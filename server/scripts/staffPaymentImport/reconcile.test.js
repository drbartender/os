// Pure-function tests for the reconcile matcher (fix 1). NO DB. Payments land ON
// payday (Tuesday, AFTER the Sunday period end), so the collection window is
// [start_date, payday+14d], not [start_date, end_date].
// Run: node --test server/scripts/staffPaymentImport/reconcile.test.js
const test = require('node:test');
const assert = require('node:assert');
const { matchReconcile } = require('./reconcile');

// One pending payout: period 2026-06-01 → 06-07 (Sun), payday 2026-06-09 (Tue).
// Collection window = [start_date, payday+14d] = [2026-06-01, 2026-06-23].
const PAYOUT = { id: 1, contractor_id: 99, total_cents: 20000, start_date: '2026-06-01', payday: '2026-06-09' };
const row = (paidOn, over = {}) => ({ cluster: 'p', contractorId: 99, paid_on: paidOn, amount_cents: 20000, platform: 'zelle', ...over });

test('a payment dated ON payday matches its payout', () => {
  const { matched, withoutPayout } = matchReconcile([row('2026-06-09')], [PAYOUT]);
  assert.strictEqual(matched.length, 1);
  assert.strictEqual(matched[0].payout.id, 1);
  assert.strictEqual(withoutPayout.length, 0);
});

test('a payment payday+13d still matches (late straggler, inside window)', () => {
  assert.strictEqual(matchReconcile([row('2026-06-22')], [PAYOUT]).matched.length, 1);
});

test('a payment payday+15d does NOT match (past the window)', () => {
  const { matched, withoutPayout, unmatchedPayouts } = matchReconcile([row('2026-06-24')], [PAYOUT]);
  assert.strictEqual(matched.length, 0);
  assert.strictEqual(withoutPayout.length, 1);
  assert.strictEqual(unmatchedPayouts.length, 1);
});

test('a payment before start_date does NOT match', () => {
  const { matched, withoutPayout } = matchReconcile([row('2026-05-31')], [PAYOUT]);
  assert.strictEqual(matched.length, 0);
  assert.strictEqual(withoutPayout.length, 1);
});

test('start_date/payday as JS Date objects (pg shape) work', () => {
  const p = { id: 2, contractor_id: 99, total_cents: 20000, start_date: new Date(2026, 5, 1), payday: new Date(2026, 5, 9) };
  assert.strictEqual(matchReconcile([row('2026-06-09')], [p]).matched.length, 1);
});

test('amount off by more than 1¢ misses; within 1¢ matches', () => {
  assert.strictEqual(matchReconcile([row('2026-06-09', { amount_cents: 20002 })], [PAYOUT]).matched.length, 0);
  assert.strictEqual(matchReconcile([row('2026-06-09', { amount_cents: 19999 })], [PAYOUT]).matched.length, 1);
});

test('a different contractor does not match', () => {
  assert.strictEqual(matchReconcile([row('2026-06-09', { contractorId: 7 })], [PAYOUT]).matched.length, 0);
});

test('one payout is consumed by at most one payment', () => {
  const { matched, withoutPayout } = matchReconcile([row('2026-06-09'), row('2026-06-10')], [PAYOUT]);
  assert.strictEqual(matched.length, 1);
  assert.strictEqual(withoutPayout.length, 1);
});
