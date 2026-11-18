// The Enhancement Lab's balance reads past due by the Chicago calendar day
// (audit PAY-07's rule, on the lab sibling it missed).
//
// THE DEFECT. balanceOf and the lab PUT's response compared the due date's
// midnight (pg hands a DATE back as a JS Date at the process-local midnight)
// with the current instant, so a balance due TODAY read as past due all day,
// a day before the scheduler charges it and the reminders call it due. The
// drink-plan rail compares calendar strings since PAY-07; the lab now does too.
//
// PURE: no database.
//
//   node --test server/routes/drinkPlans/labHelpers.pastDue.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { balanceOf, isBalancePastDue } = require('./labHelpers');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const { shiftYmd } = require('../../utils/balanceReminderScheduling');

// A DATE column the way pg returns it: the process-local midnight of the day.
const pgDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };
const plan = (dueYmd, paid = '100.00') => ({
  proposal_id: 1, proposal_total_price: '1000.00', proposal_amount_paid: paid, balance_due_date: pgDate(dueYmd),
});

test('a balance due today (the Chicago day) is not past due', () => {
  assert.equal(balanceOf(plan(chicagoTodayYmd())).past_due, false);
});

test('a balance due yesterday is past due', () => {
  assert.equal(balanceOf(plan(shiftYmd(chicagoTodayYmd(), -1))).past_due, true);
});

test('a paid-up balance is never past due, however old the date', () => {
  assert.equal(balanceOf(plan(shiftYmd(chicagoTodayYmd(), -30), '1000.00')).past_due, false);
});

test('isBalancePastDue reads a plain YYYY-MM-DD, and no date and no event reads not past due', () => {
  assert.equal(isBalancePastDue(50, shiftYmd(chicagoTodayYmd(), -1)), true);
  assert.equal(isBalancePastDue(50, chicagoTodayYmd()), false);
  assert.equal(isBalancePastDue(50, null), false);
});

test('with no balance_due_date the due day is the event day minus 14, as the drink-plan rail reads it', () => {
  const today = chicagoTodayYmd();
  // An event 13 days out: its due day (event minus 14) was yesterday.
  assert.equal(isBalancePastDue(50, null, pgDate(shiftYmd(today, 13))), true);
  // An event 14 days out: its due day is today, which is not past due.
  assert.equal(isBalancePastDue(50, null, pgDate(shiftYmd(today, 14))), false);
  assert.equal(balanceOf({ ...plan(today), balance_due_date: null, proposal_event_date: pgDate(shiftYmd(today, 13)) }).past_due, true);
});
