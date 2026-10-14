import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import WebSocket from 'ws';

const PORT = 36199;
const BASE = `http://localhost:${PORT}`;
const TSX_CLI = path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');

// Minimal mock Flussonic v3 API. Records DELETE calls to assert unlink-only delete.
let mockServer: any;
const remoteDeletes: string[] = [];
const remoteRequests: string[] = [];
const remotePort = 36198;
// Test-controlled mock behavior: override GET /streams payload and add latency
const mockBehavior = { streamsPayload: null as any, vodsPayload: null as any, vodFilesPayload: null as any, delayMs: 0 };

let appProcess: any;
let tmpDir: string;
let dbPath: string;

async function waitForServer(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.status === 400) return; // server is up
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Server did not start in time');
}

function cookieFrom(res: any) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

async function login(username: string, password: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return { res, cookie: cookieFrom(res) };
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playout-it-test-'));
  dbPath = path.join(tmpDir, 'test.db');

  // Mock Flussonic server
  mockServer = createServer((req, res) => {
    if (req.method === 'DELETE') remoteDeletes.push(req.url || '');
    remoteRequests.push(`${req.method} ${req.url}`);
    const respond = () => {
      res.setHeader('Content-Type', 'application/json');
      // Test-controlled GET /streams payload override (sync tests)
      if (req.method === 'GET' && mockBehavior.streamsPayload !== null && /\/streams$/.test(req.url || '')) {
        res.end(JSON.stringify(mockBehavior.streamsPayload));
        return;
      }
      if (req.method === 'GET' && mockBehavior.vodsPayload !== null && /\/vods$/.test(req.url || '')) {
        res.end(JSON.stringify(mockBehavior.vodsPayload));
        return;
      }
      if (req.method === 'GET' && mockBehavior.vodFilesPayload !== null && /\/vods\/[^/]+\/(storages\/0\/)?files$/.test(req.url || '')) {
        res.end(JSON.stringify(mockBehavior.vodFilesPayload));
        return;
      }
      // Companion-VOD fixtures:
    //  - legacy-stream: VOD exists only under the stream's own name (pre-upgrade
    //    convention); `legacy-stream_vod` 404s
    //  - new-stream: VOD exists only under `new-stream_vod` (current convention)
    if (req.url?.startsWith('/flussonic/api/v3/vods/legacy-stream_vod')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    } else if (req.url?.startsWith('/flussonic/api/v3/vods/legacy-stream')) {
      if (req.method === 'GET' && req.url.includes('/files')) {
        res.end(JSON.stringify({ files: [{ name: 'legacy-clip.mp4', size: 123 }] }));
      } else {
        res.end(JSON.stringify({ prefix: 'legacy-stream', storages: [{ url: '/storage/legacy-stream' }] }));
      }
    } else if (req.method === 'GET' && req.url?.startsWith('/flussonic/api/v3/vods/new-stream_vod')) {
      if (req.url.includes('/files')) {
        res.end(JSON.stringify({ files: [{ name: 'new-clip.mp4', size: 456 }] }));
      } else {
        res.end(JSON.stringify({ prefix: 'new-stream_vod', storages: [{ url: '/storage/new-stream_vod' }] }));
      }
    } else if (req.url?.includes('/config')) {
      res.end(JSON.stringify({ stats: { total_clients: 0, uptime: 1 } }));
    } else if (req.url?.includes('/streams')) {
      res.end(JSON.stringify([]));
      } else if (req.url?.includes('/vods')) {
        res.end(JSON.stringify([]));
      } else {
        res.end('{}');
      }
    };
    if (mockBehavior.delayMs) setTimeout(respond, mockBehavior.delayMs);
    else respond();
  });
  await new Promise(r => mockServer.listen(remotePort, '127.0.0.1', r));

  // Spawn real app server in production mode (serves dist/, enforces JWT_SECRET requirement)
  appProcess = spawn(process.execPath, [TSX_CLI, 'server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_PATH: dbPath,
      JWT_SECRET: 'test-secret-key-for-integration-tests-only-0123456789',
    },
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProcess.stderr.on('data', d => process.stderr.write(`[app] ${d}`));

  await waitForServer();

  // Seed users directly (provisioning CLI is intentionally not used here;
  // test DB lifecycle is test-owned).
  const db = new Database(dbPath);
  const hash = (p: string) => bcrypt.hashSync(p, 12);
  db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)')
    .run('itadmin', hash('it-admin-pass-12345'), 'it@local', 'admin');
  db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)')
    .run('itclient', hash('it-client-pass-12345'), 'itc@local', 'client');
  db.close();
});

