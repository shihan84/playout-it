# IBS Manager

A management dashboard for Flussonic Media Server with VOD playlist fallback and Telegram watchdog notifications.

## Deployment to Hostinger

### Method 1: VPS (Recommended)
1. **Clone the repository** to your VPS.
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Build the application**:
   ```bash
   npm run build
   ```
4. **Start the application** using PM2 (for persistence):
   ```bash
   pm2 start dist/server.cjs --name flussonic-manager
   ```

### Method 2: Hostinger Shared Hosting (Node.js)
1. **Upload your code** to the server (you can use Git or FTP).
2. Go to the **Node.js** section in your Hostinger Panel.
3. Select the folder where you uploaded the code.
4. Set the **Application Entry Point** to `dist/server.cjs`.
5. Run the **Build** command via the Hostinger UI (if available) or via SSH:
   ```bash
   npm install
   ```
6. The `package.json` includes a `build` script that prepares both the frontend and the backend bundle.

## Deployment to Raspberry Pi 3 B+ (Raspbian OS)

These scripts are optimized for the Raspberry Pi 3 B+ running 32-bit or 64-bit Raspbian OS.

### 1. Initial system setup (run once on the Pi)

```bash
# Copy project to the Pi, then:
cd /opt/flussonic-manager
chmod +x scripts/*.sh
./scripts/setup-raspbian.sh
```

This script will:
- Update the system
- Configure a 2 GB swap file (required for compiling native modules on 1 GB RAM)
- Install Node.js 20.x, build tools, PM2, and git
- Create `/opt/flussonic-manager`

### 2. Deploy / update the application

```bash
cd /opt/flussonic-manager
./scripts/deploy-raspbian.sh
```

This script will:
- Install npm dependencies with low memory settings
- Rebuild native modules (`better-sqlite3`, `bcrypt`) from source for ARM
- Build the frontend and backend bundle
- Start the app via PM2 with a 512 MB memory limit

### 3. Alternative: systemd service (lighter than PM2)

```bash
sudo cp scripts/flussonic-manager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable flussonic-manager
sudo systemctl start flussonic-manager
sudo systemctl status flussonic-manager
```

### Performance notes for RPi 3 B+
- Keep the number of concurrent dashboard users low (1–3).
- Use an external USB drive or SSD for the VOD storage path; SD cards are too slow for reliable streaming.
- Avoid enabling VOD sync on very large folders; sync is memory intensive.
- If the build runs out of memory, increase swap to 4 GB in `/etc/dphys-swapfile`.

## Environment Variables
Create a `.env` file in the root directory:
```env
PORT=3000
DATABASE_PATH=flussonic.db
NODE_ENV=production
```

## GitHub Integration
To commit this code to GitHub:
1. Open the **Settings** menu in AI Studio.
2. Select **Connect to GitHub** or **Export to GitHub**.
3. Follow the authentication flow to push your project to a new or existing repository.
