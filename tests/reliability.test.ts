import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'node:http';

// P5 — Reliability & release-readiness tests (mocked Flussonic only).
// Disposable DB per run; env set BEFORE service imports.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playout-rel-'));
const tmpDb = path.join(tmpDir, 'rel.db');
process.env.DATABASE_PATH = tmpDb;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'reliability-test-secret-0123456789abcd';

const sched = await import('../src/server/services/scheduler.ts');
const { db } = await import('../src/server/db');

// --- Mock Flussonic ---------------------------------------------------------

const MOCK_PORT = 36399;
const remote = {
  inputs: new Map<string, { url: string }[]>(),
  puts: [] as string[],   // stream names that received a PUT, in order
  getCount: 0,
  failGet: false,
  failPut: false,
};

const mock = createServer((req, res) => {
  const m = (req.url || '').match(/\/flussonic\/api\/v3\/streams\/([^/?]+)$/);
  res.setHeader('Content-Type', 'application/json');
  if (!m) { res.statusCode = 404; res.end('{}'); return; }
  const name = decodeURIComponent(m[1]);
  if (req.method === 'GET') {
    remote.getCount++;
    if (remote.failGet) { res.statusCode = 500; res.end('{"error":"injected"}'); return; }
    res.end(JSON.stringify({ name, inputs: remote.inputs.get(name) || [{ url: 'udp://orig' }] }));
    return;
  }
  if (req.method === 'PUT') {
    remote.puts.push(name);
    if (remote.failPut) { res.statusCode = 500; res.end('{"error":"injected"}'); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { const p = JSON.parse(body); if (Array.isArray(p.inputs)) remote.inputs.set(name, p.inputs); } catch { /* noop */ }
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.end('{}');
});
await new Promise<void>(r => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));

function seed(streamName: string, serverUrl = `http://127.0.0.1:${MOCK_PORT}`) {
  const sInfo = db.prepare("INSERT INTO servers (name, url, api_key) VALUES (?, ?, 'u:p')").run(`srv-${streamName}`, serverUrl);
  const serverId = Number(sInfo.lastInsertRowid);
  const tInfo = db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (?, ?, '', '')").run(serverId, streamName);
  return { serverId, streamId: Number(tInfo.lastInsertRowid) };
}

function seedJob(streamId: number, status: string, opts: { inputs?: string; prev?: string | null; start?: number; end?: number } = {}) {
  const now = Date.now();
  db.prepare(`INSERT INTO playout_jobs (stream_id, kind, inputs, start_at_utc, duration_sec, end_at_utc, status, previous_inputs)
    VALUES (?, 'inputs', ?, ?, 60, ?, ?, ?)`)
    .run(streamId,
      opts.inputs ?? '[{"url":"playlist:///x/1.txt"}]',
      new Date(opts.start ?? now - 1000).toISOString(),
      new Date(opts.end ?? now + 300e3).toISOString(),
      status, opts.prev === undefined ? '[{"url":"udp://orig"}]' : opts.prev);
  return (db.prepare('SELECT MAX(id) i FROM playout_jobs WHERE stream_id = ?').get(streamId) as any).i;
}

const job = (id: number) => db.prepare('SELECT * FROM playout_jobs WHERE id = ?').get(id) as any;

// --- Tests ------------------------------------------------------------------

test('scheduler gate: disabled -> no remote calls even when jobs are due', async () => {
  // No settings row and no env -> disabled.
  delete process.env.SCHEDULER_ENABLED;
  assert.equal(sched.schedulerEnabled(), false);

  const { streamId } = seed('rel-gate');
  const jobId = seedJob(streamId, 'scheduled', { start: Date.now() - 5000 });
  remote.puts.length = 0;

  // startScheduler must refuse to arm.
  sched.startScheduler(50);
  await new Promise(r => setTimeout(r, 300));
  sched.stopScheduler();

  assert.equal(remote.puts.length, 0, 'disabled scheduler must never PUT to Flussonic');
  assert.equal(job(jobId).status, 'scheduled', 'due job stays scheduled while disabled');

  // And explicit env opt-in enables.
  process.env.SCHEDULER_ENABLED = '1';
  assert.equal(sched.schedulerEnabled(), true);
  delete process.env.SCHEDULER_ENABLED;
});

test('concurrent ticks: exactly one claim executes the remote swap', async () => {
  process.env.SCHEDULER_ENABLED = '1';
  const { streamId } = seed('rel-race');
  seedJob(streamId, 'scheduled', { start: Date.now() - 5000 });
  remote.puts.length = 0;

  // Two overlapping ticks racing the same due job.
  await Promise.all([sched.tick(), sched.tick()]);

  assert.equal(remote.puts.filter(n => n === 'rel-race').length, 1,
    'atomic claim must allow exactly one swap execution');
  const jobs = db.prepare("SELECT status FROM playout_jobs WHERE stream_id = ?").all(streamId) as any[];
  assert.equal(jobs.filter(j => j.status === 'running').length, 1);
});

test('overlap: duplicate window for same stream is rejected at service level', async () => {
  const { streamId } = seed('rel-overlap');
  const start = Date.now() + 3600e3;
  const spec = (url: string, startMs: number) => ({
    kind: 'inputs', inputs: [{ url }],
    start_at_utc: new Date(startMs).toISOString(),
    duration_sec: 600,
    end_at_utc: new Date(startMs + 600e3).toISOString(),
  });
  sched.createJob(streamId, null, spec('udp://a', start));
  assert.throws(
    () => sched.createJob(streamId, null, spec('udp://b', start + 1000)),
    (e: any) => e.status === 409
  );
});

test('crash recovery: interrupted swap + unreachable remote -> restore_unverified', async () => {
  // Server points at a dead port — remote state cannot be determined.
  const { streamId } = seed('rel-unreach', 'http://127.0.0.1:1');
  const jobId = seedJob(streamId, 'swapping');
  await sched.recoverInterruptedJobs();
  assert.equal(job(jobId).status, 'restore_unverified');
  assert.match(job(jobId).last_error, /could not be read|manual check/i);
});

test('restart recovery: stale running job restores originals at end', async () => {
  process.env.SCHEDULER_ENABLED = '1';
  const { streamId } = seed('rel-stale');
  remote.inputs.set('rel-stale', [{ url: 'playlist:///x/1.txt' }]); // as-if swap had happened
  // Past-end running job with captured originals — simulates crash mid-job.
  const jobId = seedJob(streamId, 'running', { end: Date.now() - 1000 });
  await sched.tick();
  assert.equal(job(jobId).status, 'completed');
  assert.deepEqual(remote.inputs.get('rel-stale'), [{ url: 'udp://orig' }], 'originals restored after crash');
});

test('failure injection: swap PUT fails -> job failed, remote unchanged', async () => {
  process.env.SCHEDULER_ENABLED = '1';
  const { streamId } = seed('rel-putfail');
  remote.inputs.set('rel-putfail', [{ url: 'udp://orig' }]);
  seedJob(streamId, 'scheduled', { start: Date.now() - 5000 });
  remote.failPut = true;
  await sched.tick();
  remote.failPut = false;
  const jobs = db.prepare("SELECT * FROM playout_jobs WHERE stream_id = ?").all(streamId) as any[];
  assert.equal(jobs[0].status, 'failed');
  assert.deepEqual(remote.inputs.get('rel-putfail'), [{ url: 'udp://orig' }], 'remote untouched on PUT failure');
});

test.after(() => {
  mock.close();
});
