require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Refunds under invoices: GET /t/:token includes a `refunds` array of SUCCEEDED
// refunds attributable to the invoice (via the payment its invoice_payments row
// funded). Pending/failed refunds, and refunds on payments NOT on this invoice,
// are excluded. Informational only — amount_paid / status stay the persisted
// values (a refund is money returned, not a reopened balance).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.refunds.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, clientId, proposalId, invoiceToken;
let comboTokenB, comboTokenC; // two invoices funded by ONE payment (clamp case)

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Refund Test', $1) RETURNING id`,
    [`refund-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid) VALUES ($1, 'deposit_paid', 1000, 500) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Deposit', 50000, 50000, 'paid') RETURNING id, token`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  const invoiceId = inv.rows[0].id;
  invoiceToken = inv.rows[0].token;

  // PAY1 funds THIS invoice.
  const pay1 = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'deposit', 50000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 50000)`,
    [invoiceId, pay1.rows[0].id]
  );
  // A negative reversal invoice_payments row (as refundHelpers writes on reconcile)
  // shares (invoice_id, payment_id) with the positive link. Deliberately UNSTAMPED
  // (no refund_id): this fixture exercises the LEGACY clamp regime, and proves the
  // aggregate lateral collapses the 2-row fan-out to one output row per refund.
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, -5000)`,
    [invoiceId, pay1.rows[0].id]
  );
  // R1 succeeded on PAY1 -> appears (once, thanks to DISTINCT). R2 pending on PAY1 -> excluded.
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 5000, 'Partial refund, over-served comp', 1000.00, 950.00, 'succeeded')`,
    [proposalId, pay1.rows[0].id]
  );
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 9999, 'Pending refund should be hidden', 1000.00, 900.00, 'pending')`,
    [proposalId, pay1.rows[0].id]
  );
  // PAY2 is NOT linked to this invoice; its SUCCEEDED refund must NOT appear here.
  const pay2 = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'balance', 30000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 7000, 'Refund on a different invoice', 1000.00, 930.00, 'succeeded')`,
    [proposalId, pay2.rows[0].id]
  );

  // Combined-payment clamp case (F3): ONE payment (PAY3, $100.00) funds TWO
  // invoices (B gets $60.00, C gets $40.00). A full $100.00 refund on PAY3 must
  // display as $60.00 on B and $40.00 on C — never the full amount on both.
  const invB = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', 6000, 6000, 'paid') RETURNING id, token`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  comboTokenB = invB.rows[0].token;
  const invC = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Drink Plan Extras', 4000, 4000, 'paid') RETURNING id, token`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  comboTokenC = invC.rows[0].token;
  const pay3 = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'drink_plan_with_balance', 10000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 6000)`,
    [invB.rows[0].id, pay3.rows[0].id]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 4000)`,
    [invC.rows[0].id, pay3.rows[0].id]
  );
  // Reconciliation writes NEGATIVE reversal rows on the refund (mirrors
  // refundHelpers). These drive the NET per-(payment,invoice) sum to 0, so the
  // display MUST use the gross-positive sum (FILTER WHERE amount > 0) or the
  // refund vanishes on both invoices. Locks the fix against a net-SUM refactor.
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, -6000)`,
    [invB.rows[0].id, pay3.rows[0].id]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, -4000)`,
    [invC.rows[0].id, pay3.rows[0].id]
  );
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 10000, 'Full refund on a combined payment', 1000.00, 900.00, 'succeeded')`,
    [proposalId, pay3.rows[0].id]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  // proposal_refunds RESTRICTs proposal_payments + proposals, so delete refunds first.
  if (proposalId) {
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [proposalId]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('GET /t/:token returns only succeeded refunds attributable to this invoice', async () => {
  const r = await get(`/api/invoices/t/${invoiceToken}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const refunds = r.body.invoice.refunds;
  assert.ok(Array.isArray(refunds), 'refunds should be an array');
  assert.equal(refunds.length, 1, `expected exactly 1 refund, got ${JSON.stringify(refunds)}`);
  assert.equal(Number(refunds[0].amount), 5000, 'amount is Stripe-native cents');
  assert.equal(refunds[0].reason, undefined, 'reason is admin-only free-text, never exposed on the public invoice');
});

