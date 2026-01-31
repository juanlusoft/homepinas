# HomePiNAS

Home NAS solution with NonRAID real-time parity protection.

## Features

- **NonRAID Kernel Driver** - Real-time parity protection (no scheduled syncs)
- **Web Dashboard** - Easy configuration and monitoring
- **Flexible Shares** - Individual disks, unified pool, or by category
- **Samba Integration** - Network shares ready out of the box

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/juanlusoft/homepinas/main/install.sh | sudo bash
```

Or with wget:

```bash
wget -qO- https://raw.githubusercontent.com/juanlusoft/homepinas/main/install.sh | sudo bash
```

## Requirements

- Ubuntu/Debian based system
- **Kernel**: 6.8 or lower, or 6.11+ (6.9 and 6.10 **not supported**)
- Root access
- At least 2 disks (1 data + 1 parity)

## Share Modes

| Mode | Description |
|------|-------------|
| **Individual** | Each disk as separate share (`\\server\Disk1`, `\\server\Disk2`...) |
| **Unified** | Single merged pool using MergerFS (`\\server\Storage`) |
| **Categories** | Named shares by category (`\\server\Media`, `\\server\Documents`...) |

## Architecture

```
NonRAID (kernel driver)
    ├── /dev/nmd1p1 → /mnt/disk1
    ├── /dev/nmd2p1 → /mnt/disk2
    └── parity disk (real-time protection)
```

## Commands

```bash
# Check array status
sudo nmdctl status

# Start/stop array
sudo nmdctl start
sudo nmdctl stop

# Run parity check
sudo nmdctl check
```

## Dashboard

After installation, access the web dashboard at:

```
http://<your-server-ip>
```

## License

MIT
