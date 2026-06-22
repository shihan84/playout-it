#!/bin/bash
# Deployment script for IBS Manager on Raspberry Pi

set -e

APP_DIR="/opt/flussonic-manager"
cd $APP_DIR

echo "=== IBS Manager Deployment ==="
echo "Installing dependencies..."
npm install

echo "Building application..."
npm run build

echo "Creating .env file..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example"
    echo "Please edit .env with your configuration"
fi

echo "Setting up PM2..."
pm2 delete flussonic-manager 2>/dev/null || true
pm2 start dist/server.cjs --name flussonic-manager
pm2 save
pm2 startup

echo "=== Deployment Complete ==="
echo "Application is running via PM2"
echo "Use 'pm2 logs flussonic-manager' to view logs"
echo "Use 'pm2 status' to check status"
