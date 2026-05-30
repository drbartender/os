require('dotenv').config();
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  registerHandler,
  getHandlerMeta,
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
  // pool.end() moved to the trailing after() block at the bottom of this file
  // (Phase 2 Task 7) so the appended push/cascade tests can still use the pool
  // in their cleanup. node:test runs after() hooks in registration order.
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

test('dispatcher > suppresses when the client has opted out of both channels', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_optout', handler);

  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(jsonb_set(communication_preferences, '{email_enabled}', 'false'::jsonb), '{sms_enabled}', 'false'::jsonb)
     WHERE id = $1`,
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
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_optout'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');

  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(jsonb_set(communication_preferences, '{email_enabled}', 'true'::jsonb), '{sms_enabled}', 'true'::jsonb)
     WHERE id = $1`,
    [testClientId]
  );
});

test('dispatcher > suppresses when both email_status and phone_status are bad', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_bademail', handler);

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'bad' WHERE id = $1", [testClientId]);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_bademail', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_bademail'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');

  await pool.query("UPDATE clients SET email_status = 'ok', phone_status = 'ok' WHERE id = $1", [testClientId]);
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

test('dispatcher > marks failed with "lookup failed" when entity_id does not exist', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_missing_entity', handler, { anchor: 'created_at', offsetFromEventDate: null });

  // Negative entity_id is guaranteed to never collide with a real proposal
  // (SERIAL ids are positive). lookupEntity returns null, dispatchRow marks
  // the row failed BEFORE calling checkSuppression or the handler.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_missing_entity', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [-999999999, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_missing_entity'"
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error_message, /lookup failed.*entity=false/);
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

test('dispatcher > skips a concurrent tick while a prior dispatch is still in flight', async () => {
  // Reproduces the overlap bug: dispatchPending is fired on a 5-min setInterval;
  // if one run overruns the interval, the next tick re-SELECTs rows the prior
  // run has sent-but-not-yet-marked and sends them again. A handler that blocks
  // on a gate lets us hold one run "in flight" and fire a second, overlapping one.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = mock.fn(async () => { await gate; });
  registerHandler('disp_test_reentrancy', handler);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_reentrancy', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  // First run — not awaited; it parks inside the handler.
  const first = dispatchPending();
  const enterDeadline = Date.now() + 3000;
  while (handler.mock.callCount() === 0 && Date.now() < enterDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(handler.mock.callCount(), 1, 'first run should have entered the handler');

  // Second run fires while the first is still parked. The re-entrancy guard must
  // return it immediately without re-selecting the still-'pending' row. Unguarded,
  // it re-enters the handler (callCount -> 2) and blocks on the gate.
  const second = dispatchPending();
  let secondReturned = false;
  second.then(() => { secondReturned = true; });
  const settleDeadline = Date.now() + 3000;
  while (!secondReturned && handler.mock.callCount() < 2 && Date.now() < settleDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.strictEqual(handler.mock.callCount(), 1, 'concurrent tick must not re-dispatch the row');
  assert.ok(secondReturned, 'guarded tick should return immediately, not block on the handler');

  release();
  await Promise.all([first, second]);

  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_reentrancy'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});

test('dispatcher > suppresses a staff SMS row when staff sms_enabled is false', async () => {
  registerHandler('disp_test_staff_sms', async () => { throw new Error('should not send'); });

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, communication_preferences)
     VALUES ('disp-staff-optout@example.com', 'x', 'staff',
             '{"sms_enabled":false,"email_enabled":true,"marketing_enabled":true}'::jsonb)
     RETURNING id`
  );
  const staffUserId = u.rows[0].id;

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_staff_sms', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [testProposalId, staffUserId]
  );

  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_staff_sms'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.ok(rows[0].error_message.includes('sms_enabled is false'));

  await pool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
});

test('dispatcher > suppresses a staff shift row when its linked proposal is archived', async () => {
  registerHandler('disp_test_shift_archived', async () => { throw new Error('should not send'); });

  const ARCH_PROPOSAL_ID = -7601;
  const ARCH_SHIFT_ID = -7602;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('disp-shift-arch-staff@example.com', 'x', 'staff')
     RETURNING id`
  );
  const staffUserId = u.rows[0].id;
  try {
    await pool.query(
      `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_duration_hours, event_timezone, event_type)
       VALUES ($1, $2, 'archived', CURRENT_DATE + INTERVAL '30 days', '18:00', 4, 'America/Chicago', 'birthday-party')`,
      [ARCH_PROPOSAL_ID, testClientId]
    );
    await pool.query(
      `INSERT INTO shifts (id, proposal_id, event_date, start_time, positions_needed, status)
       VALUES ($1, $2, CURRENT_DATE + INTERVAL '30 days', '18:00', '["Bartender"]', 'open')`,
      [ARCH_SHIFT_ID, ARCH_PROPOSAL_ID]
    );
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
       VALUES ($1, 'shift', 'disp_test_shift_archived', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
      [ARCH_SHIFT_ID, staffUserId]
    );

    await dispatchPending();

    const { rows } = await pool.query(
      "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_shift_archived'"
    );
    assert.strictEqual(rows[0].status, 'suppressed');
    assert.ok(rows[0].error_message.includes('archived'));
  } finally {
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [ARCH_SHIFT_ID]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [ARCH_SHIFT_ID]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [ARCH_PROPOSAL_ID]);
    await pool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
  }
});

test('registerHandler > stores priority, cooldownExempt, and multiChannel in handler meta', () => {
  registerHandler('disp_test_meta_pri', async () => {}, {
    priority: 2,
    cooldownExempt: true,
    multiChannel: true,
    offsetFromEventDate: null,
  });
  const meta = getHandlerMeta('disp_test_meta_pri');
  assert.strictEqual(meta.priority, 2);
  assert.strictEqual(meta.cooldownExempt, true);
  assert.strictEqual(meta.multiChannel, true);
});

test('registerHandler > defaults priority to 3, cooldownExempt and multiChannel to false', () => {
  registerHandler('disp_test_meta_default', async () => {});
  const meta = getHandlerMeta('disp_test_meta_default');
  assert.strictEqual(meta.priority, 3);
  assert.strictEqual(meta.cooldownExempt, false);
  assert.strictEqual(meta.multiChannel, false);
});

test('registerHandler > rejects an out-of-range priority', () => {
  assert.throws(
    () => registerHandler('disp_test_meta_bad', async () => {}, { priority: 9 }),
    /priority/
  );
});

test('registerHandler > coerces a non-true multiChannel value to false', () => {
  registerHandler('disp_test_meta_mc', async () => {}, { multiChannel: 'yes' });
  const meta = getHandlerMeta('disp_test_meta_mc');
  assert.strictEqual(meta.multiChannel, false);
});

test('checkSuppression is exported', () => {
  // CC-import: the wrap-up preview UI calls checkSuppression directly to
  // decide whether to render a "this message would be suppressed" badge
  // without actually mutating any rows. Keep the export contract.
  const dispatcher = require('./scheduledMessageDispatcher');
  assert.strictEqual(typeof dispatcher.checkSuppression, 'function');
});

test('overlap > defers a lower-priority touch when a higher-priority one already fired today', async () => {
  // A priority-1 balance reminder already sent 1 hour ago. A priority-4 drip
  // touch on the same client+channel today must be deferred, not sent.
  registerHandler('disp_test_hi', async () => {}, { priority: 1 });
  registerHandler('disp_test_lo', mock.fn(async () => {}), { priority: 4 });

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ($1, 'proposal', 'disp_test_hi', 'client', $2, 'email', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 'sent')`,
    [testProposalId, testClientId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_lo', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_lo'"
  );
  assert.strictEqual(rows[0].status, 'deferred');
});

test('overlap > a cooldownExempt touch fires even when another touch already fired today', async () => {
  const exemptHandler = mock.fn(async () => {});
  registerHandler('disp_test_exempt', exemptHandler, { priority: 1, cooldownExempt: true });

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ($1, 'proposal', 'disp_test_other', 'client', $2, 'email', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours', 'sent')`,
    [testProposalId, testClientId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_exempt', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(exemptHandler.mock.callCount(), 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_exempt'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});

test('overlap > does not defer when the prior touch is on a different channel', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_otherchan', handler, { priority: 4 });

  // Prior sent touch on SMS; current touch on email, different channel, no collision.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ($1, 'proposal', 'disp_test_smsprior', 'client', $2, 'sms', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 'sent')`,
    [testProposalId, testClientId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_otherchan', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_otherchan'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});

test('overlap > within one tick, the higher-priority touch fires and the lower-priority one defers even when the lower-priority one has the earlier scheduled_for', async () => {
  // Two same-client same-channel rows due in the SAME tick. Lower-priority
  // (4) has EARLIER scheduled_for, so naive ASC dispatch would send it first.
  // It would claim the channel. Then priority-1, being strictly higher, would
  // bypass cooldown and ALSO send, a double-send. The in-memory priority sort
  // must dispatch the priority-1 row first so the priority-4 row finds a sent
  // collision and defers.
  const hiHandler = mock.fn(async () => {});
  const loHandler = mock.fn(async () => {});
  registerHandler('disp_test_tick_hi', hiHandler, { priority: 1 });
  registerHandler('disp_test_tick_lo', loHandler, { priority: 4 });

  // Lower-priority row: earlier scheduled_for (5 minutes ago).
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_tick_lo', 'client', $2, 'email', NOW() - INTERVAL '5 minutes')`,
    [testProposalId, testClientId]
  );
  // Higher-priority row: later scheduled_for (1 minute ago) but still due.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_tick_hi', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(hiHandler.mock.callCount(), 1, 'priority-1 touch sent');
  assert.strictEqual(loHandler.mock.callCount(), 0, 'priority-4 touch deferred, handler never ran');
  const hi = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_tick_hi'"
  );
  const lo = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_tick_lo'"
  );
  assert.strictEqual(hi.rows[0].status, 'sent');
  assert.strictEqual(lo.rows[0].status, 'deferred');
});

