require('dotenv').config();

// Unit test for computeExtrasBreakdown — the shared drink-plan extras amount
// helper. Asserts against the real calculateSyrupCost (not a magic number) so a
// change to syrup pricing keeps the test honest. Runs against the dev DB only to
// close the pool; the syrup-only case never queries service_addons.

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
    { selections: sel, guestCount: 75, pricingSnapshot: { syrups: { selections: [] } }, numBars: 0 },
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
    { selections: sel, guestCount: 40, pricingSnapshot: { syrups: { selections: ['blackberry'] } }, numBars: 0 },
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
      guestCount: 75, pricingSnapshot: { syrups: { selections: [] } }, numBars: 0 },
    pool
  );
  const expected = Math.round(calculateSyrupCost(['blackberry'], 75).total * 100);
  assert.equal(asString.syrupCents, expected, 'a string self-provided must not suppress the charge');

  const asObject = await computeExtrasBreakdown(
    { selections: { syrupSelections: { d1: ['blackberry'] }, syrupSelfProvided: {} },
      guestCount: 75, pricingSnapshot: { syrups: { selections: [] } }, numBars: 0 },
    pool
  );
  assert.equal(asObject.syrupCents, expected, 'an object self-provided must not crash or suppress');
});

test('computeExtrasBreakdown: per_guest + flat add-ons + first bar rental priced correctly', async () => {
  // Stub the service_addons lookup so the add-on path is deterministic + DB-free.
  const stubClient = {
    query: async () => ({ rows: [
      { slug: 'pg', rate: '5', billing_type: 'per_guest' },
      { slug: 'fl', rate: '50', billing_type: 'flat' },
    ] }),
  };
  const sel = {
    addOns: { pg: { enabled: true }, fl: { enabled: true } },
    logistics: { addBarRental: true },
  };
  const bd = await computeExtrasBreakdown(
    { selections: sel, guestCount: 100,
      pricingSnapshot: { bar_rental: { first_bar_fee: 50, additional_bar_fee: 100 } }, numBars: 0 },
    stubClient
  );
  // per_guest 5*100 = 500 + flat 50 = 550 -> 55000c; first bar 50 -> 5000c.
  assert.equal(bd.addonCents, 55000);
  assert.equal(bd.barRentalCents, 5000);
  assert.equal(bd.syrupCents, 0);
  assert.equal(bd.totalCents, 60000);
});

test('computeExtrasBreakdown: bar rental prices as ADDITIONAL when numBars>=1', async () => {
  const bd = await computeExtrasBreakdown(
    { selections: { logistics: { addBarRental: true } }, guestCount: 100,
      pricingSnapshot: { bar_rental: { first_bar_fee: 50, additional_bar_fee: 100 } }, numBars: 1 },
    pool
  );
  assert.equal(bd.barRentalCents, 10000); // additional_bar_fee
  assert.equal(bd.totalCents, 10000);
});

after(async () => { await pool.end(); });
