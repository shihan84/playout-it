import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const PORT = 36199;
const BASE = `http://localhost:${PORT}`;
const TSX_CLI = path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');

// Minimal mock Flussonic v3 API. Records DELETE calls to assert unlink-only delete.
let mockServer: any;
const remoteDeletes: string[] = [];
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
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/config')) {
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
  const { res: loginRes, cookie } = await login('itadmin', 'it-admin-pass-12345');
  assert.equal(loginRes.status, 200, 'admin login failed');

  const restart = await fetch(`${BASE}/api/watchdog/restart`, { method: 'POST', headers: { cookie } });
  assert.equal(restart.status, 200);
});

test('server credentials are redacted in both online and offline responses', async () => {
  const { cookie } = await login('itadmin', 'it-admin-pass-12345');

  // Online server (mock responds to /flussonic/api/v3/config)
  const mk = await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'mock-online', url: `http://127.0.0.1:${remotePort}`, username: 'ituser', password: 'itpass123456' })
  });
  assert.equal(mk.status, 200);
  const created = await mk.json();
  assert.ok(!('api_key' in created) && !('password' in created) && !('username' in created), 'POST response leaks credentials');

  // Offline server (nothing listens on port 1)
  await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'mock-offline', url: 'http://127.0.0.1:1', username: 'ituser2', password: 'itpass123456' })
  });

  const list = await (await fetch(`${BASE}/api/servers`, { headers: { cookie } })).json();
  for (const s of list) {
    assert.ok(!('api_key' in s), `server ${s.name} leaks api_key`);
    assert.ok(!('username' in s), `server ${s.name} leaks username`);
    assert.ok(!('password' in s), `server ${s.name} leaks password`);
  }
  assert.ok(list.some((s: any) => s.name === 'mock-online' && s.status === 'online'), 'online server should report online');
  assert.ok(list.some((s: any) => s.name === 'mock-offline' && s.status === 'offline'), 'unreachable server should report offline');
});

test('deleting a server never calls DELETE on the remote Flussonic API', async () => {
  const { cookie } = await login('itadmin', 'it-admin-pass-12345');
  const list = await (await fetch(`${BASE}/api/servers`, { headers: { cookie } })).json();
  const online = list.find((s: any) => s.name === 'mock-online');
  assert.ok(online, 'mock-online server missing');

  remoteDeletes.length = 0;
  const del = await fetch(`${BASE}/api/servers/${online.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(del.status, 200);
  await new Promise(r => setTimeout(r, 500)); // allow any async remote calls to land
  assert.equal(remoteDeletes.length, 0, `remote DELETE calls observed: ${remoteDeletes.join(', ')}`);
});