test('retrofit > priority and multiChannel landed on the 14 existing handler registrations', async () => {
  // Marketing + pre-event handlers: re-register via their exported functions
  // (they write into the instance this file imported at its top).
  // eslint-disable-next-line global-require
  require('./preEventHandlers').registerAll();
  // eslint-disable-next-line global-require
  require('./marketingHandlers').registerMarketingHandlers();

  // Phase 4b flags exactly one marketing-side existing handler as multiChannel:
  // drip_touch_5_email (the +21d drip pair's email half). The other 8
  // marketing/pre-event handlers stay single-channel.
  assert.strictEqual(getHandlerMeta('drip_touch_5_email').multiChannel, true);
  for (const mt of [
    'event_week_reminder', 'long_lead_t30_recap', 'review_request',
    'drip_touch_2', 'drip_touch_4', 'new_year_hello', 'six_months_out', 'retention_nudge',
  ]) {
    const meta = getHandlerMeta(mt);
    assert.ok(meta, `${mt} is registered`);
    assert.strictEqual(meta.multiChannel, false, `${mt} stays single-channel`);
  }
  // Priority retrofit spot-check across the tiers, marketing/pre-event side.
  assert.strictEqual(getHandlerMeta('event_week_reminder').priority, 3);
  assert.strictEqual(getHandlerMeta('review_request').priority, 3);
  assert.strictEqual(getHandlerMeta('drip_touch_2').priority, 4);
  assert.strictEqual(getHandlerMeta('drip_touch_5_email').priority, 4);
  assert.strictEqual(getHandlerMeta('retention_nudge').priority, 5);

  // The five balance handlers register only at module-load of the dispatcher.
  // Re-require it with the cache cleared so the module body re-runs and those
  // five registerHandler calls re-execute against the fresh instance's own
  // registry. Read them via the fresh instance's getHandlerMeta.
  const dispatcherPath = require.resolve('./scheduledMessageDispatcher');
  delete require.cache[dispatcherPath];
  // eslint-disable-next-line global-require
  const fresh = require('./scheduledMessageDispatcher');
  // Of the five, three gain an SMS sibling in Phase 3 -> multiChannel:true; the
  // two T-3 reminders are email-only and stay single-channel.
  for (const mt of ['balance_due_today', 'balance_late_t1', 'balance_late_t3']) {
    assert.strictEqual(fresh.getHandlerMeta(mt).multiChannel, true, `${mt} is multiChannel`);
  }
  for (const mt of ['balance_reminder_autopay_t3', 'balance_reminder_non_autopay_t3']) {
    assert.strictEqual(fresh.getHandlerMeta(mt).multiChannel, false, `${mt} stays single-channel`);
  }
  assert.strictEqual(fresh.getHandlerMeta('balance_due_today').priority, 1);
  assert.strictEqual(fresh.getHandlerMeta('balance_due_today').cooldownExempt, true);
  assert.strictEqual(fresh.getHandlerMeta('balance_reminder_autopay_t3').priority, 1);
  assert.strictEqual(fresh.getHandlerMeta('balance_late_t1').priority, 2);
  assert.strictEqual(fresh.getHandlerMeta('balance_late_t3').priority, 2);

  // Restore the original cached dispatcher instance so the rest of the suite
  // whose top-of-file destructured imports point at the original is
  // unaffected. (This is the last test in the file, but restoring keeps the
  // cache honest if tests are later appended.)
  delete require.cache[dispatcherPath];
  // eslint-disable-next-line global-require
  require('./scheduledMessageDispatcher');
});

