import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { config } from '../config';
import { authenticateToken } from '../middleware/auth';
import { authRateLimiter } from '../middleware/rateLimit';

const router = Router();

// Compared against when the username doesn't exist so response time doesn't
// reveal which usernames are valid.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

router.post('/login', authRateLimiter, (req, res) => {
  const { username, password } = req.body;


  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  const passwordMatch = bcrypt.compareSync(String(password), user ? user.password_hash : DUMMY_HASH);

  if (!user || !passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.token_version ?? 0 },
    config.jwtSecret,
    { expiresIn: '24h' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
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

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

router.get('/me', authenticateToken, (req: any, res) => {
  const user = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

export default router;
