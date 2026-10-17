// server/utils/adjustmentRules.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const R = require('./adjustmentRules');
const { SHARED_GRATUITY_LABEL, GRATUITY_LABEL } = require('./gratuityLabels');

test('coercions match the engine (pricingEngine.js L476-479)', () => {
  assert.equal(R.adjVisible({ visible: true }), true);
  assert.equal(R.adjVisible({}), false);               // missing = hidden
  assert.equal(R.adjVisible({ visible: 'yes' }), true);
  assert.equal(R.adjAmount({ amount: '12.5' }), 12.5);
  assert.equal(R.adjAmount({ amount: -7 }), 7);
  assert.equal(R.adjAmount({ amount: 'x' }), 0);
  assert.equal(R.adjSignedCents({ type: 'discount', amount: 162 }), -16200);
  assert.equal(R.adjSignedCents({ type: 'surcharge', amount: '0.1' }), 10);
  assert.equal(R.adjSignedCents({ type: 'weird', amount: 5 }), 500); // non-discount = surcharge
  // A $0 discount (the editor's fresh "+ Discount" line) is 0, never -0: strict
  // asserts compare with Object.is and Intl currency formatting prints "-$0.00".
  assert.equal(R.adjSignedCents({ type: 'discount', amount: '' }), 0);
  assert.equal(R.adjLabel({ type: 'discount' }), 'Discount');
  assert.equal(R.adjLabel({ type: 'surcharge', label: '' }), 'Surcharge');
  assert.equal(R.adjLabel({ type: 'discount', label: 'Test A' }), 'Test A');
});

test('protection is by source, never by label', () => {
  assert.equal(R.isProtectedAdjustment({ source: 'refund', label: 'Anything' }), true);
  assert.equal(R.isProtectedAdjustment({ source: 'agreed_price' }), true);
  assert.equal(R.isProtectedAdjustment({ label: 'Refund' }), false);
  assert.equal(R.isProtectedAdjustment(null), false);
});

test('validateAdjustments normalizes and keeps only known keys', () => {
  const { value, error } = R.validateAdjustments([
    { type: 'discount', label: 'Test A', amount: '100.25', visible: 0, extra: 'drop me' },
    { type: 'discount', label: '', amount: '', visible: true },                // the editor's fresh line
    { type: 'surcharge', label: '', amount: 5, visible: true, source: 'agreed_price' },
    { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 14 },
  ]);
  assert.equal(error, null);
  assert.deepEqual(value, [
    { type: 'discount', label: 'Test A', amount: 100.25, visible: false },
    { type: 'discount', label: '', amount: 0, visible: true },
    { type: 'surcharge', label: '', amount: 5, visible: true, source: 'agreed_price' },
    { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 14 },
  ]);
});

test('validateAdjustments refuses bad input with one message', () => {
  const bad = [
    'not an array',
    Array.from({ length: 51 }, () => ({ type: 'discount', label: '', amount: 1, visible: true })),
    [{ type: 'gift', label: '', amount: 1, visible: true }],
    [{ type: 'discount', label: '', amount: -1, visible: true }],
    [{ type: 'discount', label: '', amount: 1000000, visible: true }],
    [{ type: 'discount', label: '', amount: 'abc', visible: true }],
    [{ type: 'discount', label: 'x'.repeat(256), amount: 1, visible: true }],
    [{ type: 'discount', label: 7, amount: 1, visible: true }],
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'other' }],
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'refund' }],            // refund needs refund_id
    [{ type: 'discount', label: '', amount: 1, visible: true, refund_id: 3 }],                // refund_id needs source refund
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'refund', refund_id: 0 }],
    // refund_id past int4 (proposal_refunds.id is SERIAL)
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'refund', refund_id: 2147483648 }],
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'refund', refund_id: 1e21 }],
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'refund', refund_id: 2 ** 53 + 2 }],
    // finer than a cent: refused, never rounded
    [{ type: 'discount', label: '', amount: 0.005, visible: true }],
    [{ type: 'discount', label: '', amount: '12.125', visible: true }],
    [{ type: 'surcharge', label: '', amount: 0.001, visible: true }],
  ];
  for (const input of bad) {
    const { value, error } = R.validateAdjustments(input);
    assert.equal(value, null);
    assert.equal(typeof error, 'string');
  }
  assert.equal(R.validateAdjustments([{ type: 'discount', label: '', amount: 0.005, visible: true }]).error,
    'A price adjustment amount must be in whole cents.');
});

test('validateAdjustments keeps whole cents as sent and takes refund_id up to int4', () => {
  const { value, error } = R.validateAdjustments([
    { type: 'discount', label: '', amount: 12.13, visible: true },
    { type: 'discount', label: '', amount: '0.10', visible: true },
    { type: 'surcharge', label: '', amount: 0.1 + 0.2, visible: true },      // float noise of whole cents
    { type: 'discount', label: 'Refund', amount: 1, visible: true, source: 'refund', refund_id: 2147483647 },
  ]);
  assert.equal(error, null);
  assert.deepEqual(value.map((l) => l.amount), [12.13, 0.1, 0.1 + 0.2, 1]); // nothing rounded
  assert.equal(value[3].refund_id, 2147483647);
});

test('isWholeCents: no part finer than a cent, float noise tolerated, nothing rounded', () => {
  for (const yes of [0, 12, 12.1, 12.13, '12.13', '0.10', '', 0.1 + 0.2, 999999.99, -3.5]) {
    assert.equal(R.isWholeCents(yes), true, String(yes));
  }
  for (const no of [0.005, 0.001, 12.125, '12.125', 0.015, -0.125, 'abc', NaN, Infinity, undefined]) {
    assert.equal(R.isWholeCents(no), false, String(no));
  }
});

