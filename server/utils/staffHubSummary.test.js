// Unit tests for the pure open-period summary behind the Staff hub subtitle.
// No DB, no network: the helper is pure date math plus a row shape.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeOpenPeriod } = require('./staffHubSummary');

test('a Wednesday with no row derives the Tue..Mon window and exists:false', () => {
  // 2026-08-19 is a Wednesday; the period is Tue 08-18 .. Mon 08-24, payday Tue 08-25.
  const out = summarizeOpenPeriod({ todayYmd: '2026-08-19', row: null });
  assert.deepEqual(out, {
    start_date: '2026-08-18',
    end_date: '2026-08-24',
    payday: '2026-08-25',
    exists: false,
    status: null,
    payouts_accrued: 0,
  });
});

test('a Tuesday is the first day of its own period, not the last of the prior one', () => {
  const out = summarizeOpenPeriod({ todayYmd: '2026-08-18', row: null });
  assert.equal(out.start_date, '2026-08-18');
  assert.equal(out.end_date, '2026-08-24');
});

test('a Monday is the last day of the period that began the prior Tuesday', () => {
  const out = summarizeOpenPeriod({ todayYmd: '2026-08-24', row: null });
  assert.equal(out.start_date, '2026-08-18');
});

test('an existing row fills exists, status and the accrued count', () => {
  const out = summarizeOpenPeriod({
    todayYmd: '2026-08-19',
    row: { status: 'open', payouts_accrued: '3' },
  });
  assert.equal(out.exists, true);
  assert.equal(out.status, 'open');
  assert.equal(out.payouts_accrued, 3);
});
