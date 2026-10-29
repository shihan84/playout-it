import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { singleUpload } from '../src/server/utils/upload';

const PORT = 36410;
const MOCK_PORT = 36411;
const BASE = `http://127.0.0.1:${PORT}`;
const TSX_CLI = path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const BOUNDARY = 'XyZuploadBoundary';

let appProcess: any;
let mock: any;
let tmpDir: string;
let auth: Record<string, string>;
let streamId: number | bigint;
let vodId: number | bigint;
const puts: { url: string; bytes: number }[] = [];

function form(field: string, data: Buffer, filename = 'clip.mp4', extra: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  f.append(field, new Blob([data], { type: 'video/mp4' }), filename);
  return f;
}

function part(field: string, data: Buffer) {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="a.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),
    data,
  ]);
}

function rawPost(base: string, url: string, headers: Record<string, string>, body: Buffer) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request(base + url, { method: 'POST', headers }, (rs) => {
      let b = '';
      rs.on('data', (c) => (b += c));
      rs.on('end', () => resolve({ status: rs.statusCode!, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

// ---- singleUpload in an isolated app (small limit so 413 is cheap) ----

function scratch(storage?: multer.StorageEngine) {
  const app = express();
  const upload = multer(storage ? { storage, limits: { fileSize: 1024 } } : { dest: os.tmpdir(), limits: { fileSize: 1024 } });
  app.post('/up', singleUpload(upload, 'file', '1KB'), (req, res) => {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
    res.json({ ok: !!req.file });
  });
  return new Promise<any>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('singleUpload maps parser errors to 4xx', async () => {
  const srv = await scratch();
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/up`, { method: 'POST', body: form('file', Buffer.alloc(1000)) })).status, 200);
    const big = await fetch(`${base}/up`, { method: 'POST', body: form('file', Buffer.alloc(5000)) });
    assert.equal(big.status, 413);
    assert.match((await big.json()).error, /1KB/);
    assert.equal((await fetch(`${base}/up`, { method: 'POST', body: form('other', Buffer.alloc(10)) })).status, 400);
    const ct = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
    assert.equal((await rawPost(base, '/up', ct, part('file', Buffer.alloc(100)))).status, 400);
    assert.equal((await rawPost(base, '/up', ct, Buffer.from('not multipart'))).status, 400);
    assert.equal((await rawPost(base, '/up', { 'content-type': 'multipart/form-data' }, part('file', Buffer.alloc(10)))).status, 400);
  } finally {
    srv.close();
  }
});

test('singleUpload keeps storage failures as 500', async () => {
  const failing: multer.StorageEngine = {
    _handleFile(_req, file, cb) {
      file.stream.resume();
      cb(Object.assign(new Error('ENOSPC: no space left on device'), { errno: -28, code: 'ENOSPC', syscall: 'write' }));
    },
    _removeFile(_req, _file, cb) { cb(null); },
  };
  const srv = await scratch(failing);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/up`, { method: 'POST', body: form('file', Buffer.alloc(10)) });
    assert.equal(r.status, 500);
    assert.doesNotMatch(await r.text(), /ENOSPC/);
  } finally {
    srv.close();
  }
});

// ---- real server against a mock Flussonic ----

test.before(async () => {
  mock = createServer((rq, rs) => {
    let n = 0;
    rq.on('data', (c) => (n += c.length));
    rq.on('end', () => {
      if (rq.method === 'PUT') puts.push({ url: rq.url!, bytes: n });
      rs.setHeader('Content-Type', 'application/json');
      rs.end(rq.method === 'GET' && /\/(streams|vods)$/.test(rq.url!) ? '[]' : '{}');
    });
  });
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
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
  appProcess.stdout.on('data', () => {});
  appProcess.stderr.on('data', (d: any) => process.stderr.write(`[app] ${d}`));

  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.status === 400) break;
    } catch {}
    if (Date.now() - start > 30000) throw new Error('Server did not start in time');
    await new Promise((r) => setTimeout(r, 500));
  }

  const db = new Database(dbPath);
  db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)')
    .run('uploadadmin', bcrypt.hashSync('upload-admin-pass-12345', 10), 'u@local', 'admin');
  db.close();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'uploadadmin', password: 'upload-admin-pass-12345' }),
  });
  auth = { authorization: `Bearer ${(await login.json()).token}` };
  const srv = await (await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'mock', url: `http://127.0.0.1:${MOCK_PORT}`, username: 'u', password: 'mockpass123456' }),
  })).json();
  const db2 = new Database(dbPath);
  streamId = db2.prepare('INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (?, ?, ?, ?)').run(srv.id, 'up-stream', 'x', 'x').lastInsertRowid;
  vodId = db2.prepare('INSERT INTO vods (server_id, name, paths) VALUES (?, ?, ?)').run(srv.id, 'up-vod', '["/tmp"]').lastInsertRowid;
  db2.close();
});

