import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Disposable DB before importing the service singleton.
const tmpDb = path.join(os.tmpdir(), `overlay-restart-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'overlay-restart-secret-0123456789abcdef';
const assetDir = path.join(os.tmpdir(), `overlay-restart-assets-${process.pid}-${Date.now()}`);
fs.mkdirSync(assetDir, { recursive: true });
process.env.OVERLAY_ASSET_DIR = assetDir;
// Fast, deterministic-ish backoff for tests (jitter ±10%).
process.env.OVERLAY_RESTART_BASE_DELAY_MS = '50';
process.env.OVERLAY_RESTART_MAX_DELAY_MS = '500';
process.env.OVERLAY_RESTART_MAX_ATTEMPTS = '3';
process.env.OVERLAY_RESTART_STABLE_MS = '60000';

const { startOverlay, stopOverlay, attemptRestart, recoverOverlayJobs,
  restartDelayMs, redactCredsInText, __setSpawnImpl, __setFfmpegAvailable } =
  await import('../src/server/services/overlay');
const { db } = await import('../src/server/db');

__setFfmpegAvailable(true); // fake spawn — real ffmpeg presence irrelevant

// ---- helpers ---------------------------------------------------------------

const spawns: { args: string[] }[] = [];
const liveProcs: any[] = [];

class FakeProc extends EventEmitter {
  stderr = new EventEmitter();
  pid = 40000 + Math.floor(Math.random() * 10000);
  args: string[];
  killed = false;
  constructor(args: string[]) { super(); this.args = args; }
  kill() { this.killed = true; return true; }
}

const restoreSpawn = __setSpawnImpl((cmd: string, args: string[]) => {
  const p = new FakeProc(args);
  spawns.push({ args });
  liveProcs.push(p);
  return p as any;
});

function seedStream(name: string) {
  db.prepare("INSERT OR IGNORE INTO servers (id, name, url, api_key) VALUES (1, 't', 'http://fs.example', 'u:p')").run();
  db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url, inputs) VALUES (1, ?, ?, '', '[]')")
    .run(name, `http://fs.example/${name}/index.m3u8`);
  return (db.prepare('SELECT id FROM streams WHERE name = ?').get(name) as any).id;
}

function seedProfile(streamId: number, name: string, autoRestart = 1) {
  return db.prepare(
    `INSERT INTO overlay_profiles (stream_id, name, output_stream, output_url, auto_restart, enabled)
     VALUES (?, ?, ?, 'srt://dest-${name}.example:9001', ?, 1)`
  ).run(streamId, name, `${name}_ovr`, autoRestart).lastInsertRowid;
}

function armGates() {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('overlay_enabled', '1')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('overlay_auto_restart', '1')").run();
}
function disarmGates() {
  db.prepare("DELETE FROM settings WHERE key IN ('overlay_enabled', 'overlay_auto_restart')").run();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const job = (id: number) => db.prepare('SELECT * FROM overlay_jobs WHERE id = ?').get(id) as any;
const jobsFor = (profileId: number) =>
  db.prepare('SELECT * FROM overlay_jobs WHERE profile_id = ? ORDER BY id').all(profileId) as any[];

// Cross-test isolation: clearing next_retry_at neutralizes any still-armed
// retry timers left by a previous test (attemptRestart no-ops on cleared
// rows), and marking leftover 'running' rows 'stopped' prevents a later
// recoverOverlayJobs() call from treating them as crash victims.
test.beforeEach(() => {
  db.prepare(`UPDATE overlay_jobs SET next_retry_at=NULL WHERE next_retry_at IS NOT NULL`).run();
  db.prepare(`UPDATE overlay_jobs SET status='stopped' WHERE status IN ('starting','running')`).run();
});

test.after(() => { restoreSpawn(); disarmGates(); });

// ---- tests -----------------------------------------------------------------

test('unexpected exit schedules auto-restart and respawns after backoff', async () => {
  armGates();
  const sid = seedStream('rs1');
  const pid = seedProfile(sid, 'rs1');
  const before = spawns.length;
  const j = await startOverlay(Number(pid));
  liveProcs[liveProcs.length - 1].emit('exit', 1);

  const crashed = job(j.id);
  assert.equal(crashed.status, 'exited');
  assert.equal(crashed.restart_count, 1);
  assert.ok(crashed.next_retry_at, 'retry time persisted for crash-during-backoff recovery');

  await sleep(150); // 50ms base + jitter → retry fires
  assert.equal(spawns.length, before + 2, 'original spawn + one respawn');
  const jobs = jobsFor(Number(pid));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].status, 'running');
  assert.equal(jobs[1].restart_count, 1, 'retry lineage carried to the new job row');
});

