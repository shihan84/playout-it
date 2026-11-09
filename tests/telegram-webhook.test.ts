import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidWebhookSecret } from '../src/server/routes/telegramWebhook';

test('webhook rejects everything when no secret is configured', () => {
  assert.equal(isValidWebhookSecret('anything', ''), false);
  assert.equal(isValidWebhookSecret(undefined, ''), false);
});

test('webhook accepts only the exact configured secret', () => {
  const secret = 's3cr3t-token_ABC';
  assert.equal(isValidWebhookSecret(secret, secret), true);
  for (const bad of [undefined, '', 's3cr3t-token_AB', 's3cr3t-token_ABCD', 'S3CR3T-TOKEN_ABC', ['s3cr3t-token_ABC']]) {
    assert.equal(isValidWebhookSecret(bad, secret), false, String(bad));
  }
});
