require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerBalanceSmsHandlers } = require('./balanceSmsHandlers');
const { getHandlerMeta, _clearHandlersForTest, dispatchPending } = require('./scheduledMessageDispatcher');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Balance SMS Test', 'balsms-test@example.com', '3125550160') RETURNING id"
  );
  clientId = c.rows[0].id;
  // Sweep any sms_messages rows this file's message_types leaked from a prior
  // aborted run. sms_messages.twilio_sid carries a partial UNIQUE index
  // (idx_sms_messages_twilio_sid) so a stale 'stub' SID would collide here.
  await pool.query(
    "DELETE FROM sms_messages WHERE message_type IN ('balance_due_today_sms','balance_late_t1_sms','balance_late_t3_sms')"
  );
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days', false)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  // The dispatch test sends through sendAndLogSms, which logs an outbound row
  // to sms_messages. Clean it up by message_type — sms_messages.twilio_sid is
  // partial-UNIQUE, so leaving it would collide on the next run / sibling file.
  await pool.query(
    "DELETE FROM sms_messages WHERE message_type IN ('balance_due_today_sms','balance_late_t1_sms','balance_late_t3_sms')"
  );
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('registerBalanceSmsHandlers > registers three types on balance_due_date with the right offsets', () => {
  _clearHandlersForTest();
  registerBalanceSmsHandlers();
  const today = getHandlerMeta('balance_due_today_sms');
  const t1 = getHandlerMeta('balance_late_t1_sms');
  const t3 = getHandlerMeta('balance_late_t3_sms');
  assert.ok(today && t1 && t3);
  assert.strictEqual(today.anchor, 'balance_due_date');
  assert.strictEqual(today.offsetFromEventDate, 0);
  assert.strictEqual(t1.offsetFromEventDate, 86400);
  assert.strictEqual(t3.offsetFromEventDate, 3 * 86400);
  assert.ok([today, t1, t3].every(m => m.category === 'operational'));
});

test('balance_due_today_sms handler > sends an SMS and marks the row sent', async () => {
  _clearHandlersForTest();
  registerBalanceSmsHandlers();
  const { __setSmsDeps } = require('./sms');
  let body = null;
  // Unique SID per call — sms_messages.twilio_sid is partial-UNIQUE, a constant
  // 'stub' SID collides across tests / runs (mirrors dripSmsHandlers.test.js).
  let sidN = 0;
  __setSmsDeps({ sendSMS: async (args) => { body = args.body; return { sid: `stub-${Date.now()}-${(sidN += 1)}` }; } });
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'balance_due_today_sms', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  await dispatchPending();
  assert.match(body, /due today/);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='balance_due_today_sms'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});

test('balance_late_t3_sms handler > suppresses when balance is already zero', async () => {
  _clearHandlersForTest();
  registerBalanceSmsHandlers();
  // Pay the balance in full so the handler's balance>0 guard fails. A moot
  // reminder to a paid-up client is an expected suppression, not a failure:
  // the row is marked 'suppressed' (no Sentry alert) with the computed balance
  // recorded in the reason, per the SERVER-13 triage.
  await pool.query('UPDATE proposals SET amount_paid = total_price WHERE id = $1', [proposalId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'balance_late_t3_sms', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_id=$1 AND message_type='balance_late_t3_sms'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /balance_not_positive/);
});