test('overlap > a deferred row whose new time is due is reactivated and dispatched', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_reactivate', handler, { priority: 4 });

  // A deferred row whose (already-bumped) scheduled_for is now in the past and
  // has no colliding sent touch. The next tick should reactivate and send it.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, error_message)
     VALUES ($1, 'proposal', 'disp_test_reactivate', 'client', $2, 'email', NOW() - INTERVAL '5 minutes', 'deferred', 'deferred: daily per-channel cooldown (spec 7.4)')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_reactivate'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});

test('delivery > substitutes the channel when the primary channel is bad', async () => {
  // email_status='bad', operational touch on email: row's channel is rewritten
  // to 'sms' and the handler runs (the handler sees scheduledMessage.channel = 'sms').
  let seenChannel = null;
  registerHandler('disp_test_subst', async ({ scheduledMessage }) => {
    seenChannel = scheduledMessage.channel;
  }, { priority: 1, category: 'operational' });

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'ok' WHERE id = $1", [testClientId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_subst', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, channel FROM scheduled_messages WHERE message_type = 'disp_test_subst'"
  );
  assert.strictEqual(rows[0].status, 'sent');
  assert.strictEqual(rows[0].channel, 'sms');
  assert.strictEqual(seenChannel, 'sms');

  await pool.query("UPDATE clients SET email_status = 'ok' WHERE id = $1", [testClientId]);
});

