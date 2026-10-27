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
let clientId, proposalId, paymentId, invoiceId, payoutRowId, matchedLineId, pendingLineId, unmatchedPayoutRowId;
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

  const app = express();
  app.use(express.json());
  app.use('/api/stripe-payouts', payoutsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });

  // Baseline of the global summary fields BEFORE we seed, read through the
  // route itself, so the assertions measure only our seeded lines whatever
  // mirror rows the shared dev DB already holds and however In transit is figured.
  const base = (await request('GET', '/api/stripe-payouts', { token: adminToken })).body.summary;
  baseInTransit = base.in_transit_cents;
  baseUnmatched = base.unmatched_count;

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

  // Second payout carrying ONE unmatched line: exercises the per-row
  // unmatched_count (mb-d). Teardown's LIKE patterns already cover both rows.
  const pou = await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, currency, status, created_at_stripe, arrival_date, lines_synced_at)
     VALUES ($1, 9680, 'usd', 'paid', NOW(), CURRENT_DATE, NOW()) RETURNING id`, [`po_test_${N}_u`]);
  unmatchedPayoutRowId = pou.rows[0].id;
  await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, available_on, matched_kind)
     VALUES ($1,$2,'charge','charge',10000,320,9680,NOW(),'unmatched')`,
    [`txn_test_${N}_u1`, unmatchedPayoutRowId]);
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
  assert.equal(res.body.summary.unmatched_count, baseUnmatched + 2, 'unmatched count picks up the seeded pending line + the unmatched payout line');
  const mine = res.body.payouts.find((p) => p.id === payoutRowId);
  assert.ok(mine, 'seeded payout present');
  assert.equal(mine.gross_cents, 45000, 'gross == SUM of line amounts');
  assert.equal(mine.fee_cents, 1335, 'fee == SUM of line fees');
  assert.equal(mine.line_count, 1);
  assert.equal(mine.unmatched_count, 0, 'per-row unmatched_count is 0 when every line is matched (mb-d)');
  const mineU = res.body.payouts.find((x) => x.stripe_payout_id === `po_test_${N}_u`);
  assert.ok(mineU, 'unmatched-line payout present');
  assert.equal(mineU.unmatched_count, 1, 'per-row unmatched_count counts unmatched lines (mb-d)');
  for (const k of ['gross_cents', 'fee_cents', 'line_count', 'status', 'arrival_date']) {
    assert.ok(k in mine, `pre-existing row field ${k} still present`);
  }
  const pend = res.body.pending.find((l) => l.id === pendingLineId);
  assert.ok(pend, 'pending line surfaced');
  assert.equal(pend.matched_kind, 'unmatched');
});

test('GET /api/stripe-payouts says which payouts are manual, so the tab can say they have no breakdown', async () => {
  await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, status, created_at_stripe, automatic, method)
     VALUES ($1, 25000, 'paid', NOW(), false, 'instant')`, [`po_test_${N}_manual`]);
  const res = await request('GET', '/api/stripe-payouts', { token: adminToken });
  assert.equal(res.status, 200);
  const manual = res.body.payouts.find((p) => p.stripe_payout_id === `po_test_${N}_manual`);
  assert.ok(manual, 'manual payout present');
  assert.equal(manual.automatic, false);
  assert.equal(manual.line_count, 0);
  assert.equal(res.body.payouts.find((p) => p.id === payoutRowId).automatic, true);
});

test('GET /api/stripe-payouts nets a pending manual payout debit out of In transit', async () => {
  const before = (await request('GET', '/api/stripe-payouts', { token: adminToken })).body.summary.in_transit_cents;
  const { rows: [line] } = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, matched_kind)
     VALUES ($1, 'payout', 'payout', -25000, 375, -25375, 'adjustment') RETURNING id`, [`txn_test_${N}_pend_po`]);
  const res = await request('GET', '/api/stripe-payouts', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.in_transit_cents, before - 25375, 'the debit lowers In transit');
  assert.ok(res.body.pending.find((l) => l.id === line.id), 'the debit is listed as pending');
});

