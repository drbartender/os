const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isUuid, requireUuidToken } = require('./tokens');
const { NotFoundError } = require('./errors');

// Canonical public-token shape validation (audit follow-up: non-UUID :token params cast
// against UUID columns and throw Postgres 22P02 -> 500; this guards them up front).

const VALID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

test('isUuid: accepts a canonical UUID (case-insensitive), rejects junk', () => {
  assert.equal(isUuid(VALID), true);
  assert.equal(isUuid(VALID.toUpperCase()), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(`${VALID}x`), false);
  assert.equal(isUuid(`x${VALID}`), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(12345), false);
});

test('requireUuidToken: calls next() with no error for a valid token', () => {
  let nextArg = 'UNSET';
  requireUuidToken()({ params: { token: VALID } }, {}, (e) => { nextArg = e; });
  assert.equal(nextArg, undefined);
});

test('requireUuidToken: calls next(NotFoundError) for a non-UUID token (never reaches the DB)', () => {
  let nextArg = 'UNSET';
  requireUuidToken()({ params: { token: 'garbage' } }, {}, (e) => { nextArg = e; });
  assert.ok(nextArg instanceof NotFoundError);
});

test('requireUuidToken: honors a custom param name and message', () => {
  const mw = requireUuidToken('groupId', 'Conversation not found');
  let bad = 'UNSET';
  mw({ params: { groupId: 'garbage' } }, {}, (e) => { bad = e; });
  assert.ok(bad instanceof NotFoundError);
  assert.equal(bad.message, 'Conversation not found');

  let good = 'UNSET';
  mw({ params: { groupId: VALID } }, {}, (e) => { good = e; });
  assert.equal(good, undefined);
});
