'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');

// ── Seams ───────────────────────────────────────────────────────────────────
// The sweep resolves notify functions by property lookup at call time, so
// replacing the properties on the shared module object stubs every call the
// sweep AND maybeAlertPayroll make. No real email/SMS/push path is reachable.
const notify = require('./serviceExtensionNotify');
const staffCalls = [];
const adminCalls = [];
let failStaffNotifyForProposal = null;
notify.notifyStaffOfOutcome = async (args) => {
  if (failStaffNotifyForProposal && args.proposalId === failStaffNotifyForProposal) {
    failStaffNotifyForProposal = null;
    throw new Error('forced notify failure (test)');
  }
  staffCalls.push(args);
  return { notified: (args.staffUserIds || []).slice(), unreachable: [] };
};
notify.alertAdminsProblem = async (args) => { adminCalls.push(args); };

// Stripe seam: invoiceVoid's own test hook (the sweep's intent-cancel path).
// retrieve throws on an unknown id, which cancelOpenInvoiceIntents treats as a
// logged best-effort failure, so a stray dev-DB stripe_sessions row can never
// wedge a test run.
const { _setStripeForTests } = require('./invoiceVoid');
const fakePis = new Map(); // pi id -> PI object
const canceledPis = [];
_setStripeForTests({
  paymentIntents: {
    retrieve: async (id) => {
      const pi = fakePis.get(id);
      if (!pi) throw new Error(`no such fake PI ${id}`);
      return pi;
    },
    cancel: async (id) => { canceledPis.push(id); return { id, status: 'canceled' }; },
  },
});

const { sweepExpiredExtensions, healUnfinalizedExtensions } = require('./serviceExtensionSweep');

const staffFor = (pid) => staffCalls.filter((c) => c.proposalId === pid);
const adminFor = (pid) => adminCalls.filter((c) => c.proposalId === pid);

// ── Fixtures ────────────────────────────────────────────────────────────────
const NONCE = `sxw-${Date.now()}`;
let clientId, pkgId, staffAId;
let invSeq = 0;
const proposals = [];
const shifts = [];
const extensions = [];
const invoices = [];
const sessions = [];

async function mkEvent({ hours = 4 } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'balance_paid',100,$3,1,350,350,'2026-09-12','8:00 PM','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId, hours]
  );
  const proposalId = p.rows[0].id;
  proposals.push(proposalId);
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id,
                         event_duration_hours, positions_needed, client_name)
     VALUES ('2026-09-12','8:00 PM','12:00 AM','open',$1,$2,'["Bartender"]',$3)
     RETURNING id`,
    [proposalId, hours, `${NONCE} client`]
  );
  shifts.push(s.rows[0].id);
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1,$2,'approved','Bartender')`,
    [s.rows[0].id, staffAId]
  );
  return { proposalId, shiftId: s.rows[0].id };
}