test('delivery > a multiChannel row whose own channel is bad is suppressed, never substituted', async () => {
  // A multiChannel touch is scheduled as both an email row and an SMS row.
  // Spec 7.3: no substitution. With email_status='bad' but SMS fine, a
  // SINGLE-channel email row would substitute to SMS; a multiChannel email row
  // must instead SUPPRESS (channel stays 'email', handler never runs) so it
  // does not duplicate the paired SMS row on the live channel.
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_multichan', handler, {
    priority: 2, category: 'operational', multiChannel: true,
  });

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'ok' WHERE id = $1", [testClientId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_multichan', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0, 'multiChannel row never reaches its handler');
  const { rows } = await pool.query(
    "SELECT status, channel FROM scheduled_messages WHERE message_type = 'disp_test_multichan'"
  );
  assert.strictEqual(rows[0].status, 'suppressed', 'suppressed, not sent');
  assert.strictEqual(rows[0].channel, 'email', 'channel was NOT rewritten to sms');

  await pool.query("UPDATE clients SET email_status = 'ok' WHERE id = $1", [testClientId]);
});

test('delivery > suspends client automation when both channels are bad', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_bothbad', handler, { priority: 1, category: 'operational' });

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'bad' WHERE id = $1", [testClientId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_bothbad', 'client', $2, 'email', NOW() - INTERVAL '1 minute'),
            ($1, 'proposal', 'disp_test_bothbad_future', 'client', $2, 'sms', NOW() + INTERVAL '5 days')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT message_type, status FROM scheduled_messages WHERE message_type LIKE 'disp_test_bothbad%' ORDER BY message_type"
  );
  // Both the due row and the future row are suppressed by the suspension cascade.
  assert.strictEqual(rows.find(r => r.message_type === 'disp_test_bothbad').status, 'suppressed');
  assert.strictEqual(rows.find(r => r.message_type === 'disp_test_bothbad_future').status, 'suppressed');

  await pool.query("UPDATE clients SET email_status = 'ok', phone_status = 'ok' WHERE id = $1", [testClientId]);
});

