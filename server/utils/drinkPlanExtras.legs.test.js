// The pay-now extras are priced through the fold's two engine legs (audit
// PRC-03, 2026-11-05).
//
// THE DEFECT. computeExtrasBreakdown had two branches, per_guest and "else one
// flat rate", while the submit fold priced an added add-on with the engine:
// a banquet server (per_hour, 4h minimum) on a 4h booking was charged and
// invoiced at the flat rate but folded at hours times rate, a mocktail bar
// (per_guest_timed) on a 6h event at guests times rate but folded with its
// extra hours, a parking fee (per_staff) at the rate but folded at staff times
// rate. The charge never matched the contract delta and nothing invoiced the
// remainder. The helper now prices the same two legs the fold prices
// (proposalExtrasFold.catalogEngineArgs), so each case equals the fold's own
// delta, computed here independently through the engine.
//
// PURE: a scripted client answers the helper's reads by SQL shape (the package
// row, the reprice-ready add-ons on the contract, the catalog rows for the new
// slugs, the settled extensions), with a fixed catalog so the expected cents
// are worked by hand.
//
//   node --test server/utils/drinkPlanExtras.legs.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeExtrasBreakdown } = require('./drinkPlanExtras');
const { calculateProposal } = require('./pricingEngine');
const { catalogEngineArgs, withRepriceQuantities } = require('./proposalExtrasFold');

const PKG = {
  id: 5, slug: 'core', name: 'The Core Reaction', category: 'byob', pricing_type: 'flat', bar_type: 'byob',
  base_rate_4hr: 350, base_rate_4hr_small: 300, min_guests: 50, guests_per_bartender: 75,
  extra_hour_rate: 75, extra_hour_rate_small: 60, first_bar_fee: 50, additional_bar_fee: 100,
};
const CATALOG = {
  'banquet-server': { id: 11, slug: 'banquet-server', name: 'Banquet Server', rate: '25', billing_type: 'per_hour', minimum_hours: 4, extra_hour_rate: null, is_active: true },
  'mocktail-bar': { id: 12, slug: 'mocktail-bar', name: 'Mocktail Bar', rate: '3', billing_type: 'per_guest_timed', minimum_hours: null, extra_hour_rate: '1', is_active: true },
  'parking-fee': { id: 13, slug: 'parking-fee', name: 'Paid Parking', rate: '20', billing_type: 'per_staff', minimum_hours: null, extra_hour_rate: null, is_active: true },
  'additional-bartender': { id: 14, slug: 'additional-bartender', name: 'Additional Bartender', rate: '40', billing_type: 'per_hour', minimum_hours: null, extra_hour_rate: null, is_active: true },
  'champagne-toast': { id: 15, slug: 'champagne-toast', name: 'Champagne Toast', rate: '5', billing_type: 'per_guest', minimum_hours: null, extra_hour_rate: null, is_active: true },
};

const proposal = (over = {}) => ({
  id: 4242, package_id: PKG.id, guest_count: 60, event_duration_hours: 4, num_bars: 0, num_bartenders: 2,
  gratuity_rate: 0, tip_jar: true, gratuity_floor_rate: null, adjustments: [],
  pricing_snapshot: { syrups: { selections: [] } },
  ...over,
});

