require('dotenv').config({ path: 'C:/Users/dalla/DRB_OS/os/.env' });
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { performConsultsCompletionFlip } = require('./drinkPlanConsult');

// Refuse to run against a non-test database. The before/after hooks DELETE
// consults / drink_plans / proposals / clients rows scoped to this test, but
// require an explicit opt-in to avoid surprise writes against prod.
if (process.env.NODE_ENV !== 'test' && !process.env.ALLOW_TEST_DB_WRITES) {
  throw new Error(
    'drinkPlanConsult.test.js refuses to run without NODE_ENV=test or ALLOW_TEST_DB_WRITES=1. ' +
    'These tests INSERT/DELETE rows on consults / drink_plans / proposals / clients.'
  );
}

let testClientId;
let testProposalId;
let testDrinkPlanId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('CalcomConsultFlip', 'consultflip@calcom-test.example', 'direct') RETURNING id`
  );
  testClientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, balance_due_date)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + INTERVAL '30 days', 'birthday-party', 100000, CURRENT_DATE + INTERVAL '14 days')
     RETURNING id`,
    [testClientId]
  );
  testProposalId = p.rows[0].id;
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, client_name, client_email, event_date, status)
     VALUES ($1, 'CalcomConsultFlip', 'consultflip@calcom-test.example', CURRENT_DATE + INTERVAL '30 days', 'pending')
     RETURNING id`,
    [testProposalId]
  );
  testDrinkPlanId = dp.rows[0].id;
});

after(async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1 OR booker_email LIKE '%@calcom-test.example'", [testProposalId]);
  await pool.query("DELETE FROM drink_plans WHERE id = $1", [testDrinkPlanId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [testProposalId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [testClientId]);
  await pool.end();
});

test('completionFlip: flips past-scheduled consult for the proposal', async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1", [testProposalId]);
  await pool.query(
    `INSERT INTO consults (proposal_id, scheduled_at, status, calcom_event_id)
     VALUES ($1, NOW() - INTERVAL '1 hour', 'scheduled', 'flip-test-past')`,
    [testProposalId]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, testProposalId);
    await client.query('COMMIT');
  } finally { client.release(); }

  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'flip-test-past'");
  assert.equal(row.rows[0].status, 'completed');
});

test('completionFlip: leaves future-scheduled consults alone', async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1", [testProposalId]);
  await pool.query(
    `INSERT INTO consults (proposal_id, scheduled_at, status, calcom_event_id)
     VALUES ($1, NOW() + INTERVAL '7 days', 'scheduled', 'flip-test-future')`,
    [testProposalId]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, testProposalId);
    await client.query('COMMIT');
  } finally { client.release(); }

  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'flip-test-future'");
  assert.equal(row.rows[0].status, 'scheduled');
});

test('completionFlip: idempotent on already-completed rows', async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1", [testProposalId]);
  await pool.query(
    `INSERT INTO consults (proposal_id, scheduled_at, status, calcom_event_id)
     VALUES ($1, NOW() - INTERVAL '1 hour', 'completed', 'flip-test-already')`,
    [testProposalId]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, testProposalId);
    await client.query('COMMIT');
  } finally { client.release(); }

  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'flip-test-already'");
  assert.equal(row.rows[0].status, 'completed');
});

test('completionFlip: no-op when no consults exist for proposal', async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1", [testProposalId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, testProposalId); // should not throw
    await client.query('COMMIT');
  } finally { client.release(); }
});

test('completionFlip: NULL proposal_id is a no-op', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, null); // should not throw
    await client.query('COMMIT');
  } finally { client.release(); }
});
