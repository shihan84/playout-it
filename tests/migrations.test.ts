import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/server/db/migrations';
import { schema } from '../src/server/db/schema';

// Build a pre-Phase-1B database: old stream/vod columns, no health columns,
// no unique indexes, duplicate stream/VOD rows with FK-referencing children.
function makeLegacyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playout-mig-'));
  const dbPath = path.join(dir, 'legacy.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL, api_key TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE streams (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL, name TEXT NOT NULL, live_url TEXT NOT NULL, playlist_url TEXT NOT NULL, status TEXT DEFAULT 'unknown', last_checked DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(server_id) REFERENCES servers(id));
    CREATE TABLE vods (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL, name TEXT NOT NULL, paths TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(server_id) REFERENCES servers(id));
    CREATE TABLE videos (id INTEGER PRIMARY KEY AUTOINCREMENT, stream_id INTEGER NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE);
    CREATE TABLE vod_files (id INTEGER PRIMARY KEY AUTOINCREMENT, vod_id INTEGER NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(vod_id) REFERENCES vods(id) ON DELETE CASCADE);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, email TEXT, role TEXT NOT NULL DEFAULT 'client', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE user_stream_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, stream_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE, UNIQUE(user_id, stream_id));
    CREATE TABLE telegram_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, stream_id INTEGER NOT NULL, telegram_chat_id TEXT NOT NULL, alert_enabled INTEGER DEFAULT 1, downtime_threshold INTEGER DEFAULT 30, last_alert_sent DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(stream_id) REFERENCES streams(id) ON DELETE CASCADE, UNIQUE(user_id, stream_id));
  `);
  return { db, dbPath, dir };
}

test('migrations preserve production data and dedupe keeps FK references valid', () => {
  const { db } = makeLegacyDb();

  // Seed: 1 server, 1 user, a duplicated stream + duplicated vod with children
  db.prepare("INSERT INTO servers (name, url, api_key) VALUES ('legacy-srv', 'http://x', 'u:p')").run();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('c1', 'h', 'client')").run();
  db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (1, 'dupstream', 'a', '')").run(); // id 1 (kept)
  db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (1, 'dupstream', 'b', '')").run(); // id 2 (dup)
  db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (1, 'solo', 'c', '')").run();       // id 3
  db.prepare("INSERT INTO vods (server_id, name, paths) VALUES (1, 'dupvod', '[]')").run();                          // id 1 (kept)
  db.prepare("INSERT INTO vods (server_id, name, paths) VALUES (1, 'dupvod', '[]')").run();                          // id 2 (dup)
  // Children pointing at the DUPLICATE rows
  db.prepare('INSERT INTO user_stream_assignments (user_id, stream_id) VALUES (1, 2)').run();
  db.prepare("INSERT INTO telegram_alerts (user_id, stream_id, telegram_chat_id) VALUES (1, 2, 'chat')").run();
  db.prepare("INSERT INTO videos (stream_id, filename, size) VALUES (2, 'v.mp4', 1)").run();
  db.prepare("INSERT INTO vod_files (vod_id, filename, size) VALUES (2, 'f.mp4', 1)").run();

  runMigrations(db);

  // Deduped, children re-pointed to kept id
  const streams = db.prepare('SELECT id, name FROM streams ORDER BY id').all() as any[];
  assert.equal(streams.filter(s => s.name === 'dupstream').length, 1, 'duplicate stream should be merged');
  const keptId = streams.find(s => s.name === 'dupstream')!.id;
  assert.equal((db.prepare('SELECT COUNT(*) n FROM user_stream_assignments WHERE stream_id = ?').get(keptId) as any).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM telegram_alerts WHERE stream_id = ?').get(keptId) as any).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM videos WHERE stream_id = ?').get(keptId) as any).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM vod_files WHERE vod_id = 1').get() as any).n, 1, 'vod_files re-pointed to kept VOD');
  assert.ok(streams.some(s => s.name === 'solo'), 'non-duplicate stream preserved');

  // New columns + indexes exist
  const cols = db.prepare('PRAGMA table_info(servers)').all().map((c: any) => c.name);
  for (const c of ['username', 'password', 'last_seen_at', 'last_error', 'consecutive_failures', 'latency_ms', 'sync_interval_secs', 'last_synced_at']) {
    assert.ok(cols.includes(c), `servers.${c} missing after migration`);
  }
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all().map((r: any) => r.name);
  assert.ok(idx.includes('idx_streams_server_name'));
  assert.ok(idx.includes('idx_vods_server_name'));

  // Phase 2 lifecycle column + events table survive the legacy rebuild path
  const streamCols = db.prepare('PRAGMA table_info(streams)').all().map((c: any) => c.name);
  assert.ok(streamCols.includes('lifecycle_state'), 'streams.lifecycle_state missing after legacy migration');
  assert.ok(streamCols.includes('channel_group'), 'streams.channel_group missing after legacy migration');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_events'").get(), 'stream_events table missing');
  const states = db.prepare('SELECT DISTINCT lifecycle_state s FROM streams').all().map((r: any) => r.s);
  assert.ok(states.every(s => s === 'live'), `existing streams must default to live, got ${states}`);

  // Uniqueness now enforced
  assert.throws(() => db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (1, 'dupstream', 'x', '')").run());

  db.close();
});

test('migrations are idempotent on a current-schema DB', () => {
  const { db } = makeLegacyDb();
  runMigrations(db);
  runMigrations(db); // second run must not throw or lose data
  const settings = db.prepare('SELECT COUNT(*) n FROM settings').get() as any;
  assert.ok(settings.n > 0, 'default settings seeded');
  db.close();
});

test('fresh install: schema + migrations produce complete DB with no admin user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playout-fresh-'));
  const db = new Database(path.join(dir, 'fresh.db'));
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);

  // No default administrator is ever created
  assert.equal((db.prepare('SELECT COUNT(*) n FROM users').get() as any).n, 0);

  // All Phase 1B columns/indexes present
  const cols = db.prepare('PRAGMA table_info(servers)').all().map((c: any) => c.name);
  for (const c of ['username', 'password', 'last_seen_at', 'last_attempt_at', 'last_error', 'consecutive_failures', 'latency_ms', 'sync_interval_secs', 'last_synced_at']) {
    assert.ok(cols.includes(c), `servers.${c} missing on fresh install`);
  }
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all().map((r: any) => r.name);
  assert.ok(idx.includes('idx_streams_server_name') && idx.includes('idx_vods_server_name'));

  const streamCols = db.prepare('PRAGMA table_info(streams)').all().map((c: any) => c.name);
  for (const c of ['input_status', 'source_type', 'uptime', 'inputs', 'push_urls', 'lifecycle_state', 'channel_group']) {
    assert.ok(streamCols.includes(c), `streams.${c} missing on fresh install`);
  }
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_events'").get(), 'stream_events missing on fresh install');
  const assignCols = db.prepare('PRAGMA table_info(user_stream_assignments)').all().map((c: any) => c.name);
  for (const c of ['expires_at', 'max_sessions']) {
    assert.ok(assignCols.includes(c), `user_stream_assignments.${c} missing on fresh install`);
  }
  db.close();
});

test('SQLite online backup produces a restorable copy of a live WAL database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playout-backup-'));
  const srcPath = path.join(dir, 'live.db');
  const bakPath = path.join(dir, 'backup.db');

  // Live DB in WAL mode (production default) — a raw file copy would be
  // unsafe here; .backup() is the online-safe mechanism.
  const src = new Database(srcPath);
  src.pragma('journal_mode = WAL');
  src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
  src.prepare("INSERT INTO t (val) VALUES ('a'), ('b'), ('c')").run();
  // Uncommitted-to-mainfile state: WAL holds recent writes
  src.prepare("INSERT INTO t (val) VALUES ('wal-only')").run();

  await src.backup(bakPath);

  const restored = new Database(bakPath, { readonly: true });
  const rows = restored.prepare('SELECT val FROM t ORDER BY id').all() as any[];
  assert.equal(rows.length, 4, 'backup must capture WAL-resident rows');
  assert.equal(rows[3].val, 'wal-only');
  restored.close();
  src.close();

  // Restored copy is writable and fully independent of the source
  const rw = new Database(bakPath);
  rw.prepare("INSERT INTO t (val) VALUES ('post-restore')").run();
  assert.equal((rw.prepare('SELECT COUNT(*) n FROM t').get() as any).n, 5);
  rw.close();
});

test('backup verification tolerates concurrent writes (window-bounded counts)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playout-backup-race-'));
  const srcPath = path.join(dir, 'busy.db');
  const bakPath = path.join(dir, 'busy-backup.db');

  const src = new Database(srcPath);
  src.pragma('journal_mode = WAL');
  src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
  const seed = src.prepare("INSERT INTO t (val) VALUES ('x')");
  for (let i = 0; i < 5000; i++) seed.run();

  // Concurrent writer on a second connection during backup
  const writer = new Database(srcPath);
  writer.pragma('journal_mode = WAL');
  const write = writer.prepare("INSERT INTO t (val) VALUES ('concurrent')");
  let stop = false;
  const writerLoop = (async () => {
    while (!stop) {
      write.run();
      await new Promise(r => setImmediate(r));
    }
  })();

  const countBefore = (src.prepare('SELECT COUNT(*) n FROM t').get() as any).n;
  await src.backup(bakPath);
  const countAfter = (src.prepare('SELECT COUNT(*) n FROM t').get() as any).n;
  stop = true;
  await writerLoop;

  const dest = new Database(bakPath, { readonly: true });
  assert.equal((dest.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  const dstCount = (dest.prepare('SELECT COUNT(*) n FROM t').get() as any).n;
  const lo = Math.min(countBefore, countAfter), hi = Math.max(countBefore, countAfter);
  assert.ok(dstCount >= lo && dstCount <= hi, `backup count ${dstCount} must fall within [${lo}, ${hi}]`);
  dest.close(); writer.close(); src.close();
});
