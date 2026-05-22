const { test } = require('node:test');
const assert = require('node:assert/strict');
const { payPeriodForDate } = require('./payrollPeriods');

test('payPeriodForDate > a Tuesday is the start of its own period', () => {
  // 2026-05-26 is a Tuesday.
  assert.deepEqual(payPeriodForDate('2026-05-26'), {
    startDate: '2026-05-26',
    endDate: '2026-06-01',
  });
});

test('payPeriodForDate > a Monday is the end of the period that started the prior Tuesday', () => {
  // 2026-06-01 is a Monday.
  assert.deepEqual(payPeriodForDate('2026-06-01'), {
    startDate: '2026-05-26',
    endDate: '2026-06-01',
  });
});

test('payPeriodForDate > a mid-week day resolves to its enclosing Tue-Mon window', () => {
  // 2026-05-29 is a Friday.
  assert.deepEqual(payPeriodForDate('2026-05-29'), {
    startDate: '2026-05-26',
    endDate: '2026-06-01',
  });
});
