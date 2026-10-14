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

const db = new Database(src, { fileMustExist: true });
await db.backup(dest);
db.close();

// Verify the backup opens and matches row counts on key tables
const check = new Database(dest, { readonly: true });
const srcRo = new Database(src, { readonly: true });
for (const table of ['users', 'servers', 'streams', 'vods']) {
  const srcCount = (srcRo.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n;
  const dstCount = (check.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n;
  if (srcCount !== dstCount) {
    console.error(`Backup verification failed: ${table} ${srcCount} != ${dstCount}`);
    process.exit(1);
  }
}
check.close();
srcRo.close();
console.log(`Backup verified: ${dest}`);
