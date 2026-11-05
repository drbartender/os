require('dotenv').config();

// Unit test for computeExtrasBreakdown — the shared drink-plan extras amount
// helper. Asserts against the real calculateSyrupCost (not a magic number) so a
// change to syrup pricing keeps the test honest. Runs against the dev DB only to
// close the pool; the syrup-only case never queries service_addons. The priced
// cases (audit PRC-03) script the helper's reads: the add-ons and the bar are
// now priced through the fold's two engine legs (drinkPlanExtras.legs.test.js
// pins the per-type figures), so the stub answers the package, the contract's
// add-ons and the catalog rows by SQL shape.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../db');
const { calculateSyrupCost } = require('./pricingEngine');
const { computeExtrasBreakdown } = require('./drinkPlanExtras');

test('computeExtrasBreakdown: syrup-only equals calculateSyrupCost in cents', async () => {
  const sel = {
    addOns: {},
    logistics: { addBarRental: false },
    syrupSelections: { d1: ['blackberry', 'vanilla-bean'] },
    syrupSelfProvided: [],
  };
  const expectSyrupCents = Math.round(calculateSyrupCost(['blackberry', 'vanilla-bean'], 75).total * 100);
  const bd = await computeExtrasBreakdown(
    { selections: sel, proposal: { guest_count: 75, pricing_snapshot: { syrups: { selections: [] } }, num_bars: 0 } },
    pool
  );
  assert.equal(bd.syrupCents, expectSyrupCents);
  assert.equal(bd.addonCents, 0);
  assert.equal(bd.barRentalCents, 0);
  assert.equal(bd.totalCents, expectSyrupCents);
});

test('computeExtrasBreakdown: excludes self-provided and already-in-snapshot syrups', async () => {
  const sel = {
    syrupSelections: { d1: ['blackberry', 'vanilla-bean', 'mint'] },
    syrupSelfProvided: ['mint'],
  };
  // proposal already priced 'blackberry' -> only 'vanilla-bean' is new.
  const expectSyrupCents = Math.round(calculateSyrupCost(['vanilla-bean'], 40).total * 100);
  const bd = await computeExtrasBreakdown(
    { selections: sel, proposal: { guest_count: 40, pricing_snapshot: { syrups: { selections: ['blackberry'] } }, num_bars: 0 } },
    pool
  );
  assert.equal(bd.syrupCents, expectSyrupCents);
  assert.equal(bd.totalCents, expectSyrupCents);
});

test('computeExtrasBreakdown: a non-array syrupSelfProvided cannot suppress or crash charges', async () => {
  // Public token payload. A string would substring-match real ids via .includes
  // (suppressing charges); an object would throw. Both must be treated as [].
  const asString = await computeExtrasBreakdown(
    { selections: { syrupSelections: { d1: ['blackberry'] }, syrupSelfProvided: 'blackberry' },
      proposal: { guest_count: 75, pricing_snapshot: { syrups: { selections: [] } }, num_bars: 0 } },
    pool
  );
  const expected = Math.round(calculateSyrupCost(['blackberry'], 75).total * 100);
  assert.equal(asString.syrupCents, expected, 'a string self-provided must not suppress the charge');

  const asObject = await computeExtrasBreakdown(
    { selections: { syrupSelections: { d1: ['blackberry'] }, syrupSelfProvided: {} },
      proposal: { guest_count: 75, pricing_snapshot: { syrups: { selections: [] } }, num_bars: 0 } },
    pool
  );
  assert.equal(asObject.syrupCents, expected, 'an object self-provided must not crash or suppress');
});

// The priced cases: a scripted client answers the package row, the contract's
// add-ons (none) and the catalog rows for the new slugs by SQL shape, DB-free.
const PKG = {
  id: 5, slug: 'core', name: 'The Core Reaction', category: 'byob', pricing_type: 'flat', bar_type: 'byob',
  base_rate_4hr: 350, base_rate_4hr_small: 300, min_guests: 50, guests_per_bartender: 75,
  extra_hour_rate: 75, extra_hour_rate_small: 60, first_bar_fee: 50, additional_bar_fee: 100,
};
const CATALOG = {
  pg: { id: 21, slug: 'pg', name: 'Per Guest', rate: '5', billing_type: 'per_guest', is_active: true },
  fl: { id: 22, slug: 'fl', name: 'Flat', rate: '50', billing_type: 'flat', is_active: true },
};
const stubClient = {
  async query(text, params) {
    if (/FROM service_packages WHERE id = \$1/.test(text)) return { rows: [PKG], rowCount: 1 };
    if (/FROM proposal_addons pa/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM service_addons WHERE slug = ANY/.test(text)) {
      const rows = params[0].map((slug) => CATALOG[slug]).filter(Boolean);
      return { rows, rowCount: rows.length };
    }
    if (/FROM service_extensions/.test(text)) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected query: ${text}`);
  },
};
const pricedProposal = (numBars) => ({
  id: 4242, package_id: PKG.id, guest_count: 100, event_duration_hours: 4, num_bars: numBars, num_bartenders: 2,
  gratuity_rate: 0, tip_jar: true, gratuity_floor_rate: null, adjustments: [], pricing_snapshot: { syrups: { selections: [] } },
});

test('computeExtrasBreakdown: per_guest + flat add-ons + first bar rental priced correctly', async () => {
  const sel = {
    addOns: { pg: { enabled: true }, fl: { enabled: true } },
    logistics: { addBarRental: true },
  };
  const bd = await computeExtrasBreakdown({ selections: sel, proposal: pricedProposal(0) }, stubClient);
  // per_guest 5*100 = 500 + flat 50 = 550 -> 55000c; first bar 50 -> 5000c.
  assert.equal(bd.addonCents, 55000);
  assert.equal(bd.barRentalCents, 5000);
  assert.equal(bd.syrupCents, 0);
  assert.equal(bd.totalCents, 60000);
});

test('computeExtrasBreakdown: bar rental prices as ADDITIONAL when numBars>=1', async () => {
  const bd = await computeExtrasBreakdown(
    { selections: { logistics: { addBarRental: true } }, proposal: pricedProposal(1) },
    stubClient
  );
  assert.equal(bd.barRentalCents, 10000); // additional_bar_fee
  assert.equal(bd.totalCents, 10000);
});

after(async () => { await pool.end(); });
