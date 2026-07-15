require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// refundExecute (P6.4): the shared one-charge refund orchestration used by both
// the admin partial-refund route and the cancel-event refund endpoint. DB-bound;
// Stripe is a DI stub. Verifies: happy-path reconciliation, gratuity_cents
// attribution on the refund row, idempotent no-op cleanup, and the Stripe-error
// path marking the pending row failed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { refundExecute } = require('./refundExecute');
const { PaymentError, ExternalServiceError } = require('./errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('refundExecute.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId, proposalId, depositInvoiceId, payId;

function fakeStripe(refundId) {
  return {
    refunds: {
      create: async ({ payment_intent, amount }) => ({
        id: refundId, payment_intent, amount, status: 'succeeded',
      }),
    },
  };
}

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('RefundExec Test', $1) RETURNING id`,
    [`refexec-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid)
     VALUES ($1, 'balance_paid', 1000, 1000) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', 100000, 100000, 'paid') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  depositInvoiceId = inv.rows[0].id;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'balance', 100000, 'succeeded', $2) RETURNING id`,
    [proposalId, `pi_refexec_${NONCE}`]
  );
  payId = pay.rows[0].id;
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 100000)`,
    [depositInvoiceId, payId]
  );
});

after(async () => {
  if (proposalId) {
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [proposalId]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('happy path: reconciles a refund, stamps gratuity_cents on the refund row', async () => {
  const refundId = `re_ok_${NONCE}`;
  const out = await refundExecute({
    stripe: fakeStripe(refundId),
    proposalId,
    paymentId: payId,
    paymentIntentId: `pi_refexec_${NONCE}`,
    amountCents: 20000,
    reason: 'cancellation gratuity portion',
    issuedBy: null,
    idempotencyKey: `refund-${proposalId}-${NONCE}-a`,
    totalPriceBeforeDollars: 1000,
    totalPriceAfterDollars: 800,
    gratuityCents: 5000,
  });
  assert.equal(out.recon.applied, true, 'reconciliation applied');
  const row = await pool.query(
    `SELECT amount, status, gratuity_cents FROM proposal_refunds WHERE stripe_refund_id = $1`,
    [refundId]
  );
  assert.equal(row.rows.length, 1, 'exactly one refund row for this stripe refund id');
  assert.equal(Number(row.rows[0].amount), 20000);
  assert.equal(row.rows[0].status, 'succeeded');
  assert.equal(Number(row.rows[0].gratuity_cents), 5000, 'gratuity portion attributed on the refund row');
});

test('idempotent no-op: a redelivered refund id deletes the redundant pending row', async () => {
  const refundId = `re_dupe_${NONCE}`;
  // Pre-seed a succeeded refund with this id (a prior winner).
  await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, stripe_refund_id, amount, reason,
        total_price_before, total_price_after, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'succeeded')`,
    [proposalId, payId, `pi_refexec_${NONCE}`, refundId, 10000, 'prior winner', 1000, 900]
  );
  const before = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE proposal_id = $1 AND status = 'pending'`,
    [proposalId]
  );
  const out = await refundExecute({
    stripe: fakeStripe(refundId),
    proposalId,
    paymentId: payId,
    paymentIntentId: `pi_refexec_${NONCE}`,
    amountCents: 10000,
    reason: 'duplicate submit',
    issuedBy: null,
    idempotencyKey: `refund-${proposalId}-${NONCE}-dupe`,
    totalPriceBeforeDollars: 1000,
    totalPriceAfterDollars: 900,
  });
  assert.equal(out.recon.applied, false, 'reconciliation no-op on already-applied refund id');
  const afterN = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE proposal_id = $1 AND status = 'pending'`,
    [proposalId]
  );
  assert.equal(afterN.rows[0].n, before.rows[0].n, 'no stranded pending row left behind');
});

