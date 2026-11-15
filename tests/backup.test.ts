import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
process.env.DATABASE_PATH = path.join(tmp, 'live.db');
const backupDir = path.join(tmp, 'backups');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('runBackup writes verified copies and keeps only the newest N', async () => {
  const { runBackup, listBackups } = await import('../src/server/services/backup');
  const { db } = await import('../src/server/db');
  db.prepare("INSERT INTO users (username, password_hash, email, role) VALUES ('bk-admin', 'x', 'a@b', 'admin')").run();

  const made: string[] = [];
  for (let i = 0; i < 3; i++) {
    made.push(await runBackup(backupDir, 2));
    await new Promise(r => setTimeout(r, 5));
  }
  const kept = listBackups(backupDir);
  assert.equal(kept.length, 2, JSON.stringify(kept));
  assert.deepEqual(kept, made.slice(1).map(f => path.basename(f)));
  assert.ok(!fs.readdirSync(backupDir).some(f => f.endsWith('.partial')));

  const copy = new Database(path.join(backupDir, kept[1]), { readonly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) n FROM users WHERE username = 'bk-admin'").get() as any).n, 1);
  copy.close();
});

test('restore drill passes on a good backup and fails on a damaged one', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [path.join('node_modules/tsx/dist/cli.mjs'), 'scripts/restore-drill.ts', ...args], {
    env: { ...process.env, BACKUP_DIR: backupDir }, encoding: 'utf8'
  });
  const ok = run([]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Restore drill passed/);

  const bad = path.join(tmp, 'bad.db');
  fs.writeFileSync(bad, 'not a database');
  const fail = run([bad]);
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
});
