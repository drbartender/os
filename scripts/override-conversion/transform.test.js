'use strict';
// The conversion transform (plan 2026-10-16-price-override-removal, Task V2;
// spec 8.2-8.4). Pure: synthetic rows priced by the real engine, no DB. One
// test per shape. Legal-hold ids are synthetic (the param, or the seam's test
// setter); nothing here uses a real held booking.
//   node --test scripts/override-conversion/transform.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { calculateProposal } = require('../../server/utils/pricingEngine');
const { GRATUITY_LABEL } = require('../../server/utils/gratuityLabels');
const { validateAdjustments, AGREED_PRICE_LABEL, REFUND_LABEL } = require('../../server/utils/adjustmentRules');
const { __setLegalHoldIdsForTest } = require('../../server/utils/legalHold');
const { planConversion } = require('./transform');

after(() => __setLegalHoldIdsForTest(null));

const PKG = {
  id: 9001, slug: 'test-pkg', name: 'Test Package', category: 'hosted', pricing_type: 'per_guest',
  base_rate_4hr: 30, base_rate_4hr_small: 35, extra_hour_rate: 6, extra_hour_rate_small: 7, min_guests: 50,
  guests_per_bartender: 100, bar_type: 'full_bar', includes: [], first_bar_fee: 75, additional_bar_fee: 125,
};
const cents = (n) => Math.round(Number(n) * 100);
const dollars = (c) => (c / 100).toFixed(2);
const price = ({ adjustments = [], override = null, gratuityRate = 0, pkg = PKG } = {}) => JSON.parse(JSON.stringify(
  calculateProposal({
    pkg, guestCount: 120, durationHours: 4, numBars: 1, numBartenders: null, addons: [], syrupSelections: [],
    adjustments, totalPriceOverride: override, gratuityRate, tipJar: true, gratuityFloorRate: null,
  })));
const service = (s) => cents(s.total) - cents((s.gratuity && s.gratuity.total) || 0);

let nextId = 1000;
function row({
  status = 'archived', override = null, adjustments = [], snapshot, totalPrice, refunds = [], invoices = [], crs = [],
} = {}) {
  const snap = snapshot || price({ adjustments, override });
  return {
    id: nextId++, status,
    total_price: totalPrice !== undefined ? totalPrice : dollars(cents(snap.total)),
    amount_paid: '0.00',
    total_price_override: override === null ? null : dollars(cents(override)),
    adjustments, adjustments_type: adjustments === null ? null : 'array', pricing_snapshot: snap,
    money_md5: 'f'.repeat(32), refunds, addons: [], additional_services_invoices: invoices, pending_change_requests: crs,
  };
}
const refund = (id, dropCents, { scope = 'contract', at = '2026-09-01T12:00:00Z', fromCents = 500000 } = {}) => ({
  id, amount: dropCents, total_scope: scope, created_at: at,
  total_price_before: dollars(fromCents), total_price_after: dollars(fromCents - dropCents),
});
const freshFor = (r, opts) => {
  const snapshot = price(opts);
  return { id: r.id, money_md5: r.money_md5, freshServiceCents: service(snapshot), snapshot };
};
const plan = (rows, fresh = [], legalHoldIds = []) => planConversion({ rows, fresh, legalHoldIds });
const only = (out, id) => out.changes.find((c) => c.id === id);
const nowhere = (out, id) => !JSON.stringify(out).includes(`"id":${id},`) && !JSON.stringify(out).includes(`"proposalId":${id},`);

test('the legal-hold list is required', () => {
  assert.throws(() => planConversion({ rows: [], fresh: [] }), /legalHoldIds/);
});

