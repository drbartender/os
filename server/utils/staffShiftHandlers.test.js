require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  parseClockTime,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  scheduleStaffShiftMessages,
  registerStaffShiftHandlers,
} = require('./staffShiftHandlers');
const { dispatchPending } = require('./scheduledMessageDispatcher');

// Negative fixture IDs so parallel test files don't collide.
const TEST_CLIENT_ID = -7401;
const TEST_USER_ID_A = -7402;
const TEST_USER_ID_B = -7403;
const TEST_PROPOSAL_ID = -7404;
const TEST_SHIFT_ID = -7405;

async function cleanup() {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [TEST_USER_ID_A, TEST_USER_ID_B]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
}

before(async () => {
  await cleanup();
  await pool.query(
    "INSERT INTO clients (id, name, email) VALUES ($1, 'StaffSMS Client', 'staffsms-client@example.com')",
    [TEST_CLIENT_ID]
  );
  // users requires email + password_hash; role 'staff' per users_role_check.
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'staffsms-a@example.com', 'x', 'staff'),
            ($2, 'staffsms-b@example.com', 'x', 'staff')`,
    [TEST_USER_ID_A, TEST_USER_ID_B]
  );
});

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
});

after(async () => {
  await cleanup();
  await pool.end();
});

async function seedShift({ status = 'confirmed', startTime = '18:00', durationHours = 4, eventDateExpr = "CURRENT_DATE + INTERVAL '60 days'" } = {}) {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_duration_hours, event_timezone, event_type)
     VALUES ($1, $2, $3, ${eventDateExpr}, $4, $5, 'America/Chicago', 'birthday-party')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, status, startTime, durationHours]
  );
  await pool.query(
    `INSERT INTO shifts (id, proposal_id, event_date, start_time, positions_needed, status)
     VALUES ($1, $2, ${eventDateExpr}, $3, '["Bartender"]', 'open')`,
    [TEST_SHIFT_ID, TEST_PROPOSAL_ID, startTime]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );
}

test('parseClockTime > parses 24-hour and 12-hour formats, rejects junk', () => {
  assert.deepStrictEqual(parseClockTime('18:00'), { hour: 18, minute: 0 });
  assert.deepStrictEqual(parseClockTime('6:00 PM'), { hour: 18, minute: 0 });
  assert.deepStrictEqual(parseClockTime('12:30 AM'), { hour: 0, minute: 30 });
  assert.strictEqual(parseClockTime('not a time'), null);
  assert.strictEqual(parseClockTime(''), null);
});

test('computeShiftReminderScheduledFor > T-24h from event start in event TZ', () => {
  const at = computeShiftReminderScheduledFor({
    event_date: '2026-08-15', event_start_time: '18:00', event_timezone: 'America/Chicago',
  });
  assert.strictEqual(at.toISOString(), '2026-08-14T23:00:00.000Z');
});

test('computeStaffThankYouScheduledFor > event end + 30 min', () => {
  const at = computeStaffThankYouScheduledFor({
    event_date: '2026-08-15', event_start_time: '18:00', event_duration_hours: 4, event_timezone: 'America/Chicago',
  });
  assert.strictEqual(at.toISOString(), '2026-08-16T03:30:00.000Z');
});

test('computeShiftReminderScheduledFor > returns null on unparseable time', () => {
  assert.strictEqual(
    computeShiftReminderScheduledFor({ event_date: '2026-08-15', event_start_time: 'TBD' }),
    null
  );
});

test('scheduleStaffShiftMessages > inserts one shift_reminder and one staff_thank_you for an approved staffer', async () => {
  await seedShift();
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    `SELECT message_type, recipient_type, channel, recipient_id
       FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      ORDER BY message_type`,
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].message_type, 'shift_reminder');
  assert.strictEqual(rows[1].message_type, 'staff_thank_you');
  for (const r of rows) {
    assert.strictEqual(r.recipient_type, 'staff');
    assert.strictEqual(r.channel, 'sms');
    assert.strictEqual(Number(r.recipient_id), TEST_USER_ID_A);
  }
});

test('scheduleStaffShiftMessages > is idempotent (second call inserts nothing)', async () => {
  await seedShift();
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(rows[0].count), 2);
});

test('scheduleStaffShiftMessages > does NOT recreate a terminal failed/suppressed row', async () => {
  await seedShift();
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  await pool.query(
    "UPDATE scheduled_messages SET status = 'failed' WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  await pool.query(
    "UPDATE scheduled_messages SET status = 'suppressed' WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'staff_thank_you'",
    [TEST_SHIFT_ID]
  );
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      ORDER BY message_type, status`,
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows.length, 2);
  const byType = Object.fromEntries(rows.map((r) => [r.message_type, r.status]));
  assert.strictEqual(byType.shift_reminder, 'failed');
  assert.strictEqual(byType.staff_thank_you, 'suppressed');
});