test('delivery > mid-batch suppression does not double-process a second row for the same client', async () => {
  // Two operational single-channel rows for the same both-bad client, due in
  // the same tick. The first to dispatch hits the both-bad path: it suppresses
  // itself and suspendClientAutomation flips the second row to 'suppressed'.
  // The stale-row guard must skip the second row so resolveDelivery's both-bad
  // branch (and its admin alert) runs only once.
  const handlerA = mock.fn(async () => {});
  const handlerB = mock.fn(async () => {});
  registerHandler('disp_test_midbatch_a', handlerA, { priority: 1, category: 'operational' });
  registerHandler('disp_test_midbatch_b', handlerB, { priority: 2, category: 'operational' });

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'bad' WHERE id = $1", [testClientId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_midbatch_a', 'client', $2, 'email', NOW() - INTERVAL '2 minutes'),
            ($1, 'proposal', 'disp_test_midbatch_b', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();

  assert.strictEqual(handlerA.mock.callCount(), 0, 'both-bad row A never reaches its handler');
  assert.strictEqual(handlerB.mock.callCount(), 0, 'row B never reaches its handler');
  const { rows } = await pool.query(
    `SELECT message_type, status, error_message FROM scheduled_messages
      WHERE message_type LIKE 'disp_test_midbatch_%' ORDER BY message_type`
  );
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every(r => r.status === 'suppressed'), 'both rows suppressed');
  // Exactly one row was suppressed by the suspension CASCADE ('suspended:'
  // prefix) and never re-processed. If the guard were missing, resolveDelivery
  // would re-run on row B and overwrite that message with 'suppressed:',
  // dropping the count to zero.
  const cascadeSuppressed = rows.filter(
    r => r.error_message && r.error_message.startsWith('suspended:')
  );
  assert.strictEqual(cascadeSuppressed.length, 1, 'row B keeps its cascade message, never re-processed');
  // And exactly one row ran resolveDelivery's both-bad branch ('suppressed:'
  // prefix with the no-working-channel reason).
  const branchSuppressed = rows.filter(
    r => r.error_message && r.error_message.startsWith('suppressed: no working contact channel')
  );
  assert.strictEqual(branchSuppressed.length, 1, 'the both-bad branch ran exactly once');

  await pool.query("UPDATE clients SET email_status = 'ok', phone_status = 'ok' WHERE id = $1", [testClientId]);
});


// ─── Phase 2 Task 7: push + sibling cascade + re-resolve ────────────────
const pushSender = require('./pushSender');
const sms = require('./sms');
const bcrypt = require('bcryptjs');

let pushTestUserId;

before(async () => {
  const passwordHash = await bcrypt.hash('test', 4);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, notifications_opt_in)
     VALUES ($1, $2, 'staff', 'approved', true) RETURNING id`,
    [`push-dispatcher-test-${Date.now()}@example.com`, passwordHash]
  );
  pushTestUserId = rows[0].id;
});

after(async () => {
  if (pushTestUserId) {
    await pool.query('DELETE FROM scheduled_messages WHERE recipient_id = $1 AND recipient_type = $2', [pushTestUserId, 'staff']);
    await pool.query('DELETE FROM users WHERE id = $1', [pushTestUserId]);
  }
  await pool.end();
});

async function setPushSubs(subs) {
  await pool.query(
    `UPDATE users SET staff_notification_preferences = jsonb_set(
       staff_notification_preferences, '{push_subscriptions}', $1::jsonb, true)
      WHERE id = $2`,
    [JSON.stringify(subs), pushTestUserId]
  );
}



test('dispatchRow > SuppressMessageError marks row suppressed without Sentry', async () => {
  const { SuppressMessageError } = require('./errors');

  registerHandler('disp_test_sup_msg_err', async () => {
    throw new SuppressMessageError('test_suppress_reason');
  }, { offsetFromEventDate: 0, anchor: 'event_date', category: 'operational', priority: 4 });

  const cli = await pool.query(
    `INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ('proposal', $1, 'disp_test_sup_msg_err', 'client', $2, 'email', NOW() - INTERVAL '1 minute')
     RETURNING id`,
    [testProposalId, testClientId]
  );

  await dispatchPending();

  const row = await pool.query('SELECT status, error_message FROM scheduled_messages WHERE id = $1', [cli.rows[0].id]);
  assert.strictEqual(row.rows[0].status, 'suppressed');
  assert.strictEqual(row.rows[0].error_message, 'test_suppress_reason');
});
test('push channel > no subscriptions => row suppressed with no_push_subscriptions', async () => {
  await setPushSubs([]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, payload)
     VALUES ($1, 'shift', 'disp_test_push_nosubs', 'staff', $2, 'push', NOW() - INTERVAL '1 minute', '{}'::jsonb)`,
    [testProposalId, pushTestUserId]
  );
  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_push_nosubs'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.strictEqual(rows[0].error_message, 'no_push_subscriptions');
});

