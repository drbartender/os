require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Prod (Render + the pg session) runs GMT while the dev box runs Chicago local
// time. Pin the process to UTC so timezone regressions (notice-date derivation
// off cancelled_at) reproduce here exactly as they would in prod. Business-time
// reads in the code under test are tz-explicit (chicagoYmdOf / chicagoTodayYmd),
// so this only de-masks LOCAL-component bugs.
process.env.TZ = 'UTC';

// P6.7: cancel-booked-event route. DB-bound; Stripe is a DI stub (getStripe seam,
// overridden before the router is required). Covers preview math, the transactional
// cancel (archive + shift-cancel + comms-delete + invoice-void), guards
// (wrong last name 422, already-archived 409, autopay in_progress 409), suppress
// toggles, cancel-time tip clawback idempotency + frozen-period deferral, and the
// multi-charge cancellation refund.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('cancel.test.js refuses to run against production');
}

// Fake Stripe (DI) — install before requiring the router (cancel.js destructures
// getStripe at load).
const refundsCreated = [];
const fakeStripe = {
  refunds: {
    create: async ({ payment_intent, amount }) => {
      const id = `re_${payment_intent}_${amount}_${crypto.randomBytes(3).toString('hex')}`;
      refundsCreated.push({ payment_intent, amount, id });
      return { id, payment_intent, amount, status: 'succeeded' };
    },
  },
};
require('../../utils/stripeClient').getStripe = () => fakeStripe;
const { clawbackTipByPaymentIntent } = require('../../utils/payrollClawback');
const { payPeriodForDate, computePayday } = require('../../utils/payrollPeriods');
const { chicagoTodayYmd, eventLocalToUtc } = require('../../utils/businessTime');

const proposalsRouter = require('./index');

const NONCE = `cxl-${Date.now()}`;
let server, baseUrl;
let adminSeq = 0;

