require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerBalanceReminderHandlers } = require('./balanceReminderHandlers');
const { registerHandler, getHandlerMeta, _clearHandlersForTest, dispatchPending } = require('./scheduledMessageDispatcher');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceReminderHandlers.test.js refuses to run against production');
}

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, email_status) VALUES ('Balance Email Test', $1, 'ok') RETURNING id",
    [`balemail-${Date.now()}@example.com`]
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled, token)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party', 1000, 100, CURRENT_DATE + INTERVAL '14 days', false, gen_random_uuid())
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  _clearHandlersForTest();
  registerBalanceReminderHandlers(registerHandler);
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

async function queue(messageType) {
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', $2, 'client', $3, 'email', NOW() - INTERVAL '1 minute')`,
    [proposalId, messageType, clientId]
  );
}
async function rowStatus(messageType) {
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_id=$1 AND message_type=$2", [proposalId, messageType]
  );
  return rows[0];
}

test('registers the five balance email types', () => {
  for (const t of ['balance_reminder_autopay_t3', 'balance_reminder_non_autopay_t3', 'balance_due_today', 'balance_late_t1', 'balance_late_t3']) {
    assert.ok(getHandlerMeta(t), t);
  }
});

test('balance_late_t1 sends (logged only under the test flag) when nothing is in flight', async () => {
  await queue('balance_late_t1');
  await dispatchPending();
  assert.equal((await rowStatus('balance_late_t1')).status, 'sent');
});

test('every balance email defers a day while a bank debit is processing', async () => {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 90000, 'processing', NOW() - INTERVAL '3 days')`,
    [proposalId, `pi_balemail_${Date.now()}`]
  );
  for (const t of ['balance_reminder_non_autopay_t3', 'balance_due_today', 'balance_late_t1', 'balance_late_t3']) {
    await queue(t);
  }
  await dispatchPending();
  for (const t of ['balance_reminder_non_autopay_t3', 'balance_due_today', 'balance_late_t1', 'balance_late_t3']) {
    const r = await rowStatus(t);
    assert.equal(r.status, 'deferred', t);
    assert.equal(r.error_message, 'deferred: payment_in_flight', t);
  }
});

test('a processing row older than 14 days no longer defers', async () => {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 90000, 'processing', NOW() - INTERVAL '15 days')`,
    [proposalId, `pi_balemail_old_${Date.now()}`]
  );
  await queue('balance_late_t3');
  await dispatchPending();
  assert.equal((await rowStatus('balance_late_t3')).status, 'sent');
});

test('a zero balance still suppresses, and suppression wins over an in-flight row', async () => {
  await pool.query('UPDATE proposals SET amount_paid = total_price WHERE id = $1', [proposalId]);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 90000, 'processing', NOW())`,
    [proposalId, `pi_balemail_paid_${Date.now()}`]
  );
  await queue('balance_due_today');
  await dispatchPending();
  const r = await rowStatus('balance_due_today');
  assert.equal(r.status, 'suppressed');
  assert.match(r.error_message, /balance_not_positive/);
});
