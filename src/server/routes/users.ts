import { Router } from 'express';
import bcrypt from 'bcrypt';
import { db } from '../db';
import { config } from '../config';
import { authenticateToken, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', authenticateToken, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, email, role, created_at FROM users').all();
  res.json(users);
});

router.post('/', authenticateToken, requireAdmin, (req, res) => {
  const { username, password, email, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existingUser) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const passwordHash = bcrypt.hashSync(password, config.saltRounds);
  const info = db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)').run(
    username,
    passwordHash,
    email || null,
    role || 'client'
  );

  const user = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json(user);
});

router.put('/:id', authenticateToken, requireAdmin, (req, res) => {
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
    values.push(bcrypt.hashSync(password, config.saltRounds));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  values.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const user = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(id);
  res.json(user);
});

router.delete('/:id', authenticateToken, requireAdmin, (req: any, res) => {
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
router.get('/:userId/streams', authenticateToken, requireAdmin, (req, res) => {
  const { userId } = req.params;
  const assignments = db.prepare(`
    SELECT usa.*, streams.name as stream_name, streams.server_id
    FROM user_stream_assignments usa
    JOIN streams ON usa.stream_id = streams.id
    WHERE usa.user_id = ?
  `).all(userId);
  res.json(assignments);
});

router.post('/:userId/streams', authenticateToken, requireAdmin, (req, res) => {
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

router.delete('/:userId/streams/:streamId', authenticateToken, requireAdmin, (req, res) => {
  const { userId, streamId } = req.params;

  db.prepare('DELETE FROM user_stream_assignments WHERE user_id = ? AND stream_id = ?').run(userId, streamId);
  res.json({ success: true });
});

export default router;
