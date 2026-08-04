require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { accruePayoutsForProposal } = require('./payrollAccrual');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrual.extension.test.js refuses to run against production');
}

// Service-extension gratuity addend (Task 12b, spec 2026-07-25 section 9).
// The pool = snapshot (contract) gratuity + SUM(gratuity_cents) over the
// proposal's status='paid' service_extensions, added AFTER fee-netting. The
// extension gate is per-extension (its own money arrived) and independent of
// the proposal-level funded gate; DRB absorbs the extension's Stripe fee.
//
// Pay-period fixtures follow the standing track-and-restore law
// (payrollLateTip.test.js / payrollClawback.test.js): a period row this suite
// did not create is never deleted, only status-restored. The period is keyed
// by an EXPLICIT far-past week (Tue 2019-04-02..Mon 2019-04-08, unused by any
// sibling suite), not by "today", so the Chicago-vs-UTC drift that bit the
// late-tip suite (2026-07-13) cannot bite: accrual resolves the period from
// the proposal's fixed event_date, never from the wall clock.
const PERIOD = { start: '2019-04-02', end: '2019-04-08', payday: '2019-04-09', status: 'open' };

const NONCE = `paext-${Date.now()}-${process.pid}`;

let bartenderA, bartenderB;
let proposalId, shiftId;
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

/** Seed a service_extensions row on the current proposal. Cents everywhere. */
async function seedExtension({ status = 'paid', gratuity = 2500, amount = 2500 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO service_extensions
       (proposal_id, contracted_duration_hours, requested_duration_hours,
        amount_cents, gratuity_cents, status, expires_at)
     VALUES ($1, 4, 4.5, $2, $3, $4, NOW() + interval '1 hour')
     RETURNING id`,
    [proposalId, amount, gratuity, status]
  );
  return rows[0].id;
}

async function lineFor(userId) {
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents, pe.wage_cents
       FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
      WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(rows.length, 1, 'exactly one payout line for the bartender');
  return rows[0];
}

before(async () => {
  // Pre-clean stranded fixtures from prior failed runs (FK chain, nonce prefix).
  const fixtureFilter = `email LIKE 'paext-%@example.test'`;
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN
    (SELECT id FROM payouts WHERE contractor_id IN
      (SELECT id FROM users WHERE ${fixtureFilter}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN
    (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN
    (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN
    (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM users WHERE ${fixtureFilter}`);

  await ensurePeriodTracked(PERIOD);

  const mk = async (suffix) => {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id`,
      [`${NONCE}-${suffix}@example.test`]
    );
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
       VALUES ($1, '3125550111', $2, 20)`,
      [u.rows[0].id, `${NONCE} ${suffix}`]
    );
    return u.rows[0].id;
  };
  bartenderA = await mk('a');
  bartenderB = await mk('b');
});

beforeEach(async () => {
  // Funded by default (amount_paid = total_price) with a $100 snapshot
  // gratuity, mirroring payrollAccrual.test.js. Individual tests underfund or
  // add card payments as needed.
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, pricing_snapshot)
     VALUES (NULL, '2019-04-02', 'completed', 'birthday-party', '6:00 PM', 4, 1000, 1000,
             '{"breakdown":[{"label":"Shared Gratuity","amount":100}]}')
     RETURNING id`
  );
  proposalId = p.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2019-04-02', '6:00 PM', 'open', $1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, bartenderA]
  );
});

afterEach(async () => {
  // FK order. invoices/proposal_refunds RESTRICT on proposal_id, so they (and
  // their links/payments) go before the proposal row.
  await pool.query(
    `DELETE FROM payout_events WHERE payout_id IN
       (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
    [bartenderA, bartenderB]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)',
    [bartenderA, bartenderB]);
  await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [proposalId]);
  await pool.query(
    `DELETE FROM invoice_payments WHERE invoice_id IN
       (SELECT id FROM invoices WHERE proposal_id = $1)`,
    [proposalId]
  );
  await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM service_extensions WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  for (const id of [bartenderA, bartenderB]) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  // Restore reality for the period this suite touched: put back the original
  // status on a pre-existing row; delete the row only if THIS suite created it,
  // and only when nothing references it.
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

test('extension addend > a paid extension raises each bartender share by the extension amount split evenly', async () => {
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, bartenderB]
  );

  // Baseline: $100 contract gratuity, two bartenders, no extension.
  await accruePayoutsForProposal(proposalId);
  const baseA = await lineFor(bartenderA);
  const baseB = await lineFor(bartenderB);
  assert.equal(baseA.gratuity_share_cents, 5000);
  assert.equal(baseB.gratuity_share_cents, 5000);

  // A paid $25.00 extension gratuity joins the pool: (10000 + 2500) / 2 each.
  await seedExtension({ status: 'paid', gratuity: 2500 });
  await accruePayoutsForProposal(proposalId);
  const withA = await lineFor(bartenderA);
  const withB = await lineFor(bartenderB);
  assert.equal(withA.gratuity_share_cents, 6250, 'A share grew by the even split of 2500');
  assert.equal(withB.gratuity_share_cents, 6250, 'B share grew by the even split of 2500');
});

