require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('./errors');
const { accruePayoutsForProposal } = require('./payrollAccrual');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');
const { assemblePaystubData } = require('./paystubData');
const payrollRouter = require('../routes/admin/payroll');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrual.sweepPreserve.test.js refuses to run against production');
}

// HOLD semantics (fix #4 / P2.4, reworked post-review to structural state):
// when the accrual roster sweeps find an off-roster worker's line with a
// POSITIVE reimbursement adjustment, the line is HELD, not deleted:
// held_state='held', hours + every payable component zeroed, line_total_cents
// = 0 (non-payable), adjustment_cents preserved as the tracked number, note
// untouched. The payout-events PATCH re-arms line_total (= wage + gratuity +
// card_tip + adjustment) and flips held -> 'confirmed'; confirmed lines are
// NEVER re-held by later sweeps (sticky even if the admin edits the note).
// Re-adding the worker to the roster clears held_state and re-seeds hours
// from contracted so wage is restored. Held lines are excluded from paystub
// adjustment aggregates so the stub still foots. Negative clawback lines
// survive untouched; zero-adjustment lines are still deleted.

const EVENT_DATE = '2026-08-11';
const EMAILS = "email IN ('sweep-admin@example.com','sweep-current@example.com','sweep-a@example.com','sweep-b@example.com','sweep-d@example.com','sweep-e@example.com','sweep-f@example.com','sweep-g@example.com')";

let server, baseUrl, adminToken;
let periodId, proposalId1, proposalId2, shiftId1, shiftId2;
let adminId, currentId, userA, userB, userD, userE, userF, userG;
// payout_event ids for the seeded lines
let peA, peB, peD, peE;

async function seedUser(email, role = 'staff') {
  const u = await pool.query(
    'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [email, 'x', role]
  );
  return u.rows[0].id;
}

async function seedPayoutLine(contractorId, shiftId, {
  adjustment_cents, adjustment_note, wage_cents, hours, line_total_cents,
  held_state = null, payout_status = 'pending',
}) {
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET status = EXCLUDED.status
     RETURNING id`,
    [periodId, contractorId, payout_status, Math.max(0, line_total_cents)]
  );
  const payoutId = po.rows[0].id;
  const pe = await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        gratuity_share_cents, adjustment_cents, adjustment_note, line_total_cents, held_state)
     VALUES ($1, $2, $3, $3, 2000, $4, 0, $5, $6, $7, $8) RETURNING id, payout_id`,
    [payoutId, shiftId, hours, wage_cents, adjustment_cents, adjustment_note, line_total_cents, held_state]
  );
  return { eventId: pe.rows[0].id, payoutId };
}

