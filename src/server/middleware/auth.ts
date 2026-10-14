import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db } from '../db';

export interface AuthRequest extends express.Request {
  user?: any;
}

export const authenticateToken = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as any;
    req.user = decoded;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid token.' });
  }
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
  ).get(req.user.id, streamId);

  if (!assignment) {
    return res.status(403).json({ error: 'Access denied to this stream.' });
  }

  next();
};
