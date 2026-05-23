require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { suspendClientAutomation } = require('./clientAutomationSuspension');

let testClientId;
let testProposalId;

before(async () => {
  const existing = await pool.query(
    "SELECT id FROM clients WHERE email = 'suspend-test@example.com' LIMIT 1"
  );
  if (existing.rowCount > 0) {
    testClientId = existing.rows[0].id;
  } else {
    const c = await pool.query(
      `INSERT INTO clients (name, email, phone) VALUES ('Suspend Test', 'suspend-test@example.com', '5555550188')
       RETURNING id`
    );
    testClientId = c.rows[0].id;
  }
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, amount_paid, balance_due_date)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + INTERVAL '30 days', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days')
     RETURNING id`,
    [testClientId]
  );
  testProposalId = p.rows[0].id;
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'suspend_test_%'");
  await pool.query('DELETE FROM proposals WHERE id = $1', [testProposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [testClientId]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'suspend_test_%'");
});

test('suspendClientAutomation > suppresses every pending row for the client', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'suspend_test_a', 'client', $2, 'email', NOW() + INTERVAL '1 day'),
            ($1, 'proposal', 'suspend_test_b', 'client', $2, 'sms', NOW() + INTERVAL '2 days')`,
    [testProposalId, testClientId]
  );

  const count = await suspendClientAutomation(testClientId);
  assert.strictEqual(count, 2);

  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type LIKE 'suspend_test_%' ORDER BY message_type"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.strictEqual(rows[1].status, 'suppressed');
});

test('suspendClientAutomation > leaves already-sent rows untouched', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ($1, 'proposal', 'suspend_test_sent', 'client', $2, 'email', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 'sent')`,
    [testProposalId, testClientId]
  );

  await suspendClientAutomation(testClientId);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'suspend_test_sent'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});
