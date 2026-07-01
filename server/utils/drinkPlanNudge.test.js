require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerDrinkPlanNudgeHandlers, scheduleDrinkPlanNudge, loadNudgeContext } = require('./drinkPlanNudge');
const { getHandlerMeta, _clearHandlersForTest } = require('./scheduledMessageDispatcher');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Nudge Test', 'nudge-test@example.com', '3125550150') RETURNING id"
  );
  clientId = c.rows[0].id;
  // Sweep any sms_messages row this file's message_type leaked from a prior
  // aborted run. sms_messages.twilio_sid carries a partial UNIQUE index
  // (idx_sms_messages_twilio_sid) so a stale 'stub' SID would collide here.
  await pool.query("DELETE FROM sms_messages WHERE message_type = 'drink_plan_nudge_sms'");
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, status, event_type, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '60 days', '18:00', 'deposit_paid', 'birthday-party', 'America/Chicago')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  // Clear the sms_messages row a stubbed SMS send logged — its twilio_sid is
  // partial-UNIQUE, so leaving it would collide on the next run / sibling file.
  await pool.query("DELETE FROM sms_messages WHERE client_id = $1 AND message_type = 'drink_plan_nudge_sms'", [clientId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('registerDrinkPlanNudgeHandlers > registers email + sms types, operational, T-21 offset', () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  for (const mt of ['drink_plan_nudge', 'drink_plan_nudge_sms']) {
    const meta = getHandlerMeta(mt);
    assert.ok(meta, `expected meta for ${mt}`);
    assert.strictEqual(meta.category, 'operational');
    assert.strictEqual(meta.anchor, 'event_date');
    assert.strictEqual(meta.offsetFromEventDate, -21 * 86400);
  }
});

test('scheduleDrinkPlanNudge > inserts an email row and an sms row', async () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  // cc-import (Task 2): scheduleDrinkPlanNudge now early-returns when no
  // drink_plans row exists. Seed the row so the nudge actually schedules.
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [proposalId]);
  await scheduleDrinkPlanNudge(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1 ORDER BY channel`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 2);
  const m = Object.fromEntries(rows.map(r => [r.channel, r.message_type]));
  assert.strictEqual(m.email, 'drink_plan_nudge');
  assert.strictEqual(m.sms, 'drink_plan_nudge_sms');
});

test('scheduleDrinkPlanNudge > is idempotent', async () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  // cc-import (Task 2): seed the drink_plans row so the early-return guard
  // does not skip scheduling. See specs/2026-05-25-checkcherry-import-design.md §9.3.D.
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [proposalId]);
  await scheduleDrinkPlanNudge(proposalId);
  await scheduleDrinkPlanNudge(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 2);
});

test('scheduleDrinkPlanNudge > skips when no drink_plans row exists (cc-import)', async () => {
  // CC-import (spec §9.3.D): events without a drink plan never get nudged.
  // No drink_plans INSERT before calling — verifies the early-return guard.
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  await scheduleDrinkPlanNudge(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1
       AND message_type LIKE 'drink_plan_nudge%'`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 0, 'no drink_plan_nudge rows should be scheduled when no drink_plans row exists');
});

test('drink_plan_nudge handler > throws SUPPRESS when the drink plan has populated selections', async () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  // A drink_plans row with a NON-EMPTY selections object means the client
  // already submitted via the Potion Planner.
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, selections) VALUES ($1, '{"beer":["lager"]}'::jsonb)`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'drink_plan_nudge', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_id=$1 AND message_type='drink_plan_nudge'",
    [proposalId]
  );
  // The handler throws SuppressMessageError → the dispatcher marks the row
  // 'suppressed' with the reason in error_message.
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /drink_plan_already_filled/);
});

test('drink_plan_nudge handler > is NOT suppressed by a default-empty drink_plans row', async () => {
  // The production case: createDrinkPlan inserts a drink_plans row at
  // conversion with NO selections value, so selections is the empty object
  // '{}' (DEFAULT '{}'), not NULL. The nudge MUST still fire for this row —
  // an empty '{}' is "not submitted". This is the regression Blocker 1 caught.
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  const { __setSmsDeps } = require('./sms');
  // Unique SID per call — sms_messages.twilio_sid is partial-UNIQUE, a constant
  // 'stub' SID collides across tests / runs (mirrors dripSmsHandlers.test.js).
  let sidN = 0;
  __setSmsDeps({ sendSMS: async () => ({ sid: `stub-${Date.now()}-${(sidN += 1)}` }) });
  // Row created exactly as createDrinkPlan would: no selections column → '{}'.
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [proposalId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'drink_plan_nudge', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='drink_plan_nudge'",
    [proposalId]
  );
  // sent (the email send succeeds in dev) — NOT 'suppressed' as no-longer-needed.
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});

test('loadNudgeContext > returns the drink-plan token so /plan/:token resolves (not the proposal token)', async () => {
  // The Potion Planner route resolves WHERE dp.token, and proposals.token and
  // drink_plans.token are independent UUIDs — the nudge link must carry the
  // drink-plan token, or the client lands on "this drink plan link is no longer valid".
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [proposalId]);
  const dp = await pool.query('SELECT token FROM drink_plans WHERE proposal_id = $1', [proposalId]);
  const p = await pool.query('SELECT token FROM proposals WHERE id = $1', [proposalId]);
  assert.notStrictEqual(dp.rows[0].token, p.rows[0].token, 'sanity: distinct UUIDs');
  const ctx = await loadNudgeContext(proposalId);
  assert.strictEqual(ctx.token, dp.rows[0].token, 'nudge context token must be the drink-plan token');
});

test('drink_plan_nudge_sms handler > sends an SMS when the drink plan is empty', async () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  const { __setSmsDeps } = require('./sms');
  let smsCalls = 0;
  // Unique SID per call — sms_messages.twilio_sid is partial-UNIQUE.
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: `stub-${Date.now()}-${smsCalls}` }; } });
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'drink_plan_nudge_sms', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();
  assert.strictEqual(smsCalls, 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='drink_plan_nudge_sms'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
