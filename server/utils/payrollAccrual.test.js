require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { accruePayoutsForProposal } = require('./payrollAccrual');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrual.test.js refuses to run against production');
}

let userId, proposalId, shiftId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('accrue@example.com','x','staff') RETURNING id"
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [userId]
  );
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, pricing_snapshot)
     VALUES (NULL, CURRENT_DATE, 'completed', 'birthday-party', '6:00 PM', 4, 1000,
             '{"breakdown":[{"label":"Shared Gratuity","amount":100}]}')
     RETURNING id`
  );
  proposalId = p.rows[0].id;
  // The shift deliberately omits event_duration_hours: it is NULL on real
  // production shifts, so accrual must read the duration from the proposal.
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES (CURRENT_DATE, '6:00 PM', 'open', $1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, userId]
  );
});

afterEach(async () => {
  await pool.query(
    `DELETE FROM payout_events WHERE payout_id IN
       (SELECT id FROM payouts WHERE contractor_id = $1)`,
    [userId]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [userId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('accruePayoutsForProposal > creates a payout and a payout_event for the bartender', async () => {
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.wage_cents, pe.gratuity_share_cents, pe.line_total_cents, po.total_cents
     FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
     WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(rows.length, 1);
  // Duration 4h read from the proposal -> 5.5 contracted hours @ $20.00 = $110.00.
  // Gratuity $100 to the one bartender; no card payments, so no fee netted.
  assert.equal(rows[0].wage_cents, 11000);
  assert.equal(rows[0].gratuity_share_cents, 10000);
  assert.equal(rows[0].line_total_cents, 21000);
  assert.equal(rows[0].total_cents, 21000);
});

test('accruePayoutsForProposal > is idempotent: a second call does not duplicate', async () => {
  await accruePayoutsForProposal(proposalId);
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT count(*) FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
     WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(Number(rows[0].count), 1);
});

test('accruePayoutsForProposal > re-accrual preserves an admin edit to hours', async () => {
  await accruePayoutsForProposal(proposalId);
  // Simulate an admin adjusting hours in the portal.
  await pool.query(
    `UPDATE payout_events SET hours = 9
     WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id = $1)`,
    [userId]
  );
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.hours, pe.wage_cents FROM payout_events pe
     JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  // The edited hours survive; wage is recomputed from them (9 * $20.00).
  assert.equal(Number(rows[0].hours), 9);
  assert.equal(rows[0].wage_cents, 18000);
});

test('accruePayoutsForProposal > nets the card fee out of the gratuity share', async () => {
  // A card payment carrying a $32.00 (3200c) Stripe fee. The proposal's
  // total_price is $1000, so the $100 gratuity bears 10% of that fee.
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'full', 100000, 'succeeded', 3200, 'pi_grat_fee')`,
    [proposalId]
  );
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents FROM payout_events pe
     JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  // Gratuity 10000c; fee share = 3200 * (10000 / 100000) = 320c; net = 9680c.
  assert.equal(rows[0].gratuity_share_cents, 9680);
});

test('accruePayoutsForProposal > splits gratuity evenly across two bartenders', async () => {
  const u2 = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('accrue2@example.com','x','staff') RETURNING id"
  );
  const user2 = u2.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [user2]
  );
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, user2]
  );
  try {
    await accruePayoutsForProposal(proposalId);
    const { rows } = await pool.query(
      `SELECT pe.gratuity_share_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       WHERE po.contractor_id IN ($1,$2) ORDER BY po.contractor_id`,
      [userId, user2]
    );
    // $100 gratuity split two ways: 5000c each, summing to the full 10000c.
    assert.equal(rows.length, 2);
    assert.equal(rows[0].gratuity_share_cents + rows[1].gratuity_share_cents, 10000);
    assert.equal(rows[0].gratuity_share_cents, 5000);
  } finally {
    await pool.query(
      `DELETE FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id = $1)`,
      [user2]
    );
    await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [user2]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [user2]);
    await pool.query('DELETE FROM users WHERE id = $1', [user2]);
  }
});

test('accruePayoutsForProposal > skips and returns structured shape when proposal has a legacy CC stub participant', async () => {
  // cc-import: events whose participants include a legacy_cc:* stub bartender
  // must NOT enter modern payouts (we cannot pay a stub through Stripe Connect).
  // The guard fires per-proposal — one stub on any shift skips the WHOLE accrual.
  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('accrue-stub@example.com','x','staff','legacy_cc:test:accrue-stub')
     RETURNING id`
  );
  const stubId = stub.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, stubId]
  );
  try {
    const result = await accruePayoutsForProposal(proposalId);
    assert.deepStrictEqual(result, { skipped: true, reason: 'legacy_cc_stub_participant' });
    // Guard MUST fire BEFORE any DB writes: no payouts/payout_events for ANY
    // participant on this proposal, including the non-stub bartender (userId).
    const noEvents = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id IN ($1, $2)`,
      [userId, stubId]
    );
    assert.strictEqual(noEvents.rows[0].c, 0);
  } finally {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1 AND user_id = $2', [shiftId, stubId]);
    await pool.query('DELETE FROM users WHERE id = $1', [stubId]);
  }
});
