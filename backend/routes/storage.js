const express = require('express');
const router = express.Router();
const { exec, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

// NonRAID constants
const NONRAID_DAT = '/nonraid.dat';
const NONRAID_MOUNT_PREFIX = '/mnt/disk';
const SAMBA_CONF = '/etc/samba/smb.conf';

// State tracking
let nonraidStatus = {
    checking: false,
    progress: 0,
    step: '',
    error: null
};

let configureStatus = {
    active: false,
    step: '',
    progress: 0,
    error: null
};

// Helper: Execute command with promise
function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr, stdout });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

// Helper: Execute command with sudo
function sudoExec(cmd) {
    return execPromise(`sudo ${cmd}`);
}

// GET /storage/disks - List available disks
router.get('/disks', async (req, res) => {
    try {
        const { stdout } = await execPromise('lsblk -J -o NAME,SIZE,TYPE,MOUNTPOINT,MODEL,SERIAL,ROTA');
        const data = JSON.parse(stdout);

        const disks = data.blockdevices
            .filter(d => d.type === 'disk' && !d.name.startsWith('loop'))
            .map(disk => ({
                name: disk.name,
                path: `/dev/${disk.name}`,
                size: disk.size,
                model: disk.model || 'Unknown',
                serial: disk.serial || 'N/A',
                rotational: disk.rota === true || disk.rota === '1',
                mounted: disk.mountpoint !== null ||
                    (disk.children && disk.children.some(c => c.mountpoint !== null)),
                partitions: disk.children ? disk.children.map(p => ({
                    name: p.name,
                    path: `/dev/${p.name}`,
                    size: p.size,
                    mountpoint: p.mountpoint
                })) : []
            }));

        res.json({ success: true, disks });
    } catch (error) {
        console.error('Error listing disks:', error);
        res.status(500).json({ success: false, error: 'Failed to list disks' });
    }
});

// GET /storage/array/status - Get NonRAID array status
router.get('/array/status', async (req, res) => {
    try {
        // Check if NonRAID is installed
        try {
            await execPromise('which nmdctl');
        } catch {
            return res.json({
                success: true,
                installed: false,
                status: 'NOT_INSTALLED'
            });
        }

        // Check if array exists
        try {
            await fs.access(NONRAID_DAT);
        } catch {
            return res.json({
                success: true,
                installed: true,
                configured: false,
                status: 'NOT_CONFIGURED'
            });
        }

        // Get array status
        const { stdout } = await sudoExec('nmdctl status -o json');
        const status = JSON.parse(stdout);

        // Get disk usage for each mounted disk
        const disks = [];
        for (let i = 0; i < status.dataDisks; i++) {
            const mountPoint = `${NONRAID_MOUNT_PREFIX}${i + 1}`;
            try {
                const { stdout: dfOut } = await execPromise(`df -B1 "${mountPoint}" | tail -1`);
                const parts = dfOut.trim().split(/\s+/);
                disks.push({
                    slot: i + 1,
                    mountPoint,
                    device: parts[0],
                    total: parseInt(parts[1]),
                    used: parseInt(parts[2]),
                    available: parseInt(parts[3]),
                    usagePercent: parseInt(parts[4])
                });
            } catch {
                disks.push({
                    slot: i + 1,
                    mountPoint,
                    status: 'unmounted'
                });
            }
        }

        res.json({
            success: true,
            installed: true,
            configured: true,
            status: status.state, // RUNNING, STOPPED, DEGRADED
            parityValid: status.parityValid,
            parityDisk: status.parityDisk,
            dataDisks: status.dataDisks,
            disks,
            lastCheck: status.lastCheck,
            checking: nonraidStatus.checking,
            checkProgress: nonraidStatus.progress
        });

    } catch (error) {
        console.error('Error getting array status:', error);
        res.status(500).json({ success: false, error: 'Failed to get array status' });
    }
});