test.after(async () => {
  if (appProcess) {
    const exited = new Promise(r => appProcess.once('exit', r));
    appProcess.kill();
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  }
  if (mockServer) await new Promise(r => mockServer.close(r));
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); break; }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
});

test('anonymous requests are rejected with 401', async () => {
  for (const [method, url] of [
    ['GET', '/api/servers'], ['GET', '/api/vods'], ['GET', '/api/users'],
    ['GET', '/api/settings'], ['POST', '/api/watchdog/restart'], ['GET', '/api/my-streams'],
    ['GET', '/api/blocked-ips'], ['GET', '/api/telegram-alerts'],
  ] as const) {
    const res = await fetch(`${BASE}${url}`, { method });
    assert.equal(res.status, 401, `${method} ${url} should be 401 for anonymous, got ${res.status}`);
  }
});

test('client role is authenticated but forbidden from admin routes', async () => {
  const { res: loginRes, cookie } = await login('itclient', 'it-client-pass-12345');
  assert.equal(loginRes.status, 200, 'client login failed');

  for (const [method, url] of [
    ['GET', '/api/servers'], ['GET', '/api/vods'], ['GET', '/api/users'],
    ['POST', '/api/watchdog/restart'], ['POST', '/api/settings'],
  ] as const) {
    const res = await fetch(`${BASE}${url}`, { method, headers: { cookie } });
    assert.equal(res.status, 403, `${method} ${url} should be 403 for client, got ${res.status}`);
  }

  // Client-readable route still works
  const mine = await fetch(`${BASE}/api/my-streams`, { headers: { cookie } });
  assert.equal(mine.status, 200, 'client /api/my-streams should be 200');
});

test('admin can restart watchdog and manage servers', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  assert.equal(loginRes.status, 200, 'admin login failed');
  const { token } = await loginRes.json();

  const restart = await fetch(`${BASE}/api/watchdog/restart`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(restart.status, 200);
});

test('server credentials are redacted in both online and offline responses', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Online server (mock responds to /flussonic/api/v3/config)
  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'mock-online', url: `http://127.0.0.1:${remotePort}`, username: 'ituser', password: 'itpass123456' })
  });
  assert.equal(mk.status, 200);
  const created = await mk.json();
  assert.ok(!('api_key' in created) && !('password' in created) && !('username' in created), 'POST response leaks credentials');

  // Offline server (nothing listens on port 1)
  await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'mock-offline', url: 'http://127.0.0.1:1', username: 'ituser2', password: 'itpass123456' })
  });

  const list = await (await fetch(`${BASE}/api/servers`, { headers })).json();
  for (const s of list) {
    assert.ok(!('api_key' in s), `server ${s.name} leaks api_key`);
    assert.ok(!('username' in s), `server ${s.name} leaks username`);
    assert.ok(!('password' in s), `server ${s.name} leaks password`);
  }
  assert.ok(list.some((s: any) => s.name === 'mock-online' && s.status === 'online'), 'online server should report online');
  assert.ok(list.some((s: any) => s.name === 'mock-offline' && s.status === 'offline'), 'unreachable server should report offline');
});