async function mkInvoice(proposalId, status = 'sent') {
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1,$2,'Service Extension',5000,$3,$4) RETURNING id`,
    // invoice_number is VARCHAR(20) + globally UNIQUE: per-call ms timestamp
    // plus seq stays under the cap and unique even across crashed runs.
    [proposalId, `X${Date.now()}${++invSeq}`, status === 'paid' ? 5000 : 0, status]
  );
  invoices.push(r.rows[0].id);
  return r.rows[0].id;
}

/**
 * expiresInMins / updatedAgoMins are LOCAL-frame offsets from NOW() (negative =
 * past). service_extensions has no updated_at trigger, so the explicit value
 * sticks, which is what lets a test cross the heal's two-minute age gate.
 */
async function mkExtension({
  proposalId, shiftId, invoiceId = null, status = 'pending',
  expiresInMins = -5, updatedAgoMins = 0, finalized = false,
  contracted = 4, requested = 4.5,
}) {
  const r = await pool.query(
    `INSERT INTO service_extensions
       (proposal_id, shift_id, requested_by_user_id, contracted_duration_hours,
        requested_duration_hours, contracted_end_time, requested_end_time,
        amount_cents, gratuity_cents, status, invoice_id, expires_at, updated_at, finalized_at)
     VALUES ($1,$2,$3,$4,$5,'12:00 AM','12:30 AM',5000,0,$6,$7,
             NOW() + make_interval(mins => $8),
             NOW() + make_interval(mins => $9),
             CASE WHEN $10::boolean THEN NOW() ELSE NULL END)
     RETURNING id`,
    [proposalId, shiftId, staffAId, contracted, requested, status, invoiceId,
     expiresInMins, updatedAgoMins, finalized]
  );
  extensions.push(r.rows[0].id);
  return r.rows[0].id;
}

async function extRow(id) {
  const { rows } = await pool.query(
    'SELECT status, finalized_at FROM service_extensions WHERE id = $1', [id]);
  return rows[0];
}
async function invoiceStatus(id) {
  const { rows } = await pool.query('SELECT status FROM invoices WHERE id = $1', [id]);
  return rows[0].status;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  pkgId = p.rows[0].id;
  // users has NO `name` column and the password column is `password_hash`
  // (plan "Test harness constraints").
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1,'x','staff','approved',0) RETURNING id`,
    [`${NONCE}-a@example.test`]
  );
  staffAId = a.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
     VALUES ($1,'3125550111',$2,40)`,
    [staffAId, `${NONCE} A`]
  );
});

after(async () => {
  if (sessions.length) await pool.query('DELETE FROM stripe_sessions WHERE id = ANY($1)', [sessions]);
  if (extensions.length) await pool.query('DELETE FROM service_extensions WHERE id = ANY($1)', [extensions]);
  if (shifts.length) await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1)', [shifts]);
  if (shifts.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [shifts]);
  if (invoices.length) await pool.query('DELETE FROM invoices WHERE id = ANY($1)', [invoices]);
  if (proposals.length) await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [proposals]);
  if (proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [proposals]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [staffAId]);
  await pool.query('DELETE FROM users WHERE id = $1', [staffAId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// ── The sweep half ──────────────────────────────────────────────────────────

let evA; // shared with the duration test below

test('sweep: expired pending row is expired, its invoice voided, and the decline sent', async () => {
  evA = await mkEvent();
  const invId = await mkInvoice(evA.proposalId, 'sent');
  const extId = await mkExtension({
    proposalId: evA.proposalId, shiftId: evA.shiftId, invoiceId: invId, expiresInMins: -5,
  });

  const res = await sweepExpiredExtensions();
  assert.ok(res.expired >= 1, 'the expired row must be claimed');

  assert.equal((await extRow(extId)).status, 'expired');
  assert.equal(await invoiceStatus(invId), 'void');

  const calls = staffFor(evA.proposalId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outcome, 'declined');
  assert.equal(calls[0].contractedEndDisplay, '12:00 AM', 'insurance-warning copy needs the contracted end');
  assert.equal(calls[0].newEndDisplay, null);
  assert.deepEqual(calls[0].staffUserIds, [staffAId]);

  const log = await pool.query(
    "SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'extension_expired'",
    [evA.proposalId]
  );
  assert.equal(log.rows[0].n, 1);
});

test('sweep: expiry never touches event_duration_hours', async () => {
  const { rows } = await pool.query(
    'SELECT event_duration_hours, total_price, amount_paid FROM proposals WHERE id = $1',
    [evA.proposalId]
  );
  assert.equal(Number(rows[0].event_duration_hours), 4, 'expiry must not extend the event');
  assert.equal(Number(rows[0].total_price), 350);
  assert.equal(Number(rows[0].amount_paid), 350);
});

test('sweep: a pending row expiring in the future is untouched', async () => {
  const ev = await mkEvent();
  const invId = await mkInvoice(ev.proposalId, 'sent');
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId, expiresInMins: 60,
  });

  await sweepExpiredExtensions();

  assert.equal((await extRow(extId)).status, 'pending');
  assert.equal(await invoiceStatus(invId), 'sent');
  assert.equal(staffFor(ev.proposalId).length, 0);
});

test('sweep: an already-settled row is not selected and its paid invoice is untouched', async () => {
  const ev = await mkEvent({ hours: 4.5 });
  const invId = await mkInvoice(ev.proposalId, 'paid');
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId,
    status: 'paid', finalized: true, expiresInMins: -5,
  });

  await sweepExpiredExtensions();

  assert.equal((await extRow(extId)).status, 'paid');
  assert.equal(await invoiceStatus(invId), 'paid');
  assert.equal(staffFor(ev.proposalId).length, 0);
});

test('sweep: two consecutive sweeps expire a row exactly once', async () => {
  const ev = await mkEvent();
  const invId = await mkInvoice(ev.proposalId, 'sent');
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId, expiresInMins: -5,
  });

  // The first test's sweep drained every pre-existing expired row, so counts
  // here are exact: the claim (WHERE status='pending') is the single winner.
  const first = await sweepExpiredExtensions();
  assert.equal(first.expired, 1);
  const second = await sweepExpiredExtensions();
  assert.equal(second.expired, 0);

  assert.equal((await extRow(extId)).status, 'expired');
  assert.equal(staffFor(ev.proposalId).length, 1, 'the decline must not be re-sent');
  const log = await pool.query(
    "SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'extension_expired'",
    [ev.proposalId]
  );
  assert.equal(log.rows[0].n, 1);
});

test('sweep: a row that fails mid-processing does not block the next row', async () => {
  const evBad = await mkEvent();
  const evGood = await mkEvent();
  const invBad = await mkInvoice(evBad.proposalId, 'sent');
  const invGood = await mkInvoice(evGood.proposalId, 'sent');
  // expires_at ASC ordering: the failing row is processed first.
  const extBad = await mkExtension({
    proposalId: evBad.proposalId, shiftId: evBad.shiftId, invoiceId: invBad, expiresInMins: -10,
  });
  const extGood = await mkExtension({
    proposalId: evGood.proposalId, shiftId: evGood.shiftId, invoiceId: invGood, expiresInMins: -5,
  });

  failStaffNotifyForProposal = evBad.proposalId;
  const res = await sweepExpiredExtensions();

  // Both rows were claimed: the failure hit AFTER the claim and the void, and
  // the per-row catch let the second row proceed.
  assert.equal(res.expired, 2);
  assert.equal((await extRow(extBad)).status, 'expired');
  assert.equal((await extRow(extGood)).status, 'expired');
  assert.equal(await invoiceStatus(invBad), 'void');
  assert.equal(await invoiceStatus(invGood), 'void');
  assert.equal(staffFor(evBad.proposalId).length, 0, 'the forced failure swallowed this decline');
  assert.equal(staffFor(evGood.proposalId).length, 1);
  assert.equal(failStaffNotifyForProposal, null, 'the forced failure must actually have fired');
});

test('sweep: stranded-paid guard leaves a paid-but-unsettled request pending and alerts', async () => {
  const ev = await mkEvent();
  const invId = await mkInvoice(ev.proposalId, 'paid'); // paid, but the row never settled
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId, expiresInMins: -5,
  });

  const res = await sweepExpiredExtensions();

  assert.equal(res.stranded, 1);
  assert.equal(res.expired, 0);
  assert.equal((await extRow(extId)).status, 'pending', 'expiring a paid request would keep the money and kill the time');
  assert.equal(await invoiceStatus(invId), 'paid', 'a paid invoice is never voided');
  assert.equal(staffFor(ev.proposalId).length, 0, 'no decline may reach the bartender');
  const alerts = adminFor(ev.proposalId).filter((c) => c.kind === 'paid_extension_stranded');
  assert.equal(alerts.length, 1);

  // Park the row so later sweep-free tests are not re-alerted by accident and
  // teardown state is deterministic.
  await pool.query("UPDATE service_extensions SET status = 'cancelled' WHERE id = $1", [extId]);
});

test('sweep: stranded alert fires once across ticks (24h activity-log throttle, merge-gate blocker pin)', async () => {
  // The bug this pins: a stranded row stays pending until a human acts, the
  // driver re-selects it every 60 seconds, and alertAdminsProblem has no dedupe
  // of its own, so before the fix one stranded row overnight was ~480 urgent
  // emails + SMS. The fix writes an 'extension_stranded_alert' marker to
  // proposal_activity_log and skips the alert while a marker exists within 24h.
  const ev = await mkEvent();
  const invId = await mkInvoice(ev.proposalId, 'paid'); // paid, never settled
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId, expiresInMins: -5,
  });

  // Two back-to-back ticks. The row is stranded on BOTH (it stays pending and
  // still occupies a driver slot), but only the first may alert.
  const first = await sweepExpiredExtensions();
  const second = await sweepExpiredExtensions();
  assert.equal(first.stranded, 1);
  assert.equal(second.stranded, 1, 'the pending row is still counted on the second tick');
  assert.equal(first.expired + second.expired, 0, 'a stranded row is never expired');

  const alerts = adminFor(ev.proposalId).filter((c) => c.kind === 'paid_extension_stranded');
  assert.equal(alerts.length, 1, 'the alert fired exactly ONCE across both ticks');

  const markers = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = 'extension_stranded_alert'
        AND (details->>'extension_id')::int = $2`,
    [ev.proposalId, extId]
  );
  assert.equal(markers.rows[0].n, 1, 'exactly one throttle marker row was written');

  assert.equal((await extRow(extId)).status, 'pending', 'the row is left for the human on every tick');
  assert.equal(await invoiceStatus(invId), 'paid');
  assert.equal(staffFor(ev.proposalId).length, 0, 'no decline reaches the bartender on either tick');

  // Park (same hygiene as the stranded test above). The marker rows are covered
  // by the teardown's proposal_activity_log delete.
  await pool.query("UPDATE service_extensions SET status = 'cancelled' WHERE id = $1", [extId]);
});

