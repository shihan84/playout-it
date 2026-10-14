import 'dotenv/config';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Online backup/restore using SQLite's backup API — safe while the app is
// running (WAL mode means a raw file copy can capture a torn state).
//
// Usage:
//   npx tsx scripts/backup-db.ts [destination.db]       # backup
//   npx tsx scripts/backup-db.ts --restore <file> --confirm   # restore
//   DATABASE_PATH overrides the app database (default: flussonic.db)

const src = process.env.DATABASE_PATH || 'flussonic.db';
const args = process.argv.slice(2);
const restoreIdx = args.indexOf('--restore');

if (restoreIdx !== -1) {
  const backupFile = args[restoreIdx + 1];
  const confirmed = args.includes('--confirm');
  if (!backupFile || !existsSync(backupFile)) {
    console.error(`Backup file not found: ${backupFile ?? '(none given)'}`);
    process.exit(1);
  }
  if (!confirmed) {
    console.error(`Restore overwrites ${src}. Re-run with --confirm to proceed. Stop the app first.`);
    process.exit(1);
  }
  const backup = new Database(backupFile, { readonly: true });
  await backup.backup(src);
  backup.close();
  console.log(`Restored ${backupFile} -> ${src}. Restart the app.`);
  process.exit(0);
}

if (!existsSync(src)) {
  console.error(`Source database not found: ${src}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = args[0] || path.join('backups', `flussonic-${stamp}.db`);
mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });

const TABLES = ['users', 'servers', 'streams', 'vods'];

// Snapshot source counts BEFORE backup — the backup captures a consistent
// point-in-time state taken at some instant during the operation, so live
// counts taken afterward can legitimately differ on a busy database.
const db = new Database(src, { fileMustExist: true });
const srcBefore = Object.fromEntries(
  TABLES.map(t => [t, (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n])
);
await db.backup(dest);
// Counts AFTER backup complete the window: a valid snapshot count must fall
// within [min(before, after), max(before, after)] for each table.
const srcAfter = Object.fromEntries(
  TABLES.map(t => [t, (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n])
);
db.close();

// Verify the backup: structural integrity first, then window-bounded counts.
const check = new Database(dest, { readonly: true });
const integrity = (check.prepare('PRAGMA integrity_check').get() as any)?.integrity_check;
if (integrity !== 'ok') {
  console.error(`Backup integrity check failed: ${integrity}`);
  process.exit(1);
}
for (const table of TABLES) {
  const dstCount = (check.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n;
  const lo = Math.min(srcBefore[table], srcAfter[table]);
  const hi = Math.max(srcBefore[table], srcAfter[table]);
  if (dstCount < lo || dstCount > hi) {
    console.error(`Backup verification failed: ${table} ${dstCount} outside [${lo}, ${hi}]`);
    process.exit(1);
  }
}
check.close();
console.log(`Backup verified: ${dest}`);
