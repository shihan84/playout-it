import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepStaleUploads } from '../src/server/utils/upload';

const PORT = 36530;
const TSX_CLI = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HEX = 'a'.repeat(32);

function makeOld(p: string) {
  const old = new Date(Date.now() - 7 * 3600_000);
  fs.utimesSync(p, old, old);
}

test('sweepStaleUploads removes only old upload leftovers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
  try {
    const up = path.join(tmp, 'playout-it-uploads');
    fs.mkdirSync(up);
    fs.writeFileSync(path.join(up, 'oldfile'), 'x');
    fs.writeFileSync(path.join(up, 'newfile'), 'x');
    makeOld(path.join(up, 'oldfile'));
    fs.mkdirSync(path.join(tmp, `upload_${HEX}`));
    makeOld(path.join(tmp, `upload_${HEX}`));
    fs.writeFileSync(path.join(tmp, `final_${HEX}_clip.mp4`), 'x');
    makeOld(path.join(tmp, `final_${HEX}_clip.mp4`));
    fs.writeFileSync(path.join(tmp, 'unrelated-old.txt'), 'x');
    makeOld(path.join(tmp, 'unrelated-old.txt'));

    assert.equal(sweepStaleUploads(tmp), 3);
    assert.deepEqual(fs.readdirSync(up), ['newfile']);
    assert.deepEqual(fs.readdirSync(tmp).sort(), ['playout-it-uploads', 'unrelated-old.txt']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('server sweeps stale uploads on boot and exits cleanly on SIGTERM', { skip: process.platform === 'win32' && 'POSIX signals only' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-test-'));
  const stale = path.join(tmp, `upload_${HEX}`);
  fs.mkdirSync(stale);
  makeOld(stale);
  const app = spawn(process.execPath, [TSX_CLI, 'server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_PATH: path.join(tmp, 'test.db'),
      JWT_SECRET: 'test-secret-key-for-integration-tests-only-0123456789',
      TMPDIR: tmp,
    },
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  app.stdout.on('data', (d) => (out += d));
  app.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => app.on('exit', (code) => r(code)));
  try {
    const start = Date.now();
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (r.status === 400) break;
      } catch {}
      if (Date.now() - start > 30000) throw new Error('Server did not start in time');
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(fs.existsSync(stale), false);
    assert.match(out, /Removed 1 stale upload/);

    app.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 10000))]);
    assert.equal(code, 0);
    assert.match(out, /SIGTERM received/);
  } finally {
    if (app.exitCode === null) app.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
