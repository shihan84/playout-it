import { Router } from 'express';
import { db } from '../db';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();

// Phase 3 P3 — Broadcast monitoring (read-only aggregation).
//
// Pulls together what the watchdog already tracks (stream status, input
// status, uptime), what the scheduler is doing (running/upcoming playout
// jobs + progress), overlay worker state, and the operational event
// timeline (stream_events + failed jobs). Admin-only for now; P4 may open
// scoped views to clients.

// overlay_jobs lives in the P2 feature branch — query defensively so this
// route works whether or not that migration has landed yet.
const hasOverlayJobs = () =>
  !!(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='overlay_jobs'`).get());

function jobProgress(job: any, nowMs: number) {
  const start = Date.parse(job.start_at_utc);
  const end = Date.parse(job.end_at_utc);
  const pct = end > start ? Math.min(100, Math.max(0, Math.round(((nowMs - start) / (end - start)) * 100))) : null;
  return {
    id: job.id, kind: job.kind, start_at_utc: job.start_at_utc, end_at_utc: job.end_at_utc,
    status: job.status, progress_pct: pct, inputs: JSON.parse(job.inputs || '[]'),
    last_error: job.last_error,
  };
}

function channelSummary(stream: any, nowMs: number) {
  // 'swapping' = claimed, remote PUT in flight — counts as the current job.
  const running = db.prepare(
    `SELECT * FROM playout_jobs WHERE stream_id = ? AND status IN ('running','swapping') ORDER BY start_at_utc DESC LIMIT 1`
  ).get(stream.id) as any;
  const next = db.prepare(
    `SELECT * FROM playout_jobs WHERE stream_id = ? AND status = 'scheduled' AND start_at_utc > ? ORDER BY start_at_utc LIMIT 1`
  ).get(stream.id, new Date(nowMs).toISOString()) as any;
  const overlay = hasOverlayJobs() ? db.prepare(
    `SELECT id, status, pid, last_error FROM overlay_jobs WHERE stream_id = ? AND status IN ('starting','running') LIMIT 1`
  ).get(stream.id) as any : null;
  const failures24h = db.prepare(
    `SELECT COUNT(*) n FROM playout_jobs WHERE stream_id = ? AND status IN ('failed','skipped','restore_failed','restore_unverified') AND created_at > datetime('now', '-1 day')`
  ).get(stream.id) as any;

  return {
    id: stream.id,
    name: stream.name,
    server_id: stream.server_id,
    status: stream.status,
    input_status: stream.input_status,
    source_type: stream.source_type,
    uptime: stream.uptime,
    lifecycle_state: stream.lifecycle_state,
    inputs: JSON.parse(stream.inputs || '[]'),
    playout: {
      running: running ? jobProgress(running, nowMs) : null,
      next: next ? jobProgress(next, nowMs) : null,
      failures_24h: failures24h.n,
    },
    overlay: overlay || null,
  };
}

// GET /api/monitoring/channels — one row per stream, all monitoring facets.
router.get('/channels', authenticateToken, requireAdmin, (_req, res) => {
  const streams = db.prepare('SELECT * FROM streams ORDER BY name').all() as any[];
  const nowMs = Date.now();
  res.json(streams.map(s => channelSummary(s, nowMs)));
});

// GET /api/monitoring/channels/:id — full detail + recent event history.
router.get('/channels/:id', authenticateToken, requireAdmin, (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id) as any;
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const events = db.prepare(
    `SELECT id, from_state, to_state, detail, created_at FROM stream_events
     WHERE stream_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`
  ).all(stream.id);
  res.json({ ...channelSummary(stream, Date.now()), events });
});

// GET /api/monitoring/events — global operational log across all channels.
// ?stream_id=, ?since=<iso>, ?limit<=500
router.get('/events', authenticateToken, requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const conds: string[] = [];
  const params: any[] = [];
  if (req.query.stream_id) { conds.push('e.stream_id = ?'); params.push(Number(req.query.stream_id)); }
  if (req.query.since) { conds.push('e.created_at >= ?'); params.push(String(req.query.since)); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT e.id, e.stream_id, s.name AS stream_name, e.from_state, e.to_state, e.detail, e.created_at
     FROM stream_events e LEFT JOIN streams s ON s.id = e.stream_id
     ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`
  ).all(...params, limit);
  res.json(rows);
});

// GET /api/monitoring/jobs/failures — recent failed/skipped playout + overlay jobs.
router.get('/jobs/failures', authenticateToken, requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const playout = db.prepare(
    `SELECT 'playout' AS type, j.id, j.stream_id, s.name AS stream_name, j.status, j.last_error, j.start_at_utc AS at
     FROM playout_jobs j LEFT JOIN streams s ON s.id = j.stream_id
     WHERE j.status IN ('failed','skipped','restore_failed','restore_unverified') ORDER BY j.created_at DESC LIMIT ?`
  ).all(limit);
  const overlay = hasOverlayJobs() ? db.prepare(
    `SELECT 'overlay' AS type, j.id, j.stream_id, s.name AS stream_name, j.status, j.last_error, j.stopped_at AS at
     FROM overlay_jobs j LEFT JOIN streams s ON s.id = j.stream_id
     WHERE j.status IN ('failed','exited') ORDER BY j.id DESC LIMIT ?`
  ).all(limit) : [];
  const merged = [...playout, ...overlay].sort((a: any, b: any) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
  res.json(merged);
});

export default router;
