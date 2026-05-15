# Flussonic Manager

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
