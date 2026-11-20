// server/utils/legalHold.test.js
'use strict';
// The legal-hold seam (spec 2026-10-16 section 5.3, plan decision 7; Task A2
// amended 2026-10-17 from the lane review). Pure: no database. A suite that
// needs a held booking ADDS a synthetic id through __setLegalHoldIdsForTest;
// no suite reads or writes a real held booking, and no test list can unhold one.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  isLegalHold, heldProposalIds, heldClientIds, holdExclusion, HELD_CLIENT_IDS_SQL, __setLegalHoldIdsForTest,
} = require('./legalHold');
const sweep = require('./staleProposalSweep');
const { LEGAL_HOLD_PROPOSAL_IDS } = sweep;

afterEach(() => __setLegalHoldIdsForTest(null));

test('the default list is the sweep constant, read as a number or plain digits', () => {
  assert.equal(isLegalHold(600), true);
  assert.equal(isLegalHold('600'), true);
  assert.equal(isLegalHold('0600'), true); // Postgres reads it as 600 too
  for (const id of LEGAL_HOLD_PROPOSAL_IDS) {
    assert.equal(isLegalHold(id), true);
    assert.equal(isLegalHold(String(id)), true);
  }
  assert.equal(isLegalHold(999999), false);
  assert.equal(isLegalHold('999999'), false);
  assert.equal(isLegalHold(601), false);
});

test('an id the seam cannot read plainly is held (fails closed)', () => {
  // Postgres 17 reads '6_00', '+0x258' and '0x2_58' as 600 where Number() gives
  // NaN; every spelling here is either that or no plain id at all.
  const unreadable = ['6_00', '60_0', '+0x258', '0x2_58', '0x258', ' 600', '600 ', '+600',
    '600.0', '6e2', '6_01', '-1', '', 'abc', '0', '9007199254740993',
    null, undefined, NaN, Infinity, -1, 0, 1.5, 2 ** 53, {}, [], [600], true, 600n];
  for (const id of unreadable) {
    assert.equal(isLegalHold(id), true, `${typeof id} ${String(id)}`);
  }
});

test('test ids add to the real list; null clears them; the real list stays held', () => {
  __setLegalHoldIdsForTest([999999, '999998']);
  assert.equal(isLegalHold(999999), true);
  assert.equal(isLegalHold('999999'), true);
  assert.equal(isLegalHold(999998), true);
  assert.equal(isLegalHold(600), true); // a test list never unholds a real hold
  assert.equal(isLegalHold('600'), true);
  assert.equal(isLegalHold(999997), false);
  __setLegalHoldIdsForTest([999997]); // a later call replaces the test ids
  assert.equal(isLegalHold(999997), true);
  assert.equal(isLegalHold(999999), false);
  __setLegalHoldIdsForTest([]);
  assert.equal(isLegalHold(600), true);
  __setLegalHoldIdsForTest(null);
  assert.equal(isLegalHold(999997), false);
  assert.equal(isLegalHold(600), true);
});

test('the setter keeps its own copy of the list', () => {
  const ids = [999999];
  __setLegalHoldIdsForTest(ids);
  ids.push(999998);
  assert.equal(isLegalHold(999998), false);
});

test('the setter refuses production, anything but a list or null, and an unreadable id', () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => __setLegalHoldIdsForTest([999999]), /production/);
    assert.throws(() => __setLegalHoldIdsForTest(null), /production/);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
  assert.equal(isLegalHold(999999), false); // the refused call added nothing
  for (const notAList of ['999999', undefined, 999999]) {
    assert.throws(() => __setLegalHoldIdsForTest(notAList), TypeError, String(notAList));
  }
  for (const badId of ['6_00', ' 999999', 0, -1, NaN]) {
    assert.throws(() => __setLegalHoldIdsForTest([badId]), TypeError, String(badId));
  }
  assert.equal(isLegalHold(999999), false);
});

test('heldProposalIds: the real list plus the test ids, as integers, read at call time', () => {
  const real = LEGAL_HOLD_PROPOSAL_IDS.map(Number);
  assert.deepEqual(heldProposalIds(), real);
  assert.ok(heldProposalIds().includes(600));
  __setLegalHoldIdsForTest([999999, '999998']);
  const withTest = heldProposalIds();
  assert.deepEqual(withTest, [...real, 999999, 999998]);
  assert.ok(withTest.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0));
  withTest.push(999997); // a caller's copy, never the list itself
  assert.equal(heldProposalIds().includes(999997), false);
  __setLegalHoldIdsForTest(null);
  assert.deepEqual(heldProposalIds(), real);
});

