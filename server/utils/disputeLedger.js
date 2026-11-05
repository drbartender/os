// The proposal-side ledger of a card dispute (audit PAY-04): a withdrawal is recorded as a
// 'dispute'-scope proposal_refunds row through the refund reconciler, so every refund-aware reader
// (per-charge headroom, the cancel target, the status ladder) nets it, and it is reversed when the
// funds are reinstated.
//
// Why the refund ledger and not a column: proposal_refunds is already what
// loadPaymentsWithRemaining, uncreditedHeadroomCents, the cancel refund target
// and the money board net, and its stripe_refund_id unique index is the
// idempotency anchor every refund path shares. A dispute id in that column
// gives a chargeback the same at-least-once safety for free. What a dispute
// is NOT is a refund the business agreed to: the contract stands, so the row
// carries total_scope 'dispute', which applyRefundReconciliation reads as
// "lower amount_paid, re-open the invoices the money paid, move neither
// total_price nor the invoice demand". A reinstatement (the dispute is won)
// re-credits those invoices and the row, promotes the status back and marks
// the row 'failed' with the reason spelling it out: money that came back never
// left, and the per-charge headroom is whole again.
//
// Both writers run inside the caller's transaction, under the proposals row
// lock the reconciler takes, on the caller's client (one pooled connection per
// request). Tips are not proposal payments and never reach here: the webhook
// routes a tip dispute to the payroll clawback first.
'use strict';

const { pool } = require('../db');
const { applyRefundReconciliation } = require('./refundHelpers');
const { OFF_LEDGER_INVOICE_LABELS } = require('./proposalMoneyShared');
const { reconcileProposalPaymentStatus } = require('./proposalStatus');
const { lockInvoice } = require('./invoiceLifecycle');

/**
 * The succeeded proposal payment a disputed PaymentIntent paid, with the
 * cents still on it after earlier refunds and disputes. Null for a charge
 * that is not a proposal payment (a tip, a stale link, not ours).
 *
 * @param {string} paymentIntentId
 * @param {object} [db]
 * @returns {Promise<{id:number, proposalId:number, amountCents:number, remainingCents:number}|null>}
 */
async function findDisputedPayment(paymentIntentId, db = pool) {
  if (!paymentIntentId) return null;
  const { rows } = await db.query(
    `SELECT pp.id, pp.proposal_id, pp.amount,
            pp.amount
              - COALESCE((SELECT SUM(pr.amount) FROM proposal_refunds pr
                           WHERE pr.payment_id = pp.id AND pr.status IN ('succeeded', 'pending')), 0)
              AS remaining
       FROM proposal_payments pp
      WHERE pp.stripe_payment_intent_id = $1 AND pp.status = 'succeeded'
      LIMIT 1`,
    [paymentIntentId]
  );
  const r = rows[0];
  if (!r || !Number.isInteger(Number(r.proposal_id)) || Number(r.proposal_id) <= 0) return null;
  return {
    id: r.id,
    proposalId: Number(r.proposal_id),
    amountCents: Number(r.amount),
    remainingCents: Math.max(0, Number(r.remaining)),
  };
}

/**
 * Record the funds Stripe withdrew for a dispute on a proposal payment.
 * Idempotent on the dispute id (the reconciler's stripe_refund_id anchor): a
 * redelivery returns applied=false and writes nothing.
 *
 * @param {{proposalId:number, paymentId:number, paymentIntentId:string, disputeId:string,
 *          amountCents:number, disputeReason?:string}} args
 * @param {object} dbClient  the caller's transaction client
 * @returns {Promise<{applied:boolean}>}
 */
