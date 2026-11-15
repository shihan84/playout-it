import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Restore drill: restores a backup into a throwaway file and checks it can serve the app.
// Never touches the live database.
//
// Usage:
//   npx tsx scripts/restore-drill.ts [backup.db]   # default: newest backup in BACKUP_DIR

const dbPath = process.env.DATABASE_PATH || 'flussonic.db';
const dir = process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(dbPath)), 'backups');
const explicit = process.argv[2];
const candidates = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => f.startsWith('flussonic-') && f.endsWith('.db')).sort()
  : [];
const backup = explicit || (candidates.length ? path.join(dir, candidates[candidates.length - 1]) : '');
if (!backup || !fs.existsSync(backup)) {
  console.error(`No backup found (${explicit || dir})`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-drill-'));
const target = path.join(scratch, 'restored.db');
let failed = false;
try {
  const src = new Database(backup, { readonly: true, fileMustExist: true });
  await src.backup(target);
  src.close();

  const restored = new Database(target, { readonly: true, fileMustExist: true });
  const integrity = (restored.prepare('PRAGMA integrity_check').get() as any)?.integrity_check;
  const fkErrors = restored.prepare('PRAGMA foreign_key_check').all().length;
  const counts: Record<string, number> = {};
  for (const table of ['users', 'servers', 'streams', 'vods', 'settings']) {
    counts[table] = (restored.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n;
  }
  const admins = (restored.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get() as any).n;
  restored.close();

  console.log(`backup: ${backup} (${fs.statSync(backup).size} bytes)`);
  console.log(`integrity_check: ${integrity}; foreign key errors: ${fkErrors}; admins: ${admins}`);
  console.log(`rows: ${JSON.stringify(counts)}`);
  if (integrity !== 'ok') { console.error('FAIL: integrity check'); failed = true; }
  if (fkErrors > 0) { console.error('FAIL: foreign key errors'); failed = true; }
  if (admins === 0) { console.error('FAIL: no admin user, nobody could log in after restore'); failed = true; }
} catch (e: any) {
  console.error(`FAIL: ${e.message}`);
  failed = true;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? 'Restore drill FAILED' : 'Restore drill passed');
process.exit(failed ? 1 : 0);
