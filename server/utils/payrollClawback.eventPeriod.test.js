require('dotenv').config();
process.env.NODE_ENV = 'test';

/**
 * A tip clawback lands in the EVENT's own pay period while that period is
 * still open, and only falls through to today's period when the event's
 * period is frozen (audit 2026-11-05, POUT-03).
 *
 * clawbackTip always picked "the open period containing today". For a tip on
 * an event whose own period was still open, that minted a synthetic debt row
 * (hours 0, wage 0, negative adjustment) in a LATER period, keyed by the
 * event's shift, instead of netting into the wage line that sits in the
 * event's period. Accrual then found two rows for one contractor+shift and
 * could seed the event period's wage line from the stub (wage lost, claw
 * booked twice), and the debt sat in a period that may never collect it.
 *
 * Harness: clawbackTip over an in-memory client stub keyed on the SQL text
 * (the stripePayoutSync.unconfigured.test.js pattern), recording which period
 * each payout upsert targets. The DB-backed sibling in payrollClawback.test.js
 * asserts the merged line against Postgres.
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
let eventPeriodRows;   // what the event-period lookup answers with
let payoutPeriods;     // the pay_period_id of every ensurePayout call
let todayLookups;      // how many times the "period containing today" SELECT ran

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
  // The event's own period, through the shift's proposal.
  if (sql.includes('FROM shifts s') && sql.includes('JOIN pay_periods pp')) {
    return { rows: eventPeriodRows, rowCount: eventPeriodRows.length };
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
  eventPeriodRows = [];
});

after(() => { pool.connect = realConnect; });

test('the event period is open: the claw lands there, on both bartenders, and today is never consulted', async () => {
  eventPeriodRows = [{ id: EVENT_PERIOD, status: 'open' }];
  const result = await clawbackTip(TIP_ID, 4000);
  assert.equal(result.delta, 4000);
  assert.equal(result.bartenders, 2);
  assert.equal(result.period_id, EVENT_PERIOD, 'the claw is booked in the period that holds the wage line');
  assert.deepEqual(payoutPeriods, [EVENT_PERIOD, EVENT_PERIOD]);
  assert.equal(todayLookups, 0, 'no stray row in a later period');
});

test('the event period is frozen: the claw falls through to the open period containing today', async () => {
  eventPeriodRows = [];
  const result = await clawbackTip(TIP_ID, 4000);
  assert.equal(result.period_id, TODAY_PERIOD);
  assert.deepEqual(payoutPeriods, [TODAY_PERIOD, TODAY_PERIOD]);
  assert.equal(todayLookups, 1);
});
