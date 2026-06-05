require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PROPOSAL_SUMMARY_COLUMNS, shapeFocus } = require('./summary');

test('PROPOSAL_SUMMARY_COLUMNS includes venue trio + override + archive_reason (parity guard)', () => {
  for (const c of ['venue_name', 'venue_city', 'venue_state', 'total_price_override', 'archive_reason'])
    assert.ok(PROPOSAL_SUMMARY_COLUMNS.includes(c), `missing ${c}`);
});
test('shapeFocus: override wins; balance = effective - paid; booked; venue city,state', () => {
  const f = shapeFocus({ token: 't', status: 'deposit_paid', event_date: '2026-10-03',
    total_price: '5000.00', total_price_override: '4800.00', amount_paid: '1000.00',
    venue_name: null, venue_city: 'Lake Forest', venue_state: 'IL', drink_plan_token: null, drink_plan_submitted_at: null });
  assert.equal(f.total_price, 4800); assert.equal(f.balance_due, 3800);
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
