'use strict';
// Pure tests for the editor PATCH guards (plan 2026-10-16 Task E1). No DB:
// every guard is a pure function of the body and the locked row. Legal-hold
// ids are ADDED through __setLegalHoldIdsForTest; nothing here reads or writes
// a real held booking.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const G = require('./patchGuards');

after(() => __setLegalHoldIdsForTest(null));

const AP = (amount, extra = {}) => ({
  type: 'discount', label: 'Agreed price adjustment', amount, visible: false, source: 'agreed_price', ...extra,
});
const REFUND = (refundId, amount = 20) => ({
  type: 'discount', label: 'Refund', amount, visible: true, source: 'refund', refund_id: refundId,
});

function throwsCode(fn, code) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, `expected a throw with code ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

// ─── parseProposalId ────────────────────────────────────────────────────────
test('parseProposalId reads plain decimal digits inside int4 and nothing else', () => {
  assert.equal(G.parseProposalId('123'), 123);
  assert.equal(G.parseProposalId('2147483647'), 2147483647);
  // Postgres reads '1_23' as 123 and '+0x7b' as 123; parseInt reads '1_23' as 1.
  for (const bad of ['1_23', '+0x7b', ' 123', '123 ', '0', '-1', '1.0', '1e3', '', '2147483648', '99999999999999999999', null, undefined, {}]) {
    const e = throwsCode(() => G.parseProposalId(bad), 'VALIDATION_ERROR');
    assert.equal(e.statusCode, 400);
    assert.deepEqual(e.fieldErrors, { id: 'Invalid proposal id.' }, `for ${JSON.stringify(bad)}`);
  }
});

// ─── assertNotLegalHold ─────────────────────────────────────────────────────
test('a held id is refused as a number or a string; any other id passes', () => {
  __setLegalHoldIdsForTest([999999]);
  try {
    for (const held of [999999, '999999']) {
      const e = throwsCode(() => G.assertNotLegalHold(held), 'LEGAL_HOLD');
      assert.equal(e.statusCode, 409);
      assert.equal(e.message, 'This booking is on legal hold and cannot be edited.');
    }
    assert.doesNotThrow(() => G.assertNotLegalHold(999998));
    assert.doesNotThrow(() => G.assertNotLegalHold('999998'));
  } finally {
    __setLegalHoldIdsForTest(null);
  }
  assert.doesNotThrow(() => G.assertNotLegalHold(999999), 'cleared test ids are no longer held');
});

// ─── canonicalLines ─────────────────────────────────────────────────────────
test('canonicalLines reads lines the way the validator coerces them', () => {
  const a = [{ type: 'discount', label: 'Test A', amount: '100', visible: true }];
  const b = [{ visible: true, amount: 100, label: 'Test A', type: 'discount' }];
  assert.equal(G.canonicalLines(a), G.canonicalLines(b), 'a numeric string and a number, and key order, are equal');
  assert.equal(G.canonicalLines([{ type: 'discount', label: 'Test A', amount: '100.00', visible: 1 }]), G.canonicalLines(b));
  assert.equal(G.canonicalLines([{ type: 'surcharge', amount: '', visible: false }]),
    G.canonicalLines([{ type: 'surcharge', label: null, amount: 0 }]), 'blank amount is 0, a missing label is blank, missing visible is hidden');
  assert.notEqual(G.canonicalLines(a), G.canonicalLines([{ ...b[0], amount: 100.01 }]));
  assert.notEqual(G.canonicalLines(a), G.canonicalLines([{ ...b[0], visible: false }]));
  assert.notEqual(G.canonicalLines([AP(162)]), G.canonicalLines([{ ...AP(162), source: undefined }]), 'the marker counts');
  assert.notEqual(G.canonicalLines([REFUND(14)]), G.canonicalLines([REFUND(15)]), 'the refund id counts');
  assert.equal(G.canonicalLines(null), G.canonicalLines([]));
  assert.equal(G.canonicalLines(undefined), '[]');
  assert.notEqual(G.canonicalLines([a[0], AP(5)]), G.canonicalLines([AP(5), a[0]]), 'order is part of the lines');
});

// ─── assertLinesFresh ───────────────────────────────────────────────────────
test('lines fresh: unchanged lines need no token; changed lines need the current one', () => {
  const stored = [{ type: 'discount', label: 'Test A', amount: '100.00', visible: true }];
  const old = { adjustments: stored };
  const TOKEN = 'token-now';
  // Unchanged (another representation of the same lines), no token.
  assert.doesNotThrow(() => G.assertLinesFresh(
    { adjustments: [{ visible: true, amount: 100, label: 'Test A', type: 'discount' }] }, old, TOKEN));
  // No adjustments key at all (a partial PATCH).
  assert.doesNotThrow(() => G.assertLinesFresh({ guest_count: 120 }, old, TOKEN));
  const changed = { adjustments: [...stored, { type: 'discount', label: 'Test B', amount: 5, visible: true }] };
  assert.doesNotThrow(() => G.assertLinesFresh({ ...changed, adjustments_token: TOKEN }, old, TOKEN));
  for (const token of [undefined, null, '', 'token-before']) {
    const e = throwsCode(() => G.assertLinesFresh({ ...changed, adjustments_token: token }, old, TOKEN), 'STALE_EDIT');
    assert.equal(e.statusCode, 409);
    assert.equal(e.message, 'This booking changed since you opened it. Reload to see the latest.');
  }
  // A NULL column reads as no lines.
  assert.doesNotThrow(() => G.assertLinesFresh({ adjustments: [] }, { adjustments: null }, TOKEN));
  throwsCode(() => G.assertLinesFresh({ adjustments: [AP(1)] }, { adjustments: null }, TOKEN), 'STALE_EDIT');
});

// ─── assertOverrideUnchanged ────────────────────────────────────────────────
test('the override: equal in cents passes, any change is refused, null and absent pass', () => {
  const stored = { total_price_override: '3373.00' };
  assert.doesNotThrow(() => G.assertOverrideUnchanged({ total_price_override: 3373 }, stored));
  assert.doesNotThrow(() => G.assertOverrideUnchanged({ total_price_override: '3373.00' }, stored));
  assert.doesNotThrow(() => G.assertOverrideUnchanged({ total_price_override: '3373' }, stored));
  assert.doesNotThrow(() => G.assertOverrideUnchanged({ total_price_override: null }, stored), 'null clears');
  assert.doesNotThrow(() => G.assertOverrideUnchanged({}, stored), 'absent carries forward');
  assert.doesNotThrow(() => G.assertOverrideUnchanged({ total_price_override: null }, { total_price_override: null }));
  assert.doesNotThrow(() => G.assertOverrideUnchanged({}, { total_price_override: null }));
  const refused = [
    [{ total_price_override: 3373.01 }, stored],
    [{ total_price_override: '3372.99' }, stored],
    [{ total_price_override: 0 }, { total_price_override: null }], // a stored NULL against a body 0 DIFFERS
    [{ total_price_override: 1500 }, { total_price_override: null }],
    [{ total_price_override: '' }, { total_price_override: '0.00' }], // blank is no price
    [{ total_price_override: 'abc' }, stored],
    [{ total_price_override: true }, stored],
  ];
  for (const [body, row] of refused) {
    const e = throwsCode(() => G.assertOverrideUnchanged(body, row), 'VALIDATION_ERROR');
    assert.deepEqual(e.fieldErrors, { total_price_override: 'Price overrides are retired. Use Set agreed price.' },
      JSON.stringify(body));
  }
});

// ─── normalizeAdjustmentsOrThrow ────────────────────────────────────────────
test('adjustments are normalized, a bad line is refused naming the field, undefined passes through', () => {
  assert.equal(G.normalizeAdjustmentsOrThrow(undefined), undefined);
  assert.deepEqual(
    G.normalizeAdjustmentsOrThrow([{ type: 'discount', label: '', amount: '', visible: true, extra: 'drop me' }]),
    [{ type: 'discount', label: '', amount: 0, visible: true }],
  );
  for (const bad of [null, 'nope', [{ type: 'gift', amount: 1 }], [{ type: 'discount', amount: -1 }], [{ type: 'discount', amount: 1.005 }]]) {
    const e = throwsCode(() => G.normalizeAdjustmentsOrThrow(bad), 'VALIDATION_ERROR');
    assert.equal(typeof e.fieldErrors.adjustments, 'string', JSON.stringify(bad));
    assert.ok(e.fieldErrors.adjustments.length > 0);
  }
});

// ─── assertRefundMarkersBound ───────────────────────────────────────────────
test('refund markers: a save keeps the refund lines it was given and never mints or repeats one', () => {
  const old = { adjustments: [{ type: 'discount', label: 'Test A', amount: 10, visible: true }, REFUND(14), REFUND(15, 5)] };
  // Kept as stored, lowered, relabeled, or removed: all pass (the editor confirms a lowering).
  assert.doesNotThrow(() => G.assertRefundMarkersBound(old.adjustments, old));
  assert.doesNotThrow(() => G.assertRefundMarkersBound([REFUND(14, 1), { ...REFUND(15, 5), label: 'Test refund' }], old));
  assert.doesNotThrow(() => G.assertRefundMarkersBound([], old));
  assert.doesNotThrow(() => G.assertRefundMarkersBound(undefined, old), 'no adjustments key');
  const minted = throwsCode(() => G.assertRefundMarkersBound([REFUND(16)], old), 'VALIDATION_ERROR');
  assert.equal(typeof minted.fieldErrors.adjustments, 'string');
  const repeated = throwsCode(() => G.assertRefundMarkersBound([REFUND(14), REFUND(14, 3)], old), 'VALIDATION_ERROR');
  assert.equal(typeof repeated.fieldErrors.adjustments, 'string');
  // A refund_id on a line the stored row holds only as an ordinary line is not bound.
  const notRefund = { adjustments: [{ type: 'discount', label: 'Test A', amount: 10, visible: true, refund_id: 17 }] };
  throwsCode(() => G.assertRefundMarkersBound([REFUND(17)], notRefund), 'VALIDATION_ERROR');
  // No stored lines at all: any refund marker is minted.
  throwsCode(() => G.assertRefundMarkersBound([REFUND(14)], { adjustments: null }), 'VALIDATION_ERROR');
});

// ─── adjustmentsAudit ───────────────────────────────────────────────────────
test('the audit carries both arrays only when the lines changed', () => {
  const stored = [{ type: 'discount', label: 'Test A', amount: '100.00', visible: true }];
  assert.deepEqual(G.adjustmentsAudit({ adjustments: stored }, [{ type: 'discount', label: 'Test A', amount: 100, visible: true }]), {});
  const next = [...stored, AP(162)];
  assert.deepEqual(G.adjustmentsAudit({ adjustments: stored }, next), { old_adjustments: stored, new_adjustments: next });
  assert.deepEqual(G.adjustmentsAudit({ adjustments: null }, [AP(5)]), { old_adjustments: [], new_adjustments: [AP(5)] });
});

// ─── linesToWrite ───────────────────────────────────────────────────────────
// A save that leaves the lines as stored writes them back byte for byte, so
// their md5 token holds and no other open tab is refused for a respelling
// (prod keeps most amounts as numeric strings; validation would write numbers).
test('linesToWrite keeps the stored lines when the body leaves them as they are', () => {
  const stored = [{ type: 'discount', label: 'Test A', amount: '25.00', visible: true }];
  const old = { adjustments: stored };
  assert.equal(G.linesToWrite(undefined, old), stored, 'no adjustments key: the stored lines');
  const sameValues = G.normalizeAdjustmentsOrThrow([{ type: 'discount', label: 'Test A', amount: 25, visible: true }]);
  assert.equal(G.linesToWrite(sameValues, old), stored, 'the same lines in another spelling: the stored ones, as stored');
  const changed = G.normalizeAdjustmentsOrThrow([{ type: 'discount', label: 'Test A', amount: 30, visible: true }]);
  assert.equal(G.linesToWrite(changed, old), changed, 'changed lines: the validated body');
  assert.deepEqual(G.linesToWrite(undefined, { adjustments: null }), []);
  assert.deepEqual(G.linesToWrite([], { adjustments: null }), []);
});

// ─── fix round 1 ────────────────────────────────────────────────────────────
test('assertLinesFresh fails closed when the route hands it no current token', () => {
  for (const missing of [undefined, null, '']) {
    assert.throws(() => G.assertLinesFresh({ adjustments: [AP(1)] }, { adjustments: [] }, missing), /no current token/);
    assert.throws(() => G.assertLinesFresh({ adjustments: [] }, { adjustments: [] }, missing), /no current token/);
  }
  assert.doesNotThrow(() => G.assertLinesFresh({ guest_count: 5 }, { adjustments: [] }, undefined), 'no lines in the body: nothing to guard');
});

test('the override compare refuses a value finer than a cent (NUMERIC(10,2) would round it away from the stored cent)', () => {
  for (const [sent, stored] of [['1.005', '1.00'], ['1024.215', '1024.21'], [1024.215, '1024.21']]) {
    const e = throwsCode(() => G.assertOverrideUnchanged({ total_price_override: sent }, { total_price_override: stored }), 'VALIDATION_ERROR');
    assert.deepEqual(e.fieldErrors, { total_price_override: 'Price overrides are retired. Use Set agreed price.' });
  }
  assert.doesNotThrow(() => G.assertOverrideUnchanged({ total_price_override: 1024.21 }, { total_price_override: '1024.21' }));
});

test('overrideToWrite writes the stored override, never the body\'s spelling; null clears', () => {
  const stored = { total_price_override: '3373.00' };
  assert.equal(G.overrideToWrite({ total_price_override: 3373 }, stored), '3373.00');
  assert.equal(G.overrideToWrite({ total_price_override: '3373.004' }, stored), '3373.00');
  assert.equal(G.overrideToWrite({}, stored), '3373.00');
  assert.equal(G.overrideToWrite({ total_price_override: null }, stored), null);
  assert.equal(G.overrideToWrite({}, { total_price_override: null }), null);
});

test('adjustmentsColumn leaves the column alone (null) when the lines are the stored ones', () => {
  const stored = [{ type: 'discount', label: 'Test A', amount: 162.5, visible: true }];
  assert.equal(G.adjustmentsColumn(stored, { adjustments: stored }), null);
  assert.equal(G.adjustmentsColumn([{ ...stored[0], amount: '162.50' }], { adjustments: stored }), null);
  assert.equal(G.adjustmentsColumn([], { adjustments: null }), null);
  const changed = [{ ...stored[0], amount: 100 }];
  assert.equal(G.adjustmentsColumn(changed, { adjustments: stored }), JSON.stringify(changed));
  assert.equal(G.adjustmentsColumn([], { adjustments: stored }), '[]', 'emptying the lines is a write');
});