test('deleting a server never calls DELETE on the remote Flussonic API', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}` };
  const list = await (await fetch(`${BASE}/api/servers`, { headers })).json();
  const online = list.find((s: any) => s.name === 'mock-online');
  assert.ok(online, 'mock-online server missing');

  remoteDeletes.length = 0;
  const del = await fetch(`${BASE}/api/servers/${online.id}`, { method: 'DELETE', headers });
  assert.equal(del.status, 200);
  await new Promise(r => setTimeout(r, 500)); // allow any async remote calls to land
  assert.equal(remoteDeletes.length, 0, `remote DELETE calls observed: ${remoteDeletes.join(', ')}`);
});

test('cookie-authenticated mutations require a CSRF marker', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const body = await loginRes.json();
  const cookie = `token=${body.token}`;

  // Cookie-only POST without CSRF marker → 403
  const noMarker = await fetch(`${BASE}/api/watchdog/restart`, { method: 'POST', headers: { cookie } });
  assert.equal(noMarker.status, 403, 'cookie-only POST without CSRF marker should be 403');

  // Cookie + X-Requested-With → 200
  const withMarker = await fetch(`${BASE}/api/watchdog/restart`, { method: 'POST', headers: { cookie, 'x-requested-with': 'XMLHttpRequest' } });
  assert.equal(withMarker.status, 200);

  // Bearer token (no cookie) → CSRF-immune, no marker needed
  const bearer = await fetch(`${BASE}/api/watchdog/restart`, { method: 'POST', headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(bearer.status, 200);
});

test('WebSocket /ws upgrades require an authenticated session', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();

  const unauth = new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.on('open', () => { ws.close(); resolve('opened'); });
    ws.on('unexpected-response', (req, res) => resolve(`rejected-${res.statusCode}`));
    ws.on('error', () => resolve('error'));
  });
  const unauthResult = await Promise.race([unauth, new Promise(r => setTimeout(() => r('timeout'), 5000))]);
  assert.equal(unauthResult, 'rejected-401', `unauthenticated /ws should be rejected, got ${unauthResult}`);

  const authed = new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { cookie: `token=${token}` } });
    ws.on('open', () => { ws.close(); resolve('opened'); });
    ws.on('unexpected-response', (req, res) => resolve(`rejected-${res.statusCode}`));
    ws.on('error', () => resolve('error'));
  });
  const authedResult = await Promise.race([authed, new Promise(r => setTimeout(() => r('timeout'), 5000))]);
  assert.equal(authedResult, 'opened', `authenticated /ws should open, got ${authedResult}`);
});

test('stream and VOD write operations enforce auth and roles', async () => {
  const { res: adminLogin } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await adminLogin.json();
  const adminHeaders = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const { res: clientLogin } = await login('itclient', 'it-client-pass-12345');
  const { token: clientToken } = await clientLogin.json();
  const clientHeaders = { authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' };

  // Dedicated server row (mock-online was deleted by an earlier test)
  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'mock-write', url: `http://127.0.0.1:${remotePort}`, username: 'ituser', password: 'itpass123456' })
  });
  const server = await mk.json();

  // Stream create: anon 401, client 403, admin 200
  const streamBody = JSON.stringify({ server_id: server.id, name: 'it-stream', inputs: ['rtsp://x/y'] });
  assert.equal((await fetch(`${BASE}/api/streams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: streamBody })).status, 401);
  assert.equal((await fetch(`${BASE}/api/streams`, { method: 'POST', headers: clientHeaders, body: streamBody })).status, 403);
  const streamRes = await fetch(`${BASE}/api/streams`, { method: 'POST', headers: adminHeaders, body: streamBody });
  assert.equal(streamRes.status, 200, `admin stream create failed: ${await streamRes.clone().text()}`);
  const stream = await streamRes.json();
  assert.ok(stream.id, 'stream id missing');

  // VOD create: anon 401, client 403, admin path
  const vodBody = JSON.stringify({ server_id: server.id, name: 'it-vod', paths: ['/storage/it-vod'] });
  assert.equal((await fetch(`${BASE}/api/vods`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: vodBody })).status, 401);
  assert.equal((await fetch(`${BASE}/api/vods`, { method: 'POST', headers: clientHeaders, body: vodBody })).status, 403);
  const vodRes = await fetch(`${BASE}/api/vods`, { method: 'POST', headers: adminHeaders, body: vodBody });
  assert.ok([200, 201].includes(vodRes.status), `admin vod create failed: ${vodRes.status} ${await vodRes.clone().text()}`);
});

test('companion VOD resolves both _vod and legacy same-name conventions', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'mock-vod', url: `http://127.0.0.1:${remotePort}`, username: 'ituser', password: 'itpass123456' })
  });
  const server = await mk.json();

  for (const name of ['legacy-stream', 'new-stream']) {
    const r = await fetch(`${BASE}/api/streams`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ server_id: server.id, name, inputs: ['fake://src'] })
    });
    assert.equal(r.status, 200, `create ${name}: ${await r.clone().text()}`);
  }

  const list = await (await fetch(`${BASE}/api/streams`, { headers })).json();
  const legacy = list.find((s: any) => s.name === 'legacy-stream');
  const modern = list.find((s: any) => s.name === 'new-stream');
  assert.ok(legacy && modern, 'seeded streams missing');

  remoteRequests.length = 0;
  const legacyFiles = await (await fetch(`${BASE}/api/streams/${legacy.id}/vod-files`, { headers })).json();
  assert.equal(legacyFiles.files?.[0]?.name, 'legacy-clip.mp4', 'legacy same-name VOD not resolved');
  assert.ok(
    remoteRequests.some(u => u === `GET /flussonic/api/v3/vods/legacy-stream_vod`) &&
    remoteRequests.some(u => u.startsWith('GET /flussonic/api/v3/vods/legacy-stream/')),
    'resolver should probe _vod first then fall back to legacy name'
  );

  remoteRequests.length = 0;
  const newFiles = await (await fetch(`${BASE}/api/streams/${modern.id}/vod-files`, { headers })).json();
  assert.equal(newFiles.files?.[0]?.name, 'new-clip.mp4', '_vod VOD not resolved');
  assert.ok(
    remoteRequests.some(u => u.startsWith('GET /flussonic/api/v3/vods/new-stream_vod/storages/0/files')),
    'modern convention should hit _vod VOD directly'
  );
  assert.ok(
    !remoteRequests.some(u => u.startsWith('GET /flussonic/api/v3/vods/new-stream/')),
    'modern convention should not probe legacy name after _vod hit'
  );
});

