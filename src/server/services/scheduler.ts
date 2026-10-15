import { db } from '../db';
import { flussonicRequest } from './flussonic';
import { recordStreamEvent } from './lifecycle';

// Phase 3 P1 — Scheduled playout engine.
//
// Model: a job swaps a stream's Flussonic inputs at start_at_utc and
// restores the previously captured inputs at end_at_utc. Flussonic does
// the actual switching — we only make supported API calls.
//
// Safety invariants (single-process deployment):
// - Jobs are claimed atomically: UPDATE ... WHERE status='scheduled'
//   must report changes=1 before we touch the remote server.
// - UNIQUE(stream_id, start_at_utc) prevents duplicate jobs.
// - Overlapping windows on the same stream are rejected at create time.
// - Boot recovery never replays stale content: jobs whose window fully
//   elapsed while the app was down are marked 'skipped'.
// - All times are stored UTC; timezone applies only at job creation.

export class SchedulerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Overridable for tests; production always uses the 30s default.
const TICK_MS = Number(process.env.SCHEDULER_TICK_MS) > 0 ? Number(process.env.SCHEDULER_TICK_MS) : 30000;
let tickTimer: NodeJS.Timeout | null = null;
let isTicking = false;

// ---- Time helpers ---------------------------------------------------------

export function isValidTimezone(tz: any): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getUtcOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

// Accepts ISO 8601. Naive datetimes (no offset) are interpreted in `tz`;
// explicit offsets/Z are used as given. Returns UTC ISO string.
export function toUtcIso(input: any, tz: string): string {
  if (typeof input !== 'string') throw new SchedulerError('start_at must be an ISO 8601 string');
  const trimmed = input.trim();
  if (Number.isNaN(Date.parse(trimmed))) throw new SchedulerError(`Invalid start_at '${input}'`);
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  if (hasOffset) return new Date(Date.parse(trimmed)).toISOString();
  // Interpret the naive wall-clock time in `tz`
  const guess = Date.parse(`${input.trim()}Z`);
  const offset = getUtcOffsetMs(tz, guess);
  // Re-check in case the first offset guess crossed a DST boundary
  const refined = getUtcOffsetMs(tz, guess - offset);
  return new Date(guess - refined).toISOString();
}

// ---- Validation & creation ------------------------------------------------

const VALID_KINDS = ['inputs'] as const;

export function validateJobSpec(body: any, timezone: string) {
  if (!body || typeof body !== 'object') throw new SchedulerError('Request body is required');
  const kind = body.kind ?? 'inputs';
  if (!VALID_KINDS.includes(kind)) {
    throw new SchedulerError(`kind must be one of ${VALID_KINDS.join(', ')}`);
  }
  const inputs = body.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new SchedulerError('inputs must be a non-empty array');
  }
  for (const inp of inputs) {
    const url = typeof inp === 'string' ? inp : inp?.url;
    if (!url || typeof url !== 'string' || url.length > 2048) {
      throw new SchedulerError('each input must have a non-empty url (max 2048 chars)');
    }
  }
  const durationSec = Number(body.duration_sec);
  if (!Number.isInteger(durationSec) || durationSec <= 0 || durationSec > 86400 * 30) {
    throw new SchedulerError('duration_sec must be an integer between 1 and 2592000');
  }
  const startUtc = toUtcIso(body.start_at, timezone);
  const endUtc = new Date(Date.parse(startUtc) + durationSec * 1000).toISOString();
  return {
    kind,
    inputs: inputs.map((i: any) => ({ url: typeof i === 'string' ? i : i.url })),
    start_at_utc: startUtc,
    duration_sec: durationSec,
    end_at_utc: endUtc,
  };
}

export function findOverlap(streamId: number, startUtc: string, endUtc: string, excludeJobId = 0): any | null {
  return db.prepare(
    `SELECT id, start_at_utc, end_at_utc, status FROM playout_jobs
     WHERE stream_id = ? AND id != ? AND status IN ('scheduled', 'running')
       AND start_at_utc < ? AND end_at_utc > ?
     LIMIT 1`
  ).get(streamId, excludeJobId, endUtc, startUtc) as any;
}

