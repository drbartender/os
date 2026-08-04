require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// No Sentry sends from a test run; every capture in the handler gates on this.
process.env.SENTRY_DSN_SERVER = '';

// Task 11 (service extension): the webhook settle tail. Calls the handler
// function DIRECTLY with a synthetic intent (no signature verification), per
// the plan. Covers the seven cases from the plan: happy path, side money,
// deposit-only regression guard, replay, paid-after-expiry, ordinary Balance
// inertness, and no-dunning (spec decision 12).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('paymentIntentSucceeded.extension.test.js refuses to run against production');
}

// ─── Stubs ──────────────────────────────────────────────────────────────────
// The handler lazy-requires both modules inside its post-commit tail, so
// mutating the shared require-cache exports here intercepts those calls: no
// real sends (notify) and no real payroll writes (applyExtensionHours).
// finalizeExtension is deliberately left REAL so the suite asserts the actual
// finalized_at stamp in the DB. That stamp is the Task 13 heal signal; a stub
// would let the handler skip it and this suite would never notice.
const notify = require('../../utils/serviceExtensionNotify');
const payroll = require('../../utils/serviceExtensionPayroll');

const staffCalls = [];
const alertCalls = [];
const payrollCalls = [];
const payrollAlertCalls = [];

// Keep the REAL payroll functions reachable: test 8 (the completed-then-settle
// gratuity ordering pin) swaps them back in for its one handler call, because
// its whole point is that the real applyExtensionHours result gates a real
// accruePayoutsForProposal re-run. The handler destructures these properties
// lazily at settle time, so a per-test property swap on the shared module
// object is enough.
const realApplyExtensionHours = payroll.applyExtensionHours;
const realMaybeAlertPayroll = payroll.maybeAlertPayroll;

notify.notifyStaffOfOutcome = async (args) => {
  staffCalls.push(args);
  return { notified: args.staffUserIds || [], unreachable: [] };
};
notify.alertAdminsProblem = async (args) => { alertCalls.push(args); };
const stubApplyExtensionHours = async (args) => {
  payrollCalls.push(args);
  return { updatedLines: 1, lockedLines: 0, frozenLines: 0, multiShiftSkipped: false, payoutIds: [] };
};
const stubMaybeAlertPayroll = async (_notify, proposalId, result) => {
  payrollAlertCalls.push({ proposalId, result });
};
payroll.applyExtensionHours = stubApplyExtensionHours;
payroll.maybeAlertPayroll = stubMaybeAlertPayroll;

const handlePaymentIntentSucceeded = require('./paymentIntentSucceeded');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;

const clientIds = [];
const proposalIds = [];
const userIds = [];

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const byProposal = (calls, proposalId) =>
  calls.filter((c) => String(c.proposalId) === String(proposalId));

/**
 * One full extension shape: client -> proposal (4h event, 6:00 PM start) ->
 * single shift -> one approved staffer on the roster -> extension invoice ->
 * service_extensions row (4h -> 4.5h, so the settled end is 10:30 PM).
 * Literal date strings throughout, so no timezone-frame ambiguity.
 */
