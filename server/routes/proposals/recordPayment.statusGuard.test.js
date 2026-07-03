require('dotenv').config();
// Force notifications off regardless of local .env (defense in depth — the 409
// path never reaches the post-commit email code, but keep parity with sibling
// record-payment suites).
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('recordPayment.statusGuard.test.js refuses to run against production');
}

// Stub the post-commit side effects NOT under test so a would-be regression
// (old code letting the payment through) can't fan out real work.
require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => {};
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};

const actionsRouter = require('./actions');

const PREFIX = 'recpay-statusguard-';

let server, baseUrl;
let adminId, adminToken, clientId, completedId, archivedId;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
    [`${PREFIX}admin@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const cl = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
    ['Record Payment Status Guard Client', `${PREFIX}client@example.com`]
  );
  clientId = cl.rows[0].id;

  // A completed, fully-paid event and an archived proposal. Neither may take a
  // manual payment (which would downgrade status back to balance_paid/deposit_paid).
  const done = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid)
     VALUES ($1, CURRENT_DATE - INTERVAL '7 days', 'completed', 'wedding', '5:00 PM', 4, 3000, 3000)
     RETURNING id`,
    [clientId]
  );
  completedId = done.rows[0].id;

  const arch = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'archived', 'wedding', '5:00 PM', 4, 3000, 0)
     RETURNING id`,
    [clientId]
  );
  archivedId = arch.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', actionsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const id of [completedId, archivedId]) {
    if (!id) continue;
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function postJson(path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => { let buf = ''; res.on('data', (ch) => { buf += ch; }); res.on('end', () => resolve({ status: res.statusCode, body: buf })); }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('record-payment on a COMPLETED proposal 409s and does not downgrade status or record a payment', async () => {
  const r = await postJson(`/api/proposals/${completedId}/record-payment`, adminToken, { amount: 500 });
  assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.body}`);
  assert.equal(JSON.parse(r.body).code, 'ALREADY_PAID_IN_FULL');

  const prop = (await pool.query('SELECT status, amount_paid FROM proposals WHERE id = $1', [completedId])).rows[0];
  assert.equal(prop.status, 'completed', 'status must stay completed, never downgraded to balance_paid');
  assert.equal(Number(prop.amount_paid), 3000, 'amount_paid unchanged');

  const pays = (await pool.query(
    "SELECT COUNT(*)::int AS c FROM proposal_payments WHERE proposal_id = $1", [completedId]
  )).rows[0].c;
  assert.equal(pays, 0, 'no payment row recorded against a completed proposal');
});

test('record-payment on an ARCHIVED proposal 409s and does not reactivate it', async () => {
  const r = await postJson(`/api/proposals/${archivedId}/record-payment`, adminToken, { amount: 500 });
  assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.body}`);
  assert.equal(JSON.parse(r.body).code, 'ALREADY_PAID_IN_FULL');

  const prop = (await pool.query('SELECT status, amount_paid FROM proposals WHERE id = $1', [archivedId])).rows[0];
  assert.equal(prop.status, 'archived', 'status must stay archived, never reactivated');
  assert.equal(Number(prop.amount_paid), 0, 'amount_paid unchanged');

  const pays = (await pool.query(
    "SELECT COUNT(*)::int AS c FROM proposal_payments WHERE proposal_id = $1", [archivedId]
  )).rows[0].c;
  assert.equal(pays, 0, 'no payment row recorded against an archived proposal');
});