// POST /storage/array/configure - Configure NonRAID array
router.post('/array/configure', async (req, res) => {
    const { dataDisks, parityDisk, shareMode } = req.body;

    if (!dataDisks || !Array.isArray(dataDisks) || dataDisks.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one data disk required' });
    }

    if (!parityDisk) {
        return res.status(400).json({ success: false, error: 'Parity disk required' });
    }

    // NonRAID currently only supports 1 parity disk
    if (Array.isArray(parityDisk) && parityDisk.length > 1) {
        return res.status(400).json({ success: false, error: 'NonRAID currently only supports 1 parity disk' });
    }

    const parity = Array.isArray(parityDisk) ? parityDisk[0] : parityDisk;

    // Start configuration in background
    configureStatus = {
        active: true,
        step: 'partition',
        progress: 0,
        error: null
    };

    res.json({ success: true, message: 'Configuration started' });

    // Run configuration async
    configureArray(dataDisks, parity, shareMode || 'individual').catch(err => {
        console.error('Configuration failed:', err);
        configureStatus.error = err.message || 'Configuration failed';
        configureStatus.active = false;
    });
});

async function configureArray(dataDisks, parityDisk, shareMode) {
    try {
        // Step 1: Partition disks (GPT)
        configureStatus.step = 'partition';
        configureStatus.progress = 0;

        const allDisks = [...dataDisks, parityDisk];
        for (let i = 0; i < allDisks.length; i++) {
            const disk = allDisks[i];
            // Create GPT partition table with single partition
            await sudoExec(`sgdisk -o -a 8 -n 1:32K:0 ${disk}`);
            configureStatus.progress = Math.round(((i + 1) / allDisks.length) * 100);
        }

        // Step 2: Create NonRAID array
        configureStatus.step = 'array';
        configureStatus.progress = 0;

        const dataPartitions = dataDisks.map(d => `${d}1`).join(' ');
        const parityPartition = `${parityDisk}1`;

        await sudoExec(`nmdctl create -p ${parityPartition} ${dataPartitions}`);
        configureStatus.progress = 100;

        // Step 3: Start array
        configureStatus.step = 'start';
        configureStatus.progress = 0;
        await sudoExec('nmdctl start');
        configureStatus.progress = 100;

        // Step 4: Create filesystems
        configureStatus.step = 'filesystem';
        configureStatus.progress = 0;

        for (let i = 0; i < dataDisks.length; i++) {
            // NonRAID exposes devices as /dev/nmd[N]p1
            await sudoExec(`mkfs.xfs -f /dev/nmd${i + 1}p1`);
            configureStatus.progress = Math.round(((i + 1) / dataDisks.length) * 100);
        }

        // Step 5: Mount disks
        configureStatus.step = 'mount';
        configureStatus.progress = 0;

        for (let i = 0; i < dataDisks.length; i++) {
            const mountPoint = `${NONRAID_MOUNT_PREFIX}${i + 1}`;
            await sudoExec(`mkdir -p ${mountPoint}`);
            configureStatus.progress = Math.round(((i + 1) / dataDisks.length) * 50);
        }

        await sudoExec('nmdctl mount');
        configureStatus.progress = 100;

        // Step 6: Configure Samba
        configureStatus.step = 'samba';
        configureStatus.progress = 0;
        await updateSambaConfigForNonRAID(dataDisks.length, shareMode);
        await sudoExec('systemctl restart smbd');
        configureStatus.progress = 100;

        // Step 7: Initial parity check
        configureStatus.step = 'check';
        configureStatus.progress = 0;

        // Start parity sync in background
        nonraidStatus.checking = true;
        nonraidStatus.progress = 0;

        const checkProcess = spawn('sudo', ['nmdctl', 'check']);

        checkProcess.stdout.on('data', (data) => {
            const match = data.toString().match(/(\d+)%/);
            if (match) {
                nonraidStatus.progress = parseInt(match[1]);
                configureStatus.progress = parseInt(match[1]);
            }
        });

        checkProcess.on('close', (code) => {
            nonraidStatus.checking = false;
            nonraidStatus.progress = 100;
            configureStatus.active = false;
            configureStatus.step = 'complete';
            configureStatus.progress = 100;
        });

    } catch (error) {
        configureStatus.error = error.message || 'Configuration failed';
        configureStatus.active = false;
        throw error;
    }
}

