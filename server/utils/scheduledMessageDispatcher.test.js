require('dotenv').config();
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  registerHandler,
  _clearHandlersForTest,
  dispatchPending,
} = require('./scheduledMessageDispatcher');

// Use unique-per-test client/proposal IDs so we don't collide with real data.
// Setup: create a throwaway client + proposal once, reuse across tests.
let testClientId;
let testProposalId;

before(async () => {
  // proposals has NO client_name / client_email columns — those live on `clients`
  // and are joined via proposals.client_id. We create the clients row first, then
  // the proposals row. `clients` has no UNIQUE constraint on email, so we look up
  // any existing test row before inserting to avoid orphaning rows across runs.
  const existing = await pool.query(
    "SELECT id FROM clients WHERE email = 'dispatcher-test@example.com' LIMIT 1"
  );
  if (existing.rowCount > 0) {
    testClientId = existing.rows[0].id;
  } else {
    const c = await pool.query(
      `INSERT INTO clients (name, email, phone) VALUES ('Dispatcher Test', 'dispatcher-test@example.com', '5555550100')
       RETURNING id`
    );
    testClientId = c.rows[0].id;
  }
  // proposals.token is UUID with default gen_random_uuid() — omit it so the
  // default fires (a string literal would error with `invalid input syntax for
  // type uuid`).
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, amount_paid, balance_due_date)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + INTERVAL '30 days', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days')
     RETURNING id`,
    [testClientId]
  );
  testProposalId = p.rows[0].id;
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'disp_test_%'");
  await pool.query('DELETE FROM proposals WHERE id = $1', [testProposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [testClientId]);
  await pool.end();
});

beforeEach(async () => {
  _clearHandlersForTest();
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'disp_test_%'");
});

test('dispatcher > calls the registered handler and marks status sent', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_simple', handler);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_simple', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_simple'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});

test('dispatcher > marks status failed when handler throws and stores the error', async () => {
  registerHandler('disp_test_throws', async () => { throw new Error('handler boom'); });

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_throws', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_throws'"
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.ok(rows[0].error_message.includes('handler boom'));
});

test('dispatcher > marks status suppressed when proposal is archived', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_archived', handler);

  await pool.query("UPDATE proposals SET status = 'archived', archive_reason = 'client_cancelled' WHERE id = $1", [testProposalId]);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_archived', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_archived'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /archived/i);

  // restore for the next tests
  await pool.query("UPDATE proposals SET status = 'deposit_paid', archive_reason = NULL WHERE id = $1", [testProposalId]);
});

test('dispatcher > marks status suppressed when client has email_enabled=false', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_optout', handler);

  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{email_enabled}', 'false'::jsonb) WHERE id = $1`,
    [testClientId]
  );

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_optout', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_optout'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /email_enabled/);

  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{email_enabled}', 'true'::jsonb) WHERE id = $1`,
    [testClientId]
  );
});

test('dispatcher > marks status suppressed when client.email_status is bad', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_bademail', handler);

  await pool.query("UPDATE clients SET email_status = 'bad' WHERE id = $1", [testClientId]);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_bademail', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_bademail'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /email_status/);

  await pool.query("UPDATE clients SET email_status = 'ok' WHERE id = $1", [testClientId]);
});

test('dispatcher > skips rows whose scheduled_for is in the future', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_future', handler);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_future', 'client', $2, 'email', NOW() + INTERVAL '1 hour')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_future'"
  );
  assert.strictEqual(rows[0].status, 'pending');
});

test('dispatcher > marks failed with "no handler registered" when handler is missing', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_nohandler', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_nohandler'"
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error_message, /no handler/i);
});

test('dispatcher > suppresses marketing-category handler when marketing_enabled=false', async () => {
  // Gemini Finding 5: marketing-category messages are gated on
  // communication_preferences.marketing_enabled. Operational messages bypass
  // this gate; marketing messages flip to 'suppressed' with reason
  // 'marketing_disabled'. Plan 2d's drip touches register with
  // category='marketing'; we simulate that here.
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_marketing', handler, { category: 'marketing', anchor: 'created_at', offsetFromEventDate: null });

  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{marketing_enabled}', 'false'::jsonb) WHERE id = $1`,
    [testClientId]
  );

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_marketing', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_marketing'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /marketing_disabled/);

  // restore
  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{marketing_enabled}', 'true'::jsonb) WHERE id = $1`,
    [testClientId]
  );
});
