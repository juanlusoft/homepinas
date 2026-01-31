// HomePiNAS v2.0.0 - NonRAID Frontend

const API_BASE = '/api';

// Application state
let availableDisks = [];
let diskAssignments = {};
let arrayStatus = null;

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    loadDashboard();
});

// Navigation
function initNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const page = e.target.closest('.nav-link').dataset.page;
            navigateTo(page);
        });
    });
}

function navigateTo(page) {
    // Update active nav
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelector(`.nav-link[data-page="${page}"]`)?.classList.add('active');

    // Hide all pages, show selected
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`${page}-page`)?.classList.add('active');

    // Load page content
    switch (page) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'storage':
            loadStoragePage();
            break;
        case 'shares':
            loadSharesPage();
            break;
        case 'settings':
            loadSettingsPage();
            break;
    }
}

// Dashboard
async function loadDashboard() {
    try {
        const response = await fetch(`${API_BASE}/storage/array/status`);
        const data = await response.json();

        if (data.success) {
            arrayStatus = data;
            renderStorageDashboard();
        }
    } catch (error) {
        console.error('Error loading dashboard:', error);
        showError('Failed to load dashboard');
    }
}

function renderStorageDashboard() {
    const container = document.getElementById('storage-dashboard');
    if (!container || !arrayStatus) return;

    if (!arrayStatus.installed) {
        container.innerHTML = `
            <div class="alert alert-warning">
                <h4>NonRAID Not Installed</h4>
                <p>NonRAID kernel driver is not installed. Please run the installation script.</p>
            </div>
        `;
        return;
    }

    if (!arrayStatus.configured) {
        container.innerHTML = `
            <div class="alert alert-info">
                <h4>Array Not Configured</h4>
                <p>No NonRAID array has been configured yet.</p>
                <button class="btn btn-primary" onclick="navigateTo('storage')">Configure Storage</button>
            </div>
        `;
        return;
    }

    // Render full dashboard
    const statusBadge = getStatusBadge(arrayStatus.status);
    const parityBadge = arrayStatus.parityValid
        ? '<span class="badge badge-success">Valid</span>'
        : '<span class="badge badge-danger">Invalid</span>';

    let disksHtml = '';
    if (arrayStatus.disks) {
        disksHtml = arrayStatus.disks.map(disk => {
            if (disk.status === 'unmounted') {
                return `
                    <div class="disk-slot-card unmounted">
                        <div class="slot-header">Slot ${disk.slot}</div>
                        <div class="slot-status">Unmounted</div>
                    </div>
                `;
            }

            const usagePercent = disk.usagePercent || 0;
            const usageClass = usagePercent > 90 ? 'critical' : usagePercent > 75 ? 'warning' : 'normal';

            return `
                <div class="disk-slot-card ${usageClass}">
                    <div class="slot-header">
                        <span>Slot ${disk.slot}</span>
                        <span class="mount-point">${disk.mountPoint}</span>
                    </div>
                    <div class="usage-bar">
                        <div class="usage-fill" style="width: ${usagePercent}%"></div>
                    </div>
                    <div class="usage-text">
                        ${formatBytes(disk.used)} / ${formatBytes(disk.total)} (${usagePercent}%)
                    </div>
                </div>
            `;
        }).join('');
    }

    container.innerHTML = `
        <div class="array-status-header">
            <div class="status-row">
                <h3>NonRAID Array</h3>
                <div class="array-badges">
                    ${statusBadge}
                    <span class="badge-label">Parity:</span> ${parityBadge}
                </div>
            </div>
            <div class="array-controls">
                ${arrayStatus.status === 'RUNNING'
                    ? '<button class="btn btn-warning" onclick="stopArray()">Stop Array</button>'
                    : '<button class="btn btn-success" onclick="startArray()">Start Array</button>'}
                <button class="btn btn-secondary" onclick="runParityCheck()"
                    ${arrayStatus.checking ? 'disabled' : ''}>
                    ${arrayStatus.checking ? `Checking ${arrayStatus.checkProgress}%` : 'Run Parity Check'}
                </button>
            </div>
        </div>

        <div class="disk-slots">
            <h4>Data Disks (${arrayStatus.dataDisks})</h4>
            <div class="disk-grid">
                ${disksHtml}
            </div>
        </div>

        <div class="parity-info">
            <h4>Parity Disk</h4>
            <p>Device: ${arrayStatus.parityDisk || 'N/A'}</p>
            ${arrayStatus.lastCheck ? `<p>Last Check: ${new Date(arrayStatus.lastCheck).toLocaleString()}</p>` : ''}
        </div>
    `;

    // Poll for check progress if checking
    if (arrayStatus.checking) {
        setTimeout(pollCheckProgress, 2000);
    }
}