async function cleanup() {
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM payout_events WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IS NULL AND event_date = '${EVENT_DATE}' AND event_type = 'sweep-preserve-test'))`);
  await pool.query(`DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IS NULL AND event_date = '${EVENT_DATE}' AND event_type = 'sweep-preserve-test'))`);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IS NULL AND event_date = '${EVENT_DATE}' AND event_type = 'sweep-preserve-test')`);
  await pool.query(`DELETE FROM proposals WHERE client_id IS NULL AND event_date = '${EVENT_DATE}' AND event_type = 'sweep-preserve-test'`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${EMAILS})`);
  await pool.query(`DELETE FROM users WHERE ${EMAILS}`);
}

before(async () => {
  await cleanup();

  // Canonical open pay period for the event date (accrual's ensurePayPeriod
  // resolves the same start_date, so our seeded payouts land in payPeriodId).
  const { startDate, endDate } = payPeriodForDate(EVENT_DATE);
  const payday = computePayday(endDate);
  const p = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open', end_date = EXCLUDED.end_date, payday = EXCLUDED.payday
     RETURNING id`,
    [startDate, endDate, payday]
  );
  periodId = p.rows[0].id;

  adminId = await seedUser('sweep-admin@example.com', 'admin');
  currentId = await seedUser('sweep-current@example.com');
  userA = await seedUser('sweep-a@example.com');
  userB = await seedUser('sweep-b@example.com');
  userD = await seedUser('sweep-d@example.com');
  userE = await seedUser('sweep-e@example.com');
  userF = await seedUser('sweep-f@example.com');
  userG = await seedUser('sweep-g@example.com');
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  // Proposal 1 (has one current worker -> exercises the roster-correction sweep).
  const pr1 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, pricing_snapshot)
     VALUES (NULL, $1, 'completed', 'sweep-preserve-test', '6:00 PM', 4, 1000, 0, '{"breakdown":[]}')
     RETURNING id`,
    [EVENT_DATE]
  );
  proposalId1 = pr1.rows[0].id;
  const s1 = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ($1, '6:00 PM', 'open', $2) RETURNING id`,
    [EVENT_DATE, proposalId1]
  );
  shiftId1 = s1.rows[0].id;

  // Current worker on shift 1: keeps the roster non-empty so accrual runs the
  // orphan sweep (not the empty-roster sweep).
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [shiftId1, currentId]
  );

  // Off-roster lines on shift 1 (their workers are not approved -> orphans):
  //  A: positive reimbursement -> HELD.
  ({ eventId: peA } = await seedPayoutLine(userA, shiftId1, {
    adjustment_cents: 500, adjustment_note: 'reimbursement for ice',
    wage_cents: 11000, hours: 5.5, line_total_cents: 11500,
  }));
  //  B: negative clawback debt -> preserved untouched.
  ({ eventId: peB } = await seedPayoutLine(userB, shiftId1, {
    adjustment_cents: -300, adjustment_note: 'tip clawback',
    wage_cents: 0, hours: 0, line_total_cents: -300,
  }));
  //  D: zero adjustment -> still deleted.
  ({ eventId: peD } = await seedPayoutLine(userD, shiftId1, {
    adjustment_cents: 0, adjustment_note: null,
    wage_cents: 5000, hours: 2.5, line_total_cents: 5000,
  }));

  // Proposal 2 (no current workers -> exercises the empty-roster sweep).
  const pr2 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, pricing_snapshot)
     VALUES (NULL, $1, 'completed', 'sweep-preserve-test', '7:00 PM', 4, 1000, 0, '{"breakdown":[]}')
     RETURNING id`,
    [EVENT_DATE]
  );
  proposalId2 = pr2.rows[0].id;
  const s2 = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ($1, '7:00 PM', 'open', $2) RETURNING id`,
    [EVENT_DATE, proposalId2]
  );
  shiftId2 = s2.rows[0].id;
  //  E: positive reimbursement on an event with no roster -> HELD via empty-roster sweep.
  ({ eventId: peE } = await seedPayoutLine(userE, shiftId2, {
    adjustment_cents: 700, adjustment_note: 'reimbursement for supplies',
    wage_cents: 8000, hours: 4, line_total_cents: 8700,
  }));

  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  await cleanup();
  await pool.query(
    `DELETE FROM pay_periods WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = $1)`,
    [periodId]
  );
  await pool.end();
});

function req(method, path_, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path_);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ method, hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => { let buf = ''; res.on('data', c => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: buf })); });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function lineById(id) {
  const { rows } = await pool.query('SELECT * FROM payout_events WHERE id = $1', [id]);
  return rows[0] || null;
}

test('orphan sweep: HOLDS a positive off-roster reimbursement (tracked, non-payable, structural state)', async () => {
  const res = await accruePayoutsForProposal(proposalId1);
  assert.equal(res.skipped, false, 'accrual ran (a current worker is on the roster)');

  const a = await lineById(peA);
  assert.ok(a, 'the positive-adjustment line survives the sweep (not deleted)');
  assert.equal(a.held_state, 'held', 'held_state set structurally');
  assert.equal(Number(a.adjustment_cents), 500, 'adjustment_cents preserved as the tracked number');
  assert.equal(Number(a.line_total_cents), 0, 'line_total_cents held at 0 (non-payable)');
  assert.equal(Number(a.wage_cents), 0, 'wage zeroed');
  assert.equal(Number(a.gratuity_share_cents), 0, 'gratuity zeroed');
  assert.equal(Number(a.card_tip_gross_cents), 0, 'card tip gross zeroed');
  assert.equal(Number(a.card_tip_fee_cents), 0, 'card tip fee zeroed');
  assert.equal(Number(a.card_tip_net_cents), 0, 'card tip net zeroed');
  assert.equal(Number(a.hours), 0, 'hours zeroed so a re-arm PATCH cannot resurrect wage');
  assert.equal(a.adjustment_note, 'reimbursement for ice', 'note untouched (no marker text)');
});

test('orphan sweep: preserves a negative clawback line unchanged', async () => {
  const b = await lineById(peB);
  assert.ok(b, 'the negative-adjustment line survives');
  assert.equal(b.held_state, null, 'clawback line is not held');
  assert.equal(Number(b.adjustment_cents), -300, 'adjustment unchanged');
  assert.equal(Number(b.line_total_cents), -300, 'line_total unchanged');
  assert.equal(b.adjustment_note, 'tip clawback', 'note untouched');
});

