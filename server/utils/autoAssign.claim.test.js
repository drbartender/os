require('dotenv').config();
// Force notifications off regardless of local .env so the approval-SMS path is a
// no-op during the test.
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('autoAssign.claim.test.js refuses to run against production');
}

// Stub the two post-approval hooks NOT under test (staff-SMS scheduling +
// last-minute staffing confirmation), mutated on the cached module exports BEFORE
// ./autoAssign is required so its destructured refs pick up the stubs. The claim
// UPDATE under test still runs REAL against the database.
require('./staffShiftHandlers').scheduleStaffShiftMessages = async () => {};
require('./lastMinuteStaffingConfirmation').confirmStaffingIfFullyStaffed = async () => {};

const { autoAssignShift } = require('./autoAssign');

// ── Approval claim: exactly-once approval under a concurrent approver ─────────
// autoAssign selected a top-N of pending requests and blindly flipped them to
// 'approved', then SMS'd each — so a concurrent auto-assign run or a manual
// approval racing the same request produced a double approval + double SMS. The
// fix flips only rows still 'pending' (UPDATE ... AND status='pending' RETURNING
// id) and notifies ONLY the returned ids.
//
// Gate/race: a gate connection holds an open transaction that has already
// approved the single pending request (uncommitted). The REAL autoAssignShift
// runs on the pool; it reads the request as pending (MVCC), selects it, and its
// claim UPDATE parks on the gate's row lock. The gate commits; autoAssign's claim
// re-evaluates status='pending' against the now-approved row -> 0 rows -> it
// approves/notifies nobody. Discrimination check: drop `AND status='pending'`
// from the claim in autoAssign.js and it re-approves the row (RETURNING the id),
// approved.length becomes 1, and this test fails.

const PREFIX = 'aa-claim-test-';

let userId, profileId, shiftId, requestId;

before(async () => {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
    [`${PREFIX}bartender@example.com`]
  );
  userId = u.rows[0].id;

  const cp = await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2) RETURNING id`,
    [userId, 'AutoAssign Claim Test Bartender']
  );
  profileId = cp.rows[0].id;

  // Shift needs exactly one bartender; no equipment required (default '[]').
  const s = await pool.query(
    `INSERT INTO shifts (event_date, positions_needed, status)
     VALUES (CURRENT_DATE + INTERVAL '30 days', '["Bartender"]', 'open') RETURNING id`
  );
  shiftId = s.rows[0].id;

  // Single pending request; empty requested_positions + no committed position =
  // bartender-eligible ("any role").
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
    [shiftId, userId]
  );
  requestId = sr.rows[0].id;
});

after(async () => {
  if (requestId) await pool.query('DELETE FROM shift_requests WHERE id = $1', [requestId]);
  if (shiftId) await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  if (profileId) await pool.query('DELETE FROM contractor_profiles WHERE id = $1', [profileId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('a request approved by a concurrent actor mid-flight is not re-approved by autoAssign', async () => {
  const gate = await pool.connect();
  let result;
  let gateRowCount;
  try {
    await gate.query('BEGIN');
    // Gate = "the other approver": claim the request (pending -> approved) and
    // hold the row lock without committing.
    const gateRes = await gate.query(
      `UPDATE shift_requests SET status = 'approved' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [requestId]
    );
    gateRowCount = gateRes.rowCount;

    // Fire autoAssign WITHOUT awaiting. It reads the request as pending (the
    // gate's approval is uncommitted), selects it, then its claim UPDATE parks on
    // the gate's row lock.
    const pending = autoAssignShift(shiftId);

    // Give it time to reach the lock wait, then let the gate commit.
    await new Promise((r) => setTimeout(r, 400));
    await gate.query('COMMIT');

    result = await pending;
  } finally {
    gate.release();
  }

  assert.equal(gateRowCount, 1, 'the gate (first approver) must win the claim');
  assert.equal(result.approved.length, 0, 'autoAssign must approve/notify nobody once the gate approved the request');

  // The request is approved exactly once — by the gate, not re-approved by autoAssign.
  const { rows } = await pool.query('SELECT status FROM shift_requests WHERE id = $1', [requestId]);
  assert.equal(rows[0].status, 'approved', 'the request must remain approved (by the gate) exactly once');
});