async function seedFixture({
  proposalStatus = 'confirmed',
  totalPrice = 1000,          // dollars: proposals money is NUMERIC DOLLARS
  amountPaid = 500,           // dollars
  withExtension = true,
  extensionStatus = 'pending',
  invoiceStatus = 'sent',
  invoiceLabel = 'Service Extension',
  amountCents = 10000,        // cents: invoices/Stripe money is INTEGER CENTS
  gratuityCents = 0,          // cents: service_extensions.gratuity_cents
  eventDate = '2026-09-10',   // test 8 uses a far-past accrual week instead
  pricingSnapshot = '{}',     // test 8 seeds a Shared Gratuity line
} = {}) {
  seq += 1;
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Ext Webhook', $1) RETURNING id`,
    [`extwh-${NONCE}-${seq}@example.test`]
  );
  clientIds.push(c.rows[0].id);

  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours)
     VALUES ($1, $2, $3, $4, 100, $5::jsonb, $6, '6:00 PM', 4)
     RETURNING id`,
    [c.rows[0].id, proposalStatus, totalPrice, amountPaid, pricingSnapshot, eventDate]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);

  const s = await pool.query(
    `INSERT INTO shifts (proposal_id, event_date, start_time, end_time, status, event_duration_hours)
     VALUES ($1, $2, '6:00 PM', '10:00 PM', 'open', 4) RETURNING id`,
    [proposalId, eventDate]
  );
  const shiftId = s.rows[0].id;

  // users has NO name column; password column is password_hash (harness law).
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id`,
    [`extwh-staff-${NONCE}-${seq}@example.test`]
  );
  const staffUserId = u.rows[0].id;
  userIds.push(staffUserId);
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
     VALUES ($1, '3125550111', $2, 40)`,
    [staffUserId, `Ext ${NONCE} ${seq}`]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'bartender', 'approved')`,
    [shiftId, staffUserId]
  );

  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [proposalId, `X${NONCE}${seq}`, invoiceLabel, amountCents, invoiceStatus]
  );
  const invoiceId = inv.rows[0].id;

  let extensionId = null;
  if (withExtension) {
    const e = await pool.query(
      `INSERT INTO service_extensions
         (proposal_id, shift_id, requested_by_user_id, invoice_id,
          contracted_end_time, requested_end_time,
          contracted_duration_hours, requested_duration_hours,
          amount_cents, gratuity_cents, terms_version, client_accepted_at,
          status, expires_at)
       VALUES ($1, $2, $3, $4, '10:00 PM', '10:30 PM', 4, 4.5,
               $5, $7, 'v1', NOW(), $6::varchar,
               CASE WHEN $6::varchar = 'pending' THEN NOW() + INTERVAL '30 minutes'
                    ELSE NOW() - INTERVAL '1 hour' END)
       RETURNING id`,
      [proposalId, shiftId, staffUserId, invoiceId, amountCents, extensionStatus, gratuityCents]
    );
    extensionId = e.rows[0].id;
  }

  return { proposalId, shiftId, staffUserId, invoiceId, extensionId };
}

/** Synthetic payment_intent.succeeded event, shaped as the handler reads it. */
function intentEvent({ piId, proposalId, invoiceId, amountCents }) {
  return {
    data: {
      object: {
        id: piId,
        amount: amountCents,
        payment_method: null,
        metadata: {
          proposal_id: String(proposalId),
          // create-intent-for-invoice stamps this unconditionally; the
          // service_extensions lookup by invoice_id is the only discriminator.
          payment_type: 'invoice',
          invoice_id: String(invoiceId),
        },
      },
    },
  };
}

// ─── Pay-period fixture (test 8 only) ───────────────────────────────────────
// Standing track-and-restore law (payrollAccrual.extension.test.js): a period
// row this suite did not create is never deleted, only status-restored. Keyed
// by an EXPLICIT far-past week no sibling suite owns (grep-verified 2026-08-03:
// payrollClawback = 2019-03-05..11, payrollAccrual.extension = 2019-04-02..08,
// payrollDeferredRetry = 2019-04-09..15; nothing references 2019-03-19..25).
// Tue-to-Mon window; payday = second working day on/after the Monday end.
const PERIOD = { start: '2019-03-19', end: '2019-03-25', payday: '2019-03-26', status: 'open' };
const trackedPeriods = []; // { id, preExisted, origStatus }

async function ensurePeriodTracked({ start, end, payday, status }) {
  const existing = await pool.query(
    'SELECT id, status FROM pay_periods WHERE start_date = $1 LIMIT 1', [start]
  );
  if (existing.rows[0]) {
    trackedPeriods.push({
      id: existing.rows[0].id, preExisted: true, origStatus: existing.rows[0].status,
    });
    if (existing.rows[0].status !== status) {
      await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2',
        [status, existing.rows[0].id]);
    }
    return existing.rows[0].id;
  }
  const r = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [start, end, payday, status]
  );
  trackedPeriods.push({ id: r.rows[0].id, preExisted: false, origStatus: null });
  return r.rows[0].id;
}

