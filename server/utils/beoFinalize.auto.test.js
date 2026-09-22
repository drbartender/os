require('dotenv').config();

// Derived BEO finalize (lane beo-auto-finalize, 2026-09-11; reshaped by lane
// beo-approve-is-review, 2026-09-22). A drink plan finalizes on its own the
// moment its shopping list is approved: approving the list IS the review, so
// finalize no longer asks for status='reviewed' beforehand and stamps it
// itself (the approve flip stamps it too). The list approve is the ONLY
// derived trigger; a hosted package owes no list, so its one click is the
// manual Finalize button, which now works from any unfinalized plan that has
// selections. Never over unpaid extras. Runs against the dev DB; every row is
// torn down.

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

test('the reviewed trigger is gone: it is a programmer error, not a skip', async () => {
  await assert.rejects(() => autoFinalizeIfEligible(999999999, adminUserId, 'reviewed'), /unknown trigger reviewed/);
});

test('approved list + submitted plan: the approve trigger finalizes, stamps reviewed, records the trigger', async () => {
  const { proposalId, planId } = await seedPlan({ status: 'submitted' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, true);
  assert.ok(r.plan && r.plan.finalized_at);
  assert.equal(r.plan.status, 'reviewed', 'finalize stamps reviewed itself');
  assert.ok(!('shopping_list_approved_snapshot' in r.plan), 'snapshot blob stays off the returned plan');
  const row = await planRow(planId);
  assert.ok(row.finalized_at);
  assert.equal(row.finalized_by, adminUserId);
  assert.equal(row.status, 'reviewed');
  const log = await logRows(proposalId, 'beo_finalized');
  assert.equal(log.length, 1);
  assert.equal(log[0].details.trigger, 'shopping_list_approved');
});

test('approved list + draft plan (the admin built the list from the consult): finalizes and stamps reviewed', async () => {
  const { planId } = await seedPlan({ status: 'draft' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, true);
  assert.equal((await planRow(planId)).status, 'reviewed');
});

test('approved list + plan already reviewed: finalizes the same way', async () => {
  const { planId } = await seedPlan();
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, true);
  assert.equal((await planRow(planId)).status, 'reviewed');
});

test('pending list: skips with list_not_approved and never stamps reviewed', async () => {
  const { proposalId, planId } = await seedPlan({ status: 'submitted', listStatus: 'pending_review' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.deepEqual({ finalized: r.finalized, reason: r.reason }, { finalized: false, reason: 'list_not_approved' });
  const row = await planRow(planId);
  assert.equal(row.finalized_at, null);
  assert.equal(row.status, 'submitted', 'a refused finalize leaves status alone');
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 0);
});

test('hosted package + no list: the derived trigger has nothing to fire on (list_not_approved); the manual button is the hosted path', async () => {
  const pkg = await seedPackage({ category: 'hosted' });
  const { planId } = await seedPlan({ packageId: pkg, listStatus: null, status: 'submitted' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'list_not_approved');
  assert.equal((await planRow(planId)).status, 'submitted');
});

test('hosted package + no list + submitted: the manual Finalize button is the one click, and it stamps reviewed', async () => {
  const pkg = await seedPackage({ category: 'hosted' });
  const { proposalId, planId } = await seedPlan({ packageId: pkg, listStatus: null, status: 'submitted' });
  const plan = await finalizeDrinkPlan(planId, adminUserId);
  assert.ok(plan.finalized_at);
  assert.equal(plan.status, 'reviewed');
  assert.equal((await logRows(proposalId, 'beo_finalized'))[0].details.trigger, 'manual');
});

test('cocktail class (category hosted, bar_type class) + no approved list: skips like BYOB', async () => {
  const pkg = await seedPackage({ category: 'hosted', barType: 'class' });
  const { planId } = await seedPlan({ packageId: pkg, listStatus: 'pending_review' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'list_not_approved');
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

test('empty selections: skips with no_selections and never stamps reviewed', async () => {
  const { planId } = await seedPlan({ status: 'submitted', selections: '{}' });
  const r = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'no_selections');
  assert.equal((await planRow(planId)).status, 'submitted');
});

test('already finalized: skips with already_finalized and writes no second log row', async () => {
  const { proposalId, planId } = await seedPlan();
  assert.equal((await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved')).finalized, true);
  const again = await autoFinalizeIfEligible(planId, adminUserId, 'shopping_list_approved');
  assert.equal(again.finalized, true, 'finalized means "finalized now", so a repeat still says true');
  assert.equal(again.reason, 'already_finalized');
  assert.equal(again.plan, undefined, 'only the call that finalized carries the plan');
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 1);
});

test('plan with no proposal: skips with not_linked and never throws', async () => {
  const dp = await pool.query(
    `INSERT INTO drink_plans (status, selections, shopping_list, shopping_list_status)
     VALUES ('submitted', $1::jsonb, $2::jsonb, 'approved') RETURNING id`, [SELECTIONS, LIST]
  );
  orphanPlanIds.push(dp.rows[0].id);
  const r = await autoFinalizeIfEligible(dp.rows[0].id, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'not_linked');
});

test('unknown plan id: skips with not_found and never throws', async () => {
  const r = await autoFinalizeIfEligible(999999999, adminUserId, 'shopping_list_approved');
  assert.equal(r.finalized, false);
  assert.equal(r.reason, 'not_found');
});

// ─── shopping_list_approve side effects ──────────────────────────────────────

test('ensureSideEffects on a submitted plan approves, stamps reviewed, finalizes; the retry reports finalized without re-running', async () => {
  const { proposalId, planId } = await seedPlan({ status: 'submitted', listStatus: 'pending_review' });
  const a = getAction('shopping_list_approve');
  const first = await a.ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(first.applied, true);
  assert.equal(first.beo.finalized, true);
  const row = await planRow(planId);
  assert.equal(row.shopping_list_status, 'approved');
  assert.equal(row.status, 'reviewed', 'approving the list is the review');
  assert.ok(row.finalized_at);
  assert.equal(row.finalized_by, adminUserId);
  assert.equal((await logRows(proposalId, 'beo_finalized'))[0].details.trigger, 'shopping_list_approved');

  const second = await a.ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(second.applied, false);
  assert.equal(second.beo.finalized, true, 'a Retry must still say the plan is finalized');
  assert.equal(String((await planRow(planId)).finalized_at), String(row.finalized_at));
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 1);
});

test('ensureSideEffects on an already-approved, unfinalized submitted plan: one repeat confirm finalizes it (the pre-deploy shape heals)', async () => {
  const { proposalId, planId } = await seedPlan({ status: 'submitted', listStatus: 'approved' });
  const r = await getAction('shopping_list_approve').ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(r.applied, false, 'the list was already approved');
  assert.equal(r.beo.finalized, true);
  const row = await planRow(planId);
  assert.ok(row.finalized_at);
  assert.equal(row.status, 'reviewed');
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 1);
});

test('ensureSideEffects on a draft plan with a consult-built list: approves, stamps reviewed, finalizes', async () => {
  const { planId } = await seedPlan({ status: 'draft', listStatus: 'pending_review' });
  const r = await getAction('shopping_list_approve').ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(r.applied, true);
  assert.equal(r.beo.finalized, true);
  const row = await planRow(planId);
  assert.equal(row.status, 'reviewed');
  assert.ok(row.finalized_at);
});

test('ensureSideEffects with unpaid extras: approves, reports unpaid_extras, and leaves status alone for the button to finish', async () => {
  const { planId } = await seedPlan({ status: 'submitted', listStatus: 'pending_review', withUnpaidExtras: true });
  const r = await getAction('shopping_list_approve').ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(r.applied, true);
  assert.equal(r.beo.finalized, false);
  assert.equal(r.beo.reason, 'unpaid_extras');
  assert.equal(r.beo.unpaid_extras_cents, 6000);
  const row = await planRow(planId);
  assert.equal(row.shopping_list_status, 'approved');
  assert.equal(row.status, 'submitted', 'only the finalize UPDATE writes reviewed; a refused finalize changes nothing');
  assert.equal(row.finalized_at, null);
});

test('ensureSideEffects on a pending plan with a consult-built list and empty selections: approves, refuses no_selections, status stays pending and the planner link keeps working', async () => {
  // The shape the per-lane review caught: Dallas publishes the consult list
  // before the client ever opens the planner. Stamping reviewed here would
  // brick the client's link (the public PUT refuses submitted/reviewed plans).
  const { planId } = await seedPlan({ status: 'pending', listStatus: 'pending_review', selections: '{}' });
  const r = await getAction('shopping_list_approve').ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(r.applied, true);
  assert.equal(r.beo.finalized, false);
  assert.equal(r.beo.reason, 'no_selections');
  const row = await planRow(planId);
  assert.equal(row.shopping_list_status, 'approved');
  assert.equal(row.status, 'pending');
  assert.equal(row.finalized_at, null);
  const tokenRow = await pool.query('SELECT token FROM drink_plans WHERE id = $1', [planId]);
  const put = await request('PUT', `/api/drink-plans/t/${tokenRow.rows[0].token}`, {
    body: { selections: { signatureDrinks: ['sd_1'] }, status: 'draft' },
  });
  assert.equal(put.status, 200, `the client can still save their planner after the approve (${JSON.stringify(put.body)})`);
  assert.equal((await planRow(planId)).status, 'draft');
});

test('finalizeDrinkPlan (manual) on a draft plan with selections works and stamps reviewed', async () => {
  const { proposalId, planId } = await seedPlan({ status: 'draft', listStatus: 'pending_review' });
  const plan = await finalizeDrinkPlan(planId, adminUserId);
  assert.ok(plan.finalized_at);
  assert.equal(plan.status, 'reviewed');
  assert.equal((await logRows(proposalId, 'beo_finalized'))[0].details.trigger, 'manual');
});

// ─── Routes ──────────────────────────────────────────────────────────────────

test('PATCH /:id/status is a plain setter now: reviewed on an approved-list plan does not finalize and carries no beo report', async () => {
  const { proposalId, planId } = await seedPlan({ status: 'submitted' });
  const res = await request('PATCH', `/api/drink-plans/${planId}/status`, { token: adminToken, body: { status: 'reviewed' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'reviewed');
  assert.equal(res.body.finalized_at, null);
  assert.equal(res.body.beo, undefined);
  assert.ok(!('shopping_list_approved_snapshot' in res.body));
  assert.equal((await logRows(proposalId, 'beo_finalized')).length, 0);
});

test('the lock holds after a derived finalize: status PATCH 409s, list PUT 409s, list GET seeds finalized_at', async () => {
  const { planId } = await seedPlan({ status: 'submitted', listStatus: 'pending_review' });
  const r = await getAction('shopping_list_approve').ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(r.beo.finalized, true);

  // The lock is inside the status UPDATE itself (no pre-check to race): the
  // write matches zero rows, the route translates that to the lock 409, and
  // the finalized plan keeps its status.
  const again = await request('PATCH', `/api/drink-plans/${planId}/status`, { token: adminToken, body: { status: 'submitted' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'finalized');
  assert.equal((await planRow(planId)).status, 'reviewed', 'a finalized plan never changes status');

  const put = await request('PUT', `/api/drink-plans/${planId}/shopping-list`, {
    token: adminToken, body: { shopping_list: JSON.parse(LIST) },
  });
  assert.equal(put.status, 409, 'list edits are locked after auto-finalize');

  const get = await request('GET', `/api/drink-plans/${planId}/shopping-list`, { token: adminToken });
  assert.equal(get.status, 200);
  assert.ok(get.body.finalized_at, 'the modal can seed its locked state from the list GET');
});

test('POST /:id/finalize (manual) from a submitted plan works, stamps reviewed, and no longer leaks the snapshot blob', async () => {
  const { planId } = await seedPlan({ status: 'submitted', listStatus: 'pending_review' });
  const res = await request('POST', `/api/drink-plans/${planId}/finalize`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.finalized_at);
  assert.equal(res.body.status, 'reviewed');
  assert.ok(!('shopping_list_approved_snapshot' in res.body));
});

test('POST /:id/finalize (manual) still refuses an empty plan with no_selections', async () => {
  const { planId } = await seedPlan({ status: 'submitted', selections: '{}' });
  const res = await request('POST', `/api/drink-plans/${planId}/finalize`, { token: adminToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'no_selections');
});

test('GET /t/:token after a derived finalize on a never-submitted plan says finalized: true and never ships the stamp', async () => {
  const { planId } = await seedPlan({ status: 'draft', listStatus: 'pending_review' });
  const r = await getAction('shopping_list_approve').ensureSideEffects(planId, { sentBy: adminUserId });
  assert.equal(r.beo.finalized, true);
  const tokenRow = await pool.query('SELECT token FROM drink_plans WHERE id = $1', [planId]);
  const get = await request('GET', `/api/drink-plans/t/${tokenRow.rows[0].token}`);
  assert.equal(get.status, 200);
  assert.equal(get.body.finalized, true, 'the celebration copy keys on this boolean');
  assert.equal(get.body.submitted_at, null);
  assert.ok(!('finalized_at' in get.body), 'the stamp itself stays off the public payload');
  assert.equal(get.body.status, 'reviewed');
});

test('unfinalize returns a never-submitted plan to draft, and leaves a client-submitted plan reviewed', async () => {
  const built = await seedPlan({ status: 'draft', listStatus: 'pending_review' });
  assert.equal((await getAction('shopping_list_approve').ensureSideEffects(built.planId, { sentBy: adminUserId })).beo.finalized, true);
  const un1 = await request('POST', `/api/drink-plans/${built.planId}/unfinalize`, { token: adminToken });
  assert.equal(un1.status, 200);
  const row1 = await planRow(built.planId);
  assert.equal(row1.finalized_at, null);
  assert.equal(row1.status, 'draft', 'reviewed without finalized_at would read as already submitted to the client');
  const tokenRow = await pool.query('SELECT token FROM drink_plans WHERE id = $1', [built.planId]);
  const put = await request('PUT', `/api/drink-plans/t/${tokenRow.rows[0].token}`, {
    body: { selections: { signatureDrinks: ['sd_1', 'sd_2'] }, status: 'draft' },
  });
  assert.equal(put.status, 200, `the client can pick their planner back up (${JSON.stringify(put.body)})`);

  const sent = await seedPlan({ status: 'submitted', listStatus: 'pending_review' });
  await pool.query('UPDATE drink_plans SET submitted_at = NOW() WHERE id = $1', [sent.planId]);
  assert.equal((await getAction('shopping_list_approve').ensureSideEffects(sent.planId, { sentBy: adminUserId })).beo.finalized, true);
  const un2 = await request('POST', `/api/drink-plans/${sent.planId}/unfinalize`, { token: adminToken });
  assert.equal(un2.status, 200);
  assert.equal((await planRow(sent.planId)).status, 'reviewed');
});
