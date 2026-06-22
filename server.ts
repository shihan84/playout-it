import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import https from 'https';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import 'dotenv/config';

// CJS-compatible __dirname and __filename
const __filename = path.resolve();
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SSL_ENABLED = process.env.SSL_ENABLED === 'true';
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || '';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || '';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const SALT_ROUNDS = 10;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API_URL = 'https://api.telegram.org/bot';

app.use(cookieParser());
app.use(express.json());

const upload = multer({ 
  dest: os.tmpdir(),
  limits: { fileSize: 1000 * 1024 * 1024 * 1024 } // 1000GB (1TB) limit
});

// WebSocket Setup
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

const parseStream = (s: any) => {
  let push_urls = [];
  let push_status = [];
  let inputs = [];
  try {
    push_urls = JSON.parse(s.push_urls || '[]');
  } catch (e) {
    console.error('Failed to parse push_urls for stream', s.id);
  }
  try {
    push_status = JSON.parse(s.push_status || '[]');
  } catch (e) {
    console.error('Failed to parse push_status for stream', s.id);
  }
  try {
    inputs = JSON.parse(s.inputs || '[]');
  } catch (e) {
    console.error('Failed to parse inputs for stream', s.id);
  }
  return {
    ...s,
    push_urls,
    push_status,
    inputs
  };
};

const broadcastStreamsUpdate = () => {
  try {
    const streams = db.prepare(`
      SELECT streams.*, servers.name as server_name, servers.url as server_url 
      FROM streams 
      LEFT JOIN servers ON streams.server_id = servers.id
    `).all();
    
    const parsedStreams = streams.map(parseStream);

    const message = JSON.stringify({ type: 'STREAMS_UPDATE', data: parsedStreams });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (error) {
    console.error('Failed to broadcast streams update:', error);
  }
};

app.use(express.json({ limit: '1000gb' }));
app.use(express.urlencoded({ limit: '1000gb', extended: true }));

// Authentication Middleware
interface AuthRequest extends express.Request {
  user?: any;
}

const authenticateToken = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid token.' });
  }
};

const requireAdmin = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

const requireStreamAccess = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  if (req.user?.role === 'admin') {
    return next();
  }
  
  const streamId = req.params.id || req.params.streamId || req.body.stream_id;
  if (!streamId) {
    return res.status(400).json({ error: 'Stream ID required' });
  }
  
  const assignment = db.prepare(
    'SELECT * FROM user_stream_assignments WHERE user_id = ? AND stream_id = ?'
  ).get(req.user.id, streamId);
  
  if (!assignment) {
    return res.status(403).json({ error: 'Access denied to this stream.' });
  }
  
  next();
};

// Database Setup
const dbPath = process.env.DATABASE_PATH || 'flussonic.db';
let db: any;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (e: any) {
  if (e.code === 'SQLITE_CORRUPT' || e.message?.includes('malformed')) {
    console.error('Database corrupted on open, recreating...');
    [dbPath, `${dbPath}-shm`, `${dbPath}-wal`].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
  } else {
    throw e;
  }
}

// Helper for Flussonic API calls to handle auth fallback
async function flussonicRequest(method: string, url: string, server: any, data: any = null, timeout = 30000, extraHeaders: any = {}) {
  let authString = server.api_key.includes(':') ? server.api_key : `flussonic:${server.api_key}`;
  const headers = { 
    'Authorization': `Basic ${Buffer.from(authString).toString('base64')}`,
    ...extraHeaders
  };
  try {
    return await axios({
      method,
      url,
      data,
      headers,
      timeout: timeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  } catch (e: any) {
    if (e.response && (e.response.status === 401 || e.response.status === 403) && !server.api_key.includes(':')) {
      authString = `admin:${server.api_key}`;
      const retryHeaders = {
        'Authorization': `Basic ${Buffer.from(authString).toString('base64')}`,
        ...extraHeaders
      };
      return await axios({
        method,
        url,
        data,
        headers: retryHeaders,
        timeout: timeout,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
    }
    throw e;
  }
}

const schema = `
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    name TEXT NOT NULL,
    live_url TEXT NOT NULL,
    playlist_url TEXT NOT NULL,
    push_urls TEXT DEFAULT '[]',
    push_status TEXT DEFAULT '[]',
    status TEXT DEFAULT 'unknown',
    input_status TEXT DEFAULT 'unknown',
    source_type TEXT DEFAULT 'unknown',
    uptime INTEGER DEFAULT 0,
    last_checked DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS vods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    name TEXT NOT NULL,
    paths TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS vod_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vod_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(vod_id) REFERENCES vods(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'client',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_stream_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stream_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    UNIQUE(user_id, stream_id)
  );

  CREATE TABLE IF NOT EXISTS blocked_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT NOT NULL UNIQUE,
    reason TEXT,
    blocked_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(blocked_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stream_id INTEGER NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    alert_enabled INTEGER DEFAULT 1,
    downtime_threshold INTEGER DEFAULT 30,
    last_alert_sent DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE,
    UNIQUE(user_id, stream_id)
  );

  CREATE TABLE IF NOT EXISTS telegram_alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_alert_id INTEGER NOT NULL,
    alert_type TEXT NOT NULL,
    message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    success INTEGER DEFAULT 1,
    error_message TEXT,
    FOREIGN KEY(telegram_alert_id) REFERENCES telegram_alerts(id) ON DELETE CASCADE
  );
`;

try {
  db.exec(schema);
  // Migration for new columns
  try {
    db.prepare('ALTER TABLE streams ADD COLUMN input_status TEXT DEFAULT "unknown"').run();
  } catch (e) {}
  try {
    db.prepare('ALTER TABLE streams ADD COLUMN source_type TEXT DEFAULT "unknown"').run();
  } catch (e) {}
  try {
    db.prepare('ALTER TABLE streams ADD COLUMN uptime INTEGER DEFAULT 0').run();
  } catch (e) {}
} catch (e: any) {
  if (e.code === 'SQLITE_CORRUPT' || e.message?.includes('malformed')) {
    console.error('Database corrupted on schema exec, recreating...');
    db.close();
    [dbPath, `${dbPath}-shm`, `${dbPath}-wal`].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(schema);
  } else {
    throw e;
  }
}

// Initialize settings if empty
const initSettings = () => {
  try {
    db.exec('ALTER TABLE streams ADD COLUMN push_urls TEXT DEFAULT "[]"');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec('ALTER TABLE streams ADD COLUMN push_status TEXT DEFAULT "[]"');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec("ALTER TABLE videos ADD COLUMN sort_order INTEGER DEFAULT 0");
    db.exec("ALTER TABLE videos ADD COLUMN duration INTEGER DEFAULT 0");
    // Initialize sort_order from existing row order
    const vids = db.prepare('SELECT id FROM videos ORDER BY created_at ASC').all() as any[];
    vids.forEach((v, i) => db.prepare('UPDATE videos SET sort_order = ? WHERE id = ?').run(i, v.id));
  } catch (e) { /* Column already exists */ }

  try {
    db.exec("ALTER TABLE streams ADD COLUMN inputs TEXT DEFAULT '[]'");
    const streams = db.prepare('SELECT * FROM streams').all() as any[];
    const updateStmt = db.prepare('UPDATE streams SET inputs = ? WHERE id = ?');
    for (const s of streams) {
      const inputs = [];
      if (s.live_url) inputs.push(s.live_url);
      if (s.playlist_url) inputs.push(s.playlist_url);
      updateStmt.run(JSON.stringify(inputs), s.id);
    }
  } catch (e) {
    // Column already exists
  }

  const telegramEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_enabled');
  if (!telegramEnabled) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('telegram_enabled', 'false');
  }

  const telegramBotToken = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_bot_token');
  if (!telegramBotToken) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('telegram_bot_token', '');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('telegram_chat_id', '');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('watchdog_interval', '5');
  } else {
    // Update existing default from 60 to 5 for better real-time updates
    db.exec("UPDATE settings SET value = '5' WHERE key = 'watchdog_interval' AND value = '60'");
  }

  const autoSyncEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_sync_enabled');
  if (!autoSyncEnabled) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('auto_sync_enabled', 'false');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('auto_sync_interval', '60');
  }

  // Create default admin user if not exists
  const adminUser = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  if (!adminUser) {
    const defaultPassword = 'admin123';
    const passwordHash = bcrypt.hashSync(defaultPassword, SALT_ROUNDS);
    db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)').run(
      'admin',
      passwordHash,
      'admin@localhost',
      'admin'
    );
    console.log('Default admin user created. Username: admin, Password: admin123');
  }

  // Migration to make server_id nullable and add ON DELETE SET NULL
  try {
    const tableInfo = db.prepare("PRAGMA table_info(streams)").all() as any[];
    const serverIdCol = tableInfo.find(c => c.name === 'server_id');
    if (serverIdCol && serverIdCol.notnull === 1) {
      console.log('Migrating streams table to allow NULL server_id...');
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE streams_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id INTEGER,
            name TEXT NOT NULL,
            live_url TEXT NOT NULL,
            playlist_url TEXT NOT NULL,
            push_urls TEXT DEFAULT '[]',
            push_status TEXT DEFAULT '[]',
            status TEXT DEFAULT 'unknown',
            last_checked DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            inputs TEXT DEFAULT '[]',
            FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL
          );
          INSERT INTO streams_new (id, server_id, name, live_url, playlist_url, push_urls, push_status, status, last_checked, created_at, inputs)
          SELECT id, server_id, name, live_url, playlist_url, push_urls, push_status, status, last_checked, created_at, inputs FROM streams;
          DROP TABLE streams;
          ALTER TABLE streams_new RENAME TO streams;
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
  } catch (e) {
    console.error('Failed to migrate streams table:', e);
    db.pragma('foreign_keys = ON');
  }

  try {
    const tableInfo = db.prepare("PRAGMA table_info(vods)").all() as any[];
    const serverIdCol = tableInfo.find(c => c.name === 'server_id');
    if (serverIdCol && serverIdCol.notnull === 1) {
      console.log('Migrating vods table to allow NULL server_id...');
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE vods_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id INTEGER,
            name TEXT NOT NULL,
            paths TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL
          );
          INSERT INTO vods_new (id, server_id, name, paths, created_at)
          SELECT id, server_id, name, paths, created_at FROM vods;
          DROP TABLE vods;
          ALTER TABLE vods_new RENAME TO vods;
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
  } catch (e) {
    console.error('Failed to migrate vods table:', e);
    db.pragma('foreign_keys = ON');
  }
};
initSettings();

// --- API Routes ---

// Authentication
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  
  console.log('Login attempt for username:', username);
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  console.log('User found:', !!user);
  if (user) {
    console.log('User role:', user.role);
  }
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const passwordMatch = bcrypt.compareSync(password, user.password_hash);
  console.log('Password match:', passwordMatch);
  
  if (!passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  });
  
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/auth/me', authenticateToken, (req: AuthRequest, res) => {
  const user = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// User Management (Admin only)
app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, email, role, created_at FROM users').all();
  res.json(users);
});

app.post('/api/users', authenticateToken, requireAdmin, (req, res) => {
  const { username, password, email, role } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existingUser) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const info = db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)').run(
    username,
    passwordHash,
    email || null,
    role || 'client'
  );
  
  const user = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json(user);
});

