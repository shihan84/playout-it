import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(process.cwd(), 'scripts', 'staging-validate.ts');
const posixOnly = { skip: process.platform === 'win32' && 'POSIX signals/shell only' };

interface MockOptions {
  preexisting?: number;
  pageSize?: number;
  loopCursor?: boolean;
  ignoreSwap?: boolean;
  putDelayMs?: number;
}

interface Seen { method: string; url: string; at: number; doneAt?: number }

function startMock(opts: MockOptions = {}) {
  const streams = new Map<string, any>();
  for (let i = 0; i < (opts.preexisting ?? 2); i++) streams.set(`ch${i}`, { name: `ch${i}`, inputs: [{ url: 'udp://x' }] });
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const entry: Seen = { method: req.method!, url: req.url!, at: Date.now() };
    seen.push(entry);
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const send = (status: number, data: unknown) => {
        entry.doneAt = Date.now();
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const u = new URL(req.url!, 'http://mock');
      const p = u.pathname.replace('/flussonic/api/v3', '');
      if (req.method === 'GET' && p === '/config') return send(200, {});
      if (req.method === 'GET' && p === '/vods') return send(200, { vods: [] });
      if (req.method === 'GET' && p === '/streams') {
        const all = [...streams.values()];
        const size = opts.pageSize ?? 1000;
        const page = Number(u.searchParams.get('cursor') || 0);
        const next = opts.loopCursor ? '1' : (page + 1) * size < all.length ? String(page + 1) : undefined;
        return send(200, { streams: all.slice(page * size, (page + 1) * size), next });
      }
      const name = decodeURIComponent(p.replace('/streams/', ''));
      if (req.method === 'GET') return streams.has(name) ? send(200, streams.get(name)) : send(404, {});
      if (req.method === 'DELETE') { streams.delete(name); return send(204, {}); }
      if (req.method === 'PUT') {
        const apply = () => {
          const cfg = JSON.parse(body);
          if (!(opts.ignoreSwap && streams.has(name))) streams.set(name, cfg);
          send(200, cfg);
        };
        return opts.putDelayMs ? setTimeout(apply, opts.putDelayMs) : apply();
      }
      send(405, {});
    });
  });
  return new Promise<{ url: string; seen: Seen[]; streams: Map<string, any>; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as any;
      resolve({ url: `http://127.0.0.1:${port}`, seen, streams, close: () => server.close() });
    });
  });
}

function run(args: string[], env: Record<string, string>, onSpawn?: (child: ReturnType<typeof spawn>) => void) {
  return new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      env: { ...process.env, STAGING_USER: 'u', STAGING_PASS: 'p', STAGING_ALLOW_HTTP: '1', PRODUCTION_HOSTS: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', d => { out += d; });
    child.stderr!.on('data', d => { out += d; });
    onSpawn?.(child);
    child.on('exit', code => resolve({ code, out }));
  });
}

const writeEnv = (url: string) => ({ STAGING_URL: url, STAGING_CONFIRM_HOST: '127.0.0.1' });
const e2e = (m: { streams: Map<string, any> }) => [...m.streams.keys()].filter(k => k.startsWith('e2e-val-'));

test('refuses plain http without STAGING_ALLOW_HTTP=1', async () => {
  const m = await startMock();
  try {
    const r = await run([], { STAGING_URL: m.url, STAGING_ALLOW_HTTP: '' });
    assert.equal(r.code, 2);
    assert.match(r.out, /must use https/);
    assert.equal(m.seen.length, 0);
  } finally { m.close(); }
});

test('read-only mode only sends GET requests', async () => {
  const m = await startMock();
  try {
    const r = await run([], { STAGING_URL: m.url });
    assert.equal(r.code, 0, r.out);
    assert.ok(m.seen.every(s => s.method === 'GET'));
  } finally { m.close(); }
});

test('write lifecycle verifies each PUT by GET and removes the disposable stream', async () => {
  const m = await startMock();
  try {
    const r = await run(['--write'], writeEnv(m.url));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PASS {2}input swap/);
    assert.match(r.out, /PASS {2}input restore/);
    assert.equal(m.seen.filter(s => s.method === 'PUT').length, 3);
    assert.equal(m.seen.filter(s => s.method === 'DELETE').length, 1);
    assert.deepEqual(e2e(m), []);
    assert.equal(m.streams.size, 2);
  } finally { m.close(); }
});

