import test from 'node:test';
import assert from 'node:assert/strict';
import { installJsonLogs } from '../src/server/utils/jsonLogs';

test('LOG_FORMAT=json writes one JSON object per line with level and formatted message', () => {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const out: string[] = [];
  const err: string[] = [];
  try {
    installJsonLogs({ write: (c: string) => out.push(c) }, { write: (c: string) => err.push(c) });
    console.log('Server running on %s', 'http://x', 3);
    console.warn('careful');
    console.error('Sync error:', new Error('boom'));
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(out.length, 1);
  assert.equal(err.length, 2);
  const info = JSON.parse(out[0]);
  assert.equal(info.level, 'info');
  assert.equal(info.msg, 'Server running on http://x 3');
  assert.ok(!Number.isNaN(Date.parse(info.time)));
  assert.equal(JSON.parse(err[0]).level, 'warn');
  const e = JSON.parse(err[1]);
  assert.equal(e.level, 'error');
  assert.match(e.msg, /Sync error: Error: boom/);
  for (const line of [...out, ...err]) assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
});