test('heldProposalIds fails closed: a missing list or an id it cannot bind as an integer throws', () => {
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  try {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = undefined;
    assert.throws(() => heldProposalIds(), /LEGAL_HOLD_PROPOSAL_IDS/);
    // 2 ** 31 is a safe integer but not a Postgres integer: bound as int[] it
    // would fail inside the job's query instead of before it.
    for (const bad of [[600, '6_00'], [600, 0], [600, -1], [600, 1.5], [600, null], [600, '600 '], [600, 2 ** 31]]) {
      sweep.LEGAL_HOLD_PROPOSAL_IDS = bad;
      assert.throws(() => heldProposalIds(), /LEGAL_HOLD_PROPOSAL_IDS/, JSON.stringify(bad));
    }
    sweep.LEGAL_HOLD_PROPOSAL_IDS = ['600', 600]; // plain digits read as the integer; one id once
    assert.deepEqual(heldProposalIds(), [600]);
  } finally {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = real;
  }
  assert.deepEqual(heldProposalIds(), LEGAL_HOLD_PROPOSAL_IDS.map(Number));
});

test('isLegalHold fails closed on a malformed list exactly as heldProposalIds does: an unreadable entry throws', () => {
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  try {
    for (const bad of [[600, '6_00'], [600, 0], [600, -1], [600, 1.5], [600, null], [600, '600 '], ['abc']]) {
      sweep.LEGAL_HOLD_PROPOSAL_IDS = bad;
      const what = JSON.stringify(bad);
      // Never "not held" off a list it cannot read: the old seam answered
      // false for 999999 here, while heldProposalIds threw.
      assert.throws(() => isLegalHold(999999), /LEGAL_HOLD_PROPOSAL_IDS/, what);
      assert.throws(() => isLegalHold(600), /LEGAL_HOLD_PROPOSAL_IDS/, what);
      assert.throws(() => heldProposalIds(), /LEGAL_HOLD_PROPOSAL_IDS/, what);
    }
    sweep.LEGAL_HOLD_PROPOSAL_IDS = ['600']; // plain digits are a readable entry
    assert.equal(isLegalHold(600), true);
    assert.equal(isLegalHold(601), false);
  } finally {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = real;
  }
  assert.equal(isLegalHold(600), true);
});

// ─── heldClientIds and holdExclusion (spec 2026-11-19 law 1) ───
// Pure: a stub db stands in for the pool, so no suite queries a real held row.
function stubDb(answer) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (answer instanceof Error) throw answer;
      return { rows: typeof answer === 'function' ? answer(params) : answer };
    },
  };
}

test('heldClientIds: the held proposals\' clients, one query with the held list bound as one int[]', async () => {
  __setLegalHoldIdsForTest([424242]);
  const db = stubDb([{ client_id: 31337 }, { client_id: '31338' }, { client_id: 31337 }]);
  assert.deepEqual(await heldClientIds(db), [31337, 31338]);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].sql, HELD_CLIENT_IDS_SQL);
  assert.deepEqual(db.calls[0].params, [heldProposalIds()]);
  assert.ok(db.calls[0].params[0].includes(424242) && LEGAL_HOLD_PROPOSAL_IDS.every((id) => db.calls[0].params[0].includes(Number(id))));
  assert.match(HELD_CLIENT_IDS_SQL, /FROM proposals\s+WHERE id = ANY\(\$1::int\[\]\) AND client_id IS NOT NULL/);
  assert.deepEqual(await heldClientIds(stubDb([])), [], 'a held id with no proposals row holds no client');
});

test('heldClientIds fails closed: a missing or malformed list throws before any query', async () => {
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  try {
    for (const bad of [undefined, null, 'nope', [600, 'x'], [600, -1], [0]]) {
      sweep.LEGAL_HOLD_PROPOSAL_IDS = bad;
      const db = stubDb([{ client_id: 31337 }]);
      await assert.rejects(heldClientIds(db), /LEGAL_HOLD_PROPOSAL_IDS/, JSON.stringify(bad));
      await assert.rejects(holdExclusion(db), /LEGAL_HOLD_PROPOSAL_IDS/, JSON.stringify(bad));
      assert.equal(db.calls.length, 0, 'nothing is read under a list it cannot read');
    }
  } finally {
    sweep.LEGAL_HOLD_PROPOSAL_IDS = real;
  }
});

test('heldClientIds fails closed: a failed read or a client id that is not a positive integer throws', async () => {
  await assert.rejects(heldClientIds(stubDb(new Error('connection reset'))), /connection reset/);
  for (const bad of [null, 0, -4, '7_0', 'x', 2 ** 31, 1.5]) {
    await assert.rejects(heldClientIds(stubDb([{ client_id: 31337 }, { client_id: bad }])), /not a positive integer/, String(bad));
  }
  await assert.rejects(heldClientIds({ query: async () => ({}) }), /could not be read/);
});

test('holdExclusion: both lists, read at call time', async () => {
  __setLegalHoldIdsForTest([424242]);
  const db = stubDb((params) => (params[0].includes(424242) ? [{ client_id: 31337 }] : []));
  assert.deepEqual(await holdExclusion(db), { proposalIds: heldProposalIds(), clientIds: [31337] });
  __setLegalHoldIdsForTest(null);
  assert.deepEqual(await holdExclusion(db), { proposalIds: LEGAL_HOLD_PROPOSAL_IDS.map(Number), clientIds: [] });
});