test('orphan sweep: still deletes a zero-adjustment off-roster line', async () => {
  const d = await lineById(peD);
  assert.equal(d, null, 'the zero-adjustment line was deleted');
});

test('empty-roster sweep: HOLDS a positive reimbursement when nobody is on the roster', async () => {
  const res = await accruePayoutsForProposal(proposalId2);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'no_approved_workers');
  const e = await lineById(peE);
  assert.ok(e, 'the positive-adjustment line survives the empty-roster sweep');
  assert.equal(e.held_state, 'held', 'held_state set structurally');
  assert.equal(Number(e.adjustment_cents), 700, 'adjustment preserved');
  assert.equal(Number(e.line_total_cents), 0, 'held at 0');
  assert.equal(Number(e.hours), 0, 'hours zeroed');
  assert.equal(e.adjustment_note, 'reimbursement for supplies', 'note untouched');
});

test('re-accrual is idempotent: a held line is not re-zeroed and its note stays clean', async () => {
  const before_ = await lineById(peA);
  assert.equal(before_.held_state, 'held', 'precondition: line is held');
  await accruePayoutsForProposal(proposalId1);
  const after_ = await lineById(peA);
  assert.equal(after_.held_state, 'held', 'still held');
  assert.equal(after_.adjustment_note, before_.adjustment_note, 'note untouched by re-accrual');
  assert.equal(Number(after_.line_total_cents), 0, 'still held at 0');
  assert.equal(Number(after_.adjustment_cents), 500, 'adjustment still tracked');
});

test('hold survives an admin note edit: cleaned note does NOT disarm the hold (critical defect 1)', async () => {
  // The old mechanism keyed idempotency on marker text in the free-text note; an
  // admin cleaning the note would disarm it and the next accrual re-zeroed the
  // line. With structural held_state, the note is irrelevant to hold semantics.
  await pool.query(
    `UPDATE payout_events SET adjustment_note = 'reimbursement for ice' WHERE id = $1`,
    [peA]
  );
  await accruePayoutsForProposal(proposalId1);
  const a = await lineById(peA);
  assert.equal(a.held_state, 'held', 'still held after a note edit');
  assert.equal(Number(a.adjustment_cents), 500, 'adjustment intact');
  assert.equal(Number(a.line_total_cents), 0, 'still non-payable');
});

test('PATCH re-arms a held reimbursement: line_total recomputes and held -> confirmed', async () => {
  // Dallas confirms the reimbursement is owed. A PATCH through the normal
  // editable-fields path recomputes line_total = wage + gratuity + card_tip +
  // adjustment (wage 0: hours were zeroed by the hold) and flips the line to
  // 'confirmed'.
  const r = await req('PATCH', `/api/admin/payroll/payout-events/${peA}`, adminToken, { adjustment_cents: 500 });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.event.held_state, 'confirmed', 'held flips to confirmed on admin PATCH');
  assert.equal(Number(body.event.line_total_cents), 500, 're-armed to the reimbursement amount');
  assert.equal(Number(body.event.adjustment_cents), 500);
  assert.equal(Number(body.event.wage_cents), 0, 'wage stays 0 (off-roster worker, held hours)');
  assert.equal(Number(body.payout_total_cents), 500, 'payout total reflects the re-armed line');
});

test('confirmed line is NEVER re-held: re-accrual with the worker still off roster leaves it payable', async () => {
  const pre = await lineById(peA);
  assert.equal(pre.held_state, 'confirmed', 'precondition: line is confirmed');
  const res = await accruePayoutsForProposal(proposalId1);
  assert.equal(res.skipped, false, 'accrual ran');
  const a = await lineById(peA);
  assert.equal(a.held_state, 'confirmed', 'still confirmed (not re-held, not deleted)');
  assert.equal(Number(a.line_total_cents), 500, 'stays payable at the confirmed amount');
  assert.equal(Number(a.adjustment_cents), 500, 'adjustment intact');
  const po = await pool.query(
    'SELECT total_cents FROM payouts WHERE id = $1', [a.payout_id]
  );
  assert.equal(Number(po.rows[0].total_cents), 500, 'payout total keeps the confirmed line');
});

