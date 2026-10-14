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

let appProcess: any;
let tmpDir: string;

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
  const dbPath = path.join(tmpDir, 'test.db');

  // Mock Flussonic server
  mockServer = createServer((req, res) => {
    if (req.method === 'DELETE') remoteDeletes.push(req.url || '');
    remoteRequests.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
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