// `onContract` are reprice rows the proposal already carries, as REPRICE_ADDON_SQL returns them.
function scripted({ onContract = [] } = {}) {
  return {
    async query(text, params) {
      if (/FROM service_packages WHERE id = \$1/.test(text)) return { rows: [PKG], rowCount: 1 };
      if (/FROM proposal_addons pa/.test(text)) return { rows: onContract, rowCount: onContract.length };
      if (/FROM service_addons WHERE slug = ANY/.test(text)) {
        const rows = params[0].map((slug) => CATALOG[slug]).filter(Boolean);
        return { rows, rowCount: rows.length };
      }
      if (/FROM service_extensions/.test(text)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${text}`);
    },
  };
}
const repriceRow = (slug, quantity, lineTotal, hours = 4) => ({
  ...CATALOG[slug], pa_quantity: quantity, pa_line_total: lineTotal, pa_rate: CATALOG[slug].rate,
  pa_duration_hours: hours, pa_settled_added_hours: 0, pa_min_contracted_hours: null,
});

// The fold's own delta for the same inputs, computed independently here.
function foldDeltaCents({ p, onContract, newSlugs, addBar = false, syrupsAfter = [] }) {
  const before = withRepriceQuantities(onContract);
  const legArgs = (addons, bars, syrups) => catalogEngineArgs({
    proposal: p, pkg: PKG, contractHours: p.event_duration_hours, numBars: bars, numBartenders: p.num_bartenders,
    addons, syrups, adjustments: p.adjustments,
  });
  const b = calculateProposal(legArgs(before, p.num_bars, []));
  const a = calculateProposal(legArgs([...before, ...newSlugs.map((s) => ({ ...CATALOG[s], quantity: 1 }))], p.num_bars + (addBar ? 1 : 0), syrupsAfter));
  return Math.round(a.total * 100) - Math.round(b.total * 100);
}

test('banquet-server (per_hour, 4h minimum) on a 4h booking: 4 x 25 = 10000, the fold delta', async () => {
  const p = proposal();
  const bd = await computeExtrasBreakdown({ selections: { addOns: { 'banquet-server': { enabled: true } } }, proposal: p }, scripted());
  assert.equal(bd.totalCents, 10000);
  assert.equal(bd.totalCents, foldDeltaCents({ p, onContract: [], newSlugs: ['banquet-server'] }));
  assert.equal(bd.folded, true);
  assert.deepEqual(bd.lines.map((l) => [l.description, l.quantity, l.line_total, l.source_type, l.source_id]),
    [['Banquet Server (4hrs)', 4, 10000, 'addon', 11]]);
});

test('mocktail-bar (per_guest_timed) on a 6h event with 60 guests: 60 x 3 + 2 extra hours x 60 x 1 = 30000', async () => {
  const p = proposal({ event_duration_hours: 6 });
  const bd = await computeExtrasBreakdown({ selections: { addOns: { 'mocktail-bar': { enabled: true } } }, proposal: p }, scripted());
  assert.equal(bd.totalCents, 30000);
  assert.equal(bd.totalCents, foldDeltaCents({ p, onContract: [], newSlugs: ['mocktail-bar'] }));
  assert.equal(bd.lines[0].description, 'Mocktail Bar (60 guests)');
});

test('parking-fee (per_staff) with 2 bartenders and a banquet server on the contract: 3 staff x 20 = 6000', async () => {
  const p = proposal();
  const onContract = [repriceRow('banquet-server', 4, 100)];
  const bd = await computeExtrasBreakdown({ selections: { addOns: { 'parking-fee': { enabled: true } } }, proposal: p }, scripted({ onContract }));
  assert.equal(bd.totalCents, 6000);
  assert.equal(bd.totalCents, foldDeltaCents({ p, onContract, newSlugs: ['parking-fee'] }));
  assert.equal(bd.lines[0].description, 'Paid Parking (3 staff)');
});

test('a server added beside a parking fee already on the contract reprices that fee too, and the lines still sum to the delta', async () => {
  const p = proposal();
  const onContract = [repriceRow('parking-fee', 2, 40)];
  const bd = await computeExtrasBreakdown({ selections: { addOns: { 'banquet-server': { enabled: true } } }, proposal: p }, scripted({ onContract }));
  // 4 x 25 for the server, plus the parking fee moving from 2 to 3 staff (+20).
  assert.equal(bd.totalCents, 12000);
  assert.equal(bd.totalCents, foldDeltaCents({ p, onContract, newSlugs: ['banquet-server'] }));
  assert.equal(bd.lines.reduce((s, l) => s + l.line_total, 0), bd.totalCents);
  assert.ok(bd.lines.some((l) => l.description === 'Contract repricing' && l.line_total === 2000));
});

test('an additional bartender carries the engine surcharge: 4h x (40 + 25 for a 60-guest event) = 26000', async () => {
  const p = proposal();
  const bd = await computeExtrasBreakdown({ selections: { addOns: { 'additional-bartender': { enabled: true } } }, proposal: p }, scripted());
  assert.equal(bd.totalCents, 26000);
  assert.equal(bd.totalCents, foldDeltaCents({ p, onContract: [], newSlugs: ['additional-bartender'] }));
});

test('a per_guest add-on and a first bar: 60 x 5 + the package first_bar_fee 50 = 35000', async () => {
  const p = proposal();
  const bd = await computeExtrasBreakdown({
    selections: { addOns: { 'champagne-toast': { enabled: true } }, logistics: { addBarRental: true } }, proposal: p,
  }, scripted());
  assert.equal(bd.addonCents, 30000);
  assert.equal(bd.barRentalCents, 5000);
  assert.equal(bd.totalCents, 35000);
  assert.equal(bd.totalCents, foldDeltaCents({ p, onContract: [], newSlugs: ['champagne-toast'], addBar: true }));
  assert.ok(bd.lines.some((l) => l.description === 'Portable Bar Rental' && l.line_total === 5000));
});

test('a second bar prices as the additional bar fee (100), on the row\'s current count', async () => {
  const p = proposal({ num_bars: 1 });
  const bd = await computeExtrasBreakdown({ selections: { logistics: { addBarRental: true } }, proposal: p }, scripted());
  assert.equal(bd.barRentalCents, 10000);
  assert.equal(bd.totalCents, 10000);
  assert.equal(bd.lines[0].description, 'Additional Portable Bar');
});

test('syrups alone never fold: priced directly, no package read, unfolded lines', async () => {
  const p = proposal({ package_id: null });
  const sel = { syrupSelections: { d1: ['blackberry', 'vanilla-bean'] }, syrupSelfProvided: [] };
  const bd = await computeExtrasBreakdown({ selections: sel, proposal: p }, { async query() { throw new Error('no read expected'); } });
  const { calculateSyrupCost } = require('./pricingEngine');
  assert.equal(bd.totalCents, Math.round(calculateSyrupCost(['blackberry', 'vanilla-bean'], 60).total * 100));
  assert.equal(bd.folded, false);
  assert.ok(bd.lines.every((l) => l.source_type === 'fee'));
});

test('an add-on already on the contract is not added twice', async () => {
  const p = proposal();
  const onContract = [repriceRow('banquet-server', 4, 100)];
  const bd = await computeExtrasBreakdown({ selections: { addOns: { 'banquet-server': { enabled: true } } }, proposal: p }, scripted({ onContract }));
  assert.equal(bd.totalCents, 0);
  assert.deepEqual(bd.lines, []);
});

test('a proposal the fold cannot price refuses an add-on on the pay-now path', async () => {
  for (const over of [{ package_id: null }, { guest_count: 0 }, { event_duration_hours: null }]) {
    await assert.rejects(
      computeExtrasBreakdown({ selections: { addOns: { 'banquet-server': { enabled: true } } }, proposal: proposal(over) }, scripted()),
      (err) => err.code === 'EXTRAS_NOT_PRICEABLE' && err.statusCode === 409
    );
  }
});
