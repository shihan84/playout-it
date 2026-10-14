import { Router } from 'express';
import { db } from '../db';
import { sendTelegramMessage, dispatchStreamAlerts } from '../services/telegram';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();

// Register Telegram alert for user/stream
router.post('/', authenticateToken, async (req: AuthRequest, res) => {
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
router.get('/', authenticateToken, (req: AuthRequest, res) => {
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
router.put('/:id', authenticateToken, async (req: AuthRequest, res) => {
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
router.delete('/:id', authenticateToken, (req: AuthRequest, res) => {
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
router.get('/:id/history', authenticateToken, (req: AuthRequest, res) => {
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
router.post('/send', authenticateToken, async (req, res) => {
  const { stream_id, alert_type, message } = req.body;

  if (!stream_id || !alert_type || !message) {
    return res.status(400).json({ error: 'stream_id, alert_type, and message are required' });
  }

  const results = await dispatchStreamAlerts(stream_id, alert_type, message);
  if (results.length === 0) {
    return res.json({ success: true, message: 'No alerts configured for this stream' });
  }
  res.json({ success: true, results });
});

export default router;
