// server/utils/proposalExtrasFold.comp.test.js
'use strict';
// H1 of the round-3 verify pass (audit PRC-01) through computeCatalogSnapshot,
// the catalog price of a booking's current inputs, over a scripted client, so
// it runs with no database: a booking paid in full at 35000 cents, a champagne
// toast added through pay-now at 75 guests (18750) and comped, then the
// headcount changed. The comp line's amount follows the toast's current price
// (compLine.js applyCompLines, which every pricer applies), so the catalog
// total stays 35000 at 50 guests (toast 12500, comp 12500) and at 100 guests
// (toast 25000, comp 25000), and the comp leaves when the toast is cancelled.
// Before round 3 the comp's cents were frozen at 18750: 50 guests priced
// 28750 (a 6250-cent "overpayment" the panel offered to refund) and 100
// guests 41250 (an Additional Services invoice for a comped add-on).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeCatalogSnapshot } = require('./proposalExtrasFold');

const PKG = {
  id: 1, slug: 'test-core', name: 'Test Core', category: 'byob', pricing_type: 'flat', bar_type: 'service_only',
  base_rate_4hr: 350, base_rate_3hr: null, extra_hour_rate: 100, min_guests: 0, bartenders_included: 1,
  guests_per_bartender: 100, extra_bartender_hourly: 40, first_bar_fee: 50, additional_bar_fee: 100, min_total: null,
};
const TOAST = {
  id: 42, slug: 'test-toast', name: 'Test Toast', billing_type: 'per_guest', rate: 2.5, extra_hour_rate: null,
  applies_to: 'all', is_active: true, minimum_hours: null,
};
// The comp as written at 75 guests: 18750 cents, naming the toast.
const COMP = {
  type: 'discount', label: 'Drink Plan Extras comped (INV0042)', amount: 187.5, visible: true, source: 'comp',
  comped: { addons: [42], bar: false, syrups: [] },
};
const cents = (n) => Math.round(Number(n) * 100);

// The row after the comp, with the headcount the admin set; the stored toast
// row still carries the 75-guest figures (the engine recovers the count from
// them and prices at the new headcount).
const row = (guests) => ({
  id: 77, package_id: 1, guest_count: guests, event_duration_hours: '4.0', num_bars: 0, num_bartenders: null,
  gratuity_rate: 0, tip_jar: true, gratuity_floor_rate: null, adjustments: [COMP],
  pricing_snapshot: { syrups: { selections: [] } },
});
const toastRow = () => ({
  ...TOAST, pa_quantity: '75', pa_line_total: '187.50', pa_rate: '2.50', pa_duration_hours: '4.0',
  pa_settled_added_hours: 0, pa_min_contracted_hours: null,
});
function scriptedClient({ toast = true } = {}) {
  return {
    query: (sql) => {
      if (/FROM service_packages WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [PKG] });
      if (/FROM proposal_addons pa/.test(sql)) return Promise.resolve({ rows: toast ? [toastRow()] : [] });
      if (/FROM service_extensions/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    },
  };
}

test('the comp follows the toast through a headcount change: the catalog total holds at 35000', async () => {
  for (const [guests, toastCents] of [[75, 18750], [50, 12500], [100, 25000]]) {
    const snap = await computeCatalogSnapshot(scriptedClient(), row(guests));
    assert.equal(cents(snap.addons[0].line_total), toastCents, `${guests} guests: the toast`);
    assert.equal(snap.adjustments.length, 1);
    assert.equal(cents(snap.adjustments[0].amount), toastCents, `${guests} guests: the comp equals the toast`);
    assert.equal(cents(snap.total), 35000, `${guests} guests: no overpayment, no additional invoice`);
  }
});

test('the toast cancelled: the comp leaves with it and the total holds', async () => {
  const snap = await computeCatalogSnapshot(scriptedClient({ toast: false }), row(50));
  assert.deepEqual(snap.addons, []);
  assert.deepEqual(snap.adjustments, []);
  assert.equal(cents(snap.total), 35000);
});
