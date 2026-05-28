require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const {
  insertBeoNudgeIfMissing,
  scheduleBeoNudgesForProposal,
  BEO_MESSAGE_TYPE,
} = require('./beoHandlers');

let clientId, proposalId, userId, shiftId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('BEO Test', 'beo-handlers-test@example.com') RETURNING id"
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type, total_price, amount_paid, balance_due_date)
     VALUES ($1, CURRENT_DATE + 30, '6:00 PM', 4, 'America/Chicago', 'deposit_paid', 'birthday-party', 100000, 10000, CURRENT_DATE + 14)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const passwordHash = await bcrypt.hash('x', 4);
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, notifications_opt_in)
     VALUES ($1, $2, 'staff', 'approved', true) RETURNING id`,
    [`beo-handlers-staff-${Date.now()}@example.com`, passwordHash]
  );
  userId = u.rows[0].id;
  await pool.query(
    "INSERT INTO contractor_profiles (user_id, phone, preferred_name) VALUES ($1, '+15555550101', 'Test Staffer')",
    [userId]
  );
  const s = await pool.query(
    "INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id",
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')",
    [shiftId, userId]
  );
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id = $1 AND entity_type = 'proposal'", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id = $1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
  await pool.end();
});

// ─── Task 7: insertBeoNudgeIfMissing ─────────────────────────────────────

test('BEO_MESSAGE_TYPE constant', () => {
  assert.strictEqual(BEO_MESSAGE_TYPE, 'beo_unack_nudge_sms');
});

test('insertBeoNudgeIfMissing > inserts pending row', async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  const scheduledFor = new Date(Date.now() + 60 * 1000);
  await insertBeoNudgeIfMissing(pool, { proposalId, userId, scheduledFor });
  const { rows } = await pool.query(
    `SELECT status, recipient_id FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type='beo_unack_nudge_sms'`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'pending');
  assert.strictEqual(rows[0].recipient_id, userId);
});

test('insertBeoNudgeIfMissing > skips when pending row already exists', async () => {
  const scheduledFor = new Date(Date.now() + 60 * 1000);
  await insertBeoNudgeIfMissing(pool, { proposalId, userId, scheduledFor });
  const { rows } = await pool.query(
    `SELECT count(*) FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type='beo_unack_nudge_sms'`,
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1, 'expected still 1 row, not 2');
});

test('insertBeoNudgeIfMissing > re-inserts when only suppressed rows exist', async () => {
  await pool.query(
    `UPDATE scheduled_messages SET status='suppressed', error_message='unfinalized'
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type='beo_unack_nudge_sms'`,
    [proposalId]
  );
  const scheduledFor = new Date(Date.now() + 60 * 1000);
  await insertBeoNudgeIfMissing(pool, { proposalId, userId, scheduledFor });
  const { rows } = await pool.query(
    `SELECT status FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type='beo_unack_nudge_sms' ORDER BY id`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 2, 'expected one suppressed + one new pending');
  assert.deepStrictEqual(rows.map(r => r.status).sort(), ['pending', 'suppressed']);
});

// ─── Task 8: scheduleBeoNudgesForProposal ────────────────────────────────

test('scheduleBeoNudgesForProposal > inserts one row per approved staffer', async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT recipient_id, scheduled_for FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND message_type='beo_unack_nudge_sms'",
    [proposalId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].recipient_id, userId);
});

test('scheduleBeoNudgesForProposal > skips deactivated staffers', async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE users SET onboarding_status='deactivated' WHERE id=$1", [userId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
  await pool.query("UPDATE users SET onboarding_status='approved' WHERE id=$1", [userId]);
});

test('scheduleBeoNudgesForProposal > skips past-event proposals', async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE - 1 WHERE id = $1", [proposalId]);
  const result = await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
  assert.strictEqual(result.skipped, 'past_or_unparseable');
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE + 30 WHERE id = $1", [proposalId]);
});

test('scheduleBeoNudgesForProposal > skips TBD start time', async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE proposals SET event_start_time = NULL WHERE id = $1", [proposalId]);
  const result = await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
  assert.strictEqual(result.skipped, 'no_start_time');
  await pool.query("UPDATE proposals SET event_start_time = '6:00 PM' WHERE id = $1", [proposalId]);
});

test('scheduleBeoNudgesForProposal > dedupes when a staffer is on two shifts', async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  const s2 = await pool.query(
    "INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id",
    [proposalId]
  );
  await pool.query("INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')", [s2.rows[0].id, userId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND recipient_id=$2",
    [proposalId, userId]
  );
  assert.strictEqual(Number(rows[0].count), 1, 'one row per staffer per proposal');
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [s2.rows[0].id]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [s2.rows[0].id]);
});


// ─── Task 9: suppress helpers ────────────────────────────────────────────

test('suppressBeoNudgesForProposal > marks pending suppressed, preserves sent', async () => {
  const { suppressBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  // Insert a fake-but-distinct sent row for a different user_id (cleanup at end)
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, sent_at)
     VALUES ($1, 'proposal', 'beo_unack_nudge_sms', 'staff', $2, 'sms', NOW(), 'sent', NOW())`,
    [proposalId, userId + 99999]
  );
  const result = await suppressBeoNudgesForProposal(proposalId, pool, 'unfinalized: BEO unfinalized by admin');
  assert.strictEqual(result.suppressed, 1);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 ORDER BY status",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  assert.strictEqual(rows[1].status, 'suppressed');
  assert.match(rows[1].error_message, /unfinalized/);
});

test('suppressBeoNudgesForStaffers > only suppresses when no surviving approved shift', async () => {
  const { suppressBeoNudgesForStaffers } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  // Staffer's shift_request is still approved -> NOT EXISTS guard preserves the row
  await suppressBeoNudgesForStaffers(proposalId, [userId], pool);
  const stillPending = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND recipient_id=$2",
    [proposalId, userId]
  );
  assert.strictEqual(stillPending.rows[0].status, 'pending');
  // Deny the request, then re-run -> now suppressed
  await pool.query("UPDATE shift_requests SET status='denied' WHERE shift_id=$1 AND user_id=$2", [shiftId, userId]);
  await suppressBeoNudgesForStaffers(proposalId, [userId], pool);
  const nowSuppressed = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND recipient_id=$2",
    [proposalId, userId]
  );
  assert.strictEqual(nowSuppressed.rows[0].status, 'suppressed');
  await pool.query("UPDATE shift_requests SET status='approved' WHERE shift_id=$1 AND user_id=$2", [shiftId, userId]);
});

test('suppressBeoNudgesForStaffers > empty userIds returns 0 without query', async () => {
  const { suppressBeoNudgesForStaffers } = require('./beoHandlers');
  const result = await suppressBeoNudgesForStaffers(proposalId, [], pool);
  assert.strictEqual(result.suppressed, 0);
});
