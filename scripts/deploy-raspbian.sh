#!/bin/bash
# Deployment script for IBS Manager on Raspbian OS / Raspberry Pi 3 B+

set -e

APP_DIR="/opt/flussonic-manager"
cd $APP_DIR

echo "=== IBS Manager Deployment for Raspbian ==="

echo "Installing dependencies..."
# Low memory: use max 1 job to avoid OOM during native compilation
npm install --prefer-offline --no-audit --max-old-space-size=768

echo "Rebuilding native modules (better-sqlite3, bcrypt)..."
npm rebuild better-sqlite3 --build-from-source
npm rebuild bcrypt --build-from-source

echo "Building application..."
npm run build

echo "Creating .env file..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example"
    echo "Please edit .env with your configuration"
fi

echo "Setting up PM2 with low memory limits..."
pm2 delete flussonic-manager 2>/dev/null || true
pm2 start dist/server.cjs --name flussonic-manager --max-memory-restart 512M
pm2 save
pm2 startup systemd -u $USER --hp $HOME

echo "=== Deployment Complete ==="
echo "Application is running via PM2"
echo "Use 'pm2 logs flussonic-manager' to view logs"
echo "Use 'pm2 status' to check status"
echo ""
echo "NOTE: On RPi 3B+ with 1GB RAM, keep the number of concurrent users low."
