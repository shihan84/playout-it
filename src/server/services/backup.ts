import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { db } from '../db';
import { config } from '../config';
import { sendTelegramNotification } from './telegram';

const PREFIX = 'flussonic-';
let intervalTimer: NodeJS.Timeout | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;
let running = false;

// ISO timestamps in the names sort chronologically.
export function listBackups(dir: string = config.backupDir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith(PREFIX) && f.endsWith('.db')).sort();
}

export function pruneBackups(dir: string, keep: number): string[] {
  const files = listBackups(dir);
  const removed = files.slice(0, Math.max(0, files.length - keep));
  for (const f of removed) fs.rmSync(path.join(dir, f), { force: true });
  return removed;
}

// Online backup (safe under WAL), verified with integrity_check before it replaces anything.
export async function runBackup(dir: string = config.backupDir, keep: number = config.backupKeep): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  const partial = `${dest}.partial`;
  try {
    await db.backup(partial);
    const check = new Database(partial, { readonly: true, fileMustExist: true });
    try {
      const result = (check.prepare('PRAGMA integrity_check').get() as any)?.integrity_check;
      if (result !== 'ok') throw new Error(`integrity_check returned ${result}`);
    } finally {
      check.close();
    }
    fs.renameSync(partial, dest);
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw e;
  }
  pruneBackups(dir, keep);
  return dest;
}

async function scheduledBackup() {
  if (running) return;
  running = true;
  try {
    console.log(`Database backup verified: ${await runBackup()}`);
  } catch (e: any) {
    console.error('Database backup failed:', e.message);
    await sendTelegramNotification(`❌ <b>Database backup failed</b>\n\n${e.message}`).catch(() => {});
  } finally {
    running = false;
  }
}

export function startBackups() {
  stopBackups();
  const hours = config.backupIntervalHours;
  if (!(hours > 0)) {
    console.log('Scheduled database backups disabled (BACKUP_INTERVAL_HOURS=0)');
    return;
  }
  firstRunTimer = setTimeout(scheduledBackup, 60_000);
  firstRunTimer.unref();
  intervalTimer = setInterval(scheduledBackup, hours * 3_600_000);
  intervalTimer.unref();
  console.log(`Database backups every ${hours}h to ${config.backupDir} (keeping ${config.backupKeep})`);
}

export function stopBackups() {
  if (firstRunTimer) clearTimeout(firstRunTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstRunTimer = intervalTimer = null;
}