app.put('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { username, email, role, password } = req.body;
  
  const existingUser = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existingUser) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (username && username !== existingUser.username) {
    const usernameExists = db.prepare('SELECT * FROM users WHERE username = ? AND id != ?').get(username, id);
    if (usernameExists) {
      return res.status(400).json({ error: 'Username already exists' });
    }
  }
  
  const updates: any[] = [];
  const values: any[] = [];
  
  if (username) {
    updates.push('username = ?');
    values.push(username);
  }
  if (email !== undefined) {
    updates.push('email = ?');
    values.push(email);
  }
  if (role) {
    updates.push('role = ?');
    values.push(role);
  }
  if (password) {
    updates.push('password_hash = ?');
    values.push(bcrypt.hashSync(password, SALT_ROUNDS));
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }
  
  values.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  
  const user = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(id);
  res.json(user);
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true });
});

// Stream Assignments
app.get('/api/users/:userId/streams', authenticateToken, requireAdmin, (req, res) => {
  const { userId } = req.params;
  const assignments = db.prepare(`
    SELECT usa.*, streams.name as stream_name, streams.server_id
    FROM user_stream_assignments usa
    JOIN streams ON usa.stream_id = streams.id
    WHERE usa.user_id = ?
  `).all(userId);
  res.json(assignments);
});

app.post('/api/users/:userId/streams', authenticateToken, requireAdmin, (req, res) => {
  const { userId } = req.params;
  const { streamId } = req.body;
  
  if (!streamId) {
    return res.status(400).json({ error: 'Stream ID is required' });
  }
  
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  
  try {
    db.prepare('INSERT INTO user_stream_assignments (user_id, stream_id) VALUES (?, ?)').run(userId, streamId);
    res.json({ success: true });
  } catch (e: any) {
    if (e.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: 'Stream already assigned to this user' });
    }
    throw e;
  }
});

app.delete('/api/users/:userId/streams/:streamId', authenticateToken, requireAdmin, (req, res) => {
  const { userId, streamId } = req.params;
  
  db.prepare('DELETE FROM user_stream_assignments WHERE user_id = ? AND stream_id = ?').run(userId, streamId);
  res.json({ success: true });
});

// Get current user's assigned streams
app.get('/api/my-streams', authenticateToken, (req: AuthRequest, res) => {
  console.log('Fetching streams for user:', req.user.username, 'role:', req.user.role);
  
  if (req.user.role === 'admin') {
    const streams = db.prepare(`
      SELECT streams.*, servers.name as server_name, servers.url as server_url
      FROM streams
      LEFT JOIN servers ON streams.server_id = servers.id
    `).all();
    console.log('Admin user, returning all streams:', streams.length);
    return res.json(streams.map(parseStream));
  }
  
  const streams = db.prepare(`
    SELECT streams.*, servers.name as server_name, servers.url as server_url
    FROM streams
    JOIN user_stream_assignments ON streams.id = user_stream_assignments.stream_id
    LEFT JOIN servers ON streams.server_id = servers.id
    WHERE user_stream_assignments.user_id = ?
  `).all(req.user.id);
  
  console.log('Client user, returning assigned streams:', streams.length);
  res.json(streams.map(parseStream));
});

// Servers
app.get('/api/servers', authenticateToken, requireAdmin, async (req, res) => {
  const servers = db.prepare(`
    SELECT s.*, 
      (SELECT COUNT(*) FROM streams WHERE server_id = s.id AND status = 'online') as online_streams,
      (SELECT COUNT(*) FROM streams WHERE server_id = s.id AND status = 'offline') as offline_streams
    FROM servers s
  `).all();
  
  // Check real-time status for each server
  const serversWithStatus = await Promise.all(servers.map(async (server: any) => {
    try {
      const configUrl = `${server.url}/flussonic/api/v3/config`;
      const response = await flussonicRequest('GET', configUrl, server);
      
      return {
        ...server,
        status: 'online',
        last_checked: new Date().toISOString(),
        config: response.data || null
      };
    } catch (error: any) {
      console.error(`Failed to check server ${server.name} status:`, error.message);
      return {
        ...server,
        status: 'offline',
        last_checked: new Date().toISOString(),
        config: null
      };
    }
  }));
  
  res.json(serversWithStatus);
});

app.post('/api/servers', authenticateToken, requireAdmin, async (req, res) => {
  const { name, url, api_key } = req.body;
  
  // Input validation
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Server name is required' });
  }
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Valid server URL is required (must start with http:// or https://)' });
  }
  if (!api_key || typeof api_key !== 'string' || api_key.trim().length === 0) {
    return res.status(400).json({ error: 'API key is required' });
  }
  
  const stmt = db.prepare('INSERT INTO servers (name, url, api_key) VALUES (?, ?, ?)');
  const info = stmt.run(name.trim(), url.trim(), api_key.trim());
  
  const server = { id: info.lastInsertRowid, name: name.trim(), url: url.trim(), api_key: api_key.trim() };
  
  // Auto-sync the newly added server
  try {
    const { addedCount } = await syncServerStreams(server);
    const vodSync = await syncServerVods(server);
    
    if (addedCount > 0 || vodSync.addedCount > 0) {
      broadcastStreamsUpdate();
    }
  } catch (error: any) {
    console.warn(`Failed to auto-sync new server ${name}:`, error.message);
  }

  res.json(server);
});

// Check single server status
app.get('/api/servers/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    const configUrl = `${server.url}/flussonic/api/v3/config`;
    const response = await flussonicRequest('GET', configUrl, server);
    
    res.json({
      status: 'online',
      last_checked: new Date().toISOString(),
      config: response.data || null
    });
  } catch (error: any) {
    console.error(`Failed to check server status:`, error.message);
    res.json({
      status: 'offline',
      last_checked: new Date().toISOString(),
      config: null,
      error: error.message
    });
  }
});

app.delete('/api/servers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const serverId = req.params.id;
    console.log(`Attempting to delete server with ID: ${serverId}`);
    const serverToDelete = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    
    if (!serverToDelete) {
      console.warn(`Server with ID ${serverId} not found for deletion`);
      return res.status(404).json({ error: 'Server not found' });
    }

    // Check if there are streams or vods associated with this server
    const streams = db.prepare('SELECT * FROM streams WHERE server_id = ?').all(serverId) as any[];
    const vods = db.prepare('SELECT * FROM vods WHERE server_id = ?').all(serverId) as any[];
    
    console.log(`Server ${serverId} has ${streams.length} streams and ${vods.length} VODs`);

    // Look for a duplicate server (same URL) to reassign to
    const normalizedUrl = serverToDelete.url.replace(/\/$/, '');
    const duplicateServer = db.prepare('SELECT id FROM servers WHERE (url = ? OR url = ? OR url = ?) AND id != ?')
      .get(normalizedUrl, normalizedUrl + '/', serverToDelete.url, serverId) as any;
    
    if (duplicateServer) {
      // Reassign to the duplicate server (no effect on Flussonic)
      console.log(`Reassigning data from server ${serverId} to duplicate server ${duplicateServer.id}`);
      db.prepare('UPDATE streams SET server_id = ? WHERE server_id = ?').run(duplicateServer.id, serverId);
      db.prepare('UPDATE vods SET server_id = ? WHERE server_id = ?').run(duplicateServer.id, serverId);
    } else {
      // No duplicate, so we should effect the Flussonic server as requested
      console.log(`No duplicate server found for ${serverId}, deleting associated data from Flussonic and local DB`);
      
      // Delete streams from Flussonic
      for (const stream of streams) {
        const flussonicUrl = `${serverToDelete.url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
        await flussonicRequest('DELETE', flussonicUrl, serverToDelete)
          .catch(e => console.error(`Failed to delete stream ${stream.name} from Flussonic:`, e.message));
        
        // Also try to delete the associated VOD location if it exists (Flussonic often creates one for streams)
        const vodUrl = `${serverToDelete.url}/flussonic/api/v3/vods/${encodeURIComponent(stream.name)}`;
        await flussonicRequest('DELETE', vodUrl, serverToDelete)
          .catch(() => {}); // Ignore errors for this secondary delete
      }

      // Delete VOD locations from Flussonic
      for (const vod of vods) {
        const flussonicUrl = `${serverToDelete.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
        await flussonicRequest('DELETE', flussonicUrl, serverToDelete)
          .catch(e => console.error(`Failed to delete VOD ${vod.name} from Flussonic:`, e.message));
      }

      // Delete from local DB
      db.prepare('DELETE FROM streams WHERE server_id = ?').run(serverId);
      db.prepare('DELETE FROM vods WHERE server_id = ?').run(serverId);
    }

    console.log(`Deleting server ${serverId} from servers table`);
    db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    console.log(`Successfully deleted server ${serverId}`);
    
    broadcastStreamsUpdate(); // Notify clients
    res.json({ success: true });
  } catch (error: any) {
    console.error('Failed to delete server:', error);
    res.status(500).json({ error: error.message });
  }
});

