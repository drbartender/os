require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SEND_NOTIFICATIONS = 'false';

// Regression test for the L2 auto-assign scoping (staffing roster project):
// auto-assign fills BARTENDER slots only. A requester is eligible iff their
// ranked requested_positions includes 'Bartender' OR is empty (legacy "any
// role"); a server-only / barback-only requester must never be auto-seated into
// a bartender slot (that would put a non-bartender into the payroll tip split
// via position='Bartender'). The real-assign path writes position='Bartender'.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { autoAssignShift } = require('./autoAssign');

if (process.env.NODE_ENV === 'production') {
  throw new Error('autoAssign.bartenderScope.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let bartenderUser, serverUser, legacyUser, legacyServerUser;
let shiftId;

async function mkStaff(tag, position) {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`autoassign-${tag}-${NONCE}@example.com`]
  );
  const id = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
     VALUES ($1, $2, $3, 25.00)`,
    [id, `AutoAssign ${tag}`, position]
  );
  return id;
}

before(async () => {
  bartenderUser = await mkStaff('bar', 'Bartender');
  serverUser = await mkStaff('srv', 'Banquet Server');
  legacyUser = await mkStaff('legacy', 'Bartender');
  legacyServerUser = await mkStaff('legacysrv', 'Banquet Server');

  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, positions_needed, equipment_required)
     VALUES (CURRENT_DATE + 12, '18:00', '22:00', 'open', '123 Main', '["Bartender","Bartender"]', '[]') RETURNING id`
  );
  shiftId = sh.rows[0].id;

  // Ranked Bartender -> eligible; server-only -> NOT eligible; empty -> "any role" eligible.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, requested_positions) VALUES ($1, $2, 'pending', $3)`,
    [shiftId, bartenderUser, '["Bartender"]']
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, requested_positions) VALUES ($1, $2, 'pending', $3)`,
    [shiftId, serverUser, '["Banquet Server"]']
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, requested_positions) VALUES ($1, $2, 'pending', $3)`,
    [shiftId, legacyUser, '[]']
  );
  // Codex-caught edge: empty requested_positions BUT a committed non-bartender
  // position. "Any role" must not override the committed role -> NOT eligible.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions) VALUES ($1, $2, 'pending', 'Banquet Server', '[]')`,
    [shiftId, legacyServerUser]
  );
});

after(async () => {
  if (shiftId) {
    await pool.query(
      `DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1`,
      [shiftId]
    );
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  }
  const ids = [bartenderUser, serverUser, legacyUser, legacyServerUser].filter(Boolean);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  await pool.end();
});

test('dry-run: bartender + legacy-empty are eligible, server-only is excluded', async () => {
  const result = await autoAssignShift(shiftId, { dryRun: true });
  const scoredUserIds = result.scores.map((s) => s.user_id);
  assert.ok(scoredUserIds.includes(bartenderUser), 'a Bartender-ranked requester is a candidate');
  assert.ok(scoredUserIds.includes(legacyUser), 'a legacy empty-requested ("any role") requester is a candidate');
  assert.ok(!scoredUserIds.includes(serverUser), 'a server-only requester is NOT a bartender-slot candidate');
  assert.ok(!scoredUserIds.includes(legacyServerUser), 'empty requested_positions + committed position=Banquet Server is NOT a bartender candidate');
});

test('real assign writes position=Bartender and never seats the server-only requester', async () => {
  await autoAssignShift(shiftId, { dryRun: false });
  const rows = await pool.query(
    `SELECT user_id, status, position FROM shift_requests WHERE shift_id = $1`,
    [shiftId]
  );
  const byUser = Object.fromEntries(rows.rows.map((r) => [r.user_id, r]));

  // Neither the ranked-server nor the committed-server-but-empty-ranked requester
  // is ever approved by auto-assign.
  assert.equal(byUser[serverUser].status, 'pending', 'server-only stays pending');
  assert.equal(byUser[legacyServerUser].status, 'pending', 'committed-server + empty-ranked stays pending');

  // Every auto-approved row carries the canonical Bartender position (the money key).
  const approved = rows.rows.filter((r) => r.status === 'approved');
  assert.ok(approved.length >= 1, 'at least one bartender slot was filled');
  for (const r of approved) {
    assert.equal(r.position, 'Bartender', `approved user ${r.user_id} written as canonical Bartender`);
    assert.notEqual(r.user_id, serverUser, 'the server-only requester was never approved');
    assert.notEqual(r.user_id, legacyServerUser, 'the committed-server requester was never approved');
  }
});
