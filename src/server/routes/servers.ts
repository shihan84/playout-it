import { Router } from 'express';
import { db } from '../db';
import { flussonicRequest, serverInBackoff } from '../services/flussonic';
import { mapLimit } from '../utils/concurrency';
import { syncServerStreams, syncServerVods } from '../services/sync';
import { broadcastStreamsUpdate } from '../websocket';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();

const publicServer = (server: any) => {
  const { api_key, username, password, ...safe } = server;
  return safe;
};

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
        ...publicServer(server),
        status: 'online',
        last_checked: new Date().toISOString(),
        config: response.data || null
      };
    } catch (error: any) {
      console.error(`Failed to check server ${server.name} status:`, error.message);
      return {
        ...publicServer(server),
        status: 'offline',
        last_checked: new Date().toISOString(),
        config: null
      };
    }
  }));

  res.json(serversWithStatus);
});

router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const { name, url, username, password, api_key, sync_interval_secs } = req.body;

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

  const syncInterval = Number.isInteger(sync_interval_secs) && sync_interval_secs >= 10 && sync_interval_secs <= 86400
    ? sync_interval_secs : null;

  const stmt = db.prepare('INSERT INTO servers (name, url, api_key, username, password, sync_interval_secs) VALUES (?, ?, ?, ?, ?, ?)');
  const info = stmt.run(name.trim(), url.trim(), apiKeyValue, finalUser, finalPass, syncInterval);

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

  res.json(publicServer(server));
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

// Persisted health record + live probe for a single server
router.get('/:id/health', authenticateToken, requireAdmin, async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as any;
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const started = Date.now();
  try {
    const response = await flussonicRequest('GET', `${server.url}/flussonic/api/v3/config`, server, null, 10000);
    const fresh = db.prepare('SELECT last_seen_at, last_attempt_at, last_error, consecutive_failures, latency_ms FROM servers WHERE id = ?').get(server.id) as any;
    res.json({
      status: 'online',
      latency_ms: Date.now() - started,
      last_seen_at: fresh?.last_seen_at ?? null,
      last_attempt_at: fresh?.last_attempt_at ?? null,
      last_error: null,
      consecutive_failures: 0,
      in_backoff: false,
      version: response.data?.version || response.data?.stats?.version || null
    });
  } catch (error: any) {
    const fresh = db.prepare('SELECT last_seen_at, last_attempt_at, last_error, consecutive_failures, latency_ms FROM servers WHERE id = ?').get(server.id) as any;
    res.json({
      status: 'offline',
      latency_ms: fresh?.latency_ms ?? null,
      last_seen_at: fresh?.last_seen_at ?? null,
      last_attempt_at: fresh?.last_attempt_at ?? null,
      last_error: error.message,
      consecutive_failures: fresh?.consecutive_failures ?? 0,
      in_backoff: serverInBackoff(fresh || server)
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

    // Unlink only. Never delete remote Flussonic resources when removing a server.
    // Existing stream/VOD records are retained and detached for reassignment.
    db.transaction(() => {
      db.prepare('UPDATE streams SET server_id = NULL WHERE server_id = ?').run(serverId);
      db.prepare('UPDATE vods SET server_id = NULL WHERE server_id = ?').run(serverId);
      db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    })();

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

    const { addedCount, removedCount, pendingRemovals } = await syncServerStreams(server);
    const vodSync = await syncServerVods(server);
    db.prepare('UPDATE servers SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(server.id);

    if (addedCount > 0 || removedCount > 0) {
      broadcastStreamsUpdate();
    }

    res.json({
      success: !vodSync.error,
      added: addedCount,
      removed: removedCount,
      vodsAdded: vodSync.addedCount,
      vodsRemoved: vodSync.removedCount,
      pendingRemovals: (pendingRemovals || 0) + (vodSync.pendingRemovals || 0),
      ...(vodSync.error ? { error: vodSync.error } : {})
    });
  } catch (error: any) {
    console.error(`Sync error for server ${req.params.id}:`, error.message);
    res.json({ success: false, added: 0, removed: 0, error: error.message });
  }
});

// Explicit admin-confirmed reconciliation: applies pending deletions.
// Regular sync NEVER deletes — it only reports pendingRemovals. This
// endpoint requires { confirm: true } and still enforces the verified
// deletion policy (complete inventory + second-fetch confirmation +
// conservative limits) inside the sync service.
router.post('/:id/prune', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'Pruning requires { confirm: true } — deletions are never automatic' });
    }
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const s = await syncServerStreams(server, { allowDeletions: true });
    const vodSync = await syncServerVods(server, { allowDeletions: true });

    // Audit trail: prune is the only path that can delete local rows
    console.warn(`[prune] admin=${req.user?.username ?? req.user?.id} server=${server.name} removed=${s.removedCount} vodsRemoved=${vodSync.removedCount} pending=${(s.pendingRemovals || 0) + (vodSync.pendingRemovals || 0)}`);

    if (s.removedCount > 0 || vodSync.removedCount > 0) {
      broadcastStreamsUpdate();
    }

    res.json({
      success: !vodSync.error,
      removed: s.removedCount,
      vodsRemoved: vodSync.removedCount,
      pendingRemovals: (s.pendingRemovals || 0) + (vodSync.pendingRemovals || 0),
      protectedRemovals: (s.protectedRemovals || 0) + (vodSync.protectedRemovals || 0),
      ...(vodSync.error ? { error: vodSync.error } : {})
    });
  } catch (error: any) {
    console.error(`Prune error for server ${req.params.id}:`, error.message);
    res.json({ success: false, error: error.message });
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
    let totalPendingRemovals = 0;
    const skipped: string[] = [];
    const failed: string[] = [];

    // Bounded parallelism so one hung server can't stall the whole sync
    await mapLimit(servers, 4, async (server) => {
      if (serverInBackoff(server)) {
        skipped.push(server.name);
        return;
      }
      try {
        const s = await syncServerStreams(server);
        const vodSync = await syncServerVods(server);

        totalAdded += s.addedCount + vodSync.addedCount;
        totalRemoved += s.removedCount + vodSync.removedCount;
        totalVodsAdded += vodSync.addedCount;
        totalVodsRemoved += vodSync.removedCount;
        totalPendingRemovals += (s.pendingRemovals || 0) + (vodSync.pendingRemovals || 0);
        if (vodSync.error) failed.push(server.name);
      } catch (err: any) {
        console.error(`Failed to sync server ${server.name}:`, err.message);
        failed.push(server.name);
      }
    });

    if (totalAdded > 0 || totalRemoved > 0) {
      broadcastStreamsUpdate();
    }

    res.json({
      success: true,
      added: totalAdded,
      removed: totalRemoved,
      vodsAdded: totalVodsAdded,
      vodsRemoved: totalVodsRemoved,
      pendingRemovals: totalPendingRemovals,
      skipped,
      failed
    });
  } catch (error: any) {
    console.error('Sync all error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
