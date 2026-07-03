require('dotenv').config();
// Force notifications off regardless of local .env so the post-commit email path
// is a no-op during the test.
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('recordPayment.staleRead.test.js refuses to run against production');
}

// Stub the post-commit side effects NOT under test (client/admin email, marketing
// scheduling, shift auto-create), mutated on the cached module exports BEFORE
// ./actions is required so the router's destructured refs pick up the stubs. The
// money-ledger writes under test (proposals.amount_paid, proposal_payments, and
// invoice_payments via linkPaymentToInvoice) still run REAL against the database.
require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => {};
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};

const actionsRouter = require('./actions');

const PREFIX = 'recpay-stale-test-';
const NUM = Date.now();

let server, baseUrl;
let adminId, adminToken, clientId, proposalId, invoiceId;

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
      ['Record Payment Stale Read Client', `${PREFIX}client@example.com`]
    );
    clientId = cl.rows[0].id;

    // total $3000, nothing paid yet, deposit_paid; the client's ONLY proposal
    // (so the same-client sweep finds no alternatives).
    const p = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price, amount_paid)
       VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'wedding', '5:00 PM', 4, 3000, 0)
       RETURNING id`,
      [clientId]
    );
    proposalId = p.rows[0].id;

    // Open invoice for the full $3000 (300000 cents) so it stays partially_paid
    // (never fully paid / locked) after both $1000 payments land.
    const inv = await c.query(
      `INSERT INTO invoices (proposal_id, invoice_number, amount_due, amount_paid, status)
       VALUES ($1, $2, 300000, 0, 'sent') RETURNING id`,
      [proposalId, `STALE${NUM}`]
    );
    invoiceId = inv.rows[0].id;

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
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (invoiceId) {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id = $1', [invoiceId]);
    await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);
  }
  if (proposalId) {
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
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

// ── FIX M7: stale-read clobber ───────────────────────────────────────────────
// A gate connection holds the proposals row lock so we can deterministically
// interleave a concurrent $1000 payment BETWEEN record-payment's non-transactional
// pre-tx read (which sees amount_paid = 0) and its write. Pre-fix, record-payment
// derived its money math from the stale pre-tx read and wrote a blind absolute
// amount_paid, clobbering the gate's payment: the proposal column ended at $1000
// while two payment rows + two invoice links summed to $2000 (ledger divergence).
// With the in-tx SELECT ... FOR UPDATE, record-payment blocks until the gate commits,
// re-reads $1000, and applies its capped delta on top -> $2000, fully consistent.
test('M7: a concurrent payment committed mid-flight is not clobbered (ledger stays consistent)', async () => {
  const gate = await pool.connect();
  let httpResult;
  try {
    await gate.query('BEGIN');
    // Hold the row lock (no write yet). A plain SELECT does not block on this, so
    // record-payment's pre-tx read still sees amount_paid = 0.
    await gate.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]);

    // Fire record-payment ($1000) WITHOUT awaiting. It reads 0 pre-tx, then parks
    // waiting for the row lock (at the locked re-read on new code; at the final
    // blind UPDATE on old code).
    const pending = postJson(`/api/proposals/${proposalId}/record-payment`, adminToken, { amount: 1000 });

    // Give the request time to reach its lock wait.
    await new Promise((r) => setTimeout(r, 400));

    // A concurrent $1000 payment lands and commits: its own succeeded payment row,
    // amount_paid bumped to $1000, and its invoice link, so the ledger is internally
    // honest before record-payment resumes.
    const gp = await gate.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
       VALUES ($1, 'deposit', 100000, 'succeeded') RETURNING id`,
      [proposalId]
    );
    await gate.query('UPDATE proposals SET amount_paid = 1000 WHERE id = $1', [proposalId]);
    await gate.query(
      `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 100000)`,
      [invoiceId, gp.rows[0].id]
    );
    await gate.query(`UPDATE invoices SET amount_paid = amount_paid + 100000, status = 'partially_paid' WHERE id = $1`, [invoiceId]);
    await gate.query('COMMIT');

    httpResult = await pending;
  } finally {
    gate.release();
  }

  assert.equal(httpResult.status, 200, `record-payment should 200, got ${httpResult.status}: ${httpResult.body}`);

  const prop = (await pool.query('SELECT amount_paid FROM proposals WHERE id = $1', [proposalId])).rows[0];
  const payCents = (await pool.query(
    "SELECT COALESCE(SUM(amount), 0)::bigint AS c FROM proposal_payments WHERE proposal_id = $1 AND status = 'succeeded'",
    [proposalId]
  )).rows[0].c;
  const linkCents = (await pool.query(
    'SELECT COALESCE(SUM(amount), 0)::bigint AS c FROM invoice_payments WHERE invoice_id = $1',
    [invoiceId]
  )).rows[0].c;

  // Pre-fix, the blind absolute write left amount_paid at $1000 while payments/links
  // summed to $2000; this is the divergence the FOR UPDATE re-read removes.
  assert.equal(Number(prop.amount_paid), 2000, 'proposal amount_paid must reflect BOTH payments ($2000)');
  assert.equal(Number(payCents), 200000, 'two succeeded payment rows sum to $2000 (200000c)');
  assert.equal(Number(prop.amount_paid) * 100, Number(payCents), 'proposal ledger must not diverge from the payment rows');
  assert.equal(Number(payCents), Number(linkCents), 'payment rows must not diverge from invoice links');
});