test('push channel > sends ok, prunes 410-gone subs, retains transient failures', async () => {
  await setPushSubs([
    { endpoint: 'https://example.test/good', keys: { p256dh: 'a', auth: 'a' }, subscribed_at: '2026-05-01T00:00:00Z' },
    { endpoint: 'https://example.test/gone', keys: { p256dh: 'b', auth: 'b' }, subscribed_at: '2026-05-02T00:00:00Z' },
    { endpoint: 'https://example.test/flaky', keys: { p256dh: 'c', auth: 'c' }, subscribed_at: '2026-05-03T00:00:00Z' },
  ]);
  const original = pushSender.sendPush;
  pushSender.sendPush = async ({ subscription }) => {
    if (subscription.endpoint.endsWith('/good')) return { ok: true };
    if (subscription.endpoint.endsWith('/gone')) return { ok: false, gone: true };
    return { ok: false, error: 'transient' };
  };
  try {
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, payload)
       VALUES ($1, 'shift', 'disp_test_push_sent', 'staff', $2, 'push', NOW() - INTERVAL '1 minute',
               '{"title":"X","body":"y","url":"/"}'::jsonb)`,
      [testProposalId, pushTestUserId]
    );
    await dispatchPending();

    const { rows } = await pool.query(
      "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_push_sent'"
    );
    assert.strictEqual(rows[0].status, 'sent', `expected sent, got ${rows[0].status} (${rows[0].error_message})`);

    const { rows: userRows } = await pool.query(
      `SELECT staff_notification_preferences->'push_subscriptions' AS subs FROM users WHERE id = $1`,
      [pushTestUserId]
    );
    const survivors = userRows[0].subs;
    assert.strictEqual(survivors.length, 2, 'gone subscription pruned, good + flaky retained');
    const endpoints = survivors.map(s => s.endpoint);
    assert.ok(endpoints.includes('https://example.test/good'));
    assert.ok(endpoints.includes('https://example.test/flaky'));
    assert.ok(!endpoints.includes('https://example.test/gone'));
  } finally {
    pushSender.sendPush = original;
  }
});

test('push channel > all subs fail => row marked failed with push_send_failed', async () => {
  await setPushSubs([
    { endpoint: 'https://example.test/all-bad', keys: { p256dh: 'a', auth: 'a' }, subscribed_at: '2026-05-01T00:00:00Z' },
  ]);
  const original = pushSender.sendPush;
  pushSender.sendPush = async () => ({ ok: false, error: 'transient' });
  try {
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, payload)
       VALUES ($1, 'shift', 'disp_test_push_allfail', 'staff', $2, 'push', NOW() - INTERVAL '1 minute', '{}'::jsonb)`,
      [testProposalId, pushTestUserId]
    );
    await dispatchPending();
    const { rows } = await pool.query(
      "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_push_allfail'"
    );
    assert.strictEqual(rows[0].status, 'failed');
    assert.strictEqual(rows[0].error_message, 'push_send_failed');
  } finally {
    pushSender.sendPush = original;
  }
});

