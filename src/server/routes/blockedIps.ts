import { Router } from 'express';
import { db } from '../db';
import { flussonicRequest } from '../services/flussonic';
import { authenticateToken, requireAdmin, AuthRequest, assignmentActiveSql } from '../middleware/auth';

const router = Router();

// Names of streams on a server the user currently holds an unexpired assignment for.
function activeStreamNames(userId: number, serverId: number): string[] {
  return (db.prepare(`
    SELECT s.name
    FROM streams s
    JOIN user_stream_assignments usa ON s.id = usa.stream_id
    WHERE usa.user_id = ? AND s.server_id = ? AND ${assignmentActiveSql('usa')}
  `).all(userId, serverId) as any[]).map(s => s.name);
}

async function fetchPlaySessions(server: any): Promise<any[]> {
  const response = await flussonicRequest('GET', `${server.url}/flussonic/api/v3/sessions`, server);
  let sessions: any[] = [];
  if (response.data) {
    if (Array.isArray(response.data)) {
      sessions = response.data;
    } else if (Array.isArray(response.data.sessions)) {
      sessions = response.data.sessions;
    } else if (Array.isArray(response.data.play_sessions)) {
      sessions = response.data.play_sessions;
    }
  }
  return sessions.map((session: any) => ({
    ...session,
    ip: session.ip || session.client_ip || session.remote_addr || 'Unknown IP',
    stream_name: session.stream_name || session.name || session.stream || session.app || 'Unknown stream',
    started_at: session.started_at || session.created_at || session.timestamp || null,
  }));
}

router.get('/blocked-ips', authenticateToken, requireAdmin, (req, res) => {
  const blockedIps = db.prepare(`
    SELECT bi.*, u.username as blocked_by_username
    FROM blocked_ips bi
    LEFT JOIN users u ON bi.blocked_by = u.id
    ORDER BY bi.created_at DESC
  `).all();
  res.json(blockedIps);
});

router.post('/blocked-ips', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
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

router.delete('/blocked-ips/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
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
router.get('/servers/:serverId/sessions', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.serverId) as any;
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const allowed = req.user.role === 'admin' ? null : activeStreamNames(req.user.id, server.id);
    if (allowed && allowed.length === 0) {
      return res.status(403).json({ error: 'You do not have access to any streams on this server' });
    }

    let sessions = await fetchPlaySessions(server);
    if (allowed) sessions = sessions.filter((s: any) => allowed.includes(s.stream_name));
    res.json(sessions);
  } catch (error: any) {
    console.error('Failed to fetch sessions:', error.message);
    // Return empty array instead of error when no sessions exist
    if (error.response?.status === 404 || error.message?.includes('not found')) {
      res.json([]);
    } else {
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  }
});

// Block IP from play session
router.post('/block-ip', authenticateToken, async (req: AuthRequest, res) => {
  const { ip_address, reason, server_id, stream_name } = req.body;

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

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id) as any;
  if (!server) {
    return res.status(404).json({ error: 'Server not found' });
  }

  // Clients may only block an IP that is currently watching one of their
  // own (unexpired) streams.
  if (req.user.role !== 'admin') {
    if (!stream_name) {
      return res.status(400).json({ error: 'Stream name is required for non-admin users' });
    }
    if (!activeStreamNames(req.user.id, server.id).includes(stream_name)) {
      return res.status(403).json({ error: 'You do not have access to this stream' });
    }
    let sessions: any[];
    try {
      sessions = await fetchPlaySessions(server);
    } catch (e: any) {
      console.error('Failed to fetch sessions for block check:', e.message);
      return res.status(502).json({ error: 'Could not verify viewer sessions on the server' });
    }
    if (!sessions.some((s: any) => s.ip === ip_address && s.stream_name === stream_name)) {
      return res.status(403).json({ error: 'This IP is not currently watching your stream' });
    }
  }

  try {
    const info = db.prepare('INSERT INTO blocked_ips (ip_address, reason, blocked_by) VALUES (?, ?, ?)').run(
      ip_address,
      reason || 'Blocked from play session',
      req.user.id
    );

    try {
      await flussonicRequest('PUT', `${server.url}/flussonic/api/v3/auth_backends/blacklist`, server, {
        type: 'deny',
        ip: ip_address
      });
      console.log(`Blocked IP ${ip_address} on Flussonic server ${server.name}`);
    } catch (e: any) {
      console.error('Failed to block IP on Flussonic server:', e.message);
      db.prepare('DELETE FROM blocked_ips WHERE id = ?').run(info.lastInsertRowid);
      return res.status(502).json({ error: 'Failed to block IP on the Flussonic server' });
    }

    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e: any) {
    if (e.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: 'IP address already blocked' });
    }
    throw e;
  }
});

export default router;
