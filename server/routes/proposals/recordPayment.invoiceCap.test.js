require('dotenv').config();
// Force notifications off regardless of local .env so the post-commit email
// path is a no-op during the test.
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('recordPayment.invoiceCap.test.js refuses to run against production');
}

// Stub the post-commit side effects that are NOT under test (client/admin
// email, marketing scheduling, shift auto-create) so the test stays hermetic
// and teardown stays simple. These are mutated on the cached module exports
// BEFORE ./actions is required, so the router's destructured references pick
// up the stubs. The money-ledger writes under test — proposals.amount_paid,
// proposal_payments, and invoice_payments via linkPaymentToInvoice — still run
// REAL against the database; the assertions read the real invoice rows back.
require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => {};
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};

const actionsRouter = require('./actions');

const PREFIX = 'recpay-cap-test-';
const NUM = Date.now();

let server, baseUrl;
let adminId, adminToken;
let clientId;
// Over-payment scenario
let overProposalId, overInvoiceId;
// Partial-payment (happy-path guard) scenario
let partProposalId, partInvoiceId;

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

    const cl = await c.query(
      `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
      ['Record Payment Cap Test Client', `${PREFIX}client@example.com`]
    );
    clientId = cl.rows[0].id;

    // ── Over-payment scenario ───────────────────────────────────────────────
    // total $3000, already paid $2800 → only $200 outstanding.
    const op = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price, amount_paid)
       VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'wedding', '5:00 PM', 4, 3000, 2800)
       RETURNING id`,
      [clientId]
    );
    overProposalId = op.rows[0].id;
    // Invoice for the $200 balance — amount_due is in CENTS (20000 = $200).
    const oi = await c.query(
      `INSERT INTO invoices (proposal_id, invoice_number, amount_due, amount_paid, status)
       VALUES ($1, $2, 20000, 0, 'sent') RETURNING id`,
      [overProposalId, `CAP${NUM}A`]
    );
    overInvoiceId = oi.rows[0].id;

    // ── Partial-payment guard scenario ──────────────────────────────────────
    // total $3000, paid $1000; record an exact $200 (no over-pay).
    const pp = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price, amount_paid)
       VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'wedding', '6:00 PM', 4, 3000, 1000)
       RETURNING id`,
      [clientId]
    );
    partProposalId = pp.rows[0].id;
    // Invoice for a $500 balance (50000 cents); we record only $200.
    const pi = await c.query(
      `INSERT INTO invoices (proposal_id, invoice_number, amount_due, amount_paid, status)
       VALUES ($1, $2, 50000, 0, 'sent') RETURNING id`,
      [partProposalId, `CAP${NUM}B`]
    );
    partInvoiceId = pi.rows[0].id;

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', actionsRouter);
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

  const invIds = [overInvoiceId, partInvoiceId].filter(Boolean);
  const propIds = [overProposalId, partProposalId].filter(Boolean);

  if (invIds.length) {
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id = ANY($1::int[])`, [invIds]);
    await pool.query(`DELETE FROM invoices WHERE id = ANY($1::int[])`, [invIds]);
  }
  if (propIds.length) {
    await pool.query(`DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])`, [propIds]);
    await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`, [propIds]);
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [propIds]);
  }
  if (clientId) await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  if (adminId) await pool.query(`DELETE FROM users WHERE id = $1`, [adminId]);

  await pool.end();
});

function postJson(path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => {
        let buf = '';
        res.on('data', (ch) => { buf += ch; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

// ── The bug (audit BLOCKER #1) ───────────────────────────────────────────────
// record-payment caps the proposal-side delta but linked the UNCAPPED amount to
// the invoice. Recording $5000 against a $200 balance must NOT push the
// invoice's amount_paid above its amount_due.
test('over-payment caps the invoice credit at amount_due (does not inflate the invoice ledger)', async () => {
  const r = await postJson(`/api/proposals/${overProposalId}/record-payment`, adminToken, { amount: 5000 });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
  const body = JSON.parse(r.body);

  // Proposal-side ledger is capped at the total (this was already correct).
  assert.equal(Number(body.amount_paid), 3000, 'proposal amount_paid should cap at total_price');

  const inv = (await pool.query(
    'SELECT amount_due, amount_paid, status, locked FROM invoices WHERE id = $1',
    [overInvoiceId]
  )).rows[0];

  // The invariant the bug violated: the invoice can never be paid beyond its due.
  assert.equal(inv.amount_paid, 20000, 'invoice amount_paid must equal the $200 balance (20000c), not the raw $5000');
  assert.equal(inv.amount_paid, inv.amount_due, 'invoice amount_paid must not exceed amount_due');
  assert.equal(inv.status, 'paid', 'invoice should be fully paid');
  assert.equal(inv.locked, true, 'fully paid invoice should be locked');
});

// ── Happy-path guard ─────────────────────────────────────────────────────────
// A normal partial payment (no over-pay) must still credit the exact amount.
test('partial payment credits the exact amount and stays partially_paid (unlocked)', async () => {
  const r = await postJson(`/api/proposals/${partProposalId}/record-payment`, adminToken, { amount: 200 });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
  const body = JSON.parse(r.body);
  assert.equal(Number(body.amount_paid), 1200, 'proposal amount_paid should be 1000 + 200');

  const inv = (await pool.query(
    'SELECT amount_due, amount_paid, status, locked FROM invoices WHERE id = $1',
    [partInvoiceId]
  )).rows[0];
  assert.equal(inv.amount_paid, 20000, 'invoice should be credited exactly $200 (20000c)');
  assert.equal(inv.status, 'partially_paid', 'invoice should remain partially paid');
  assert.equal(inv.locked, false, 'a partially paid invoice must not be locked');
});