// Fresh admin per request: the cancel endpoints sit behind adminWriteLimiter
// (10/min keyed by user id), and this suite fires ~15 admin POSTs in seconds.
// Minting a throwaway admin per call keeps every bucket at 1 with no budget
// arithmetic to drift (the crud.test.js budget-note failure mode).
async function mintAdmin() {
  adminSeq += 1;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version) VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`,
    [`${NONCE}-admin-${adminSeq}@example.test`]
  );
  seededUsers.push(u.rows[0].id);
  return jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET);
}
const seeded = []; // proposal ids to clean
const seededClients = [];
const seededUsers = [];

function post(path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end(payload);
  });
}

let seq = 0;
async function seedBooked(opts = {}) {
  seq += 1;
  const {
    status = 'balance_paid',
    totalPrice = 1000,
    amountPaid = 1000,
    eventDaysOut = 30,
    gratuityDollars = 150,
    depositPaidCents = 10000,
    balancePaidCents = 90000,
    autopayStatus = null,
    clientName = 'Jane Smith',
    withShiftTip = false,
    tipAmountCents = 4000,
  } = opts;

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [clientName, `${NONCE}-${seq}@example.com`]
  );
  const clientId = c.rows[0].id;
  seededClients.push(clientId);

  const snapshot = { breakdown: [{ label: 'Shared Gratuity', amount: gratuityDollars }] };
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, amount_paid, pricing_snapshot, autopay_status,
                            autopay_enrolled)
     VALUES ($1, $2, 'wedding', 'America/Chicago',
             (CURRENT_DATE + ($3 || ' days')::interval), '18:00', 4,
             $4, $5, $6, $7, false)
     RETURNING id`,
    [clientId, status, String(eventDaysOut), totalPrice, amountPaid, JSON.stringify(snapshot), autopayStatus]
  );
  const proposalId = p.rows[0].id;
  seeded.push(proposalId);

  // Deposit invoice (paid) + Balance invoice (sent, unpaid).
  const depInv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Deposit', $3, $3, 'paid') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, depositPaidCents]
  );
  const balanceDueCents = Math.round(totalPrice * 100) - depositPaidCents;
  const balInv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', $3, 0, 'sent') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, balanceDueCents]
  );

  // Payments: deposit + balance succeeded, each with an intent (refundable).
  const depPay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'deposit', $2, 'succeeded', $3) RETURNING id`,
    [proposalId, depositPaidCents, `pi_dep_${NONCE}_${seq}`]
  );
  await pool.query(`INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)`,
    [depInv.rows[0].id, depPay.rows[0].id, depositPaidCents]);
  let balPayId = null;
  if (balancePaidCents > 0) {
    const balPay = await pool.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
       VALUES ($1, 'balance', $2, 'succeeded', $3) RETURNING id`,
      [proposalId, balancePaidCents, `pi_bal_${NONCE}_${seq}`]
    );
    balPayId = balPay.rows[0].id;
    // Balance paid onto the Balance invoice.
    await pool.query(`UPDATE invoices SET amount_paid = $2, status = 'paid' WHERE id = $1`,
      [balInv.rows[0].id, balancePaidCents]);
    await pool.query(`INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)`,
      [balInv.rows[0].id, balPayId, balancePaidCents]);
  }

  // A pending balance-reminder scheduled message (should be deleted on cancel).
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ($1, 'proposal', 'balance_due_today', 'client', $2, 'email', NOW() + INTERVAL '5 days', 'pending')`,
    [proposalId, clientId]
  );

  const out = { clientId, proposalId, depInvId: depInv.rows[0].id, balInvId: balInv.rows[0].id, depPayId: depPay.rows[0].id, balPayId };

  if (withShiftTip) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${NONCE}-bt-${seq}@example.com`]
    );
    const bartenderId = u.rows[0].id;
    seededUsers.push(bartenderId);
    const s = await pool.query(
      `INSERT INTO shifts (proposal_id, event_date, status) VALUES ($1, CURRENT_DATE, 'confirmed') RETURNING id`,
      [proposalId]
    );
    const shiftId = s.rows[0].id;
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'bartender', 'approved')`,
      [shiftId, bartenderId]
    );
    const tipIntent = `pi_tip_${NONCE}_${seq}`;
    const t = await pool.query(
      `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, stripe_payment_intent_id, tipped_at, shift_id, fee_cents, refunded_amount_cents)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), $4, 0, 0) RETURNING id`,
      [bartenderId, tipAmountCents, tipIntent, shiftId]
    );
    out.shiftId = shiftId;
    out.bartenderId = bartenderId;
    out.tipId = t.rows[0].id;
    out.tipIntent = tipIntent;
    out.tipAmountCents = tipAmountCents;
  }
  return out;
}

async function cleanupProposal(o) {
  const pid = o.proposalId;
  await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [pid]);
  await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [pid]);
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [pid]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [pid]);
  await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`, [pid]);
  if (o.shiftId) {
    await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1`, [o.shiftId]);
    await pool.query('DELETE FROM tips WHERE shift_id = $1', [o.shiftId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [o.shiftId]);
    if (o.bartenderId) {
      await pool.query('DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id = $1)', [o.bartenderId]);
      await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [o.bartenderId]);
    }
    await pool.query('DELETE FROM shifts WHERE id = $1', [o.shiftId]);
  }
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  if (o.clientId) await pool.query('DELETE FROM clients WHERE id = $1', [o.clientId]);
}

async function setTodayPeriod(status) {
  const ymd = chicagoTodayYmd();
  const { startDate, endDate } = payPeriodForDate(ymd);
  const payday = computePayday(endDate);
  const prior = await pool.query('SELECT id, status FROM pay_periods WHERE start_date = $1', [startDate]);
  if (prior.rows[0]) {
    await pool.query('UPDATE pay_periods SET status = $2 WHERE id = $1', [prior.rows[0].id, status]);
    return { existed: true, id: prior.rows[0].id, status: prior.rows[0].status };
  }
  const ins = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status) VALUES ($1,$2,$3,$4) RETURNING id`,
    [startDate, endDate, payday, status]);
  return { existed: false, id: ins.rows[0].id };
}
async function restoreTodayPeriod(prior) {
  if (!prior) return;
  if (prior.existed) await pool.query('UPDATE pay_periods SET status = $2 WHERE id = $1', [prior.id, prior.status]);
  else await pool.query('DELETE FROM payouts WHERE pay_period_id = $1', [prior.id]).then(() => pool.query('DELETE FROM pay_periods WHERE id = $1', [prior.id]));
}