// Streams
app.get('/api/streams', authenticateToken, (req: AuthRequest, res) => {
  try {
    let streams;
    if (req.user.role === 'admin') {
      streams = db.prepare(`
        SELECT streams.*, servers.name as server_name, servers.url as server_url 
        FROM streams 
        LEFT JOIN servers ON streams.server_id = servers.id
      `).all();
    } else {
      streams = db.prepare(`
        SELECT streams.*, servers.name as server_name, servers.url as server_url 
        FROM streams 
        LEFT JOIN servers ON streams.server_id = servers.id
        JOIN user_stream_assignments ON streams.id = user_stream_assignments.stream_id
        WHERE user_stream_assignments.user_id = ?
      `).all(req.user.id);
    }
    
    const parsedStreams = streams.map(parseStream);
    res.json(parsedStreams);
  } catch (error: any) {
    console.error('Failed to fetch streams:', error);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

app.post('/api/streams', authenticateToken, requireAdmin, async (req, res) => {
  const { server_id, name, inputs, push_urls } = req.body;
  
  // Input validation
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Stream name is required' });
  }
  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
    return res.status(400).json({ error: 'At least one input URL is required' });
  }
  if (push_urls && !Array.isArray(push_urls)) {
    return res.status(400).json({ error: 'Push URLs must be an array' });
  }
  
  const pushes = (push_urls || []).map((url: string) => ({ url }));
  const streamInputs = (inputs || []).map((url: string) => ({ url }));
  
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const baseUrl = server.url.replace(/\/$/, '');
    // Automatically create a VOD folder for this stream
    const vodName = name;
    const vodPath = `/storage/${vodName}`;
    
    // Check if VOD already exists in DB
    const existingVod = db.prepare('SELECT * FROM vods WHERE name = ? AND server_id = ?').get(vodName, server_id);
    if (!existingVod) {
      const vodPayload = {
        storages: [{ url: vodPath }]
      };
      const flussonicVodUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`;
      await flussonicRequest('PUT', flussonicVodUrl, server, vodPayload)
        .catch(e => {
          console.warn(`Flussonic create VOD error for ${vodName}:`, e.message);
          // Try alternative payload if first fails
          return flussonicRequest('PUT', flussonicVodUrl, server, { storage: vodPath })
            .catch(e2 => console.warn('Alternative VOD create failed:', e2.message));
        });
      
      db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)').run(server_id, vodName, JSON.stringify([vodPath]));
    }

    // Configure stream on Flussonic
    const flussonicUrl = `${baseUrl}/flussonic/api/v3/streams/${encodeURIComponent(name)}`;
    
    const payload: any = {
      inputs: streamInputs
    };
    if (pushes.length > 0) {
      payload.pushes = pushes;
    }

    await flussonicRequest('PUT', flussonicUrl, server, payload)
      .catch(e => console.warn('Flussonic create stream error (ignored for preview):', e.message));

    const stmt = db.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url, push_urls, inputs) VALUES (?, ?, ?, ?, ?, ?)');
    // Keep live_url and playlist_url empty for backward compatibility in DB, use inputs
    const info = stmt.run(server_id, name.trim(), '', '', JSON.stringify(push_urls || []), JSON.stringify(inputs || []));
    
    broadcastStreamsUpdate();
    res.json({ id: info.lastInsertRowid, server_id, name, inputs, push_urls });
  } catch (error: any) {
    console.error('Error creating stream on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to configure stream on Flussonic' });
  }
});

app.put('/api/streams/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { server_id, name, inputs, push_urls } = req.body;
  
  // Input validation
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Stream name is required' });
  }
  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
    return res.status(400).json({ error: 'At least one input URL is required' });
  }
  if (push_urls && !Array.isArray(push_urls)) {
    return res.status(400).json({ error: 'Push URLs must be an array' });
  }
  
  const pushes = (push_urls || []).map((url: string) => ({ url }));
  const streamInputs = (inputs || []).map((url: string) => ({ url }));
  
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
    if (!stream) return res.status(404).json({ error: 'Stream not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    // If name changed, we might need to delete old one and create new, but for simplicity let's just update the new one
    if (stream.name !== name) {
      const oldServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
      if (oldServer) {
        const oldFlussonicUrl = `${oldServer.url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
        await flussonicRequest('DELETE', oldFlussonicUrl, oldServer)
          .catch(e => console.error('Flussonic delete error (ignored):', e.message));
      }
    }

    // Automatically create a VOD folder for this stream if it doesn't exist
    const vodName = name;
    const vodPath = `/storage/${vodName}`;
    const existingVod = db.prepare('SELECT * FROM vods WHERE name = ? AND server_id = ?').get(vodName, server_id);
    if (!existingVod) {
      const vodPayload = {
        storages: [{ url: vodPath }]
      };
      const flussonicVodUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vodName)}`;
      await flussonicRequest('PUT', flussonicVodUrl, server, vodPayload)
        .catch(e => console.warn('Flussonic create VOD error (ignored for preview):', e.message));
      
      db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)').run(server_id, vodName, JSON.stringify([vodPath]));
    }

    const flussonicUrl = `${server.url}/flussonic/api/v3/streams/${encodeURIComponent(name)}`;
    const payload: any = {
      name,
      inputs: streamInputs
    };
    if (pushes.length > 0) {
      payload.pushes = pushes;
    }

    await flussonicRequest('PUT', flussonicUrl, server, payload)
      .catch(e => console.warn('Flussonic update stream error (ignored for preview):', e.message));

    const stmt = db.prepare('UPDATE streams SET server_id = ?, name = ?, inputs = ?, push_urls = ? WHERE id = ?');
    stmt.run(server_id, name.trim(), JSON.stringify(inputs || []), JSON.stringify(push_urls || []), req.params.id);
    
    broadcastStreamsUpdate();
    res.json({ id: req.params.id, server_id, name, inputs, push_urls });
  } catch (error: any) {
    console.error('Error updating stream on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to update stream on Flussonic' });
  }
});

app.delete('/api/streams/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
    if (stream) {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
      if (server) {
        // Delete from Flussonic
        const flussonicUrl = `${server.url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
        await flussonicRequest('DELETE', flussonicUrl, server)
          .catch(e => console.error('Flussonic delete error (ignored):', e.message));
          
        // Also try to delete the associated VOD location if it exists
        const vodUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(stream.name)}`;
        await flussonicRequest('DELETE', vodUrl, server)
          .catch(e => console.error('Flussonic delete VOD error (ignored):', e.message));
      }
    }
    db.prepare('DELETE FROM streams WHERE id = ?').run(req.params.id);
    if (stream) {
      db.prepare('DELETE FROM vods WHERE name = ? AND server_id = ?').run(stream.name, stream.server_id);
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/streams/:id/details', authenticateToken, requireStreamAccess, async (req, res) => {
  try {
    const stream = db.prepare(`
      SELECT streams.*, servers.name as server_name, servers.url as server_url, servers.api_key 
      FROM streams 
      LEFT JOIN servers ON streams.server_id = servers.id
      WHERE streams.id = ?
    `).get(req.params.id) as any;

    if (!stream) return res.status(404).json({ error: 'Stream not found' });

    try {
      stream.push_urls = JSON.parse(stream.push_urls || '[]');
    } catch (e) {
      stream.push_urls = [];
    }

    try {
      stream.push_status = JSON.parse(stream.push_status || '[]');
    } catch (e) {
      stream.push_status = [];
    }

    try {
      stream.inputs = JSON.parse(stream.inputs || '[]');
    } catch (e) {
      stream.inputs = [];
    }

    if (stream.server_url && stream.api_key) {
      try {
        const flussonicUrl = `${stream.server_url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
        const response = await flussonicRequest('GET', flussonicUrl, { api_key: stream.api_key });
        const fData = response.data;

        // Use Flussonic real inputs (has url field)
        const flussonicInputs: any[] = fData.inputs || [];
        const configInputs: any[] = fData.config_on_disk?.inputs || [];
        stream.flussonic_inputs = flussonicInputs;

        // Derive source_type from real Flussonic inputs
        const firstInput = flussonicInputs[0] || configInputs[0];
        const inputUrl: string = firstInput?.url || '';
        if (inputUrl.startsWith('publish://')) {
          stream.source_type = 'publish';
        } else if (inputUrl.startsWith('rtmp://') || inputUrl.startsWith('rtsp://') || inputUrl.startsWith('srt://') || inputUrl.startsWith('udp://') || inputUrl.startsWith('http')) {
          stream.source_type = 'live';
        } else if (inputUrl.includes('.m3u8') || inputUrl.includes('.m3u')) {
          stream.source_type = 'playlist';
        } else if (inputUrl.includes('.mp4') || inputUrl.includes('.mkv') || inputUrl.startsWith('file://')) {
          stream.source_type = 'static';
        } else if (inputUrl) {
          stream.source_type = 'live';
        } else {
          stream.source_type = 'unknown';
        }

        // Use Flussonic real stats
        const fStats = fData.stats || {};
        stream.flussonic_stats = fStats;
        stream.status = (fStats.alive === true || fStats.running === true || fStats.status === 'running') ? 'online' : 'offline';
        stream.input_status = flussonicInputs.length > 0 && flussonicInputs[0].stats ? 'online' : 'offline';
        stream.bitrate = fStats.bitrate || 0;
        stream.client_count = fStats.client_count || 0;
        stream.uptime = fStats.lifetime ? Math.floor(fStats.lifetime / 1000) : 0;
        stream.published_via = fStats.published_via || null;
        stream.published_from = fStats.published_from || null;

        // Real push statuses from Flussonic
        const fPushes: any[] = fData.pushes || [];
        stream.flussonic_pushes = fPushes;

        // Media info (codec, resolution)
        stream.media_info = fStats.media_info || flussonicInputs[0]?.stats?.media_info || null;
      } catch (e: any) {
        stream.flussonic_error = e.message;
        if (e.response && e.response.status === 404) {
          stream.source_type = stream.source_type || 'unknown';
          stream.status = 'offline';
          stream.flussonic_pushes = stream.push_urls.map((url: string) => ({ url, status: 'offline' }));
        } else {
          stream.source_type = stream.source_type || 'unknown';
          stream.flussonic_pushes = stream.push_urls.map((url: string) => ({ url, status: 'unknown' }));
        }
      }
    } else {
      stream.source_type = stream.source_type || 'unknown';
      stream.flussonic_pushes = stream.push_urls.map((url: string) => ({ url, status: 'unknown' }));
    }

    delete stream.api_key;
    res.json(stream);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Helper to sync streams for a server
async function syncServerStreams(server: any) {
  const baseUrl = server.url.replace(/\/$/, '');
  const flussonicUrl = `${baseUrl}/flussonic/api/v3/streams`;
  const response = await flussonicRequest('GET', flussonicUrl, server);

  let streams: any[] = [];
  if (Array.isArray(response.data)) {
    streams = response.data;
  } else if (response.data && Array.isArray(response.data.streams)) {
    streams = response.data.streams;
  } else if (response.data && typeof response.data === 'object') {
    streams = Object.keys(response.data).map(key => {
      const val = response.data[key];
      if (typeof val === 'object' && val !== null) {
        return { name: key, ...val };
      }
      return { name: key };
    });
  }

  let addedCount = 0;
  let removedCount = 0;

  const insertStmt = db.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url, push_urls, status) VALUES (?, ?, ?, ?, ?, ?)');
  const checkStmt = db.prepare('SELECT id FROM streams WHERE server_id = ? AND name = ?');
  const deleteStmt = db.prepare('DELETE FROM streams WHERE id = ?');
  
  // Get all existing streams for this server
  const existingStreams = db.prepare('SELECT id, name FROM streams WHERE server_id = ?').all(server.id) as any[];
  const existingStreamNames = new Set(existingStreams.map(s => s.name));
  const remoteStreamNames = new Set(streams.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean));

  // Add new streams
  for (const s of streams) {
    let name = typeof s === 'string' ? s : s.name;
    if (!name) continue;

    if (!existingStreamNames.has(name)) {
      let live_url = '';
      let playlist_url = '';
      let push_urls: string[] = [];
      let status = 'offline';

      if (typeof s !== 'string') {
        if (s.inputs && s.inputs.length > 0) {
          live_url = s.inputs[0].url || '';
          if (s.inputs.length > 1) {
            playlist_url = s.inputs[1].url || '';
          }
        }
        push_urls = s.pushes ? s.pushes.map((p: any) => p.url) : [];
        status = (s.stats && s.stats.alive) ? 'online' : 'offline';
      }

      insertStmt.run(server.id, name, live_url, playlist_url, JSON.stringify(push_urls), status);
      addedCount++;
    }
  }

  // Remove deleted streams
  for (const existing of existingStreams) {
    if (!remoteStreamNames.has(existing.name)) {
      deleteStmt.run(existing.id);
      removedCount++;
    }
  }

  return { addedCount, removedCount };
}