test('live override: priced at the fresh compute, the line takes the difference, the gate holds', () => {
  const line = { type: 'discount', label: 'Test discount A', amount: '25.00', visible: true };
  const r = row({ status: 'confirmed', override: 2000, adjustments: [line] });
  const f = freshFor(r, { adjustments: [line] });
  const out = plan([r], [f]);
  const c = only(out, r.id);
  assert.equal(c.kind, 'override_live');
  const want = 200000 - f.freshServiceCents;
  assert.deepEqual(c.lines, [{
    type: want < 0 ? 'discount' : 'surcharge', label: AGREED_PRICE_LABEL, amount: Math.abs(want) / 100,
    visible: false, source: 'agreed_price',
  }]);
  assert.deepEqual(c.after.adjustments, [line, c.lines[0]]);
  const s = c.after.pricing_snapshot;
  assert.deepEqual(s.adjustments, c.after.adjustments);
  assert.equal(s.calculated_at, f.snapshot.calculated_at, 'the fresh compute, not a new one');
  assert.equal(cents(s.total), cents(r.total_price), 'gate: the after total is total_price');
  assert.equal(s.total_price_override, null);
  assert.equal(c.after.total_price_override, null);
  assert.deepEqual(s.breakdown.at(-1), { label: AGREED_PRICE_LABEL, amount: want / 100, visible: false });
  assert.equal(c.placement, 'end');
  assert.equal(c.money_md5, r.money_md5);
});

test('live override with a client gratuity: the line row goes before the gratuity row', () => {
  const r = row({ status: 'deposit_paid', override: 3000, snapshot: price({ override: 3000, gratuityRate: 25 }) });
  const f = freshFor(r, { gratuityRate: 25 });
  const c = only(plan([r], [f]), r.id);
  const bd = c.after.pricing_snapshot.breakdown;
  assert.equal(bd.at(-1).label, GRATUITY_LABEL);
  assert.equal(bd.at(-2).label, AGREED_PRICE_LABEL);
  assert.equal(c.placement, 'before_last');
  assert.equal(cents(c.after.pricing_snapshot.total), cents(r.total_price));
});

test('terminal plain override: converted in place against the stored subtotal', () => {
  const r = row({ status: 'archived', override: 1500 });
  const snap = r.pricing_snapshot;
  const c = only(plan([r]), r.id);
  assert.equal(c.kind, 'override_terminal');
  const want = 150000 - Math.max(0, cents(snap.subtotal));
  assert.deepEqual(c.lines.map((l) => [l.type, cents(l.amount), l.source]), [[want < 0 ? 'discount' : 'surcharge', Math.abs(want), 'agreed_price']]);
  const s = c.after.pricing_snapshot;
  assert.equal(s.calculated_at, snap.calculated_at, 'in place: the stored snapshot, line prices untouched');
  assert.deepEqual(s.package, snap.package);
  assert.equal(s.subtotal, snap.subtotal);
  assert.equal(cents(s.total), 150000);
  assert.equal(s.total_price_override, null);
  assert.deepEqual(s.breakdown.slice(0, -1), snap.breakdown);
  assert.deepEqual(s.breakdown.at(-1), { label: AGREED_PRICE_LABEL, amount: want / 100, visible: false });
});

test('existing adjustments (net -237.50): the line nets against them', () => {
  const lines = [
    { type: 'discount', label: 'Test discount A', amount: 200, visible: true },
    { type: 'discount', label: 'Test discount B', amount: '37.50', visible: false },
  ];
  const r = row({ status: 'completed', override: 2500, adjustments: lines });
  const c = only(plan([r]), r.id);
  const want = 250000 - Math.max(0, cents(r.pricing_snapshot.subtotal) - 23750);
  assert.equal(c.lines.length, 1);
  assert.equal(cents(c.lines[0].amount) * (c.lines[0].type === 'discount' ? -1 : 1), want);
  assert.deepEqual(c.after.adjustments.slice(0, 2), lines, 'stored lines kept as stored');
});

test('the 527/599 shape: a refund lowered the row override, not the snapshot: one agreed-price line, no Refund line', () => {
  const r = row({
    status: 'completed', override: 1700, snapshot: price({ override: 1800 }), totalPrice: '1700.00',
    refunds: [refund(71, 10000, { fromCents: 180000 })],
  });
  const out = plan([r]);
  const c = only(out, r.id);
  assert.equal(c.kind, 'override_terminal');
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].source, 'agreed_price');
  assert.equal(cents(c.lines[0].amount) * -1, 170000 - cents(r.pricing_snapshot.subtotal), 'from the ROW override');
  assert.equal(cents(c.after.pricing_snapshot.total), 170000);
  assert.deepEqual(out.absorbedRefunds, [{ proposalId: r.id, refundIds: [71] }]);
});

