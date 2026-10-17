// server/utils/clientPriceLines.test.js
// The rows a client sees, built on the server (spec 2026-10-16 section 4.1).
// Pure: no DB. Fixtures are synthetic engine-shaped snapshots.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildClientPriceRows, snapshotServiceCents } = require('./clientPriceLines');
const { adjSignedCents, adjLabel } = require('./adjustmentRules');

// Characterization (plan Task C2 Step 1): the body of the lineItems memo in
// client/src/pages/proposal/proposalView/ProposalView.js (L580-620 on
// 2026-10-16) as it stood before this builder replaced it, minus its gratuity
// row (L612-617), which the page keeps adding itself. The builder must
// reproduce it exactly whenever no adjustment is hidden.
function legacyRows(snap, packageName) {
  const items = [];
  if (snap && snap.package) {
    const packageTotal = (snap.package.base_cost || 0) + (snap.staffing?.total || 0);
    items.push({ label: packageName, amount: packageTotal });
    if (snap.bar_rental?.total > 0) {
      items.push({ label: 'Bar Rental', amount: snap.bar_rental.total });
    }
    (snap.addons || []).forEach(a => {
      items.push({ label: a.name, amount: a.line_total });
    });
    if (snap.syrups?.total > 0) {
      let syrupLabel = 'Handcrafted Syrups';
      const sc = snap.syrups;
      if (sc.packs > 0 && sc.singles > 0) {
        syrupLabel += ` (${sc.packs} three-pack${sc.packs !== 1 ? 's' : ''} + ${sc.singles} single${sc.singles !== 1 ? 's' : ''})`;
      } else if (sc.packs > 0) {
        syrupLabel += ` (${sc.packs} three-pack${sc.packs !== 1 ? 's' : ''})`;
      } else {
        syrupLabel += ` (${sc.singles} bottle${sc.singles !== 1 ? 's' : ''})`;
      }
      items.push({ label: syrupLabel, amount: sc.total });
    }
    (snap.adjustments || []).forEach(adj => {
      if (!adj.visible) return;
      const amt = Math.abs(Number(adj.amount) || 0);
      items.push({
        label: adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge'),
        amount: adj.type === 'discount' ? -amt : amt,
      });
    });
  }
  return items;
}

const DISPLAY_LABELS = { 'Shared Gratuity': 'Staffing Gratuity', Gratuity: 'Gratuity' };

// (a) Flat package with bar rental, two add-ons (one $0), syrups (singles),
// one visible discount. subtotal 450 + 50 + 120 + 0 + 30 = 650; total 625.
const FLAT = Object.freeze({
  _version: 3,
  calculated_at: '2026-10-16T00:00:00.000Z',
  inputs: { guestCount: 80, durationHours: 4, numBars: 1, numBartenders: 1 },
  package: { id: 9001, slug: 'test-flat', name: 'Test Flat', category: 'byob', pricing_type: 'flat', base_cost: 450 },
  bar_rental: { num_bars: 1, first_bar_fee: 50, additional_bar_fee: 100, total: 50 },
  staffing: { included: 1, required: 1, actual: 1, extra: 0, hourly_rate: 40, total: 0 },
  addons: [
    { name: 'Test Add-on A', billing_type: 'flat', rate: 120, quantity: 1, line_total: 120 },
    { name: 'Test Add-on Free', billing_type: 'flat', rate: 0, quantity: 1, line_total: 0 },
  ],
  syrups: { selections: ['s-1', 's-2'], count: 2, bottles_per_flavor: 1, total_bottles: 2, packs: 0, singles: 2, total: 30 },
  breakdown: [
    { label: 'Test Flat (4hrs, 80 guests)', amount: 450 },
    { label: 'Bar Rental (1 bar)', amount: 50 },
    { label: 'Test Add-on A', amount: 120 },
    { label: 'Test Add-on Free', amount: 0 },
    { label: 'Hand-Crafted Syrups (2 flavors, 2 bottles)', amount: 30 },
    { label: 'Test visible discount', amount: -25 },
  ],
  staff_noun: 'bartender',
  display_labels: DISPLAY_LABELS,
  gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 4, staff_noun: 'bartender', total: 0, floor_rate: null },
  floor_applied: false,
  floor_reason: null,
  billed_guests: 80,
  adjustments: [{ type: 'discount', label: 'Test visible discount', amount: 25, visible: true }],
  total_price_override: null,
  subtotal: 650,
  total: 625,
});

