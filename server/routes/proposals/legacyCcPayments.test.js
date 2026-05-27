require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const crudRouter = require('./crud');

if (process.env.NODE_ENV === 'production') {
  throw new Error('legacyCcPayments.test.js refuses to run against production');
}

// Covers Batch 13a Task 23c — GET /api/proposals/:id/legacy-cc-payments. The
// endpoint is `adminOnly` per spec §11. We seed a proposal with two payment
// rows: one with a `legacy_charge_id` (must surface) and one without (must be
// filtered out). Manager token gets 403, admin gets 200 with only the legacy
// row.

const PREFIX = 'cc-legacypay-test-';

let server, baseUrl;
let adminId, adminToken;
let managerId, managerToken;
let clientId;
let proposalId;
let proposalEmptyId;
let legacyPaymentId;
let regularPaymentId;

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

    const cl = await c.query(
      `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
      ['Legacy CC Test Client', `${PREFIX}client@example.com`]
    );
    clientId = cl.rows[0].id;

    // Proposal #1 — has both a legacy and a regular payment row.
    const p1 = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price)
       VALUES ($1, CURRENT_DATE + INTERVAL '14 days', 'deposit_paid', 'wedding', '5:00 PM', 4, 3000)
       RETURNING id`,
      [clientId]
    );
    proposalId = p1.rows[0].id;

    // Proposal #2 — no payments at all, used for the empty-result case.
    const p2 = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price)
       VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'sent', 'wedding', '6:00 PM', 4, 2500)
       RETURNING id`,
      [clientId]
    );
    proposalEmptyId = p2.rows[0].id;

    // Legacy CC payment — has legacy_charge_id (ch_...). Must surface.
    const lp = await c.query(
      `INSERT INTO proposal_payments
         (proposal_id, payment_type, amount, status, legacy_charge_id, payment_method)
       VALUES ($1, 'deposit', 10000, 'succeeded', 'ch_legacycctest_001', 'card')
       RETURNING id`,
      [proposalId]
    );
    legacyPaymentId = lp.rows[0].id;

    // Regular DRB-native payment — no legacy_charge_id. Must NOT surface.
    const rp = await c.query(
      `INSERT INTO proposal_payments
         (proposal_id, payment_type, amount, status)
       VALUES ($1, 'balance', 20000, 'succeeded')
       RETURNING id`,
      [proposalId]
    );
    regularPaymentId = rp.rows[0].id;

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', crudRouter);
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

  const paymentIds = [legacyPaymentId, regularPaymentId].filter(Boolean);
  if (paymentIds.length) {
    await pool.query(`DELETE FROM proposal_payments WHERE id = ANY($1::int[])`, [paymentIds]);
  }
  const propIds = [proposalId, proposalEmptyId].filter(Boolean);
  if (propIds.length) {
    await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`, [propIds]);
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [propIds]);
  }
  if (clientId) await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);

  const userIds = [adminId, managerId].filter(Boolean);
  if (userIds.length) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  }

  await pool.end();
});

function req(method, path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
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
    r.end();
  });
}

// ── /api/proposals/:id/legacy-cc-payments ────────────────────────────

test('GET /:id/legacy-cc-payments 400 on non-integer id', async () => {
  const r = await req('GET', '/api/proposals/abc/legacy-cc-payments', adminToken);
  assert.equal(r.status, 400);
});

test('GET /:id/legacy-cc-payments 401 without token', async () => {
  const r = await req('GET', `/api/proposals/${proposalId}/legacy-cc-payments`, null);
  assert.equal(r.status, 401);
});

test('GET /:id/legacy-cc-payments 403 for manager token (adminOnly)', async () => {
  const r = await req('GET', `/api/proposals/${proposalId}/legacy-cc-payments`, managerToken);
  assert.equal(r.status, 403);
});

test('GET /:id/legacy-cc-payments 200 with empty array when no legacy payments', async () => {
  const r = await req('GET', `/api/proposals/${proposalEmptyId}/legacy-cc-payments`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.payments, []);
});

test('GET /:id/legacy-cc-payments 200 returns only rows with legacy_charge_id', async () => {
  const r = await req('GET', `/api/proposals/${proposalId}/legacy-cc-payments`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.payments.length, 1, 'only the legacy payment row should surface');
  assert.equal(body.payments[0].id, legacyPaymentId);
  assert.equal(body.payments[0].legacy_charge_id, 'ch_legacycctest_001');
  assert.equal(body.payments[0].amount, 10000);
  assert.equal(body.payments[0].payment_method, 'card');
  // The non-legacy regular payment row must NOT appear.
  const ids = body.payments.map(p => p.id);
  assert.ok(!ids.includes(regularPaymentId), 'regular payment must be filtered out');
});
