require('dotenv').config();
process.env.NODE_ENV = 'test';

/**
 * A tip clawback lands in the open period containing TODAY, keyed by the
 * original shift, even while the event's own period is still open (audit
 * 2026-11-05, POUT-03 verify: the main-branch behavior, kept on purpose).
 *
 * The POUT-03 lane briefly booked the claw in the event's own period while it
 * was open, so that it netted into the wage line. The verify pass showed that
 * widened a pre-existing hazard: a refund before completion then left a pure
 * debt stub (hours 0, rate 0) in the event's period, which accrual read as the
 * worker's prior line and seeded a 0 wage from (H1). The period-keyed prior
 * lookup already closes the cross-period case on its own, so the landing rule
 * went back to main's: today's open period, the stub kept out of the wage
 * line's way, and accrual told to never seed from a stub.
 *
 * Harness: clawbackTip over an in-memory client stub keyed on the SQL text
 * (the stripePayoutSync.unconfigured.test.js pattern), recording which period
 * each payout upsert targets. No database.
 *
 * Run: node --test server/utils/payrollClawback.eventPeriod.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { clawbackTip } = require('./payrollClawback');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollClawback.eventPeriod.test.js refuses to run against production');
}

const TIP_ID = 8001;
const SHIFT_ID = 8101;
const BARTENDER_A = 8201;
const BARTENDER_B = 8202;
const EVENT_PERIOD = 41;
const TODAY_PERIOD = 42;

const realConnect = pool.connect;
let eventPeriodLookups; // how many times a lookup of the event's own period ran (none expected)
let payoutPeriods;      // the pay_period_id of every ensurePayout call
let todayLookups;       // how many times the "period containing today" SELECT ran

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id, shift_id, amount_cents, fee_cents, refunded_amount_cents')) {
    return {
      rows: [{
        id: TIP_ID, shift_id: SHIFT_ID, amount_cents: 4000, fee_cents: 128, refunded_amount_cents: 0,
        target_user_id: BARTENDER_A, deferred_at: null, defer_kind: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT sr.user_id, (u.cc_id LIKE')) {
    return { rows: [{ user_id: BARTENDER_A, is_stub: false }, { user_id: BARTENDER_B, is_stub: false }], rowCount: 2 };
  }
  // A lookup of the event's own period through the shift's proposal: the
  // event's period is OPEN here, and it must still not be chosen.
  if (sql.includes('FROM shifts s') && sql.includes('JOIN pay_periods pp')) {
    eventPeriodLookups += 1;
    return { rows: [{ id: EVENT_PERIOD, status: 'open' }], rowCount: 1 };
  }
  // payrollProcessing.findOpenPeriodForDate: the period containing today.
  if (sql.startsWith('SELECT id, start_date, end_date, payday, status FROM pay_periods WHERE status = \'open\'')) {
    todayLookups += 1;
    return {
      rows: [{ id: TODAY_PERIOD, start_date: '2026-10-20', end_date: '2026-10-26', payday: '2026-10-27', status: 'open' }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('INSERT INTO payouts')) {
    payoutPeriods.push(params[0]);
    return { rows: [{ id: 500 + Number(params[1]) }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO payout_events')) {
    return { rows: [{ held_state: null }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

before(() => {
  pool.connect = () => Promise.resolve({
    query: (text, params) => Promise.resolve(answer(text, params)),
    release: () => {},
  });
});

beforeEach(() => {
  payoutPeriods = [];
  todayLookups = 0;
  eventPeriodLookups = 0;
});

after(() => { pool.connect = realConnect; });

test('the claw lands in the open period containing today, keyed by the original shift, and the event period is never consulted', async () => {
  const result = await clawbackTip(TIP_ID, 4000);
  assert.equal(result.delta, 4000);
  assert.equal(result.bartenders, 2);
  assert.equal(result.period_id, TODAY_PERIOD, 'today, as on main: never the event period, open or not');
  assert.deepEqual(payoutPeriods, [TODAY_PERIOD, TODAY_PERIOD]);
  assert.equal(todayLookups, 1);
  assert.equal(eventPeriodLookups, 0, 'no lookup of the event period exists on this path');
});