// (b) Hosted package with staffing (one over-ratio bartender), an add-on,
// syrups (three-packs only) and a client gratuity. subtotal 2400 + 210 + 99.5
// + 90 = 2799.5; total 2799.5 + 240 = 3039.5.
const HOSTED = Object.freeze({
  _version: 3,
  calculated_at: '2026-10-16T00:00:00.000Z',
  inputs: { guestCount: 160, durationHours: 4, numBars: 0, numBartenders: 3 },
  package: { id: 9002, slug: 'test-hosted', name: 'Test Hosted', category: 'hosted', pricing_type: 'per_guest', base_cost: 2400 },
  bar_rental: { num_bars: 0, first_bar_fee: 50, additional_bar_fee: 100, total: 0 },
  staffing: { included: 2, required: 2, actual: 3, extra: 1, hourly_rate: 40, total: 210 },
  addons: [{ name: 'Test Add-on Hosted', billing_type: 'per_guest', rate: 0.5, quantity: 1, line_total: 99.5 }],
  syrups: { selections: ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'], count: 6, bottles_per_flavor: 1, total_bottles: 6, packs: 2, singles: 0, total: 90 },
  breakdown: [
    { label: 'Test Hosted (4hrs, 160 guests)', amount: 2400 },
    { label: 'Additional Bartender (1)', amount: 160 },
    { label: 'Shared Gratuity', amount: 50 },
    { label: 'Test Add-on Hosted (160 guests)', amount: 99.5 },
    { label: 'Hand-Crafted Syrups (6 flavors, 6 bottles)', amount: 90 },
    { label: 'Gratuity', amount: 240 },
  ],
  staff_noun: 'bartender',
  display_labels: DISPLAY_LABELS,
  gratuity: { rate: 20, tip_jar: false, staff_count: 3, hours: 4, staff_noun: 'bartender', total: 240, floor_rate: null },
  floor_applied: false,
  floor_reason: 'rate',
  billed_guests: 160,
  adjustments: [],
  total_price_override: null,
  subtotal: 2799.5,
  total: 3039.5,
});

// (c) No adjustments: two bars, syrups (three-pack plus singles), no add-ons.
// subtotal 325.75 + 150 + 75 = 550.75 = total.
const PLAIN = Object.freeze({
  _version: 3,
  calculated_at: '2026-10-16T00:00:00.000Z',
  inputs: { guestCount: 50, durationHours: 3, numBars: 2, numBartenders: 1 },
  package: { id: 9003, slug: 'test-plain', name: 'Test Plain', category: 'byob', pricing_type: 'flat', base_cost: 325.75 },
  bar_rental: { num_bars: 2, first_bar_fee: 50, additional_bar_fee: 100, total: 150 },
  staffing: { included: 1, required: 1, actual: 1, extra: 0, hourly_rate: 40, total: 0 },
  addons: [],
  syrups: { selections: ['s-1', 's-2', 's-3', 's-4', 's-5'], count: 5, bottles_per_flavor: 1, total_bottles: 5, packs: 1, singles: 2, total: 75 },
  breakdown: [
    { label: 'Test Plain (3hrs, 50 guests)', amount: 325.75 },
    { label: 'Bar Rental (2 bars)', amount: 150 },
    { label: 'Hand-Crafted Syrups (5 flavors, 5 bottles)', amount: 75 },
  ],
  staff_noun: 'bartender',
  display_labels: DISPLAY_LABELS,
  gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 3, staff_noun: 'bartender', total: 0, floor_rate: null },
  floor_applied: false,
  floor_reason: null,
  billed_guests: 50,
  adjustments: [],
  total_price_override: null,
  subtotal: 550.75,
  total: 550.75,
});

const FIXTURES = [FLAT, HOSTED, PLAIN];

// Appends `adj` to the snapshot's adjustments (and its breakdown row) and
// moves the total by its signed cents, the service part clamped at 0 the
// engine's way (calculatedTotal = max(0, subtotal + net); gratuity on top).
function withHidden(snap, adj) {
  const out = structuredClone(snap);
  out.adjustments = [...(out.adjustments || []), adj];
  out.breakdown = [...(out.breakdown || []), { label: adjLabel(adj), amount: adjSignedCents(adj) / 100 }];
  const gratuityCents = Math.round((out.gratuity?.total || 0) * 100);
  const serviceCents = Math.round(out.total * 100) - gratuityCents;
  out.total = (Math.max(0, serviceCents + adjSignedCents(adj)) + gratuityCents) / 100;
  return out;
}

const cents = (rows) => rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);