test('an even row writes no line but still retires the override', () => {
  const base = price();
  const r = row({ status: 'archived', override: base.subtotal });
  const c = only(plan([r]), r.id);
  assert.deepEqual(c.lines, []);
  assert.equal(c.placement, 'none');
  assert.equal(c.after.pricing_snapshot.total_price_override, null);
  assert.deepEqual(c.after.pricing_snapshot.breakdown, r.pricing_snapshot.breakdown);
  assert.deepEqual(c.after.adjustments, []);
});

test('backfill: two contract refunds, two Refund lines, the gap closes', () => {
  const snap = price();
  const r = row({
    status: 'balance_paid', snapshot: snap, totalPrice: dollars(cents(snap.total) - 8000),
    refunds: [refund(81, 5000, { at: '2026-09-01T00:00:00Z' }), refund(82, 3000, { at: '2026-09-02T00:00:00Z' })],
  });
  const c = only(plan([r]), r.id);
  assert.equal(c.kind, 'refund_backfill');
  assert.deepEqual(c.lines, [
    { type: 'discount', label: REFUND_LABEL, amount: 50, visible: true, source: 'refund', refund_id: 81 },
    { type: 'discount', label: REFUND_LABEL, amount: 30, visible: true, source: 'refund', refund_id: 82 },
  ]);
  assert.equal(cents(c.after.pricing_snapshot.total), cents(r.total_price));
  assert.deepEqual(c.after.pricing_snapshot.breakdown.slice(-2), [
    { label: REFUND_LABEL, amount: -50, visible: true }, { label: REFUND_LABEL, amount: -30, visible: true }]);
  assert.equal(c.after.total_price_override, null);
});

test('a refund whose line step 1 already wrote is never backfilled again', () => {
  const line = { type: 'discount', label: REFUND_LABEL, amount: 40, visible: true, source: 'refund', refund_id: 91 };
  const r = row({ status: 'confirmed', adjustments: [line], refunds: [refund(91, 4000)] });
  const out = plan([r]);
  assert.equal(out.changes.length, 0);
  assert.ok(nowhere(out, r.id));
});

test('Review Focus 4: an overpayment refund and a contract refund write one line', () => {
  const snap = price();
  const r = row({
    status: 'balance_paid', snapshot: snap, totalPrice: dollars(cents(snap.total) - 4000),
    refunds: [refund(101, 2500, { scope: 'overpayment', fromCents: 300000 }), refund(102, 4000)],
  });
  r.refunds[0].total_price_after = r.refunds[0].total_price_before; // overpayment never moves the total
  const c = only(plan([r]), r.id);
  assert.deepEqual(c.lines.map((l) => l.refund_id), [102]);
});

test('gap 0 with an unbacked refund is listed with the Additional Services invoices minted after it', () => {
  const r = row({
    status: 'confirmed', refunds: [refund(111, 6000, { at: '2026-09-05T00:00:00Z' })],
    invoices: [
      { id: 501, created_at: '2026-09-01T00:00:00Z', amount_due: 1000, status: 'paid' },
      { id: 502, created_at: '2026-09-07T00:00:00Z', amount_due: 6000, status: 'sent' },
    ],
  });
  const out = plan([r]);
  assert.equal(out.changes.length, 0);
  assert.deepEqual(out.dallasLists.refundGapZero.map((e) => [e.id, e.refunds.map((x) => [x.id, x.dropCents, x.additionalServicesAfter.map((i) => i.id)])]),
    [[r.id, [[111, 6000, [502]]]]]);
});

test('an unequal gap is listed, not written', () => {
  const snap = price();
  const r = row({ status: 'confirmed', snapshot: snap, totalPrice: dollars(cents(snap.total) - 7000), refunds: [refund(121, 5000)] });
  const out = plan([r]);
  assert.equal(out.changes.length, 0);
  assert.deepEqual(out.dallasLists.refundGapUnequal.map((e) => [e.id, e.gapCents, e.unbackedCents]), [[r.id, 7000, 5000]]);
});

test('row and snapshot lines that differ are listed, not guessed at', () => {
  const snap = price({ adjustments: [{ type: 'discount', label: 'Test discount C', amount: 10, visible: true }], override: 1400 });
  const r = row({ status: 'archived', override: 1400, adjustments: [], snapshot: snap });
  const out = plan([r]);
  assert.equal(out.changes.length, 0);
  assert.deepEqual(out.dallasLists.snapshotMismatch.map((e) => [e.id, e.kind]), [[r.id, 'override_terminal']]);
});

