require('dotenv').config();

// Derived BEO finalize (lane beo-auto-finalize, 2026-09-11). A drink plan
// finalizes on its own the moment it is reviewed AND its shopping list is
// approved (hosted packages need no list), never over unpaid extras. The two
// admin actions that can complete that state (Mark reviewed, shopping-list
// approve) call autoFinalizeIfEligible; whichever lands last fires it. The
// manual Finalize button stays the override path for unpaid extras and the
// post-Unfinalize state. Runs against the dev DB; every row is torn down.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('./errors');
const { autoFinalizeIfEligible, finalizeDrinkPlan } = require('./beoFinalize');
const { getAction } = require('./comms/registry');
const drinkPlansRouter = require('../routes/drinkPlans');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const SELECTIONS = '{"signatureDrinks":["sd_1"]}';
const LIST = '{"guestCount":50,"liquorBeerWine":[],"everythingElse":[]}';

let adminUserId;
let adminToken;
let server;
let baseUrl;
const proposalIds = [];
const clientIds = [];
const packageIds = [];
const orphanPlanIds = [];

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function seedPackage({ category, barType = 'full_bar' }) {
  const p = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'Auto BEO Pkg', $2, $3, 28, 33, 50, 100, $4, '[]') RETURNING id`,
    [`auto-beo-${NONCE}-${packageIds.length}`, category, category === 'hosted' ? 'per_guest' : 'flat', barType]
  );
  packageIds.push(p.rows[0].id);
  return p.rows[0].id;
}

// status / listStatus / packageId / withUnpaidExtras / selections shape one plan.
async function seedPlan({ status = 'reviewed', listStatus = 'approved', packageId = null, withUnpaidExtras = false, selections = SELECTIONS } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Auto BEO', $1) RETURNING id`,
    [`auto-beo-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
                            status, event_type, total_price, amount_paid, guest_count, num_bars, pricing_snapshot, package_id)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 1000, 100, 75, 0, '{}'::jsonb, $2) RETURNING id`,
    [c.rows[0].id, packageId]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, shopping_list, shopping_list_status,
                              shopping_list_approved_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::varchar, CASE WHEN $5::varchar = 'approved' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [proposalId, status, selections, listStatus ? LIST : null, listStatus]
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

async function planRow(planId) {
  const r = await pool.query(
    'SELECT status, finalized_at, finalized_by, shopping_list_status FROM drink_plans WHERE id = $1', [planId]
  );
  return r.rows[0];
}

async function logRows(proposalId, action) {
  const r = await pool.query(
    'SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = $2 ORDER BY id', [proposalId, action]
  );
  return r.rows;
}

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`auto-beo-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminUserId, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
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
  if (orphanPlanIds.length) await pool.query('DELETE FROM drink_plans WHERE id = ANY($1::int[])', [orphanPlanIds]);
  if (packageIds.length) await pool.query('DELETE FROM service_packages WHERE id = ANY($1::int[])', [packageIds]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── autoFinalizeIfEligible ──────────────────────────────────────────────────

test('flat + approved list + reviewed: the reviewed trigger finalizes and records the trigger', async () => {
  const { proposalId, planId } = await seedPlan();
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'reviewed');
  assert.equal(r.finalized, true);
  assert.ok(r.plan && r.plan.finalized_at);
  assert.ok(!('shopping_list_approved_snapshot' in r.plan), 'snapshot blob stays off the returned plan');
  const row = await planRow(planId);
  assert.ok(row.finalized_at);
  assert.equal(row.finalized_by, adminUserId);
  const log = await logRows(proposalId, 'beo_finalized');
  assert.equal(log.length, 1);
  assert.equal(log[0].details.trigger, 'reviewed');
});

test('flat + pending list + reviewed: skips with list_not_approved', async () => {
  const { proposalId, planId } = await seedPlan({ listStatus: 'pending_review' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'reviewed');
  assert.deepEqual({ finalized: r.finalized, reason: r.reason }, { finalized: false, reason: 'list_not_approved' });
  assert.equal((await planRow(planId)).finalized_at, null);
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 0);
});

test('hosted package + reviewed + no list at all: finalizes', async () => {
  const pkg = await seedPackage({ category: 'hosted' });
  const { planId } = await seedPlan({ packageId: pkg, listStatus: null });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'reviewed');
  assert.equal(r.finalized, true);
  assert.ok((await planRow(planId)).finalized_at);
});

test('cocktail class (category hosted, bar_type class) + no approved list: skips like BYOB', async () => {
  const pkg = await seedPackage({ category: 'hosted', barType: 'class' });
  const { planId } = await seedPlan({ packageId: pkg, listStatus: 'pending_review' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'reviewed');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'list_not_approved');
});

test('submitted + approved list: the list trigger skips with not_reviewed', async () => {
  const { planId } = await seedPlan({ status: 'submitted' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'not_reviewed');
  assert.equal((await planRow(planId)).finalized_at, null);
});

test('unpaid extras: skips with the amount, never overrides, writes no audit row', async () => {
  const { proposalId, planId } = await seedPlan({ withUnpaidExtras: true });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'unpaid_extras');
  assert.equal(r.unpaid_extras_cents, 6000);
  assert.equal((await planRow(planId)).finalized_at, null);
  assert.equal((await logRows(proposalId, 'finalized_unpaid_extras')).length, 0);
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 0);
  // The manual override path is untouched: it still finalizes and audits.
  const plan = await finalizeDrinkPlan(planId, adminUserId, { overrideUnpaidExtras: true });
  assert.ok(plan.finalized_at);
  const audit = await logRows(proposalId, 'finalized_unpaid_extras');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.amount_cents, 6000);
});

test('empty selections: skips with no_selections', async () => {
  const { planId } = await seedPlan({ selections: '{}' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'reviewed');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'no_selections');
});

test('already finalized: skips with already_finalized and writes no second log row', async () => {
  const { proposalId, planId } = await seedPlan();
  assert.equal((await autoFinalizeIfEligible(planId, adminUserId, 'reviewed')).finalized, true);
  const again = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(again.finalized, true, 'finalized means "finalized now", so the losing trigger still says true');
  assert.equal(again.reason, 'already_finalized');
  assert.equal(again.plan, undefined, 'only the call that finalized carries the plan');
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 1);
});

test('plan with no proposal: skips with not_linked and never throws', async () => {
  const dp = await pool.query(
    `INSERT INTO drink_plans (status, selections, shopping_list, shopping_list_status)
     VALUES ('reviewed', $1::jsonb, $2::jsonb, 'approved') RETURNING id`, [SELECTIONS, LIST]
  );
  orphanPlanIds.push(dp.rows[0].id);
  const r = await autoFinalizeIfEligible(dp.rows[0].id, adminUserId, 'reviewed');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'not_linked');
});

test('unknown plan id: skips with not_found and never throws', async () => {
  const r = await autoFinalizeIfEligible(999999999, adminUserId, 'reviewed');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'not_found');
});

// ─── shopping_list_approve side effects ──────────────────────────────────────

test('ensureSideEffects on a reviewed plan approves AND finalizes; the retry reports finalized without re-running', async () => {
  const { proposalId, planId } = await seedPlan({ listStatus: 'pending_review' });
  const a = getAction('shopping_list_approve');
  const first = await a.ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(first.applied, true);
  assert.equal(first.beo.finalized, true);
  const row = await planRow(planId);
  assert.equal(row.shopping_list_status, 'approved');
  assert.ok(row.finalized_at);
  assert.equal(row.finalized_by, adminUserId);
  assert.equal((await logRows(proposalId, 'beo_finalized'))[0].details.trigger, 'shopping_list_approved');

  const second = await a.ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(second.applied, false);
  assert.equal(second.beo.finalized, true, 'a Retry must still say the plan is finalized');
  assert.equal(String((await planRow(planId)).finalized_at), String(row.finalized_at));
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 1);
});

test('ensureSideEffects on an already-approved, unfinalized plan re-attempts: honest reason first, finalize once reviewed', async () => {
  const { proposalId, planId } = await seedPlan({ status: 'submitted', listStatus: 'approved' });
  const a = getAction('shopping_list_approve');
  const first = await a.ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(first.applied, false);
  assert.equal(first.beo.finalized, false);
  assert.equal(first.beo.reason, 'not_reviewed', 'a repeat confirm carries the real reason, not a bare false');

  await pool.query("UPDATE drink_plans SET status = 'reviewed' WHERE id = $1", [planId]);
  const second = await a.ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(second.applied, false);
  assert.equal(second.beo.finalized, true, 'the repeat confirm heals a plan that became eligible');
  assert.ok((await planRow(planId)).finalized_at);
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 1);
});

test('ensureSideEffects on a submitted plan approves but reports not_reviewed', async () => {
  const { planId } = await seedPlan({ status: 'submitted', listStatus: 'pending_review' });
  const r = await getAction('shopping_list_approve').ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(r.applied, true);
  assert.equal(r.beo.finalized, false);
  assert.equal(r.beo.reason, 'not_reviewed');
  assert.equal((await planRow(planId)).shopping_list_status, 'approved');
});

// ─── Routes ──────────────────────────────────────────────────────────────────

test('PATCH /:id/status reviewed on an approved-list plan finalizes, reports beo, strips the snapshot; the lock then holds', async () => {
  const { planId } = await seedPlan({ status: 'submitted' });
  const res = await request('PATCH', `/api/drink-plans/${planId}/status`, { token: adminToken, body: { status: 'reviewed' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'reviewed');
  assert.ok(res.body.finalized_at, 'response carries the fresh finalized_at');
  assert.equal(res.body.beo.finalized, true);
  assert.ok(!('shopping_list_approved_snapshot' in res.body));

  const again = await request('PATCH', `/api/drink-plans/${planId}/status`, { token: adminToken, body: { status: 'submitted' } });
  assert.equal(again.status, 409);

  const put = await request('PUT', `/api/drink-plans/${planId}/shopping-list`, {
    token: adminToken, body: { shopping_list: JSON.parse(LIST) },
  });
  assert.equal(put.status, 409, 'list edits are locked after auto-finalize');

  const get = await request('GET', `/api/drink-plans/${planId}/shopping-list`, { token: adminToken });
  assert.equal(get.status, 200);
  assert.ok(get.body.finalized_at, 'the modal can seed its locked state from the list GET');
});

test('PATCH /:id/status reviewed on a pending-list plan stays unfinalized and says why', async () => {
  const { planId } = await seedPlan({ status: 'submitted', listStatus: 'pending_review' });
  const res = await request('PATCH', `/api/drink-plans/${planId}/status`, { token: adminToken, body: { status: 'reviewed' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.finalized_at, null);
  assert.equal(res.body.beo.finalized, false);
  assert.equal(res.body.beo.reason, 'list_not_approved');
});

test('PATCH /:id/status reviewed with unpaid extras stays unfinalized and reports the cents', async () => {
  const { planId } = await seedPlan({ status: 'submitted', withUnpaidExtras: true });
  const res = await request('PATCH', `/api/drink-plans/${planId}/status`, { token: adminToken, body: { status: 'reviewed' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.finalized_at, null);
  assert.equal(res.body.beo.reason, 'unpaid_extras');
  assert.equal(res.body.beo.unpaid_extras_cents, 6000);
});

test('POST /:id/finalize (manual) still works and no longer leaks the snapshot blob', async () => {
  const { planId } = await seedPlan({ listStatus: 'pending_review' });
  const res = await request('POST', `/api/drink-plans/${planId}/finalize`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.finalized_at);
  assert.ok(!('shopping_list_approved_snapshot' in res.body));
});