after(async () => {
  // Let the handler's fire-and-forget tail (sendPaymentNotifications) settle
  // before the pool closes under it.
  await new Promise((r) => setTimeout(r, 400));
  const pids = proposalIds;
  if (pids.length) {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [pids]);
    await pool.query('DELETE FROM service_extensions WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', pids]);
    // Payout lines (test 8) BEFORE shifts: payout_events.shift_id is ON DELETE
    // RESTRICT. Keyed by this suite's staff users, so other tests are no-ops.
    if (userIds.length) {
      await pool.query('DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id = ANY($1::int[]))', [userIds]);
      await pool.query('DELETE FROM payouts WHERE contractor_id = ANY($1::int[])', [userIds]);
    }
    await pool.query('DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1::int[]))', [pids]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [pids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (userIds.length) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  }
  // Restore reality for the tracked period: put back the original status on a
  // pre-existing row; delete the row only if THIS suite created it, and only
  // when nothing references it.
  for (const p of trackedPeriods) {
    if (p.preExisted) {
      await pool.query('UPDATE pay_periods SET status = $1 WHERE id = $2',
        [p.origStatus, p.id]);
    } else {
      await pool.query(
        `DELETE FROM pay_periods pp WHERE pp.id = $1
           AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`,
        [p.id]
      );
    }
  }
  await pool.end();
});

// Shared with tests 2 and 7: the plan's side-money assertions read "after the
// same run" as the happy path, and the no-dunning test re-checks the settled
// proposal. node:test runs a file's tests serially in declaration order.
let happy;

test('1. happy path: paid extension invoice settles, bumps duration, greenlights staff', async () => {
  happy = await seedFixture();
  await handlePaymentIntentSucceeded(intentEvent({
    piId: `pi_${NONCE}_happy`, proposalId: happy.proposalId,
    invoiceId: happy.invoiceId, amountCents: 10000,
  }));

  const ext = await one('SELECT status, finalized_at FROM service_extensions WHERE id = $1', [happy.extensionId]);
  assert.equal(ext.status, 'paid', 'extension claimed as paid');
  assert.ok(ext.finalized_at, 'finalized_at stamped (every settle path ends with finalizeExtension)');

  const prop = await one('SELECT event_duration_hours FROM proposals WHERE id = $1', [happy.proposalId]);
  assert.equal(Number(prop.event_duration_hours), 4.5, 'proposal duration bumped to the requested hours');

  const shift = await one('SELECT end_time, event_duration_hours FROM shifts WHERE id = $1', [happy.shiftId]);
  assert.equal(shift.end_time, '10:30 PM', 'single-shift end_time rewritten');
  assert.equal(Number(shift.event_duration_hours), 4.5, 'shift duration synced');

  const inv = await one('SELECT status, amount_paid FROM invoices WHERE id = $1', [happy.invoiceId]);
  assert.equal(inv.status, 'paid', 'extension invoice settled');
  assert.equal(Number(inv.amount_paid), 10000, 'invoice credited the captured cents');

  const myPayroll = byProposal(payrollCalls, happy.proposalId);
  assert.equal(myPayroll.length, 1, 'payroll hours applied exactly once');
  assert.equal(Number(myPayroll[0].newDurationHours), 4.5, 'payroll got the new duration');
  assert.equal(byProposal(payrollAlertCalls, happy.proposalId).length, 1, 'maybeAlertPayroll invoked with the payroll result');

  const myStaff = byProposal(staffCalls, happy.proposalId);
  assert.equal(myStaff.length, 1, 'staff greenlight sent exactly once');
  assert.equal(myStaff[0].outcome, 'approved');
  assert.deepEqual(myStaff[0].staffUserIds, [happy.staffUserId], 'the rostered staffer is greenlit');
  assert.equal(myStaff[0].newEndDisplay, '10:30 PM');
  assert.equal(myStaff[0].contractedEndDisplay, '10:00 PM');

  assert.equal(byProposal(alertCalls, happy.proposalId).length, 0, 'no problem alert on the happy path');
});