test('combined-payment refund is clamped to what the payment applied to EACH invoice (F3 legacy fallback: reversals not stamped with refund_id)', async () => {
  const rb = await get(`/api/invoices/t/${comboTokenB}`);
  assert.equal(rb.status, 200, `expected 200 for invoice B, got ${rb.status}`);
  assert.equal(rb.body.invoice.refunds.length, 1, 'invoice B shows the refund once');
  assert.equal(Number(rb.body.invoice.refunds[0].amount), 6000,
    'invoice B shows only its $60.00 share of the $100.00 refund');

  const rc = await get(`/api/invoices/t/${comboTokenC}`);
  assert.equal(rc.status, 200, `expected 200 for invoice C, got ${rc.status}`);
  assert.equal(rc.body.invoice.refunds.length, 1, 'invoice C shows the refund once');
  assert.equal(Number(rc.body.invoice.refunds[0].amount), 4000,
    'invoice C shows only its $40.00 share (shares sum to the true refund)');
});

test('invoice amount_paid/status are unchanged by refunds (informational only)', async () => {
  const r = await get(`/api/invoices/t/${invoiceToken}`);
  assert.equal(Number(r.body.invoice.amount_paid), 50000, 'amount_paid stays the persisted value');
  assert.equal(r.body.invoice.status, 'paid', 'status is not reopened by a refund');
});

// Runs LAST: drives the REAL applyRefundReconciliation (which mutates this
// proposal's totals), so it must not precede the assertions above.
test('attributed partial refund on a combined payment shows ONLY on the invoice it walked onto', async () => {
  // PAY4 ($100.00) funds invoice D ($60.00, Balance) and invoice E ($40.00,
  // Drink Plan Extras). A $30.00 partial refund walks greedily onto D alone
  // (invoice_id ASC). Reconciliation stamps the reversal with refund_id, so
  // D displays exactly $30.00 and E displays NOTHING. (The legacy clamp used
  // to phantom the $30.00 onto E as well.)
  const invD = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', 6000, 6000, 'paid') RETURNING id, token`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  const invE = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Drink Plan Extras', 4000, 4000, 'paid') RETURNING id, token`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  const pay4 = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'drink_plan_with_balance', 10000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 6000)`,
    [invD.rows[0].id, pay4.rows[0].id]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 4000)`,
    [invE.rows[0].id, pay4.rows[0].id]
  );

  const { applyRefundReconciliation } = require('../utils/refundHelpers');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const r = await applyRefundReconciliation({
      proposalId,
      stripeRefundId: `re_attr_${NONCE}`,
      paymentIntentId: `pi_attr_${NONCE}`,
      paymentId: pay4.rows[0].id,
      amountCents: 3000,
      reason: 'partial combined refund (attribution test)',
      issuedBy: null,
    }, db);
    await db.query('COMMIT');
    assert.equal(r.applied, true, 'reconciliation applied');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }

  // Write side: exactly one reversal row, on D, stamped with its refund id.
  const rev = await pool.query(
    `SELECT ip.invoice_id, ip.amount, ip.refund_id
       FROM invoice_payments ip
      WHERE ip.payment_id = $1 AND ip.amount < 0`,
    [pay4.rows[0].id]
  );
  assert.equal(rev.rows.length, 1, 'exactly one reversal row written');
  assert.equal(rev.rows[0].invoice_id, invD.rows[0].id, 'reversal walked onto invoice D');
  assert.equal(Number(rev.rows[0].amount), -3000);
  assert.ok(rev.rows[0].refund_id, 'reversal row is stamped with its refund id');

  // Read side: D shows the exact attributed $30.00; E shows no phantom refund.
  const rd = await get(`/api/invoices/t/${invD.rows[0].token}`);
  assert.equal(rd.status, 200, `expected 200 for invoice D, got ${rd.status}`);
  assert.equal(rd.body.invoice.refunds.length, 1, 'invoice D shows the refund once');
  assert.equal(Number(rd.body.invoice.refunds[0].amount), 3000, 'invoice D shows the exact attributed $30.00');
  const re2 = await get(`/api/invoices/t/${invE.rows[0].token}`);
  assert.equal(re2.status, 200, `expected 200 for invoice E, got ${re2.status}`);
  assert.equal(re2.body.invoice.refunds.length, 0, 'invoice E shows NO phantom refund');
});