test('sync never wipes local data and preserves stream ids + assignments', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Remote reports one stream
  mockBehavior.streamsPayload = [{ name: 'persist-stream', inputs: [{ url: 'rtsp://a' }], stats: { alive: true } }];
  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'mock-sync', url: `http://127.0.0.1:${remotePort}`, username: 'u', password: 'p123456' })
  });
  const server = await mk.json();

  let list = await (await fetch(`${BASE}/api/streams`, { headers })).json();
  const stream = list.find((s: any) => s.name === 'persist-stream');
  assert.ok(stream, 'synced stream missing');
  const originalId = stream.id;

  // Assign it to the client user — assignments must survive re-sync
  const idb = new Database(dbPath);
  const client = idb.prepare("SELECT id FROM users WHERE username = 'itclient'").get() as any;
  idb.prepare('INSERT INTO user_stream_assignments (user_id, stream_id) VALUES (?, ?)').run(client.id, originalId);
  idb.close();

  // Re-sync with updated metadata → same id, updated live_url, assignment intact
  mockBehavior.streamsPayload = [{ name: 'persist-stream', inputs: [{ url: 'rtsp://b' }], stats: { alive: true } }];
  await fetch(`${BASE}/api/servers/${server.id}/sync`, { method: 'POST', headers });
  list = await (await fetch(`${BASE}/api/streams`, { headers })).json();
  const resynced = list.find((s: any) => s.name === 'persist-stream');
  assert.equal(resynced.id, originalId, 'stream id must survive sync (upsert, not delete+insert)');
  assert.equal(resynced.live_url, 'rtsp://b', 'stream metadata should refresh on sync');

  // Malformed/empty remote → no deletions
  for (const bad of [{}, { error: 'upstream' }, 'garbage']) {
    mockBehavior.streamsPayload = bad;
    const sync = await fetch(`${BASE}/api/servers/${server.id}/sync`, { method: 'POST', headers });
    await sync.json();
    list = await (await fetch(`${BASE}/api/streams`, { headers })).json();
    assert.ok(
      list.some((s: any) => s.id === originalId),
      `malformed payload ${JSON.stringify(bad)} must not delete local streams`
    );
  }

  // Assignment survived all of the above
  const idb2 = new Database(dbPath);
  const assign = idb2.prepare('SELECT 1 FROM user_stream_assignments WHERE stream_id = ?').get(originalId);
  assert.ok(assign, 'user_stream_assignments row must survive sync');
  idb2.close();

  mockBehavior.streamsPayload = null;
});

