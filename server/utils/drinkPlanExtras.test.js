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
    syrupSelections: { d1: ['blackberry', 'vanilla'] },
    syrupSelfProvided: [],
  };
  const expectSyrupCents = Math.round(calculateSyrupCost(['blackberry', 'vanilla'], 75).total * 100);
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
    syrupSelections: { d1: ['blackberry', 'vanilla', 'mint'] },
    syrupSelfProvided: ['mint'],
  };
  // proposal already priced 'blackberry' -> only 'vanilla' is new.
  const expectSyrupCents = Math.round(calculateSyrupCost(['vanilla'], 40).total * 100);
  const bd = await computeExtrasBreakdown(
    { selections: sel, guestCount: 40, pricingSnapshot: { syrups: { selections: ['blackberry'] } }, numBars: 0 },
    pool
  );
  assert.equal(bd.syrupCents, expectSyrupCents);
  assert.equal(bd.totalCents, expectSyrupCents);
});

after(async () => { await pool.end(); });
