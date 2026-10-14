import { Router } from 'express';
import { db } from '../db';
import { flussonicRequest } from '../services/flussonic';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();

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
router.post('/block-ip', authenticateToken, async (req: AuthRequest, res) => {
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

export default router;
