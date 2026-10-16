import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../lib/password.js';

test('hashPassword produces a scrypt record and never stores the plaintext', () => {
  const record = hashPassword('correct horse battery');
  assert.match(record, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!record.includes('correct horse battery'));
});

test('two hashes of the same password differ (unique salt)', () => {
  assert.notEqual(hashPassword('same-password-123'), hashPassword('same-password-123'));
});

test('verifyPassword accepts the right password', () => {
  const record = hashPassword('s3cret-password');
  assert.equal(verifyPassword('s3cret-password', record), true);
});

test('verifyPassword rejects the wrong password', () => {
  const record = hashPassword('s3cret-password');
  assert.equal(verifyPassword('s3cret-passwore', record), false);
  assert.equal(verifyPassword('', record), false);
});

test('verifyPassword rejects malformed or foreign records', () => {
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', 'bcrypt$whatever'), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', null), false);
});

test('DUMMY_HASH never validates a real password', () => {
  assert.equal(verifyPassword('anything-at-all', DUMMY_HASH), false);
  assert.match(DUMMY_HASH, /^scrypt\$/);
});
