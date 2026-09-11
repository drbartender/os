require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Hosted packages never owe the client a shopping list (DRB stocks the bar), so
// none of the three server-side list writers may stage one on a hosted plan:
// the post-submit auto-gen, the admin consult save, and the post-Lab refresh.
// Found 2026-09-10: every writer ran on package-blind plan rows, so a hosted
// client sat in the prep queue as "shopping list needs review" two days out.
//
// One fixture set pins all three writers plus the list route's
// package_category projection (what the prep queue reads to skip hosted).
// Control cases on a BYOB (flat) package and on a package-less plan prove the
// gate is the PACKAGE, never a broken fixture. Harness per submitPlannerV2:
// real routers over HTTP against the dev DB, nonce-suffixed rows, full
// teardown. Run ALONE (shared dev DB):
//   node --test server/routes/drinkPlans/hostedNoList.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { autoGenerateShoppingList } = require('../../utils/shoppingListGen');
const { refreshListAfterLabChange } = require('./labListRefresh');
const drinkPlansRouter = require('../drinkPlans');
const drinkPlanConsultRouter = require('../drinkPlanConsult');

if (process.env.NODE_ENV === 'production') {
  throw new Error('hostedNoList.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken, clientId;
let hostedPkgId, byobPkgId, classPkgId;
const proposalIds = [];
const planIds = {};

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function seedPackage(key, category, pricingType, barType) {
  const r = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, $2, $3, $4, 28, 33, 50, 100, $5, '[]') RETURNING id`,
    [`hnl-${key}-${NONCE}`, `HNL ${key} ${NONCE}`, category, pricingType, barType]
  );
  return r.rows[0].id;
}

// A submitted plan (submitted_at set, empty picks) on a proposal carrying the
// given package. `status: 'pending'` seeds the consult-path shape instead;
// `existingList: { status, source }` pre-seeds a list on the row (an empty one,
// so a regeneration is visible as the baseline items appearing).
async function seedPlan(key, packageId, { status = 'submitted', existingList = null } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 80, 0, 2000, 100, '{}'::jsonb)
     RETURNING id`,
    [clientId, packageId]
  );
  proposalIds.push(p.rows[0].id);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, submitted_at, client_name, client_email)
     VALUES ($1, $2, '{"signatureDrinks":[],"mocktails":[]}'::jsonb, $3, $4, $5)
     RETURNING id`,
    [p.rows[0].id, status, status === 'submitted' ? new Date() : null,
      `HNL ${key} ${NONCE}`, `hnl-${NONCE}@example.com`]
  );
  planIds[key] = dp.rows[0].id;
  if (existingList) {
    await pool.query(
      // Values computed here, never compared in SQL against a parameter that is
      // also bound to a column: pg deduces two types for it and refuses.
      `UPDATE drink_plans
          SET shopping_list = '{"guestCount": 80, "liquorBeerWine": [], "everythingElse": []}'::jsonb,
              shopping_list_status = $2,
              shopping_list_approved_at = $3,
              shopping_list_source = $4,
              consult_selections = CASE WHEN $5::boolean THEN '{}'::jsonb ELSE consult_selections END,
              consult_filled_at = CASE WHEN $5::boolean THEN NOW() ELSE consult_filled_at END
        WHERE id = $1`,
      [dp.rows[0].id, existingList.status,
        existingList.status === 'approved' ? new Date() : null,
        existingList.source, existingList.source === 'consult']
    );
  }
  return dp.rows[0].id;
}

async function listState(planId) {
  const r = await pool.query(
    `SELECT shopping_list IS NOT NULL AS has_list, shopping_list_status, shopping_list_source,
            consult_filled_at, consult_selections,
            jsonb_array_length(COALESCE(shopping_list->'everythingElse', '[]'::jsonb)) AS everything_else_count
       FROM drink_plans WHERE id = $1`,
    [planId]
  );
  return r.rows[0];
}

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`hnl-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`HNL Client ${NONCE}`, `hnl-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  hostedPkgId = await seedPackage('hosted', 'hosted', 'per_guest', 'full_bar');
  byobPkgId = await seedPackage('byob', 'byob', 'flat', 'service_only');
  // Cocktail classes are seeded category 'hosted' but sell an optional supplies
  // add-on, so a self-supplying class client still needs a list (pricingEngine
  // exempts bar_type 'class' from the hosted rule the same way).
  classPkgId = await seedPackage('class', 'hosted', 'per_guest', 'class');

  await seedPlan('hostedAuto', hostedPkgId);
  await seedPlan('byobAuto', byobPkgId);
  await seedPlan('noPkgAuto', null);
  await seedPlan('classAuto', classPkgId);
  await seedPlan('hostedLab', hostedPkgId);
  await seedPlan('hostedLabExisting', hostedPkgId, { existingList: { status: 'pending_review', source: 'planner' } });
  await seedPlan('byobLab', byobPkgId);
  await seedPlan('hostedConsult', hostedPkgId, { status: 'pending' });
  await seedPlan('byobConsult', byobPkgId, { status: 'pending' });
  await seedPlan('hostedConsultExisting', hostedPkgId, { status: 'pending', existingList: { status: 'approved', source: 'consult' } });

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use('/api/drink-plans', drinkPlanConsultRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    console.error('unexpected test-harness error:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const ids = Object.values(planIds);
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1::int[])", [proposalIds]);
  await pool.query('DELETE FROM message_log WHERE proposal_id = ANY($1::int[])', [proposalIds]);
  await pool.query('DELETE FROM consults WHERE proposal_id = ANY($1::int[])', [proposalIds]);
  await pool.query('DELETE FROM drink_plans WHERE id = ANY($1::int[])', [ids]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  await pool.query('DELETE FROM service_packages WHERE id = ANY($1::int[])', [[hostedPkgId, byobPkgId, classPkgId]]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

// ─── Writer 1: post-submit auto-gen ─────────────────────────────────────────

test('auto-gen stages nothing on a hosted plan', async () => {
  const out = await autoGenerateShoppingList(planIds.hostedAuto, pool);
  assert.equal(out, null, 'returns null, exactly like the no-guest-count skip');
  const row = await listState(planIds.hostedAuto);
  assert.equal(row.has_list, false, 'no list stored');
  assert.equal(row.shopping_list_status, null, 'no pending_review to badge or queue');
});

test('auto-gen still stages a pending_review list on a BYOB plan (control)', async () => {
  const out = await autoGenerateShoppingList(planIds.byobAuto, pool);
  assert.ok(out && typeof out === 'object', 'a list came back');
  const row = await listState(planIds.byobAuto);
  assert.equal(row.has_list, true);
  assert.equal(row.shopping_list_status, 'pending_review');
  assert.equal(row.shopping_list_source, 'planner');
});

test('auto-gen fails open to BYOB on a plan whose proposal has no package', async () => {
  await autoGenerateShoppingList(planIds.noPkgAuto, pool);
  const row = await listState(planIds.noPkgAuto);
  assert.equal(row.has_list, true, 'unknown package is treated as BYOB, never as hosted');
});

test('auto-gen still stages a list on a cocktail-class package', async () => {
  await autoGenerateShoppingList(planIds.classAuto, pool);
  const row = await listState(planIds.classAuto);
  assert.equal(row.has_list, true, 'a class client may self-supply, so the list is still owed');
  assert.equal(row.shopping_list_status, 'pending_review');
});

// ─── Writer 2: post-Lab refresh ──────────────────────────────────────────────

test('lab refresh builds no list on a hosted plan', async () => {
  await refreshListAfterLabChange(planIds.hostedLab);
  const row = await listState(planIds.hostedLab);
  assert.equal(row.has_list, false);
  assert.equal(row.shopping_list_status, null);
});

test('lab refresh keeps an existing hosted list in step, same as consult save', async () => {
  const before = await listState(planIds.hostedLabExisting);
  assert.equal(before.everything_else_count, 0, 'seeded empty so a rebuild is visible');
  await refreshListAfterLabChange(planIds.hostedLabExisting);
  const row = await listState(planIds.hostedLabExisting);
  assert.equal(row.has_list, true);
  assert.equal(row.shopping_list_status, 'pending_review');
  assert.ok(row.everything_else_count > 0, 'the list was rebuilt: hosted never STAGES a list, but maintains one that exists');
});

test('lab refresh still rebuilds a BYOB plan (control)', async () => {
  await refreshListAfterLabChange(planIds.byobLab);
  const row = await listState(planIds.byobLab);
  assert.equal(row.has_list, true);
  assert.equal(row.shopping_list_status, 'pending_review');
});

// ─── Writer 3: admin consult save ────────────────────────────────────────────

test('consult save on a hosted plan records the consult but stages no list', async () => {
  const r = await request('PUT', `/api/drink-plans/${planIds.hostedConsult}/consult`, {
    body: { consult: { spirits: ['vodka'] } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.list_staged, false, 'the response says no list was staged');
  const row = await listState(planIds.hostedConsult);
  assert.ok(row.consult_filled_at, 'the write-up itself is saved');
  assert.deepEqual(row.consult_selections, { spirits: ['vodka'] });
  assert.equal(row.has_list, false, 'no list from the consult form on hosted');
  assert.equal(row.shopping_list_status, null);
  assert.equal(row.shopping_list_source, 'consult',
    'the consult is still recorded as the input source, so a later admin-built list builds from it');
});

test('consult save on a hosted plan that already carries a list regenerates it and resets approval', async () => {
  const r = await request('PUT', `/api/drink-plans/${planIds.hostedConsultExisting}/consult`, {
    body: { consult: { spirits: ['gin'] } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.list_staged, true);
  const row = await listState(planIds.hostedConsultExisting);
  assert.equal(row.has_list, true, 'an existing list is kept in step with the consult, as before the gate');
  assert.equal(row.shopping_list_status, 'pending_review', 'a stale approved list stops being served until re-approved');
  assert.equal(row.shopping_list_source, 'consult');
});

test('consult save on a BYOB plan stages a consult-sourced list (control)', async () => {
  const r = await request('PUT', `/api/drink-plans/${planIds.byobConsult}/consult`, {
    body: { consult: { spirits: ['vodka'] } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.list_staged, true);
  const row = await listState(planIds.byobConsult);
  assert.equal(row.has_list, true);
  assert.equal(row.shopping_list_status, 'pending_review');
  assert.equal(row.shopping_list_source, 'consult');
});

// ─── The list the prep queue reads ───────────────────────────────────────────

test('GET /api/drink-plans carries package_category so the prep queue can skip hosted', async () => {
  const r = await request('GET', `/api/drink-plans?search=${encodeURIComponent(NONCE)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = Array.isArray(r.body) ? r.body : (r.body && r.body.plans) || [];
  const hosted = rows.find((p) => p.id === planIds.hostedAuto);
  const byob = rows.find((p) => p.id === planIds.byobAuto);
  const noPkg = rows.find((p) => p.id === planIds.noPkgAuto);
  const cls = rows.find((p) => p.id === planIds.classAuto);
  assert.ok(hosted && byob && noPkg && cls, 'all four fixture plans are listed');
  assert.equal(hosted.package_category, 'hosted');
  assert.equal(hosted.package_bar_type, 'full_bar');
  assert.equal(byob.package_category, 'byob');
  assert.equal(cls.package_category, 'hosted');
  assert.equal(cls.package_bar_type, 'class', 'the class exception rides on bar_type');
  assert.equal(noPkg.package_category, null, 'a package-less plan reads null, not a guess');
});