function getStatusBadge(status) {
    const badges = {
        'RUNNING': '<span class="badge badge-success">RUNNING</span>',
        'STOPPED': '<span class="badge badge-secondary">STOPPED</span>',
        'DEGRADED': '<span class="badge badge-danger">DEGRADED</span>',
        'REBUILDING': '<span class="badge badge-warning">REBUILDING</span>'
    };
    return badges[status] || `<span class="badge badge-secondary">${status}</span>`;
}

// Storage Setup
async function loadStoragePage() {
    const container = document.getElementById('storage-setup-container');
    if (!container) return;

    // Check if already configured
    const response = await fetch(`${API_BASE}/storage/array/status`);
    const status = await response.json();

    if (status.configured) {
        container.innerHTML = `
            <div class="alert alert-info">
                <h4>Array Already Configured</h4>
                <p>A NonRAID array is already configured with ${status.dataDisks} data disk(s).</p>
                <p><strong>Warning:</strong> Reconfiguring will destroy all data!</p>
                <button class="btn btn-danger" onclick="showStorageSetup()">Reconfigure Array</button>
            </div>
        `;
        return;
    }

    showStorageSetup();
}

async function showStorageSetup() {
    await initStorageSetup();
}

async function initStorageSetup() {
    const container = document.getElementById('storage-setup-container');

    // Load available disks
    try {
        const response = await fetch(`${API_BASE}/storage/disks`);
        const data = await response.json();

        if (data.success) {
            availableDisks = data.disks.filter(d => !d.mounted);
            renderDiskSelection();
        } else {
            showError('Failed to load disks');
        }
    } catch (error) {
        console.error('Error loading disks:', error);
        showError('Failed to load disk information');
    }
}

function renderDiskSelection() {
    const container = document.getElementById('disk-list');
    if (!container) return;

    if (availableDisks.length === 0) {
        container.innerHTML = `
            <div class="alert alert-warning">
                <p>No available disks found. All disks may already be mounted or in use.</p>
            </div>
        `;
        return;
    }

    // Roles: none, data, parity (no cache for NonRAID)
    const roles = ['none', 'data', 'parity'];

    container.innerHTML = availableDisks.map(disk => `
        <div class="disk-item" data-disk="${disk.path}">
            <div class="disk-info">
                <span class="disk-name">${disk.path}</span>
                <span class="disk-model">${disk.model}</span>
                <span class="disk-size">${disk.size}</span>
                <span class="disk-type">${disk.rotational ? 'HDD' : 'SSD'}</span>
            </div>
            <div class="disk-role">
                <select class="role-select" onchange="updateDiskRole('${disk.path}', this.value)">
                    ${roles.map(role => `
                        <option value="${role}" ${diskAssignments[disk.path] === role ? 'selected' : ''}>
                            ${role === 'none' ? 'Not Used' : role.charAt(0).toUpperCase() + role.slice(1)}
                        </option>
                    `).join('')}
                </select>
            </div>
        </div>
    `).join('');

    updateSaveButton();
}

function updateDiskRole(diskPath, role) {
    if (role === 'none') {
        delete diskAssignments[diskPath];
    } else {
        diskAssignments[diskPath] = role;
    }
    updateSaveButton();
}

function updateSaveButton() {
    const btn = document.getElementById('saveStorageBtn');
    if (!btn) return;

    const dataDisks = Object.entries(diskAssignments).filter(([_, role]) => role === 'data');
    const parityDisks = Object.entries(diskAssignments).filter(([_, role]) => role === 'parity');

    // Validate: need at least 1 data and exactly 1 parity
    const valid = dataDisks.length >= 1 && parityDisks.length === 1;

    btn.disabled = !valid;

    // Update status message
    const statusEl = document.getElementById('disk-selection-status');
    if (statusEl) {
        if (parityDisks.length > 1) {
            statusEl.innerHTML = '<span class="text-danger">NonRAID currently supports only 1 parity disk</span>';
        } else if (parityDisks.length === 0) {
            statusEl.innerHTML = '<span class="text-warning">Select 1 parity disk</span>';
        } else if (dataDisks.length === 0) {
            statusEl.innerHTML = '<span class="text-warning">Select at least 1 data disk</span>';
        } else {
            statusEl.innerHTML = `<span class="text-success">${dataDisks.length} data + 1 parity disk selected</span>`;
        }
    }
}

