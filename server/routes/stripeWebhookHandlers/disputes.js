// stripeWebhook concern: charge.dispute.funds_withdrawn / funds_reinstated.
// Extracted verbatim from stripeWebhook.js — tip clawback on withdrawal, and the
// dispute-won notification on reinstatement. funds_reinstated returns via res
// (early ack); funds_withdrawn falls through to the dispatcher's ack.
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { clawbackTipByPaymentIntent, rewindDisputeClawbackByPaymentIntent } = require('../../utils/payrollClawback');

async function handleDisputeFundsWithdrawn(event) {
    const dispute = event.data.object;
    await clawbackTipByPaymentIntent(dispute.payment_intent, Number(dispute.amount || 0));
}

async function handleDisputeFundsReinstated(event, res) {
    const dispute = event.data.object;
    const piId = dispute.payment_intent;
    if (piId) {
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

module.exports = { handleDisputeFundsWithdrawn, handleDisputeFundsReinstated };
