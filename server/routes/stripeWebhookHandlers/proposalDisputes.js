// stripeWebhook concern: chargebacks on CLIENT payments (deposit / balance /
// full / invoice / drink-plan rails), audit 2026-11-05 H1.
//
// Before this, a dispute on a client payment reached only the tip clawback
// (disputes.js, keyed on tips.stripe_payment_intent_id) and was otherwise
// invisible: the booking stayed paid, autopay could charge the saved card on
// top of the disputed deposit, a refund could pay the money out twice, and a
// LOST dispute never touched amount_paid.
//
// Opened  (charge.dispute.created / charge.dispute.funds_withdrawn): stamp
//   proposals.dispute_open_at (autopay, admin Charge balance, admin refund and
//   cancel all refuse while it is set), one activity row, Sentry, admin email
//   with the evidence deadline.
// Closed  (charge.dispute.closed / charge.dispute.funds_reinstated): clear the
//   stamp, one activity row, admin email. LOST additionally books the reversal
//   through applyRefundReconciliation (amount_paid down, the paid invoice
//   reversed, payment status re-derived), keyed on the dispute id so a
//   redelivery no-ops. 'overpayment' scope: the contract total is NOT reduced
//   (refundHelpers: contractCents = 0 under that scope); a chargeback is money
//   taken back, not a renegotiated price, so the booking shows the amount owed
//   again.
//
// Idempotency: the dispute id in the activity row details (opened / closed are
// each written once per dispute), and the proposal_refunds unique index on the
// dispute id for the lost reversal. Both handlers take their own pool
// connections (the dispatcher holds none); the lost reversal runs in one
// transaction on one client.
'use strict';
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { applyRefundReconciliation } = require('../../utils/refundHelpers');
const { notifyAdminCategory } = require('../../utils/adminNotifications');
const { ADMIN_URL } = require('../../utils/urls');
const { esc } = require('../../utils/htmlEscape');

const usd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

/** The succeeded client payment a dispute's PaymentIntent paid, or null (a tip, or unknown). */
async function findDisputedPayment(paymentIntentId) {
  if (!paymentIntentId) return null;
  const { rows } = await pool.query(
    `SELECT pp.id, pp.proposal_id, pp.payment_type, pp.amount,
            p.status AS proposal_status, p.dispute_open_at, c.name AS client_name
       FROM proposal_payments pp
       JOIN proposals p ON p.id = pp.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE pp.stripe_payment_intent_id = $1 AND pp.status = 'succeeded'
      ORDER BY pp.id DESC
      LIMIT 1`,
    [paymentIntentId]
  );
  return rows[0] || null;
}

async function alreadyLogged(proposalId, action, disputeId, db = pool) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = $2 AND details->>'dispute_id' = $3
      LIMIT 1`,
    [proposalId, action, disputeId]
  );
  return rowCount > 0;
}

function warn(message, tags, extra) {
  console.warn(`[stripe/dispute] ${message}`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(message, { level: 'warning', tags: { webhook: 'stripe', ...tags }, extra });
  }
}

/**
 * A dispute opened on a client payment.
 * @returns {Promise<{handled:boolean, duplicate?:boolean}>}
 */
async function handleProposalDisputeOpened(dispute) {
  const payment = await findDisputedPayment(dispute && dispute.payment_intent);
  if (!payment) return { handled: false };
  const proposalId = payment.proposal_id;
  if (await alreadyLogged(proposalId, 'dispute_opened', dispute.id)) return { handled: true, duplicate: true };

  await pool.query(
    'UPDATE proposals SET dispute_open_at = COALESCE(dispute_open_at, NOW()) WHERE id = $1',
    [proposalId]
  );
  const dueBy = dispute.evidence_details && dispute.evidence_details.due_by
    ? new Date(dispute.evidence_details.due_by * 1000) : null;
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, 'dispute_opened', 'system', $2)`,
    [proposalId, JSON.stringify({
      dispute_id: dispute.id,
      payment_intent_id: dispute.payment_intent,
      payment_id: payment.id,
      payment_type: payment.payment_type,
      amount: Number(dispute.amount || 0),
      reason: dispute.reason || null,
      status: dispute.status || null,
      evidence_due_by: dueBy ? dueBy.toISOString() : null,
    })]
  );
  warn(
    `chargeback_opened (proposal ${proposalId}, ${payment.payment_type}, ${usd(dispute.amount)}, ${dispute.reason || 'no reason'}, ${dispute.id})`,
    { issue: 'dispute_opened' }, { proposalId, disputeId: dispute.id }
  );

  const adminUrl = `${ADMIN_URL}/proposals/${proposalId}`;
  const line = `A chargeback for ${usd(dispute.amount)} was opened on proposal #${proposalId}`
    + `${payment.client_name ? ` (${payment.client_name})` : ''}: ${payment.payment_type} payment, reason "${dispute.reason || 'not given'}". `
    + (dueBy ? `Evidence is due in Stripe by ${dueBy.toISOString().slice(0, 10)}. ` : 'Respond in the Stripe dashboard. ')
    + 'Until it closes, autopay will not charge this card and the proposal cannot be refunded or cancelled here.';
  await notifyAdminCategory({
    category: 'payment_failure',
    subject: `Chargeback opened: proposal #${proposalId} (${usd(dispute.amount)})`,
    emailText: `${line}\n\nAdmin: ${adminUrl}\nStripe dispute: ${dispute.id}`,
    emailHtml: `<p>${esc(line)}</p><p><a href="${esc(adminUrl)}">Open in admin</a> &middot; Stripe dispute ${esc(dispute.id)}</p>`,
  });
  return { handled: true };
}