test('2. side money: amount_paid, total_price and status untouched by the settle', async () => {
  const prop = await one('SELECT amount_paid, total_price, status FROM proposals WHERE id = $1', [happy.proposalId]);
  assert.equal(Number(prop.amount_paid), 500, 'amount_paid UNCHANGED: the off-ledger label skipped the roll-up');
  assert.equal(Number(prop.total_price), 1000, 'total_price untouched');
  assert.equal(prop.status, 'confirmed', 'proposal status untouched');
});

test('3. deposit-only regression guard: settle cannot fake funding or trip auto-completion', async () => {
  const f = await seedFixture({ proposalStatus: 'deposit_paid', totalPrice: 1000, amountPaid: 100 });
  await handlePaymentIntentSucceeded(intentEvent({
    piId: `pi_${NONCE}_dep`, proposalId: f.proposalId,
    invoiceId: f.invoiceId, amountCents: 10000,
  }));

  const prop = await one('SELECT amount_paid, status, event_duration_hours FROM proposals WHERE id = $1', [f.proposalId]);
  assert.equal(Number(prop.amount_paid), 100, 'amount_paid is still the deposit only');
  assert.equal(prop.status, 'deposit_paid', 'status not promoted: the funded-gratuity gate stays false');
  assert.equal(Number(prop.event_duration_hours), 4.5, 'the extension itself still settled');
});

test('4. replay: a redelivered intent settles nothing twice', async () => {
  const f = await seedFixture();
  const ev = intentEvent({
    piId: `pi_${NONCE}_replay`, proposalId: f.proposalId,
    invoiceId: f.invoiceId, amountCents: 10000,
  });
  await handlePaymentIntentSucceeded(ev);
  await handlePaymentIntentSucceeded(ev);

  const prop = await one('SELECT event_duration_hours FROM proposals WHERE id = $1', [f.proposalId]);
  assert.equal(Number(prop.event_duration_hours), 4.5, 'duration moved exactly once');

  const pays = await pool.query('SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1', [`pi_${NONCE}_replay`]);
  assert.equal(pays.rowCount, 1, 'exactly one proposal_payments row');

  const inv = await one('SELECT amount_paid FROM invoices WHERE id = $1', [f.invoiceId]);
  assert.equal(Number(inv.amount_paid), 10000, 'invoice credited once, not twice');

  assert.equal(byProposal(staffCalls, f.proposalId).length, 1, 'roster texted once across both deliveries');
  assert.equal(byProposal(alertCalls, f.proposalId).length, 0,
    'the replay raises no paid-after-expiry alert: isFirstDelivery gates the lookup before the now-paid row is ever read');
});

test('5. paid after expiry: void invoice, no settle, admin told to refund', async () => {
  const f = await seedFixture({ extensionStatus: 'expired', invoiceStatus: 'void' });
  await handlePaymentIntentSucceeded(intentEvent({
    piId: `pi_${NONCE}_late`, proposalId: f.proposalId,
    invoiceId: f.invoiceId, amountCents: 10000,
  }));

  const ext = await one('SELECT status, finalized_at FROM service_extensions WHERE id = $1', [f.extensionId]);
  assert.equal(ext.status, 'expired', 'row stays expired');
  assert.equal(ext.finalized_at, null, 'no finalize stamp on a non-settle');

  const prop = await one('SELECT event_duration_hours, amount_paid, status FROM proposals WHERE id = $1', [f.proposalId]);
  assert.equal(Number(prop.event_duration_hours), 4, 'duration did NOT move');
  assert.equal(Number(prop.amount_paid), 500, 'contract untouched: the off-ledger skip holds even against a void invoice');
  assert.equal(prop.status, 'confirmed', 'status untouched');

  const shift = await one('SELECT end_time FROM shifts WHERE id = $1', [f.shiftId]);
  assert.equal(shift.end_time, '10:00 PM', 'shift untouched');

  const inv = await one('SELECT status, amount_paid FROM invoices WHERE id = $1', [f.invoiceId]);
  assert.equal(inv.status, 'void', 'void invoice never reanimated');
  assert.equal(Number(inv.amount_paid), 0, 'no credit against a void invoice');
  const links = await pool.query('SELECT id FROM invoice_payments WHERE invoice_id = $1', [f.invoiceId]);
  assert.equal(links.rowCount, 0, 'no invoice_payments link row');

  const pays = await pool.query('SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1', [`pi_${NONCE}_late`]);
  assert.equal(pays.rowCount, 1, 'the payment itself is still recorded: a refund needs a record');

  const myAlerts = byProposal(alertCalls, f.proposalId);
  assert.equal(myAlerts.length, 1, 'exactly one admin alert');
  assert.equal(myAlerts[0].kind, 'paid_after_expiry');
  assert.match(myAlerts[0].detail, /Refund this payment/, 'alert carries the refund instruction');
  assert.match(myAlerts[0].detail, /already expired/, 'alert names the prior status');

  assert.equal(byProposal(staffCalls, f.proposalId).length, 0, 'no staff greenlight');
  assert.equal(byProposal(payrollCalls, f.proposalId).length, 0, 'no payroll write');
});

