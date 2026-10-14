import bcrypt from 'bcrypt';
import { config } from '../config';

export function runMigrations(db: any) {
  // Migration for new columns
  try {
    db.prepare('ALTER TABLE streams ADD COLUMN input_status TEXT DEFAULT "unknown"').run();
  } catch (e) {}
  try {
    db.prepare('ALTER TABLE streams ADD COLUMN source_type TEXT DEFAULT "unknown"').run();
  } catch (e) {}
  try {
    db.prepare('ALTER TABLE streams ADD COLUMN uptime INTEGER DEFAULT 0').run();
  } catch (e) {}

  // Initialize settings if empty
  try {
    db.exec('ALTER TABLE streams ADD COLUMN push_urls TEXT DEFAULT "[]"');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec('ALTER TABLE streams ADD COLUMN push_status TEXT DEFAULT "[]"');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec("ALTER TABLE videos ADD COLUMN sort_order INTEGER DEFAULT 0");
    db.exec("ALTER TABLE videos ADD COLUMN duration INTEGER DEFAULT 0");
    // Initialize sort_order from existing row order
    const vids = db.prepare('SELECT id FROM videos ORDER BY created_at ASC').all() as any[];
    vids.forEach((v, i) => db.prepare('UPDATE videos SET sort_order = ? WHERE id = ?').run(i, v.id));
  } catch (e) { /* Column already exists */ }

  try {
    db.exec("ALTER TABLE streams ADD COLUMN inputs TEXT DEFAULT '[]'");
    const streams = db.prepare('SELECT * FROM streams').all() as any[];
    const updateStmt = db.prepare('UPDATE streams SET inputs = ? WHERE id = ?');
    for (const s of streams) {
      const inputs = [];
      if (s.live_url) inputs.push(s.live_url);
      if (s.playlist_url) inputs.push(s.playlist_url);
      updateStmt.run(JSON.stringify(inputs), s.id);
    }
  } catch (e) {
    // Column already exists
  }

  // Add username/password columns to servers and backfill from api_key
  try {
    db.exec('ALTER TABLE servers ADD COLUMN username TEXT');
    db.exec('ALTER TABLE servers ADD COLUMN password TEXT');
  } catch (e) {
    // Columns already exist
  }
  try {
    const servers = db.prepare('SELECT id, api_key, username, password FROM servers').all() as any[];
    const updateCreds = db.prepare('UPDATE servers SET username = ?, password = ? WHERE id = ?');
    for (const s of servers) {
      if (!s.username || !s.password) {
        if (s.api_key && s.api_key.includes(':')) {
          const [u, ...rest] = s.api_key.split(':');
          updateCreds.run(u, rest.join(':'), s.id);
        } else {
          updateCreds.run('flussonic', s.api_key || '', s.id);
        }
      }
    }
  } catch (e) {}

  const telegramEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_enabled');
  if (!telegramEnabled) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('telegram_enabled', 'false');
  }

  const telegramBotToken = db.prepare('SELECT value FROM settings WHERE key = ?').get('telegram_bot_token');
  if (!telegramBotToken) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('telegram_bot_token', '');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('telegram_chat_id', '');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('watchdog_interval', '5');
  } else {
    // Update existing default from 60 to 5 for better real-time updates
    db.exec("UPDATE settings SET value = '5' WHERE key = 'watchdog_interval' AND value = '60'");
  }

  const autoSyncEnabled = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_sync_enabled');
  if (!autoSyncEnabled) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('auto_sync_enabled', 'false');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('auto_sync_interval', '60');
  }

  // Per-server health tracking (Phase 1B)
  for (const col of [
    'ALTER TABLE servers ADD COLUMN last_seen_at DATETIME',
    'ALTER TABLE servers ADD COLUMN last_attempt_at DATETIME',
    'ALTER TABLE servers ADD COLUMN last_error TEXT',
    'ALTER TABLE servers ADD COLUMN consecutive_failures INTEGER DEFAULT 0',
    'ALTER TABLE servers ADD COLUMN latency_ms INTEGER',
    'ALTER TABLE servers ADD COLUMN sync_interval_secs INTEGER',
    'ALTER TABLE servers ADD COLUMN last_synced_at DATETIME',
  ]) {
    try { db.exec(col); } catch (e) { /* column exists */ }
  }

  // Explicitly provision the initial administrator using deployment tooling.
  // Never create a known default password on startup.

  // Migration to make server_id nullable and add ON DELETE SET NULL.
  // Must run BEFORE unique indexes — it rebuilds the tables (dropping indexes).
  migrateNullableServerId(db, 'streams');
  migrateNullableServerId(db, 'vods');

  // Dedupe before creating unique indexes (keep earliest row per server+name,
  // re-pointing child rows so no assignments/videos/alerts are lost).
  // Runs as ONE transaction — a mid-way failure rolls back rather than
  // leaving half-merged rows without unique indexes.
  // UNIQUE(user_id, stream_id) collisions on assignments/alerts are the only
  // expected conflict: re-point via INSERT OR IGNORE + delete the dup's rows.
  try {
    db.transaction(() => {
      const streamDupes = db.prepare(
        'SELECT server_id, name, MIN(id) as keep_id, GROUP_CONCAT(id) as ids FROM streams GROUP BY server_id, name HAVING COUNT(*) > 1'
      ).all() as any[];
      for (const d of streamDupes) {
        for (const dupId of d.ids.split(',').map(Number).filter((id: number) => id !== d.keep_id)) {
          db.prepare('INSERT OR IGNORE INTO user_stream_assignments (user_id, stream_id) SELECT user_id, ? FROM user_stream_assignments WHERE stream_id = ?').run(d.keep_id, dupId);
          db.prepare('DELETE FROM user_stream_assignments WHERE stream_id = ?').run(dupId);
          db.prepare('INSERT OR IGNORE INTO telegram_alerts (user_id, stream_id, telegram_chat_id, alert_enabled, downtime_threshold, last_alert_sent, created_at) SELECT user_id, ?, telegram_chat_id, alert_enabled, downtime_threshold, last_alert_sent, created_at FROM telegram_alerts WHERE stream_id = ?').run(d.keep_id, dupId);
          db.prepare('DELETE FROM telegram_alerts WHERE stream_id = ?').run(dupId);
          db.prepare('UPDATE videos SET stream_id = ? WHERE stream_id = ?').run(d.keep_id, dupId);
          db.prepare('DELETE FROM streams WHERE id = ?').run(dupId);
        }
      }
      const vodDupes = db.prepare(
        'SELECT server_id, name, MIN(id) as keep_id, GROUP_CONCAT(id) as ids FROM vods GROUP BY server_id, name HAVING COUNT(*) > 1'
      ).all() as any[];
      for (const d of vodDupes) {
        for (const dupId of d.ids.split(',').map(Number).filter((id: number) => id !== d.keep_id)) {
          db.prepare('UPDATE vod_files SET vod_id = ? WHERE vod_id = ?').run(d.keep_id, dupId);
          db.prepare('DELETE FROM vods WHERE id = ?').run(dupId);
        }
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_streams_server_name ON streams(server_id, name)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vods_server_name ON vods(server_id, name)');
    })();
  } catch (e) {
    console.warn('Could not create unique indexes on streams/vods:', (e as any)?.message);
  }
}

