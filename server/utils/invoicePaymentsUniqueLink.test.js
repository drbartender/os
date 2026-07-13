require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// F7 (defense-in-depth): invoice_payments must reject a SECOND positive credit
// link for the same (invoice_id, payment_id) — a double-linked payment would
// break the sum(invoice_payments.amount) == invoices.amount_paid invariant and
// double-credit an invoice on a webhook redelivery. The guard is a PARTIAL
// unique index WHERE amount > 0 (positive links only): every refund reversal
// row is amount < 0 and MUST still be insertable even though it shares
// (invoice_id, payment_id) with its positive link — including LEGACY reversal
// rows that carry refund_id NULL (which a WHERE refund_id IS NULL predicate
// would wrongly reject). See invoiceLinking.js, refundHelpers.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool, initDb } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoicePaymentsUniqueLink.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId, proposalId, invoiceId, paymentId, refundId;

before(async () => {
  // Apply the schema (incl. the F7 partial unique index) via the real boot path,
  // so this migration test is self-contained and actually exercises the
  // CREATE UNIQUE INDEX DDL instead of leaning on ambient dev-DB state.
  await initDb();

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('F7 Uniqueness Test', $1) RETURNING id`,
    [`f7-uniq-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', 100, 100) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Deposit', 10000, 10000, 'paid') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  invoiceId = inv.rows[0].id;

  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
     VALUES ($1, 'deposit', 10000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  paymentId = pay.rows[0].id;

  // A proposal_refunds row so the "new reversal" shape (refund_id set) is FK-valid.
  const ref = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 5000, 'F7 test reversal', 100.00, 50.00, 'succeeded') RETURNING id`,
    [proposalId, paymentId]
  );
  refundId = ref.rows[0].id;

  // The ONE legitimate positive credit link (mirrors invoiceLinking.js).
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 10000)`,
    [invoiceId, paymentId]
  );
});

after(async () => {
  if (proposalId) {
    // proposal_refunds RESTRICTs proposal_payments + proposals — delete it first.
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [proposalId]);
    await pool.query(
      'DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)',
      [proposalId]
    );
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('a second positive credit link to the same (invoice, payment) is rejected', async () => {
  await assert.rejects(
    () => pool.query(
      `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 10000)`,
      [invoiceId, paymentId]
    ),
    (err) => {
      assert.equal(err.code, '23505', `expected unique_violation 23505, got ${err.code}`);
      assert.equal(err.constraint, 'uq_invoice_payments_positive_link',
        `expected the partial-unique index, got ${err.constraint}`);
      return true;
    }
  );
});

test('reversal rows sharing (invoice, payment) with the positive link are still allowed (legacy NULL + stamped)', async () => {
  // Legacy reversal shape: amount < 0, refund_id NULL, shares (invoice, payment).
  // This is the row a WHERE refund_id IS NULL predicate would WRONGLY reject.
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, -5000)`,
    [invoiceId, paymentId]
  );
  // New reversal shape: amount < 0, refund_id set (mirrors refundHelpers.js).
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount, refund_id) VALUES ($1, $2, -5000, $3)`,
    [invoiceId, paymentId, refundId]
  );
  const n = await pool.query(
    `SELECT COUNT(*)::int AS c FROM invoice_payments WHERE invoice_id = $1 AND payment_id = $2 AND amount < 0`,
    [invoiceId, paymentId]
  );
  assert.equal(n.rows[0].c, 2, 'both reversal rows must persist alongside the single positive link');
});