test('6. ordinary Balance invoice: amount_paid still rolls up (the change is inert for normal payments)', async () => {
  const f = await seedFixture({
    withExtension: false, invoiceLabel: 'Balance', amountCents: 40000,
    proposalStatus: 'deposit_paid', totalPrice: 1000, amountPaid: 600,
  });
  await handlePaymentIntentSucceeded(intentEvent({
    piId: `pi_${NONCE}_bal`, proposalId: f.proposalId,
    invoiceId: f.invoiceId, amountCents: 40000,
  }));

  const prop = await one('SELECT amount_paid, status, event_duration_hours FROM proposals WHERE id = $1', [f.proposalId]);
  assert.equal(Number(prop.amount_paid), 1000, 'amount_paid DOES increase as it always did');
  assert.equal(prop.status, 'balance_paid', 'fully paid still promotes as before');
  assert.equal(Number(prop.event_duration_hours), 4, 'no duration change');

  const inv = await one('SELECT status, amount_paid FROM invoices WHERE id = $1', [f.invoiceId]);
  assert.equal(inv.status, 'paid', 'Balance invoice settled normally');
  assert.equal(Number(inv.amount_paid), 40000, 'Balance invoice credited normally');

  assert.equal(byProposal(staffCalls, f.proposalId).length, 0, 'no extension side effects');
  assert.equal(byProposal(payrollCalls, f.proposalId).length, 0, 'no payroll call');
  assert.equal(byProposal(alertCalls, f.proposalId).length, 0, 'no alert');
});

test('7. no dunning: nothing is ever scheduled against an extension (spec decision 12)', async () => {
  // A live pending request (never paid) plus the settled one from test 1: an
  // unpaid extension is not a receivable, so nothing may ever chase either.
  const pending = await seedFixture();
  const ids = [pending.proposalId, happy.proposalId];

  const byEntity = await pool.query(
    `SELECT id FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1::int[])`,
    [ids]
  );
  assert.equal(byEntity.rowCount, 0, 'zero scheduled messages for a pending or a settled extension proposal');

  const byType = await pool.query(
    `SELECT id FROM scheduled_messages WHERE message_type ILIKE '%extension%'`
  );
  assert.equal(byType.rowCount, 0, 'no extension message_type exists anywhere');
});