test.after(async () => {
  if (appProcess) {
    const exited = new Promise((r) => appProcess.once('exit', r));
    appProcess.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  mock?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('stream video upload streams the full file to Flussonic', async () => {
  puts.length = 0;
  const r = await fetch(`${BASE}/api/streams/${streamId}/videos`, { method: 'POST', headers: auth, body: form('video', Buffer.alloc(3 * 1024 * 1024, 7)) });
  assert.equal(r.status, 200);
  const put = puts.find((p) => p.url.endsWith('/files/clip.mp4'));
  assert.ok(put, 'expected PUT to Flussonic');
  assert.equal(put!.bytes, 3 * 1024 * 1024);
});

test('upload filenames are encoded as a single URL path segment', async () => {
  puts.length = 0;
  const name = 'a b.mp4?x=1#frag';
  assert.equal((await fetch(`${BASE}/api/streams/${streamId}/videos`, { method: 'POST', headers: auth, body: form('video', Buffer.alloc(10), name) })).status, 200);
  assert.equal((await fetch(`${BASE}/api/vods/${vodId}/files`, { method: 'POST', headers: auth, body: form('file', Buffer.alloc(10), name) })).status, 200);
  const encoded = `/files/${encodeURIComponent(name)}`;
  assert.equal(puts.filter((p) => p.url.endsWith(encoded)).length, 2, JSON.stringify(puts));
});

test('wrong field and malformed multipart return 400 on every upload route', async () => {
  const init = await (await fetch(`${BASE}/api/vods/${vodId}/files/init-chunked`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'c.mp4', totalChunks: 1 }),
  })).json();
  const S = `/api/streams/${streamId}/videos`;
  const V = `/api/vods/${vodId}/files`;
  const C = `${V}/chunk`;

  assert.equal((await fetch(BASE + S, { method: 'POST', headers: auth, body: form('file', Buffer.alloc(10)) })).status, 400);
  assert.equal((await fetch(BASE + C, { method: 'POST', headers: auth, body: form('file', Buffer.alloc(10), 'c', { uploadId: init.uploadId, chunkIndex: '0' }) })).status, 400);

  const ct = { ...auth, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
  for (const [url, field] of [[S, 'video'], [V, 'file'], [C, 'chunk']]) {
    assert.equal((await rawPost(BASE, url, ct, part(field, Buffer.alloc(500, 1)))).status, 400, `${url} truncated`);
    assert.equal((await rawPost(BASE, url, ct, Buffer.from('this is not multipart'))).status, 400, `${url} garbage`);
    assert.equal((await rawPost(BASE, url, { ...auth, 'content-type': 'multipart/form-data' }, part(field, Buffer.alloc(10)))).status, 400, `${url} no boundary`);
  }

  // valid chunk still accepted
  assert.equal((await fetch(BASE + C, { method: 'POST', headers: auth, body: form('chunk', Buffer.alloc(100, 1), 'c0', { uploadId: init.uploadId, chunkIndex: '0' }) })).status, 200);
});

test('flussonicRequest sends a fresh stream on legacy-auth retry and destroys every stream', async () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-test-'));
  process.env.DATABASE_PATH = path.join(scratchDir, 'fr.db');
  const { flussonicRequest } = await import('../src/server/services/flussonic');
  const file = path.join(scratchDir, 'body.bin');
  fs.writeFileSync(file, Buffer.alloc(200000, 5));
  const received: number[] = [];
  const srv = createServer((rq, rs) => {
    let n = 0;
    rq.on('data', (c) => (n += c.length));
    rq.on('end', () => {
      received.push(n);
      rs.statusCode = received.length === 1 ? 401 : 200;
      rs.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const streams: fs.ReadStream[] = [];
  try {
    const port = (srv.address() as any).port;
    await flussonicRequest('PUT', `http://127.0.0.1:${port}/x`, { api_key: 'key' }, () => {
      const s = fs.createReadStream(file);
      streams.push(s);
      return s;
    });
    assert.deepEqual(received, [200000, 200000]);
    assert.equal(streams.length, 2);
    assert.ok(streams.every((s) => s.destroyed));
  } finally {
    srv.close();
    // Close the DB opened by importing flussonic.ts; Windows can't delete open files.
    (await import('../src/server/db')).db.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
