import { Router } from 'express';
import { db } from '../db';
import { flussonicRequest } from '../services/flussonic';
import { syncServerStreams, syncServerVods } from '../services/sync';
import { broadcastStreamsUpdate } from '../websocket';
import { authenticateToken, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', authenticateToken, requireAdmin, async (req, res) => {
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

router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const { name, url, username, password, api_key } = req.body;

  // Input validation
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Server name is required' });
  }
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Valid server URL is required (must start with http:// or https://)' });
  }

  // Resolve credentials: prefer explicit username/password, fall back to legacy api_key
  let finalUser = (username || '').trim();
  let finalPass = (password || '').trim();
  let finalKey = (api_key || '').trim();

  if (!finalUser && !finalPass && !finalKey) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (!finalUser && !finalPass && finalKey) {
    // Legacy api_key provided
    if (finalKey.includes(':')) {
      const [u, ...rest] = finalKey.split(':');
      finalUser = u;
      finalPass = rest.join(':');
    } else {
      finalUser = 'flussonic';
      finalPass = finalKey;
    }
  }
  if (!finalUser || !finalPass) {
    return res.status(400).json({ error: 'Both username and password are required' });
  }

  // Keep api_key column populated for backward compatibility
  const apiKeyValue = `${finalUser}:${finalPass}`;

  const stmt = db.prepare('INSERT INTO servers (name, url, api_key, username, password) VALUES (?, ?, ?, ?, ?)');
  const info = stmt.run(name.trim(), url.trim(), apiKeyValue, finalUser, finalPass);

  const server = { id: info.lastInsertRowid, name: name.trim(), url: url.trim(), api_key: apiKeyValue, username: finalUser, password: finalPass };

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
router.get('/:id/status', authenticateToken, requireAdmin, async (req, res) => {
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

router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
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

// Sync Streams from Server
router.post('/:id/sync', authenticateToken, requireAdmin, async (req, res) => {
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
router.post('/sync-all', authenticateToken, requireAdmin, async (req, res) => {
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
    console.error('Sync all error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
