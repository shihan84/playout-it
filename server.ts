import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import https from 'https';
import cookieParser from 'cookie-parser';
import { authenticateToken, requireAdmin } from './src/server/middleware/auth';
import { csrfProtection } from './src/server/middleware/csrf';

import { config } from './src/server/config';
import './src/server/db'; // initializes DB as side effect
import { wss, verifyWsAuth } from './src/server/websocket';
import { startWatchdog } from './src/server/services/watchdog';
import { startScheduler } from './src/server/services/scheduler';

import authRoutes from './src/server/routes/auth';
import usersRoutes from './src/server/routes/users';
import serversRoutes from './src/server/routes/servers';
import streamsRoutes from './src/server/routes/streams';
import myStreamsRoutes from './src/server/routes/myStreams';
import vodsRoutes from './src/server/routes/vods';
import blockedIpsRoutes from './src/server/routes/blockedIps';
import telegramAlertsRoutes from './src/server/routes/telegramAlerts';
import telegramWebhookRoutes from './src/server/routes/telegramWebhook';
import metricsRoutes from './src/server/routes/metrics';
import settingsRoutes from './src/server/routes/settings';
import sslRoutes from './src/server/routes/ssl';
import channelsRoutes from './src/server/routes/channels';
import schedulesRoutes from './src/server/routes/schedules';

const app = express();

const PORT = config.port;
const SSL_ENABLED = config.sslEnabled;
const SSL_KEY_PATH = config.sslKeyPath;
const SSL_CERT_PATH = config.sslCertPath;

app.use(cookieParser());
app.use('/api', csrfProtection);
app.use(express.json({ limit: '1000gb' }));
app.use(express.urlencoded({ limit: '1000gb', extended: true }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/servers', serversRoutes);
app.use('/api/streams', streamsRoutes);
app.use('/api/my-streams', myStreamsRoutes);
app.use('/api/vods', vodsRoutes);
app.use('/api', blockedIpsRoutes);
app.use('/api/telegram-alerts', telegramAlertsRoutes);
app.use('/api/telegram/webhook', telegramWebhookRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/servers', metricsRoutes);
app.use('/api/ssl', sslRoutes);
app.use('/api/channels', channelsRoutes);
app.use('/api/schedules', schedulesRoutes);

// Watchdog restart endpoint
app.post('/api/watchdog/restart', authenticateToken, requireAdmin, (req, res) => {
  startWatchdog();
  res.json({ success: true });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  let server: any;

  if (SSL_ENABLED && SSL_KEY_PATH && SSL_CERT_PATH) {
    // Validate SSL files exist
    if (!fs.existsSync(SSL_KEY_PATH)) {
      throw new Error(`SSL key file not found: ${SSL_KEY_PATH}`);
    }
    if (!fs.existsSync(SSL_CERT_PATH)) {
      throw new Error(`SSL cert file not found: ${SSL_CERT_PATH}`);
    }

    const sslOptions = {
      key: fs.readFileSync(SSL_KEY_PATH),
      cert: fs.readFileSync(SSL_CERT_PATH)
    };

    server = https.createServer(sslOptions, app).listen(Number(PORT), "0.0.0.0", () => {
      console.log(`Server running on https://0.0.0.0:${PORT}`);
    });
  } else {
    server = app.listen(Number(PORT), "0.0.0.0", () => {
      console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
  }

  server.on('upgrade', (request: any, socket: any, head: any) => {
    if (request.url === '/ws') {
      const wsUser = verifyWsAuth(request);
      if (!wsUser) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      request.wsUser = wsUser;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });
}

// Start background services
startWatchdog();
startScheduler();

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
