import { Router } from 'express';
import { db } from '../db';
import { parseStream } from '../utils/streams';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/', authenticateToken, (req: AuthRequest, res) => {
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
      AND (user_stream_assignments.expires_at IS NULL OR datetime(user_stream_assignments.expires_at) > datetime('now'))
  `).all(req.user.id);

  console.log('Client user, returning assigned streams:', streams.length);
  res.json(streams.map(parseStream));
});

export default router;
