const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDrinkPlanPreBooking } = require('./drinkPlanAccess');

test('post-booking statuses are NOT pre-booking (plan accessible)', () => {
  for (const s of ['deposit_paid', 'balance_paid', 'confirmed', 'completed']) {
    assert.equal(isDrinkPlanPreBooking(s), false, `${s} should be accessible`);
  }
});

test('pre-deposit statuses ARE pre-booking (plan locked)', () => {
  for (const s of ['sent', 'viewed', 'modified', 'accepted']) {
    assert.equal(isDrinkPlanPreBooking(s), true, `${s} should be locked`);
  }
});

test('fails safe: null/undefined/unknown statuses are locked', () => {
  assert.equal(isDrinkPlanPreBooking(null), true);
  assert.equal(isDrinkPlanPreBooking(undefined), true);
  assert.equal(isDrinkPlanPreBooking(''), true);
  assert.equal(isDrinkPlanPreBooking('cancelled'), true);
  assert.equal(isDrinkPlanPreBooking('totally_unknown'), true);
});
