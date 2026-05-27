require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { createDrinkPlan } = require('./eventCreation');
const { registerDrinkPlanNudgeHandlers } = require('./drinkPlanNudge');
const { _clearHandlersForTest } = require('./scheduledMessageDispatcher');

// Pinned negative-ID fixtures so this file's deletes never collide with sibling
// tests running in parallel against the shared dev DB.
const TEST_CLIENT_ID = -710;
const TEST_PROPOSAL_ID = -711;

before(() => {
  // Register the drink-plan nudge handler metadata so the post-insert hook's
  // scheduleDrinkPlanNudge -> computeScheduledFor lookup resolves. The hook is
  // wrapped in try/catch (non-blocking) — without the metadata it would log a
  // warning and silently skip, masking the assertion this file is checking.
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
});

beforeEach(async () => {
  // Defensive cleanup before each test.
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);

  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES ($1, 'Event Creation Test', 'evtcreation-test@example.com', '+15557770100')`,
    [TEST_CLIENT_ID]
  );
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, event_type, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', CURRENT_DATE + INTERVAL '60 days', '18:00', 'America/Chicago', 'birthday-party', NOW(), 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
});

after(async () => {
  await pool.end();
});

async function loadProposal(id) {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS client_name, c.email AS client_email
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [id]
  );
  return rows[0];
}

test('createDrinkPlan > scheduleDrinkPlanNudge fires after a new plan is inserted', async () => {
  const proposal = await loadProposal(TEST_PROPOSAL_ID);
  const plan = await createDrinkPlan(TEST_PROPOSAL_ID, proposal);
  assert.ok(plan, 'createDrinkPlan should return the new row');

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type = 'drink_plan_nudge'`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(rows[0].n, 1, 'exactly one drink_plan_nudge email row should be scheduled');

  const { rows: smsRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type = 'drink_plan_nudge_sms'`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(smsRows[0].n, 1, 'exactly one drink_plan_nudge_sms row should be scheduled');
});

test('createDrinkPlan > hook does NOT fire on idempotent skip (plan already exists)', async () => {
  // Pre-seed an existing drink_plans row so createDrinkPlan takes the idempotent
  // skip path (returns null) without reaching the post-insert hook.
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [TEST_PROPOSAL_ID]);
  const proposal = await loadProposal(TEST_PROPOSAL_ID);
  const result = await createDrinkPlan(TEST_PROPOSAL_ID, proposal);
  assert.strictEqual(result, null, 'idempotent skip path returns null');

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type LIKE 'drink_plan_nudge%'`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(rows[0].n, 0, 'no drink_plan_nudge rows should be scheduled when the insert was skipped');
});
