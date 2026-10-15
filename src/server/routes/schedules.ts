import { Router } from 'express';
import { db } from '../db';
import {
  SchedulerError, isValidTimezone, validateJobSpec, createJob, findOverlap,
} from '../services/scheduler';
import { authenticateToken, requireAdmin, requireStreamAccess, AuthRequest } from '../middleware/auth';
import { broadcastStreamsUpdate } from '../websocket';

const router = Router();

function err(e: any, res: any) {
  res.status(e.status || 500).json({ error: e.message });
}

// ---- Schedules ------------------------------------------------------------

router.get('/', authenticateToken, requireAdmin, (_req, res) => {
  const rows = db.prepare(
    `SELECT ps.*, s.name AS stream_name,
       (SELECT COUNT(*) FROM playout_jobs j WHERE j.schedule_id = ps.id AND j.status IN ('scheduled','running')) AS active_jobs
     FROM playout_schedules ps JOIN streams s ON s.id = ps.stream_id ORDER BY ps.id`
  ).all();
  res.json(rows);
});

router.post('/', authenticateToken, requireAdmin, (req: AuthRequest, res) => {
  try {
    const { stream_id, name, timezone = 'UTC', enabled = 1 } = req.body || {};
    if (typeof stream_id !== 'number') throw new SchedulerError('stream_id is required');
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
      throw new SchedulerError('name is required (max 200 chars)');
    }
    if (!isValidTimezone(timezone)) throw new SchedulerError(`Invalid timezone '${timezone}' (use an IANA name, e.g. 'UTC', 'Asia/Kolkata')`);
    const stream = db.prepare('SELECT id FROM streams WHERE id = ?').get(stream_id);
    if (!stream) throw new SchedulerError('Stream not found', 404);
    const info = db.prepare(
      'INSERT INTO playout_schedules (stream_id, name, timezone, enabled, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(stream_id, name.trim(), timezone, enabled ? 1 : 0, req.user.id);
    res.json(db.prepare('SELECT * FROM playout_schedules WHERE id = ?').get(info.lastInsertRowid));
  } catch (e: any) { err(e, res); }
});

router.patch('/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const sched = db.prepare('SELECT * FROM playout_schedules WHERE id = ?').get(req.params.id) as any;
    if (!sched) throw new SchedulerError('Schedule not found', 404);
    const { name, timezone, enabled } = req.body || {};
    if (timezone !== undefined && !isValidTimezone(timezone)) {
      throw new SchedulerError(`Invalid timezone '${timezone}'`);
    }
    db.prepare('UPDATE playout_schedules SET name = ?, timezone = ?, enabled = ? WHERE id = ?')
      .run(
        name !== undefined ? String(name).trim() : sched.name,
        timezone !== undefined ? timezone : sched.timezone,
        enabled !== undefined ? (enabled ? 1 : 0) : sched.enabled,
        sched.id
      );
    res.json(db.prepare('SELECT * FROM playout_schedules WHERE id = ?').get(sched.id));
  } catch (e: any) { err(e, res); }
});

router.delete('/:id', authenticateToken, requireAdmin, (req, res) => {
  // Deleting a schedule cancels its pending jobs but never touches remote config.
  const info = db.transaction(() => {
    db.prepare(
      `UPDATE playout_jobs SET status = 'cancelled' WHERE schedule_id = ? AND status = 'scheduled'`
    ).run(req.params.id);
    return db.prepare('DELETE FROM playout_schedules WHERE id = ?').run(req.params.id);
  })();
  if (info.changes === 0) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ success: true });
});

// ---- Jobs -----------------------------------------------------------------

router.get('/:id/jobs', authenticateToken, requireAdmin, (req, res) => {
  const sched = db.prepare('SELECT id FROM playout_schedules WHERE id = ?').get(req.params.id);
  if (!sched) return res.status(404).json({ error: 'Schedule not found' });
  const rows = db.prepare(
    `SELECT id, schedule_id, stream_id, kind, inputs, start_at_utc, duration_sec, end_at_utc, status, last_error, created_at
     FROM playout_jobs WHERE schedule_id = ? ORDER BY start_at_utc`
  ).all(req.params.id) as any[];
  res.json(rows.map(j => ({ ...j, inputs: JSON.parse(j.inputs || '[]') })));
});

router.post('/:id/jobs', authenticateToken, requireAdmin, (req: AuthRequest, res) => {
  try {
    const sched = db.prepare('SELECT * FROM playout_schedules WHERE id = ?').get(req.params.id) as any;
    if (!sched) throw new SchedulerError('Schedule not found', 404);
    if (!sched.enabled) throw new SchedulerError('Schedule is disabled — enable it before adding jobs', 409);
    const spec = validateJobSpec(req.body, sched.timezone);
    const job = createJob(sched.stream_id, sched.id, spec);
    res.status(201).json(job);
  } catch (e: any) { err(e, res); }
});

router.delete('/jobs/:jobId', authenticateToken, requireAdmin, (req, res) => {
  const job = db.prepare('SELECT * FROM playout_jobs WHERE id = ?').get(req.params.jobId) as any;
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!['scheduled', 'skipped', 'completed', 'failed'].includes(job.status)) {
    return res.status(409).json({ error: `Cannot cancel a job in status '${job.status}'` });
  }
  db.prepare(`UPDATE playout_jobs SET status = 'cancelled' WHERE id = ? AND status != 'running'`).run(job.id);
  res.json({ success: true });
});

// ---- Per-stream schedule view (read for assigned users too) ---------------

// Now/next preview — what is airing and what comes next within `hours`.
router.get('/stream/:streamId/next', authenticateToken, requireStreamAccess, (req, res) => {
  const now = new Date().toISOString();
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
  const horizon = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const running = db.prepare(
    `SELECT id, kind, inputs, start_at_utc, end_at_utc, status FROM playout_jobs
     WHERE stream_id = ? AND status = 'running' LIMIT 1`
  ).all(req.params.streamId) as any[];
  const upcoming = db.prepare(
    `SELECT id, kind, inputs, start_at_utc, end_at_utc, status FROM playout_jobs
     WHERE stream_id = ? AND status = 'scheduled' AND start_at_utc < ? ORDER BY start_at_utc LIMIT 20`
  ).all(req.params.streamId, horizon) as any[];
  res.json({
    now,
    running: running.map(j => ({ ...j, inputs: JSON.parse(j.inputs || '[]') })),
    upcoming: upcoming.map(j => ({ ...j, inputs: JSON.parse(j.inputs || '[]') })),
  });
});

export default router;
