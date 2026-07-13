require('dotenv').config();
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { scheduleMessage } = require('./messageScheduling');

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'test_%'");
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'test_%'");
  await pool.end();
});

test('messageScheduling > inserts a new pending row', async () => {
  const row = await scheduleMessage({
    entityType: 'proposal',
    entityId: 12345,
    messageType: 'test_balance_t3',
    recipientType: 'client',
    recipientId: 999,
    channel: 'email',
    scheduledFor: new Date(Date.now() + 24 * 3600 * 1000),
  });
  assert.ok(row);
  assert.ok(row.id > 0);
  assert.strictEqual(row.status, 'pending');

  const check = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE message_type = 'test_balance_t3' AND entity_id = 12345 AND status = 'pending'"
  );
  assert.strictEqual(Number(check.rows[0].count), 1);
});

test('messageScheduling > returns null on duplicate enrollment for the same pending tuple', async () => {
  const args = {
    entityType: 'proposal',
    entityId: 12346,
    messageType: 'test_dup',
    recipientType: 'client',
    recipientId: 888,
    channel: 'email',
    scheduledFor: new Date(Date.now() + 24 * 3600 * 1000),
  };
  const first = await scheduleMessage(args);
  assert.ok(first);
  const second = await scheduleMessage(args);
  assert.strictEqual(second, null);

  const check = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE message_type = 'test_dup' AND entity_id = 12346 AND status = 'pending'"
  );
  assert.strictEqual(Number(check.rows[0].count), 1);
});

test('messageScheduling > allows re-scheduling after the prior row moves out of pending', async () => {
  const args = {
    entityType: 'proposal',
    entityId: 12347,
    messageType: 'test_reschedule',
    recipientType: 'client',
    recipientId: 777,
    channel: 'email',
    scheduledFor: new Date(Date.now() + 24 * 3600 * 1000),
  };
  const first = await scheduleMessage(args);
  await pool.query("UPDATE scheduled_messages SET status = 'sent', sent_at = NOW() WHERE id = $1", [first.id]);

  const second = await scheduleMessage(args);
  assert.ok(second);
  assert.notStrictEqual(second.id, first.id);
});

test('messageScheduling > rejects an invalid channel before hitting the constraint', async () => {
  await assert.rejects(
    () => scheduleMessage({
      entityType: 'proposal',
      entityId: 12348,
      messageType: 'test_bad_channel',
      recipientType: 'client',
      recipientId: 555,
      channel: 'fax',
      scheduledFor: new Date(),
    }),
    /channel/i
  );
});

// ─── enqueueCategorizedMessage tests (Phase 1 Task 4) ───
const { enqueueCategorizedMessage } = require('./messageScheduling');
const bcrypt = require('bcryptjs');

let categorizedTestUserId;

test('enqueueCategorizedMessage > test fixtures setup', async () => {
  const passwordHash = await bcrypt.hash('test', 4);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, $2, 'staff', 'approved') RETURNING id`,
    [`enqueue-test-${Date.now()}@example.com`, passwordHash]
  );
  categorizedTestUserId = rows[0].id;
});

test('enqueueCategorizedMessage > fans out one row per resolved channel', async () => {
  // Default staff_notification_preferences ships shift_offered = push+sms+email
  const result = await enqueueCategorizedMessage({
    userId: categorizedTestUserId,
    category: 'shift_offered',
    payload: { title: 'New shift', body: 'body', url: '/shifts/1' },
    sendAt: new Date(Date.now() + 60_000),
    entityType: 'shift',
    entityId: 99001,
    messageType: 'test_categorized_fanout',
  });
  assert.strictEqual(result.deadLetter, false);
  assert.strictEqual(result.enqueued.length, 3, 'expected three rows (push+sms+email)');

  const { rows } = await pool.query(
    `SELECT channel, suppression_key, payload->'re_resolve_count' AS rc
       FROM scheduled_messages WHERE id = ANY($1::int[]) ORDER BY channel`,
    [result.enqueued]
  );
  assert.strictEqual(rows.length, 3);
  assert.deepEqual(rows.map(r => r.channel).sort(), ['email', 'push', 'sms']);
  // All rows share the same suppression_key
  const keys = new Set(rows.map(r => r.suppression_key));
  assert.strictEqual(keys.size, 1);
  assert.strictEqual([...keys][0], `shift:99001:test_categorized_fanout:${categorizedTestUserId}`);
  // re_resolve_count seeded to 0 in payload
  rows.forEach(r => assert.strictEqual(Number(r.rc), 0));
});

test('enqueueCategorizedMessage > deadLetter return for critical category with all channels blocked', async () => {
  // Mute everything for this user + flip comms-prefs off (no push subs by default)
  await pool.query(
    `UPDATE users SET
        staff_notification_preferences = jsonb_set(
          staff_notification_preferences,
          '{channels,beo_finalized}', '[]'::jsonb, true),
        communication_preferences = (
          COALESCE(communication_preferences, '{}'::jsonb)
          || '{"sms_enabled":false,"email_enabled":false}'::jsonb)
      WHERE id = $1`,
    [categorizedTestUserId]
  );
  const result = await enqueueCategorizedMessage({
    userId: categorizedTestUserId,
    category: 'beo_finalized',
    payload: { title: 'BEO ready' },
    sendAt: new Date(),
    entityType: 'shift',
    entityId: 99002,
    messageType: 'test_dead_letter_beo',
  });
  assert.deepEqual(result, { enqueued: [], deadLetter: true });
});

test('enqueueCategorizedMessage > empty for non-critical category with no opted channels', async () => {
  // tip_received default is ['push'], with no push subs and no critical override
  await pool.query(
    `UPDATE users SET
        staff_notification_preferences = jsonb_set(
          jsonb_set(staff_notification_preferences,
                    '{channels,tip_received}', '[]'::jsonb, true),
          '{push_subscriptions}', '[]'::jsonb, true)
      WHERE id = $1`,
    [categorizedTestUserId]
  );
  const result = await enqueueCategorizedMessage({
    userId: categorizedTestUserId,
    category: 'tip_received',
    payload: { title: 'New tip' },
    sendAt: new Date(),
    entityType: 'shift',
    entityId: 99003,
    messageType: 'test_empty_no_channels',
  });
  assert.deepEqual(result, { enqueued: [], deadLetter: false });
});

test('enqueueCategorizedMessage > cleanup test users', async () => {
  await pool.query(
    `DELETE FROM scheduled_messages WHERE message_type LIKE 'test_categorized_%' OR message_type LIKE 'test_dead_letter_%' OR message_type LIKE 'test_empty_%'`
  );
  await pool.query('DELETE FROM users WHERE id = $1', [categorizedTestUserId]);
});

test('messageScheduling > push channel now accepted (no longer thrown)', async () => {
  // The prior VALID_CHANNELS rejected 'push'; widening accepts it.
  // We expect the underlying CHECK to also accept now.
  const row = await scheduleMessage({
    entityType: 'shift',
    entityId: 99099,
    messageType: 'test_push_accept',
    recipientType: 'staff',
    recipientId: 1,
    channel: 'push',
    scheduledFor: new Date(Date.now() + 60_000),
  });
  // Row may be null if the (entity, recipient_id=1, channel='push', message_type=test_push_accept)
  // tuple already had a pending row from a prior run; either way no throw.
  if (row) {
    await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [row.id]);
  } else {
    await pool.query(
      `DELETE FROM scheduled_messages WHERE message_type = 'test_push_accept'`
    );
  }
});
