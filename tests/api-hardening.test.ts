import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { createRateLimiter } from '../src/server/middleware/rateLimit';

const PORT = 36210;
const BASE = `http://localhost:${PORT}`;
const TSX_CLI = path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');

let appProcess: any;
let tmpDir: string;
let dbPath: string;

async function waitForServer(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (r.status === 400) return;
      if (r.status === 429) await new Promise(r => setTimeout(r, 500));
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Server did not start in time');
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-test-'));
  dbPath = path.join(tmpDir, 'test.db');

  appProcess = spawn(process.execPath, [TSX_CLI, 'server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_PATH: dbPath,
      JWT_SECRET: 'test-secret-key-for-integration-tests-only-0123456789',
      // Low limit so the real-app 429 test is cheap; ordering budget respected below.
      AUTH_RATE_LIMIT_MAX: '6',
      AUTH_RATE_LIMIT_WINDOW_MS: '60000',
    },
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProcess.stderr.on('data', (d: any) => process.stderr.write(`[app] ${d}`));
  appProcess.on('exit', (code: any) => process.stderr.write(`[app] exited with code ${code}\n`));

  await waitForServer();

  const db = new Database(dbPath);
  const hash = (p: string) => bcrypt.hashSync(p, 12);
  db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)')
    .run('hardadmin', hash('hard-admin-pass-12345'), 'h@local', 'admin');
  db.close();
});

