require('dotenv').config();

// Extension-scope refund exclusion (plan Task 19, lane ext-webhook-payroll).
// Service Extension invoices are OFF-LEDGER (spec D12): their dollars never
// enter proposals.amount_paid, so the contract refund candidate set must never
// include the payments that funded them. Without the exclusion an admin
// refund aimed at an extension could land on the contract charge instead
// (corrupting the contract ledger with side money) or trip EXCEEDS_AMOUNT_PAID
// on a barely-paid contract, and a cancel-line overpayment split could drain
// an extension charge. loadPaymentsWithRemaining now anti-joins away any
// payment linked to an OFF_LEDGER_INVOICE_LABELS invoice, regardless of rails.
// Extension refunds happen at the Stripe dashboard (see docs/ops-runbook.md).
// Run ALONE against the shared dev DB:
//   node --env-file=/home/drbartender/projects/os/.env --test server/utils/refundHelpers.extensionScope.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const {
  loadPaymentsWithRemaining,
  planRefund,
  planOverpaymentSplits,
  CANCEL_LINE_REFUND_RAILS,
} = require('./refundHelpers');
const { SERVICE_EXTENSION_INVOICE_LABEL } = require('./proposalMoneyShared');

if (process.env.NODE_ENV === 'production') {
  throw new Error('refundHelpers.extensionScope.test.js refuses to run against production');
}

const NONCE = `extscope-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let seq = 0;
const seededClients = [];
const seededProposals = [];

async function seedProposal({ totalPrice = 1000, amountPaid = 1000 } = {}) {
  seq += 1;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`ExtScope Test ${NONCE}`, `${NONCE}-${seq}@example.com`]
  );
  seededClients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, amount_paid, pricing_snapshot, autopay_enrolled)
     VALUES ($1, 'balance_paid', 'wedding', 'America/Chicago',
             CURRENT_DATE + 30, '18:00', 4, $2, $3, '{}'::jsonb, false)
     RETURNING id`,
    [c.rows[0].id, totalPrice, amountPaid]
  );
  seededProposals.push(p.rows[0].id);
  return p.rows[0].id;
}

