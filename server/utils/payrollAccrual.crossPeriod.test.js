require('dotenv').config();
process.env.NODE_ENV = 'test';

/**
 * Accrual's prior-line lookup is scoped to the period being written, and a
 * wage line that already lives in ANOTHER period is a hard stop, never a seed
 * (audit 2026-11-05, POUT-03).
 *
 * `existing` was keyed by contractor:shift across every pay period, so:
 *   A. after an event-date move, a PAID line in the frozen period seeded a
 *      second payable line in the open period (the contractor paid twice);
 *   B. a clawback stub that landed in a later open period (hours 0, wage 0,
 *      a negative adjustment) could win the key and rewrite the event's own
 *      wage line to 0 hours, 0 wage and the debt, booking the claw twice and
 *      losing the wage, and which row won depended on SELECT order.
 *
 * Harness: accruePayoutsForProposal over an in-memory pool stub keyed on the
 * SQL text (the stripePayoutSync.unconfigured.test.js pattern), recording the
 * payout and payout_events writes instead of executing them. The DB-backed
 * siblings in payrollAccrual.test.js run the same scenarios against Postgres.
 *
 * Run: node --test server/utils/payrollAccrual.crossPeriod.test.js
 */

const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { accruePayoutsForProposal } = require('./payrollAccrual');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrual.crossPeriod.test.js refuses to run against production');
}

const PROPOSAL_ID = 7001;
const SHIFT_ID = 7101;
const WORKER_ID = 7201;
const P1 = 31; // the event's own period
const P2 = 32; // the next period

const realQuery = pool.query;
const realConnect = pool.connect;

// Per-test knobs.
let thisPeriod;        // { id, status } ensurePayPeriod answers with
let existingRows;      // what the existing-lines SELECT answers with
let payoutInserts;     // ensurePayout calls (params)
let lineInserts;       // payout_events upserts (params)

