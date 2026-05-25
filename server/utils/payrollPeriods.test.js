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

const { computePayday, isWorkingDay, usFederalHolidays } = require('./payrollPeriods');

test('isWorkingDay > a normal Tuesday is a working day', () => {
  assert.equal(isWorkingDay('2026-05-26'), true);
});

test('isWorkingDay > a Saturday is not a working day', () => {
  assert.equal(isWorkingDay('2026-05-30'), false);
});

test('usFederalHolidays > Memorial Day 2026 is the last Monday of May', () => {
  assert.ok(usFederalHolidays(2026).has('2026-05-25'));
});

test('isWorkingDay > a federal holiday Monday is not a working day', () => {
  // 2026-05-25 is Memorial Day.
  assert.equal(isWorkingDay('2026-05-25'), false);
});

test('computePayday > normal week: payday is the Tuesday after the closing Monday', () => {
  // Period ends Monday 2026-06-01; that Monday is a working day, Tuesday is payday.
  assert.equal(computePayday('2026-06-01'), '2026-06-02');
});

test('computePayday > Memorial Day week: closing Monday is a holiday, payday slides to Wednesday', () => {
  // Period ends Monday 2026-05-25 (Memorial Day). Tue is working day 1, Wed is payday.
  assert.equal(computePayday('2026-05-25'), '2026-05-27');
});