// Seed an ACCRUED card-tip payout line for a shift (what payrollAccrual writes at
// event completion). The over-claw guard keys on payout_events.card_tip_net_cents
// > 0 for the shift; seeding this makes the cancel-time clawback take the real
// claw path (defense-in-depth branch) instead of the never-accrued skip.
async function seedAccruedTipLine(periodId, contractorId, shiftId, cents) {
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ($1, $2)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET pay_period_id = EXCLUDED.pay_period_id
     RETURNING id`,
    [periodId, contractorId]);
  const payoutId = po.rows[0].id;
  await pool.query(
    `INSERT INTO payout_events
       (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
        gratuity_share_cents, card_tip_gross_cents, card_tip_fee_cents,
        card_tip_net_cents, adjustment_cents, line_total_cents)
     VALUES ($1, $2, 0, 0, 0, 0, 0, $3, 0, $3, 0, $3)`,
    [payoutId, shiftId, cents]);
  await pool.query('UPDATE payouts SET total_cents = $2 WHERE id = $1', [payoutId, cents]);
  return payoutId;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', proposalsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const uid of seededUsers) await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  await pool.end();
});

test('preview: client >14d fully paid returns the correct math, staff and comms', async () => {
  const o = await seedBooked({ eventDaysOut: 30 });
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel/preview`, await mintAdmin(), { mode: 'client' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.days_out > 14, `days_out should be >14, got ${r.body.days_out}`);
    assert.equal(r.body.refund_cents, 86250, 'excess 71250 + gratuity 15000');
    assert.equal(r.body.refund_breakdown.gratuity_cents, 15000);
    assert.equal(r.body.refund_breakdown.excess_cents, 71250);
    assert.equal(r.body.refund_breakdown.fee_cents, 3750);
    assert.ok(Array.isArray(r.body.comms_halted));
    assert.ok(r.body.comms_halted.length >= 1, 'the pending balance reminder shows in comms_halted');
    assert.ok(r.body.email_preview && r.body.email_preview.subject);
    assert.ok(!/[—–]/.test(r.body.email_preview.text), 'no em/en dashes in email copy');
  } finally { await cleanupProposal(o); }
});

test('cancel: client >14d archives, cancels shift, voids balance invoice, deletes pending comms', async () => {
  const o = await seedBooked({ eventDaysOut: 30, balancePaidCents: 0, amountPaid: 100, withShiftTip: true });
  // balancePaidCents 0 leaves the Balance invoice unpaid (voidable); amountPaid 100
  // (deposit only) so gratuity is unfunded (0) and this is a deposit-only >14d case.
  const prior = await setTodayPeriod('open');
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'smith', suppress_client_email: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'archived');

    const prop = await pool.query('SELECT status, archive_reason, cancelled_by, cancelled_at FROM proposals WHERE id = $1', [o.proposalId]);
    assert.equal(prop.rows[0].status, 'archived');
    assert.equal(prop.rows[0].archive_reason, 'client_cancelled');
    assert.equal(prop.rows[0].cancelled_by, 'client');
    assert.ok(prop.rows[0].cancelled_at, 'cancelled_at stamped');

    const shift = await pool.query('SELECT status FROM shifts WHERE id = $1', [o.shiftId]);
    assert.equal(shift.rows[0].status, 'cancelled', 'linked shift cancelled');
    const sr = await pool.query("SELECT status FROM shift_requests WHERE shift_id = $1", [o.shiftId]);
    assert.equal(sr.rows[0].status, 'denied', 'approved request denied');

    const bal = await pool.query('SELECT status FROM invoices WHERE id = $1', [o.balInvId]);
    assert.equal(bal.rows[0].status, 'void', 'unpaid balance invoice voided');
    const dep = await pool.query('SELECT status FROM invoices WHERE id = $1', [o.depInvId]);
    assert.equal(dep.rows[0].status, 'paid', 'paid deposit invoice untouched');

    const pending = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
      [o.proposalId]);
    assert.equal(pending.rows[0].n, 0, 'pending proposal comms deleted');
  } finally {
    await cleanupProposal(o);
    await restoreTodayPeriod(prior);
  }
});