test('8. completed-then-settle ordering: existing payroll lines get the extension gratuity via re-accrual (merge-gate blocker pin)', async () => {
  // The bug this pins: auto-complete accrues payroll while the extension row is
  // still pending, so the 12b addend lands at $0. The client then pays inside
  // the grace window; applyExtensionHours rewrites hours/wage only, and before
  // the fix NOTHING re-ran accrual, so the extension's gratuity_cents silently
  // never reached staff. The fixed tail calls accruePayoutsForProposal whenever
  // payroll lines already exist (updatedLines+lockedLines+frozenLines > 0).
  //
  // This test needs the REAL payroll path end to end, so the module stubs are
  // swapped out for exactly the one handler call below.
  const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');

  await ensurePeriodTracked(PERIOD);
  // Fully paid (funded gate true) + completed (accrual only runs on completed)
  // + a $100 Shared Gratuity snapshot line, mirroring the payrollAccrual
  // fixtures. Event date sits inside the tracked far-past open week.
  const f = await seedFixture({
    proposalStatus: 'completed',
    totalPrice: 1000,
    amountPaid: 1000,
    eventDate: '2019-03-19',
    pricingSnapshot: '{"breakdown":[{"label":"Shared Gratuity","amount":100}]}',
    gratuityCents: 2500,
  });

  const line = async () => one(
    `SELECT pe.gratuity_share_cents, pe.hours, pe.contracted_hours, pe.wage_cents,
            po.total_cents
       FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
      WHERE po.contractor_id = $1`,
    [f.staffUserId]
  );

  // Step 1: accrual runs FIRST (the auto-complete ordering), while the
  // extension row is still pending. The addend keys on status='paid', so the
  // baseline gratuity share is the contract gratuity alone: $100, one
  // bartender, funded, no card fees. contractedHours(4) = 5.5 at $40/hr.
  const accrued = await accruePayoutsForProposal(f.proposalId);
  assert.equal(accrued.skipped, false, `baseline accrual must run (got ${JSON.stringify(accrued)})`);
  const base = await line();
  assert.equal(Number(base.gratuity_share_cents), 10000, 'pending extension contributes $0 to the baseline pool');
  assert.equal(Number(base.hours), 5.5, 'first accrual seeds contracted hours (4 + 1.5)');
  assert.equal(Number(base.wage_cents), 22000);

  // Step 2: the webhook settle lands on top of those existing lines, with the
  // REAL applyExtensionHours and the real accruePayoutsForProposal in play.
  payroll.applyExtensionHours = realApplyExtensionHours;
  payroll.maybeAlertPayroll = realMaybeAlertPayroll;
  try {
    await handlePaymentIntentSucceeded(intentEvent({
      piId: `pi_${NONCE}_grat12b`, proposalId: f.proposalId,
      invoiceId: f.invoiceId, amountCents: 10000,
    }));
  } finally {
    payroll.applyExtensionHours = stubApplyExtensionHours;
    payroll.maybeAlertPayroll = stubMaybeAlertPayroll;
  }

  const ext = await one('SELECT status, finalized_at FROM service_extensions WHERE id = $1', [f.extensionId]);
  assert.equal(ext.status, 'paid');
  assert.ok(ext.finalized_at, 'the real settle path still finalizes');

  // THE pin: the payout line's gratuity share now INCLUDES the extension's
  // gratuity_cents (sole bartender, so the whole 2500 lands on this line),
  // on top of the contract gratuity that was already there.
  const settled = await line();
  assert.equal(Number(settled.gratuity_share_cents), 10000 + 2500,
    'the settle re-accrued: the 12b addend landed on the pre-existing line');
  assert.equal(Number(settled.hours), 6, 'real applyExtensionHours moved the line to contractedHours(4.5)');
  assert.equal(Number(settled.contracted_hours), 6);
  assert.equal(Number(settled.wage_cents), 24000, 'wage recomputed from the new hours');
  assert.equal(Number(settled.total_cents), 24000 + 12500, 'payout header recomputed: wage + gratuity');

  // Real-path side checks: the stub was NOT used, the roster was greenlit, no
  // problem alert fired (updated lines, nothing locked/frozen), and the
  // off-ledger label kept the contract money untouched.
  assert.equal(byProposal(payrollCalls, f.proposalId).length, 0, 'the stub stayed out of this settle');
  const myStaff = byProposal(staffCalls, f.proposalId);
  assert.equal(myStaff.length, 1);
  assert.equal(myStaff[0].outcome, 'approved');
  assert.equal(byProposal(alertCalls, f.proposalId).length, 0);
  const prop = await one('SELECT amount_paid, total_price, status FROM proposals WHERE id = $1', [f.proposalId]);
  assert.equal(Number(prop.amount_paid), 1000, 'off-ledger settle never rolls into amount_paid');
  assert.equal(prop.status, 'completed', 'lifecycle status untouched');
});
