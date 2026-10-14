import Database from 'better-sqlite3';
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
    // Preserve corrupt databases and WAL files for operator-led recovery.
    // Never silently delete persistent data.
    throw e;
    throw e;
  }
}

let db = createDb(config.dbPath);

try {
  db.exec(schema);
} catch (e: any) {
  if (e.code === 'SQLITE_CORRUPT' || e.message?.includes('malformed')) {
    db.close();
    console.error('Database corruption detected; files preserved for recovery.');
    throw e;
  } else {
    throw e;
  }
}

runMigrations(db);

export { db };
