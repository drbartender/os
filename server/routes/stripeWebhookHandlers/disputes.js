// stripeWebhook concern: charge.dispute.* events.
//
// Two populations share a PaymentIntent id space: card TIPS (tips table) and
// CLIENT PAYMENTS (proposal_payments). The tip half is the original code
// (extracted verbatim from stripeWebhook.js: clawback on withdrawal, the
// dispute-won notification on reinstatement). The client-payment half
// (proposalDisputes.js, audit 2026-11-05 H1) is routed from the same events:
// a dispute on a non-tip intent flags the proposal on open and books the
// reversal on a loss. funds_reinstated returns via res (early ack);
// funds_withdrawn / created / closed fall through to the dispatcher's ack.
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { clawbackTipByPaymentIntent, rewindDisputeClawbackByPaymentIntent } = require('../../utils/payrollClawback');
const { handleProposalDisputeOpened, handleProposalDisputeClosed } = require('./proposalDisputes');

async function isTipIntent(piId) {
  if (!piId) return false;
  const { rows } = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1', [piId]);
  return !!rows[0];
}

/** charge.dispute.created: client-payment disputes only (a tip waits for funds_withdrawn). */
async function handleDisputeCreated(event) {
    const dispute = event.data.object;
    if (await isTipIntent(dispute.payment_intent)) return;
    await handleProposalDisputeOpened(dispute);
}

async function handleDisputeFundsWithdrawn(event) {
    const dispute = event.data.object;
    if (await isTipIntent(dispute.payment_intent)) {
      await clawbackTipByPaymentIntent(dispute.payment_intent, Number(dispute.amount || 0));
      return;
    }
    // Opened is idempotent on the dispute id, so created + funds_withdrawn
    // (Stripe sends both) flag the proposal once; this one also covers an
    // account that never subscribed to charge.dispute.created.
    await handleProposalDisputeOpened(dispute);
}

/** charge.dispute.closed: won / lost / warning_closed on a client payment. */
async function handleDisputeClosed(event) {
    const dispute = event.data.object;
    if (await isTipIntent(dispute.payment_intent)) return; // tips settle on funds_reinstated
    await handleProposalDisputeClosed(dispute);
}

async function handleDisputeFundsReinstated(event, res) {
    const dispute = event.data.object;
    const piId = dispute.payment_intent;
    if (piId) {
      if (!(await isTipIntent(piId))) {
        // A client-payment dispute we WON. Clears the flag; idempotent with a
        // charge.dispute.closed delivery for the same dispute.
        await handleProposalDisputeClosed({ ...dispute, status: dispute.status || 'won' });
        return res.json({ received: true });
      }
      // F5: roll the clawback counter back FIRST, decoupled from the admin email.
      // Not gated on dispute_won_at (the ledger must not wait on email delivery)
      // — it carries its own idempotency column, tips.dispute_reinstated_at.
      // Errors propagate so Stripe retries the delivery; the rewind is a no-op
      // on redelivery, and notifyDisputeWon below is idempotent via dispute_won_at.
      await rewindDisputeClawbackByPaymentIntent(piId, Number(dispute.amount || 0));

      const { rows } = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1', [piId]);
      if (rows[0]) {
        try {
          const { notifyDisputeWon } = require('../../utils/payrollDisputeNotify');
          await notifyDisputeWon(rows[0].id, {
            reinstatedAmountCents: Number(dispute.amount || 0),
            disputeOpenedAt: dispute.created ? new Date(dispute.created * 1000) : null,
            disputeWonAt: new Date(),
          });
        } catch (err) { Sentry.captureException(err, { tags: { webhook: 'tip_dispute_won' } }); }
      }
    }
    return res.json({ received: true });
}

module.exports = {
  handleDisputeCreated, handleDisputeFundsWithdrawn, handleDisputeClosed, handleDisputeFundsReinstated,
};
