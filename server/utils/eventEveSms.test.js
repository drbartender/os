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

test('scheduleEventEve > inserts the sms row AND its email twin at the same instant', async () => {
  // The twin exists so a client who declines SMS still gets the day-before
  // details. Both halves are multiChannel, so whichever channel is dead
  // suppresses and the other delivers; neither is ever substituted into a
  // duplicate of the other.
  _clearHandlersForTest();
  registerEventEveHandler();
  await scheduleEventEve(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel, scheduled_for FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1
     ORDER BY message_type`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(
    rows.map(r => [r.message_type, r.channel]),
    [['event_eve', 'sms'], ['event_eve_email', 'email']]
  );
  assert.strictEqual(
    new Date(rows[0].scheduled_for).getTime(),
    new Date(rows[1].scheduled_for).getTime(),
    'both halves fire at the same T-24h instant'
  );
});

test('registerEventEveHandler > both halves are multiChannel', () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  for (const type of ['event_eve', 'event_eve_email']) {
    const meta = getHandlerMeta(type);
    assert.ok(meta, `${type} is registered`);
    assert.strictEqual(meta.multiChannel, true, `${type} must be multiChannel`);
    assert.strictEqual(meta.cooldownExempt, true);
    assert.strictEqual(meta.priority, 1);
  }
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

test('event_eve pair > an SMS-declining client still gets the email half', async () => {
  // The regression this twin exists to prevent. Before it, sms_enabled:false
  // (now the default for any client who leaves the consent box unchecked)
  // dropped the day-before message entirely: the SMS half suppressed and there
  // was nothing else to deliver.
  _clearHandlersForTest();
  registerEventEveHandler();
  const { __setSmsDeps } = require('./sms');
  __setSmsDeps({
    sendSMS: () => Promise.reject(new Error('SMS must not be attempted for an opted-out client')),
  });

  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(communication_preferences, '{sms_enabled}', 'false'::jsonb)
     WHERE id = $1`, [clientId]);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'event_eve', 'client', $2, 'sms', NOW() - INTERVAL '1 minute'),
            ($1, 'proposal', 'event_eve_email', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  await dispatchPending();

  const { rows } = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
      WHERE entity_id=$1 AND message_type IN ('event_eve','event_eve_email')
      ORDER BY message_type`,
    [proposalId]
  );
  const byType = Object.fromEntries(rows.map(r => [r.message_type, r.status]));
  assert.strictEqual(byType.event_eve, 'suppressed', 'SMS half correctly stands down');
  assert.strictEqual(byType.event_eve_email, 'sent', 'email half still delivers the details');

  // restore
  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(communication_preferences, '{sms_enabled}', 'true'::jsonb)
     WHERE id = $1`, [clientId]);
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});

// B9: reverting the 99fd240 'processing' widening. A reschedule must NOT delete
// a mid-send ('processing') row out from under the dispatcher.
test('scheduleEventEve > a reschedule during a mid-send claim keeps the sent-marker and never queues a duplicate', async () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  // 1. Schedule the initial event_eve row (pending).
  await scheduleEventEve(proposalId);
  // 2. Simulate the dispatcher claiming the row (pending -> processing), exactly
  //    as dispatchRow does (scheduledMessageDispatcher.js claim UPDATE).
  const claim = await pool.query(
    `UPDATE scheduled_messages SET status='processing', claimed_at=NOW()
      WHERE entity_id=$1 AND entity_type='proposal' AND message_type='event_eve' AND status='pending'`,
    [proposalId]
  );
  assert.strictEqual(claim.rowCount, 1, 'the initial pending row was claimed');
  // 3. A reschedule moves the event out.
  await pool.query(
    "UPDATE proposals SET event_date = event_date + INTERVAL '7 days' WHERE id = $1",
    [proposalId]
  );
  // 4. The reschedule cascade re-invokes scheduleEventEve while the send is in flight.
  await scheduleEventEve(proposalId);
  // 5. Simulate the dispatcher's terminal sent-marker (guarded on status='processing').
  const terminal = await pool.query(
    `UPDATE scheduled_messages SET status='sent', sent_at=NOW()
      WHERE entity_id=$1 AND entity_type='proposal' AND message_type='event_eve' AND status='processing'`,
    [proposalId]
  );
  // The in-flight claim must survive the reschedule so its sent-marker lands (HEAD: 0 — deleted).
  assert.strictEqual(terminal.rowCount, 1, 'the surviving processing row was marked sent (claim not deleted)');
  // ...and no duplicate pending row was scheduled for the tuple (HEAD: 1 — the re-insert).
  const pending = await pool.query(
    "SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve' AND status='pending'",
    [proposalId]
  );
  assert.strictEqual(pending.rows[0].n, 0, 'no duplicate pending event_eve row');
  const all = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve'",
    [proposalId]
  );
  assert.strictEqual(all.rows.length, 1, 'exactly one event_eve row total');
  assert.strictEqual(all.rows[0].status, 'sent');
});

// B9: end-to-end race through the real dispatcher. A reschedule fired while the
// dispatcher is mid-send must not double-schedule or lose the send.
test('scheduleEventEve > end-to-end: a reschedule racing a live dispatch sends exactly once, no duplicate queued', async () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  const { __setSmsDeps } = require('./sms');
  let smsCount = 0;
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  let markEntered;
  const entered = new Promise((r) => { markEntered = r; });
  __setSmsDeps({
    sendSMS: async () => { smsCount += 1; markEntered(); await gate; return { sid: `stub-${Date.now()}` }; },
  });
  try {
    // A due event_eve row (mirrors the handler test's insert above).
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
       VALUES ($1, 'proposal', 'event_eve', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
      [proposalId, clientId]
    );
    // Dispatch WITHOUT awaiting; the stub blocks on the gate mid-send (the row is now 'processing').
    const dispatchP = dispatchPending();
    await entered;
    // Reschedule racing the in-flight send.
    await pool.query(
      "UPDATE proposals SET event_date = event_date + INTERVAL '7 days' WHERE id = $1",
      [proposalId]
    );
    await scheduleEventEve(proposalId);
    // Let the send finish.
    releaseGate();
    await dispatchP;
    assert.strictEqual(smsCount, 1, 'exactly one SMS sent across the race');
    const { rows } = await pool.query(
      "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve'",
      [proposalId]
    );
    assert.strictEqual(rows.length, 1, 'exactly one event_eve row total');
    assert.strictEqual(rows[0].status, 'sent', 'the in-flight row was marked sent (HEAD: pending — the queued duplicate)');
    assert.strictEqual(rows.filter((r) => r.status === 'pending').length, 0, 'no duplicate pending row was queued');
  } finally {
    releaseGate();
    __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
  }
});
