require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('autoAssign.seniority.test.js refuses to run against production');
}

// Post-approval hooks not under test → no-ops (mutate before requiring autoAssign).
require('./staffShiftHandlers').scheduleStaffShiftMessages = async () => {};
require('./lastMinuteStaffingConfirmation').confirmStaffingIfFullyStaffed = async () => {};
const { autoAssignShift } = require('./autoAssign');

const PREFIX = 'aa-seniority-test-';
let userId, shiftId;

before(async () => {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`${PREFIX}u@example.com`]
  );
  userId = u.rows[0].id;
  // Contractor profile: NO live OS events, but 12 historical (pre-migration).
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, historical_events_worked)
     VALUES ($1, $2, 12)`,
    [userId, `${PREFIX}Vet`]
  );
  // A future shift needing one bartender. positions_needed uses the
  // {position,count} shape, parsePositionsNeeded reads entry.position, NOT
  // entry.role. equipment_required is left unset (autoAssign coalesces it to '[]').
  const s = await pool.query(
    `INSERT INTO shifts (event_date, positions_needed, status)
     VALUES (CURRENT_DATE + 30, $1, 'open') RETURNING id`,
    [JSON.stringify([{ position: 'Bartender', count: 1 }])]
  );
  shiftId = s.rows[0].id;
  // One pending bartender request from our vet.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, 'pending', 'Bartender')`,
    [shiftId, userId]
  );
});

after(async () => {
  await pool.query(`DELETE FROM shift_requests WHERE shift_id = $1`, [shiftId]);
  await pool.query(`DELETE FROM shifts WHERE id = $1`, [shiftId]);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

test('historical_events_worked is added to the live event count in the ranker', async () => {
  const result = await autoAssignShift(shiftId, { dryRun: true });
  const mine = result.scores.find((s) => s.user_id === userId);
  assert.ok(mine, 'candidate scored');
  // 0 live + 12 historical = 12
  assert.equal(mine.scores.events_worked, 12);
  assert.ok(mine.scores.seniority > 0, 'seniority reflects the historical credit');
});
