import 'dotenv/config';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Online backup using SQLite's backup API — safe while the app is running
// (WAL mode means a raw file copy can capture a torn state).
// Usage: npx tsx scripts/backup-db.ts [destination.db]
//   DATABASE_PATH overrides the source (default: flussonic.db)

const src = process.env.DATABASE_PATH || 'flussonic.db';
if (!existsSync(src)) {
  console.error(`Source database not found: ${src}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = process.argv[2] || path.join('backups', `flussonic-${stamp}.db`);
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
