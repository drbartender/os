'use strict';

// Route-level tests for the `silent` publish flag on POST /api/comms/send.
// Mirrors the express()+node:http harness in server/routes/beo.test.js.
// Runs ALONE against the shared dev DB: node -r dotenv/config --test.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const commsRouter = require('./comms');
const drinkPlansRouter = require('./drinkPlans');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const CLIENT_EMAIL = `silent-pub-${NONCE}@example.test`;
let server, baseUrl, adminToken;
let clientId, proposalId, planId, planApprovedId, invoiceId;

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  const passwordHash = await bcrypt.hash('x', 4);
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`silent-pub-admin-${NONCE}@example.com`, passwordHash]
  );
  adminToken = jwt.sign(
    { userId: admin.rows[0].id, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Silent Pub', $1, '3125550188') RETURNING id`,
    [CLIENT_EMAIL]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'balance_paid', 'wedding-reception', 200000, 200000, CURRENT_DATE + INTERVAL '7 days', false)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  // Plan in pending_review with a real list AND a valid client email, so the
  // email channel is genuinely "available" (needed by the guard test).
  const dp = await pool.query(
    `INSERT INTO drink_plans (client_name, client_email, event_type, event_date, proposal_id, shopping_list, shopping_list_status)
     VALUES ('Silent Pub', $1, 'wedding-reception', CURRENT_DATE + INTERVAL '21 days', $2,
             '{"guestCount": 50, "liquorBeerWine": [], "everythingElse": []}'::jsonb, 'pending_review')
     RETURNING id`,
    [CLIENT_EMAIL, proposalId]
  );
  planId = dp.rows[0].id;
  // A second plan ALREADY approved (snapshot set) — an independent fixture for
  // the ever_approved GET and the already-approved no-op test, so neither leans
  // on test 1 having mutated planId.
  const dpa = await pool.query(
    `INSERT INTO drink_plans (client_name, client_email, event_type, event_date, proposal_id,
                              shopping_list, shopping_list_status, shopping_list_approved_at,
                              shopping_list_approved_snapshot)
     VALUES ('Silent Pub', $1, 'wedding-reception', CURRENT_DATE + INTERVAL '21 days', $2,
             '{"guestCount": 50, "liquorBeerWine": [], "everythingElse": []}'::jsonb,
             'approved', NOW(),
             '{"guestCount": 50, "liquorBeerWine": [], "everythingElse": []}'::jsonb)
     RETURNING id`,
    [CLIENT_EMAIL, proposalId]
  );
  planApprovedId = dpa.rows[0].id;
  // A DRAFT invoice for the ordering guard (invoice_send does NOT opt into silent).
  // invoice_number is VARCHAR(20); NONCE alone is ~20 chars, so keep it short.
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', 6000, 0, 'draft') RETURNING id`,
    [proposalId, `INV-${NONCE.slice(-12)}`]
  );
  invoiceId = inv.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/comms', commsRouter);
  app.use('/api/drink-plans', drinkPlansRouter);
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
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);
  await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE email = $1', [`silent-pub-admin-${NONCE}@example.com`]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('silent publish flips pending_review -> approved and sends nothing', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planId, channels: [], silent: true },
  });
  assert.strictEqual(res.status, 200);
  const row = (await pool.query(
    'SELECT shopping_list_status, shopping_list_approved_at FROM drink_plans WHERE id = $1', [planId]
  )).rows[0];
  assert.strictEqual(row.shopping_list_status, 'approved');
  assert.notStrictEqual(row.shopping_list_approved_at, null);
  const logged = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM message_log WHERE proposal_id = $1', [proposalId]
  )).rows[0].n;
  assert.strictEqual(logged, 0); // nothing sent, nothing ledgered
});

test('silent publish on an already-approved list is a no-op (stays approved, sends nothing)', async () => {
  const before = (await pool.query(
    'SELECT shopping_list_approved_at FROM drink_plans WHERE id = $1', [planApprovedId]
  )).rows[0];
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planApprovedId, channels: [], silent: true },
  });
  assert.strictEqual(res.status, 200);
  const after = (await pool.query(
    'SELECT shopping_list_status, shopping_list_approved_at FROM drink_plans WHERE id = $1', [planApprovedId]
  )).rows[0];
  assert.strictEqual(after.shopping_list_status, 'approved');
  // Idempotent: ensureSideEffects returned applied:false, so approved_at is untouched.
  assert.deepStrictEqual(after.shopping_list_approved_at, before.shopping_list_approved_at);
});

test('silent rejected for an action without allowSilent, and the invoice stays draft', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'invoice_send', entity_id: invoiceId, channels: [], silent: true },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.silent);
  const status = (await pool.query('SELECT status FROM invoices WHERE id = $1', [invoiceId])).rows[0].status;
  assert.strictEqual(status, 'draft'); // ensureSideEffects never ran
});

test('silent + non-empty channels is rejected', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planId, channels: ['email'], silent: true },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.channels);
});

test('silent + retry is rejected', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planId, channels: [], silent: true, retry: true },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.retry);
});

test('non-silent empty channels still rejected when a channel is available', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planId, channels: [] },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.channels);
});

test('GET shopping-list reports ever_approved once a snapshot exists', async () => {
  const res = await request('GET', `/api/drink-plans/${planApprovedId}/shopping-list`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ever_approved, true);
});
