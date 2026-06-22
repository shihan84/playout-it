#!/bin/bash
# Setup script for Raspberry Pi 3 B+ Ubuntu 22.04 Server
# This script installs all dependencies needed for IBS Manager

set -e

echo "=== IBS Manager Setup for Raspberry Pi ==="
echo "Updating system packages..."
sudo apt update && sudo apt upgrade -y

echo "Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -S bash -
sudo apt install -y nodejs

echo "Installing PM2 for process management..."
sudo npm install -g pm2

echo "Installing nginx for reverse proxy..."
sudo apt install -y nginx

echo "Installing git..."
sudo apt install -y git

echo "Installing build tools..."
sudo apt install -y build-essential python3

echo "Installing Certbot for SSL..."
sudo apt install -y certbot python3-certbot-nginx

echo "Creating application directory..."
sudo mkdir -p /opt/flussonic-manager
sudo chown $USER:$USER /opt/flussonic-manager

echo "=== Setup Complete ==="
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"
echo "PM2 version: $(pm2 --version)"
echo ""
echo "Next steps:"
echo "1. Upload/clone the codebase to /opt/flussonic-manager"
echo "2. Run deploy.sh to install dependencies and start the application"
