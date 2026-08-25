require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

/**
 * shiftReap — the shared shift-cancel reap behind BOTH the proposal cancel flow
 * and the admin archive flow.
 *
 * This suite drives `reapShiftsForProposal` directly on a transaction client,
 * which is exactly how both callers use it. Covers the Out-of-Area lock release
 * (spec 2026-08-06 §6): a cancelled event denies every request, so nobody is
 * left holding the bonus and the lock must come off unscoped, or the duty line
 * would keep pointing at a staffer whose event no longer exists.
 *
 * Fixtures are keyed 'reap-%@example.com' so nothing collides on the shared dev
 * DB, and all writes happen inside a transaction the test ROLLS BACK.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { reapShiftsForProposal } = require('./shiftReap');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shiftReap.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let staffAId, staffBId, clientId, proposalId;

async function cleanup() {
  const uids = "(SELECT id FROM users WHERE email LIKE 'reap-%@example.com')";
  const props = "(SELECT id FROM proposals WHERE event_type = 'reap-fixture')";
  await pool.query(`DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id IN (SELECT id FROM shifts WHERE proposal_id IN ${props})`);
  await pool.query(`DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id IN ${props})`);
  await pool.query(`UPDATE shifts SET out_of_area_locked_user_id = NULL, out_of_area_attached_by = NULL WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM shifts WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id IN ${props}`);
  await pool.query(`DELETE FROM proposals WHERE event_type = 'reap-fixture'`);
  await pool.query(`DELETE FROM clients WHERE email LIKE 'reap-%@example.com'`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN ${uids}`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'reap-%@example.com'`);
}

before(async () => {
  await cleanup();
  const mk = async (tag) => (await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`reap-${tag}-${NONCE}@example.com`]
  )).rows[0].id;
  staffAId = await mk('a');
  staffBId = await mk('b');

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`Reap ${NONCE}`, `reap-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            status, event_type, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 20, '18:00', 4, 'confirmed', 'reap-fixture', 0, 0, '{"addons":[]}')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

after(async () => {
  await cleanup();
  await pool.end();
});

test('reap releases the Out-of-Area lock on every reaped shift and keeps the amount', async () => {
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, positions_needed,
                         out_of_area_bonus_cents, out_of_area_locked_at, out_of_area_locked_user_id)
     VALUES (CURRENT_DATE + 20, '18:00', 'open', $1, '["Bartender"]'::jsonb, 2000, NOW(), $2)
     RETURNING id`,
    [proposalId, staffAId]
  );
  const shiftId = s.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [shiftId, staffAId]
  );

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const reaped = await reapShiftsForProposal(proposalId, dbClient, 'event cancelled');
    assert.equal(reaped.length, 1, 'one shift reaped');
    assert.equal(reaped[0].shiftId, shiftId);
    assert.deepEqual(reaped[0].userIds, [staffAId]);

    // Read INSIDE the transaction: the release has to be part of the same unit
    // as the cancel, so a rollback leaves the bonus exactly where it was.
    const inTx = await dbClient.query(
      `SELECT status, out_of_area_bonus_cents, out_of_area_locked_at, out_of_area_locked_user_id
         FROM shifts WHERE id = $1`,
      [shiftId]
    );
    assert.equal(inTx.rows[0].status, 'cancelled');
    assert.equal(inTx.rows[0].out_of_area_locked_at, null, 'cancelling released the lock');
    assert.equal(inTx.rows[0].out_of_area_locked_user_id, null);
    assert.equal(Number(inTx.rows[0].out_of_area_bonus_cents), 2000,
      'the amount survives so the event still reports its true cost');

    await dbClient.query('ROLLBACK');
  } finally {
    dbClient.release();
  }

  // Rollback restored the lock: the release is transactional, not a side write.
  const after0 = await pool.query(
    'SELECT status, out_of_area_locked_user_id FROM shifts WHERE id = $1', [shiftId]
  );
  assert.equal(after0.rows[0].status, 'open');
  assert.equal(after0.rows[0].out_of_area_locked_user_id, staffAId,
    'a rolled-back cancel must not have released the bonus');

  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
});

test('reap releases across MULTIPLE shifts and skips already-cancelled ones', async () => {
  const mkShift = async (status, lockUser) => (await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, positions_needed,
                         out_of_area_bonus_cents, out_of_area_locked_at, out_of_area_locked_user_id)
     VALUES (CURRENT_DATE + 20, '18:00', $3, $1, '["Bartender"]'::jsonb, 3500, NOW(), $2)
     RETURNING id`,
    [proposalId, lockUser, status]
  )).rows[0].id;

  const liveOne = await mkShift('open', staffAId);
  const liveTwo = await mkShift('open', staffBId);
  // Already cancelled: the reap's WHERE excludes it, so its lock is untouched.
  const alreadyCancelled = await mkShift('cancelled', staffBId);
  for (const [sid, uid] of [[liveOne, staffAId], [liveTwo, staffBId]]) {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1, $2, 'Bartender', 'approved')`,
      [sid, uid]
    );
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const reaped = await reapShiftsForProposal(proposalId, dbClient, 'event cancelled');
    assert.equal(reaped.length, 2, 'only the two live shifts are reaped');

    const rows = await dbClient.query(
      `SELECT id, out_of_area_locked_user_id FROM shifts WHERE id = ANY($1) ORDER BY id`,
      [[liveOne, liveTwo, alreadyCancelled]]
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.out_of_area_locked_user_id]));
    assert.equal(byId.get(liveOne), null, 'shift 1 released');
    assert.equal(byId.get(liveTwo), null, 'shift 2 released, not just the first');
    assert.equal(byId.get(alreadyCancelled), staffBId, 'an already-cancelled shift is not re-reaped');

    await dbClient.query('ROLLBACK');
  } finally {
    dbClient.release();
  }

  await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1)', [[liveOne, liveTwo]]);
  await pool.query('UPDATE shifts SET out_of_area_locked_user_id = NULL WHERE id = ANY($1)',
    [[liveOne, liveTwo, alreadyCancelled]]);
  await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [[liveOne, liveTwo, alreadyCancelled]]);
});

test('a staffer who already dropped is not told the event was cancelled', async () => {
  // Dropping leaves status = 'approved' and stamps dropped_at, so a capture
  // that filters on status alone sweeps up someone who already left. Those
  // userIds become the cancellation notification (actions.js reapedStaff), so
  // the person gets told about an event they are no longer on, and it costs a
  // send. The bartender clawback six lines below this capture has always
  // filtered dropped_at, which is what makes the intent unambiguous: the money
  // path was right and the messaging path was not.
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, positions_needed)
     VALUES (CURRENT_DATE + 20, '18:00', 'open', $1, '["Bartender","Bartender"]'::jsonb)
     RETURNING id`,
    [proposalId]
  );
  const shiftId = s.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved')`,
    [shiftId, staffAId]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status, dropped_at)
     VALUES ($1, $2, 'Bartender', 'approved', NOW())`,
    [shiftId, staffBId]
  );

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const reaped = await reapShiftsForProposal(proposalId, dbClient, 'event cancelled');
    const mine = reaped.find((r) => r.shiftId === shiftId);
    assert.ok(mine, 'the shift was reaped');
    assert.deepEqual(mine.userIds, [staffAId],
      'only the staffer still on the shift is notified; the dropped one is not');
    assert.deepEqual(mine.bartenderUserIds, [staffAId],
      'the clawback capture already agreed, and still does');
    await dbClient.query('ROLLBACK');
  } finally {
    dbClient.release();
  }

  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
});
