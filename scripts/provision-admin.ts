import 'dotenv/config';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const dbPath = process.env.DATABASE_PATH || 'flussonic.db';
const username = process.env.ADMIN_USERNAME || 'admin';
const email = process.env.ADMIN_EMAIL || null;
const passwordFile = process.env.ADMIN_PASSWORD_FILE;

if (!passwordFile) {
  console.error('Set ADMIN_PASSWORD_FILE to a private file containing the initial admin password.');
  process.exit(1);
}
const password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
if (password.length < 16 || Buffer.byteLength(password, 'utf8') > 1024) {
  console.error('Admin password must be between 16 and 1024 bytes.');
  process.exit(1);
}
if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) {
  console.error('Invalid ADMIN_USERNAME.');
  process.exit(1);
}
const db = new Database(dbPath, { fileMustExist: true });
try {
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  if (users.count !== 0) {
    console.error('Provisioning refused: user accounts already exist.');
    process.exitCode = 1;
  } else {
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO users (username, password_hash, email, role) VALUES (?, ?, ?, ?)').run(username, hash, email, 'admin');
    console.log('Initial administrator provisioned. Password was not printed.');
  }
} finally {
  db.close();
}
