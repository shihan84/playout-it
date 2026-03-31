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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

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
      JOIN servers ON streams.server_id = servers.id
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

// Database Setup
const dbPath = process.env.DATABASE_PATH || 'flussonic.db';
let db: any;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
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
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    live_url TEXT NOT NULL,
    playlist_url TEXT NOT NULL,
    push_urls TEXT DEFAULT '[]',
    push_status TEXT DEFAULT '[]',
    status TEXT DEFAULT 'unknown',
    last_checked DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id)
  );

  CREATE TABLE IF NOT EXISTS vods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    paths TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id)
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
`;

try {
  db.exec(schema);
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
};
initSettings();

// --- API Routes ---

// Servers
app.get('/api/servers', (req, res) => {
  const servers = db.prepare(`
    SELECT s.*, 
      (SELECT COUNT(*) FROM streams WHERE server_id = s.id AND status = 'online') as online_streams,
      (SELECT COUNT(*) FROM streams WHERE server_id = s.id AND status = 'offline') as offline_streams
    FROM servers s
  `).all();
  res.json(servers);
});

app.post('/api/servers', async (req, res) => {
  const { name, url, api_key } = req.body;
  const stmt = db.prepare('INSERT INTO servers (name, url, api_key) VALUES (?, ?, ?)');
  const info = stmt.run(name, url, api_key);
  
  const server = { id: info.lastInsertRowid, name, url, api_key };
  
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

app.delete('/api/servers/:id', (req, res) => {
  db.prepare('DELETE FROM streams WHERE server_id = ?').run(req.params.id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Streams
app.get('/api/streams', (req, res) => {
  try {
    const streams = db.prepare(`
      SELECT streams.*, servers.name as server_name, servers.url as server_url 
      FROM streams 
      JOIN servers ON streams.server_id = servers.id
    `).all();
    
    const parsedStreams = streams.map(parseStream);
    res.json(parsedStreams);
  } catch (error: any) {
    console.error('Failed to fetch streams:', error);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

app.post('/api/streams', async (req, res) => {
  const { server_id, name, inputs, push_urls } = req.body;
  const pushes = (push_urls || []).map((url: string) => ({ url }));
  const streamInputs = (inputs || []).map((url: string) => ({ url }));
  
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    // Automatically create a VOD folder for this stream
    const vodName = name;
    const vodPath = `/storage/${vodName}`;
    
    // Check if VOD already exists in DB
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

    // Configure stream on Flussonic
    const flussonicUrl = `${server.url}/flussonic/api/v3/streams/${encodeURIComponent(name)}`;
    
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
    const info = stmt.run(server_id, name, '', '', JSON.stringify(push_urls || []), JSON.stringify(inputs || []));
    
    broadcastStreamsUpdate();
    res.json({ id: info.lastInsertRowid, server_id, name, inputs, push_urls });
  } catch (error: any) {
    console.error('Error creating stream on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to configure stream on Flussonic' });
  }
});

app.put('/api/streams/:id', async (req, res) => {
  const { server_id, name, inputs, push_urls } = req.body;
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
    stmt.run(server_id, name, JSON.stringify(inputs || []), JSON.stringify(push_urls || []), req.params.id);
    
    broadcastStreamsUpdate();
    res.json({ id: req.params.id, server_id, name, inputs, push_urls });
  } catch (error: any) {
    console.error('Error updating stream on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to update stream on Flussonic' });
  }
});

app.delete('/api/streams/:id', async (req, res) => {
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

app.get('/api/streams/:id/details', async (req, res) => {
  try {
    const stream = db.prepare(`
      SELECT streams.*, servers.name as server_name, servers.url as server_url, servers.api_key 
      FROM streams 
      JOIN servers ON streams.server_id = servers.id
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

    try {
      const flussonicUrl = `${stream.server_url}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
      const response = await flussonicRequest('GET', flussonicUrl, { api_key: stream.api_key });
      stream.flussonic_stats = response.data.stats;
      stream.flussonic_pushes = response.data.pushes || response.data.stats?.pushes || [];
    } catch (e: any) {
      stream.flussonic_error = e.message;
      
      if (e.response && e.response.status === 404) {
        stream.flussonic_stats = {
          alive: false,
          bitrate: 0,
          client_count: 0,
          uptime: 0
        };
        stream.flussonic_pushes = stream.push_urls.map((url: string) => ({
          url,
          status: 'offline'
        }));
      } else {
        // Mock stats for preview if real server fails
        stream.flussonic_stats = {
          alive: stream.status === 'online',
          bitrate: Math.floor(Math.random() * 5000) + 1000,
          client_count: Math.floor(Math.random() * 100),
          uptime: Math.floor(Math.random() * 3600),
          _mocked: true
        };
        stream.flussonic_pushes = stream.push_urls.map((url: string) => ({
          url,
          status: stream.status === 'online' ? 'pushing' : 'offline'
        }));
      }
    }

    delete stream.api_key;
    res.json(stream);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Helper to sync streams for a server
async function syncServerStreams(server: any) {
  const flussonicUrl = `${server.url}/flussonic/api/v3/streams`;
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
  const flussonicUrl = `${server.url}/flussonic/api/v3/vods`;
  try {
    let response;
    try {
      response = await flussonicRequest('GET', flussonicUrl, server);
      console.log(`[syncServerVods] /vods response for ${server.name}:`, JSON.stringify(response.data).substring(0, 500));
    } catch (e: any) {
      if (e.response && e.response.status === 404) {
        // Fallback to config API if /vods endpoint is not available
        const configUrl = `${server.url}/flussonic/api/v3/config`;
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
app.get('/api/streams/:id/videos', (req, res) => {
  const stream = db.prepare('SELECT id FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  
  const videos = db.prepare('SELECT filename as name, size, created_at FROM videos WHERE stream_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(videos);
});

async function updatePlaylistFile(stream: any) {
  const videos = db.prepare('SELECT filename FROM videos WHERE stream_id = ? ORDER BY created_at ASC').all(stream.id) as any[];
  const playlistContent = videos.map(v => v.filename).join('\n');

  // Also upload the playlist to the Flussonic server's VOD folder via WebDAV/HTTP PUT
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any;
    if (server) {
      // Assuming there is a VOD with the same name as the stream
      const uploadUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(stream.name)}/storages/0/files/playlist.txt`;
      await flussonicRequest('PUT', uploadUrl, server, playlistContent);
      console.log(`Playlist uploaded to Flussonic VOD: ${stream.name}`);
    }
  } catch (e: any) {
    console.warn('Failed to upload playlist to Flussonic VOD (ignored if VOD does not exist):', e.message);
  }
}