// Helper to sync VODs for a server
async function syncServerVods(server: any) {
  const baseUrl = server.url.replace(/\/$/, '');
  const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods`;
  try {
    let response;
    try {
      response = await flussonicRequest('GET', flussonicUrl, server);
      console.log(`[syncServerVods] /vods response for ${server.name}:`, JSON.stringify(response.data).substring(0, 500));
    } catch (e: any) {
      if (e.response && e.response.status === 404) {
        // Fallback to config API if /vods endpoint is not available
        const configUrl = `${baseUrl}/flussonic/api/v3/config`;
        response = await flussonicRequest('GET', configUrl, server);
        console.log(`[syncServerVods] /config response for ${server.name}:`, JSON.stringify(response.data.vods || {}).substring(0, 500));
        if (response.data && response.data.vods) {
          response.data = response.data.vods;
        } else {
          throw new Error('No VODs found in config');
        }
      } else {
        throw e;
      }
    }
    
    let vodsList: any[] = [];
    if (Array.isArray(response.data)) {
      vodsList = response.data;
    } else if (response.data && Array.isArray(response.data.vods)) {
      vodsList = response.data.vods;
    } else if (response.data && typeof response.data === 'object') {
      // Handle case where Flussonic returns an object with VOD names as keys
      vodsList = Object.keys(response.data).map(key => {
        const val = response.data[key];
        if (typeof val === 'object' && val !== null) {
          return { name: key, ...val };
        }
        return { name: key };
      });
    }
    
    let addedCount = 0;
    let removedCount = 0;

    const insertStmt = db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)');
    const deleteStmt = db.prepare('DELETE FROM vods WHERE id = ?');
    
    const existingVods = db.prepare('SELECT id, name FROM vods WHERE server_id = ?').all(server.id) as any[];
    const existingVodNames = new Set(existingVods.map(v => v.name));
    
    const remoteVodNames = new Set();

    // Add new VODs
    for (const item of vodsList) {
      let name = item.name || item.prefix;
      let paths: string[] = [];
      
      // If Flussonic returns an array of strings (just names) instead of objects
      if (typeof item === 'string') {
        name = item;
        try {
          const detailRes = await flussonicRequest('GET', `${flussonicUrl}/${encodeURIComponent(name)}`, server);
          paths = detailRes.data.storages ? detailRes.data.storages.map((s: any) => s.url) : [];
        } catch (e) {
          console.warn(`Failed to fetch details for VOD ${name}`);
        }
      } else if (item && (item.name || item.prefix)) {
        name = item.name || item.prefix;
        if (item.storages && Array.isArray(item.storages)) {
          paths = item.storages.map((s: any) => s.url || s.path || s);
        } else if (item.storage) {
          paths = Array.isArray(item.storage) ? item.storage : [item.storage];
        } else if (item.path) {
          paths = Array.isArray(item.path) ? item.path : [item.path];
        } else if (item.url) {
          paths = Array.isArray(item.url) ? item.url : [item.url];
        }
      }

      if (!name) continue;
      remoteVodNames.add(name);

      if (!existingVodNames.has(name)) {
        insertStmt.run(server.id, name, JSON.stringify(paths));
        addedCount++;
      }
    }

    // Remove deleted VODs
    for (const existing of existingVods) {
      if (!remoteVodNames.has(existing.name)) {
        deleteStmt.run(existing.id);
        removedCount++;
      }
    }

    return { addedCount, removedCount };
  } catch (error: any) {
    console.warn(`Failed to sync VODs for server ${server.name}:`, error.message);
    return { addedCount: 0, removedCount: 0 };
  }
}

// Stream VOD Videos
app.get('/api/streams/:id/videos', authenticateToken, requireStreamAccess, (req, res) => {
  const stream = db.prepare('SELECT id FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  
  const videos = db.prepare('SELECT id, filename as name, size, duration, sort_order, created_at FROM videos WHERE stream_id = ? ORDER BY sort_order ASC, created_at ASC').all(req.params.id);
  res.json(videos);
});

// Reorder playlist
app.put('/api/streams/:id/videos/order', authenticateToken, requireStreamAccess, (req, res) => {
  const { order } = req.body; // array of video ids in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of ids' });
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const update = db.prepare('UPDATE videos SET sort_order = ? WHERE id = ? AND stream_id = ?');
  db.transaction(() => { order.forEach((id: number, i: number) => update.run(i, id, stream.id)); })();
  // Regenerate playlist with new order
  updatePlaylistFile(stream).catch(e => console.warn('Playlist update after reorder:', e.message));
  res.json({ success: true });
});

// Update video duration
app.patch('/api/streams/:id/videos/:videoId/duration', authenticateToken, requireStreamAccess, (req, res) => {
  const { duration } = req.body;
  db.prepare('UPDATE videos SET duration = ? WHERE id = ? AND stream_id = ?').run(duration || 0, req.params.videoId, req.params.id);
  res.json({ success: true });
});

async function updatePlaylistFile(stream: any) {
  const videos = db.prepare('SELECT filename FROM videos WHERE stream_id = ? ORDER BY sort_order ASC, created_at ASC').all(stream.id) as any[];
  // VOD named `khabar70` has storage /storage/khabar70.
  // Playlist entries are BARE filenames (e.g. video.mp4), because Flussonic resolves them
  // as <vod_storage_root>/<entry> = /storage/khabar70/video.mp4.
  // Adding the vodname/ prefix would double-resolve: /storage/khabar70/khabar70/video.mp4 (wrong).
  const playlistContent = videos.map(v => {
    const fname = v.filename as string;
    // Strip any accidental streamname/ prefix that may have been stored in DB
    if (fname.startsWith(`${stream.name}/`)) return fname.slice(stream.name.length + 1);
    return fname;
  }).join('\n');

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
  if (!server) return;

  // 1. Upload playlist.txt to Flussonic VOD storage (standard Flussonic filename)
  const playlistFilename = 'playlist.txt';
  try {
    const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(stream.name)}/storages/0/files/${playlistFilename}`;
    await flussonicRequest('PUT', uploadUrl, server, playlistContent, 30000, { 'Content-Type': 'text/plain' });
    console.log(`Playlist uploaded to Flussonic VOD: ${stream.name}/playlist.txt`);
  } catch (e: any) {
    console.warn('Failed to upload playlist.txt to Flussonic VOD:', e.message);
    return;
  }

  // 2. Update stream inputs to use playlist:// as fallback
  // playlist:///khabar70/playlist.txt — triple slash = Flussonic resolves via VOD named khabar70
  const playlistInputUrl = `playlist:///${stream.name}/playlist.txt`;
  try {
    const flussonicStreamUrl = `${server.url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
    const streamResponse = await flussonicRequest('GET', flussonicStreamUrl, server);
    const fData = streamResponse.data;
    const existingInputs: any[] = fData.config_on_disk?.inputs || fData.inputs || [];

    // Keep the primary input, replace/add the playlist:// fallback
    let newInputs: any[];
    if (existingInputs.length === 0) {
      newInputs = [{ url: playlistInputUrl }];
    } else {
      // Keep all non-playlist:// inputs, then append playlist:// as last fallback
      const primaryInputs = existingInputs.filter((inp: any) => !inp.url?.startsWith('playlist://'));
      newInputs = [...primaryInputs, { url: playlistInputUrl }];
    }

    await flussonicRequest('PUT', flussonicStreamUrl, server, {
      name: stream.name,
      inputs: newInputs,
      ...(fData.config_on_disk?.pushes ? { pushes: fData.config_on_disk.pushes } : {})
    });

    // Persist the updated inputs in our DB
    const inputUrls = newInputs.map((i: any) => i.url);
    db.prepare('UPDATE streams SET inputs = ? WHERE id = ?').run(JSON.stringify(inputUrls), stream.id);
    console.log(`Stream inputs updated on Flussonic: ${stream.name} -> ${JSON.stringify(inputUrls)}`);
  } catch (e: any) {
    console.warn('Failed to update stream inputs on Flussonic:', e.message);
  }
}

app.post('/api/streams/:id/videos', authenticateToken, requireStreamAccess, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Stream not found' });
  }

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
    if (!server) throw new Error('Server not found');

    // Upload video to Flussonic
    const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(stream.name)}/storages/0/files/${req.file.originalname}`;
    const fileBuffer = fs.readFileSync(req.file.path);
    
    try {
      await flussonicRequest('PUT', uploadUrl, server, fileBuffer);
    } catch (uploadError: any) {
      if (uploadError.response && uploadError.response.status === 404) {
        // VOD doesn't exist, create it
        console.log(`VOD ${stream.name} not found, creating it...`);
        const createVodUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(stream.name)}`;
        await flussonicRequest('PUT', createVodUrl, server, {
          storages: [{ url: `/storage/vods/${stream.name}` }]
        });
        
        // Also save it to our database so it shows up in VODs page
        db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)').run(server.id, stream.name, JSON.stringify([`/storage/vods/${stream.name}`]));
        
        // Try uploading again
        await flussonicRequest('PUT', uploadUrl, server, fileBuffer);
      } else {
        throw uploadError;
      }
    }
    console.log(`Video uploaded to Flussonic VOD: ${stream.name}/${req.file.originalname}`);

    // Insert into database
    db.prepare('INSERT INTO videos (stream_id, filename, size) VALUES (?, ?, ?)').run(stream.id, req.file.originalname, req.file.size);

    await updatePlaylistFile(stream);
    
    res.json({ success: true, filename: req.file.originalname });
  } catch (error: any) {
    console.error('Failed to upload video to Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to upload video to Flussonic' });
  } finally {
    // Clean up temp file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

app.delete('/api/streams/:id/videos/:filename', authenticateToken, requireStreamAccess, async (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  
  const video = db.prepare('SELECT * FROM videos WHERE stream_id = ? AND filename = ?').get(stream.id, req.params.filename) as any;
  if (!video) return res.status(404).json({ error: 'File not found' });

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
    if (server) {
      // Delete video from Flussonic
      const deleteUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(stream.name)}/storages/0/files/${req.params.filename}`;
      await flussonicRequest('DELETE', deleteUrl, server).catch(e => console.warn('Failed to delete from Flussonic (ignored):', e.message));
      console.log(`Video deleted from Flussonic VOD: ${stream.name}/${req.params.filename}`);
    }

    // Delete from database
    db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);

    await updatePlaylistFile(stream);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Failed to delete video from Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to delete video from Flussonic' });
  }
});

