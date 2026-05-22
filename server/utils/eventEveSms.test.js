require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerEventEveHandler, scheduleEventEve, computeEventEveSendAt } = require('./eventEveSms');
const { getHandlerMeta, _clearHandlersForTest, dispatchPending } = require('./scheduledMessageDispatcher');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('EventEve Test', 'eventeve-test@example.com', '3125550180') RETURNING id"
  );
  clientId = c.rows[0].id;
  await pool.query("DELETE FROM sms_messages WHERE message_type = 'event_eve'");
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_location, status, event_type, event_timezone, setup_minutes_before)
     VALUES ($1, CURRENT_DATE + INTERVAL '40 days', '18:00', '123 Main St', 'deposit_paid', 'birthday-party', 'America/Chicago', 60)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query("DELETE FROM sms_messages WHERE message_type = 'event_eve'");
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('registerEventEveHandler > registers event_eve operational with a null offset', () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  const meta = getHandlerMeta('event_eve');
  assert.ok(meta);
  assert.strictEqual(meta.category, 'operational');
  assert.strictEqual(meta.offsetFromEventDate, null);
});

test('computeEventEveSendAt > returns the event start instant minus 24h in event TZ', () => {
  const sendAt = computeEventEveSendAt({
    event_date: '2026-08-15',
    event_start_time: '18:00',
    event_timezone: 'America/Chicago',
  });
  // 2026-08-15 18:00 CDT == 2026-08-15 23:00 UTC. Minus 24h == 2026-08-14 23:00 UTC.
  assert.strictEqual(sendAt.toISOString(), '2026-08-14T23:00:00.000Z');
});

test('scheduleEventEve > inserts one event_eve sms row', async () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  await scheduleEventEve(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].message_type, 'event_eve');
  assert.strictEqual(rows[0].channel, 'sms');
});

test('scheduleEventEve > re-run deletes the stale pending row and re-inserts (reschedule path)', async () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  await scheduleEventEve(proposalId);
  const before = await pool.query(
    "SELECT scheduled_for FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve'",
    [proposalId]
  );
  await pool.query(
    "UPDATE proposals SET event_date = event_date + INTERVAL '7 days' WHERE id = $1",
    [proposalId]
  );
  await scheduleEventEve(proposalId);
  const after = await pool.query(
    "SELECT scheduled_for FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve' AND status='pending'",
    [proposalId]
  );
  assert.strictEqual(after.rows.length, 1, 'still exactly one pending row');
  assert.notStrictEqual(
    new Date(before.rows[0].scheduled_for).getTime(),
    new Date(after.rows[0].scheduled_for).getTime(),
    'scheduled_for should have moved'
  );
});

test('event_eve handler > sends an SMS even with no bartender assigned', async () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  const { __setSmsDeps } = require('./sms');
  let sidN = 0;
  let body = null;
  __setSmsDeps({ sendSMS: async (args) => { body = args.body; return { sid: `stub-${Date.now()}-${(sidN += 1)}` }; } });
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'event_eve', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  await dispatchPending();
  assert.ok(body, 'an SMS body should have been produced');
  assert.match(body, /tomorrow/);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
