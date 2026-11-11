import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { securityHeaders, parseTrustProxy } from '../src/server/middleware/securityHeaders';

async function headersFor(production: boolean) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders(production));
  app.get('/', (_req, res) => { res.send('ok'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    return res.headers;
  } finally {
    server.close();
  }
}

test('production responses carry a CSP and hardening headers', async () => {
  const h = await headersFor(true);
  const csp = h.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(h.get('strict-transport-security') || '', /max-age=15552000/);
  assert.equal(h.get('x-powered-by'), null);
});

test('development skips CSP (Vite inline scripts) but keeps other headers', async () => {
  const h = await headersFor(false);
  assert.equal(h.get('content-security-policy'), null);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
});

test('TRUST_PROXY accepts only an explicit hop count', () => {
  assert.equal(parseTrustProxy(undefined), 0);
  assert.equal(parseTrustProxy(''), 0);
  assert.equal(parseTrustProxy('1'), 1);
  for (const bad of ['true', 'false', '10.0.0.1', '-1', 'loopback']) {
    assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, bad);
  }
});