test('GET /api/stripe-payouts leaves an instant payout\'s advance and its funding out of In transit', async () => {
  const before = (await request('GET', '/api/stripe-payouts', { token: adminToken })).body.summary.in_transit_cents;
  // Stripe fronts the instant payout (+) and takes it back out of the charges
  // as they settle (-); unclaimed, the pair is left out of In transit.
  const { rows } = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, matched_kind)
     VALUES ($1, 'advance', 'advance', 25375, 0, 25375, 'adjustment'),
            ($2, 'advance_funding', 'advance_funding', -10000, 0, -10000, 'adjustment')
     RETURNING id`, [`txn_test_${N}_pend_adv`, `txn_test_${N}_pend_advf`]);
  const res = await request('GET', '/api/stripe-payouts', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.in_transit_cents, before, 'the advance pair does not move In transit');
  for (const r of rows) assert.ok(!res.body.pending.find((l) => l.id === r.id), 'the advance pair is not listed as pending');
});

test('GET /api/stripe-payouts nets an advance a payout claimed before its funding arrived', async () => {
  const start = (await request('GET', '/api/stripe-payouts', { token: adminToken })).body.summary;
  const before = start.in_transit_cents;
  const owedBefore = start.advance_owed_cents;
  // A bank-debit payout inside the repayment window claimed the advance and the
  // instant debit; the charge the advance fronted is still pending, and the
  // funding that repays the advance out of it does not exist yet.
  const { rows: [po] } = await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, status, created_at_stripe, lines_synced_at)
     VALUES ($1, 0, 'paid', NOW(), NOW()) RETURNING id`, [`po_test_${N}_split`]);
  await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, matched_kind)
     VALUES ($1, $3, 'advance', 'advance', 25375, 0, 25375, 'adjustment'),
            ($2, $3, 'payout', 'payout', -25000, 375, -25375, 'adjustment')`,
    [`txn_test_${N}_split_adv`, `txn_test_${N}_split_po`, po.id]);
  await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, matched_kind)
     VALUES ($1, 'charge', 'charge', 26000, 625, 25375, 'payment')`, [`txn_test_${N}_split_ch`]);
  let res = await request('GET', '/api/stripe-payouts', { token: adminToken });
  assert.equal(res.body.summary.in_transit_cents, before,
    'the fronted charge goes to repay the advance, so the next deposit gains nothing');
  assert.equal(res.body.summary.advance_owed_cents, owedBefore + 25375, 'the advance still owed is returned');
  const listed = res.body.pending.reduce((s, l) => s + l.net_cents, 0);
  assert.equal(listed - res.body.summary.advance_owed_cents, res.body.summary.in_transit_cents,
    'the listed lines less the advance still owed add up to In transit');
  await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, matched_kind)
     VALUES ($1, 'advance_funding', 'advance_funding', -25375, 0, -25375, 'adjustment')`, [`txn_test_${N}_split_f`]);
  res = await request('GET', '/api/stripe-payouts', { token: adminToken });
  assert.equal(res.body.summary.in_transit_cents, before, 'the funding, once it lands, changes nothing either');
  assert.equal(res.body.summary.advance_owed_cents, owedBefore + 25375, 'the advance stays owed until a deposit claims its funding');
  // The next deposit claims the fronted charge with the funding that repays the
  // advance out of it: nothing is owed and In transit is back where it began.
  const { rows: [next] } = await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, status, created_at_stripe, lines_synced_at)
     VALUES ($1, 0, 'paid', NOW(), NOW()) RETURNING id`, [`po_test_${N}_split_next`]);
  await pool.query('UPDATE stripe_payout_lines SET payout_id = $1 WHERE stripe_balance_txn_id IN ($2, $3)',
    [next.id, `txn_test_${N}_split_ch`, `txn_test_${N}_split_f`]);
  res = await request('GET', '/api/stripe-payouts', { token: adminToken });
  assert.equal(res.body.summary.advance_owed_cents, owedBefore, 'a repaid advance is owed no longer');
  assert.equal(res.body.summary.in_transit_cents, before, 'In transit is back to its baseline');
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

test('acknowledged unmatched lines are excluded from unmatched counts but stay visible in detail', async () => {
  // Acknowledged pre-cutover baseline (2026-07-25): counted nowhere as
  // "unmatched", still listed. Covered by the after() LIKE cleanup.
  await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, available_on, matched_kind, acknowledged_at)
     VALUES ($1,$2,'charge','charge',5000,160,4840,NOW(),'unmatched',NOW())`,
    [`txn_test_${N}_ack`, unmatchedPayoutRowId]);
  const res = await request('GET', '/api/stripe-payouts', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.unmatched_count, baseUnmatched + 2,
    'summary unmatched_count unchanged by an acknowledged line');
  const mineU = res.body.payouts.find((x) => x.id === unmatchedPayoutRowId);
  assert.equal(mineU.unmatched_count, 1, 'per-payout count still counts only the live unmatched line');
  assert.equal(mineU.line_count, 2, 'acknowledged line still counted as a line (history visible)');
  const det = await request('GET', `/api/stripe-payouts/${unmatchedPayoutRowId}`, { token: adminToken });
  assert.equal(det.status, 200);
  const ackLine = det.body.lines.find((l) => l.stripe_balance_txn_id === `txn_test_${N}_ack`);
  assert.ok(ackLine, 'acknowledged line still listed in payout detail');
  assert.ok(ackLine.acknowledged_at, 'acknowledged_at exposed in the rows payload');
  assert.equal(ackLine.matched_kind, 'unmatched', 'matched_kind untouched by acknowledgement');
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