// A succeeded, intent-bearing payment; when `label` is given, also an invoice
// with that label holding the full amount and the invoice_payments link (the
// linkage the exclusion anti-joins on). Extension payments are payment_type
// 'invoice' rows linked to a 'Service Extension' invoice, exactly as
// paymentIntentSucceeded records them; minted alone, paid alone.
async function addPayment(proposalId, { type, amountCents, label = null }) {
  seq += 1;
  const intent = `pi_extscope_${NONCE}_${seq}`;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, $2, $3, 'succeeded', $4) RETURNING id`,
    [proposalId, type, amountCents, intent]
  );
  let invId = null;
  if (label) {
    const inv = await pool.query(
      `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
       VALUES ($1, $2, $3, $4, $4, 'paid', true) RETURNING id`,
      [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, label, amountCents]
    );
    invId = inv.rows[0].id;
    await pool.query(
      'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
      [invId, pay.rows[0].id, amountCents]
    );
  }
  return { paymentId: pay.rows[0].id, intent, invId };
}

after(async () => {
  for (const pid of seededProposals) {
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  for (const cid of seededClients) await pool.query('DELETE FROM clients WHERE id = $1', [cid]);
  await pool.end();
});

// Shared by tests 1 and 2: paid Balance + paid Service Extension.
let mixed; // { proposalId, balance, ext }

test('1: paid Balance + paid Service Extension: candidates hold ONLY the Balance payment', async () => {
  const proposalId = await seedProposal();
  const balance = await addPayment(proposalId, { type: 'balance', amountCents: 100000, label: 'Balance' });
  const ext = await addPayment(proposalId, {
    type: 'invoice', amountCents: 20000, label: SERVICE_EXTENSION_INVOICE_LABEL,
  });
  mixed = { proposalId, balance, ext };
  const rows = await loadPaymentsWithRemaining(proposalId); // default panel rails
  assert.equal(rows.length, 1, 'extension payment must be excluded');
  assert.equal(rows[0].id, balance.paymentId);
  assert.equal(rows[0].stripe_payment_intent_id, balance.intent);
  assert.equal(rows[0].remainingCents, 100000);
});

test('2: planRefund for the full contract amount targets the Balance charge, never the extension', async () => {
  const rows = await loadPaymentsWithRemaining(mixed.proposalId);
  const plan = planRefund({
    paymentsWithRemaining: rows,
    requestedDollars: 1000,
    amountPaidDollars: 1000,
    totalPriceDollars: 1000,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.targetPaymentId, mixed.balance.paymentId);
  assert.equal(plan.targetIntentId, mixed.balance.intent);
  assert.notEqual(plan.targetPaymentId, mixed.ext.paymentId);
  assert.equal(plan.amountCents, 100000);
});

test('3: extension-only proposal: empty candidates, planRefund refuses with a clear code', async () => {
  // amount_paid is 0 here for realism (extension dollars never roll into it),
  // but the refusal must come from the EMPTY candidate list, not the paid cap.
  const proposalId = await seedProposal({ totalPrice: 1000, amountPaid: 0 });
  await addPayment(proposalId, {
    type: 'invoice', amountCents: 20000, label: SERVICE_EXTENSION_INVOICE_LABEL,
  });
  const rows = await loadPaymentsWithRemaining(proposalId);
  assert.deepEqual(rows, [], 'no candidate at all, not a silently-zero refund');
  const plan = planRefund({
    paymentsWithRemaining: rows,
    requestedDollars: 200,
    amountPaidDollars: 0,
    totalPriceDollars: 1000,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NO_REFUNDABLE_PAYMENT');
});

test('4: regression: ordinary payments (incl. invoice-rail, non-off-ledger label) are untouched', async () => {
  // The real byte-identical guard is the existing refundHelpers suites; this
  // pins the two shapes the anti-join could plausibly over-exclude: a payment
  // with NO invoice link at all (deposit) and an invoice-rail payment linked
  // to a NON-off-ledger label (Additional Services), with pending+succeeded
  // refund netting still applied.
  const proposalId = await seedProposal({ totalPrice: 1000, amountPaid: 400 });
  const dep = await addPayment(proposalId, { type: 'deposit', amountCents: 10000 }); // no invoice link
  const inv = await addPayment(proposalId, {
    type: 'invoice', amountCents: 30000, label: 'Additional Services',
  });
  await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status)
     VALUES ($1, $2, $3, 5000, 'seeded partial', 1000, 1000, NULL, 'succeeded')`,
    [proposalId, inv.paymentId, inv.intent]
  );
  const rows = await loadPaymentsWithRemaining(proposalId);
  assert.equal(rows.length, 2, 'both ordinary payments stay refundable');
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(dep.paymentId).remainingCents, 10000);
  assert.equal(byId.get(inv.paymentId).remainingCents, 25000); // 30000 - 5000 netting unchanged
});

test('5: cancel-line overpayment split never draws on an extension payment', async () => {
  // Cancel-line seam: loadPaymentsWithRemaining on CANCEL_LINE_REFUND_RAILS
  // feeding pure planOverpaymentSplits (cancelLineItem.js runCore). Before the
  // exclusion, the extension charge (payment_type 'invoice', on those rails)
  // would have absorbed the 10000 cents past the contract charge's headroom;
  // now that remainder correctly falls to manualReturnCents.
  const proposalId = await seedProposal();
  const contract = await addPayment(proposalId, { type: 'balance', amountCents: 100000, label: 'Balance' });
  const ext = await addPayment(proposalId, {
    type: 'invoice', amountCents: 20000, label: SERVICE_EXTENSION_INVOICE_LABEL,
  });
  const rows = await loadPaymentsWithRemaining(proposalId, pool, { rails: CANCEL_LINE_REFUND_RAILS });
  assert.equal(rows.length, 1, 'extension payment excluded on the cancel-line rails too');
  assert.equal(rows[0].id, contract.paymentId);
  const split = planOverpaymentSplits({
    paymentsWithRemaining: rows,
    overpaymentCents: 110000,
  });
  assert.equal(split.splits.length, 1);
  assert.equal(split.splits[0].paymentId, contract.paymentId);
  assert.equal(split.splits[0].amountCents, 100000);
  assert.ok(
    split.splits.every((s) => s.paymentId !== ext.paymentId && s.paymentIntentId !== ext.intent),
    'no split may target the extension payment'
  );
  assert.equal(split.stripeRefundableCents, 100000);
  assert.equal(split.manualReturnCents, 10000);
});