async function saveStorageConfig() {
    const dataDisks = Object.entries(diskAssignments)
        .filter(([_, role]) => role === 'data')
        .map(([path]) => path);

    const parityDisks = Object.entries(diskAssignments)
        .filter(([_, role]) => role === 'parity')
        .map(([path]) => path);

    if (parityDisks.length !== 1) {
        showError('NonRAID currently supports exactly 1 parity disk');
        return;
    }

    const shareMode = document.getElementById('share-mode')?.value || 'individual';

    // Show progress modal
    showProgressModal();

    try {
        const response = await fetch(`${API_BASE}/storage/array/configure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dataDisks,
                parityDisk: parityDisks[0],
                shareMode
            })
        });

        const data = await response.json();

        if (data.success) {
            // Start polling for progress
            pollConfigureProgress();
        } else {
            hideProgressModal();
            showError(data.error || 'Failed to start configuration');
        }
    } catch (error) {
        hideProgressModal();
        console.error('Error saving config:', error);
        showError('Failed to save storage configuration');
    }
}

function showProgressModal() {
    const modal = document.getElementById('progress-modal');
    if (modal) {
        modal.classList.add('active');
        // Reset all steps
        document.querySelectorAll('.progress-step').forEach(step => {
            step.classList.remove('active', 'complete');
        });
    }
}

function hideProgressModal() {
    const modal = document.getElementById('progress-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function pollConfigureProgress() {
    try {
        const response = await fetch(`${API_BASE}/storage/array/configure/progress`);
        const data = await response.json();

        if (!data.success) {
            hideProgressModal();
            showError('Failed to get progress');
            return;
        }

        // Update step indicators
        const steps = ['partition', 'array', 'start', 'filesystem', 'mount', 'samba', 'check'];
        const currentIndex = steps.indexOf(data.step);

        steps.forEach((step, index) => {
            const el = document.getElementById(`step-${step}`);
            if (el) {
                if (index < currentIndex) {
                    el.classList.remove('active');
                    el.classList.add('complete');
                } else if (index === currentIndex) {
                    el.classList.add('active');
                    el.classList.remove('complete');
                } else {
                    el.classList.remove('active', 'complete');
                }
            }
        });

        // Update progress bar
        const progressBar = document.getElementById('step-progress-bar');
        if (progressBar) {
            progressBar.style.width = `${data.progress}%`;
        }

        // Check if complete or error
        if (data.error) {
            hideProgressModal();
            showError(data.error);
            return;
        }

        if (data.step === 'complete' || !data.active) {
            hideProgressModal();
            showSuccess('Storage array configured successfully!');
            loadDashboard();
            navigateTo('dashboard');
            return;
        }

        // Continue polling
        setTimeout(pollConfigureProgress, 1000);
    } catch (error) {
        console.error('Error polling progress:', error);
        setTimeout(pollConfigureProgress, 2000);
    }
}

// Array controls
async function startArray() {
    try {
        const response = await fetch(`${API_BASE}/storage/array/start`, { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            showSuccess('Array started');
            loadDashboard();
        } else {
            showError(data.error || 'Failed to start array');
        }
    } catch (error) {
        console.error('Error starting array:', error);
        showError('Failed to start array');
    }
}

async function stopArray() {
    if (!confirm('Are you sure you want to stop the array? All shares will become unavailable.')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/storage/array/stop`, { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            showSuccess('Array stopped');
            loadDashboard();
        } else {
            showError(data.error || 'Failed to stop array');
        }
    } catch (error) {
        console.error('Error stopping array:', error);
        showError('Failed to stop array');
    }
}

async function runParityCheck() {
    try {
        const response = await fetch(`${API_BASE}/storage/array/check`, { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            showSuccess('Parity check started');
            arrayStatus.checking = true;
            arrayStatus.checkProgress = 0;
            renderStorageDashboard();
        } else {
            showError(data.error || 'Failed to start parity check');
        }
    } catch (error) {
        console.error('Error starting parity check:', error);
        showError('Failed to start parity check');
    }
}

async function pollCheckProgress() {
    try {
        const response = await fetch(`${API_BASE}/storage/array/check/progress`);
        const data = await response.json();

        if (data.success) {
            arrayStatus.checking = data.checking;
            arrayStatus.checkProgress = data.progress;

            if (data.error) {
                showError(data.error);
            }

            renderStorageDashboard();

            if (data.checking) {
                setTimeout(pollCheckProgress, 2000);
            } else if (data.progress === 100) {
                showSuccess('Parity check completed');
            }
        }
    } catch (error) {
        console.error('Error polling check progress:', error);
        setTimeout(pollCheckProgress, 5000);
    }
}

// Shares page
async function loadSharesPage() {
    const container = document.getElementById('shares-list');
    if (!container) return;

    try {
        const response = await fetch(`${API_BASE}/storage/shares`);
        const data = await response.json();

        if (data.success && data.shares.length > 0) {
            container.innerHTML = data.shares.map(share => `
                <div class="share-item">
                    <div class="share-name">${share.name}</div>
                    <div class="share-path">${share.path}</div>
                    <div class="share-access">\\\\${window.location.hostname}\\${share.name}</div>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<p>No shares configured</p>';
        }
    } catch (error) {
        console.error('Error loading shares:', error);
        container.innerHTML = '<p class="text-danger">Failed to load shares</p>';
    }
}

// Settings page
function loadSettingsPage() {
    // Load current settings
}

// Utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showError(message) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-error';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

function showSuccess(message) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// Export for use in HTML
window.saveStorageConfig = saveStorageConfig;
window.startArray = startArray;
window.stopArray = stopArray;
window.runParityCheck = runParityCheck;
window.navigateTo = navigateTo;
window.showStorageSetup = showStorageSetup;