test('legal hold: a held id appears nowhere, from the list or from the seam', () => {
  const byList = row({ status: 'archived', override: 1500 });
  const bySeam = row({ status: 'confirmed', override: 1600 });
  const refundHeld = row({ status: 'confirmed', refunds: [refund(131, 1000)], totalPrice: '1.00' });
  __setLegalHoldIdsForTest([bySeam.id, refundHeld.id]);
  try {
    const out = plan([byList, bySeam, refundHeld], [freshFor(bySeam, {})], [byList.id]);
    for (const r of [byList, bySeam, refundHeld]) assert.ok(nowhere(out, r.id), `id ${r.id} appears nowhere`);
    assert.deepEqual(out.changes, []);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
});

test('the 59 shape: drift with no unbacked refund is untouched', () => {
  const line = { type: 'discount', label: REFUND_LABEL, amount: 20, visible: true, source: 'refund', refund_id: 141 };
  const snap = price({ adjustments: [line] });
  const r = row({ status: 'confirmed', adjustments: [line], snapshot: snap, totalPrice: dollars(cents(snap.total) - 3300), refunds: [refund(141, 2000)] });
  const out = plan([r]);
  assert.equal(out.changes.length, 0);
  assert.ok(nowhere(out, r.id));
});

test('a missing snapshot gratuity counts as 0', () => {
  const snap = price({ override: 1500 });
  delete snap.gratuity;
  const r = row({ status: 'completed', override: 1500, snapshot: snap });
  const c = only(plan([r]), r.id);
  assert.equal(cents(c.after.pricing_snapshot.total), 150000);
  assert.equal(c.after.pricing_snapshot.gratuity, undefined, 'nothing invented');
});

test('a snapshot with no breakdown gets the line but never a breakdown', () => {
  const snap = price({ override: 1500 });
  delete snap.breakdown;
  const c = only(plan([row({ status: 'archived', override: 1500, snapshot: snap })]), nextId - 1);
  assert.equal(c.placement, 'none');
  assert.equal('breakdown' in c.after.pricing_snapshot, false);
  assert.equal(c.after.pricing_snapshot.adjustments.length, 1);
});

test('report: the drift and both fold verdicts on a live row that lands on the fallback', () => {
  const OLD = { ...PKG, base_rate_4hr: 28 };
  const big = { type: 'surcharge', label: 'Test surcharge D', amount: 3000, visible: true };
  const stored = price({ adjustments: [big], override: 500, pkg: OLD });
  const r = row({ status: 'confirmed', override: 500, adjustments: [big], snapshot: stored, crs: [{ id: 7, created_at: '2026-10-01T00:00:00Z' }] });
  const f = freshFor(r, { adjustments: [big] });
  const out = plan([r], [f]);
  const rep = out.report.find((x) => x.id === r.id);
  assert.equal(rep.kind, 'override_live');
  assert.equal(rep.catalogDriftCents, f.freshServiceCents - (cents(stored.subtotal) + 300000), 'fresh against the stored calculated total');
  assert.equal(rep.catalogDriftCents, 120 * 2 * 100, 'two dollars a guest more today');
  assert.equal(rep.pageVerdict, 'fallback');
  assert.equal(rep.invoiceVerdict, 'fallback');
  assert.deepEqual(rep.pendingChangeRequests, [{ id: 7, created_at: '2026-10-01T00:00:00Z' }]);
  assert.deepEqual(rep.lines, [{ type: 'discount', label: AGREED_PRICE_LABEL, amount: (f.freshServiceCents - 50000) / 100 }]);
});

test('report verdicts read package and none where the fold fits or there is no gap', () => {
  const r = row({ status: 'archived', override: 1500 });
  const rep = plan([r]).report[0];
  assert.equal(rep.pageVerdict, 'package');
  assert.equal(rep.invoiceVerdict, 'package');
  assert.equal(rep.catalogDriftCents, null, 'drift is for live rows only');
});

test('rows the transform cannot convert cleanly are listed with a reason, never written', () => {
  const refused = row({ status: 'confirmed', override: 900 });
  const missing = row({ status: 'confirmed', override: 950 });
  const off = row({ status: 'archived', override: 1500, totalPrice: '1499.00' });
  const bad = row({ status: 'archived', override: 1500, adjustments: [{ type: 'bonus', label: 'x', amount: 1 }] });
  bad.pricing_snapshot.adjustments = bad.adjustments;
  const out = plan([refused, missing, off, bad], [{ id: refused.id, money_md5: refused.money_md5, error: 'no package' }]);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.dallasLists.unconverted.map((e) => [e.id, e.reason]), [
    [refused.id, 'fresh_compute_refused'], [missing.id, 'no_fresh_compute'], [off.id, 'total_mismatch'], [bad.id, 'invalid_lines'],
  ]);
});