function line(overrides) {
  return {
    id: 1, payout_id: 1, shift_id: SHIFT_ID, contracted_hours: '5.50', hours: '5.50',
    rate_cents: 2000, wage_cents: 11000, late: false, gratuity_share_cents: 0,
    card_tip_gross_cents: 0, card_tip_fee_cents: 0, card_tip_net_cents: 0,
    adjustment_cents: 0, adjustment_note: null, line_total_cents: 11000, held_state: null,
    contractor_id: WORKER_ID, pay_period_id: P1,
    ...overrides,
  };
}

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id, event_date, status, event_duration_hours')) {
    return {
      rows: [{
        id: PROPOSAL_ID, event_date: new Date(2026, 9, 17), status: 'completed',
        event_duration_hours: '4.0', total_price: '1000.00', amount_paid: '1000.00',
        pricing_snapshot: '{"addons":[],"breakdown":[]}',
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('INSERT INTO pay_periods')) {
    return { rows: [thisPeriod], rowCount: 1 };
  }
  if (sql.startsWith('SELECT sr.user_id, sr.position, s.id AS shift_id')) {
    return { rows: [{ user_id: WORKER_ID, position: 'Bartender', shift_id: SHIFT_ID, hourly_rate: '20.00' }], rowCount: 1 };
  }
  if (sql.includes('FROM service_extensions')) return { rows: [{ cents: 0 }], rowCount: 1 };
  if (sql.includes('FROM proposal_payments pp')) return { rows: [{ fee: 0 }], rowCount: 1 };
  if (sql.startsWith('SELECT COALESCE(SUM(t.amount_cents), 0) AS gross')) return { rows: [{ gross: 0, fee: 0 }], rowCount: 1 };
  if (sql.startsWith('SELECT pe.*, po.contractor_id, po.pay_period_id')) {
    return { rows: existingRows, rowCount: existingRows.length };
  }
  if (sql.startsWith('INSERT INTO payouts')) {
    payoutInserts.push(params);
    return { rows: [{ id: 500 + Number(params[0]) }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO payout_events')) {
    lineInserts.push(params);
    return { rows: [], rowCount: 1 };
  }
  // The duty context (no proposal row: skipped), the legacy-stub guard, the
  // fee captures, the deferred-tip sweep and the total recompute: nothing.
  return { rows: [], rowCount: 0 };
}

before(() => {
  pool.query = (text, params) => Promise.resolve(answer(text, params));
  pool.connect = () => Promise.resolve({
    query: (text, params) => Promise.resolve(answer(text, params)),
    release: () => {},
  });
});

beforeEach(() => {
  payoutInserts = [];
  lineInserts = [];
  thisPeriod = { id: P1, status: 'open' };
  existingRows = [];
  mock.restoreAll();
});

after(() => {
  mock.restoreAll();
  pool.query = realQuery;
  pool.connect = realConnect;
});

// INSERT INTO payout_events params: payout_id, shift_id, contracted_hours,
// hours, rate_cents, wage_cents, late, gratuity, tip gross, tip fee, tip net,
// adjustment_cents, adjustment_note, line_total_cents.
function written(params) {
  return {
    contracted_hours: params[2], hours: params[3], rate_cents: params[4], wage_cents: params[5],
    adjustment_cents: params[11], line_total_cents: params[13],
  };
}

test('A: a PAID line for this shift in a frozen period is a hard stop, not a seed for the open period', async () => {
  const sentry = mock.method(Sentry, 'captureMessage');
  thisPeriod = { id: P2, status: 'open' };
  existingRows = [line({ pay_period_id: P1, id: 11, payout_id: 91 })];

  const result = await accruePayoutsForProposal(PROPOSAL_ID);
  assert.equal(result.skipped, false);
  assert.deepEqual(lineInserts, [], 'no second wage line for a shift already paid in another period');
  assert.deepEqual(payoutInserts, [], 'and no phantom payout stub is minted for the skipped worker');

  const warnings = sentry.mock.calls.filter((c) => /another period/i.test(String(c.arguments[0])));
  assert.equal(warnings.length, 1, 'one Sentry warning for the skipped worker');
  const extra = warnings[0].arguments[1].extra;
  assert.deepEqual(extra.other_period_ids, [P1], 'the warning names the period that holds the line');
  assert.equal(extra.contractorId, WORKER_ID);
  assert.equal(extra.shiftId, SHIFT_ID);
  assert.equal(extra.payPeriodId, P2);
});

for (const order of ['wage line first', 'claw stub first']) {
  test(`B: a clawback stub in a later period never rewrites the event period's wage line (${order})`, async () => {
    const sentry = mock.method(Sentry, 'captureMessage');
    thisPeriod = { id: P1, status: 'open' };
    const wage = line({ pay_period_id: P1, id: 11, payout_id: 91 });
    const claw = line({
      pay_period_id: P2, id: 12, payout_id: 92, contracted_hours: '0.00', hours: '0.00',
      rate_cents: 0, wage_cents: 0, adjustment_cents: -1936,
      adjustment_note: 'Chargeback on tip 5: +$40.00 (cumulative $40.00)', line_total_cents: -1936,
    });
    existingRows = order === 'wage line first' ? [wage, claw] : [claw, wage];

    await accruePayoutsForProposal(PROPOSAL_ID);
    assert.equal(lineInserts.length, 1, 'the P1 line is rewritten once');
    assert.deepEqual(written(lineInserts[0]), {
      contracted_hours: 5.5, hours: 5.5, rate_cents: 2000, wage_cents: 11000,
      adjustment_cents: 0, line_total_cents: 11000,
    }, 'seeded from P1 own line: the claw stub in P2 is neither a seed nor a stop');
    assert.equal(payoutInserts[0][0], P1, 'written to the event period payout');
    assert.equal(sentry.mock.calls.length, 0, 'a pure debt stub elsewhere is not a cross-period wage line');
  });
}

test('a held reimbursement line in another period is not a stop: the worker still accrues here', async () => {
  // Held = hours and every payable zeroed, the reimbursement tracked. The
  // wage for this shift is not carried by that row, so it must not block a
  // fresh line in the period being written.
  thisPeriod = { id: P2, status: 'open' };
  existingRows = [line({
    pay_period_id: P1, id: 13, payout_id: 93, contracted_hours: '5.50', hours: '0.00',
    wage_cents: 0, adjustment_cents: 5000, line_total_cents: 0, held_state: 'held',
  })];
  await accruePayoutsForProposal(PROPOSAL_ID);
  assert.equal(lineInserts.length, 1);
  assert.deepEqual(written(lineInserts[0]), {
    contracted_hours: 5.5, hours: 5.5, rate_cents: 2000, wage_cents: 11000,
    adjustment_cents: 0, line_total_cents: 11000,
  }, 'a first accrual for this period, seeded from the contract');
});