app.get('/api/streams/:id/playlist.txt', authenticateToken, requireStreamAccess, (req, res) => {
  const stream = db.prepare('SELECT id, name FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).send('Stream not found');
  
  const videos = db.prepare('SELECT filename FROM videos WHERE stream_id = ? ORDER BY sort_order ASC, created_at ASC').all(stream.id) as any[];
  if (videos.length === 0) {
    return res.type('text/plain').send('');
  }
  
  const playlistContent = videos.map((v: any) => {
    const fname = v.filename as string;
    if (fname.startsWith(`${stream.name}/`)) return fname.slice(stream.name.length + 1);
    return fname;
  }).join('\n');
  res.type('text/plain').send(playlistContent);
});

// Fetch live VOD files from Flussonic for a stream (shows what is actually on the server)
app.get('/api/streams/:id/vod-files', authenticateToken, requireStreamAccess, async (req, res) => {
  try {
    const stream = db.prepare('SELECT streams.*, servers.url as server_url, servers.api_key FROM streams LEFT JOIN servers ON streams.server_id = servers.id WHERE streams.id = ?').get(req.params.id) as any;
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (!stream.server_url || !stream.api_key) return res.json({ files: [] });

    const baseUrl = stream.server_url.replace(/\/$/, '');
    const encodedName = encodeURIComponent(stream.name);
    const urls = [
      `${baseUrl}/flussonic/api/v3/vods/${encodedName}/storages/0/files`,
      `${baseUrl}/flussonic/api/v3/vods/${encodedName}/files`,
    ];

    let files: any[] = [];
    for (const url of urls) {
      try {
        const r = await flussonicRequest('GET', url, { api_key: stream.api_key });
        const data = r.data;
        files = Array.isArray(data) ? data : (Array.isArray(data?.files) ? data.files : []);
        if (files.length > 0) break;
      } catch (e: any) {
        if (e.response?.status !== 404) console.warn('[vod-files]', url, e.message);
      }
    }

    const result = files
      .filter((f: any) => f.type !== 'directory')
      .map((f: any) => ({
        name: f.path || f.name || f.filename,
        size: f.size || 0,
        type: f.type || 'file',
      }));

    delete stream.api_key;
    res.json({ files: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Sync Streams from Server
app.post('/api/servers/:id/sync', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const { addedCount, removedCount } = await syncServerStreams(server);
    const vodSync = await syncServerVods(server);

    if (addedCount > 0 || removedCount > 0) {
      broadcastStreamsUpdate();
    }

    res.json({ 
      success: true, 
      added: addedCount, 
      removed: removedCount,
      vodsAdded: vodSync.addedCount,
      vodsRemoved: vodSync.removedCount
    });
  } catch (error: any) {
    console.error(`Sync error for server ${req.params.id}:`, error.message);
    res.json({ success: false, added: 0, removed: 0, error: error.message });
  }
});

// Sync All Servers
app.post('/api/servers/sync-all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const servers = db.prepare('SELECT * FROM servers').all() as any[];
    let totalAdded = 0;
    let totalRemoved = 0;
    let totalVodsAdded = 0;
    let totalVodsRemoved = 0;

    for (const server of servers) {
      try {
        const { addedCount, removedCount } = await syncServerStreams(server);
        const vodSync = await syncServerVods(server);
        
        totalAdded += addedCount;
        totalRemoved += removedCount;
        totalVodsAdded += vodSync.addedCount;
        totalVodsRemoved += vodSync.removedCount;
      } catch (err: any) {
        console.error(`Failed to sync server ${server.name}:`, err.message);
      }
    }

    if (totalAdded > 0 || totalRemoved > 0) {
      broadcastStreamsUpdate();
    }

    res.json({ 
      success: true, 
      added: totalAdded, 
      removed: totalRemoved,
      vodsAdded: totalVodsAdded,
      vodsRemoved: totalVodsRemoved
    });
  } catch (error: any) {
    console.error('Failed to sync all streams:', error.message);
    res.status(500).json({ error: 'Failed to sync all streams' });
  }
});

// VODs
app.get('/api/vods', authenticateToken, requireAdmin, (req, res) => {
  const vods = db.prepare(`
    SELECT vods.*, servers.name as server_name 
    FROM vods 
    LEFT JOIN servers ON vods.server_id = servers.id
  `).all();
  res.json(vods.map((v: any) => {
    let paths = [];
    try {
      paths = JSON.parse(v.paths || '[]');
    } catch (e) {
      console.error('Failed to parse paths for vod', v.id);
    }
    return { ...v, paths };
  }));
});

app.post('/api/vods', authenticateToken, requireAdmin, async (req, res) => {
  const { server_id, name, paths } = req.body;
  
  // Input validation
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'VOD name is required' });
  }
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'At least one storage path is required' });
  }
  
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const baseUrl = server.url.replace(/\/$/, '');
    const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(name)}`;
    await flussonicRequest('PUT', flussonicUrl, server, {
      storages: paths.map((p: string) => ({ url: p }))
    }).catch(e => {
      console.warn(`Flussonic create VOD error for ${name}:`, e.message);
      // Try alternative payload
      if (paths.length > 0) {
        return flussonicRequest('PUT', flussonicUrl, server, { storage: paths[0] })
          .catch(e2 => console.warn('Alternative VOD create failed:', e2.message));
      }
    });

    const stmt = db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)');
    const info = stmt.run(server_id, name.trim(), JSON.stringify(paths));
    res.json({ id: info.lastInsertRowid, server_id, name: name.trim(), paths });
  } catch (error: any) {
    console.error('Error creating VOD on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to configure VOD on Flussonic' });
  }
});

app.put('/api/vods/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { server_id, name, paths } = req.body;
  
  // Input validation
  if (!server_id || typeof server_id !== 'number') {
    return res.status(400).json({ error: 'Valid server ID is required' });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'VOD name is required' });
  }
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'At least one storage path is required' });
  }
  
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const baseUrl = server.url.replace(/\/$/, '');
    const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(name)}`;
    
    // If name changed, we might need to delete old one and create new, but for simplicity let's just update the new one
    if (vod.name !== name) {
      const oldServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
      if (oldServer) {
        const oldBaseUrl = oldServer.url.replace(/\/$/, '');
        const oldFlussonicUrl = `${oldBaseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
        await flussonicRequest('DELETE', oldFlussonicUrl, oldServer).catch(() => {});
      }
    }

    await flussonicRequest('PUT', flussonicUrl, server, {
      storages: paths.map((p: string) => ({ url: p }))
    }).catch(e => {
      console.warn(`Flussonic update VOD error for ${name}:`, e.message);
      if (paths.length > 0) {
        return flussonicRequest('PUT', flussonicUrl, server, { storage: paths[0] })
          .catch(e2 => console.warn('Alternative VOD update failed:', e2.message));
      }
    });

    db.prepare('UPDATE vods SET server_id = ?, name = ?, paths = ? WHERE id = ?').run(server_id, name.trim(), JSON.stringify(paths), req.params.id);
    res.json({ id: req.params.id, server_id, name: name.trim(), paths });
  } catch (error: any) {
    console.error('Error updating VOD on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to update VOD on Flussonic' });
  }
});

app.delete('/api/vods/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (vod) {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
      if (server) {
        const flussonicUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
        await flussonicRequest('DELETE', flussonicUrl, server)
          .catch(e => console.error('Flussonic delete error:', e.message));
      }
    }
    db.prepare('DELETE FROM vods WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

async function updateVodPlaylistFile(vod: any) {
  const files = db.prepare("SELECT filename FROM vod_files WHERE vod_id = ? AND filename NOT LIKE '%playlist.txt' ORDER BY created_at ASC").all(vod.id) as any[];
  if (files.length === 0) return; // Don't create empty playlist

  const firstPart = vod.name.split('/')[0];
  const playlistContent = files.map(v => {
    if (v.filename.startsWith(`${firstPart}/`)) return v.filename;
    return `${firstPart}/${v.filename}`;
  }).join('\n');

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (server) {
      // Try to find the first storage that is not a read-only one if possible, but default to 0
      const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/playlist.txt`;
      await flussonicRequest('PUT', uploadUrl, server, playlistContent, 30000, { 'Content-Type': 'text/plain' });
      console.log(`Playlist uploaded to Flussonic VOD: ${vod.name}`);
    }
  } catch (e: any) {
    console.warn('Failed to upload playlist to Flussonic VOD:', e.message);
  }
}

async function syncVodFilesFromRemote(vod: any, server: any) {
  const baseUrl = server.url.replace(/\/$/, '');
  const encodedName = encodeURIComponent(vod.name);
  
  // Try multiple URL patterns for VOD files
  const urls = [
    `${baseUrl}/flussonic/api/v3/vods/${encodedName}/storages/0/files`,
    `${baseUrl}/flussonic/api/v3/vods/${encodedName}/files`,
    `${baseUrl}/flussonic/api/v3/vods/${vod.name}/storages/0/files`,
    `${baseUrl}/flussonic/api/v3/vods/${vod.name}/files`
  ];

  let response;
  let lastError;

  for (const url of urls) {
    try {
      console.log(`[syncVodFilesFromRemote] Trying URL: ${url}`);
      response = await flussonicRequest('GET', url, server);
      if (response && response.data) break;
    } catch (e: any) {
      lastError = e;
      console.warn(`[syncVodFilesFromRemote] Failed for ${url}:`, e.message);
      // Continue to next URL if it's a 404 or 500
      if (e.response && (e.response.status === 404 || e.response.status === 500)) {
        continue;
      }
      throw e;
    }
  }

  if (!response) {
    throw lastError || new Error('Failed to fetch VOD files from any known endpoint');
  }

  try {
    let remoteFiles: any[] = [];
    
    if (Array.isArray(response.data)) {
      remoteFiles = response.data;
    } else if (response.data && Array.isArray(response.data.files)) {
      remoteFiles = response.data.files;
    }

    db.transaction(() => {
      db.prepare('DELETE FROM vod_files WHERE vod_id = ?').run(vod.id);
      const insertStmt = db.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)');
      for (const file of remoteFiles) {
        const name = file.path || file.name;
        if (!name || name.endsWith('playlist.txt') || file.type === 'directory') continue;
        insertStmt.run(vod.id, name, file.size || 0);
      }
    })();

    await updateVodPlaylistFile(vod);
    return remoteFiles.length;
  } catch (e: any) {
    console.error(`Failed to process synced files for VOD ${vod.name}:`, e.message);
    throw e;
  }
}

app.get('/api/vods/:id/playlist/content', (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });
    
    const files = db.prepare("SELECT filename FROM vod_files WHERE vod_id = ? AND filename NOT LIKE '%playlist.txt' ORDER BY created_at ASC").all(vod.id) as any[];
    const firstPart = vod.name.split('/')[0];
    const playlistContent = files.map(v => {
      if (v.filename.startsWith(`${firstPart}/`)) return v.filename;
      return `${firstPart}/${v.filename}`;
    }).join('\n');
    
    res.json({ content: playlistContent });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vods/:id/playlist/update', async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });
    
    await updateVodPlaylistFile(vod);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// IP Blocking Management
app.get('/api/blocked-ips', authenticateToken, requireAdmin, (req, res) => {
  const blockedIps = db.prepare(`
    SELECT bi.*, u.username as blocked_by_username
    FROM blocked_ips bi
    LEFT JOIN users u ON bi.blocked_by = u.id
    ORDER BY bi.created_at DESC
  `).all();
  res.json(blockedIps);
});

app.post('/api/blocked-ips', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const { ip_address, reason, server_id } = req.body;
  
  if (!ip_address) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  
  if (!server_id) {
    return res.status(400).json({ error: 'Server ID is required' });
  }
  
  // Validate IP format
  const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  if (!ipRegex.test(ip_address)) {
    return res.status(400).json({ error: 'Invalid IP address format' });
  }
  
  try {
    const info = db.prepare('INSERT INTO blocked_ips (ip_address, reason, blocked_by) VALUES (?, ?, ?)').run(
      ip_address,
      reason || 'Manual block',
      req.user.id
    );
    
    // Block IP on Flussonic server using auth configurator
    try {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
      if (server) {
        // Add IP to blacklist via Flussonic API
        const blacklistUrl = `${server.url}/flussonic/api/v3/auth_backends/blacklist`;
        const blacklistData = {
          type: 'deny',
          ip: ip_address
        };
        await flussonicRequest('PUT', blacklistUrl, server, blacklistData);
        console.log(`Blocked IP ${ip_address} on Flussonic server ${server.name}`);
      }
    } catch (e: any) {
      console.error('Failed to block IP on Flussonic server:', e.message);
    }
    
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e: any) {
    if (e.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: 'IP address already blocked' });
    }
    throw e;
  }
});

app.delete('/api/blocked-ips/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { server_id } = req.body;
  
  const blockedIp = db.prepare('SELECT * FROM blocked_ips WHERE id = ?').get(id) as any;
  if (!blockedIp) {
    return res.status(404).json({ error: 'Blocked IP not found' });
  }
  
  db.prepare('DELETE FROM blocked_ips WHERE id = ?').run(id);
  
  // Remove from Flussonic server blacklist
  if (server_id) {
    try {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
      if (server) {
        // Remove IP from blacklist via Flussonic API
        const blacklistUrl = `${server.url}/flussonic/api/v3/auth_backends/blacklist/${blockedIp.ip_address}`;
        await flussonicRequest('DELETE', blacklistUrl, server);
        console.log(`Unblocked IP ${blockedIp.ip_address} from Flussonic server ${server.name}`);
      }
    } catch (e: any) {
      console.error('Failed to unblock IP on Flussonic server:', e.message);
    }
  }
  
  res.json({ success: true });
});

