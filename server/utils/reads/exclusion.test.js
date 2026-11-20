// readExclusion and readLookupId (spec 2026-11-19 law 1): a hold exclusion
// reaches SQL as two clean int lists or not at all, and a malformed one
// throws rather than excluding nothing. Pure: no database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readExclusion, readLookupId } = require('./exclusion');

test('absent is null; present is two clean, deduplicated int lists', () => {
  assert.equal(readExclusion(undefined), null);
  assert.equal(readExclusion(null), null);
  assert.deepEqual(readExclusion({ proposalIds: [12, '12', 13], clientIds: [] }), { proposalIds: [12, 13], clientIds: [] });
});

test('any other shape throws (fails closed)', () => {
  for (const bad of [{}, [], 'x', 0, true, { proposalIds: [1] }, { clientIds: [1] }, { proposalIds: 'x', clientIds: [] },
    { proposalIds: [0], clientIds: [] }, { proposalIds: [-1], clientIds: [] }, { proposalIds: [1.5], clientIds: [] },
    { proposalIds: ['6_00'], clientIds: [] }, { proposalIds: ['+1'], clientIds: [] }, { proposalIds: [2 ** 31], clientIds: [] },
    { proposalIds: [], clientIds: [null] }]) {
    assert.throws(() => readExclusion(bad), TypeError, JSON.stringify(bad));
  }
});

test('a lookup id reads only as a positive integer in the Postgres range', () => {
  assert.deepEqual([readLookupId(7), readLookupId('7'), readLookupId('007')], [7, 7, 7]);
  for (const bad of ['6_00', '+7', ' 7', '7.0', '0x7', 0, -7, 2 ** 31, null, undefined, {}, 7.5]) {
    assert.equal(readLookupId(bad), null, String(bad));
  }
});