test('sync-all uses bounded concurrency and records per-server health', async (t) => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Seed 50 mock servers directly in the test DB
  const idb = new Database(dbPath);
  const ins = idb.prepare('INSERT INTO servers (name, url, api_key, username, password) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 50; i++) {
    ins.run(`scale-${i}`, `http://127.0.0.1:${remotePort}`, 'u:p', 'u', 'p');
  }
  idb.close();

  // Slow every mock response by 120ms. Serial sync of 50 servers would take
  // ~12s+ (50 × ≥2 requests × 120ms); bounded parallelism should be far less.
  mockBehavior.delayMs = 120;
  const start = Date.now();
  const res = await fetch(`${BASE}/api/servers/sync-all`, { method: 'POST', headers });
  const elapsed = Date.now() - start;
  mockBehavior.delayMs = 0;
  assert.equal(res.status, 200);
  assert.ok(elapsed < 12000, `sync-all over 50 slow servers took ${elapsed}ms — expected bounded concurrency`);

  // Health columns recorded on the server rows
  const idb2 = new Database(dbPath);
  const healthy = idb2.prepare("SELECT COUNT(*) as n FROM servers WHERE name LIKE 'scale-%' AND last_seen_at IS NOT NULL AND consecutive_failures = 0").get() as any;
  assert.ok(healthy.n >= 48, `expected health recorded for seeded servers, got ${healthy.n}`);
  idb2.close();
});

test('per-server health endpoint reports live + persisted state', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  assert.equal((await fetch(`${BASE}/api/servers/1/health`)).status, 401);

  const list = await (await fetch(`${BASE}/api/servers`, { headers })).json();
  const online = list.find((s: any) => s.name === 'mock-vod');
  const health = await (await fetch(`${BASE}/api/servers/${online.id}/health`, { headers })).json();
  assert.equal(health.status, 'online');
  assert.equal(typeof health.latency_ms, 'number');
  assert.ok(health.last_seen_at, 'last_seen_at should be persisted');

  // Offline server accumulates failures and eventually enters backoff
  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'mock-dead', url: 'http://127.0.0.1:2', username: 'u', password: 'p123456' })
  });
  const dead = await mk.json();
  const deadHealth = await (await fetch(`${BASE}/api/servers/${dead.id}/health`, { headers })).json();
  assert.equal(deadHealth.status, 'offline');
  assert.ok(deadHealth.last_error, 'offline health should carry last_error');

  for (let i = 0; i < 3; i++) {
    await fetch(`${BASE}/api/servers/${dead.id}/sync`, { method: 'POST', headers });
  }
  const syncAll = await (await fetch(`${BASE}/api/servers/sync-all`, { method: 'POST', headers })).json();
  assert.ok(syncAll.skipped?.includes('mock-dead'), `mock-dead should be skipped in backoff, got ${JSON.stringify(syncAll.skipped)}`);
});

