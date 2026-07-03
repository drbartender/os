// stripeWebhook concern: charge.refunded. Extracted verbatim from
// stripeWebhook.js — reconciles a dashboard/in-app refund against the proposal,
// notifies the client only when THIS request applied it, and runs the tip
// clawback. No res used; falls through to the dispatcher's ack.
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { clawbackTipByPaymentIntent } = require('../../utils/payrollClawback');

module.exports = async function handleChargeRefunded(event) {
    const charge = event.data.object;
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
    // refunds.data is newest-first, so data[0] is the refund this event is about.
    // A mis-pick in a multi-refund race is harmless: unique stripe_refund_id makes
    // applyRefundReconciliation a no-op for an id already applied by the sync route.
    const refundObj = charge.refunds?.data?.[0];
    const proposalId = charge.metadata?.proposal_id
      || (paymentIntentId
            ? (await pool.query(
                'SELECT proposal_id FROM proposal_payments WHERE stripe_payment_intent_id = $1 LIMIT 1',
                [paymentIntentId]
              )).rows[0]?.proposal_id
            : null);

    if (proposalId && refundObj && paymentIntentId) {
      const dbClient = await pool.connect();
      let recon = null;
      try {
        await dbClient.query('BEGIN');
        const payRow = await dbClient.query(
          `SELECT id FROM proposal_payments
            WHERE stripe_payment_intent_id = $1 AND status = 'succeeded' LIMIT 1`,
          [paymentIntentId]
        );
        const { applyRefundReconciliation } = require('../../utils/refundHelpers');
        recon = await applyRefundReconciliation(
          {
            proposalId: Number(proposalId),
            stripeRefundId: refundObj.id,
            paymentIntentId,
            paymentId: payRow.rows[0]?.id ?? null,
            amountCents: refundObj.amount,
            reason: 'Refunded via Stripe dashboard',
            issuedBy: null,
          },
          dbClient
        );
        await dbClient.query('COMMIT');
        console.log(`charge.refunded reconciled for proposal ${proposalId} (refund ${refundObj.id})`);
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dbErr, { tags: { webhook: 'stripe', event: 'charge.refunded' } });
        }
        console.error('Webhook charge.refunded error:', dbErr);
        throw dbErr; // 5xx → Stripe retries (same posture as payment_intent.succeeded)
      } finally {
        dbClient.release();
      }

      // Notify the client only when THIS request actually applied the refund.
      // Dashboard-issued refunds land here first (recon.applied true) and the
      // client gets the same notification email the in-app route would send.
      // When the webhook fires after an in-app refund, recon.applied is false
      // (the in-app route already applied) and we skip to avoid double-send.
      if (recon?.applied) {
        const { sendRefundClientNotification } = require('../../utils/refundClientNotify');
        await sendRefundClientNotification({
          proposalId,
          amountCents: refundObj.amount,
          source: 'webhook',
        });
      }
    }
    // Tip-clawback path: no-ops when paymentIntentId is not a tip.
    await clawbackTipByPaymentIntent(paymentIntentId, Number(charge.amount_refunded || 0));
};
