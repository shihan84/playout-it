import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidRole, validateEmail, validatePassword, validateUsername } from '../src/server/utils/userValidation';

test('roles are limited to admin and client', () => {
  assert.ok(isValidRole('admin'));
  assert.ok(isValidRole('client'));
  for (const r of ['superadmin', 'Admin', '', null, 1]) assert.equal(isValidRole(r), false, String(r));
});

test('usernames are restricted to a safe character set', () => {
  assert.equal(validateUsername('ops.user-1_a'), null);
  for (const u of ['', 'a b', '<script>', 'x'.repeat(65), 5]) assert.notEqual(validateUsername(u), null, String(u));
});

test('password policy: 12+ for clients, 16+ for admins, max 72 bytes', () => {
  assert.equal(validatePassword('a'.repeat(12), 'client'), null);
  assert.notEqual(validatePassword('a'.repeat(11), 'client'), null);
  assert.notEqual(validatePassword('a'.repeat(15), 'admin'), null);
  assert.equal(validatePassword('a'.repeat(16), 'admin'), null);
  assert.equal(validatePassword('a'.repeat(72), 'admin'), null);
  assert.notEqual(validatePassword('a'.repeat(73), 'admin'), null);
  assert.notEqual(validatePassword(undefined, 'client'), null);
});

test('email is optional but must look like an address when given', () => {
  assert.equal(validateEmail(undefined), null);
  assert.equal(validateEmail(''), null);
  assert.equal(validateEmail('a@b.co'), null);
  assert.notEqual(validateEmail('nope'), null);
});
