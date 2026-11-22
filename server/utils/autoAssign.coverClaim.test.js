// Auto-assign and cover claims: a live claim is never seated, a finished one is an ordinary request.
//
// A live cover claim (a pending request whose replaced_by_request_id points at
// an original still approved, undropped and asking for cover) is a swap only an
// admin approves, since approving it must deny the original. Auto-assign seating
// one left both staffers approved, and payroll paid both. replaced_by_request_id
// is never cleared, so once the claim is over (the original no longer asks for
// cover) the same row must be seatable again.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('autoAssign.coverClaim.test.js refuses to run against production');
}

// Stub the post-approval hooks not under test, before ./autoAssign is required.
require('./staffShiftHandlers').scheduleStaffShiftMessages = async () => {};
require('./lastMinuteStaffingConfirmation').confirmStaffingIfFullyStaffed = async () => {};

const { autoAssignShift } = require('./autoAssign');

const TAG = crypto.randomBytes(4).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
const userIds = [];
let shiftId, origReq, claimReq;

async function mkUser(label) {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
    [`aa-cover-${label}-${TAG}@example.com`]
  );
  await pool.query(
    'INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)',
    [u.rows[0].id, `Cover Test ${label}`]
  );
  userIds.push(u.rows[0].id);
  return u.rows[0].id;
}

before(async () => {
  const a = await mkUser('original');
  const b = await mkUser('claimer');
  // Two bartender slots, so a slot is open even with the original seated.
  const s = await pool.query(
    `INSERT INTO shifts (event_date, positions_needed, status)
     VALUES (CURRENT_DATE + INTERVAL '30 days', '["Bartender","Bartender"]', 'open') RETURNING id`
  );
  shiftId = s.rows[0].id;
  const o = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, cover_requested_at)
     VALUES ($1, $2, 'approved', 'Bartender', NOW()) RETURNING id`,
    [shiftId, a]
  );
  origReq = o.rows[0].id;
  const c = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, replaced_by_request_id)
     VALUES ($1, $2, 'pending', $3) RETURNING id`,
    [shiftId, b, origReq]
  );
  claimReq = c.rows[0].id;
});

after(async () => {
  if (shiftId) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
  if (userIds.length) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  }
  await pool.end();
});

test('a live cover claim is never seated by auto-assign', async () => {
  const result = await autoAssignShift(shiftId);
  assert.equal(result.approved.length, 0, 'no one seated while the claim is live');
  const { rows } = await pool.query('SELECT status FROM shift_requests WHERE id = $1', [claimReq]);
  assert.equal(rows[0].status, 'pending');
});

test('once the original no longer asks for cover, the old claim row is an ordinary request', async () => {
  await pool.query('UPDATE shift_requests SET cover_requested_at = NULL WHERE id = $1', [origReq]);
  const result = await autoAssignShift(shiftId);
  assert.equal(result.approved.length, 1, 'the former claimer is seated');
  const { rows } = await pool.query('SELECT status FROM shift_requests WHERE id = $1', [claimReq]);
  assert.equal(rows[0].status, 'approved');
});
