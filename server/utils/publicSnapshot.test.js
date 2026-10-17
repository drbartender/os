// server/utils/publicSnapshot.test.js
// The public copy of a pricing snapshot (spec 2026-10-16 section 4.3, plan
// decision 11). Pure: no DB. Synthetic labels and amounts.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSnapshotForPublic } = require('./publicSnapshot');

test('hidden data never survives; the package row is folded', () => {
  const snap = { total: 300, subtotal: 400, total_price_override: 300,
    package: { name: 'Test Package', base_cost: 350 }, staffing: { total: 50, actual: 1 },
    adjustments: [{ type: 'discount', label: 'Test secret', amount: 100, visible: false },
                  { type: 'surcharge', label: 'Test shown', amount: 5, visible: true }],
    breakdown: [{ label: 'Test secret', amount: -100 }], gratuity: { total: 0 }, display_labels: { gratuity: 'Tip' } };
  const out = sanitizeSnapshotForPublic(snap, { packageRowAmount: 295 });
  const json = JSON.stringify(out);
  assert.ok(!json.includes('Test secret'));
  assert.ok(!('subtotal' in out) && !('breakdown' in out) && !('total_price_override' in out));
  assert.deepEqual(out.adjustments.map(a => a.label), ['Test shown']);
  assert.equal(out.package.base_cost + out.staffing.total, 295);   // the old bundle draws the folded row
  assert.deepEqual(out.display_labels, { gratuity: 'Tip' });       // denylist keeps everything else
  assert.equal(snap.adjustments.length, 2);                         // input not mutated
});
test('no package row: base_cost removed, nothing invented', () => {
  const out = sanitizeSnapshotForPublic({ total: 10, package: { base_cost: 10 } }, { packageRowAmount: undefined });
  assert.ok(!('base_cost' in out.package));
});
test('null in, null out', () => assert.equal(sanitizeSnapshotForPublic(null, {}), null));

// ─── Beyond the plan's three ────────────────────────────────────────────────

test('anything that is not a snapshot object fails closed to null, never passes through', () => {
  // A denylist must never hand an unknown shape over whole: a JSON string or
  // an array would carry every hidden field it holds.
  const hidden = JSON.stringify({ total: 1, adjustments: [{ label: 'Test secret', visible: false }] });
  for (const bad of [hidden, [hidden], 42, true, undefined]) {
    assert.equal(sanitizeSnapshotForPublic(bad, { packageRowAmount: 1 }), null, String(bad));
  }
});

test('a visible line keeps only what a page reads; internal markers stay home', () => {
  const out = sanitizeSnapshotForPublic({
    total: 80,
    adjustments: [
      { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 14 },
      { type: 'surcharge', label: 'Test shown', amount: '3.50', visible: 'yes', note: 'Test internal note' },
    ],
  }, {});
  assert.deepEqual(out.adjustments, [
    { type: 'discount', label: 'Refund', amount: 20, visible: true },
    { type: 'surcharge', label: 'Test shown', amount: '3.50', visible: 'yes' },
  ]);
});

test('adjustments that are not a list are removed, not trusted', () => {
  const out = sanitizeSnapshotForPublic({ total: 5, adjustments: { 0: { label: 'Test secret', visible: false } } }, {});
  assert.ok(!('adjustments' in out));
  assert.ok(!JSON.stringify(out).includes('Test secret'));
});

test('the folded package price is whole cents, staffing taken off the cents way', () => {
  // 1234.63 - 0.07 is 1234.5600000000002 in floating point.
  const out = sanitizeSnapshotForPublic(
    { total: 1234.63, package: { name: 'Test Package', base_cost: 1300 }, staffing: { total: 0.07 } },
    { packageRowAmount: 1234.63 });
  assert.equal(out.package.base_cost, 1234.56);
  // A missing staffing block counts as 0.
  const bare = sanitizeSnapshotForPublic({ total: 99, package: { base_cost: 120 } }, { packageRowAmount: 99 });
  assert.equal(bare.package.base_cost, 99);
});

// ─── publicPriceView: the one call every public route makes (Task C4) ───────

test('publicPriceView: the folded rows and the matching public snapshot, from one builder call', () => {
  const { publicPriceView } = require('./publicSnapshot');
  const snap = {
    // subtotal 2400 + 210 + 99 + 90 = 2799; less the hidden 123.50 = 2675.50
    total: 2675.5, subtotal: 2799,
    package: { name: 'Test Package', base_cost: 2400 }, staffing: { total: 210, actual: 3 },
    bar_rental: { total: 0 }, addons: [{ name: 'Test Add-on', line_total: 99 }], syrups: { total: 90, packs: 2, singles: 0 },
    adjustments: [{ type: 'discount', label: 'Test secret', amount: 123.5, visible: false }],
    breakdown: [{ label: 'Test secret', amount: -123.5 }],
    gratuity: { total: 0 }, total_price_override: null,
  };
  const view = publicPriceView(snap, { packageName: 'Test Package' });
  const cents = view.rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  assert.equal(cents, 267550, 'the rows reach the page target');
  assert.equal(view.fold.applied, 'package');
  const pkgRow = view.rows.find((r) => r.key === 'package');
  assert.equal(pkgRow.amount, 2486.5);
  // The old bundle's package row from the public snapshot is the same figure.
  assert.equal(view.snapshot.package.base_cost + view.snapshot.staffing.total, pkgRow.amount);
  assert.ok(!JSON.stringify({ rows: view.rows, snapshot: view.snapshot }).includes('Test secret'));
  // The fold report is for the server only; the caller decides what leaves.
  assert.deepEqual(Object.keys(view).sort(), ['fold', 'rows', 'snapshot']);
});

test('publicPriceView: a snapshot with a gratuity targets the service part only', () => {
  const { publicPriceView } = require('./publicSnapshot');
  const view = publicPriceView({
    total: 740, package: { base_cost: 500 }, staffing: { total: 0 },
    adjustments: [{ type: 'discount', label: 'Test secret', amount: 60, visible: false }],
    gratuity: { total: 300 },
  }, { packageName: 'Test Package' });
  assert.deepEqual(view.rows, [{ key: 'package', label: 'Test Package', amount: 440 }]);
  assert.equal(view.snapshot.gratuity.total, 300);
});

test('publicPriceView: nothing usable in, nothing invented out', () => {
  const { publicPriceView } = require('./publicSnapshot');
  assert.deepEqual(publicPriceView(null, { packageName: 'x' }), { rows: [], fold: { applied: 'no_total', gapCents: 0, hiddenNetCents: 0, explainedCents: null, unexplainedCents: 0 }, snapshot: null });
  const empty = publicPriceView({}, {});
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.snapshot, {});
});
