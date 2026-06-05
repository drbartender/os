require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeEditWindow, filterToAllowlist } = require('./changeRequests');

test('computeEditWindow: not booked is pre_booking', () => {
  assert.equal(computeEditWindow({ status: 'sent', event_date: '2099-01-01' }), 'pre_booking');
});
test('computeEditWindow: booked, far out is before_t14', () => {
  assert.equal(computeEditWindow({ status: 'deposit_paid', event_date: '2099-01-01' }), 'before_t14');
});
test('computeEditWindow: booked, past date is inside_t14', () => {
  assert.equal(computeEditWindow({ status: 'confirmed', event_date: '2000-01-01' }), 'inside_t14');
});
test('filterToAllowlist drops note/acknowledged_total and rejects unknown keys', () => {
  const out = filterToAllowlist({ guest_count: 120, note: 'hi', acknowledged_total: 5000 });
  assert.deepEqual(out, { guest_count: 120 });
  assert.throws(() => filterToAllowlist({ total_price_override: 1 }), /not be changed/i);
  assert.throws(() => filterToAllowlist({ adjustments: [] }), /not be changed/i);
});
