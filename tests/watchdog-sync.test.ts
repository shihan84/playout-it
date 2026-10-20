import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Disposable DB before importing the service singleton.
process.env.DATABASE_PATH = path.join(os.tmpdir(), `watchdog-sync-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'watchdog-test-secret-0123456789abcdef';

const { serverDueForSync } = await import('../src/server/services/watchdog');
const { describeNetError } = await import('../src/server/services/flussonic');

// ---- serverDueForSync: per-server interval gating --------------------------
// Bug being guarded: when any server's override is shorter than the global
// interval, the tick fires at the shorter rate — servers WITHOUT an override
// must still wait for the global interval, not sync every tick.

const NOW = Date.parse('2026-10-20T12:00:00Z');
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString().replace('T', ' ').slice(0, 19);

test('server without last_synced_at is always due', () => {
  assert.equal(serverDueForSync({ last_synced_at: null }, 60, NOW), true);
  assert.equal(serverDueForSync({ last_synced_at: null, sync_interval_secs: 300 }, 60, NOW), true);
});

test('server without override respects the global interval', () => {
  assert.equal(serverDueForSync({ last_synced_at: ago(30) }, 60, NOW), false, '30s < 60s global');
  assert.equal(serverDueForSync({ last_synced_at: ago(60) }, 60, NOW), true, '60s elapsed');
  assert.equal(serverDueForSync({ last_synced_at: ago(120) }, 60, NOW), true);
});

test('per-server override shorter than global is honored', () => {
  const s = { last_synced_at: ago(15), sync_interval_secs: 15 };
  assert.equal(serverDueForSync(s, 60, NOW), true, '15s override elapsed');
  assert.equal(serverDueForSync({ last_synced_at: ago(5), sync_interval_secs: 15 }, 60, NOW), false);
});

test('per-server override longer than global is honored', () => {
  const s = { last_synced_at: ago(120), sync_interval_secs: 300 };
  assert.equal(serverDueForSync(s, 60, NOW), false, 'only 120s of 300s elapsed');
  assert.equal(serverDueForSync({ last_synced_at: ago(310), sync_interval_secs: 300 }, 60, NOW), true);
});

test('mixed fleet: short-override server syncs, plain servers wait for global', () => {
  // Simulates a 15s tick driven by server A's override while server B has none.
  const a = { last_synced_at: ago(15), sync_interval_secs: 15 };
  const b = { last_synced_at: ago(15) };
  assert.equal(serverDueForSync(a, 60, NOW), true);
  assert.equal(serverDueForSync(b, 60, NOW), false, 'plain server must not sync on A\'s fast tick');
});

// ---- describeNetError: operator-actionable diagnostics ---------------------

test('classifies HTTP status failures', () => {
  assert.equal(describeNetError({ response: { status: 401 }, message: 'Request failed' }), 'authentication rejected (HTTP 401)');
  assert.equal(describeNetError({ response: { status: 500 }, message: 'Request failed' }), 'remote server error (HTTP 500)');
  assert.match(describeNetError({ response: { status: 404 }, message: 'x' }), /endpoint not found/);
});

test('classifies network-layer failures', () => {
  assert.match(describeNetError({ code: 'ECONNREFUSED', address: '10.0.0.5', port: 8080, message: 'connect ECONNREFUSED' }), /connection refused.*10\.0\.0\.5:8080/);
  assert.match(describeNetError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND bad.host' }), /DNS resolution failed/);
  assert.match(describeNetError({ code: 'ECONNABORTED', timeout: 5000, message: 'timeout of 5000ms exceeded' }), /timed out/);
  assert.match(describeNetError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self signed' }), /TLS certificate error/);
});

test('falls back to raw message for unclassified errors', () => {
  assert.equal(describeNetError({ message: 'something odd' }), 'something odd');
});
