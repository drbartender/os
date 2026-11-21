// Unsubscribe token helper tests: signing picks UNSUBSCRIBE_SECRET when set,
// verification accepts either key, and the 365-day life and typ are stamped.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { signUnsubscribeToken, verifyUnsubscribeToken } = require('./unsubscribeToken');

const JWT_KEY = 'j'.repeat(40);
const UNSUB_KEY = 'u'.repeat(40);
let saved;

beforeEach(() => {
  saved = { j: process.env.JWT_SECRET, u: process.env.UNSUBSCRIBE_SECRET };
  process.env.JWT_SECRET = JWT_KEY;
  delete process.env.UNSUBSCRIBE_SECRET;
});
afterEach(() => {
  for (const [k, v] of [['JWT_SECRET', saved.j], ['UNSUBSCRIBE_SECRET', saved.u]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('without UNSUBSCRIBE_SECRET it signs with JWT_SECRET, as before', () => {
  const t = signUnsubscribeToken({ leadId: 7 });
  const d = jwt.verify(t, JWT_KEY);
  assert.equal(d.leadId, 7);
  assert.equal(d.typ, 'unsub');
  assert.ok(d.exp - d.iat >= 365 * 86400);
});

test('with UNSUBSCRIBE_SECRET set it signs with that key', () => {
  process.env.UNSUBSCRIBE_SECRET = UNSUB_KEY;
  const t = signUnsubscribeToken({ clientId: 3, marketing: true });
  assert.equal(jwt.verify(t, UNSUB_KEY).clientId, 3);
  assert.throws(() => jwt.verify(t, JWT_KEY));
});

test('verify accepts a token under either key and refuses a foreign one', () => {
  const legacy = jwt.sign({ leadId: 1 }, JWT_KEY);
  process.env.UNSUBSCRIBE_SECRET = UNSUB_KEY;
  const fresh = jwt.sign({ leadId: 2 }, UNSUB_KEY);
  assert.equal(verifyUnsubscribeToken(legacy).leadId, 1);
  assert.equal(verifyUnsubscribeToken(fresh).leadId, 2);
  assert.equal(verifyUnsubscribeToken(jwt.sign({ leadId: 3 }, 'x'.repeat(40))), null);
  assert.equal(verifyUnsubscribeToken('not-a-jwt'), null);
  assert.equal(verifyUnsubscribeToken(''), null);
});

test('an expired token is refused under either key', () => {
  process.env.UNSUBSCRIBE_SECRET = UNSUB_KEY;
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.equal(verifyUnsubscribeToken(jwt.sign({ leadId: 1, exp: past }, JWT_KEY)), null);
  assert.equal(verifyUnsubscribeToken(jwt.sign({ leadId: 1, exp: past }, UNSUB_KEY)), null);
});
