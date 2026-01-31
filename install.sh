#!/bin/bash
#
# HomePiNAS v2.0.0 Installation Script
# NonRAID-based storage system
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/homepinas"
SERVICE_USER="homepinas"
NODE_VERSION="20"

echo -e "${BLUE}"
echo "=============================================="
echo "       HomePiNAS v2.0.0 Installer"
echo "       NonRAID Storage System"
echo "=============================================="
echo -e "${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: Please run as root (sudo)${NC}"
    exit 1
fi

# Check for existing installation
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}Warning: Existing HomePiNAS installation detected!${NC}"
    echo -e "${YELLOW}This installer will upgrade to NonRAID v2.0.0${NC}"
    echo ""
    echo -e "${RED}IMPORTANT: If you have data on SnapRAID+MergerFS:${NC}"
    echo "  1. Back up all data from /mnt/storage first"
    echo "  2. NonRAID uses a different storage architecture"
    echo "  3. Data migration is NOT automatic"
    echo ""
    read -p "Continue with installation? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "Installation cancelled."
        exit 0
    fi
fi

# Check kernel version (NonRAID doesn't support 6.9 or 6.10)
echo -e "${BLUE}Checking kernel compatibility...${NC}"
KERNEL_VERSION=$(uname -r | cut -d. -f1,2)
KERNEL_MAJOR=$(echo $KERNEL_VERSION | cut -d. -f1)
KERNEL_MINOR=$(echo $KERNEL_VERSION | cut -d. -f2)

if [ "$KERNEL_MAJOR" -eq 6 ] && [ "$KERNEL_MINOR" -ge 9 ] && [ "$KERNEL_MINOR" -le 10 ]; then
    echo -e "${RED}Error: NonRAID does NOT support kernel 6.9 or 6.10${NC}"
    echo "Current kernel: $(uname -r)"
    echo ""
    echo "Please downgrade to kernel 6.8 or upgrade to 6.11+"
    echo "Or wait for NonRAID to support your kernel version."
    exit 1
fi
echo -e "${GREEN}Kernel $(uname -r) is compatible${NC}"

# Detect distribution
echo -e "${BLUE}Detecting distribution...${NC}"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO=$ID
    echo -e "${GREEN}Detected: $PRETTY_NAME${NC}"
else
    echo -e "${RED}Cannot detect distribution${NC}"
    exit 1
fi

# Update package lists
echo -e "${BLUE}Updating package lists...${NC}"
apt-get update -qq

# Install dependencies
echo -e "${BLUE}Installing dependencies...${NC}"
apt-get install -y -qq \
    curl \
    wget \
    git \
    linux-headers-$(uname -r) \
    dkms \
    gdisk \
    xfsprogs \
    samba \
    samba-common-bin \
    nginx \
    build-essential

# Install Node.js
echo -e "${BLUE}Installing Node.js ${NODE_VERSION}...${NC}"
if ! command -v node &> /dev/null || [ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt "$NODE_VERSION" ]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
fi
echo -e "${GREEN}Node.js $(node -v) installed${NC}"

# Install NonRAID
echo -e "${BLUE}Installing NonRAID...${NC}"

# Add NonRAID PPA
if [ "$DISTRO" = "ubuntu" ] || [ "$DISTRO" = "debian" ]; then
    echo -e "${BLUE}Adding NonRAID repository...${NC}"

    # Add PPA key
    curl -fsSL https://qvr.github.io/nonraid/KEY.gpg | gpg --dearmor -o /usr/share/keyrings/nonraid-archive-keyring.gpg

    # Add repository
    echo "deb [signed-by=/usr/share/keyrings/nonraid-archive-keyring.gpg] https://qvr.github.io/nonraid/apt stable main" > /etc/apt/sources.list.d/nonraid.list

    apt-get update -qq
    apt-get install -y nonraid-dkms nonraid-tools
else
    echo -e "${YELLOW}Warning: NonRAID packages not available for $DISTRO${NC}"
    echo "Attempting to build from source..."

    # Build from source
    cd /tmp
    git clone https://github.com/qvr/nonraid.git
    cd nonraid
    make
    make install
    cd ..
    rm -rf nonraid
fi

# Verify NonRAID installation
if ! command -v nmdctl &> /dev/null; then
    echo -e "${RED}Error: NonRAID installation failed${NC}"
    exit 1
fi
echo -e "${GREEN}NonRAID installed successfully${NC}"

# Create service user
echo -e "${BLUE}Creating service user...${NC}"
if ! id "$SERVICE_USER" &>/dev/null; then
    useradd -r -s /bin/false -d "$INSTALL_DIR" "$SERVICE_USER"
fi

# Create sambashare group if not exists
if ! getent group sambashare &>/dev/null; then
    groupadd sambashare
fi

# Add service user to sambashare group
usermod -aG sambashare "$SERVICE_USER"

# Create installation directory
echo -e "${BLUE}Setting up HomePiNAS...${NC}"
mkdir -p "$INSTALL_DIR"

# Copy application files
cp -r . "$INSTALL_DIR/"