test('backoff grows exponentially and is capped', () => {
  process.env.OVERLAY_RESTART_BASE_DELAY_MS = '100';
  process.env.OVERLAY_RESTART_MAX_DELAY_MS = '2000'; // floor is 1000ms in code
  const d1 = restartDelayMs(1), d2 = restartDelayMs(2), d3 = restartDelayMs(3), d10 = restartDelayMs(10);
  assert.ok(d1 >= 90 && d1 <= 110, `attempt1 ~100 got ${d1}`);
  assert.ok(d2 >= 180 && d2 <= 220, `attempt2 ~200 got ${d2}`);
  assert.ok(d3 >= 360 && d3 <= 440, `attempt3 ~400 got ${d3}`);
  assert.ok(d10 >= 1800 && d10 <= 2200, `capped at max+jitter got ${d10}`);
  process.env.OVERLAY_RESTART_BASE_DELAY_MS = '50';
  process.env.OVERLAY_RESTART_MAX_DELAY_MS = '500';
});

test('retry budget exhausted -> job failed, event recorded, no more spawns', async () => {
  armGates();
  process.env.OVERLAY_RESTART_MAX_ATTEMPTS = '1';
  const sid = seedStream('rs2');
  const pid = seedProfile(sid, 'rs2');
  const j1 = await startOverlay(Number(pid));
  liveProcs[liveProcs.length - 1].emit('exit', 1); // crash #1 -> retry scheduled (attempt 1)
  await sleep(150);                              // retry fires -> job #2 running
  const j2 = jobsFor(Number(pid)).at(-1)!;
  const before = spawns.length;
  liveProcs[liveProcs.length - 1].emit('exit', 1); // crash #2 -> attempt 2 > max(1)
  await sleep(150);
  assert.equal(spawns.length, before, 'no further spawns after budget exhausted');
  assert.equal(job(j2.id).status, 'failed');
  const ev = db.prepare("SELECT detail FROM stream_events WHERE stream_id = ? AND detail LIKE '%exhausted%'").get(sid) as any;
  assert.ok(ev, 'exhaustion event recorded');
  process.env.OVERLAY_RESTART_MAX_ATTEMPTS = '3';
});

test('operator stop cancels a pending auto-restart', async () => {
  armGates();
  const sid = seedStream('rs3');
  const pid = seedProfile(sid, 'rs3');
  const j = await startOverlay(Number(pid));
  liveProcs[liveProcs.length - 1].emit('exit', 1);
  assert.ok(job(j.id).next_retry_at);
  const before = spawns.length;
  stopOverlay(j.id);
  assert.equal(job(j.id).next_retry_at, null);
  await sleep(150);
  assert.equal(spawns.length, before, 'cancelled retry never spawns');
});

test('no restart when gate off, profile opt-out, or intentional stop', async () => {
  // Gate off — clear the auto-restart setting row left by earlier armGates().
  disarmGates();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('overlay_enabled', '1')").run();
  const sid1 = seedStream('rs4a');
  const pid1 = seedProfile(sid1, 'rs4a');
  const j1 = await startOverlay(Number(pid1));
  liveProcs[liveProcs.length - 1].emit('exit', 1);
  assert.equal(job(j1.id).next_retry_at, null, 'global gate off -> no retry');

  // Gate on, profile opted out
  armGates();
  const sid2 = seedStream('rs4b');
  const pid2 = seedProfile(sid2, 'rs4b', 0);
  const j2 = await startOverlay(Number(pid2));
  liveProcs[liveProcs.length - 1].emit('exit', 1);
  assert.equal(job(j2.id).next_retry_at, null, 'profile auto_restart=0 -> no retry');

  // Intentional stop -> exit event must not schedule anything
  const sid3 = seedStream('rs4c');
  const pid3 = seedProfile(sid3, 'rs4c');
  const j3 = await startOverlay(Number(pid3));
  const proc = liveProcs[liveProcs.length - 1];
  stopOverlay(j3.id);
  proc.emit('exit', 143); // SIGTERM exit code arrives after 'stopped' was written
  assert.equal(job(j3.id).status, 'stopped');
  assert.equal(job(j3.id).next_retry_at, null);
});

test('stable-run crash resets the retry counter', async () => {
  armGates();
  process.env.OVERLAY_RESTART_STABLE_MS = '0'; // any uptime counts as stable
  const sid = seedStream('rs5');
  const pid = seedProfile(sid, 'rs5');
  const j = await startOverlay(Number(pid));
  liveProcs[liveProcs.length - 1].emit('exit', 1);
  // restart_count persisted as 1 but the NEXT crash (on the respawn) also
  // counts as attempt 1 because the worker ran "long enough".
  await sleep(150);
  const j2 = jobsFor(Number(pid)).at(-1)!;
  liveProcs[liveProcs.length - 1].emit('exit', 1);
  await sleep(150);
  const jobs = jobsFor(Number(pid));
  assert.equal(jobs.at(-1)!.restart_count, 1, 'stable respawn crash restarts budget at 1');
  assert.equal(jobs.length, 3, 'three attempts total (initial + 2 restarts)');
  process.env.OVERLAY_RESTART_STABLE_MS = '60000';
});