app.post('/api/streams/:id/videos', upload.single('video'), async (req, res) => {
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

app.delete('/api/streams/:id/videos/:filename', async (req, res) => {
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

app.get('/api/streams/:id/playlist.txt', (req, res) => {
  const stream = db.prepare('SELECT id, name FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).send('Stream not found');
  
  const videos = db.prepare('SELECT filename FROM videos WHERE stream_id = ? ORDER BY created_at ASC').all(stream.id) as any[];
  if (videos.length === 0) {
    return res.type('text/plain').send('');
  }
  
  const playlistContent = videos.map(v => v.filename).join('\n');
  
  res.type('text/plain').send(playlistContent);
});

// Sync Streams from Server
app.post('/api/servers/:id/sync', async (req, res) => {
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
app.post('/api/servers/sync-all', async (req, res) => {
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
app.get('/api/vods', (req, res) => {
  const vods = db.prepare(`
    SELECT vods.*, servers.name as server_name 
    FROM vods 
    JOIN servers ON vods.server_id = servers.id
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

app.post('/api/vods', async (req, res) => {
  const { server_id, name, paths } = req.body;
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const flussonicUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(name)}`;
    await flussonicRequest('PUT', flussonicUrl, server, {
      storages: paths.map((p: string) => ({ url: p }))
    }).catch(e => console.warn('Flussonic create VOD error (ignored for preview):', e.message));

    const stmt = db.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)');
    const info = stmt.run(server_id, name, JSON.stringify(paths));
    res.json({ id: info.lastInsertRowid, server_id, name, paths });
  } catch (error: any) {
    console.error('Error creating VOD on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to configure VOD on Flussonic' });
  }
});

app.put('/api/vods/:id', async (req, res) => {
  const { server_id, name, paths } = req.body;
  try {
    const vod = db.prepare('SELECT * FROM vods WHERE id = ?').get(req.params.id) as any;
    if (!vod) return res.status(404).json({ error: 'VOD not found' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const flussonicUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(name)}`;
    
    // If name changed, we might need to delete old one and create new, but for simplicity let's just update the new one
    if (vod.name !== name) {
      const oldServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(vod.server_id) as any;
      if (oldServer) {
        const oldFlussonicUrl = `${oldServer.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
        await flussonicRequest('DELETE', oldFlussonicUrl, oldServer).catch(() => {});
      }
    }

    await flussonicRequest('PUT', flussonicUrl, server, {
      storages: paths.map((p: string) => ({ url: p }))
    }).catch(e => console.warn('Flussonic update VOD error (ignored for preview):', e.message));

    db.prepare('UPDATE vods SET server_id = ?, name = ?, paths = ? WHERE id = ?').run(server_id, name, JSON.stringify(paths), req.params.id);
    res.json({ id: req.params.id, server_id, name, paths });
  } catch (error: any) {
    console.error('Error updating VOD on Flussonic:', error.message);
    res.status(500).json({ error: 'Failed to update VOD on Flussonic' });
  }
});

app.delete('/api/vods/:id', async (req, res) => {
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
  const files = db.prepare("SELECT filename FROM vod_files WHERE vod_id = ? AND filename != 'playlist.txt' ORDER BY created_at ASC").all(vod.id) as any[];
  if (files.length === 0) return; // Don't create empty playlist

  const playlistContent = files.map(v => `${vod.name}/${v.filename}`).join('\n');

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
        if (!name || name === 'playlist.txt' || file.type === 'directory') continue;
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
      const deleteUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}/storages/0/files/${req.params.filename}`;
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

    const flussonicUrl = `${server.url}/flussonic/api/v3/vods/${encodeURIComponent(vod.name)}`;
    try {
      let response;
      try {
        response = await flussonicRequest('GET', flussonicUrl, server);
      } catch (e: any) {
        if (e.response && e.response.status === 404) {
          const configUrl = `${server.url}/flussonic/api/v3/config`;
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
  const { telegram_bot_token, telegram_chat_id, watchdog_interval, auto_sync_enabled, auto_sync_interval } = req.body;
  const stmt = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  
  db.transaction(() => {
    if (telegram_bot_token !== undefined) stmt.run(telegram_bot_token, 'telegram_bot_token');
    if (telegram_chat_id !== undefined) stmt.run(telegram_chat_id, 'telegram_chat_id');
    if (watchdog_interval !== undefined) stmt.run(watchdog_interval, 'watchdog_interval');
    if (auto_sync_enabled !== undefined) stmt.run(auto_sync_enabled.toString(), 'auto_sync_enabled');
    if (auto_sync_interval !== undefined) stmt.run(auto_sync_interval, 'auto_sync_interval');
  })();
  
  res.json({ success: true });
});

// --- Watchdog & Telegram ---
const sendTelegramNotification = async (message: string) => {
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

const checkStreams = async () => {
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
        let newPushStatus = '[]';

        if (remoteStream) {
          const stats = remoteStream.stats;
          const isAlive = stats && stats.alive;
          newStatus = isAlive ? 'online' : 'offline';
          
          if (remoteStream.pushes && remoteStream.pushes.length > 0) {
            newPushStatus = JSON.stringify(remoteStream.pushes.map((p: any) => ({
              url: p.url,
              status: p.stats?.status || 'unknown'
            })));
          }
        }

        if (stream.status !== newStatus && stream.status !== 'unknown') {
          const emoji = newStatus === 'online' ? '✅' : '❌';
          await sendTelegramNotification(`${emoji} <b>Stream Status Changed</b>\n\n<b>Stream:</b> ${stream.name}\n<b>Server:</b> ${server.name}\n<b>Status:</b> ${newStatus.toUpperCase()}`);
        }

        const result = db.prepare('UPDATE streams SET status = ?, push_status = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, newPushStatus, stream.id);
        if (result.changes > 0 && (stream.status !== newStatus || stream.push_status !== newPushStatus)) {
          hasUpdates = true;
        }
      }
    } catch (error: any) {
      console.error(`Failed to check streams for server ${server.name}:`, error.message);
      for (const stream of streamsByServer[Number(serverId)]) {
        if (stream.status !== 'offline') {
          await sendTelegramNotification(`❌ <b>Stream Offline (Error)</b>\n\n<b>Stream:</b> ${stream.name}\n<b>Server:</b> ${server.name}\n<b>Error:</b> ${error.message}`);
          db.prepare('UPDATE streams SET status = ?, push_status = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?').run('offline', '[]', stream.id);
          hasUpdates = true;
        }
      }
    }
  }

  if (hasUpdates) {
    broadcastStreamsUpdate();
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


async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  const server = app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

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