test.after(async () => {
  if (appProcess) {
    const exited = new Promise(r => appProcess.once('exit', r));
    appProcess.kill();
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- In-process limiter tests (isolated express app, no real server) ----

async function postJson(port: number, pathName: string, headers: Record<string, string> = {}) {
  return fetch(`http://localhost:${port}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{}',
  });
}

function startScratchApp(configure: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  configure(app);
  return new Promise<any>(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('rate limiter returns 429 after limit, with rate-limit headers', async () => {
  const srv = await startScratchApp((app) => {
    app.post('/login', createRateLimiter({ windowMs: 60000, max: 2 }), (_req, res) => res.json({ ok: true }));
  });
  try {
    const port = srv.address().port;
    assert.equal((await postJson(port, '/login')).status, 200);
    assert.equal((await postJson(port, '/login')).status, 200);
    const limited = await postJson(port, '/login');
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('ratelimit') !== null, 'expected RateLimit response headers');
    const body: any = await limited.json();
    assert.ok(body.error.length > 0);
  } finally {
    srv.close();
  }
});

test('rate limiter isolates counts between clients', async () => {
  const srv = await startScratchApp((app) => {
    app.set('trust proxy', 1); // one trusted hop -> XFF[0] is the client key
    app.post('/login', createRateLimiter({ windowMs: 60000, max: 2 }), (_req, res) => res.json({ ok: true }));
  });
  try {
    const port = srv.address().port;
    const ipA = { 'x-forwarded-for': '203.0.113.10' };
    const ipB = { 'x-forwarded-for': '203.0.113.20' };
    assert.equal((await postJson(port, '/login', ipA)).status, 200);
    assert.equal((await postJson(port, '/login', ipA)).status, 200);
    assert.equal((await postJson(port, '/login', ipA)).status, 429); // A exhausted
    assert.equal((await postJson(port, '/login', ipB)).status, 200); // B unaffected
  } finally {
    srv.close();
  }
});

test('rate-limit window expires — no permanent lockout', async () => {
  const srv = await startScratchApp((app) => {
    app.post('/login', createRateLimiter({ windowMs: 300, max: 1 }), (_req, res) => res.json({ ok: true }));
  });
  try {
    const port = srv.address().port;
    assert.equal((await postJson(port, '/login')).status, 200);
    assert.equal((await postJson(port, '/login')).status, 429);
    await new Promise(r => setTimeout(r, 400)); // let the 300ms window lapse
    assert.equal((await postJson(port, '/login')).status, 200);
  } finally {
    srv.close();
  }
});

test('multiple users behind one proxy share a bucket when proxy is untrusted', async () => {
  const srv = await startScratchApp((app) => {
    // No trust proxy: NATed/proxied clients collapse to the proxy's IP.
    app.post('/login', createRateLimiter({ windowMs: 60000, max: 2 }), (_req, res) => res.json({ ok: true }));
  });
  try {
    const port = srv.address().port;
    assert.equal((await postJson(port, '/login', { 'x-forwarded-for': '10.0.0.1' })).status, 200);
    assert.equal((await postJson(port, '/login', { 'x-forwarded-for': '10.0.0.2' })).status, 200);
    // Third distinct "user" behind the same peer IP is still limited.
    assert.equal((await postJson(port, '/login', { 'x-forwarded-for': '10.0.0.3' })).status, 429);
  } finally {
    srv.close();
  }
});

test('spoofed X-Forwarded-For cannot bypass the limit when proxy is not trusted', async () => {
  const srv = await startScratchApp((app) => {
    // No `trust proxy` -> XFF ignored, key is the socket peer.
    app.post('/login', createRateLimiter({ windowMs: 60000, max: 2 }), (_req, res) => res.json({ ok: true }));
  });
  try {
    const port = srv.address().port;
    assert.equal((await postJson(port, '/login', { 'x-forwarded-for': '1.1.1.1' })).status, 200);
    assert.equal((await postJson(port, '/login', { 'x-forwarded-for': '2.2.2.2' })).status, 200);
    assert.equal((await postJson(port, '/login', { 'x-forwarded-for': '3.3.3.3' })).status, 429);
  } finally {
    srv.close();
  }
});

// ---- Real-app integration tests (spawned server) ----

function loginBody(username: string, password: string, extraHeaders: Record<string, string> = {}) {
  return fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ username, password }),
  });
}

test('login succeeds with valid credentials; invalid creds and unknown user get identical 401 (no enumeration)', async () => {
  const ok = await loginBody('hardadmin', 'hard-admin-pass-12345');
  assert.equal(ok.status, 200);
  const okBody: any = await ok.json();
  assert.ok(okBody.token);
  assert.equal(okBody.user.role, 'admin');

  const badPass = await loginBody('hardadmin', 'wrong-password');
  assert.equal(badPass.status, 401);
  const badBody: any = await badPass.json();

  const noUser = await loginBody('nosuchuser', 'whatever');
  assert.equal(noUser.status, 401);
  const noUserBody: any = await noUser.json();
  assert.equal(badBody.error, noUserBody.error, 'error message must not reveal account existence');
});

test('malformed JSON returns 400, not 500', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(res.status, 400);
});

test('oversized JSON to /api/auth returns 413', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'x'.repeat(10 * 1024), password: 'y' }),
  });
  assert.equal(res.status, 413);
});

test('real app enforces auth rate limit (429) and ignores spoofed X-Forwarded-For', async () => {
  // Limit is 6/min; earlier tests consumed ~4 login attempts. Burn through
  // the remainder while rotating XFF — if XFF were trusted each request would
  // be a fresh bucket and we could never reach 429.
  let saw429 = false;
  for (let i = 0; i < 10; i++) {
    const res = await loginBody('nosuchuser', 'x', { 'x-forwarded-for': `198.51.100.${i + 1}` });
    if (res.status === 429) { saw429 = true; break; }
    assert.equal(res.status, 401);
  }
  assert.ok(saw429, 'expected 429 after exceeding AUTH_RATE_LIMIT_MAX');
});

// The rate-limit test above exhausts the bucket; give this one a fresh identity
// via bearer auth (Authorization bypasses the login endpoint anyway).
test('oversized JSON to non-auth endpoints returns 413 (5MB default cap)', async () => {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-token' },
    body: JSON.stringify({ data: 'x'.repeat(6 * 1024 * 1024) }),
  });
  assert.equal(res.status, 413);
});

test('valid ~1MB JSON payload reaches the handler (not rejected by 5MB cap)', async () => {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-token' },
    body: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }),
  });
  // 401/403 (auth) or 404 proves the body parsed and reached routing — not 413/400.
  assert.ok([401, 403, 404].includes(res.status), `expected 401/403/404 after parse, got ${res.status}`);
});

// ---- JWT secret validation (spawns config import under NODE_ENV=production) ----

const CONFIG_URL = pathToFileURL(path.join(process.cwd(), 'src/server/config/index.ts')).href;

function configBoot(secret: string | undefined) {
  // Isolate from the repo's .env so "missing" really means missing.
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'nonexistent-hardening-test.env'),
  } as any;
  if (secret === undefined) delete env.JWT_SECRET; else env.JWT_SECRET = secret;
  const r = spawnSync(process.execPath, [TSX_CLI, '-e',
    `import('${CONFIG_URL}').then(()=>{console.log('BOOTED')}).catch(e=>{console.log('FAILED:'+e.message);process.exit(1)})`
  ], { env, encoding: 'utf8', timeout: 30000 });
  return r.stdout + r.stderr;
}

test('production startup rejects missing JWT_SECRET', () => {
  assert.match(configBoot(undefined), /FAILED:/);
});

test('production startup rejects short JWT_SECRET', () => {
  assert.match(configBoot('too-short'), /FAILED:/);
});

test('production startup rejects placeholder JWT_SECRET', () => {
  assert.match(configBoot('your-secret-key-change-in-production'), /FAILED:/);
});

test('production startup accepts a strong JWT_SECRET', () => {
  assert.match(configBoot('a'.repeat(64)), /BOOTED/);
});
