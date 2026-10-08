const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ValidationError } = require('../errors');
const { firstTextPrefixFor, withFirstTextPrefix } = require('./firstText');

// Answers "has this line texted this number before?" and records each ask.
function fakeDb(sentBefore) {
  const calls = [];
  return {
    calls,
    query: (sql, params) => {
      calls.push(params);
      return Promise.resolve({ rowCount: sentBefore ? 1 : 0, rows: sentBefore ? [{}] : [] });
    },
  };
}

test('only a 224 line takes the prefix, and only before its first text to that number', async () => {
  const fresh = fakeDb(false);
  assert.equal(await firstTextPrefixFor({ line: '888', to: '+13125550100' }, fresh), null);
  assert.equal(fresh.calls.length, 0, 'the 888 never asks');
  assert.equal(await firstTextPrefixFor({ line: '1922', to: '+13125550100' }, fresh), 'Dr. Bartender: ');
  assert.deepEqual(fresh.calls[0], ['3125550100', '1922']);
  assert.equal(await firstTextPrefixFor({ line: '0082', to: '+13125550100' }, fakeDb(true)), null);
  assert.equal(await firstTextPrefixFor({ line: '1922', to: 'not a phone' }, fakeDb(false)), null);
});

test('withFirstTextPrefix adds it once, never doubles a typed one, and refuses past 1600 characters', async () => {
  const to = '+13125550100';
  assert.equal(await withFirstTextPrefix({ body: 'Hello', line: '1922', to }, fakeDb(false)), 'Dr. Bartender: Hello');
  assert.equal(await withFirstTextPrefix({ body: 'Hello', line: '1922', to }, fakeDb(true)), 'Hello');
  assert.equal(await withFirstTextPrefix({ body: 'dr. bartender: hi', line: '1922', to }, fakeDb(false)), 'dr. bartender: hi');
  assert.equal(await withFirstTextPrefix({ body: 'Hello', line: '888', to }, fakeDb(false)), 'Hello');
  assert.equal((await withFirstTextPrefix({ body: 'x'.repeat(1585), line: '1922', to }, fakeDb(false))).length, 1600);
  await assert.rejects(withFirstTextPrefix({ body: 'x'.repeat(1586), line: '1922', to }, fakeDb(false)),
    (err) => err instanceof ValidationError && /1600/.test(err.fieldErrors.body) && err.message === err.fieldErrors.body);
});