// ── The heal half ───────────────────────────────────────────────────────────

test('heal: a crashed paid settle is re-finalized, staff re-greenlit, admin told', async () => {
  // The crash shape: settleExtension committed (duration already 4.5) but the
  // post-commit tail died, so finalized_at is NULL and nobody was told.
  const ev = await mkEvent({ hours: 4.5 });
  const invId = await mkInvoice(ev.proposalId, 'paid');
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId,
    status: 'paid', updatedAgoMins: -10, expiresInMins: -5,
  });

  const res = await healUnfinalizedExtensions();
  assert.ok(res.healed >= 1);

  const row = await extRow(extId);
  assert.equal(row.status, 'paid');
  assert.ok(row.finalized_at, 'the heal must stamp finalized_at LAST');
  assert.equal(await invoiceStatus(invId), 'paid', 'a paid extension invoice is left alone');

  const calls = staffFor(ev.proposalId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outcome, 'approved');
  assert.equal(calls[0].newEndDisplay, '12:30 AM');
  assert.equal(calls[0].contractedEndDisplay, '12:00 AM');
  assert.deepEqual(calls[0].staffUserIds, [staffAId]);

  const healAlerts = adminFor(ev.proposalId).filter((c) => c.kind === 'settle_healed');
  assert.equal(healAlerts.length, 1, 'admins are told a heal ran so they can spot-check payroll');
  const payrollAlerts = adminFor(ev.proposalId).filter((c) => c.kind === 'payroll_hours_locked');
  assert.equal(payrollAlerts.length, 0, 'single-shift, no payout lines: nothing to flag');

  // A second heal pass must not re-fire: finalized rows are out of the query.
  const again = await healUnfinalizedExtensions();
  assert.equal(again.healed, 0);
  assert.equal(staffFor(ev.proposalId).length, 1, 'the greenlight must not be re-sent');
});