test('no hidden lines: identical to the page today', () => {
  for (const snap of FIXTURES) {
    const target = Math.round((snap.total - (snap.gratuity?.total || 0)) * 100);
    const { rows, fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
    assert.deepEqual(rows.map(({ key: _key, ...r }) => r), legacyRows(snap, 'Test Package')); // the memo rows carry no key
    assert.equal(fold.applied, 'none');
  }
});

test('a hidden discount folds into the package and the rows reach the target', () => {
  const snap = withHidden(FIXTURES[0], { type: 'discount', label: 'Test hidden', amount: 100, visible: false });
  const target = Math.round((snap.total - (snap.gratuity?.total || 0)) * 100);
  const { rows, fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
  assert.equal(fold.applied, 'package');
  assert.equal(cents(rows), target);
  assert.ok(!rows.some(r => r.label === 'Test hidden'));
});

test('a hidden discount bigger than the package uses one Pricing adjustment row', () => {
  const snap = withHidden(FIXTURES[0], { type: 'discount', label: 'Test hidden', amount: 5000, visible: false });
  const target = Math.max(0, Math.round((snap.total - (snap.gratuity?.total || 0)) * 100));
  const { rows, fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
  assert.equal(fold.applied, 'fallback');
  assert.equal(rows.at(-1).label, 'Pricing adjustment');
  assert.equal(cents(rows), target);
});

test('no total means no rows; no package means no fold', () => {
  assert.deepEqual(buildClientPriceRows({}, { targetCents: NaN }).rows, []);
  assert.equal(buildClientPriceRows(null, { targetCents: 0 }).fold.applied, 'no_total');
  const noPkg = { ...FIXTURES[0], package: undefined };
  assert.equal(buildClientPriceRows(noPkg, { targetCents: 1 }).fold.applied, 'skipped');
});

test('legacy string amounts and odd types follow the engine', () => {
  const snap = withHidden(FIXTURES[2], { type: 'Discount', label: 'Test odd', amount: '25', visible: 'true' });
  // type 'Discount' is not 'discount': the engine treats it as a SURCHARGE; visible 'true' is truthy
  const target = Math.round((snap.total - (snap.gratuity?.total || 0)) * 100);
  const { rows } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
  assert.equal(rows.find(r => r.label === 'Test odd').amount, 25);
});

// ─── Beyond the plan's five: spec section 10's builder list ─────────────────

test('cents rounding: every row is whole cents and the rows still reach the target', () => {
  // 1234.56 + 0.07 is 1234.6299999999999 in floating point (the old memo's
  // package row); a row leaves the server as 1234.63. A visible '3.333' is
  // 3.33, the engine's per-line cents.
  assert.notEqual(1234.56 + 0.07, 1234.63, 'the fixture really carries float noise');
  const snap = structuredClone(FIXTURES[2]);
  snap.package.base_cost = 1234.56;
  snap.staffing.total = 0.07;
  snap.adjustments = [{ type: 'surcharge', label: 'Test cents', amount: '3.333', visible: true }];
  const target = 123463 + 15000 + 7500 + 333;
  const { rows, fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
  assert.equal(rows.find(r => r.key === 'package').amount, 1234.63);
  assert.equal(rows.find(r => r.label === 'Test cents').amount, 3.33);
  for (const r of rows) assert.equal(r.amount, Math.round(r.amount * 100) / 100, `${r.label} is whole cents`);
  assert.equal(fold.applied, 'none');
  assert.equal(cents(rows), target);
});

test('row keys never reveal where a hidden line sat', () => {
  const snap = structuredClone(FIXTURES[2]);
  snap.adjustments = [
    { type: 'discount', label: 'Test shown one', amount: 5, visible: true },
    { type: 'discount', label: 'Test secret', amount: 7, visible: false },
    { type: 'surcharge', label: 'Test shown two', amount: 3, visible: true },
  ];
  const { rows } = buildClientPriceRows(snap, { targetCents: 55075 - 500 - 700 + 300, packageName: 'Test Package' });
  assert.deepEqual(rows.map(r => r.key), ['package', 'bar-rental', 'syrups', 'adjustment-0', 'adjustment-1']);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length, 'keys are unique');
});

test('the fold report: the hidden net, and any gap it does not explain', () => {
  const snap = withHidden(FIXTURES[0], { type: 'discount', label: 'Test hidden', amount: 100, visible: false });
  const target = snapshotServiceCents(snap);
  const { fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
  assert.deepEqual(fold, { applied: 'package', gapCents: -10000, hiddenNetCents: -10000, explainedCents: -10000, unexplainedCents: 0 });
  // A target the snapshot does not explain (a contract total that drifted from it) shows up as unexplained.
  const drifted = buildClientPriceRows(snap, { targetCents: target - 2000, packageName: 'Test Package' }).fold;
  assert.equal(drifted.unexplainedCents, -2000);
});

// What the snapshot explains is read the way invoiceLineItems.foldToContract
// reads it: its own service total less what it itemizes (subtotal plus the
// visible lines). That covers the hidden lines, an override's difference and
// the engine's zero clamp, so none of them reads as unexplained.
const PKG_ONLY = (over) => ({
  package: { name: 'Test Package', base_cost: 500 }, staffing: { total: 0 }, bar_rental: { total: 40 },
  addons: [{ name: 'Test Add-on', line_total: 60 }], syrups: { total: 0 },
  gratuity: { total: 0 }, total_price_override: null, subtotal: 600, ...over,
});

test('the engine zero clamp is explained, whether the lines are hidden or visible', () => {
  // A comped booking: a hidden 700 against a 600 subtotal; the engine clamps at 0.
  const hidden = { ...PKG_ONLY({}), bar_rental: { total: 0 }, addons: [], subtotal: 500,
    adjustments: [{ type: 'discount', label: 'Test comp', amount: 600, visible: false }], total: 0 };
  const h = buildClientPriceRows(hidden, { targetCents: snapshotServiceCents(hidden), packageName: 'Test Package' });
  assert.deepEqual(h.rows, [{ key: 'package', label: 'Test Package', amount: 0 }]);
  assert.equal(h.fold.applied, 'package');
  assert.equal(h.fold.unexplainedCents, 0, 'the clamp is the snapshot\'s own arithmetic');
  // A visible 700 against 600: the rows run to -100 and the clamp lifts them to 0.
  const visible = PKG_ONLY({ adjustments: [{ type: 'discount', label: 'Test big', amount: 700, visible: true }], total: 0 });
  const v = buildClientPriceRows(visible, { targetCents: snapshotServiceCents(visible), packageName: 'Test Package' });
  assert.equal(v.fold.applied, 'package');
  assert.equal(v.rows.reduce((s, r) => s + Math.round(r.amount * 100), 0), 0, 'the rows still reach $0');
  assert.equal(v.fold.unexplainedCents, 0);
});

test('an override is explained by the snapshot; parts that disagree with the subtotal are not', () => {
  const over = PKG_ONLY({ adjustments: [], total_price_override: 480, total: 480 });
  const o = buildClientPriceRows(over, { targetCents: snapshotServiceCents(over), packageName: 'Test Package' });
  assert.equal(o.fold.gapCents, -12000);
  assert.equal(o.fold.explainedCents, -12000);
  assert.equal(o.fold.unexplainedCents, 0);
  // The snapshot says 600, its parts say 580: drift no line explains.
  const drift = PKG_ONLY({ adjustments: [], addons: [{ name: 'Test Add-on', line_total: 40 }], total: 600 });
  const d = buildClientPriceRows(drift, { targetCents: snapshotServiceCents(drift), packageName: 'Test Package' });
  assert.equal(d.fold.explainedCents, 0);
  assert.equal(d.fold.unexplainedCents, 2000);
});

test('a snapshot without a subtotal explains its gap by its hidden lines alone', () => {
  const snap = { ...PKG_ONLY({ adjustments: [{ type: 'discount', label: 'Test hidden', amount: 35, visible: false }], total: 565 }) };
  delete snap.subtotal;
  const { fold } = buildClientPriceRows(snap, { targetCents: snapshotServiceCents(snap), packageName: 'Test Package' });
  assert.equal(fold.explainedCents, null);
  assert.equal(fold.hiddenNetCents, -3500);
  assert.equal(fold.unexplainedCents, 0);
});

test('the input snapshot is never mutated', () => {
  const snap = withHidden(FIXTURES[0], { type: 'discount', label: 'Test hidden', amount: 100, visible: false });
  const before = structuredClone(snap);
  buildClientPriceRows(snap, { targetCents: snapshotServiceCents(snap), packageName: 'Test Package' });
  assert.deepEqual(snap, before);
});

test('snapshotServiceCents: the page target, the snapshot total less a positive client gratuity', () => {
  assert.equal(snapshotServiceCents(HOSTED), 279950);
  assert.equal(snapshotServiceCents(FLAT), 62500);
  assert.equal(snapshotServiceCents({ total: '100.10', gratuity: { total: '0.10' } }), 10000);
  // The page adds a gratuity row only above zero, so only that is taken off.
  assert.equal(snapshotServiceCents({ total: 50, gratuity: { total: -5 } }), 5000);
  // No usable total is no target, never $0 (a $0 target would fold every row away).
  for (const bad of [null, undefined, {}, { total: null }, { total: '' }, { total: '  ' }, { total: 'abc' }, { total: true }, 'not a snapshot']) {
    assert.ok(Number.isNaN(snapshotServiceCents(bad)), `no target for ${JSON.stringify(bad)}`);
  }
  assert.equal(buildClientPriceRows({ ...FLAT, total: null }, { targetCents: 0 }).fold.applied, 'no_total');
});