async function recordDisputeWithdrawal({ proposalId, paymentId, paymentIntentId, disputeId, amountCents, disputeReason }, dbClient) {
  const reason = `Chargeback: Stripe dispute ${disputeId} withdrew the funds (${disputeReason || 'no reason given'})`;
  const recon = await applyRefundReconciliation(
    {
      proposalId, stripeRefundId: disputeId, paymentIntentId, paymentId, amountCents,
      reason, issuedBy: null, totalScope: 'dispute', allowPendingHeuristic: false,
    },
    dbClient
  );
  if (recon.applied) {
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'dispute_funds_withdrawn', 'system', $2)`,
      [proposalId, JSON.stringify({ dispute_id: disputeId, amount: amountCents, payment_intent_id: paymentIntentId, payment_id: paymentId })]
    );
  }
  return recon;
}

/**
 * Reverse a recorded withdrawal once Stripe reinstates the funds (the dispute
 * was won). Re-credits the invoices the withdrawal re-opened (a positive
 * invoice_payments row per reversal row, stamped with the same refund id),
 * restores amount_paid, re-derives the status through the shared ladder and
 * marks the dispute row 'failed' (money that came back never left). Autopay
 * stays disarmed if the withdrawal disarmed it: re-arming a card the client
 * disputed is the admin's call. Idempotent: a row already reversed (or never
 * recorded) returns reversed=false and writes nothing.
 *
 * @param {{proposalId:number, disputeId:string}} args
 * @param {object} dbClient  the caller's transaction client
 * @returns {Promise<{reversed:boolean, amountCents:number}>}
 */
async function reverseDisputeWithdrawal({ proposalId, disputeId }, dbClient) {
  const propRes = await dbClient.query(
    'SELECT status, total_price, amount_paid FROM proposals WHERE id = $1 FOR UPDATE',
    [proposalId]
  );
  if (!propRes.rows[0]) return { reversed: false, amountCents: 0 };
  const rowRes = await dbClient.query(
    `SELECT id, payment_id, amount FROM proposal_refunds
      WHERE stripe_refund_id = $1 AND proposal_id = $2 AND status = 'succeeded' AND total_scope = 'dispute'
      FOR UPDATE`,
    [disputeId, proposalId]
  );
  const row = rowRes.rows[0];
  if (!row) return { reversed: false, amountCents: 0 };
  const amountCents = Number(row.amount);

  // The reversal rows the withdrawal wrote: one negative invoice_payments row
  // per invoice it re-opened, stamped with this refund row's id.
  const reversals = await dbClient.query(
    `SELECT ip.invoice_id, (-ip.amount)::int AS take, i.label
       FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
      WHERE ip.refund_id = $1 AND ip.amount < 0
      ORDER BY ip.id ASC`,
    [row.id]
  );
  let offLedgerCents = 0;
  for (const rev of reversals.rows) {
    const take = Number(rev.take);
    if (take <= 0) continue;
    if (OFF_LEDGER_INVOICE_LABELS.includes(rev.label)) offLedgerCents += take;
    await dbClient.query(
      'INSERT INTO invoice_payments (invoice_id, payment_id, amount, refund_id) VALUES ($1, $2, $3, $4)',
      [rev.invoice_id, row.payment_id, take, row.id]
    );
    const upd = await dbClient.query(
      'UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING amount_due, amount_paid',
      [take, rev.invoice_id]
    );
    if (upd.rows[0]) {
      const inv = upd.rows[0];
      const newStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
      await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, rev.invoice_id]);
      if (newStatus === 'paid') await lockInvoice(rev.invoice_id, dbClient);
    }
  }

  // Off-ledger money never entered amount_paid, so its return never does either
  // (the withdrawal left it out of the drop for the same reason).
  const moneyRes = await dbClient.query(
    `UPDATE proposals SET amount_paid = amount_paid + ($1 / 100.0)
      WHERE id = $2 RETURNING total_price, amount_paid`,
    [amountCents - offLedgerCents, proposalId]
  );
  const mr = moneyRes.rows[0];
  const statusBefore = propRes.rows[0].status;
  let statusAfter = statusBefore;
  if (mr) {
    const rec = reconcileProposalPaymentStatus({ status: statusBefore, amountPaid: mr.amount_paid, totalPrice: mr.total_price });
    if (rec.changed) {
      await dbClient.query('UPDATE proposals SET status = $1 WHERE id = $2', [rec.status, proposalId]);
      statusAfter = rec.status;
    }
  }

  await dbClient.query(
    `UPDATE proposal_refunds SET status = 'failed', reason = reason || ' (funds reinstated: the dispute was won)' WHERE id = $1`,
    [row.id]
  );
  await dbClient.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, 'dispute_funds_reinstated', 'system', $2)`,
    [proposalId, JSON.stringify({ dispute_id: disputeId, amount: amountCents, refund_row_id: row.id, status_before: statusBefore, status_after: statusAfter })]
  );
  return { reversed: true, amountCents };
}

module.exports = { findDisputedPayment, recordDisputeWithdrawal, reverseDisputeWithdrawal };