// Fetch play sessions from Flussonic
app.get('/api/servers/:serverId/sessions', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.serverId) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    // For non-admin users, check if they have access to any streams on this server
    if (req.user.role !== 'admin') {
      const userStreams = db.prepare(`
        SELECT s.id, s.name
        FROM streams s
        JOIN user_stream_assignments usa ON s.id = usa.stream_id
        WHERE usa.user_id = ? AND s.server_id = ?
      `).all(req.user.id, server.id);
      
      if (userStreams.length === 0) {
        return res.status(403).json({ error: 'You do not have access to any streams on this server' });
      }
    }
    
    // Try to fetch sessions from Flussonic
    // Note: Flussonic sessions API varies by version, using a generic approach
    const sessionsUrl = `${server.url}/flussonic/api/v3/sessions`;
    const response = await flussonicRequest('GET', sessionsUrl, server);
    
    // Log the response structure for debugging
    console.log('Flussonic sessions response:', JSON.stringify(response.data, null, 2));
    
    // Handle response - ensure it's an array
    let sessions = [];
    if (response.data) {
      if (Array.isArray(response.data)) {
        sessions = response.data;
      } else if (response.data.sessions && Array.isArray(response.data.sessions)) {
        sessions = response.data.sessions;
      } else if (response.data.play_sessions && Array.isArray(response.data.play_sessions)) {
        sessions = response.data.play_sessions;
      }
    }
    
    // Normalize session data to have consistent field names
    sessions = sessions.map((session: any) => ({
      ip: session.ip || session.client_ip || session.remote_addr || 'Unknown IP',
      stream_name: session.stream_name || session.name || session.stream || session.app || 'Unknown stream',
      started_at: session.started_at || session.created_at || session.timestamp || null,
      ...session // include all other fields
    }));
    
    // For non-admin users, filter sessions to only show their assigned streams
    if (req.user.role !== 'admin') {
      const userStreamNames = db.prepare(`
        SELECT s.name
        FROM streams s
        JOIN user_stream_assignments usa ON s.id = usa.stream_id
        WHERE usa.user_id = ? AND s.server_id = ?
      `).all(req.user.id, server.id).map((s: any) => s.name);
      
      sessions = sessions.filter((session: any) => 
        userStreamNames.includes(session.stream_name)
      );
    }
    
    res.json(sessions);
  } catch (error: any) {
    console.error('Failed to fetch sessions:', error.message);
    // Return empty array instead of error when no sessions exist
    if (error.response?.status === 404 || error.message?.includes('not found')) {
      res.json([]);
    } else {
      res.status(500).json({ error: 'Failed to fetch sessions', details: error.message });
    }
  }
});

// Block IP from play session
app.post('/api/sessions/block-ip', authenticateToken, async (req: AuthRequest, res) => {
  const { ip_address, reason, server_id, stream_name } = req.body;
  
  if (!ip_address) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  
  if (!server_id) {
    return res.status(400).json({ error: 'Server ID is required' });
  }
  
  // For non-admin users, verify they have access to the stream
  if (req.user.role !== 'admin') {
    if (!stream_name) {
      return res.status(400).json({ error: 'Stream name is required for non-admin users' });
    }
    
    const stream = db.prepare(`
      SELECT s.id
      FROM streams s
      JOIN user_stream_assignments usa ON s.id = usa.stream_id
      WHERE s.name = ? AND s.server_id = ? AND usa.user_id = ?
    `).get(stream_name, server_id, req.user.id);
    
    if (!stream) {
      return res.status(403).json({ error: 'You do not have access to this stream' });
    }
  }
  
  // Validate IP format
  const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  if (!ipRegex.test(ip_address)) {
    return res.status(400).json({ error: 'Invalid IP address format' });
  }
  
  try {
    const info = db.prepare('INSERT INTO blocked_ips (ip_address, reason, blocked_by) VALUES (?, ?, ?)').run(
      ip_address,
      reason || 'Blocked from play session',
      req.user.id
    );
    
    // Block IP on Flussonic server using auth configurator
    try {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
      if (server) {
        // Add IP to blacklist via Flussonic API
        const blacklistUrl = `${server.url}/flussonic/api/v3/auth_backends/blacklist`;
        const blacklistData = {
          type: 'deny',
          ip: ip_address
        };
        await flussonicRequest('PUT', blacklistUrl, server, blacklistData);
        console.log(`Blocked IP ${ip_address} on Flussonic server ${server.name}`);
      }
    } catch (e: any) {
      console.error('Failed to block IP on Flussonic server:', e.message);
    }
    
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e: any) {
    if (e.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: 'IP address already blocked' });
    }
    throw e;
  }
});

// Telegram Alert Management
async function sendTelegramMessage(chatId: string, message: string, retryCount = 0): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN not configured');
    return false;
  }

  const url = `${TELEGRAM_API_URL}${TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  try {
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    }, {
      timeout: 10000
    });

    if (response.data.ok) {
      return true;
    } else {
      console.error('Telegram API error:', response.data);
      return false;
    }
  } catch (error: any) {
    console.error('Failed to send Telegram message:', error.message);
    
    // Retry logic with exponential backoff
    if (retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      console.log(`Retrying in ${delay}ms... (attempt ${retryCount + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendTelegramMessage(chatId, message, retryCount + 1);
    }
    
    return false;
  }
}

// Telegram webhook endpoint
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body;
    
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text;
      
      if (text === '/start') {
        await sendTelegramMessage(chatId, 
          '👋 Welcome to Flussonic Stream Alerts!\n\n' +
          'To receive stream alerts, please contact your administrator to register your Telegram chat ID.\n\n' +
          'Your Chat ID: <code>' + chatId + '</code>\n\n' +
          'Share this Chat ID with your administrator to link it to your streams.'
        );
      } else if (text === '/help') {
        await sendTelegramMessage(chatId,
          '📖 Available commands:\n\n' +
          '/start - Register with the bot and get your Chat ID\n' +
          '/help - Show this help message\n\n' +
          'To receive stream alerts, contact your administrator with your Chat ID.'
        );
      }
    }
    
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Telegram webhook error:', error.message);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// Register Telegram alert for user/stream
app.post('/api/telegram-alerts', authenticateToken, async (req: AuthRequest, res) => {
  const { stream_id, telegram_chat_id, downtime_threshold } = req.body;
  
  if (!stream_id || !telegram_chat_id) {
    return res.status(400).json({ error: 'stream_id and telegram_chat_id are required' });
  }
  
  // Verify stream exists and user has access
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(stream_id) as any;
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  
  // Check if user has access to this stream
  if (req.user.role !== 'admin') {
    const assignment = db.prepare(
      'SELECT * FROM user_stream_assignments WHERE user_id = ? AND stream_id = ?'
    ).get(req.user.id, stream_id);
    if (!assignment) {
      return res.status(403).json({ error: 'You do not have access to this stream' });
    }
  }
  
  try {
    const info = db.prepare(
      'INSERT INTO telegram_alerts (user_id, stream_id, telegram_chat_id, downtime_threshold) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, stream_id, telegram_chat_id, downtime_threshold || 30);
    
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e: any) {
    if (e.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: 'Alert already registered for this stream' });
    }
    throw e;
  }
});

// Get user's Telegram alerts
app.get('/api/telegram-alerts', authenticateToken, (req: AuthRequest, res) => {
  let alerts;
  if (req.user.role === 'admin') {
    alerts = db.prepare(`
      SELECT ta.*, u.username, s.name as stream_name, s.server_id
      FROM telegram_alerts ta
      JOIN users u ON ta.user_id = u.id
      JOIN streams s ON ta.stream_id = s.id
      ORDER BY ta.created_at DESC
    `).all();
  } else {
    alerts = db.prepare(`
      SELECT ta.*, s.name as stream_name, s.server_id
      FROM telegram_alerts ta
      JOIN streams s ON ta.stream_id = s.id
      WHERE ta.user_id = ?
      ORDER BY ta.created_at DESC
    `).all(req.user.id);
  }
  res.json(alerts);
});

// Update Telegram alert
app.put('/api/telegram-alerts/:id', authenticateToken, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { alert_enabled, downtime_threshold } = req.body;
  
  const alert = db.prepare('SELECT * FROM telegram_alerts WHERE id = ?').get(id) as any;
  if (!alert) {
    return res.status(404).json({ error: 'Alert not found' });
  }
  
  // Check ownership
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  const updates: string[] = [];
  const values: any[] = [];
  
  if (alert_enabled !== undefined) {
    updates.push('alert_enabled = ?');
    values.push(alert_enabled ? 1 : 0);
  }
  if (downtime_threshold !== undefined) {
    updates.push('downtime_threshold = ?');
    values.push(downtime_threshold);
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }
  
  values.push(id);
  db.prepare(`UPDATE telegram_alerts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  
  res.json({ success: true });
});

// Delete Telegram alert
app.delete('/api/telegram-alerts/:id', authenticateToken, (req: AuthRequest, res) => {
  const { id } = req.params;
  
  const alert = db.prepare('SELECT * FROM telegram_alerts WHERE id = ?').get(id) as any;
  if (!alert) {
    return res.status(404).json({ error: 'Alert not found' });
  }
  
  // Check ownership
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  db.prepare('DELETE FROM telegram_alerts WHERE id = ?').run(id);
  res.json({ success: true });
});

// Get alert history
app.get('/api/telegram-alerts/:id/history', authenticateToken, (req: AuthRequest, res) => {
  const { id } = req.params;
  
  const alert = db.prepare('SELECT * FROM telegram_alerts WHERE id = ?').get(id) as any;
  if (!alert) {
    return res.status(404).json({ error: 'Alert not found' });
  }
  
  // Check ownership
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  const history = db.prepare(`
    SELECT * FROM telegram_alert_history
    WHERE telegram_alert_id = ?
    ORDER BY sent_at DESC
    LIMIT 100
  `).all(id);
  
  res.json(history);
});

// Send alert (internal API, called by monitoring system)
app.post('/api/telegram-alerts/send', async (req, res) => {
  const { stream_id, alert_type, message } = req.body;
  
  if (!stream_id || !alert_type || !message) {
    return res.status(400).json({ error: 'stream_id, alert_type, and message are required' });
  }
  
  // Get all enabled alerts for this stream
  const alerts = db.prepare(`
    SELECT ta.*, s.name as stream_name
    FROM telegram_alerts ta
    JOIN streams s ON ta.stream_id = s.id
    WHERE ta.stream_id = ? AND ta.alert_enabled = 1
  `).all(stream_id) as any[];
  
  if (alerts.length === 0) {
    return res.json({ success: true, message: 'No alerts configured for this stream' });
  }
  
  const results = [];
  
  for (const alert of alerts) {
    // Check rate limiting (don't send if last alert was sent within threshold)
    if (alert.last_alert_sent) {
      const lastAlert = new Date(alert.last_alert_sent);
      const now = new Date();
      const diffMinutes = (now.getTime() - lastAlert.getTime()) / (1000 * 60);
      
      if (diffMinutes < alert.downtime_threshold) {
        console.log(`Skipping alert for chat ${alert.telegram_chat_id} - last alert sent ${diffMinutes.toFixed(1)} minutes ago`);
        continue;
      }
    }
    
    // Send message
    const success = await sendTelegramMessage(alert.telegram_chat_id, message);
    
    // Log to history
    db.prepare(`
      INSERT INTO telegram_alert_history (telegram_alert_id, alert_type, message, success, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(alert.id, alert_type, message, success ? 1 : 0, success ? null : 'Failed to send');
    
    // Update last_alert_sent if successful
    if (success) {
      db.prepare('UPDATE telegram_alerts SET last_alert_sent = CURRENT_TIMESTAMP WHERE id = ?').run(alert.id);
    }
    
    results.push({
      telegram_chat_id: alert.telegram_chat_id,
      success
    });
  }
  
  res.json({ success: true, results });
});

