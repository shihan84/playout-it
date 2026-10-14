import Database from 'better-sqlite3';
import fs from 'fs';
import { config } from '../config';
import { schema } from './schema';
import { runMigrations } from './migrations';

function createDb(path: string) {
  try {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  } catch (e: any) {
    if (e.code === 'SQLITE_CORRUPT' || e.message?.includes('malformed')) {
      console.error('Database corrupted on open, recreating...');
      [path, `${path}-shm`, `${path}-wal`].forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
      const db = new Database(path);
      db.pragma('journal_mode = WAL');
      return db;
    }
    throw e;
  }
}

let db = createDb(config.dbPath);

try {
  db.exec(schema);
} catch (e: any) {
  if (e.code === 'SQLITE_CORRUPT' || e.message?.includes('malformed')) {
    console.error('Database corrupted on schema exec, recreating...');
    db.close();
    [config.dbPath, `${config.dbPath}-shm`, `${config.dbPath}-wal`].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    db = createDb(config.dbPath);
    db.exec(schema);
  } else {
    throw e;
  }
}

runMigrations(db);

export { db };
