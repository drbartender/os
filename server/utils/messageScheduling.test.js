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
