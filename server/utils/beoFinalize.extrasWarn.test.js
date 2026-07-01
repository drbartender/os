require('dotenv').config();

// B3: finalizeDrinkPlan is the SERVER-side unpaid-extras gate. With an open,
// unpaid "Drink Plan Extras" invoice it refuses to finalize (rolls back) unless
// called with { overrideUnpaidExtras: true }, and on override it writes a
// finalized_unpaid_extras audit row carrying the unpaid amount. A plan with no
// unpaid extras finalizes normally. Runs against the dev DB; rows torn down.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { pool } = require('../db');
const { finalizeDrinkPlan } = require('./beoFinalize');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let adminUserId;
const proposalIds = [];
const clientIds = [];

async function seedFinalizable({ withUnpaidExtras }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('BEO Extras', $1) RETURNING id`,
    [`beo-extras-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
                            status, event_type, total_price, amount_paid, guest_count, num_bars, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 1000, 100, 75, 0, '{}'::jsonb) RETURNING id`,
    [c.rows[0].id]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections)
     VALUES ($1, 'reviewed', '{"signatureDrinks":["sd_1"]}'::jsonb) RETURNING id`,
    [proposalId]
  );
  if (withUnpaidExtras) {
    await pool.query(
      `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
       VALUES ($1, $2, 'Drink Plan Extras', 6000, 0, 'sent')`,
      [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
    );
  }
  return { proposalId, planId: dp.rows[0].id };
}

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`beo-extras-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
});

after(async () => {
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await pool.end();
});

test('unpaid extras: finalize refuses, then override finalizes + audits the amount', async () => {
  const { proposalId, planId } = await seedFinalizable({ withUnpaidExtras: true });

  await assert.rejects(() => finalizeDrinkPlan(planId, adminUserId), /unpaid extras/i);

  // Refused finalize rolled back — plan is NOT finalized.
  const notYet = await pool.query('SELECT finalized_at FROM drink_plans WHERE id = $1', [planId]);
  assert.equal(notYet.rows[0].finalized_at, null, 'refused finalize must not stamp finalized_at');

  // Override succeeds.
  const plan = await finalizeDrinkPlan(planId, adminUserId, { overrideUnpaidExtras: true });
  assert.ok(plan.finalized_at, 'override finalize stamps finalized_at');

  // Audit rows: both the normal beo_finalized and the override marker.
  const marker = await pool.query(
    `SELECT actor_id, details->>'amount_cents' AS amt, details->>'drink_plan_id' AS dp
       FROM proposal_activity_log WHERE action = 'finalized_unpaid_extras' AND proposal_id = $1`,
    [proposalId]
  );
  assert.equal(marker.rows.length, 1);
  assert.equal(Number(marker.rows[0].amt), 6000);
  assert.equal(Number(marker.rows[0].dp), planId);
  assert.equal(marker.rows[0].actor_id, adminUserId);

  const finalized = await pool.query(
    `SELECT count(*)::int AS n FROM proposal_activity_log WHERE action = 'beo_finalized' AND proposal_id = $1`,
    [proposalId]
  );
  assert.equal(finalized.rows[0].n, 1);
});

test('no unpaid extras: finalize succeeds without override', async () => {
  const { proposalId, planId } = await seedFinalizable({ withUnpaidExtras: false });
  const plan = await finalizeDrinkPlan(planId, adminUserId);
  assert.ok(plan.finalized_at);
  const marker = await pool.query(
    `SELECT count(*)::int AS n FROM proposal_activity_log WHERE action = 'finalized_unpaid_extras' AND proposal_id = $1`,
    [proposalId]
  );
  assert.equal(marker.rows[0].n, 0, 'no override marker when there are no unpaid extras');
});