test('restart re-runs full validation — unsafe target aborts instead of spawning', async () => {
  armGates();
  const sid = seedStream('rs6');
  const pid = seedProfile(sid, 'rs6');
  const j = await startOverlay(Number(pid));
  liveProcs[liveProcs.length - 1].emit('exit', 1);
  assert.ok(job(j.id).next_retry_at);
  // Output becomes unsafe during backoff — restart must re-validate, not spawn.
  db.prepare('UPDATE overlay_profiles SET output_url = ? WHERE id = ?')
    .run('rtmp://fs.example/live/rs6', Number(pid)); // targets source stream's server+name
  const before = spawns.length;
  await sleep(150);
  assert.equal(spawns.length, before, 'unsafe output never respawns');
  const ev = db.prepare("SELECT detail FROM stream_events WHERE stream_id = ? AND detail LIKE '%aborted%'").get(sid) as any;
  assert.ok(ev, 'abort recorded to stream events');
});

test('boot recovery resumes a pending retry and restarts a stale running job', async () => {
  armGates();
  // Crash-during-backoff: exited job with retry still pending.
  const sid1 = seedStream('rs7a');
  const pid1 = seedProfile(sid1, 'rs7a');
  const jid = db.prepare(
    `INSERT INTO overlay_jobs (profile_id, stream_id, status, restart_count, next_retry_at)
     VALUES (?, ?, 'exited', 1, datetime('now', '-1 seconds'))`
  ).run(Number(pid1), sid1).lastInsertRowid;
  const before = spawns.length;
  recoverOverlayJobs();
  await sleep(150);
  assert.equal(spawns.length, before + 1, 'elapsed retry fired on boot');
  assert.equal(job(Number(jid)).next_retry_at, null);

  // Crash-during-run: stale 'running' job on an auto-restart profile.
  const sid2 = seedStream('rs7b');
  const pid2 = seedProfile(sid2, 'rs7b');
  db.prepare(`INSERT INTO overlay_jobs (profile_id, stream_id, status) VALUES (?, ?, 'running')`)
    .run(Number(pid2), sid2);
  recoverOverlayJobs();
  const stale = db.prepare("SELECT * FROM overlay_jobs WHERE profile_id = ? ORDER BY id DESC").get(Number(pid2)) as any;
  assert.equal(stale.status, 'exited');
  assert.ok(stale.next_retry_at, 'stale running job got a fresh backoff window');
});

test('stderr credentials are redacted from last_error and stream events', async () => {
  armGates();
  const sid = seedStream('rs8');
  const pid = seedProfile(sid, 'rs8');
  db.prepare('UPDATE overlay_profiles SET output_url = ? WHERE id = ?')
    .run('srt://user:secretpass@dest-rs8.example:9001', Number(pid));
  const j = await startOverlay(Number(pid));
  const proc = liveProcs[liveProcs.length - 1];
  proc.stderr.emit('data', 'Connection to srt://user:secretpass@dest-rs8.example:9001 failed\n');
  proc.emit('exit', 1);
  const row = job(j.id);
  assert.ok(!row.last_error.includes('secretpass'), 'last_error scrubbed');
  const ev = db.prepare("SELECT detail FROM stream_events WHERE stream_id = ? ORDER BY id DESC").get(sid) as any;
  assert.ok(!ev.detail.includes('secretpass'), 'event detail scrubbed');
});

test('redactCredsInText strips credentialed URLs inside arbitrary text', () => {
  const out = redactCredsInText('publish to rtmp://u:p@host:1935/app/x failed; also srt://tok@h:9');
  assert.equal(out, 'publish to rtmp://***@host:1935/app/x failed; also srt://***@h:9');
  assert.equal(redactCredsInText('no creds here'), 'no creds here');
});

test('manual attemptRestart is a no-op when the retry was cancelled', async () => {
  armGates();
  const sid = seedStream('rs9');
  const pid = seedProfile(sid, 'rs9');
  const jid = db.prepare(
    `INSERT INTO overlay_jobs (profile_id, stream_id, status, restart_count) VALUES (?, ?, 'exited', 1)`
  ).run(Number(pid), sid).lastInsertRowid;
  const before = spawns.length;
  await attemptRestart(Number(jid)); // next_retry_at never set -> cancelled
  assert.equal(spawns.length, before);
});
