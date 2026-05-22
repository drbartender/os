require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { notifyStaffOfCancellation } = require('../utils/staffShiftHandlers');

const TEST_CLIENT_ID = -7501;
const TEST_USER_ID_A = -7502;
const TEST_USER_ID_B = -7503;
const TEST_PROPOSAL_ID = -7504;
const TEST_SHIFT_ID = -7505;

async function cleanup() {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)', [TEST_USER_ID_A, TEST_USER_ID_B]);
  await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [TEST_USER_ID_A, TEST_USER_ID_B]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
  await pool.query("DELETE FROM sms_messages WHERE message_type IN ('staff_cancellation_notice','staff_unassignment_notice')");
}

before(async () => {
  await cleanup();
  await pool.query(
    "INSERT INTO clients (id, name, email) VALUES ($1, 'Cancel Test', 'cancel-test@example.com')",
    [TEST_CLIENT_ID]
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'cancel-a@example.com', 'x', 'staff'),
            ($2, 'cancel-b@example.com', 'x', 'staff')`,
    [TEST_USER_ID_A, TEST_USER_ID_B]
  );
});

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_duration_hours, event_timezone, event_type)
     VALUES ($1, $2, 'confirmed', CURRENT_DATE + INTERVAL '40 days', '18:00', 4, 'America/Chicago', 'birthday-party')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  await pool.query(
    `INSERT INTO shifts (id, proposal_id, event_date, start_time, positions_needed, status)
     VALUES ($1, $2, CURRENT_DATE + INTERVAL '40 days', '18:00', '["Bartender","Bartender"]', 'open')`,
    [TEST_SHIFT_ID, TEST_PROPOSAL_ID]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status)
     VALUES ($1, $2, 'approved'), ($1, $3, 'approved')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A, TEST_USER_ID_B]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'sms', NOW() + INTERVAL '10 days'),
            ($1, 'shift', 'shift_reminder', 'staff', $3, 'sms', NOW() + INTERVAL '10 days')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A, TEST_USER_ID_B]
  );
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query("DELETE FROM sms_messages WHERE message_type IN ('staff_cancellation_notice','staff_unassignment_notice')");
});

after(async () => {
  await cleanup();
  await pool.end();
});

async function runCancel() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE shifts SET status = 'cancelled' WHERE id = $1", [TEST_SHIFT_ID]);
    await c.query("UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND status != 'denied'", [TEST_SHIFT_ID]);
    await c.query(
      `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'shift cancelled'
        WHERE entity_type = 'shift' AND entity_id = $1
          AND message_type IN ('shift_reminder', 'staff_thank_you') AND status = 'pending'`,
      [TEST_SHIFT_ID]
    );
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function runUnassign(userId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND user_id = $2 AND status = 'approved'",
      [TEST_SHIFT_ID, userId]
    );
    await c.query(
      `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'staff unassigned'
        WHERE entity_type = 'shift' AND entity_id = $1
          AND recipient_type = 'staff' AND recipient_id = $2
          AND message_type IN ('shift_reminder', 'staff_thank_you') AND status = 'pending'`,
      [TEST_SHIFT_ID, userId]
    );
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

test('cancel > denies all requests and suppresses all pending reminder rows', async () => {
  await runCancel();
  const reqs = await pool.query(
    "SELECT count(*) FROM shift_requests WHERE shift_id = $1 AND status = 'denied'", [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(reqs.rows[0].count), 2);
  const shift = await pool.query('SELECT status FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  assert.strictEqual(shift.rows[0].status, 'cancelled');
  const sm = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND status = 'suppressed'",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(sm.rows[0].count), 2);
});

test('unassign > denies only the one staffer and suppresses only their pending rows', async () => {
  await runUnassign(TEST_USER_ID_A);
  const denied = await pool.query(
    "SELECT user_id, status FROM shift_requests WHERE shift_id = $1 ORDER BY user_id", [TEST_SHIFT_ID]
  );
  const byUser = Object.fromEntries(denied.rows.map((r) => [Number(r.user_id), r.status]));
  assert.strictEqual(byUser[TEST_USER_ID_A], 'denied');
  assert.strictEqual(byUser[TEST_USER_ID_B], 'approved');
  const aSuppressed = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_id = $2",
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );
  assert.strictEqual(aSuppressed.rows[0].status, 'suppressed');
  const bRow = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_id = $2",
    [TEST_SHIFT_ID, TEST_USER_ID_B]
  );
  assert.strictEqual(bRow.rows[0].status, 'pending');
});

test('notifyStaffOfCancellation > sends nothing when both channels are off', async () => {
  const r = await notifyStaffOfCancellation({
    shiftId: TEST_SHIFT_ID, staffUserIds: [TEST_USER_ID_A], kind: 'cancelled', sms: false, email: false,
  });
  assert.deepStrictEqual(r, { smsSent: 0, emailSent: 0 });
});

test('notifyStaffOfCancellation > sends SMS to a staffer with a phone', async () => {
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Alex', '5555550133')
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone`,
    [TEST_USER_ID_A]
  );
  const r = await notifyStaffOfCancellation({
    shiftId: TEST_SHIFT_ID, staffUserIds: [TEST_USER_ID_A], kind: 'unassigned', sms: true, email: false,
  });
  assert.strictEqual(r.smsSent, 1);
});