test('cancel: <=14d fully paid refunds gratuity only', async () => {
  const o = await seedBooked({ eventDaysOut: 5 });
  const prior = await setTodayPeriod('open');
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Smith' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refund_cents, 15000, 'gratuity-only refund');
    assert.equal(r.body.refund_breakdown.excess_cents, 0);
    assert.equal(r.body.refund_breakdown.fee_cents, 0);
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('cancel: drb mode fully refunds and marks we_cancelled/admin', async () => {
  const o = await seedBooked({ eventDaysOut: 5 });
  const prior = await setTodayPeriod('open');
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'drb', confirm_last_name: 'Smith' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refund_cents, 100000, 'full refund of everything paid');
    assert.equal(r.body.archive_reason, 'we_cancelled');
    assert.equal(r.body.cancelled_by, 'admin');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('cancel: wrong last name is rejected 422 and nothing is archived', async () => {
  const o = await seedBooked({ eventDaysOut: 30 });
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Wrongname' });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'LAST_NAME_MISMATCH');
    const prop = await pool.query('SELECT status FROM proposals WHERE id = $1', [o.proposalId]);
    assert.notEqual(prop.rows[0].status, 'archived', 'proposal not archived on a failed name gate');
  } finally { await cleanupProposal(o); }
});

test('cancel: already-archived returns 409', async () => {
  const o = await seedBooked({ eventDaysOut: 30 });
  await pool.query(`UPDATE proposals SET status = 'archived', archive_reason = 'client_cancelled' WHERE id = $1`, [o.proposalId]);
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Smith' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'ALREADY_ARCHIVED');
  } finally { await cleanupProposal(o); }
});

test('cancel: autopay in_progress returns 409', async () => {
  const o = await seedBooked({ eventDaysOut: 30, status: 'deposit_paid', autopayStatus: 'in_progress' });
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Smith' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'AUTOPAY_IN_PROGRESS');
    const prop = await pool.query('SELECT status FROM proposals WHERE id = $1', [o.proposalId]);
    assert.notEqual(prop.rows[0].status, 'archived', 'not archived while a charge is mid-flight');
  } finally { await cleanupProposal(o); }
});