// GET /storage/array/configure/progress - Get configuration progress
router.get('/array/configure/progress', (req, res) => {
    res.json({
        success: true,
        ...configureStatus
    });
});

// POST /storage/array/start - Start the array
router.post('/array/start', async (req, res) => {
    try {
        await sudoExec('nmdctl start');
        await sudoExec('nmdctl mount');
        res.json({ success: true, message: 'Array started' });
    } catch (error) {
        console.error('Error starting array:', error);
        res.status(500).json({ success: false, error: 'Failed to start array' });
    }
});

// POST /storage/array/stop - Stop the array
router.post('/array/stop', async (req, res) => {
    try {
        await sudoExec('nmdctl unmount');
        await sudoExec('nmdctl stop');
        res.json({ success: true, message: 'Array stopped' });
    } catch (error) {
        console.error('Error stopping array:', error);
        res.status(500).json({ success: false, error: 'Failed to stop array' });
    }
});

// POST /storage/array/check - Start parity check
router.post('/array/check', async (req, res) => {
    if (nonraidStatus.checking) {
        return res.status(400).json({ success: false, error: 'Parity check already in progress' });
    }

    nonraidStatus.checking = true;
    nonraidStatus.progress = 0;
    nonraidStatus.error = null;

    res.json({ success: true, message: 'Parity check started' });

    // Run check in background
    const checkProcess = spawn('sudo', ['nmdctl', 'check']);

    checkProcess.stdout.on('data', (data) => {
        const match = data.toString().match(/(\d+)%/);
        if (match) {
            nonraidStatus.progress = parseInt(match[1]);
        }
    });

    checkProcess.stderr.on('data', (data) => {
        console.error('Check error:', data.toString());
    });

    checkProcess.on('close', (code) => {
        nonraidStatus.checking = false;
        if (code !== 0) {
            nonraidStatus.error = 'Parity check failed';
        } else {
            nonraidStatus.progress = 100;
        }
    });
});

// GET /storage/array/check/progress - Get parity check progress
router.get('/array/check/progress', (req, res) => {
    res.json({
        success: true,
        checking: nonraidStatus.checking,
        progress: nonraidStatus.progress,
        error: nonraidStatus.error
    });
});

// POST /storage/array/add - Add a disk to the array
router.post('/array/add', async (req, res) => {
    const { disk, slot } = req.body;

    if (!disk) {
        return res.status(400).json({ success: false, error: 'Disk path required' });
    }

    try {
        // Partition the disk
        await sudoExec(`sgdisk -o -a 8 -n 1:32K:0 ${disk}`);

        // Add to array
        await sudoExec(`nmdctl add ${disk}1`);

        // Create filesystem
        const { stdout } = await sudoExec('nmdctl status -o json');
        const status = JSON.parse(stdout);
        const newSlot = status.dataDisks;

        await sudoExec(`mkfs.xfs -f /dev/nmd${newSlot}p1`);

        // Create mount point and mount
        const mountPoint = `${NONRAID_MOUNT_PREFIX}${newSlot}`;
        await sudoExec(`mkdir -p ${mountPoint}`);
        await sudoExec(`mount /dev/nmd${newSlot}p1 ${mountPoint}`);

        res.json({ success: true, message: 'Disk added', slot: newSlot });
    } catch (error) {
        console.error('Error adding disk:', error);
        res.status(500).json({ success: false, error: 'Failed to add disk' });
    }
});