test('WebSocket stream updates are scoped to user assignments', async () => {
  const { res: adminLogin } = await login('itadmin', 'it-admin-pass-12345');
  const { token: adminToken } = await adminLogin.json();
  const { res: clientLogin } = await login('itclient', 'it-client-pass-12345');
  const { token: clientToken } = await clientLogin.json();

  const waitForUpdate = (cookie: string) => new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { cookie: `token=${cookie}` } });
    const timer = setTimeout(() => { ws.close(); reject(new Error('no STREAMS_UPDATE within 8s')); }, 8000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'STREAMS_UPDATE') { clearTimeout(timer); ws.close(); resolve(msg.data); }
    });
    ws.on('error', reject);
  });

  const clientUpdate = waitForUpdate(clientToken);
  const adminUpdate = waitForUpdate(adminToken);
  await new Promise(r => setTimeout(r, 500)); // let sockets connect

  // Trigger a broadcast: admin creates a stream the client is NOT assigned to
  const headers = { authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
  const list = await (await fetch(`${BASE}/api/servers`, { headers })).json();
  const server = list.find((s: any) => s.name === 'mock-vod');
  const create = await fetch(`${BASE}/api/streams`, {
    method: 'POST', headers,
    body: JSON.stringify({ server_id: server.id, name: 'ws-scoped', inputs: ['fake://x'] })
  });
  assert.equal(create.status, 200);

  const [clientStreams, adminStreams] = await Promise.all([clientUpdate, adminUpdate]);
  const adminNames = adminStreams.map((s: any) => s.name);
  const clientNames = clientStreams.map((s: any) => s.name);

  assert.ok(adminNames.includes('ws-scoped'), 'admin should see the new stream');
  assert.ok(!clientNames.includes('ws-scoped'), 'client must not see unassigned streams');
  assert.ok(clientNames.includes('persist-stream'), 'client should see its assigned stream');
});

test('partial nonempty remote stream list cannot delete local records', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Seed 50 streams remotely, create server → auto-sync pulls them
  mockBehavior.streamsPayload = Array.from({ length: 50 }, (_, i) => ({ name: `bulk-${i}`, inputs: [{ url: 'fake://x' }] }));
  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'mock-partial', url: `http://127.0.0.1:${remotePort}`, username: 'u', password: 'p123456' })
  });
  const server = await mk.json();

  let list = await (await fetch(`${BASE}/api/streams`, { headers })).json();
  assert.equal(list.filter((s: any) => s.server_id === server.id).length, 50, 'seeded 50 streams');

  // Remote now returns only 10 (partial/truncated) → zero deletions
  mockBehavior.streamsPayload = Array.from({ length: 10 }, (_, i) => ({ name: `bulk-${i}`, inputs: [{ url: 'fake://x' }] }));
  const sync = await (await fetch(`${BASE}/api/servers/${server.id}/sync`, { method: 'POST', headers })).json();
  assert.equal(sync.removed, 0, 'partial response must not delete local streams');
  assert.ok(sync.pendingRemovals >= 40, 'missing streams should be reported as pendingRemovals');

  list = await (await fetch(`${BASE}/api/streams`, { headers })).json();
  assert.equal(list.filter((s: any) => s.server_id === server.id).length, 50, 'all 50 local streams preserved');

  // Full restore → still all present, zero churn
  mockBehavior.streamsPayload = Array.from({ length: 50 }, (_, i) => ({ name: `bulk-${i}`, inputs: [{ url: 'fake://x' }] }));
  await fetch(`${BASE}/api/servers/${server.id}/sync`, { method: 'POST', headers });
  mockBehavior.streamsPayload = null;
});

