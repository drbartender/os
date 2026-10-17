require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PROPOSAL_SUMMARY_COLUMNS, shapeFocus } = require('./summary');

test('PROPOSAL_SUMMARY_COLUMNS includes venue trio + archive_reason, never the override (parity guard)', () => {
  for (const c of ['venue_name', 'venue_city', 'venue_state', 'total_price', 'archive_reason'])
    assert.ok(PROPOSAL_SUMMARY_COLUMNS.includes(c), `missing ${c}`);
  // The portal reads total_price only (spec 2026-10-16 section 4.4).
  assert.ok(!PROPOSAL_SUMMARY_COLUMNS.includes('total_price_override'), 'the override is not selected');
});
test('shapeFocus: total_price wins over an override (gratuity included); balance = total_price - paid; booked; venue city,state', () => {
  // A $4,800 override with a $280 gratuity on top: total_price is 5080. The
  // override alone left the gratuity out of the Total and the balance.
  const f = shapeFocus({ token: 't', status: 'deposit_paid', event_date: '2026-10-03',
    total_price: '5080.00', total_price_override: '4800.00', amount_paid: '1000.00',
    venue_name: null, venue_city: 'Lake Forest', venue_state: 'IL', drink_plan_token: null, drink_plan_submitted_at: null });
  assert.equal(f.total_price, 5080); assert.equal(f.balance_due, 4080);
  assert.equal(f.booked, true); assert.equal(f.venue_label, 'Lake Forest, IL'); assert.equal(f.drink_plan_submitted, false);
});
test('shapeFocus: venue_name wins; submitted from submitted_at; not-booked', () => {
  const f = shapeFocus({ token: 't', status: 'sent', total_price: '5000.00', total_price_override: null,
    amount_paid: '0', venue_name: 'The Foundry', venue_city: 'Chicago', venue_state: 'IL',
    drink_plan_token: 'dp', drink_plan_submitted_at: '2026-01-01T00:00:00Z' });
  assert.equal(f.venue_label, 'The Foundry'); assert.equal(f.booked, false); assert.equal(f.drink_plan_submitted, true);
});
test('shapeFocus: no venue -> Location TBD; null money -> 0', () => {
  const f = shapeFocus({ token: 't', status: 'draft', total_price: null, total_price_override: null,
    amount_paid: null, venue_name: null, venue_city: null, venue_state: null, drink_plan_token: null, drink_plan_submitted_at: null });
  assert.equal(f.venue_label, 'Location TBD'); assert.equal(f.balance_due, 0);
});