test('cancel: suppress_staff_notifications skips staff sends', async () => {
  const o = await seedBooked({ eventDaysOut: 30, withShiftTip: true });
  const prior = await setTodayPeriod('open');
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Smith', suppress_staff_notifications: true, suppress_client_email: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.staff_notified, 0, 'no staff notified when suppressed');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('clawback skip: a never-accrued tip advances the marker with NO payout adjustment; webhook stays a no-op', async () => {
  // Over-claw guard: accrual is completion-gated and cancel is booked-only, so
  // this tip was never accrued into a payout line. A negative adjustment would
  // reverse money never granted; the cancel must only advance the marker so the
  // later charge.refunded webhook clawback computes delta<=0 and no-ops.
  const o = await seedBooked({ eventDaysOut: 30, withShiftTip: true, tipAmountCents: 4000 });
  const prior = await setTodayPeriod('open');
  try {
    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Smith', suppress_client_email: true, suppress_staff_notifications: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const afterCancel = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE pe.shift_id = $1 AND po.contractor_id = $2`,
      [o.shiftId, o.bartenderId]);
    assert.equal(afterCancel.rows[0].n, 0, 'no adjustment line for a never-accrued tip');
    const tip1 = await pool.query('SELECT refunded_amount_cents, deferred_at FROM tips WHERE id = $1', [o.tipId]);
    assert.equal(Number(tip1.rows[0].refunded_amount_cents), 4000, 'refunded marker advanced to full tip');
    assert.equal(tip1.rows[0].deferred_at, null, 'no deferral marker on the skip path');

    // Simulate the charge.refunded webhook for the SAME tip + cumulative amount.
    await clawbackTipByPaymentIntent(o.tipIntent, 4000);

    const afterWebhook = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE pe.shift_id = $1 AND po.contractor_id = $2`,
      [o.shiftId, o.bartenderId]);
    assert.equal(afterWebhook.rows[0].n, 0, 'webhook is a marker no-op; still no line');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('clawback accrued: an accrued card-tip line IS clawed at cancel; webhook replay does not double-claw', async () => {
  // Defense-in-depth branch of the guard: when an accrued card-tip payout line
  // EXISTS for the shift, cancel claws it back (negative adjustment netted into
  // the same line via ON CONFLICT), and a later charge.refunded webhook replay
  // computes delta=0 against the marker and no-ops.
  const o = await seedBooked({ eventDaysOut: 30, withShiftTip: true, tipAmountCents: 4000 });
  const prior = await setTodayPeriod('open');
  try {
    await seedAccruedTipLine(prior.id, o.bartenderId, o.shiftId, 4000);

    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Smith', suppress_client_email: true, suppress_staff_notifications: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const afterCancel = await pool.query(
      `SELECT pe.adjustment_cents, pe.card_tip_net_cents, pe.line_total_cents, COUNT(*) OVER ()::int AS n
         FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE pe.shift_id = $1 AND po.contractor_id = $2`,
      [o.shiftId, o.bartenderId]);
    assert.equal(afterCancel.rows[0].n, 1, 'still one line (clawback netted into the accrued row)');
    assert.equal(Number(afterCancel.rows[0].adjustment_cents), -4000, 'full tip clawed as a negative adjustment');
    assert.equal(Number(afterCancel.rows[0].card_tip_net_cents), 4000, 'original accrued tip untouched');
    assert.equal(Number(afterCancel.rows[0].line_total_cents), 0, 'line nets to zero (tip granted then clawed)');
    const tip1 = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [o.tipId]);
    assert.equal(Number(tip1.rows[0].refunded_amount_cents), 4000, 'refunded marker advanced to full tip');

    // Simulate the charge.refunded webhook for the SAME tip + cumulative amount.
    await clawbackTipByPaymentIntent(o.tipIntent, 4000);

    const afterWebhook = await pool.query(
      `SELECT COALESCE(SUM(adjustment_cents),0)::int AS adj, COUNT(*)::int AS n
         FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE pe.shift_id = $1 AND po.contractor_id = $2`,
      [o.shiftId, o.bartenderId]);
    assert.equal(afterWebhook.rows[0].n, 1, 'still one line after the webhook (no double-claw)');
    assert.equal(afterWebhook.rows[0].adj, -4000, 'adjustment unchanged (delta=0 no-op)');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('clawback frozen-period: an accrued tip defers with a marker while the period is frozen', async () => {
  const o = await seedBooked({ eventDaysOut: 30, withShiftTip: true, tipAmountCents: 4000 });
  const prior = await setTodayPeriod('processing'); // today's period is frozen
  try {
    // Accrued line exists (guard passes), but today's period is frozen, so the
    // claw DEFERS: marker untouched, defer_kind='clawback' written for retry.
    await seedAccruedTipLine(prior.id, o.bartenderId, o.shiftId, 4000);

    const r = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Smith', suppress_client_email: true, suppress_staff_notifications: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const tip = await pool.query('SELECT refunded_amount_cents, deferred_at, defer_kind, defer_target_cents FROM tips WHERE id = $1', [o.tipId]);
    assert.ok(tip.rows[0].deferred_at, 'clawback deferred while the period is frozen');
    assert.equal(tip.rows[0].defer_kind, 'clawback', 'deferral marked as a clawback');
    assert.equal(Number(tip.rows[0].defer_target_cents), 4000, 'defer target is the full tip');
    assert.equal(Number(tip.rows[0].refunded_amount_cents), 0, 'refunded marker NOT advanced (deferred)');
    // The seeded accrued line is untouched — no adjustment landed in a frozen period.
    const lines = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(adjustment_cents),0)::int AS adj
         FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE pe.shift_id = $1 AND po.contractor_id = $2`,
      [o.shiftId, o.bartenderId]);
    assert.equal(lines.rows[0].n, 1, 'only the seeded accrued line exists');
    assert.equal(lines.rows[0].adj, 0, 'no clawback adjustment landed in a frozen period');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('refund: a drb cancellation refund spans the deposit + balance charges', async () => {
  const o = await seedBooked({ eventDaysOut: 30, totalPrice: 1000, amountPaid: 1000,
    depositPaidCents: 10000, balancePaidCents: 90000 });
  const prior = await setTodayPeriod('open');
  try {
    // Cancel first (drb → full refund target = $1000).
    const c = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'drb', confirm_last_name: 'Smith', suppress_client_email: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.refund_cents, 100000);

    refundsCreated.length = 0;
    const idem = crypto.randomBytes(6).toString('hex');
    const r = await post(`/api/proposals/${o.proposalId}/cancel/refund`, await mintAdmin(), { idempotency_key: idem });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refunded_cents, 100000, 'full amount refunded');
    assert.equal(r.body.charges.length, 2, 'refund spanned two charges (deposit + balance)');

    // Two succeeded refund rows written, summing to the total.
    const refunds = await pool.query(
      `SELECT amount, gratuity_cents FROM proposal_refunds WHERE proposal_id = $1 AND status = 'succeeded'`,
      [o.proposalId]);
    assert.equal(refunds.rows.length, 2, 'two succeeded refund rows');
    const sum = refunds.rows.reduce((a, x) => a + Number(x.amount), 0);
    assert.equal(sum, 100000, 'refund rows sum to the full amount');
    const gratSum = refunds.rows.reduce((a, x) => a + Number(x.gratuity_cents || 0), 0);
    assert.equal(gratSum, 15000, 'gratuity portion attributed across the refund rows');

    // A second refund click is a no-op (target already met).
    const r2 = await post(`/api/proposals/${o.proposalId}/cancel/refund`, await mintAdmin(), { idempotency_key: crypto.randomBytes(6).toString('hex') });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.refunded_cents, 0, 'nothing more to refund');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('refund: a drink_plan_with_balance charge is refundable at cancellation (no silent clamp)', async () => {
  const o = await seedBooked({ eventDaysOut: 30, totalPrice: 1000, amountPaid: 1000,
    depositPaidCents: 10000, balancePaidCents: 70000 });
  const prior = await setTodayPeriod('open');
  try {
    // Remaining $200 was paid through the drink-plan combined checkout.
    await pool.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
       VALUES ($1, 'drink_plan_with_balance', 20000, 'succeeded', $2)`,
      [o.proposalId, `pi_dp_${NONCE}_dpa`]
    );

    const c = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'drb', confirm_last_name: 'Smith', suppress_client_email: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.refund_cents, 100000, 'target includes the drink-plan payment');

    refundsCreated.length = 0;
    const r = await post(`/api/proposals/${o.proposalId}/cancel/refund`, await mintAdmin(),
      { idempotency_key: crypto.randomBytes(6).toString('hex') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refunded_cents, 100000, 'drink-plan charge is reachable, nothing clamped');
    assert.equal(r.body.shortfall_cents, 0, 'no stranded remainder');
    assert.equal(r.body.charges.length, 3, 'refund spanned deposit + balance + drink-plan charges');
    const stripeSum = refundsCreated.reduce((a, x) => a + x.amount, 0);
    assert.equal(stripeSum, 100000, 'Stripe saw the full amount');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('refund: daysOut uses the CHICAGO day of cancelled_at, so an evening cancel cannot flip the <=14d branch', async () => {
  const o = await seedBooked({ eventDaysOut: 15, totalPrice: 1000, amountPaid: 1000,
    depositPaidCents: 10000, balancePaidCents: 90000 });
  const prior = await setTodayPeriod('open');
  try {
    // Pin the event exactly 15 CHICAGO-days out, independent of the pg session date.
    const chicagoToday = chicagoTodayYmd();
    const [cy, cm, cd] = chicagoToday.split('-').map(Number);
    const eventYmd = new Date(Date.UTC(cy, cm - 1, cd + 15, 12)).toISOString().slice(0, 10);
    await pool.query(`UPDATE proposals SET event_date = $2 WHERE id = $1`, [o.proposalId, eventYmd]);

    const c = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'client', confirm_last_name: 'Smith', suppress_client_email: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    // >14d branch: (100000 - 10000 retainer - 15000 gratuity) * 0.95 + 15000.
    assert.equal(c.body.refund_cents, 86250, 'cancel-time math promised the >14d amount');

    // Simulate an evening cancel: 19:30 in Chicago is already TOMORROW in UTC,
    // which under the old local-component derivation read daysOut as 14.
    const eveningInstant = eventLocalToUtc(chicagoToday, 19, 30, 'America/Chicago');
    await pool.query(`UPDATE proposals SET cancelled_at = $2 WHERE id = $1`, [o.proposalId, eveningInstant]);

    refundsCreated.length = 0;
    const r = await post(`/api/proposals/${o.proposalId}/cancel/refund`, await mintAdmin(),
      { idempotency_key: crypto.randomBytes(6).toString('hex') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refunded_cents, 86250, 'refund-time daysOut matches the promised >14d amount');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('refund: a pending refund row (Stripe reached, unreconciled) is netted, so a retry cannot double-issue', async () => {
  const o = await seedBooked({ eventDaysOut: 30, totalPrice: 1000, amountPaid: 1000,
    depositPaidCents: 10000, balancePaidCents: 90000 });
  const prior = await setTodayPeriod('open');
  try {
    const c = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'drb', confirm_last_name: 'Smith', suppress_client_email: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));

    // Simulate a prior /cancel/refund attempt that reached Stripe on the balance
    // charge but died before reconciliation: the row stays 'pending' (with
    // stripe_refund_id NULL — reconciliation is what stamps it) until the
    // charge.refunded webhook adopts it. A fresh-idempotency-key retry follows.
    await pool.query(
      `INSERT INTO proposal_refunds
         (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
          total_price_before, total_price_after, status)
       VALUES ($1, $2, 'pi_pending_sim', 90000, 'Event cancellation refund (Dr. Bartender)',
               1000, 1000, 'pending')`,
      [o.proposalId, o.balPayId]
    );

    refundsCreated.length = 0;
    const r = await post(`/api/proposals/${o.proposalId}/cancel/refund`, await mintAdmin(),
      { idempotency_key: crypto.randomBytes(6).toString('hex') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.already_refunded_cents, 90000, 'the in-flight pending amount counts as already refunded');
    assert.equal(r.body.refunded_cents, 10000, 'only the uncovered deposit remainder is issued');
    const stripeSum = refundsCreated.reduce((a, x) => a + x.amount, 0);
    assert.equal(stripeSum, 10000, 'Stripe was NOT asked to re-issue the pending 90000');
    const balRows = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM proposal_refunds WHERE payment_id = $1 GROUP BY status`,
      [o.balPayId]);
    assert.deepEqual(balRows.rows, [{ status: 'pending', n: 1 }], 'no new refund row on the pending charge');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});

test('refund: a legacy-CC (no-intent) payment surfaces as shortfall_cents, never silently clamped', async () => {
  const o = await seedBooked({ eventDaysOut: 30, totalPrice: 1200, amountPaid: 1200,
    depositPaidCents: 10000, balancePaidCents: 90000 });
  const prior = await setTodayPeriod('open');
  try {
    // $200 collected on the legacy Check Cherry rail: succeeded, but no Stripe
    // intent to refund against. The agreement target includes it; Stripe can't.
    await pool.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, legacy_charge_id)
       VALUES ($1, 'balance', 20000, 'succeeded', $2)`,
      [o.proposalId, `ch_legacy_${NONCE}`]
    );

    const c = await post(`/api/proposals/${o.proposalId}/cancel`, await mintAdmin(),
      { mode: 'drb', confirm_last_name: 'Smith', suppress_client_email: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.refund_cents, 120000, 'target includes the legacy payment');

    refundsCreated.length = 0;
    const r = await post(`/api/proposals/${o.proposalId}/cancel/refund`, await mintAdmin(),
      { idempotency_key: crypto.randomBytes(6).toString('hex') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.refunded_cents, 100000, 'only the Stripe-reachable charges are issued');
    assert.equal(r.body.shortfall_cents, 20000, 'the unreachable legacy amount is surfaced, not clamped');
    const stripeSum = refundsCreated.reduce((a, x) => a + x.amount, 0);
    assert.equal(stripeSum, 100000, 'Stripe was never asked to cover the legacy 20000');
  } finally { await cleanupProposal(o); await restoreTodayPeriod(prior); }
});