test('every written line set passes the editor validator and money compares in cents', () => {
  const snap = price();
  const rows = [
    row({ status: 'archived', override: 1234.56 }),
    row({ status: 'completed', override: 999.99, adjustments: [{ type: 'surcharge', label: 'Test surcharge E', amount: '', visible: false }] }),
    row({ status: 'balance_paid', snapshot: snap, totalPrice: dollars(cents(snap.total) - 1), refunds: [refund(151, 1)] }),
  ];
  const out = plan(rows);
  assert.equal(out.changes.length, 3);
  for (const c of out.changes) {
    assert.equal(validateAdjustments(c.after.adjustments).error, null, `proposal ${c.id}`);
    assert.equal(cents(c.after.pricing_snapshot.total), cents(rows.find((r) => r.id === c.id).total_price));
  }
});

// Fix round.
const { SHARED_GRATUITY_LABEL } = require('../../server/utils/gratuityLabels');

test('the report shows the payroll gratuity pool before and after, and flags a live row that moves it', () => {
  const stored = price({ override: 2000 });
  stored.breakdown.push({ label: SHARED_GRATUITY_LABEL, amount: 60 }); // over-ratio staff at the old count
  const r = row({ status: 'confirmed', override: 2000, snapshot: stored });
  const terminal = row({ status: 'archived', override: 1500 });
  terminal.pricing_snapshot.breakdown.push({ label: SHARED_GRATUITY_LABEL, amount: 25 });
  const out = plan([r, terminal], [freshFor(r, {})]);
  const live = out.report.find((x) => x.id === r.id);
  assert.deepEqual([live.payrollGratuityBeforeCents, live.payrollGratuityAfterCents, live.payrollGratuityChanged], [6000, 0, true]);
  const inPlace = out.report.find((x) => x.id === terminal.id);
  assert.deepEqual([inPlace.payrollGratuityBeforeCents, inPlace.payrollGratuityAfterCents, inPlace.payrollGratuityChanged], [2500, 2500, false]);
});

test('a refund that already has its own line is not reported as absorbed', () => {
  const line = { type: 'discount', label: REFUND_LABEL, amount: 40, visible: true, source: 'refund', refund_id: 161 };
  const r = row({ status: 'completed', override: 1500, adjustments: [line], snapshot: price({ override: 1500, adjustments: [line] }),
    refunds: [refund(161, 4000), refund(162, 1000)] });
  const out = plan([r]);
  assert.equal(out.changes.length, 1);
  assert.deepEqual(out.absorbedRefunds, [{ proposalId: r.id, refundIds: [162] }]);
});

test('an invoice gap with no package line to carry it reads skipped, not none', () => {
  const snap = price({ override: 1500 });
  delete snap.package;
  const rep = plan([row({ status: 'archived', override: 1500, snapshot: snap })]).report[0];
  assert.equal(rep.pageVerdict, 'skipped');
  assert.equal(rep.invoiceVerdict, 'skipped');
});

test('a refund named in only one of the row and snapshot lists is listed, never silently skipped', () => {
  const line = { type: 'discount', label: REFUND_LABEL, amount: 40, visible: true, source: 'refund', refund_id: 171 };
  const r = row({ status: 'confirmed', adjustments: [], snapshot: price({ adjustments: [line] }), refunds: [refund(171, 4000)] });
  const out = plan([r]);
  assert.equal(out.changes.length, 0);
  assert.deepEqual(out.dallasLists.snapshotMismatch.map((e) => [e.id, e.kind]), [[r.id, 'refund_backfill']]);
});