# Install Node.js dependencies
cd "$INSTALL_DIR"
if [ -f package.json ]; then
    npm install --production
fi

# Set permissions
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# Configure sudoers for HomePiNAS
echo -e "${BLUE}Configuring sudo permissions...${NC}"
cat > /etc/sudoers.d/homepinas << 'EOF'
# HomePiNAS sudo permissions
homepinas ALL=(ALL) NOPASSWD: /usr/bin/nmdctl *
homepinas ALL=(ALL) NOPASSWD: /usr/sbin/sgdisk *
homepinas ALL=(ALL) NOPASSWD: /sbin/mkfs.xfs *
homepinas ALL=(ALL) NOPASSWD: /bin/mount *
homepinas ALL=(ALL) NOPASSWD: /bin/umount *
homepinas ALL=(ALL) NOPASSWD: /bin/mkdir -p /mnt/disk[0-9]*
homepinas ALL=(ALL) NOPASSWD: /bin/mv /tmp/smb.conf.new /etc/samba/smb.conf
homepinas ALL=(ALL) NOPASSWD: /bin/systemctl restart smbd
homepinas ALL=(ALL) NOPASSWD: /bin/systemctl start nonraid
homepinas ALL=(ALL) NOPASSWD: /bin/systemctl stop nonraid
homepinas ALL=(ALL) NOPASSWD: /usr/bin/testparm *
homepinas ALL=(ALL) NOPASSWD: /usr/bin/df *
homepinas ALL=(ALL) NOPASSWD: /usr/bin/lsblk *
EOF
chmod 440 /etc/sudoers.d/homepinas

# Create Samba configuration template
echo -e "${BLUE}Configuring Samba...${NC}"
cat > /etc/samba/smb.conf << 'EOF'
[global]
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
   passwd chat = *Enter\snew\s*\spassword:* %n\n *Retype\snew\s*\spassword:* %n\n *password\supdated\ssuccessfully* .

# Shares will be configured by HomePiNAS dashboard
EOF

# Configure nginx
echo -e "${BLUE}Configuring Nginx...${NC}"
cat > /etc/nginx/sites-available/homepinas << 'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;

    root /opt/homepinas;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }

    location /frontend {
        alias /opt/homepinas/frontend;
    }
}
EOF

# Enable nginx site
ln -sf /etc/nginx/sites-available/homepinas /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test and reload nginx
nginx -t && systemctl reload nginx

# Create systemd service
echo -e "${BLUE}Creating systemd service...${NC}"
cat > /etc/systemd/system/homepinas.service << EOF
[Unit]
Description=HomePiNAS Dashboard
After=network.target nonraid.service
Wants=nonraid.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/backend/server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Create backend server if it doesn't exist
if [ ! -f "$INSTALL_DIR/backend/server.js" ]; then
    mkdir -p "$INSTALL_DIR/backend"
    cat > "$INSTALL_DIR/backend/server.js" << 'EOF'
const express = require('express');
const path = require('path');
const storageRoutes = require('./routes/storage');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// API routes
app.use('/api/storage', storageRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0.0' });
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`HomePiNAS server running on port ${PORT}`);
});
EOF
    chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/backend/server.js"
fi

# Create package.json if it doesn't exist
if [ ! -f "$INSTALL_DIR/package.json" ]; then
    cat > "$INSTALL_DIR/package.json" << 'EOF'
{
    "name": "homepinas",
    "version": "2.0.0",
    "description": "HomePiNAS - Home NAS Dashboard with NonRAID",
    "main": "backend/server.js",
    "scripts": {
        "start": "node backend/server.js"
    },
    "dependencies": {
        "express": "^4.18.2"
    }
}
EOF
    chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/package.json"
    cd "$INSTALL_DIR"
    npm install --production
fi

# Enable and start services
echo -e "${BLUE}Enabling services...${NC}"
systemctl daemon-reload
systemctl enable nonraid
systemctl enable homepinas
systemctl enable smbd
systemctl enable nginx

# Start services
systemctl start smbd
systemctl start nginx
systemctl start homepinas

echo ""
echo -e "${GREEN}=============================================="
echo "       Installation Complete!"
echo "==============================================${NC}"
echo ""
echo "HomePiNAS v2.0.0 has been installed successfully!"
echo ""
echo -e "${BLUE}Access the dashboard:${NC}"
echo "  http://$(hostname -I | awk '{print $1}')"
echo ""
echo -e "${BLUE}NonRAID Information:${NC}"
echo "  - Real-time parity protection (no scheduled syncs)"
echo "  - Each data disk mounts at /mnt/diskN"
echo "  - Currently supports 1 parity disk"
echo "  - Use 'nmdctl status' to check array status"
echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo "  1. Access the web dashboard"
echo "  2. Go to Storage > Configure your disks"
echo "  3. Select data and parity disks"
echo "  4. Choose share mode"
echo "  5. Start using your NAS!"
echo ""
echo -e "${YELLOW}Important:${NC}"
echo "  - Create a Samba user: sudo smbpasswd -a <username>"
echo "  - Add user to sambashare: sudo usermod -aG sambashare <username>"
echo ""
