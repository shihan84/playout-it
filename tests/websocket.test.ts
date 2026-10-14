import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Point the app DB at a disposable file BEFORE importing server modules —
// config/db resolve DATABASE_PATH at import time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playout-ws-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'ws-test.db');
process.env.NODE_ENV = 'test';

const { broadcastStreamsUpdate, clients } = await import('../src/server/websocket/index');
const { db } = await import('../src/server/db');
const { schema } = await import('../src/server/db/schema');

db.exec(schema);
db.prepare("INSERT INTO servers (name, url, api_key) VALUES ('s1', 'http://x', 'u:p')").run();
db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin1', 'h', 'admin')").run();
db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('client1', 'h', 'client')").run();
db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (1, 'stream-a', 'u', '')").run();
db.prepare("INSERT INTO streams (server_id, name, live_url, playlist_url) VALUES (1, 'stream-b', 'u', '')").run();
// client1 (id=2) assigned stream-b (id=2) only
db.prepare('INSERT INTO user_stream_assignments (user_id, stream_id) VALUES (2, 2)').run();

function fakeSocket(user: any) {
  const received: any[] = [];
  return {
    readyState: 1, // WebSocket.OPEN
    user,
    send: (m: string) => received.push(JSON.parse(m)),
    received
  };
}

function collect(user: any) {
  const ws = fakeSocket(user);
  clients.add(ws as any);
  broadcastStreamsUpdate();
  clients.delete(ws as any);
  return ws.received;
}

test('broadcast fails closed when the socket has no verified identity', () => {
  // Missing identity — must receive NOTHING (previously got full admin payload)
  assert.equal(collect(null).length, 0, 'identity-less socket must not receive stream data');
  assert.equal(collect(undefined).length, 0);
  assert.equal(collect({}).length, 0, 'empty user object must not receive data');
});

test('broadcast re-validates the role against the DB (stale/deleted sessions)', () => {
  // JWT claims admin but the user no longer exists → nothing
  assert.equal(collect({ id: 9999, role: 'admin' }).length, 0, 'deleted user must not receive data');
  // JWT role downgraded in DB: claims admin, DB says client → client view
  const out = collect({ id: 2, role: 'admin' });
  assert.equal(out.length, 1);
  const names = out[0].data.map((s: any) => s.name);
  assert.deepEqual(names, ['stream-b'], 'DB role (client) must win over stale JWT claims');
});

test('admin sees all streams; client sees only assigned', () => {
  const adminOut = collect({ id: 1, role: 'admin' });
  assert.equal(adminOut[0].data.length, 2);
  const clientOut = collect({ id: 2, role: 'client' });
  assert.deepEqual(clientOut[0].data.map((s: any) => s.name), ['stream-b']);
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