function migrateNullableServerId(db: any, tableName: string) {
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
    const serverIdCol = tableInfo.find(c => c.name === 'server_id');
    if (serverIdCol && serverIdCol.notnull === 1) {
      console.log(`Migrating ${tableName} table to allow NULL server_id...`);
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        if (tableName === 'streams') {
          db.exec(`
            CREATE TABLE streams_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              server_id INTEGER,
              name TEXT NOT NULL,
              live_url TEXT NOT NULL,
              playlist_url TEXT NOT NULL,
              push_urls TEXT DEFAULT '[]',
              push_status TEXT DEFAULT '[]',
              status TEXT DEFAULT 'unknown',
              input_status TEXT DEFAULT 'unknown',
              source_type TEXT DEFAULT 'unknown',
              uptime INTEGER DEFAULT 0,
              last_checked DATETIME,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              inputs TEXT DEFAULT '[]',
              FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL
            );
            INSERT INTO streams_new (id, server_id, name, live_url, playlist_url, push_urls, push_status, status, input_status, source_type, uptime, last_checked, created_at, inputs)
            SELECT id, server_id, name, live_url, playlist_url, push_urls, push_status, status,
                   COALESCE(input_status, 'unknown'), COALESCE(source_type, 'unknown'), COALESCE(uptime, 0),
                   last_checked, created_at, inputs FROM streams;
            DROP TABLE streams;
            ALTER TABLE streams_new RENAME TO streams;
          `);
        } else if (tableName === 'vods') {
          db.exec(`
            CREATE TABLE vods_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              server_id INTEGER,
              name TEXT NOT NULL,
              paths TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE SET NULL
            );
            INSERT INTO vods_new (id, server_id, name, paths, created_at)
            SELECT id, server_id, name, paths, created_at FROM vods;
            DROP TABLE vods;
            ALTER TABLE vods_new RENAME TO vods;
          `);
        }
      })();
      db.pragma('foreign_keys = ON');
    }
  } catch (e) {
    console.error(`Failed to migrate ${tableName} table:`, e);
    db.pragma('foreign_keys = ON');
  }
}
