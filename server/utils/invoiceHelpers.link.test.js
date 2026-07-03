'use strict';

// Seam-sweep M1/M2 guards on invoice linking + void PI cancellation.
// Run: DOTENV_CONFIG_PATH=<os>/.env node -r dotenv/config --test server/utils/invoiceHelpers.link.test.js
const { test, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { linkPaymentToInvoice } = require('./invoiceHelpers');
const { cancelOpenInvoiceIntents, _setStripeForTests } = require('./invoiceVoid');

const proposalIds = new Set();
const invoiceIds = new Set();
const paymentIds = new Set();
let invSeq = 0;

async function seed({ invStatus = 'sent', amountDue = 10000, invAmountPaid = 0 } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (status, amount_paid, pricing_snapshot, total_price)
     VALUES ('sent', 0, '{}'::jsonb, 1000) RETURNING id`);
  proposalIds.add(p.id);
  invSeq += 1;
  const { rows: [i] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [p.id, `TEST-LK-${invSeq}`, amountDue, invAmountPaid, invStatus]);
  invoiceIds.add(i.id);
  const { rows: [pay] } = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
     VALUES ($1, 'deposit', 10000, 'succeeded') RETURNING id`, [p.id]);
  paymentIds.add(pay.id);
  return { proposalId: p.id, invoiceId: i.id, paymentId: pay.id };
}

async function invoiceRow(id) {
  const { rows: [r] } = await pool.query(
    'SELECT status, amount_due, amount_paid, locked FROM invoices WHERE id = $1', [id]);
  return r;
}

async function linkSum(invoiceId) {
  const { rows: [r] } = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_payments WHERE invoice_id = $1', [invoiceId]);
  return Number(r.s);
}

after(async () => {
  if (invoiceIds.size) {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id = ANY($1)', [[...invoiceIds]]);
    await pool.query('DELETE FROM invoices WHERE id = ANY($1)', [[...invoiceIds]]);
  }
  if (paymentIds.size) await pool.query('DELETE FROM proposal_payments WHERE id = ANY($1)', [[...paymentIds]]);
  if (proposalIds.size) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1)', [[...proposalIds]]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [[...proposalIds]]);
  }
  await pool.end();
});

// ── M1: linker guards ────────────────────────────────────────────────────────

test('normal link still credits, flips status, and locks when fully paid', async () => {
  const { invoiceId, paymentId } = await seed({ invStatus: 'sent', amountDue: 10000 });
  const res = await linkPaymentToInvoice(invoiceId, paymentId, 10000, pool);
  assert.deepStrictEqual(res, { linked: true, creditedCents: 10000, overflowCents: 0 });
  const inv = await invoiceRow(invoiceId);
  assert.strictEqual(inv.status, 'paid');
  assert.strictEqual(inv.amount_paid, 10000);
  assert.strictEqual(inv.locked, true);
});

test('a paid invoice refuses further credit (two-tab double-pay)', async () => {
  const { invoiceId, paymentId } = await seed({ invStatus: 'sent', amountDue: 10000 });
  await linkPaymentToInvoice(invoiceId, paymentId, 10000, pool);
  const res = await linkPaymentToInvoice(invoiceId, paymentId, 10000, pool);
  assert.strictEqual(res.linked, false);
  assert.strictEqual(res.reason, 'not_payable');
  const inv = await invoiceRow(invoiceId);
  assert.strictEqual(inv.amount_paid, 10000, 'amount_paid did not double');
  assert.strictEqual(await linkSum(invoiceId), 10000, 'no second link row');
});

test('a void invoice is never reanimated by a late payment', async () => {
  const { invoiceId, paymentId } = await seed({ invStatus: 'void', amountDue: 10000 });
  const res = await linkPaymentToInvoice(invoiceId, paymentId, 10000, pool);
  assert.strictEqual(res.linked, false);
  assert.strictEqual(res.reason, 'not_payable');
  const inv = await invoiceRow(invoiceId);
  assert.strictEqual(inv.status, 'void');
  assert.strictEqual(inv.amount_paid, 0);
});

test('overpayment is capped at remaining due; link row records the capped amount', async () => {
  const { invoiceId, paymentId } = await seed({ invStatus: 'sent', amountDue: 10000 });
  const res = await linkPaymentToInvoice(invoiceId, paymentId, 300000, pool);
  assert.strictEqual(res.linked, true);
  assert.strictEqual(res.creditedCents, 10000);
  assert.strictEqual(res.overflowCents, 290000);
  const inv = await invoiceRow(invoiceId);
  assert.strictEqual(inv.amount_paid, 10000, 'capped at amount_due');
  assert.strictEqual(inv.status, 'paid');
  assert.strictEqual(await linkSum(invoiceId), 10000, 'link row is the capped amount');
});

// ── M2: void cancels open PaymentIntents ─────────────────────────────────────

function fakeStripe(intentsById, { cancelThrows = false } = {}) {
  const canceled = [];
  return {
    canceled,
    paymentIntents: {
      retrieve: async (id) => {
        if (!intentsById[id]) { const e = new Error('No such payment_intent'); throw e; }
        return intentsById[id];
      },
      cancel: async (id) => {
        if (cancelThrows) throw new Error('cancel failed');
        canceled.push(id);
        return { id, status: 'canceled' };
      },
    },
  };
}

test('cancelOpenInvoiceIntents cancels only cancelable PIs for the voided invoice', async () => {
  const { proposalId, invoiceId } = await seed();
  const otherInvoiceId = invoiceId + 999999;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES
     ($1, 'pi_test_match', 10000, 'pending'),
     ($1, 'pi_test_other', 10000, 'pending'),
     ($1, 'pi_test_processing', 10000, 'pending')`,
    [proposalId]
  );
  const stripe = fakeStripe({
    pi_test_match: { id: 'pi_test_match', status: 'requires_payment_method', metadata: { invoice_id: String(invoiceId) } },
    pi_test_other: { id: 'pi_test_other', status: 'requires_payment_method', metadata: { invoice_id: String(otherInvoiceId) } },
    pi_test_processing: { id: 'pi_test_processing', status: 'processing', metadata: { invoice_id: String(invoiceId) } },
  });
  _setStripeForTests(stripe);
  try {
    const res = await cancelOpenInvoiceIntents(proposalId, invoiceId);
    assert.strictEqual(res.checked, 3);
    assert.strictEqual(res.canceled, 1);
    assert.deepStrictEqual(stripe.canceled, ['pi_test_match']);
  } finally {
    _setStripeForTests(null);
  }
});

test('cancelOpenInvoiceIntents never throws when Stripe cancel fails', async () => {
  const { proposalId, invoiceId } = await seed();
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, 'pi_test_boom', 10000, 'pending')`,
    [proposalId]
  );
  const stripe = fakeStripe(
    { pi_test_boom: { id: 'pi_test_boom', status: 'requires_payment_method', metadata: { invoice_id: String(invoiceId) } } },
    { cancelThrows: true }
  );
  _setStripeForTests(stripe);
  try {
    const res = await cancelOpenInvoiceIntents(proposalId, invoiceId);
    assert.strictEqual(res.canceled, 0, 'failure is swallowed, not thrown');
  } finally {
    _setStripeForTests(null);
  }
});
