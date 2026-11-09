import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('VOD router authenticates and authorizes all routes', () => {
  const source = read('src/server/routes/vods.ts');
  assert.match(source, /router\.use\(authenticateToken, requireAdmin\)/);
  assert.doesNotMatch(source, /getServerAuthHeader/);
  assert.doesNotMatch(source, /altAuthHeader/);
});
test('server listing redacts credentials and unlink does not delete remote resources', () => {
  const source = read('src/server/routes/servers.ts');
  assert.match(source, /publicServer\(server\)/);
  const section = source.split("router.delete('/:id'")[1].split('// Sync Streams from Server')[0];
  assert.doesNotMatch(section, /flussonicRequest\('DELETE'/);
  assert.match(section, /UPDATE streams SET server_id = NULL/);
});
test('database corruption never deletes database files', () => {
  const source = read('src/server/db/index.ts');
  assert.doesNotMatch(source, /unlinkSync|rmSync/);
});
test('no default administrator password', () => {
  const source = read('src/server/db/migrations.ts');
  assert.doesNotMatch(source, /admin123/);
});
test('production requires explicit JWT secret', () => {
  const source = read('src/server/config/index.ts');
  assert.match(source, /JWT_SECRET must be configured/);
});

test('watchdog restart requires an authenticated administrator', () => {
  const source = read('server.ts');
  assert.match(source, /app\.post\('\/api\/watchdog\/restart', authenticateToken, requireAdmin/);
});

test('development binds to loopback unless BIND_HOST is set', () => {
  const cfg = read('src/server/config/index.ts');
  assert.match(cfg, /bindHost: process\.env\.BIND_HOST \|\| \(process\.env\.NODE_ENV === 'production' \? '0\.0\.0\.0' : '127\.0\.0\.1'\)/);
  const srv = read('server.ts');
  assert.doesNotMatch(srv, /listen\(Number\(PORT\), "0\.0\.0\.0"/);
  assert.match(srv, /listen\(Number\(PORT\), HOST/);
});