test('extension addend > deposit-stage proposal: contract gratuity gated $0, extension gratuity still pays (independent gates)', async () => {
  // amount_paid < total_price trips the proposal-level funded gate, so the
  // snapshot gratuity stays $0. The extension gate is the row's OWN
  // status='paid' (its money arrived), so its gratuity must still reach the
  // bartender: a deposit-stage event pays out what the client actually paid
  // for the extra time.
  await pool.query('UPDATE proposals SET amount_paid = 100 WHERE id = $1', [proposalId]);
  await seedExtension({ status: 'paid', gratuity: 2500 });

  await accruePayoutsForProposal(proposalId);
  const line = await lineFor(bartenderA);
  assert.equal(line.gratuity_share_cents, 2500,
    'extension gratuity alone: contract gratuity gated off, addend unaffected');
  assert.ok(Number(line.wage_cents) > 0, 'wages still accrue when underpaid');
});

test('extension addend > pending and overridden extensions contribute nothing', async () => {
  // pending: money not arrived yet. overridden: invoice voided, money never
  // arrives (spec decision 14). Neither may touch the pool.
  await seedExtension({ status: 'pending', gratuity: 2000 });
  await seedExtension({ status: 'overridden', gratuity: 3000 });

  await accruePayoutsForProposal(proposalId);
  const line = await lineFor(bartenderA);
  assert.equal(line.gratuity_share_cents, 10000, 'contract gratuity only; no addend');
});

test('extension addend > extension gratuity is NOT fee-netted; netting stays scoped to contract gratuity', async () => {
  // Contract card payment: $1000 with a 3200c fee. The $100 contract gratuity
  // bears 10% of it (320c) -> nets to 9680c, exactly as payrollAccrual.test.js
  // pins. The 2500c extension gratuity joins RAW after that netting: DRB
  // absorbs the extension's Stripe fee (spec section 9), so the share is
  // 9680 + 2500, never 12180 - some extension fee slice.
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'full', 100000, 'succeeded', 3200, $2)`,
    [proposalId, `pi_${NONCE}_contract`]
  );
  await seedExtension({ status: 'paid', gratuity: 2500 });

  await accruePayoutsForProposal(proposalId);
  const line = await lineFor(bartenderA);
  assert.equal(line.gratuity_share_cents, 9680 + 2500,
    'contract part netted (9680), extension part raw (2500)');
});

test('extension addend > two paid extensions both contribute exactly once, recomputed not accumulated across re-accruals', async () => {
  await seedExtension({ status: 'paid', gratuity: 2500 });
  await seedExtension({ status: 'paid', gratuity: 1000 });

  await accruePayoutsForProposal(proposalId);
  let line = await lineFor(bartenderA);
  assert.equal(line.gratuity_share_cents, 10000 + 3500, 'pool grew by 2500 + 1000');

  // Re-accrual recomputes the addend from the table; it must not double to 7000.
  await accruePayoutsForProposal(proposalId);
  line = await lineFor(bartenderA);
  assert.equal(line.gratuity_share_cents, 13500, 'still 3500 of extension money, not 7000');
});

test('extension addend > a REFUNDED extension still contributes (spec section 14 default, approved 2026-08-03)', async () => {
  // The staffer worked the time, so a later refund of the extension charge
  // does not pull the gratuity back out of the pool: the addend keys on
  // status='paid' and nothing marks the service_extensions row when its
  // payment is refunded. This test documents that approved default, not a
  // mechanism; if Dallas flips the decision, the addend query gains a
  // NOT EXISTS clause against succeeded refunds and THIS test is what changes.
  await seedExtension({ status: 'paid', gratuity: 2500, amount: 2500 });

  // The extension's own money trail: an off-ledger 'Service Extension' invoice
  // paid by a payment_type='invoice' charge (5000c = amount + gratuity),
  // then a succeeded refund against that payment. total_price/amount_paid are
  // untouched: side money, per D12.
  const { rows: [pay] } = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'invoice', 5000, 'succeeded', 0, $2) RETURNING id`,
    [proposalId, `pi_${NONCE}_ext`]
  );
  const { rows: [inv] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Service Extension', 5000, 5000, 'paid') RETURNING id`,
    [proposalId, `TEST-${NONCE.slice(-12)}`]
  );
  await pool.query(
    'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 5000)',
    [inv.id, pay.id]
  );
  await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_refund_id, amount, reason,
        total_price_before, total_price_after, status)
     VALUES ($1, $2, $3, 5000, 'client disputed the extra time', 1000, 1000, 'succeeded')`,
    [proposalId, pay.id, `re_${NONCE}`]
  );

  await accruePayoutsForProposal(proposalId);
  const line = await lineFor(bartenderA);
  assert.equal(line.gratuity_share_cents, 10000 + 2500,
    'refunded extension gratuity still pooled, by decision');
});