export function createJob(streamId: number, scheduleId: number | null, spec: any): any {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId) as any;
  if (!stream) throw new SchedulerError('Stream not found', 404);
  const conflict = findOverlap(streamId, spec.start_at_utc, spec.end_at_utc);
  if (conflict) {
    throw new SchedulerError(
      `Job overlaps existing job #${conflict.id} (${conflict.start_at_utc} → ${conflict.end_at_utc}, status=${conflict.status})`, 409);
  }
  try {
    const info = db.prepare(
      `INSERT INTO playout_jobs (schedule_id, stream_id, kind, inputs, start_at_utc, duration_sec, end_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(scheduleId, streamId, spec.kind, JSON.stringify(spec.inputs), spec.start_at_utc, spec.duration_sec, spec.end_at_utc);
    return db.prepare('SELECT * FROM playout_jobs WHERE id = ?').get(info.lastInsertRowid);
  } catch (e: any) {
    if (e.code === 'SQLITE_CONSTRAINT' || String(e.message).includes('UNIQUE')) {
      throw new SchedulerError(`A job already exists on this stream at ${spec.start_at_utc}`, 409);
    }
    throw e;
  }
}

// ---- Execution ------------------------------------------------------------

function normalizeInputs(raw: any): { url: string }[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((i: any) => ({ url: typeof i === 'string' ? i : i.url })).filter((i: any) => !!i.url);
}

async function swapStreamInputs(stream: any, server: any, inputs: { url: string }[]) {
  const baseUrl = server.url.replace(/\/$/, '');
  const streamUrl = `${baseUrl}/flussonic/api/v3/streams/${encodeURIComponent(stream.name)}`;
  const current = await flussonicRequest('GET', streamUrl, server);
  const fData = current.data;
  const existingInputs = fData.config_on_disk?.inputs || fData.inputs || [];
  await flussonicRequest('PUT', streamUrl, server, {
    name: stream.name,
    inputs,
    ...(fData.config_on_disk?.pushes ? { pushes: fData.config_on_disk.pushes } : {}),
  });
  return existingInputs;
}

async function executeJob(job: any) {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(job.stream_id) as any;
  const server = stream?.server_id ? db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any : null;
  if (!stream || !server) throw new SchedulerError('stream or server no longer exists');
  const inputs = normalizeInputs(JSON.parse(job.inputs));
  if (inputs.length === 0) throw new SchedulerError('job has no inputs');
  const previous = await swapStreamInputs(stream, server, inputs);
  db.prepare('UPDATE playout_jobs SET previous_inputs = ? WHERE id = ?').run(JSON.stringify(normalizeInputs(previous)), job.id);
  db.prepare('UPDATE streams SET inputs = ? WHERE id = ?').run(JSON.stringify(inputs.map(i => i.url)), stream.id);
  recordStreamEvent(stream.id, stream.lifecycle_state, stream.lifecycle_state, null,
    `playout job #${job.id} started: inputs -> ${JSON.stringify(inputs.map(i => i.url))}`);
}

async function restoreJob(job: any) {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(job.stream_id) as any;
  const server = stream?.server_id ? db.prepare('SELECT * FROM servers WHERE id = ?').get(stream.server_id) as any : null;
  const previous = normalizeInputs(job.previous_inputs ? JSON.parse(job.previous_inputs) : []);
  if (!stream || !server || previous.length === 0) return; // nothing restorable — job still completes
  try {
    await swapStreamInputs(stream, server, previous);
    db.prepare('UPDATE streams SET inputs = ? WHERE id = ?').run(JSON.stringify(previous.map(i => i.url)), stream.id);
    recordStreamEvent(stream.id, stream.lifecycle_state, stream.lifecycle_state, null,
      `playout job #${job.id} completed: inputs restored`);
  } catch (e: any) {
    // Restore is best-effort — do not rethrow; the job ends regardless and the
    // failure is surfaced via last_error + a stream event for the operator.
    recordStreamEvent(stream.id, stream.lifecycle_state, stream.lifecycle_state, null,
      `playout job #${job.id} ended but input restore FAILED: ${e.message} — manual check required on server '${server.name}'`);
    db.prepare('UPDATE playout_jobs SET last_error = ? WHERE id = ?')
      .run(`restore failed: ${e.message} (manual check required)`, job.id);
  }
}

export function recoverOnBoot() {
  const now = new Date().toISOString();
  // Jobs whose window fully elapsed while we were down: never replay mid-air.
  const missed = db.prepare(
    `UPDATE playout_jobs SET status = 'skipped', last_error = 'missed while application was down'
     WHERE status = 'scheduled' AND end_at_utc <= ?`
  ).run(now);
  // Running jobs that should have ended: restore + complete on next tick path.
  const staleRunning = db.prepare(
    `UPDATE playout_jobs SET status = 'ending' WHERE status = 'running' AND end_at_utc <= ?`
  ).run(now);
  if (missed.changes || staleRunning.changes) {
    console.log(`[scheduler] boot recovery: ${missed.changes} missed job(s) skipped, ${staleRunning.changes} stale running job(s) to finalize`);
  }
}

export async function tick() {
  const now = new Date().toISOString();

  // 1. Complete running/'ending' jobs past their window.
  const ending = db.prepare(
    `SELECT * FROM playout_jobs WHERE status IN ('running', 'ending') AND end_at_utc <= ?`
  ).all(now) as any[];
  for (const job of ending) {
    await restoreJob(job);
    db.prepare(`UPDATE playout_jobs SET status = 'completed' WHERE id = ?`).run(job.id);
  }

  // 2. Expire scheduled jobs whose window has fully elapsed.
  db.prepare(
    `UPDATE playout_jobs SET status = 'skipped', last_error = 'window elapsed before execution'
     WHERE status = 'scheduled' AND end_at_utc <= ?`
  ).run(now);

  // 3. Claim due jobs atomically and execute.
  const due = db.prepare(
    `SELECT * FROM playout_jobs WHERE status = 'scheduled' AND start_at_utc <= ? AND end_at_utc > ? ORDER BY start_at_utc LIMIT 50`
  ).all(now, now) as any[];
  for (const job of due) {
    const claim = db.prepare(
      `UPDATE playout_jobs SET status = 'running', claimed_at = ? WHERE id = ? AND status = 'scheduled'`
    ).run(now, job.id);
    if (claim.changes !== 1) continue; // claimed concurrently — not ours
    try {
      await executeJob(job);
    } catch (e: any) {
      db.prepare(`UPDATE playout_jobs SET status = 'failed', last_error = ? WHERE id = ?`).run(e.message, job.id);
      recordStreamEvent(job.stream_id, null, 'playout_failed', null,
        `playout job #${job.id} failed to start: ${e.message}`);
    }
  }
}

export function startScheduler(intervalMs = TICK_MS) {
  recoverOnBoot();
  tick().catch(e => console.error('[scheduler] initial tick failed:', e.message));
  tickTimer = setInterval(() => {
    if (isTicking) return;
    isTicking = true;
    tick().catch(e => console.error('[scheduler] tick failed:', e.message))
      .finally(() => { isTicking = false; });
  }, intervalMs);
  console.log(`[scheduler] started with interval ${intervalMs / 1000}s`);
}

export function stopScheduler() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
