require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../../db');
const { AppError } = require('../../../utils/errors');
const proposalActionsRouter = require('./proposalActions');
const { registerDrinkPlanNudgeHandlers } = require('../../../utils/drinkPlanNudge');

if (process.env.NODE_ENV === 'production') {
  throw new Error('proposalActions.test.js refuses to run against production');
}

// Production normally runs registerDrinkPlanNudgeHandlers() at server boot
// (server/index.js). The standalone test harness needs to register them so
// computeScheduledFor knows about 'drink_plan_nudge' / 'drink_plan_nudge_sms'.
registerDrinkPlanNudgeHandlers();

const PREFIX = 'cc-proposalActions-test-';

// Fixture handles
let server, baseUrl;
let adminId, adminToken;
let managerId, managerToken;
let staffId, staffToken; // for the 403 test
let clientId;
let proposalWithPlanId; // proposal that HAS a drink plan
let proposalNoPlanId;   // proposal with NO drink plan
let drinkPlanId;

before(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const a = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
      [`${PREFIX}admin@example.com`]
    );
    adminId = a.rows[0].id;
    adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

    const m = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'manager') RETURNING id`,
      [`${PREFIX}manager@example.com`]
    );
    managerId = m.rows[0].id;
    managerToken = jwt.sign({ userId: managerId, tokenVersion: 0 }, process.env.JWT_SECRET);

    const s = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${PREFIX}staff@example.com`]
    );
    staffId = s.rows[0].id;
    staffToken = jwt.sign({ userId: staffId, tokenVersion: 0 }, process.env.JWT_SECRET);

    const cl = await c.query(
      `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
      ['Proposal Actions Client', `${PREFIX}client@example.com`]
    );
    clientId = cl.rows[0].id;

    // Two proposals: one with a drink plan, one without.
    const p1 = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price)
       VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'confirmed', 'wedding', '5:00 PM', 4, 2500)
       RETURNING id`,
      [clientId]
    );
    proposalWithPlanId = p1.rows[0].id;
    const p2 = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price)
       VALUES ($1, CURRENT_DATE + INTERVAL '40 days', 'confirmed', 'birthday-party', '6:00 PM', 3, 1500)
       RETURNING id`,
      [clientId]
    );
    proposalNoPlanId = p2.rows[0].id;

    const dp = await c.query(
      `INSERT INTO drink_plans (proposal_id, client_name, client_email, event_date, status)
       VALUES ($1, $2, $3, CURRENT_DATE + INTERVAL '30 days', 'submitted') RETURNING id`,
      [proposalWithPlanId, 'Proposal Actions Client', `${PREFIX}client@example.com`]
    );
    drinkPlanId = dp.rows[0].id;

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/admin', proposalActionsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));

  if (drinkPlanId) {
    await pool.query(`DELETE FROM drink_plans WHERE id = $1`, [drinkPlanId]);
  }
  const propIds = [proposalWithPlanId, proposalNoPlanId].filter(Boolean);
  if (propIds.length) {
    // Clear any scheduled_messages emitted by the success test before deleting
    // the parent proposal. scheduleDrinkPlanNudge inserts via scheduleMessage,
    // which targets entity_type='proposal'.
    await pool.query(
      `DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1::int[])`,
      [propIds]
    );
    await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`, [propIds]);
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [propIds]);
  }
  if (clientId) await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);

  const userIds = [adminId, managerId, staffId].filter(Boolean);
  for (const uid of userIds) {
    await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id = $1 OR target_user_id = $1`, [uid]);
  }
  // Audit rows reference the test client (targetUserId is client_id). Clean by
  // action+recent so we don't leave audit rows pointing at a deleted client.
  await pool.query(
    `DELETE FROM admin_audit_log
      WHERE action IN ('cc_drink_plan_nudge_reenrolled','cc_payout_reaccrued')
        AND created_at > NOW() - INTERVAL '1 hour'`
  );
  for (const uid of userIds) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [uid]);
  }

  await pool.end();
});

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request(
      {
        method, hostname: url.hostname, port: url.port,
        path: url.pathname + (url.search || ''), headers,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── /proposals/:id/reenroll-drink-plan-nudge ─────────────────────────

test('POST /proposals/:id/reenroll-drink-plan-nudge rejects non-integer id', async () => {
  const r = await req('POST', '/api/admin/proposals/abc/reenroll-drink-plan-nudge', adminToken, {});
  assert.equal(r.status, 400);
});

test('POST /proposals/:id/reenroll-drink-plan-nudge 401 without token', async () => {
  const r = await req('POST', `/api/admin/proposals/${proposalWithPlanId}/reenroll-drink-plan-nudge`, null, {});
  assert.equal(r.status, 401);
});

test('POST /proposals/:id/reenroll-drink-plan-nudge 403 for non-admin/manager role', async () => {
  const r = await req('POST', `/api/admin/proposals/${proposalWithPlanId}/reenroll-drink-plan-nudge`, staffToken, {});
  assert.equal(r.status, 403);
});

test('POST /proposals/:id/reenroll-drink-plan-nudge 404 on unknown proposal', async () => {
  const r = await req('POST', '/api/admin/proposals/999999999/reenroll-drink-plan-nudge', adminToken, {});
  assert.equal(r.status, 404);
});

test('POST /proposals/:id/reenroll-drink-plan-nudge 409 when no drink plan exists', async () => {
  const r = await req('POST', `/api/admin/proposals/${proposalNoPlanId}/reenroll-drink-plan-nudge`, adminToken, {});
  assert.equal(r.status, 409);
});

test('POST /proposals/:id/reenroll-drink-plan-nudge succeeds + writes audit row', async () => {
  const r = await req('POST', `/api/admin/proposals/${proposalWithPlanId}/reenroll-drink-plan-nudge`, adminToken, {});
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.ok, true);
  assert.match(body.message, /scheduled/i);

  const audit = await pool.query(
    `SELECT actor_user_id, target_user_id, action, metadata FROM admin_audit_log
      WHERE action = 'cc_drink_plan_nudge_reenrolled'
        AND actor_user_id = $1
      ORDER BY id DESC LIMIT 1`,
    [adminId]
  );
  assert.equal(audit.rowCount, 1, 'audit row exists');
  assert.equal(audit.rows[0].target_user_id, null);
  assert.equal(audit.rows[0].metadata.proposal_id, proposalWithPlanId);
  assert.equal(audit.rows[0].metadata.client_id, clientId);
});

// ── /proposals/:id/reaccrue-payout ───────────────────────────────────

test('POST /proposals/:id/reaccrue-payout rejects non-integer id', async () => {
  const r = await req('POST', '/api/admin/proposals/abc/reaccrue-payout', adminToken, {});
  assert.equal(r.status, 400);
});

test('POST /proposals/:id/reaccrue-payout 404 on unknown proposal', async () => {
  const r = await req('POST', '/api/admin/proposals/999999999/reaccrue-payout', adminToken, {});
  assert.equal(r.status, 404);
});

test('POST /proposals/:id/reaccrue-payout succeeds (returns result + writes audit)', async () => {
  const r = await req('POST', `/api/admin/proposals/${proposalWithPlanId}/reaccrue-payout`, adminToken, {});
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.result && typeof body.result === 'object',
    'result field is an object (skipped or completed)');

  const audit = await pool.query(
    `SELECT actor_user_id, target_user_id, action, metadata FROM admin_audit_log
      WHERE action = 'cc_payout_reaccrued'
        AND actor_user_id = $1
      ORDER BY id DESC LIMIT 1`,
    [adminId]
  );
  assert.equal(audit.rowCount, 1, 'audit row exists');
  assert.equal(audit.rows[0].target_user_id, null);
  assert.equal(audit.rows[0].metadata.proposal_id, proposalWithPlanId);
  assert.equal(audit.rows[0].metadata.client_id, clientId);
});
