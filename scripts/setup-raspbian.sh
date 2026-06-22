#!/bin/bash
# Setup script for Raspbian OS on Raspberry Pi 3 B+
# Installs all dependencies and optimizes the system for IBS Manager

set -e

APP_DIR="/opt/flussonic-manager"
SWAP_SIZE_MB=2048

echo "=== IBS Manager Setup for Raspbian OS / Raspberry Pi 3 B+ ==="

# Detect architecture
ARCH=$(dpkg --print-architecture)
BITS=$(getconf LONG_BIT)
echo "Architecture: $ARCH ($BITS-bit)"

# RPi 3B+ has only 1GB RAM. Add/ensure swap for building native modules.
echo "Configuring swap ($SWAP_SIZE_MB MB)..."
if [ -f /etc/dphys-swapfile ]; then
    sudo sed -i "s/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=$SWAP_SIZE_MB/" /etc/dphys-swapfile
    sudo dphys-swapfile setup
    sudo dphys-swapfile swapon
else
    sudo fallocate -l ${SWAP_SIZE_MB}M /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=$SWAP_SIZE_MB
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "Updating system packages..."
sudo apt update && sudo apt upgrade -y

echo "Installing build tools (needed for better-sqlite3 on ARM)..."
sudo apt install -y build-essential python3 libsqlite3-dev pkg-config

echo "Installing Node.js 20.x..."
# NodeSource setup works on both armhf and arm64 Raspbian
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
    sudo apt install -y nodejs
else
    echo "Node.js already installed: $(node --version)"
fi

echo "Installing PM2 for process management..."
sudo npm install -g pm2

echo "Installing git..."
sudo apt install -y git

echo "Creating application directory..."
sudo mkdir -p $APP_DIR
sudo chown $USER:$USER $APP_DIR

echo "=== Setup Complete ==="
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"
echo "PM2 version: $(pm2 --version)"
echo "Swap: $(free -h | awk '/Swap/{print $2}')"
echo ""
echo "Next steps:"
echo "1. Copy/clone the project to $APP_DIR"
echo "2. Run: cd $APP_DIR && ./scripts/deploy-raspbian.sh"
