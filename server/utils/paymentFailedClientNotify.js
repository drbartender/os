const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

// Client-facing "your card failed" email for a failed Stripe payment, sent once
// per proposal. Extracted from routes/stripe.js (over the file-size cap).
// Best-effort — owns its try/catch, never throws into the webhook handler.
//
// The slot is CLAIMED first with an atomic INSERT ... ON CONFLICT DO NOTHING
// against the partial unique index idx_proposal_activity_payment_failed_client,
// so concurrent Stripe retries can't both win — the proposal fetch and the send
// only run for the winner. If the send then fails, the claim is released so a
// later retry can still notify. (The admin gets a separate failure email on
// every attempt, so one client email per proposal is the right anti-spam bound.)
async function notifyClientPaymentFailed({ proposalId, paymentIntentId }) {
  try {
    const claim = await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'payment_failed_email_client', 'system', $2)
       ON CONFLICT (proposal_id) WHERE action = 'payment_failed_email_client'
       DO NOTHING
       RETURNING id`,
      [proposalId, JSON.stringify({ payment_intent_id: paymentIntentId })]
    );
    if (claim.rowCount !== 1) return; // already notified for this proposal

    const propRow = await pool.query(
      `SELECT p.token, p.event_type, p.event_type_custom,
              c.name AS client_name, c.email AS client_email
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1`,
      [proposalId]
    );
    const pc = propRow.rows[0];
    if (!pc?.client_email) {
      // No recipient — release the claim so a later retry (or a corrected
      // client record) can still notify.
      await pool.query('DELETE FROM proposal_activity_log WHERE id = $1', [claim.rows[0].id])
        .catch(() => {});
      return;
    }

    const tpl = emailTemplates.paymentFailedClient({
      clientName: pc.client_name,
      eventTypeLabel: getEventTypeLabel({
        event_type: pc.event_type,
        event_type_custom: pc.event_type_custom,
      }),
      last4: null, // not stored today — future task
      proposalUrl: `${PUBLIC_SITE_URL}/proposal/${pc.token}`,
    });
    try {
      await sendEmail({ to: pc.client_email, ...tpl });
    } catch (sendErr) {
      // Release the claim so a later retry can still notify the client.
      await pool.query('DELETE FROM proposal_activity_log WHERE id = $1', [claim.rows[0].id])
        .catch(() => {});
      throw sendErr;
    }
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { webhook: 'stripe', component: 'paymentFailedClient' },
      });
    }
    console.error('Client payment-failure email failed (non-blocking):', err);
  }
}

module.exports = { notifyClientPaymentFailed };
