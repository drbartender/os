const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt } = require('./encryption');

// Audit 3c (sec-xcut): getKey must reject a non-hex or wrong-length ENCRYPTION_KEY instead of
// letting Buffer.from(key, 'hex') silently truncate it (an empty/short key then throws inside
// createCipheriv at request time, or worse produces unrecoverable ciphertext). In dev/test a
// rejected key falls back to plaintext (null key); a valid 64-hex key still encrypts.

function withKey(k, fn) {
  const prev = process.env.ENCRYPTION_KEY;
  if (k === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = k;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = prev;
  }
}

test('a 64-char NON-HEX ENCRYPTION_KEY is rejected (dev plaintext fallback, not a thrown/truncated cipher)', () => {
  const out = withKey('z'.repeat(64), () => encrypt('secret'));
  assert.equal(out, 'secret', 'non-hex key must be rejected and fall back to plaintext in dev');
});

test('a wrong-length (longer) ENCRYPTION_KEY is rejected', () => {
  const out = withKey('a'.repeat(88), () => encrypt('secret'));
  assert.equal(out, 'secret', 'an over-length key must be rejected, not truncated');
});

test('a valid 64-hex ENCRYPTION_KEY still encrypts (iv:tag:data)', () => {
  const out = withKey('a'.repeat(64), () => encrypt('secret'));
  assert.notEqual(out, 'secret', 'a valid key should produce ciphertext');
  assert.match(out, /^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, 'ciphertext is enc:iv:tag:data hex');
});
