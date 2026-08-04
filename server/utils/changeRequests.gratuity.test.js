// Election-at-payment (spec 2026-08-03): a change-request preview must carry the
// proposal's STORED gratuity into the re-price. Before this, priceProposedState
// omitted gratuityRate/tipJar entirely, so a paid proposal's change-request
// preview silently dropped the client's paid gratuity line and quoted a total
// below what they owe. Pure-function suite: priceProposedState takes a `db` with
// a .query method, so no seeding is needed.

require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { priceProposedState, buildPreview } = require('./changeRequests');

if (process.env.NODE_ENV === 'production') {
  throw new Error('changeRequests.gratuity.test.js refuses to run against production');
}

// Fixture columns mirror the real service_packages schema — copied from the BYOB
// fixture in server/utils/pricingEngine.test.js, not invented.
const PKG = { id: 1, slug: 'byob', name: 'BYOB Bar', category: 'byob', pricing_type: 'flat',
  bar_type: 'byob', base_rate_4hr: 1000, base_rate_3hr: 900, extra_hour_rate: 150,
  bartenders_included: 1, min_guests: 0, guests_per_bartender: 100, extra_bartender_hourly: 40,
  first_bar_fee: 50, additional_bar_fee: 100 };
const fakeDb = { query: async (sql) => sql.includes('service_packages')
  ? { rows: [PKG] } : { rows: [] } };

test('priceProposedState carries the stored gratuity into the preview', async () => {
  const proposal = {
    id: 1, package_id: 1, guest_count: 50, event_duration_hours: 5, num_bars: 1,
    gratuity_rate: 50, tip_jar: false,
    pricing_snapshot: { gratuity: { staff_count: 1, hours: 5 } },
    adjustments: [], total_price_override: null, client_provides_glassware: false,
  };
  const snap = await priceProposedState(proposal, { guest_count: 50 }, fakeDb);
  const line = snap.breakdown.find(l => l.label === 'Gratuity');
  assert.ok(line, 'preview keeps the Gratuity line');
  assert.equal(line.amount, 250, '50/staff/hr x 1 staff x 5h');
});

// The baseline half of the same seam: once the ESTIMATE carries the stored
// gratuity, the CURRENT total it is compared against must carry it too.
// total_price_override is a SERVICE-level number that excludes gratuity (the
// engine layers gratuity on top of the override, never diluting it), so
// baselining on the override made a no-op change request preview a phantom
// +gratuity delta on any paid proposal that had both. total_price is the right
// baseline: every writer stores snapshot.total, which already includes both.
test('buildPreview baselines on total_price, so a no-op on an override + gratuity proposal is delta 0', async () => {
  const proposal = {
    id: 3, package_id: 1, guest_count: 50, event_duration_hours: 5, num_bars: 1,
    gratuity_rate: 50, tip_jar: false,
    total_price_override: 1000, total_price: 1250,
    pricing_snapshot: { gratuity: { staff_count: 1, hours: 5 } },
    adjustments: [], client_provides_glassware: false,
  };
  const { price_preview } = await buildPreview(proposal, { guest_count: 50 }, fakeDb);
  assert.equal(price_preview.estimated_total, 1250, 'override 1000 + 250 gratuity');
  assert.equal(price_preview.current_total, 1250,
    'baseline must include the gratuity the estimate includes');
  assert.equal(price_preview.delta, 0, 'a no-op change request shows no phantom delta');
});

test('priceProposedState defaults to jar-on / no gratuity when the proposal carries none', async () => {
  const proposal = {
    id: 2, package_id: 1, guest_count: 50, event_duration_hours: 5, num_bars: 1,
    gratuity_rate: 0, tip_jar: true,
    pricing_snapshot: { gratuity: { staff_count: 1, hours: 5 } },
    adjustments: [], total_price_override: null, client_provides_glassware: false,
  };
  const snap = await priceProposedState(proposal, { guest_count: 50 }, fakeDb);
  assert.ok(!snap.breakdown.some(l => l.label === 'Gratuity'),
    'an unpaid/jar-on proposal previews with no gratuity line');
  assert.equal(snap.gratuity.tip_jar, true);
});