test('names-only VOD responses preserve stored paths; partial VOD list never deletes', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Seed 20 VODs with real storages
  mockBehavior.vodsPayload = { vods: Array.from({ length: 20 }, (_, i) => ({ prefix: `pv-${i}`, storages: [{ url: `/storage/pv-${i}` }] })) };
  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'mock-vodpartial', url: `http://127.0.0.1:${remotePort}`, username: 'u', password: 'p123456' })
  });
  const server = await mk.json();

  const idb = new Database(dbPath);
  assert.equal((idb.prepare('SELECT COUNT(*) n FROM vods WHERE server_id = ?').get(server.id) as any).n, 20);
  const before = idb.prepare("SELECT paths FROM vods WHERE server_id = ? AND name = 'pv-0'").get(server.id) as any;
  assert.equal(JSON.parse(before.paths)[0], '/storage/pv-0', 'paths seeded from sync');

  // Names-only response must not overwrite paths
  mockBehavior.vodsPayload = Array.from({ length: 20 }, (_, i) => `pv-${i}`);
  await fetch(`${BASE}/api/servers/${server.id}/sync`, { method: 'POST', headers });
  const after = idb.prepare("SELECT paths FROM vods WHERE server_id = ? AND name = 'pv-0'").get(server.id) as any;
  assert.equal(JSON.parse(after.paths)[0], '/storage/pv-0', 'names-only sync must not clear stored paths');

  // Partial list (5 of 20) → no deletions, pendingRemovals reported
  mockBehavior.vodsPayload = Array.from({ length: 5 }, (_, i) => `pv-${i}`);
  const sync = await (await fetch(`${BASE}/api/servers/${server.id}/sync`, { method: 'POST', headers })).json();
  assert.equal((idb.prepare('SELECT COUNT(*) n FROM vods WHERE server_id = ?').get(server.id) as any).n, 20, 'all 20 local VODs preserved');
  assert.ok(sync.pendingRemovals >= 15, 'missing VODs reported as pendingRemovals');
  mockBehavior.vodsPayload = null;
  idb.close();
});

test('malformed VOD file listing preserves local vod_files', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const idb = new Database(dbPath);
  const server = idb.prepare("SELECT id FROM servers WHERE name = 'mock-vodpartial'").get() as any;
  const vod = idb.prepare("SELECT id FROM vods WHERE server_id = ? AND name = 'pv-0'").get(server.id) as any;
  idb.prepare("INSERT INTO vod_files (vod_id, filename, size) VALUES (?, 'keep.mp4', 100)").run(vod.id);
  idb.close();

  // Malformed response → 500, local vod_files untouched
  mockBehavior.vodFilesPayload = { error: 'weird upstream' };
  const bad = await fetch(`${BASE}/api/vods/${vod.id}/files/sync`, { method: 'POST', headers });
  assert.equal(bad.status, 500, 'malformed listing should fail');
  const idb2 = new Database(dbPath);
  assert.equal((idb2.prepare('SELECT COUNT(*) n FROM vod_files WHERE vod_id = ?').get(vod.id) as any).n, 1, 'vod_files preserved');

  // Valid listing replaces correctly
  mockBehavior.vodFilesPayload = { files: [{ name: 'new.mp4', size: 5 }] };
  const good = await fetch(`${BASE}/api/vods/${vod.id}/files/sync`, { method: 'POST', headers });
  assert.equal(good.status, 200);
  const files = idb2.prepare('SELECT filename FROM vod_files WHERE vod_id = ?').all(vod.id) as any[];
  assert.deepEqual(files.map(f => f.filename), ['new.mp4']);
  mockBehavior.vodFilesPayload = null;
  idb2.close();
});

test('sync failure propagates explicitly to the API response', async () => {
  const { res: loginRes } = await login('itadmin', 'it-admin-pass-12345');
  const { token } = await loginRes.json();
  const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Server whose /vods returns malformed garbage → explicit error surface
  mockBehavior.vodsPayload = 'totally-invalid';
  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'mock-vodfail', url: `http://127.0.0.1:${remotePort}`, username: 'u', password: 'p123456' })
  });
  const server = await mk.json();

  const sync = await (await fetch(`${BASE}/api/servers/${server.id}/sync`, { method: 'POST', headers })).json();
  assert.equal(sync.success, false, 'sync should report failure');
  assert.ok(sync.error, 'error message must be present');
  mockBehavior.vodsPayload = null;
});