test('sibling cascade > push success marks pending siblings suppressed_by_sibling', async () => {
  await setPushSubs([{ endpoint: 'https://example.test/sib-ok', keys: { p256dh: 'a', auth: 'a' }, subscribed_at: '2026-05-01T00:00:00Z' }]);
  const original = pushSender.sendPush;
  pushSender.sendPush = async () => ({ ok: true });
  try {
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, suppression_key, payload)
       VALUES ($1, 'shift', 'disp_test_sibling', 'staff', $2, 'push', NOW() - INTERVAL '2 minutes', 'shift:99:disp_test_sibling:1', '{"title":"X"}'::jsonb),
              ($1, 'shift', 'disp_test_sibling', 'staff', $2, 'sms',  NOW() - INTERVAL '1 minute',  'shift:99:disp_test_sibling:1', '{"title":"X"}'::jsonb)`,
      [testProposalId, pushTestUserId]
    );
    await dispatchPending();
    const { rows } = await pool.query(
      "SELECT channel, status FROM scheduled_messages WHERE message_type = 'disp_test_sibling' ORDER BY channel"
    );
    assert.strictEqual(rows.length, 2);
    const byChannel = Object.fromEntries(rows.map(r => [r.channel, r.status]));
    assert.strictEqual(byChannel.push, 'sent');
    assert.strictEqual(byChannel.sms, 'suppressed_by_sibling');
  } finally {
    pushSender.sendPush = original;
  }
});

test('re-resolve > critical-path dead-letter when re_resolve_count >= 2', async () => {
  await pool.query(
    `UPDATE users SET
       communication_preferences = (COALESCE(communication_preferences, '{}'::jsonb)
                                    || '{"sms_enabled":false,"email_enabled":false}'::jsonb),
       staff_notification_preferences = jsonb_set(
         jsonb_set(staff_notification_preferences, '{channels,beo_finalized}', '[]'::jsonb, true),
         '{push_subscriptions}', '[]'::jsonb, true)
      WHERE id = $1`,
    [pushTestUserId]
  );

  const origSms = sms.sendAndLogSms;
  let adminSmsBody = null;
  sms.sendAndLogSms = async (args) => { adminSmsBody = args.body; return { id: 1 }; };
  const originalAdminPhone = process.env.ADMIN_PHONE;
  process.env.ADMIN_PHONE = '+13125550100';

  try {
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, suppression_key, payload)
       VALUES ($1, 'shift', 'disp_test_dead_letter', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute', 'failed', 'shift:88:disp_test_dl:1', '{"category":"beo_finalized","re_resolve_count":2}'::jsonb)`,
      [testProposalId, pushTestUserId]
    );
    await dispatchPending();
    const { rows } = await pool.query(
      "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_dead_letter'"
    );
    assert.strictEqual(rows[0].status, 'dead_letter');
    assert.ok(adminSmsBody && adminSmsBody.includes('dead-lettered'), 'ADMIN_PHONE SMS fired');
  } finally {
    sms.sendAndLogSms = origSms;
    if (originalAdminPhone === undefined) delete process.env.ADMIN_PHONE;
    else process.env.ADMIN_PHONE = originalAdminPhone;
  }
});

test('re-resolve > increments counter and enqueues retry when channels still resolve', async () => {
  await pool.query(
    `UPDATE users SET
       communication_preferences = (COALESCE(communication_preferences, '{}'::jsonb)
                                    || '{"sms_enabled":true,"email_enabled":true}'::jsonb),
       staff_notification_preferences = jsonb_set(
         staff_notification_preferences, '{channels,beo_finalized}', '["sms","email"]'::jsonb, true)
      WHERE id = $1`,
    [pushTestUserId]
  );
  const suppKey = `shift:77:disp_test_retry:${pushTestUserId}`;
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, suppression_key, payload)
     VALUES ($1, 'shift', 'disp_test_retry', 'staff', $2, 'push', NOW() - INTERVAL '5 minutes', 'failed', $3, '{"category":"beo_finalized","re_resolve_count":0}'::jsonb)`,
    [testProposalId, pushTestUserId, suppKey]
  );
  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT channel, status, suppression_key, payload->>'re_resolve_count' AS rc FROM scheduled_messages WHERE message_type = 'disp_test_retry' ORDER BY id"
  );
  assert.strictEqual(rows.length, 2, 'original + retry row');
  assert.strictEqual(rows[0].status, 'failed');
  const retry = rows[1];
  assert.strictEqual(retry.suppression_key, `${suppKey}:retry1`);
  assert.strictEqual(Number(retry.rc), 1);
  assert.strictEqual(retry.channel, 'sms');
});
