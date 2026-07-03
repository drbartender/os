// stripeWebhook concern: payment_intent.payment_failed. Extracted verbatim from
// stripeWebhook.js — records the failed payment (with the L1 monotonic-failure
// guard), logs it, and notifies admins + the client. Returns via res only on the
// stale-after-success early-ack; otherwise falls through to the dispatcher's ack.
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { notifyAdminCategory } = require('../../utils/adminNotifications');
const { notifyClientPaymentFailed } = require('../../utils/paymentFailedClientNotify');
const { ADMIN_URL } = require('../../utils/urls');
const { esc } = require('../../utils/htmlEscape');
const { eventLabelFor } = require('../../utils/stripeRouteHelpers');

module.exports = async function handlePaymentIntentFailed(event, res) {
    const intent = event.data.object;
    const proposalId = intent.metadata?.proposal_id;
    const paymentType = intent.metadata?.payment_type || 'deposit';

    if (proposalId) {
      try {
        // Monotonic-failure guard (L1): Stripe can deliver a stale payment_failed
        // AFTER the same PI already succeeded (a retry on the same PI, delivered
        // out of order). Flipping the session to 'failed', inserting a failed row,
        // and emailing the client "payment failed" for money we already captured is
        // wrong. If a succeeded proposal_payments row exists for this PI, ack and
        // skip all failure handling.
        const priorSuccess = await pool.query(
          "SELECT 1 FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = 'succeeded' LIMIT 1",
          [intent.id]
        );
        if (priorSuccess.rows[0]) {
          console.log(`Webhook: payment_failed for intent ${intent.id} (proposal ${proposalId}) arrived after a succeeded payment, skipping failure handling`);
          return res.json({ received: true });
        }

        // Three independent writes — parallelize via Promise.all.
        await Promise.all([
          pool.query(
            "UPDATE stripe_sessions SET status = 'failed' WHERE stripe_payment_intent_id = $1",
            [intent.id]
          ),
          pool.query(
            `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
             VALUES ($1, $2, $3, $4, 'failed')`,
            [proposalId, intent.id, paymentType, intent.amount]
          ),
          pool.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'payment_failed', 'system', $2)`,
            [proposalId, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id, payment_type: paymentType, failure_message: intent.last_payment_error?.message || null })]
          ),
        ]);
        console.warn(`Payment FAILED (${paymentType}) for proposal ${proposalId}: ${intent.last_payment_error?.message || 'unknown'}`);

        // Notify admins subscribed to payment_failure of a failed payment.
        const payInfo = await pool.query(`SELECT p.event_type, p.event_type_custom, c.name AS client_name FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`, [proposalId]);
        const failPi = payInfo.rows[0];
        const failReason = intent.last_payment_error?.message || 'Unknown error';
        const failAmount = `$${(intent.amount / 100).toFixed(2)}`;
        const failClient = failPi?.client_name || 'Unknown';
        await notifyAdminCategory({
          category: 'payment_failure',
          subject: `Payment failed: ${failClient} (${eventLabelFor(failPi)})`,
          emailHtml: `<p>A ${esc(paymentType)} payment of ${esc(failAmount)} failed for <strong>${esc(failClient)}</strong>.</p><p><strong>Reason:</strong> ${esc(failReason)}</p><p><a href="${ADMIN_URL}/proposals/${esc(proposalId)}">View Proposal</a></p>`,
          emailText: `A ${paymentType} payment of ${failAmount} failed for ${failClient}. Reason: ${failReason}. ${ADMIN_URL}/proposals/${proposalId}`,
        });

        // Client-facing payment-failure email (throttled 1/24h per proposal),
        // extracted to a sibling util so this over-cap file stays flat.
        await notifyClientPaymentFailed({ proposalId, paymentIntentId: intent.id });
      } catch (err) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, {
            tags: { webhook: 'stripe', route: '/webhook' },
          });
        }
        console.error('payment_intent.payment_failed handler error:', err);
      }
    }
};