test('stream count follows pagination and refuses to write on a populated server', async () => {
  const m = await startMock({ preexisting: 30, pageSize: 15 });
  try {
    const r = await run(['--write'], writeEnv(m.url));
    assert.equal(r.code, 1);
    assert.match(r.out, /30 remote streams/);
    assert.match(r.out, /30 streams > STAGING_MAX_STREAMS=20/);
    assert.ok(!m.seen.some(s => s.method !== 'GET'));
  } finally { m.close(); }
});

test('an incomplete stream count (pagination loop) refuses to write', async () => {
  const m = await startMock({ loopCursor: true, pageSize: 1 });
  try {
    const r = await run(['--write'], writeEnv(m.url));
    assert.equal(r.code, 1);
    assert.match(r.out, /inventory incomplete/);
    assert.ok(!m.seen.some(s => s.method !== 'GET'));
  } finally { m.close(); }
});

test('a swap that does not take effect fails and still cleans up', async () => {
  const m = await startMock({ ignoreSwap: true });
  try {
    const r = await run(['--write'], writeEnv(m.url));
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}input swap.*expected fake:\/\/fake2/);
    assert.equal(m.seen.filter(s => s.method === 'DELETE').length, 1);
    assert.deepEqual(e2e(m), []);
  } finally { m.close(); }
});

test('--publish must contain {stream} and target the staging host', async () => {
  const m = await startMock();
  try {
    let r = await run(['--write', '--publish=rtmp://127.0.0.1/live/existing'], writeEnv(m.url));
    assert.equal(r.code, 2);
    assert.match(r.out, /must contain \{stream\}/);
    r = await run(['--write', '--publish=rtmp://other.example/{stream}'], writeEnv(m.url));
    assert.equal(r.code, 2);
    assert.match(r.out, /must target the staging host/);
    assert.equal(m.seen.length, 0);
  } finally { m.close(); }
});

test('--publish keeps "=" in the URL, publishes only into the disposable stream, and redacts ffmpeg errors', posixOnly, async () => {
  const m = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-ffmpeg-'));
  const fake = path.join(dir, 'ffmpeg');
  const argsFile = path.join(dir, 'args');
  fs.writeFileSync(fake, `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s' "$last" > "${argsFile}"\necho "Connection to $last failed (rtmp://user:topsecret@127.0.0.1/x passphrase=topsecret)" >&2\nexit 1\n`, { mode: 0o755 });
  try {
    const url = 'srt://127.0.0.1:9000?streamid=publish:{stream}&passphrase=top=secret';
    const r = await run(['--write', `--publish=${url}`], { ...writeEnv(m.url), FFMPEG_PATH: fake });
    assert.equal(r.code, 1);
    const sent = fs.readFileSync(argsFile, 'utf8');
    assert.match(sent, /^srt:\/\/127\.0\.0\.1:9000\?streamid=publish:e2e-val-[a-z0-9]+&passphrase=top=secret$/);
    assert.match(r.out, /FAIL {2}ffmpeg publish/);
    assert.doesNotMatch(r.out, /secret/);
    assert.ok(m.seen.some(s => s.method === 'PUT'));
    const putTargets = new Set(m.seen.filter(s => s.method === 'PUT').map(s => s.url));
    assert.equal(putTargets.size, 1);
    assert.match([...putTargets][0], /\/streams\/e2e-val-/);
    assert.deepEqual(e2e(m), []);
  } finally { m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SIGINT during the first PUT waits for it, then deletes the stream', posixOnly, async () => {
  const m = await startMock({ putDelayMs: 400 });
  try {
    const r = await run(['--write'], writeEnv(m.url), child => {
      const timer = setInterval(() => {
        if (m.seen.some(s => s.method === 'PUT')) { clearInterval(timer); child.kill('SIGINT'); }
      }, 20);
      child.on('exit', () => clearInterval(timer));
    });
    assert.equal(r.code, 130, r.out);
    const put = m.seen.find(s => s.method === 'PUT')!;
    const del = m.seen.find(s => s.method === 'DELETE');
    assert.ok(del, 'cleanup DELETE sent');
    assert.ok(put.doneAt! <= del!.at, 'DELETE sent after the PUT completed');
    assert.equal(m.seen.filter(s => s.method === 'PUT').length, 1, 'no further writes after the signal');
    assert.deepEqual(e2e(m), []);
  } finally { m.close(); }
});
