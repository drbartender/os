require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Route-level tests for /api/stripe-payouts (DB-only GET list/detail + sync POST).
// Mirrors the hand-rolled harness in server/routes/beo.test.js: minimal express
// app, real router, real auth middleware, driven over real HTTP. Nonce-scoped
// fixtures cleaned in after(); shared dev DB.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const sync = require('../utils/stripePayoutSync');
const payoutsRouter = require('./stripePayouts');

if (process.env.NODE_ENV === 'production') throw new Error('stripePayouts.test.js refuses to run against production');

const N = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, staffToken;
let clientId, proposalId, paymentId, invoiceId, payoutRowId, matchedLineId, pendingLineId;
// Summary fields (in_transit_cents, unmatched_count) are GLOBAL sums over the
// whole table; the shared dev DB may already hold backfilled mirror rows, so we
// assert our seeded rows' DELTA against a baseline captured before seeding.
let baseInTransit, baseUnmatched;

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
  // Baseline of the global summary fields BEFORE we seed, so the assertions
  // measure only our two seeded lines regardless of pre-existing mirror rows.
  const base = await pool.query(`
    SELECT
      COALESCE(SUM(net_cents) FILTER (WHERE payout_id IS NULL AND txn_type <> 'payout'), 0)::int AS in_transit_cents,
      COUNT(*) FILTER (WHERE matched_kind = 'unmatched')::int AS unmatched_count
    FROM stripe_payout_lines`);
  baseInTransit = base.rows[0].in_transit_cents;
  baseUnmatched = base.rows[0].unmatched_count;

  const passwordHash = await bcrypt.hash('x', 4);
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1,$2,'admin','approved',0) RETURNING id, token_version`,
    [`sp-route-admin-${N}@test.local`, passwordHash]);
  adminToken = jwt.sign({ userId: admin.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const staff = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1,$2,'staff','approved',0) RETURNING id, token_version`,
    [`sp-route-staff-${N}@test.local`, passwordHash]);
  staffToken = jwt.sign({ userId: staff.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id`,
    [`SP Route ${N}`, `sp-route-client-${N}@test.local`]);
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_type, status) VALUES ($1,'wedding','confirmed') RETURNING id`, [clientId]);
  proposalId = p.rows[0].id;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1,$2,'deposit',45000,'succeeded') RETURNING id`, [proposalId, `pi_sp_${N}`]);
  paymentId = pay.rows[0].id;
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due) VALUES ($1,$2,'Invoice',45000) RETURNING id`,
    [proposalId, `INV-S${String(N).slice(-6)}`]);
  invoiceId = inv.rows[0].id;
  await pool.query(`INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1,$2,45000)`,
    [invoiceId, paymentId]);

  // One paid payout with one matched (payment) line.
  const po = await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, currency, status, created_at_stripe, arrival_date, lines_synced_at)
     VALUES ($1, 43665, 'usd', 'paid', NOW(), CURRENT_DATE, NOW()) RETURNING id`, [`po_test_${N}`]);
  payoutRowId = po.rows[0].id;
  const ml = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, available_on, stripe_payment_intent_id, matched_kind,
       proposal_payment_id, proposal_id, invoice_id)
     VALUES ($1,$2,'charge','charge',45000,1335,43665,NOW(),$3,'payment',$4,$5,$6) RETURNING id`,
    [`txn_test_${N}_matched`, payoutRowId, `pi_sp_${N}`, paymentId, proposalId, invoiceId]);
  matchedLineId = ml.rows[0].id;
  // One pending, unmatched line (in transit).
  const pl = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, available_on, matched_kind)
     VALUES ($1,NULL,'charge','charge',10000,320,9680,NOW(),'unmatched') RETURNING id`,
    [`txn_test_${N}_pending`]);
  pendingLineId = pl.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/stripe-payouts', payoutsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  await pool.query('DELETE FROM stripe_payout_lines WHERE stripe_balance_txn_id LIKE $1', [`txn_test_${N}%`]);
  await pool.query('DELETE FROM stripe_payouts WHERE stripe_payout_id LIKE $1', [`po_test_${N}%`]);
  await pool.query('DELETE FROM invoice_payments WHERE invoice_id = $1', [invoiceId]);
  await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);
  await pool.query('DELETE FROM proposal_payments WHERE id = $1', [paymentId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`sp-route-%-${N}@test.local`]);
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('GET /api/stripe-payouts requires auth (401 no token)', async () => {
  const res = await request('GET', '/api/stripe-payouts');
  assert.equal(res.status, 401);
});

test('GET /api/stripe-payouts forbids staff role (403)', async () => {
  const res = await request('GET', '/api/stripe-payouts', { token: staffToken });
  assert.equal(res.status, 403);
});

test('GET /api/stripe-payouts is DB-only and returns summary + pending + payouts', async () => {
  // Prove the list endpoint never touches Stripe: any access to the client throws.
  sync._setStripeClientForTests({ get payouts() { throw new Error('GET must be DB-only'); } });
  const res = await request('GET', '/api/stripe-payouts', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.in_transit_cents, baseInTransit + 9680, 'in_transit picks up the seeded pending net');
  assert.equal(res.body.summary.unmatched_count, baseUnmatched + 1, 'unmatched count picks up the seeded pending line');
  const mine = res.body.payouts.find((p) => p.id === payoutRowId);
  assert.ok(mine, 'seeded payout present');
  assert.equal(mine.gross_cents, 45000, 'gross == SUM of line amounts');
  assert.equal(mine.fee_cents, 1335, 'fee == SUM of line fees');
  assert.equal(mine.line_count, 1);
  const pend = res.body.pending.find((l) => l.id === pendingLineId);
  assert.ok(pend, 'pending line surfaced');
  assert.equal(pend.matched_kind, 'unmatched');
});

test('GET /api/stripe-payouts/:id returns the payout with joined lines', async () => {
  const res = await request('GET', `/api/stripe-payouts/${payoutRowId}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.payout.id, payoutRowId);
  const line = res.body.lines.find((l) => l.id === matchedLineId);
  assert.ok(line, 'matched line present');
  assert.equal(line.client_name, `SP Route ${N}`, 'client_name joined');
  assert.equal(line.invoice_number, `INV-S${String(N).slice(-6)}`, 'invoice_number joined');
});

test('GET /api/stripe-payouts/999999 -> 404', async () => {
  const res = await request('GET', '/api/stripe-payouts/999999', { token: adminToken });
  assert.equal(res.status, 404);
});

test('POST /api/stripe-payouts/sync -> 200 synced:true (no-op fake stripe)', async () => {
  sync._setStripeClientForTests({
    payouts: { list: async () => ({ data: [], has_more: false }) },
    balanceTransactions: { list: async () => ({ data: [], has_more: false }) },
  });
  const res = await request('POST', '/api/stripe-payouts/sync', { token: adminToken, body: { force: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, true);
});
