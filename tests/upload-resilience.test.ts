// Upload resilience: retry/auth-fallback bodies, stream cleanup, temp-file cleanup, DELETE encoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-probe-'));
process.env.DATABASE_PATH = path.join(scratchDir, 'unit.db');
const SIZE = 300_000;
const bodyFile = path.join(scratchDir, 'body.bin');
fs.writeFileSync(bodyFile, Buffer.alloc(SIZE, 9));
const BIG = path.join(scratchDir, 'big.bin');
fs.writeFileSync(BIG, Buffer.alloc(20 * 1024 * 1024, 1));

type Act = 'ok' | 401 | 403 | 400 | 404 | 500 | 'reset' | 'early413' | 'early401';
async function mockWith(actions: Act[]) {
  const seen: { auth: string; bytes: number; url: string; method: string }[] = [];
  let i = 0;
  const srv = createServer((rq, rs) => {
    const act = actions[i++] ?? 'ok';
    if (act === 'reset') { rq.socket.destroy(); seen.push({ auth: rq.headers.authorization || '', bytes: -1, url: rq.url!, method: rq.method! }); return; }
    if (act === 'early413' || act === 'early401') {
      seen.push({ auth: rq.headers.authorization || '', bytes: -2, url: rq.url!, method: rq.method! });
      rs.statusCode = act === 'early413' ? 413 : 401; rs.setHeader('Connection', 'close'); rs.end('{}'); return;
    }
    let n = 0;
    rq.on('data', (c) => (n += c.length));
    rq.on('end', () => {
      seen.push({ auth: rq.headers.authorization || '', bytes: n, url: rq.url!, method: rq.method! });
      rs.statusCode = act === 'ok' ? 200 : act;
      rs.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, seen, url: `http://127.0.0.1:${(srv.address() as any).port}/x` };
}
const settle = () => new Promise((r) => setTimeout(r, 100));

let dbLoaded = false;
async function run(actions: Act[], server: any, file = bodyFile) {
  dbLoaded = true;
  const { flussonicRequest } = await import('../src/server/services/flussonic');
  const m = await mockWith(actions);
  const streams: fs.ReadStream[] = [];
  let err: any = null;
  try {
    await flussonicRequest('PUT', m.url, server, () => { const s = fs.createReadStream(file); streams.push(s); return s; }, 30000);
  } catch (e) { err = e; }
  await settle();
  m.srv.close();
  return { err, seen: m.seen, streams };
}
const API_ONLY = { api_key: 'key' };
const CREDS = { username: 'u', password: 'p' };
const allClosed = (ss: fs.ReadStream[]) => ss.length > 0 && ss.every((s) => s.destroyed && (s as any).closed);

for (const code of [401, 403] as const) {
  test(`legacy fallback after ${code}: fresh full body, admin:<key> header, all streams closed`, async () => {
    const r = await run([code, 'ok'], API_ONLY);
    assert.equal(r.err, null);
    assert.deepEqual(r.seen.map((s) => s.bytes), [SIZE, SIZE]);
    assert.equal(r.seen[0].auth, 'Basic ' + Buffer.from('flussonic:key').toString('base64'));
    assert.equal(r.seen[1].auth, 'Basic ' + Buffer.from('admin:key').toString('base64'));
    assert.equal(r.streams.length, 2); assert.ok(allClosed(r.streams));
  });
}
test('explicit creds + 401: no legacy retry, error, stream closed', async () => {
  const r = await run([401], CREDS);
  assert.equal(r.err?.response?.status, 401); assert.equal(r.seen.length, 1); assert.ok(allClosed(r.streams));
});
test('5xx then ok: retried with fresh full body', async () => {
  const r = await run([500, 'ok'], CREDS);
  assert.equal(r.err, null); assert.deepEqual(r.seen.map((s) => s.bytes), [SIZE, SIZE]); assert.equal(r.streams.length, 2); assert.ok(allClosed(r.streams));
});
test('5xx twice: throws after 1 retry, all streams closed', async () => {
  const r = await run([500, 500, 'ok'], CREDS);
  assert.equal(r.err?.response?.status, 500); assert.equal(r.seen.length, 2); assert.ok(allClosed(r.streams));
});
test('network reset then ok: retried with fresh full body', async () => {
  const r = await run(['reset', 'ok'], CREDS);
  assert.equal(r.err, null); assert.equal(r.seen.at(-1)!.bytes, SIZE); assert.equal(r.streams.length, 2); assert.ok(allClosed(r.streams));
});
test('4xx (400): no retry, stream closed', async () => {
  const r = await run([400, 'ok'], CREDS);
  assert.equal(r.err?.response?.status, 400); assert.equal(r.seen.length, 1); assert.ok(allClosed(r.streams));
});
test('success: stream closed', async () => {
  const r = await run(['ok'], CREDS);
  assert.equal(r.err, null); assert.ok(allClosed(r.streams));
});
test('early 413 response on 20MB body (no read): rejects, every stream closed', async () => {
  const r = await run(['early413', 'early413', 'early413'], CREDS, BIG);
  assert.ok(r.err, 'expected rejection'); assert.ok(allClosed(r.streams), `streams=${r.streams.length}`);
});
test('early 401 on api-key server (20MB): legacy retry gets fresh full body', async () => {
  const r = await run(['early401', 'ok'], API_ONLY, BIG);
  assert.ok(allClosed(r.streams));
  if (!r.err) assert.equal(r.seen.at(-1)!.bytes, 20 * 1024 * 1024);
});
test('non-stream JSON body still works with retries', async () => {
  dbLoaded = true;
  const { flussonicRequest } = await import('../src/server/services/flussonic');
  const m = await mockWith([500, 'ok']);
  await flussonicRequest('PUT', m.url, CREDS, { a: 1 });
  m.srv.close();
  assert.deepEqual(m.seen.map((s) => s.bytes), [7, 7]);
});

// ---------- integration: real app, isolated TMPDIR, scripted mock Flussonic ----------
const PORT = 36520, MOCK_PORT = 36521, BASE = `http://127.0.0.1:${PORT}`;
const appTmp = path.join(scratchDir, 'apptmp'); fs.mkdirSync(appTmp);
let app: any, auth: Record<string, string>, streamId: any, vodId: any;
let putPlan: Act[] = [];
const flog: { method: string; url: string; bytes: number }[] = [];
let mock: any;
const leftovers = () => fs.readdirSync(appTmp).filter((f) => /^[a-f0-9]{32}$/.test(f) || /^(upload|final)_/.test(f));

function form(field: string, data: Buffer, filename = 'clip.mp4', extra: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  f.append(field, new Blob([data], { type: 'video/mp4' }), filename);
  return f;
}

test.before(async () => {
  mock = createServer((rq, rs) => {
    const isFilePut = rq.method === 'PUT' && rq.url!.includes('/files/');
    const act: Act = isFilePut ? (putPlan.shift() ?? 'ok') : 'ok';
    if (act === 'early413') { flog.push({ method: rq.method!, url: rq.url!, bytes: -2 }); rs.statusCode = 413; rs.setHeader('Connection', 'close'); rs.end('{}'); return; }
    let n = 0;
    rq.on('data', (c) => (n += c.length));
    rq.on('end', () => {
      flog.push({ method: rq.method!, url: rq.url!, bytes: n });
      rs.statusCode = act === 'ok' ? 200 : (act as number);
      rs.setHeader('Content-Type', 'application/json');
      rs.end(rq.method === 'GET' && /\/(streams|vods)$/.test(rq.url!) ? '[]' : '{}');
    });
  });
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));
  const dbPath = path.join(scratchDir, 'app.db');
  app = spawn(process.execPath, [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), 'server.ts'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATABASE_PATH: dbPath, TMPDIR: appTmp, TEMP: appTmp, TMP: appTmp,
      JWT_SECRET: 'test-secret-key-for-integration-tests-only-0123456789' },
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', () => {}); app.stderr.on('data', () => {});
  const start = Date.now();
  for (;;) {
    try { if ((await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 400) break; } catch {}
    if (Date.now() - start > 30000) throw new Error('app did not start');
    await new Promise((r) => setTimeout(r, 500));
  }
  const db = new Database(dbPath);
  db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)').run('rv', bcrypt.hashSync('review-admin-pass-12345', 10), 'r@l', 'admin');
  db.close();
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rv', password: 'review-admin-pass-12345' }) })).json();
  auth = { authorization: `Bearer ${login.token}` };
  const srv = await (await fetch(`${BASE}/api/servers`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'mock', url: `http://127.0.0.1:${MOCK_PORT}`, username: 'u', password: 'mockpass123456' }) })).json();
  const db2 = new Database(dbPath);
  streamId = db2.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (?, ?, ?, ?)').run(srv.id, 'rv-stream', 'x', 'x').lastInsertRowid;
  vodId = db2.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)').run(srv.id, 'rv-vod', '["/tmp"]').lastInsertRowid;
  db2.prepare('INSERT INTO videos (stream_id, filename, size) VALUES (?, ?, ?)').run(streamId, 'x y.mp4?a=1#f', 1);
  db2.prepare('INSERT INTO vod_files (vod_id, filename, size) VALUES (?, ?, ?)').run(vodId, 'x y.mp4?a=1#f', 1);
  db2.close();
});
test.after(async () => {
  if (app) { const ex = new Promise((r) => app.once('exit', r)); app.kill(); await Promise.race([ex, new Promise((r) => setTimeout(r, 5000))]); }
  mock?.close();
  if (dbLoaded) (await import('../src/server/db')).db.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

const S = () => `/api/streams/${streamId}/videos`, V = () => `/api/vods/${vodId}/files`;
for (const [label, plan, expect] of [
  ['Flussonic 500 twice', [500, 500] as Act[], 500],
  ['Flussonic 500 then ok (retry)', [500] as Act[], 200],
  ['Flussonic early 413 (20MB)', ['early413', 'early413'] as Act[], 500],
] as const) {
  for (const [route, field] of [['stream', 'video'], ['vod', 'file']] as const) {
    test(`${route} upload, ${label}: HTTP ${expect}, temp file removed`, async () => {
      putPlan = [...plan]; flog.length = 0;
      const big = label.includes('20MB');
      const data = big ? fs.readFileSync(BIG) : Buffer.alloc(SIZE, 3);
      const r = await fetch(BASE + (route === 'stream' ? S() : V()), { method: 'POST', headers: auth, body: form(field, data) });
      assert.equal(r.status, expect);
      await settle();
      assert.deepEqual(leftovers(), []);
      const puts = flog.filter((f) => f.method === 'PUT' && f.url.endsWith('/files/clip.mp4'));
      if (expect === 200) assert.ok(puts.every((p) => p.bytes === SIZE), JSON.stringify(puts));
    });
  }
}
test('stream upload: 404 -> create VOD -> re-upload sends fresh full body', async () => {
  putPlan = [404]; flog.length = 0;
  const r = await fetch(BASE + S(), { method: 'POST', headers: auth, body: form('video', Buffer.alloc(SIZE, 4)) });
  assert.equal(r.status, 200);
  const puts = flog.filter((f) => f.method === 'PUT' && f.url.endsWith('/files/clip.mp4'));
  assert.deepEqual(puts.map((p) => p.bytes), [SIZE, SIZE]);
  assert.deepEqual(leftovers(), []);
});
test('chunked complete with Flussonic 500: chunk dir and final file removed', async () => {
  putPlan = [500, 500];
  const init = await (await fetch(`${BASE}${V()}/init-chunked`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'c d.mp4', totalChunks: 1 }) })).json();
  assert.equal((await fetch(`${BASE}${V()}/chunk`, { method: 'POST', headers: auth, body: form('chunk', Buffer.alloc(1000, 2), 'c', { uploadId: init.uploadId, chunkIndex: '0' }) })).status, 200);
  const c = await fetch(`${BASE}${V()}/complete-chunked`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: init.uploadId, filename: 'c d.mp4', totalChunks: 1, size: 1000 }) });
  assert.equal(c.status, 500);
  await settle();
  assert.deepEqual(leftovers(), []);
});
for (const [route, field] of [['stream', 'video'], ['vod', 'file'], ['chunk', 'chunk']] as const) {
  test(`${route}: client aborts mid-upload -> no temp file left, server still serves`, async () => {
    const url = route === 'stream' ? S() : route === 'vod' ? V() : `${V()}/chunk`;
    await new Promise<void>((resolve) => {
      const rq = request(BASE + url, { method: 'POST', headers: { ...auth, 'content-type': 'multipart/form-data; boundary=BB', 'content-length': String(50 * 1024 * 1024) } });
      rq.on('error', () => resolve());
      rq.write(`--BB\r\nContent-Disposition: form-data; name="${field}"; filename="a.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
      rq.write(Buffer.alloc(2 * 1024 * 1024, 5), () => setTimeout(() => { rq.destroy(); resolve(); }, 300));
    });
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(leftovers(), []);
    assert.equal((await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  });
}
test('DELETE routes encode filename as a single path segment', async () => {
  flog.length = 0;
  const name = 'x y.mp4?a=1#f';
  assert.equal((await fetch(`${BASE}${S().replace('/videos', '')}/videos/${encodeURIComponent(name)}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal((await fetch(`${BASE}${V()}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: auth })).status, 200);
  const dels = flog.filter((f) => f.method === 'DELETE').map((f) => f.url);
  assert.equal(dels.filter((u) => u.endsWith(`/files/${encodeURIComponent(name)}`)).length, 2, JSON.stringify(dels));
});