/**
 * A dispute closed (won, lost, or withdrawn). LOST books the reversal.
 * @returns {Promise<{handled:boolean, duplicate?:boolean, lost?:boolean}>}
 */
async function handleProposalDisputeClosed(dispute) {
  const payment = await findDisputedPayment(dispute && dispute.payment_intent);
  if (!payment) return { handled: false };
  const proposalId = payment.proposal_id;
  if (await alreadyLogged(proposalId, 'dispute_closed', dispute.id)) return { handled: true, duplicate: true };

  const lost = dispute.status === 'lost';
  const amountCents = Number(dispute.amount || 0);
  const dbClient = await pool.connect();
  let reversal = { applied: false };
  try {
    await dbClient.query('BEGIN');
    if (lost && amountCents > 0) {
      reversal = await applyRefundReconciliation({
        proposalId,
        stripeRefundId: dispute.id,
        paymentIntentId: dispute.payment_intent,
        paymentId: payment.id,
        amountCents,
        reason: `Chargeback lost (${dispute.reason || 'no reason given'}, ${dispute.id})`,
        issuedBy: null,
        totalScope: 'overpayment',
        pendingRowId: null,
        allowPendingHeuristic: false,
      }, dbClient);
    }
    await dbClient.query('UPDATE proposals SET dispute_open_at = NULL WHERE id = $1', [proposalId]);
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'dispute_closed', 'system', $2)`,
      [proposalId, JSON.stringify({
        dispute_id: dispute.id,
        payment_intent_id: dispute.payment_intent,
        payment_id: payment.id,
        amount: amountCents,
        status: dispute.status || null,
        reversal_applied: !!reversal.applied,
      })]
    );
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err; // Stripe retries the delivery; nothing above committed.
  } finally {
    dbClient.release();
  }

  const adminUrl = `${ADMIN_URL}/proposals/${proposalId}`;
  let outcome;
  if (lost) {
    outcome = `was LOST. ${usd(amountCents)} has been taken back by the cardholder's bank and the booking now shows it as unpaid again`
      + `${reversal.applied ? '' : ' (the ledger reversal was already recorded)'}. Autopay and refunds are unblocked.`;
  } else if (dispute.status === 'won') {
    outcome = 'was WON. The funds stay with you. Autopay and refunds are unblocked.';
  } else {
    outcome = `closed as "${dispute.status || 'unknown'}". Autopay and refunds are unblocked.`;
  }
  warn(
    `chargeback_closed (proposal ${proposalId}, ${dispute.status}, ${usd(amountCents)}, ${dispute.id})`,
    { issue: 'dispute_closed' }, { proposalId, disputeId: dispute.id, lost }
  );
  const line = `The chargeback for ${usd(amountCents)} on proposal #${proposalId}`
    + `${payment.client_name ? ` (${payment.client_name})` : ''} ${outcome}`;
  const verdict = lost ? 'lost' : dispute.status === 'won' ? 'won' : 'closed';
  await notifyAdminCategory({
    category: lost ? 'payment_failure' : 'routine_finance',
    subject: `Chargeback ${verdict}: proposal #${proposalId} (${usd(amountCents)})`,
    emailText: `${line}\n\nAdmin: ${adminUrl}\nStripe dispute: ${dispute.id}`,
    emailHtml: `<p>${esc(line)}</p><p><a href="${esc(adminUrl)}">Open in admin</a> &middot; Stripe dispute ${esc(dispute.id)}</p>`,
  });
  return { handled: true, lost };
}

module.exports = { handleProposalDisputeOpened, handleProposalDisputeClosed, findDisputedPayment };
