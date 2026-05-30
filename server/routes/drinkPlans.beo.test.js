require('dotenv').config();

// Route-level tests for POST /api/drink-plans/:id/finalize.
//
// HARNESS NOTES
// -------------
// Mirrors the hand-rolled pattern in server/routes/beo.test.js and crud.test.js:
// the repo has no supertest/jest/mocha — every existing route test stands up a
// minimal express() app, mounts the real router, attaches the real auth
// middleware (already inside the router via drinkPlans.js's auth call), and
// drives the surface over real HTTP via node's built-in `http` module. The
// error handler mirrors server/index.js so a thrown AppError becomes the right
// status + JSON.
//
// Tests run against the dev database (DATABASE_URL pulled from ../../os/.env
// via the npm-test-runner's bash prefix). Every row this file inserts is
// cleaned up in after(). User emails are nonce-suffixed so stale rows from a
// crashed prior run can't collide with the unique-index on users.email.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const drinkPlansRouter = require('./drinkPlans');
const drinkPlanConsultRouter = require('./drinkPlanConsult');

// ─── Shared harness state ──────────────────────────────────────────────────
let server;
let baseUrl;
let adminToken;
let adminUserId;
let clientId;
let proposalId;
let drinkPlanId;
let shiftId;
let staffUserId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // Belt-and-suspenders: purge any stale rows from a previous crashed run.
  // The unique-key on users.email will reject the inserts below if these still
  // exist with the same address.
  await pool.query("DELETE FROM users WHERE email LIKE 'fin-route-%'");

  const passwordHash = await bcrypt.hash('x', 4);

  // Admin user
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`fin-route-admin-${NONCE}@example.com`, passwordHash]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminUserId, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Staff user with approved shift on the test proposal (so the nudge schedule
  // helper inserts a row — it filters on onboarding_status='approved').
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`fin-route-staff-${NONCE}@example.com`, passwordHash]
  );
  staffUserId = s.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name)
     VALUES ($1, '+15555550199', 'Fin Staff')`,
    [staffUserId]
  );

  // Client + proposal + drink_plan + shift + approved request
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551111') RETURNING id",
    [`Fin Route Test ${NONCE}`, `fin-route-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  // No UNIQUE on drink_plans.proposal_id — check-then-insert to guard against
  // any future auto-create trigger or a leaked row from a prior test run.
  const existingDp = await pool.query(
    'SELECT id FROM drink_plans WHERE proposal_id = $1', [proposalId]
  );
  if (existingDp.rowCount) {
    drinkPlanId = existingDp.rows[0].id;
    await pool.query(
      `UPDATE drink_plans
          SET status='reviewed',
              selections='{"signatureDrinks":["sd_1"]}'::jsonb,
              finalized_at = NULL,
              finalized_by = NULL
        WHERE id = $1`,
      [drinkPlanId]
    );
  } else {
    const dp = await pool.query(
      `INSERT INTO drink_plans (proposal_id, status, selections)
       VALUES ($1, 'reviewed', '{"signatureDrinks":["sd_1"]}'::jsonb) RETURNING id`,
      [proposalId]
    );
    drinkPlanId = dp.rows[0].id;
  }

  const sh = await pool.query(
    "INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id",
    [proposalId]
  );
  shiftId = sh.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')",
    [shiftId, staffUserId]
  );

  // Minimal app: real router + AppError-aware error handler matching server/index.js.
  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use('/api/drink-plans', drinkPlanConsultRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

// ─── Teardown ───────────────────────────────────────────────────────────────
after(async () => {
  await pool.query(
    "DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id=$1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id=$1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id=$1", [proposalId]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id=$1", [staffUserId]);
  await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [adminUserId, staffUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Tests ─────────────────────────────────────────────────────────────────
//
// Test order is load-bearing. The 200 case sets finalized_at; the second test
// confirms the already-finalized 409; later tests mutate plan/proposal state
// to force the remaining 409 branches and reset afterward.

test('POST /:id/finalize > succeeds when reviewed with selections', async () => {
  const res = await request('POST', `/api/drink-plans/${drinkPlanId}/finalize`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.finalized_at, 'response should include finalized_at');
  // Activity log entry
  const log = await pool.query(
    "SELECT action, actor_id FROM proposal_activity_log WHERE proposal_id=$1 AND action='beo_finalized'",
    [proposalId]
  );
  assert.strictEqual(log.rows.length, 1);
  assert.strictEqual(log.rows[0].actor_id, adminUserId);
  // BEO nudge row scheduled
  const sm = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND message_type='beo_unack_nudge_sms'",
    [proposalId]
  );
  assert.strictEqual(Number(sm.rows[0].count), 1);
});

test('POST /:id/finalize > 409 already_finalized when finalized_at set', async () => {
  const res = await request('POST', `/api/drink-plans/${drinkPlanId}/finalize`, { token: adminToken });
  assert.strictEqual(res.status, 409);
});

test('POST /:id/finalize > 409 not_reviewed when status is submitted', async () => {
  await pool.query("UPDATE drink_plans SET finalized_at = NULL, status='submitted' WHERE id = $1", [drinkPlanId]);
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1", [proposalId]);
  const res = await request('POST', `/api/drink-plans/${drinkPlanId}/finalize`, { token: adminToken });
  assert.strictEqual(res.status, 409);
  await pool.query("UPDATE drink_plans SET status='reviewed' WHERE id = $1", [drinkPlanId]);
});

test('POST /:id/finalize > 409 no_selections when empty', async () => {
  await pool.query("UPDATE drink_plans SET selections = '{}'::jsonb WHERE id = $1", [drinkPlanId]);
  const res = await request('POST', `/api/drink-plans/${drinkPlanId}/finalize`, { token: adminToken });
  assert.strictEqual(res.status, 409);
  await pool.query(
    "UPDATE drink_plans SET selections = '{\"signatureDrinks\":[\"sd_1\"]}'::jsonb WHERE id = $1",
    [drinkPlanId]
  );
});

test('POST /:id/finalize > 409 archived when proposal archived', async () => {
  await pool.query("UPDATE proposals SET status='archived' WHERE id = $1", [proposalId]);
  const res = await request('POST', `/api/drink-plans/${drinkPlanId}/finalize`, { token: adminToken });
  assert.strictEqual(res.status, 409);
  await pool.query("UPDATE proposals SET status='deposit_paid' WHERE id = $1", [proposalId]);
});

// ─── Unfinalize tests ───────────────────────────────────────────────────────
//
// The first test re-finalizes (the prior block left finalized_at=NULL), then
// seeds an ack + a sent nudge row + a fresh pending nudge row, then unfinalizes
// and asserts: finalized_at/finalized_by cleared, ack cleared, pending flipped
// to suppressed, sent row preserved. The second test runs against the now-
// unfinalized plan to exercise the 409.

test('POST /:id/unfinalize > clears finalized_at, acks, suppresses pending', async () => {
  // Finalize first (success path resets state and schedules a pending nudge)
  await request('POST', `/api/drink-plans/${drinkPlanId}/finalize`, { token: adminToken });
  // Manually stamp an ack
  await pool.query("UPDATE shift_requests SET beo_acknowledged_at = NOW() WHERE shift_id = $1", [shiftId]);
  // Manually mark one row sent (for the audit-preserve assertion)
  await pool.query(
    "UPDATE scheduled_messages SET status='sent', sent_at=NOW() WHERE entity_id=$1 AND message_type='beo_unack_nudge_sms'",
    [proposalId]
  );
  // Add a fresh pending row (different recipient_id so it doesn't collide)
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ($1, 'proposal', 'beo_unack_nudge_sms', 'staff', $2, 'sms', NOW() + INTERVAL '1 hour', 'pending')`,
    [proposalId, staffUserId + 1000]
  );

  const res = await request('POST', `/api/drink-plans/${drinkPlanId}/unfinalize`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.finalized_at, null);

  const dp = await pool.query("SELECT finalized_at, finalized_by FROM drink_plans WHERE id = $1", [drinkPlanId]);
  assert.strictEqual(dp.rows[0].finalized_at, null);
  assert.strictEqual(dp.rows[0].finalized_by, null);

  const sr = await pool.query("SELECT beo_acknowledged_at FROM shift_requests WHERE shift_id = $1", [shiftId]);
  assert.strictEqual(sr.rows[0].beo_acknowledged_at, null);

  const sm = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='beo_unack_nudge_sms' ORDER BY status",
    [proposalId]
  );
  // sent stays sent; pending flipped to suppressed
  assert.deepStrictEqual(sm.rows.map((r) => r.status).sort(), ['sent', 'suppressed']);
});

test('POST /:id/unfinalize > 409 when not finalized', async () => {
  const res = await request('POST', `/api/drink-plans/${drinkPlanId}/unfinalize`, { token: adminToken });
  assert.strictEqual(res.status, 409);
});

// ─── Lock-when-finalized tests (Task 17) ────────────────────────────────────
//
// Every mutation route refuses while finalized_at is set. Helper re-stamps the
// row before each test so a single 200 path (the finalize tests above) does
// not pollute the lock-check state. Each test asserts only the 409 shape; the
// existing 200-path tests cover the happy path elsewhere.

async function reFinalize() {
  await pool.query(
    'UPDATE drink_plans SET finalized_at = NOW(), finalized_by = $2 WHERE id = $1',
    [drinkPlanId, adminUserId]
  );
}

test('PATCH /:id/status > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('PATCH', `/api/drink-plans/${drinkPlanId}/status`, { token: adminToken, body: { status: 'submitted' } });
  assert.strictEqual(res.status, 409);
});

test('PATCH /:id/notes > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('PATCH', `/api/drink-plans/${drinkPlanId}/notes`, { token: adminToken, body: { admin_notes: 'updated' } });
  assert.strictEqual(res.status, 409);
});

test('PUT /:id/shopping-list > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('PUT', `/api/drink-plans/${drinkPlanId}/shopping-list`, { token: adminToken, body: { shopping_list: { items: [] } } });
  assert.strictEqual(res.status, 409);
});

test('PATCH /:id/shopping-list/approve > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('PATCH', `/api/drink-plans/${drinkPlanId}/shopping-list/approve`, { token: adminToken });
  assert.strictEqual(res.status, 409);
});

test('DELETE /:id/logo > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('DELETE', `/api/drink-plans/${drinkPlanId}/logo`, { token: adminToken });
  assert.strictEqual(res.status, 409);
});

test('DELETE /:id > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('DELETE', `/api/drink-plans/${drinkPlanId}`, { token: adminToken });
  assert.strictEqual(res.status, 409);
});

// POST /:id/logo — multipart route, but the lock check fires before
// express-fileupload runs (the route is mounted without that middleware in
// this test harness, so the handler is reached, hits ensureNotFinalized first,
// and returns 409 before the missing-file check ever runs). Confirms the guard
// short-circuits before any body work.
test('POST /:id/logo > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('POST', `/api/drink-plans/${drinkPlanId}/logo`, { token: adminToken });
  assert.strictEqual(res.status, 409);
});

test('PUT /t/:token > 409 when finalized', async () => {
  await reFinalize();
  const tok = (await pool.query('SELECT token FROM drink_plans WHERE id = $1', [drinkPlanId])).rows[0].token;
  const res = await request('PUT', `/api/drink-plans/t/${tok}`, { body: { selections: {} } });
  assert.strictEqual(res.status, 409);
});

test('POST /t/:token/logo > 409 when finalized', async () => {
  await reFinalize();
  const tok = (await pool.query('SELECT token FROM drink_plans WHERE id = $1', [drinkPlanId])).rows[0].token;
  const res = await request('POST', `/api/drink-plans/t/${tok}/logo`);
  assert.strictEqual(res.status, 409);
});

// ─── drinkPlanConsult.js routes (Task 18) ──────────────────────────────────
//
// Same flat lock-check shape as the drinkPlans.js routes above: refinalize,
// hit the route, expect 409. The consult router is mounted on the same
// /api/drink-plans base in server/index.js, so the test harness mirrors that
// by mounting both routers on the same prefix above.

test('PUT /:id/consult > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('PUT', `/api/drink-plans/${drinkPlanId}/consult`, { token: adminToken, body: { consult: { barType: 'full_bar' } } });
  assert.strictEqual(res.status, 409);
});

test('PATCH /:id/shopping-list-source > 409 when finalized', async () => {
  await reFinalize();
  const res = await request('PATCH', `/api/drink-plans/${drinkPlanId}/shopping-list-source`, { token: adminToken, body: { source: 'planner' } });
  assert.strictEqual(res.status, 409);
});
