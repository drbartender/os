require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerDripSmsHandlers } = require('./dripSmsHandlers');
const { getHandlerMeta, _clearHandlersForTest } = require('./scheduledMessageDispatcher');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Drip SMS Test', 'dripsms-test@example.com', '3125550140') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '120 days', 'sent', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  // The dispatch test sends through sendAndLogSms, which logs an outbound row
  // to sms_messages. Clean it up by message_type — sms_messages.client_id is
  // FK ON DELETE SET NULL, so a client-id filter cannot reach rows orphaned by
  // a prior run's client teardown.
  await pool.query(
    "DELETE FROM sms_messages WHERE message_type IN ('drip_touch_1','drip_touch_3','drip_touch_5_sms')"
  );
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('loadDripSmsContext > suppresses (not fails) when the client has no phone', async () => {
  // Regression for DRBARTENDER-SERVER-V: a client with no phone is an expected
  // skip, not a dispatch failure — the loader throws SuppressMessageError so the
  // dispatcher records the row 'suppressed' without alerting Sentry.
  const { loadDripSmsContext } = require('./dripSmsHandlers');
  const { SuppressMessageError } = require('./errors');
  await pool.query('UPDATE clients SET phone = NULL WHERE id = $1', [clientId]);
  try {
    await assert.rejects(
      () => loadDripSmsContext(proposalId),
      (err) => err instanceof SuppressMessageError && err.reason === 'client_no_phone'
    );
  } finally {
    await pool.query("UPDATE clients SET phone = '3125550140' WHERE id = $1", [clientId]);
  }
});

test('registerDripSmsHandlers > registers the three drip SMS types with marketing category and null offset', () => {
  _clearHandlersForTest();
  registerDripSmsHandlers();
  for (const mt of ['drip_touch_1', 'drip_touch_3', 'drip_touch_5_sms']) {
    const meta = getHandlerMeta(mt);
    assert.ok(meta, `expected meta for ${mt}`);
    assert.strictEqual(meta.category, 'marketing', `${mt} should be marketing`);
    assert.strictEqual(meta.anchor, 'created_at', `${mt} should anchor on created_at`);
    assert.strictEqual(meta.offsetFromEventDate, null, `${mt} should have a null offset`);
  }
});

test('dripSmsHandler > sends an SMS and the dispatcher marks the row sent', async () => {
  _clearHandlersForTest();
  registerDripSmsHandlers();
  // Inject a stub sender so we do not hit Twilio. The stub returns a unique
  // sid per call — sms_messages has a partial unique index on twilio_sid, so a
  // constant sid would collide on a re-run.
  const { __setSmsDeps } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: `stub-${Date.now()}-${smsCalls}` }; } });

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'drip_touch_1', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();

  assert.strictEqual(smsCalls, 1, 'the SMS sender should have been called once');
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='drip_touch_1'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