test('scheduleStaffShiftMessages > skips an archived proposal', async () => {
  await seedShift({ status: 'archived' });
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('scheduleStaffShiftMessages > schedules for a second staffer added later', async () => {
  await seedShift();
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')`,
    [TEST_SHIFT_ID, TEST_USER_ID_B]
  );
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    `SELECT recipient_id, count(*) AS n
       FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      GROUP BY recipient_id`,
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows.length, 2);
  for (const r of rows) assert.strictEqual(Number(r.n), 2);
});

test('dispatcher > shift_reminder marks sent for a staffer with a phone', async () => {
  registerStaffShiftHandlers();
  await seedShift();
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Sam', '5555550111')
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, preferred_name = EXCLUDED.preferred_name`,
    [TEST_USER_ID_A]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );

  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows[0].status, 'sent');

  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [TEST_USER_ID_A]);
});

test('dispatcher > shift_reminder marks failed when the staffer has no phone', async () => {
  registerStaffShiftHandlers();
  await seedShift();
  // No contractor_profiles row for staffer A → handler throws "no phone".
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );

  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.ok(rows[0].error_message.includes('no phone'));
});

test('dispatcher > staff_thank_you marks sent for a staffer with a phone', async () => {
  registerStaffShiftHandlers();
  await seedShift();
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Sam', '5555550111')
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, preferred_name = EXCLUDED.preferred_name`,
    [TEST_USER_ID_A]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'shift', 'staff_thank_you', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );

  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'staff_thank_you'",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows[0].status, 'sent');

  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [TEST_USER_ID_A]);
});

test('notifyStaffOfScheduleChange > sends SMS to an assigned staffer with a phone', async () => {
  await seedShift();
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Sam', '5555550144')
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, preferred_name = EXCLUDED.preferred_name`,
    [TEST_USER_ID_A]
  );
  const { notifyStaffOfScheduleChange } = require('./staffShiftHandlers');
  const r = await notifyStaffOfScheduleChange({
    proposalId: TEST_PROPOSAL_ID,
    updated: { event_date: '2026-09-01', event_start_time: '19:00', event_location: 'New Venue' },
    sms: true,
    email: false,
  });
  assert.strictEqual(r.smsSent, 1);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [TEST_USER_ID_A]);
});

test('notifyStaffOfScheduleChange > sends nothing when both channels are off', async () => {
  await seedShift();
  const { notifyStaffOfScheduleChange } = require('./staffShiftHandlers');
  const r = await notifyStaffOfScheduleChange({
    proposalId: TEST_PROPOSAL_ID,
    updated: { event_date: '2026-09-01' },
    sms: false,
    email: false,
  });
  assert.deepStrictEqual(r, { smsSent: 0, emailSent: 0 });
});

test('reanchorStaffShiftMessages > moves a pending shift_reminder to the new event date', async () => {
  await seedShift({ eventDateExpr: "CURRENT_DATE + INTERVAL '60 days'" });
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const before = await pool.query(
    "SELECT scheduled_for FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  const beforeAt = new Date(before.rows[0].scheduled_for).getTime();

  await pool.query(
    "UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '70 days' WHERE id = $1",
    [TEST_PROPOSAL_ID]
  );
  await pool.query(
    "UPDATE shifts SET event_date = CURRENT_DATE + INTERVAL '70 days' WHERE id = $1",
    [TEST_SHIFT_ID]
  );

  const { reanchorStaffShiftMessages } = require('./staffShiftHandlers');
  await reanchorStaffShiftMessages(TEST_PROPOSAL_ID);

  const after = await pool.query(
    "SELECT scheduled_for FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  const afterAt = new Date(after.rows[0].scheduled_for).getTime();
  assert.ok(afterAt - beforeAt > 9 * 86400000 && afterAt - beforeAt < 11 * 86400000,
    `expected ~10-day shift, got ${(afterAt - beforeAt) / 86400000} days`);
});

test('reanchorStaffShiftMessages > schedules a reminder that was skipped because the event time was TBD at assignment', async () => {
  await seedShift({ startTime: '' });

  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const atAssign = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(atAssign.rows[0].count), 0);

  await pool.query(
    "UPDATE proposals SET event_start_time = '18:00' WHERE id = $1",
    [TEST_PROPOSAL_ID]
  );
  await pool.query(
    "UPDATE shifts SET start_time = '18:00' WHERE id = $1",
    [TEST_SHIFT_ID]
  );

  const { reanchorStaffShiftMessages } = require('./staffShiftHandlers');
  await reanchorStaffShiftMessages(TEST_PROPOSAL_ID);

  const after = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      ORDER BY message_type`,
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(after.rows.length, 2);
  const byType = Object.fromEntries(after.rows.map((r) => [r.message_type, r.status]));
  assert.strictEqual(byType.shift_reminder, 'pending');
  assert.strictEqual(byType.staff_thank_you, 'pending');
});