test('roster re-add: held worker regains contracted wage; held_state cleared; adjustment preserved (critical defect 2)', async () => {
  // Re-add userA to the roster. The worker loop must NOT treat the held hours=0
  // as admin-owned: hours re-seed from contracted_hours, wage is restored, the
  // hold is cleared, and the reimbursement rides along.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')
     ON CONFLICT (shift_id, user_id) DO UPDATE SET status = 'approved', dropped_at = NULL`,
    [shiftId1, userA]
  );
  try {
    const res = await accruePayoutsForProposal(proposalId1);
    assert.equal(res.skipped, false, 'accrual ran');
    const a = await lineById(peA);
    assert.equal(a.held_state, null, 'held_state cleared on roster re-add');
    assert.equal(Number(a.hours), 5.5, 'hours re-seeded from contracted_hours (not the held 0)');
    assert.equal(Number(a.wage_cents), 11000, 'contracted wage restored (5.5h x $20/hr)');
    assert.equal(Number(a.adjustment_cents), 500, 'reimbursement preserved');
    assert.equal(a.adjustment_note, 'reimbursement for ice', 'note preserved');
    assert.equal(Number(a.line_total_cents), 11500, 'line_total = wage + adjustment');
  } finally {
    // Take userA back off the roster and re-hold the line so later tests see a
    // stable baseline (the sweep will hold it again since held_state is NULL).
    await pool.query(
      'DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2',
      [shiftId1, userA]
    );
    await accruePayoutsForProposal(proposalId1);
    const a = await lineById(peA);
    assert.equal(a.held_state, 'held', 'line re-held after the worker went off roster again');
  }
});

test('paystub excludes held lines from adjustment aggregates (this-period and YTD) so the stub foots', async () => {
  // userF: one normal paid line (wage 10000) + one HELD line (adjustment 500,
  // line_total 0) in the same PAID payout. The paystub's Adjustments must
  // exclude the held 500 in both thisPeriod and YTD, so Adjustments + Wages
  // reconcile with net (payout total_cents = 10000).
  const { payoutId } = await seedPayoutLine(userF, shiftId1, {
    adjustment_cents: 0, adjustment_note: null,
    wage_cents: 10000, hours: 5, line_total_cents: 10000,
    payout_status: 'paid',
  });
  await seedPayoutLine(userF, shiftId2, {
    adjustment_cents: 500, adjustment_note: 'held reimbursement',
    wage_cents: 0, hours: 0, line_total_cents: 0,
    held_state: 'held',
    payout_status: 'paid',
  });
  await pool.query(
    `UPDATE payouts SET total_cents = 10000, paid_at = NOW(), payment_method = 'venmo'
      WHERE id = $1`,
    [payoutId]
  );
  const stub = await assemblePaystubData(userF, periodId);
  assert.ok(stub, 'paystub data assembled');
  assert.equal(stub.thisPeriod.adjustments_cents, 0, 'this-period adjustments exclude the held line');
  assert.equal(stub.thisPeriod.wages_cents, 10000, 'wages unaffected');
  assert.equal(stub.thisPeriod.net_cents, 10000, 'net = canonical payout total');
  assert.equal(stub.ytd.adjustments_cents, 0, 'YTD adjustments exclude the held line');
  assert.equal(stub.ytd.wages_cents, 10000, 'YTD wages include the paid wage line');
  assert.equal(stub.ytd.net_cents, 10000, 'YTD net = paid payout totals');
});

test('schema backfill stamps held_state on old marker rows and is idempotent', async () => {
  // Extract the ACTUAL backfill statement from schema.sql (pins the file and the
  // test to the same SQL), seed a row held by the old note-marker mechanism, run
  // the backfill twice: first run stamps it, second run is a global no-op.
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'
  );
  const m = schema.match(/UPDATE payout_events\s+SET held_state = 'held'[\s\S]*?;/);
  assert.ok(m, 'backfill UPDATE present in schema.sql');
  const backfillSql = m[0];

  const { eventId } = await seedPayoutLine(userG, shiftId2, {
    adjustment_cents: 300,
    adjustment_note: 'gas money [held: worker off roster, confirm at payroll]',
    wage_cents: 0, hours: 0, line_total_cents: 0,
  });
  const first = await pool.query(backfillSql);
  assert.ok(first.rowCount >= 1, 'first run stamps at least the seeded marker row');
  const g = await lineById(eventId);
  assert.equal(g.held_state, 'held', 'marker row migrated to structural held_state');
  assert.equal(Number(g.adjustment_cents), 300, 'adjustment untouched by backfill');
  const second = await pool.query(backfillSql);
  assert.equal(second.rowCount, 0, 'second run is a no-op (idempotent)');
});