test('heal: the two-minute age gate protects a settle still mid-tail', async () => {
  const ev = await mkEvent({ hours: 4.5 });
  const invId = await mkInvoice(ev.proposalId, 'paid');
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId,
    status: 'paid', updatedAgoMins: 0, expiresInMins: -5,
  });

  const res = await healUnfinalizedExtensions();
  assert.equal(res.healed, 0);
  assert.equal((await extRow(extId)).finalized_at, null, 'a fresh settle is still finishing its own tail');
  assert.equal(staffFor(ev.proposalId).length, 0);
});

test('heal: a crashed override also voids its still-payable invoice (merge-gate carry-over)', async () => {
  // The carry-over shape from the ext-routes merge-gate review: the override
  // route settled ('overridden' committed) and crashed BEFORE
  // voidExtensionInvoice, leaving a payable 'sent' invoice for time an admin
  // already granted free. The heal must cancel open intents first, then void.
  const ev = await mkEvent({ hours: 4.5 });
  const invId = await mkInvoice(ev.proposalId, 'sent');
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId,
    status: 'overridden', updatedAgoMins: -10, expiresInMins: -5,
  });

  // A client sits mid-checkout against that invoice.
  const piId = `pi_${NONCE}_1`;
  fakePis.set(piId, {
    id: piId,
    status: 'requires_payment_method',
    metadata: { invoice_id: String(invId) },
  });
  const sess = await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1,$2,5000,'pending') RETURNING id`,
    [ev.proposalId, piId]
  );
  sessions.push(sess.rows[0].id);

  const res = await healUnfinalizedExtensions();
  assert.ok(res.healed >= 1);

  assert.equal(await invoiceStatus(invId), 'void', 'the override residue must not stay payable');
  assert.deepEqual(canceledPis, [piId], 'open intents are canceled before the void');
  const row = await extRow(extId);
  assert.equal(row.status, 'overridden');
  assert.ok(row.finalized_at);
  const calls = staffFor(ev.proposalId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outcome, 'approved', 'overridden means the time WAS granted');
});

test('heal: never voids an overridden row invoice that money actually landed on', async () => {
  // The race the status <> 'paid' guard exists for: the client paid while the
  // admin was overriding (the webhook lost the claim but the linker marked the
  // invoice paid), then the override crashed before finalize. The money landed,
  // so refund is a human decision; the heal only finalizes.
  const ev = await mkEvent({ hours: 4.5 });
  const invId = await mkInvoice(ev.proposalId, 'paid');
  const extId = await mkExtension({
    proposalId: ev.proposalId, shiftId: ev.shiftId, invoiceId: invId,
    status: 'overridden', updatedAgoMins: -10, expiresInMins: -5,
  });
  const cancelsBefore = canceledPis.length;

  const res = await healUnfinalizedExtensions();
  assert.ok(res.healed >= 1);

  assert.equal(await invoiceStatus(invId), 'paid', 'landed money is never auto-voided');
  assert.equal(canceledPis.length, cancelsBefore, 'no Stripe round-trip on a non-payable invoice');
  const row = await extRow(extId);
  assert.ok(row.finalized_at, 'the row itself still finalizes');
  assert.equal(staffFor(ev.proposalId).length, 1);
});