test('stripe error: marks the pending row failed and throws PaymentError', async () => {
  const badStripe = {
    refunds: {
      create: async () => {
        const e = new Error('No such payment_intent');
        e.type = 'StripeInvalidRequestError';
        throw e;
      },
    },
  };
  await assert.rejects(
    () => refundExecute({
      stripe: badStripe,
      proposalId,
      paymentId: payId,
      paymentIntentId: `pi_refexec_${NONCE}`,
      amountCents: 5000,
      reason: 'will fail',
      issuedBy: null,
      idempotencyKey: `refund-${proposalId}-${NONCE}-fail`,
      totalPriceBeforeDollars: 1000,
      totalPriceAfterDollars: 950,
    }),
    (err) => err instanceof PaymentError && err.code === 'REFUND_REJECTED'
  );
  const failed = await pool.query(
    `SELECT status FROM proposal_refunds
      WHERE proposal_id = $1 AND reason = 'will fail' ORDER BY created_at DESC LIMIT 1`,
    [proposalId]
  );
  assert.equal(failed.rows[0].status, 'failed', 'pending row flipped to failed');
});

// B6: ambiguous Stripe errors (we cannot know whether the refund reached Stripe)
// must LEAVE the pending row pending so it blocks headroom and the sweeper
// resolves it. Today refundExecute.js flips ANY error to 'failed' → these fail.
test('ambiguous errors (StripeConnectionError, StripeAPIError) leave the row pending and throw ExternalServiceError', async () => {
  for (const type of ['StripeConnectionError', 'StripeAPIError']) {
    const reason = `ambiguous ${type}`;
    const ambiguousStripe = {
      refunds: {
        create: async () => {
          const e = new Error(`ambiguous ${type}`);
          e.type = type;
          throw e;
        },
      },
    };
    await assert.rejects(
      () => refundExecute({
        stripe: ambiguousStripe,
        proposalId,
        paymentId: payId,
        paymentIntentId: `pi_refexec_${NONCE}`,
        amountCents: 3000,
        reason,
        issuedBy: null,
        idempotencyKey: `refund-${proposalId}-${NONCE}-${type}`,
        totalPriceBeforeDollars: 1000,
        totalPriceAfterDollars: 970,
      }),
      (err) => err instanceof ExternalServiceError,
      `${type} should throw ExternalServiceError`
    );
    const r = await pool.query(
      `SELECT status, stripe_refund_id FROM proposal_refunds
        WHERE proposal_id = $1 AND reason = $2 ORDER BY created_at DESC LIMIT 1`,
      [proposalId, reason]
    );
    assert.equal(r.rows[0].status, 'pending', `${type} leaves the row pending (today flips it failed)`);
    assert.equal(r.rows[0].stripe_refund_id, null, `${type} leaves stripe_refund_id NULL`);
  }
});

// B6: the sweeper's exact-match anchor. refunds.create must carry the pending
// row id + proposal id in metadata. Today no metadata is passed → this fails.
test('passes metadata.proposal_refund_row_id and proposal_id to stripe.refunds.create', async () => {
  let captured = null;
  const capturingStripe = {
    refunds: {
      create: async (params) => {
        captured = params;
        return { id: `re_meta_${NONCE}`, status: 'succeeded', payment_intent: params.payment_intent, amount: params.amount };
      },
    },
  };
  const out = await refundExecute({
    stripe: capturingStripe,
    proposalId,
    paymentId: payId,
    paymentIntentId: `pi_refexec_${NONCE}`,
    amountCents: 4000,
    reason: 'metadata anchor',
    issuedBy: null,
    idempotencyKey: `refund-${proposalId}-${NONCE}-meta`,
    totalPriceBeforeDollars: 1000,
    totalPriceAfterDollars: 960,
  });
  assert.ok(captured && captured.metadata, 'metadata object passed to refunds.create');
  assert.equal(captured.metadata.proposal_refund_row_id, String(out.refundRowId), 'row id anchor stamped');
  assert.equal(captured.metadata.proposal_id, String(proposalId), 'proposal id stamped');
});
