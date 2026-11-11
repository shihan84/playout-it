import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db } from '../db';

export interface AuthRequest extends express.Request {
  user?: any;
}

export interface SessionUser {
  id: number;
  username: string;
  role: string;
}

// Verifies the JWT and re-loads the user so deleted users, role changes and
// revoked sessions (token_version bump) take effect immediately. Role always
// comes from the DB, never from the token.
export function resolveSession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  let decoded: any;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded.id !== 'number') return null;
  const row = db.prepare('SELECT id, username, role, token_version FROM users WHERE id = ?').get(decoded.id) as any;
  if (!row) return null;
  if ((decoded.tv ?? 0) !== (row.token_version ?? 0)) return null;
  return { id: row.id, username: row.username, role: row.role };
}

export const authenticateToken = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const user = resolveSession(token);
  if (!user) {
    // 401 (not 403) so clients treat an expired/invalid session as "log in again".
    if (req.cookies?.token) res.clearCookie('token');
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
  req.user = user;
  next();
};

export const requireAdmin = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

export const requireStreamAccess = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  if (req.user?.role === 'admin') {
    return next();
  }

  const streamId = req.params.id || req.params.streamId || req.body.stream_id;
  if (!streamId) {
    return res.status(400).json({ error: 'Stream ID required' });
  }

  const assignment = db.prepare(
    'SELECT * FROM user_stream_assignments WHERE user_id = ? AND stream_id = ?'
  ).get(req.user.id, streamId) as any;

  if (!assignment) {
    return res.status(403).json({ error: 'Access denied to this stream.' });
  }

  // Assignment expiry is enforced server-side (Phase 2 P2)
  if (assignment.expires_at && new Date(assignment.expires_at).getTime() <= Date.now()) {
    return res.status(403).json({ error: 'Stream assignment has expired.' });
  }

  next();
};

// SQL predicate for "assignment still valid". Use with the appropriate table
// alias — datetime() normalizes both ISO-8601 and SQLite timestamp formats.
export const assignmentActiveSql = (alias: string) =>
  `(${alias}.expires_at IS NULL OR datetime(${alias}.expires_at) > datetime('now'))`;