test('client twin behaves the same', async () => {
  const C = await import(pathToFileURL(path.join(__dirname, '../../client/src/utils/adjustmentRules.js')).href);
  for (const k of ['AGREED_PRICE_LABEL', 'REFUND_LABEL', 'MAX_ADJUSTMENTS', 'MAX_ADJUSTMENT_DOLLARS', 'MAX_ADJUSTMENT_LABEL']) {
    // eslint-disable-next-line security/detect-object-injection -- k is one of this suite's own literal export names
    assert.deepEqual(C[k], R[k], k);
  }
  assert.deepEqual([...C.ADJUSTMENT_SOURCES], [...R.ADJUSTMENT_SOURCES]);
  const cases = [{}, { visible: true, type: 'discount', amount: '3.333', label: '' },
    { type: 'surcharge', amount: -2, label: 'Test B', source: 'refund' }, { type: 'x', amount: null },
    { type: 'discount', amount: '' }, null,
    // Each of these catches a one-token drift of one twin (code review, 2026-10-17):
    { visible: 'yes' }, { visible: 'false' }, { visible: 1 },                  // visible === true
    { amount: 'x' }, { amount: '12abc' }, { amount: '0x10' },                  // parseFloat for Number
    { type: 'weird', amount: 5 }, { type: 'Discount', amount: '25', visible: 'true' }, // any non-surcharge, or a case-folded type, read as a discount
    { type: 'discount', amount: 0.125 },                                        // rounding the signed dollars
    { source: 'REFUND' }, { source: 'other' }, { source: 'agreed_price' },     // a case-folded or widened source
  ];
  for (const c of cases) {
    for (const fn of ['adjVisible', 'adjAmount', 'adjSignedCents', 'adjLabel', 'isProtectedAdjustment']) {
      // eslint-disable-next-line security/detect-object-injection -- fn is one of this suite's own literal export names
      assert.deepEqual(C[fn](c), R[fn](c), `${fn} ${JSON.stringify(c)}`);
    }
  }
  const amounts = [0, 12.13, '12.13', 0.005, '12.125', 0.1 + 0.2, '', 'abc', null, undefined, -0.125, 999999.995];
  for (const a of amounts) {
    assert.deepEqual(C.isWholeCents(a), R.isWholeCents(a), `isWholeCents ${String(a)}`);
  }
});

// Placement (Task A2): the engine pushes adjustment rows after every other
// service row and the client gratuity row LAST, only when it is above zero
// (pricingEngine.js breakdown). A server-written line sits where the engine
// would have put it.
const placementRows = () => [
  { label: 'Test Package (4hrs, 80 guests)', amount: 2240 },
  { label: SHARED_GRATUITY_LABEL, amount: 100 },   // inside staffing
  { label: 'Test Addon', amount: 200 },
  { label: SHARED_GRATUITY_LABEL, amount: 100 },   // the additional-bartender add-on
  { label: 'Test discount A', amount: -50 },       // an existing adjustment
];
const writtenRow = { label: 'Refund', amount: -20, visible: true };

test('a written line goes before the client gratuity row when that row is last and above zero', () => {
  const snapshot = { breakdown: [...placementRows(), { label: GRATUITY_LABEL, amount: 40 }], gratuity: { total: 40 } };
  const out = R.insertAdjustmentBreakdownRow(snapshot, writtenRow);
  assert.equal(out.length, 7);
  assert.equal(out[5], writtenRow);
  assert.deepEqual(out[6], { label: GRATUITY_LABEL, amount: 40 });
  assert.deepEqual(out.slice(0, 5), placementRows());
  assert.notEqual(out, snapshot.breakdown);       // a new array
  assert.equal(snapshot.breakdown.length, 6);     // the snapshot is untouched
  assert.equal(snapshot.breakdown[5].label, GRATUITY_LABEL);
});

test('with no client gratuity the written line appends', () => {
  const snapshot = { breakdown: placementRows(), gratuity: { total: 0 } };
  const out = R.insertAdjustmentBreakdownRow(snapshot, writtenRow);
  assert.equal(out.length, 6);
  assert.equal(out[5], writtenRow);
  assert.equal(snapshot.breakdown.length, 5);
});

test('an admin adjustment labeled Gratuity is never taken for the client row', () => {
  // Not last: matching on the label alone would put the line at index 1.
  const notLast = {
    breakdown: [{ label: 'Test Package', amount: 500 }, { label: GRATUITY_LABEL, amount: -10 },
      { label: 'Test surcharge C', amount: 5 }],
    gratuity: { total: 40 },
  };
  const out1 = R.insertAdjustmentBreakdownRow(notLast, writtenRow);
  assert.equal(out1.length, 4);
  assert.equal(out1[3], writtenRow);
  // Last, but the client gratuity is 0 (or missing), so the engine wrote no
  // client row and this one is the admin's line.
  for (const gratuity of [{ total: 0 }, undefined]) {
    const lastNoGratuity = { breakdown: [{ label: 'Test Package', amount: 500 }, { label: GRATUITY_LABEL, amount: -10 }], gratuity };
    const out2 = R.insertAdjustmentBreakdownRow(lastNoGratuity, writtenRow);
    assert.equal(out2.length, 3);
    assert.equal(out2[2], writtenRow);
  }
});

test('a snapshot with no breakdown yields just the row', () => {
  assert.deepEqual(R.insertAdjustmentBreakdownRow({}, writtenRow), [writtenRow]);
  assert.deepEqual(R.insertAdjustmentBreakdownRow(null, writtenRow), [writtenRow]);
  assert.deepEqual(R.insertAdjustmentBreakdownRow({ breakdown: null, gratuity: { total: 40 } }, writtenRow), [writtenRow]);
});
