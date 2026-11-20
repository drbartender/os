'use strict';

// The connector's credential helpers (spec 2026-11-19 section 7.2, law 8):
// the prefixed shape, the hash, and the PKCE S256 check against RFC 7636's own
// test vector. Pure: no database (the grants themselves are exercised through
// the routes in server/routes/connector.flow.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tokens = require('./tokens');

test('every credential carries its prefix and a 43-character random body', () => {
  const seen = new Set();
  for (const prefix of [tokens.ACCESS_PREFIX, tokens.REFRESH_PREFIX, tokens.CODE_PREFIX]) {
    assert.ok(prefix.startsWith(tokens.TOKEN_PREFIX));
    for (let i = 0; i < 50; i += 1) {
      const t = tokens.mint(prefix);
      assert.ok(tokens.hasShape(t, prefix), t);
      assert.equal(seen.has(t), false, 'no repeats');
      seen.add(t);
    }
  }
  assert.equal(tokens.hasShape(tokens.mint(tokens.ACCESS_PREFIX), tokens.REFRESH_PREFIX), false, 'kinds do not cross');
  assert.equal(tokens.hasShape('eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.c2ln', tokens.ACCESS_PREFIX), false, 'a JWT is not ours');
  assert.equal(tokens.hasShape(`${tokens.ACCESS_PREFIX}short`, tokens.ACCESS_PREFIX), false);
  assert.equal(tokens.hasShape(undefined, tokens.ACCESS_PREFIX), false);
});

test('the stored hash is the SHA-256 hex of the token, never the token', () => {
  const t = tokens.mint(tokens.ACCESS_PREFIX);
  const h = tokens.hashToken(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, crypto.createHash('sha256').update(t).digest('hex'));
  assert.equal(h.includes(t), false);
});

test('PKCE S256 matches RFC 7636 appendix B, and refuses a wrong or malformed verifier', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(tokens.pkceMatches(verifier, challenge), true);
  assert.equal(tokens.pkceMatches(`${verifier}x`, challenge), false);
  assert.equal(tokens.pkceMatches(verifier, `${challenge}x`), false);
  assert.equal(tokens.pkceMatches('short', challenge), false, 'under 43 characters');
  assert.equal(tokens.pkceMatches(challenge, challenge), false, 'the plain method is not accepted');
  assert.equal(tokens.pkceMatches(undefined, challenge), false);
});