app.get('/api/vods/:id/files', (req, res) => {
  try {
    const files = db.prepare('SELECT * FROM vod_files WHERE vod_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.json(files);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/vods/:id/upload-info', (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    let authString = server.api_key.includes(':') ? server.api_key : `flussonic:${server.api_key}`;
    const authHeader = `Basic ${Buffer.from(authString).toString('base64')}`;
    
    let altAuthHeader = null;
    if (!server.api_key.includes(':')) {
      const altAuthString = `admin:${server.api_key}`;
      altAuthHeader = `Basic ${Buffer.from(altAuthString).toString('base64')}`;
    }

    res.json({
      serverUrl: server.url,
      vodName: vod.name,
      authHeader,
      altAuthHeader
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vods/:id/files/confirm-upload', async (req, res) => {
  const { filename, size } = req.body;
  if (!filename || !size) return res.status(400).json({ error: 'Missing filename or size' });

  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    db.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)').run(vod.id, filename, size);
    await updateVodPlaylistFile(vod);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vods/:id/files/init-chunked', (req, res) => {
  const { filename, totalChunks } = req.body;
  if (!filename || !totalChunks) return res.status(400).json({ error: 'Missing filename or totalChunks' });

  const uploadId = Math.random().toString(36).substring(2, 15);
  const chunkDir = path.join(os.tmpdir(), `upload_${uploadId}`);
  
  if (!fs.existsSync(chunkDir)) {
    fs.mkdirSync(chunkDir, { recursive: true });
  }

  res.json({ uploadId, chunkDir });
});

app.post('/api/vods/:id/files/chunk', upload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex } = req.body;
  if (!uploadId || chunkIndex === undefined || !req.file) {
    return res.status(400).json({ error: 'Missing uploadId, chunkIndex, or chunk file' });
  }

  const chunkDir = path.join(os.tmpdir(), `upload_${uploadId}`);
  if (!fs.existsSync(chunkDir)) {
    return res.status(400).json({ error: 'Upload session not found' });
  }

  const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
  fs.renameSync(req.file.path, chunkPath);

  res.json({ success: true });
});

app.post('/api/vods/:id/files/complete-chunked', async (req, res) => {
  const { uploadId, filename, totalChunks, size } = req.body;
  if (!uploadId || !filename || !totalChunks || !size) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const chunkDir = path.join(os.tmpdir(), `upload_${uploadId}`);
  const finalPath = path.join(os.tmpdir(), `final_${uploadId}_${filename}`);

  try {
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) throw new Error(`Chunk ${i} missing`);
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
      fs.unlinkSync(chunkPath);
    }
    writeStream.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    // Now push to Flussonic
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) throw new Error('VOD not found');

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) throw new Error('Server not found');

    const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/${filename}`;
    const fileStream = fs.createReadStream(finalPath);
    
    await flussonicRequest('PUT', uploadUrl, server, fileStream, 3600000);
    
    db.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)').run(vod.id, filename, size);
    await updateVodPlaylistFile(vod);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Chunked upload completion failed:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (fs.existsSync(chunkDir)) fs.rmSync(chunkDir, { recursive: true, force: true });
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
  }
});

app.post('/api/vods/:id/files', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Max limit is 1000GB.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(500).json({ error: err.message || 'Upload error' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
  if (!vod) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'VOD not found' });
  }

  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) throw new Error('Server not found');

    const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/${req.file.originalname}`;
    const fileStream = fs.createReadStream(req.file.path);
    
    // Use a much longer timeout for file uploads (1 hour)
    await flussonicRequest('PUT', uploadUrl, server, fileStream, 3600000);
    console.log(`File uploaded to Flussonic VOD: ${vod.name}/${req.file.originalname}`);

    db.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)').run(vod.id, req.file.originalname, req.file.size);

    await updateVodPlaylistFile(vod);
    
    res.json({ success: true, filename: req.file.originalname });
  } catch (error: any) {
    console.error('Failed to upload file to Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to upload file to Flussonic' });
  } finally {
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

app.delete('/api/vods/:id/files/:filename', async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (server) {
      const baseUrl = server.url.replace(/\/$/, '');
      const deleteUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/${req.params.filename}`;
      await flussonicRequest('DELETE', deleteUrl, server).catch(e => console.warn('Failed to delete from Flussonic (ignored):', e.message));
    }

    db.prepare('DELETE FROM vod_files WHERE vod_id = ? AND filename = ?').run(vod.id, req.params.filename);
    
    await updateVodPlaylistFile(vod);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vods/:id/files/sync', async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });
    
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const count = await syncVodFilesFromRemote(vod, server);
    res.json({ success: true, count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vods/:id/sync', async (req, res) => {
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });
    
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const baseUrl = server.url.replace(/\/$/, '');
    const flussonicUrl = `${baseUrl}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
    try {
      let response;
      try {
        response = await flussonicRequest('GET', flussonicUrl, server);
      } catch (e: any) {
        if (e.response && e.response.status === 404) {
          const configUrl = `${baseUrl}/flussonic/api/v3/config`;
          const configRes = await flussonicRequest('GET', configUrl, server);
          if (configRes.data && configRes.data.vods && configRes.data.vods[vod.name]) {
            response = { data: configRes.data.vods[vod.name] };
          } else {
            throw e; // Re-throw the 404 to trigger deletion
          }
        } else {
          throw e;
        }
      }

      let paths: string[] = [];
      if (response && response.data) {
        const item = response.data;
        if (item.storages && Array.isArray(item.storages)) {
          paths = item.storages.map((p: any) => p.url || p.path || p);
        } else if (item.storage) {
          paths = Array.isArray(item.storage) ? item.storage : [item.storage];
        } else if (item.path) {
          paths = Array.isArray(item.path) ? item.path : [item.path];
        } else if (item.url) {
          paths = Array.isArray(item.url) ? item.url : [item.url];
        }
      }

      if (paths.length > 0) {
        db.prepare('UPDATE vods SET paths = ? WHERE id = ?').run(JSON.stringify(paths), vod.id);
        
        // Also sync files
        try {
          await syncVodFilesFromRemote(vod, server);
        } catch (e: any) {
          console.warn('Failed to sync files during VOD sync:', e.message);
        }

        res.json({ success: true, paths });
      } else {
        res.json({ success: true, message: 'No paths found or unchanged' });
      }
    } catch (e: any) {
      if (e.response && e.response.status === 404) {
        // VOD doesn't exist on Flussonic anymore, delete it locally
        db.prepare('DELETE FROM vods WHERE id = ?').run(vod.id);
        res.json({ success: true, deleted: true });
      } else {
        console.error('Flussonic sync error:', e.message);
        res.status(500).json({ error: 'Failed to sync with Flussonic' });
      }
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Server Metrics
app.get('/api/servers/:id/metrics', async (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const flussonicUrl = `${server.url}/flussonic/api/v3/config`;
    
    try {
      const response = await flussonicRequest('GET', flussonicUrl, server);

      const stats = response.data.stats || {};
      
      // Get active streams from database
      const activeStreams = db.prepare('SELECT name FROM streams WHERE server_id = ? AND status = ?').all(server.id, 'online');
      
      res.json({
        total_clients: stats.total_clients || 0,
        bitrate: (stats.output_kbit || 0) * 1000,
        uptime: stats.uptime || 0,
        cpu_usage: stats.cpu_usage || 0,
        active_streams: activeStreams.map((s: any) => s.name)
      });
    } catch (apiError: any) {
      console.warn(`Flussonic API failed for server ${server.name}, returning mock metrics. Error: ${apiError.message}`);
      
      const activeStreams = db.prepare('SELECT name FROM streams WHERE server_id = ? AND status = ?').all(server.id, 'online');
      
      // Return mock data so the UI still works for preview/testing purposes
      res.json({
        total_clients: Math.floor(Math.random() * 500) + 50,
        bitrate: Math.floor(Math.random() * 1000000000) + 100000000, // 100-1100 Mbps
        uptime: Math.floor(Math.random() * 5000000) + 86400,
        cpu_usage: (Math.random() * 40) + 10,
        active_streams: activeStreams.map((s: any) => s.name),
        _mocked: true,
        _error: apiError.message
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch metrics', details: error.message });
  }
});

// Settings
app.get('/api/settings', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all();
  const settingsObj = settings.reduce((acc: any, curr: any) => {
    acc[curr.key] = curr.value;
    return acc;
  }, {});
  res.json(settingsObj);
});

app.post('/api/settings', (req, res) => {
  const { telegram_enabled, telegram_bot_token, telegram_chat_id, watchdog_interval, auto_sync_enabled, auto_sync_interval } = req.body;
  const stmt = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  
  db.transaction(() => {
    if (telegram_enabled !== undefined) stmt.run(telegram_enabled.toString(), 'telegram_enabled');
    if (telegram_bot_token !== undefined) stmt.run(telegram_bot_token, 'telegram_bot_token');
    if (telegram_chat_id !== undefined) stmt.run(telegram_chat_id, 'telegram_chat_id');
    if (watchdog_interval !== undefined) stmt.run(watchdog_interval, 'watchdog_interval');
    if (auto_sync_enabled !== undefined) stmt.run(auto_sync_enabled.toString(), 'auto_sync_enabled');
    if (auto_sync_interval !== undefined) stmt.run(auto_sync_interval, 'auto_sync_interval');
  })();
  
  res.json({ success: true });
});

app.post('/api/settings/test-telegram', async (req, res) => {
  const { telegram_bot_token, telegram_chat_id } = req.body;
  if (!telegram_bot_token || !telegram_chat_id) {
    return res.status(400).json({ error: 'Missing bot token or chat ID' });
  }
  try {
    const response = await axios.post(`https://api.telegram.org/bot${telegram_bot_token}/sendMessage`, {
      chat_id: telegram_chat_id,
      text: '✅ <b>IBS Manager</b>\n\nTelegram notifications are working correctly!',
      parse_mode: 'HTML'
    });
    res.json({ success: true, data: response.data });
  } catch (error: any) {
    console.error('Failed to send test message from server:', error.response?.data || error.message);
    const description = error.response?.data?.description || error.message;
    res.status(error.response?.status || 500).json({ error: description });
  }
});

// --- Watchdog & Telegram ---
const sendTelegramNotification = async (message: string) => {
  const enabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_enabled') as any;
  if (!enabled || enabled.value !== 'true') return;

  const token = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_bot_token') as any;
  const chatId = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_chat_id') as any;
  
  if (!token?.value || !chatId?.value) return;

  try {
    await axios.post(`https://api.telegram.org/bot${token.value}/sendMessage`, {
      chat_id: chatId.value,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (error: any) {
    console.error('Telegram notification failed:', error.message);
  }
};

let isChecking = false;
const checkStreams = async () => {
  if (isChecking) return;
  isChecking = true;
  
  try {
    const streams = db.prepare('SELECT * FROM streams').all() as any[];
    const servers = db.prepare('SELECT * FROM servers').all() as any[];
    
    const serverMap = servers.reduce((acc, s) => { acc[s.id] = s; return acc; }, {});
    
    // Group streams by server
    const streamsByServer: Record<number, any[]> = {};
    for (const stream of streams) {
      if (!streamsByServer[stream.server_id]) streamsByServer[stream.server_id] = [];
      streamsByServer[stream.server_id].push(stream);
    }

    let hasUpdates = false;

    for (const serverId of Object.keys(streamsByServer)) {
      const server = serverMap[Number(serverId)];
      if (!server) continue;

      try {
        const flussonicUrl = `${server.url}/flussonic/api/v3/streams`;
        const response = await flussonicRequest('GET', flussonicUrl, server);
        const remoteStreams = Array.isArray(response.data) ? response.data : (response.data.streams || []);
        const remoteStreamMap = remoteStreams.reduce((acc: any, s: any) => { acc[s.name] = s; return acc; }, {});

        for (const stream of streamsByServer[Number(serverId)]) {
          const remoteStream = remoteStreamMap[stream.name];
          let newStatus = 'offline';
          let newInputStatus = 'offline';
          let newSourceType = 'unknown';
          let newUptime = 0;
          let newPushStatus = '[]';

          if (remoteStream) {
            const stats = remoteStream.stats;
            const isAlive = stats && stats.alive;
            newStatus = isAlive ? 'online' : 'offline';
            newInputStatus = stats?.input_alive ? 'online' : 'offline';
            newSourceType = stats?.source_type || 'unknown';
            newUptime = stats?.uptime || 0;
            
            if (remoteStream.pushes && remoteStream.pushes.length > 0) {
              newPushStatus = JSON.stringify(remoteStream.pushes.map((p: any) => ({
                url: p.url,
                status: p.stats?.status || 'unknown'
              })));
            }
          }

          // Notifications Consolidation
          const notifications: string[] = [];
          
          if (stream.status !== newStatus && stream.status !== 'unknown') {
            const emoji = newStatus === 'online' ? '✅' : '❌';
            notifications.push(`${emoji} <b>Status:</b> ${newStatus.toUpperCase()}`);
            
            // Send Telegram alert when stream goes offline
            if (newStatus === 'offline' && TELEGRAM_BOT_TOKEN) {
              try {
                const message = `🔴 <b>Stream Alert</b>\n\n` +
                  `<b>Stream:</b> ${stream.name}\n` +
                  `<b>Status:</b> OFFLINE\n` +
                  `<b>Time:</b> ${new Date().toLocaleString()}\n\n` +
                  `Your stream has stopped streaming. Please check your source.`;
                
                await axios.post('http://localhost:3000/api/telegram-alerts/send', {
                  stream_id: stream.id,
                  alert_type: 'stream_offline',
                  message: message
                });
              } catch (error: any) {
                console.error('Failed to send Telegram alert:', error.message);
              }
            }
          }

          if (stream.input_status !== newInputStatus && stream.input_status !== 'unknown' && newStatus === 'online') {
            const emoji = newInputStatus === 'online' ? '📥' : '⚠️';
            const msg = newInputStatus === 'online' ? 'RESTORED' : 'DROPPED';
            notifications.push(`${emoji} <b>Input:</b> ${msg}`);
          }

          if (stream.source_type !== newSourceType && stream.source_type !== 'unknown' && newStatus === 'online') {
            const emoji = newSourceType === 'live' ? '📡' : (newSourceType === 'playlist' || newSourceType === 'static' ? '📁' : '❓');
            const typeLabel = newSourceType === 'live' ? 'LIVE' : (newSourceType === 'playlist' ? 'PLAYLIST' : (newSourceType === 'static' ? 'VOD' : newSourceType.toUpperCase()));
            notifications.push(`${emoji} <b>Source:</b> ${typeLabel}`);
          }

          if (newUptime < stream.uptime && newUptime > 0 && stream.uptime > 0 && newStatus === 'online' && (stream.status === newStatus)) {
            // Only notify restart if status didn't just change to online (to avoid double notification with status change)
            notifications.push(`🔄 <b>Stream Restarted</b> (Uptime: ${newUptime}s)`);
          }

          if (notifications.length > 0) {
            const header = `<b>Stream Update: ${stream.name}</b>\n<b>Server:</b> ${server.name}\n\n`;
            await sendTelegramNotification(header + notifications.join('\n'));
          }

          const result = db.prepare('UPDATE streams SET status = ?, input_status = ?, source_type = ?, uptime = ?, push_status = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run(
            newStatus, 
            newInputStatus, 
            newSourceType, 
            newUptime, 
            newPushStatus, 
            stream.id
          );

          if (result.changes > 0 && (
            stream.status !== newStatus || 
            stream.input_status !== newInputStatus || 
            stream.source_type !== newSourceType || 
            stream.push_status !== newPushStatus
          )) {
            hasUpdates = true;
          }
        }
      } catch (error: any) {
        console.error(`Failed to check streams for server ${server.name}:`, error.message);
        const affectedStreams = streamsByServer[Number(serverId)].filter(s => s.status !== 'offline');
        
        if (affectedStreams.length > 0) {
          const streamNames = affectedStreams.map(s => s.name).join(', ');
          await sendTelegramNotification(`❌ <b>Server Unreachable</b>\n\n<b>Server:</b> ${server.name}\n<b>Error:</b> ${error.message}\n<b>Affected Streams:</b> ${streamNames}`);
          
          for (const stream of affectedStreams) {
            db.prepare('UPDATE streams SET status = ?, push_status = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run('offline', '[]', stream.id);
            hasUpdates = true;
          }
        }
      }
    }

    if (hasUpdates) {
      broadcastStreamsUpdate();
    }
  } finally {
    isChecking = false;
  }
};

let watchdogTimer: NodeJS.Timeout;
let autoSyncTimer: NodeJS.Timeout;

const startWatchdog = () => {
  if (watchdogTimer) clearInterval(watchdogTimer);
  const intervalSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('watchdog_interval') as any;
  const intervalSecs = parseInt(intervalSetting?.value || '60', 10);
  
  watchdogTimer = setInterval(checkStreams, intervalSecs * 1000);
  console.log(`Watchdog started with interval ${intervalSecs}s`);

  // Auto Sync
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  const autoSyncEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_sync_enabled') as any;
  
  if (autoSyncEnabled?.value === 'true') {
    const syncIntervalSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_sync_interval') as any;
    const syncIntervalSecs = parseInt(syncIntervalSetting?.value || '60', 10);
    
    autoSyncTimer = setInterval(async () => {
      console.log('Running auto-sync for all servers...');
      const servers = db.prepare('SELECT * FROM servers').all() as any[];
      let totalAdded = 0;
      let totalRemoved = 0;
      
      for (const server of servers) {
        try {
          const { addedCount, removedCount } = await syncServerStreams(server);
          const vodSync = await syncServerVods(server);
          totalAdded += addedCount + vodSync.addedCount;
          totalRemoved += removedCount + vodSync.removedCount;
        } catch (err: any) {
          console.error(`Auto-sync failed for server ${server.name}:`, err.message);
        }
      }
      
      if (totalAdded > 0 || totalRemoved > 0) {
        console.log(`Auto-sync complete: ${totalAdded} added, ${totalRemoved} removed.`);
        broadcastStreamsUpdate();
      }
    }, syncIntervalSecs * 1000);
    console.log(`Auto-sync started with interval ${syncIntervalSecs}s`);
  } else {
    console.log('Auto-sync is disabled');
  }
};

startWatchdog();

// Restart watchdog when settings change
app.post('/api/watchdog/restart', (req, res) => {
  startWatchdog();
  res.json({ success: true });
});

// SSL Certificate Management
app.get('/api/ssl/status', (req, res) => {
  try {
    const sslEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_enabled');
    const sslDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_domain');
    
    let status = 'not_configured';
    let expiry = null;
    
    if (sslEnabled?.value === 'true' && sslDomain?.value) {
      // Check if certificate exists
      const certPath = `/etc/letsencrypt/live/${sslDomain.value}/fullchain.pem`;
      if (fs.existsSync(certPath)) {
        const cert = fs.readFileSync(certPath, 'utf8');
        const certMatch = cert.match(/Not After\s*:\s*(.+)/);
        if (certMatch) {
          expiry = certMatch[1].trim();
          const expiryDate = new Date(expiry);
          const now = new Date();
          const daysUntilExpiry = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysUntilExpiry < 0) {
            status = 'expired';
          } else if (daysUntilExpiry < 30) {
            status = 'expiring_soon';
          } else {
            status = 'active';
          }
        }
      } else {
        status = 'certificate_missing';
      }
    }
    
    res.json({
      enabled: sslEnabled?.value === 'true',
      domain: sslDomain?.value || '',
      expiry,
      status
    });
  } catch (error: any) {
    console.error('Failed to get SSL status:', error);
    res.status(500).json({ error: 'Failed to get SSL status' });
  }
});

app.post('/api/ssl/install', async (req, res) => {
  const { domain, email } = req.body;
  
  if (!domain || !email) {
    return res.status(400).json({ error: 'Domain and email are required' });
  }
  
  try {
    // Validate domain format
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    if (!domainRegex.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }
    
    // Save SSL settings to database
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_enabled', 'true');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_domain', domain);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ssl_email', email);
    
    // Use certbot to obtain certificate
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // First, ensure certbot is installed
    try {
      await execPromise('which certbot');
    } catch {
      await execPromise('sudo apt install -y certbot python3-certbot-nginx');
    }
    
    // Obtain certificate using certbot
    const certbotCommand = `sudo certbot certonly --nginx -d ${domain} --non-interactive --agree-tos --email ${email}`;
    await execPromise(certbotCommand);
    
    // Update nginx configuration
    await updateNginxConfig(domain);
    
    // Restart nginx
    await execPromise('sudo systemctl restart nginx');
    
    res.json({ success: true, message: 'SSL certificate installed successfully' });
  } catch (error: any) {
    console.error('Failed to install SSL certificate:', error);
    res.status(500).json({ error: error.message || 'Failed to install SSL certificate' });
  }
});

app.post('/api/ssl/renew', async (req, res) => {
  try {
    const sslDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('ssl_domain');
    
    if (!sslDomain?.value) {
      return res.status(400).json({ error: 'No SSL domain configured' });
    }
    
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // Renew certificate
    await execPromise('sudo certbot renew --non-interactive');
    
    // Restart nginx
    await execPromise('sudo systemctl restart nginx');
    
    res.json({ success: true, message: 'SSL certificate renewed successfully' });
  } catch (error: any) {
    console.error('Failed to renew SSL certificate:', error);
    res.status(500).json({ error: error.message || 'Failed to renew SSL certificate' });
  }
});

async function updateNginxConfig(domain: string) {
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);
  
  const nginxConfig = `# Nginx configuration for IBS Manager
# Place this in /etc/nginx/sites-available/flussonic-manager
# Then symlink: sudo ln -s /etc/nginx/sites-available/flussonic-manager /etc/nginx/sites-enabled/

# HTTP server - redirect to HTTPS
server {
    listen 80;
    server_name ${domain};

    # Allow Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Redirect all other HTTP traffic to HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name ${domain};

    # SSL certificate paths
    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Proxy to Node.js application
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    # WebSocket support
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # Increase upload size for large video files
    client_max_body_size 1000G;
}`;
  
  // Write new nginx config
  await execPromise(`sudo tee /etc/nginx/sites-available/flussonic-manager > /dev/null << 'EOF'
${nginxConfig}
EOF`);
  
  // Test nginx configuration
  await execPromise('sudo nginx -t');
}


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

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