// POST /storage/array/replace/:slot - Replace a disk
router.post('/array/replace/:slot', async (req, res) => {
    const { slot } = req.params;
    const { disk } = req.body;

    if (!disk) {
        return res.status(400).json({ success: false, error: 'New disk path required' });
    }

    try {
        // Partition the new disk
        await sudoExec(`sgdisk -o -a 8 -n 1:32K:0 ${disk}`);

        // Replace in array
        await sudoExec(`nmdctl replace ${slot} ${disk}1`);

        // Rebuild will start automatically
        nonraidStatus.checking = true;
        nonraidStatus.progress = 0;
        nonraidStatus.step = 'Rebuilding disk';

        res.json({ success: true, message: 'Disk replacement started' });
    } catch (error) {
        console.error('Error replacing disk:', error);
        res.status(500).json({ success: false, error: 'Failed to replace disk' });
    }
});

// Helper: Update Samba configuration for NonRAID
async function updateSambaConfigForNonRAID(diskCount, shareMode) {
    let sambaConfig = `[global]
   workgroup = WORKGROUP
   server string = HomePiNAS
   security = user
   map to guest = Bad User
   log file = /var/log/samba/log.%m
   max log size = 1000
   logging = file
   panic action = /usr/share/samba/panic-action %d
   server role = standalone server
   obey pam restrictions = yes
   unix password sync = yes
   pam password change = yes
   passwd program = /usr/bin/passwd %u
   passwd chat = *Enter\\snew\\s*\\spassword:* %n\\n *Retype\\snew\\s*\\spassword:* %n\\n *password\\supdated\\ssuccessfully* .

`;

    if (shareMode === 'individual') {
        // Individual shares per disk
        for (let i = 1; i <= diskCount; i++) {
            sambaConfig += `
[Disk${i}]
   path = ${NONRAID_MOUNT_PREFIX}${i}
   browseable = yes
   read only = no
   guest ok = no
   valid users = @sambashare
   create mask = 0664
   directory mask = 0775
   force group = sambashare
`;
        }
    } else if (shareMode === 'merged') {
        // Unified pool using MergerFS
        const diskPaths = [];
        for (let i = 1; i <= diskCount; i++) {
            diskPaths.push(`${NONRAID_MOUNT_PREFIX}${i}`);
        }

        // Create MergerFS mount
        const mergerPaths = diskPaths.join(':');
        await sudoExec(`mkdir -p /mnt/storage`);
        await sudoExec(`mergerfs ${mergerPaths} /mnt/storage -o defaults,allow_other,use_ino,category.create=mfs,moveonenospc=true,dropcacheonclose=true`);

        sambaConfig += `
[Storage]
   path = /mnt/storage
   browseable = yes
   read only = no
   guest ok = no
   valid users = @sambashare
   create mask = 0664
   directory mask = 0775
   force group = sambashare
`;
    } else if (shareMode === 'categories') {
        // Default category mapping
        const categories = ['Media', 'Documents', 'Backups', 'Downloads', 'Photos', 'Projects'];
        for (let i = 1; i <= diskCount; i++) {
            const category = categories[i - 1] || `Disk${i}`;
            sambaConfig += `
[${category}]
   path = ${NONRAID_MOUNT_PREFIX}${i}
   browseable = yes
   read only = no
   guest ok = no
   valid users = @sambashare
   create mask = 0664
   directory mask = 0775
   force group = sambashare
`;
        }
    }

    // Write Samba config
    await fs.writeFile('/tmp/smb.conf.new', sambaConfig);
    await sudoExec('mv /tmp/smb.conf.new /etc/samba/smb.conf');
}

// GET /storage/shares - Get configured shares
router.get('/shares', async (req, res) => {
    try {
        const { stdout } = await execPromise('testparm -s 2>/dev/null');
        const shares = [];

        const shareBlocks = stdout.split(/\[([^\]]+)\]/);
        for (let i = 1; i < shareBlocks.length; i += 2) {
            const name = shareBlocks[i];
            if (name === 'global') continue;

            const content = shareBlocks[i + 1];
            const pathMatch = content.match(/path\s*=\s*(.+)/);

            shares.push({
                name,
                path: pathMatch ? pathMatch[1].trim() : 'N/A'
            });
        }

        res.json({ success: true, shares });
    } catch (error) {
        console.error('Error getting shares:', error);
        res.status(500).json({ success: false, error: 'Failed to get shares' });
    }
});

module.exports = router;
