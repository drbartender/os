const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { shouldSendImmediate } = require('./messageSuppression');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

// Client-facing "your card failed" email + SMS for a failed Stripe payment,
// sent once per proposal (spec 3.3, email + SMS together, urgent). Extracted
// from routes/stripe.js (over the file-size cap). Best-effort — owns its
// try/catch, never throws into the webhook handler.
//
// The slot is CLAIMED first with an atomic INSERT ... ON CONFLICT DO NOTHING
// against the partial unique index idx_proposal_activity_payment_failed_client,
// so concurrent Stripe retries can't both win — the proposal fetch and the
// sends only run for the winner. The email AND the SMS are the single
// client-facing payment-failure touch, so they share this one claim: a client
// gets at most one email and one SMS per proposal. If the EMAIL send fails the
// claim is released so a later retry can still notify (an SMS failure does not
// release — the email is the load-bearing channel for the release decision,
// and sendAndLogSms already logs the failed SMS row).
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
      `SELECT p.token, p.status, p.event_type, p.event_type_custom, p.event_date,
              c.id AS client_id, c.name AS client_name, c.email AS client_email,
              c.phone AS client_phone, c.communication_preferences,
              c.email_status, c.phone_status
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1`,
      [proposalId]
    );
    const pc = propRow.rows[0];
    if (!pc?.client_email && !pc?.client_phone) {
      // No recipient on either channel — release the claim so a later retry
      // (or a corrected client record) can still notify.
      await pool.query('DELETE FROM proposal_activity_log WHERE id = $1', [claim.rows[0].id])
        .catch(() => {});
      return;
    }

    const eventTypeLabel = getEventTypeLabel({
      event_type: pc.event_type,
      event_type_custom: pc.event_type_custom,
    });
    const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${pc.token}`;

    // ── Email half ──
    if (pc.client_email) {
      const tpl = emailTemplates.paymentFailedClient({
        clientName: pc.client_name,
        eventTypeLabel,
        last4: null, // not stored today — future task
        proposalUrl,
      });
      try {
        await sendEmail({ to: pc.client_email, ...tpl });
      } catch (sendErr) {
        // Release the claim so a later retry can still notify the client.
        await pool.query('DELETE FROM proposal_activity_log WHERE id = $1', [claim.rows[0].id])
          .catch(() => {});
        throw sendErr;
      }
    }

    // ── SMS half (Phase 3, spec 3.3) — separate try/catch so an SMS failure
    // does not release the claim or mask the email's success. ──
    try {
      const smsCheck = await shouldSendImmediate({
        proposal: { status: pc.status },
        client: {
          communication_preferences: pc.communication_preferences,
          email_status: pc.email_status,
          phone_status: pc.phone_status,
        },
        channel: 'sms',
      });
      if (smsCheck.ok && pc.client_phone) {
        const eventDateSms = pc.event_date
          ? new Date(String(pc.event_date).slice(0, 10) + 'T12:00:00Z')
              .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' })
          : 'your event';
        await sendAndLogSms({
          to: pc.client_phone,
          body: smsTemplates.paymentFailureSms({ eventDate: eventDateSms, link: proposalUrl }),
          clientId: pc.client_id || null,
          messageType: 'payment_failure',
          recipientName: pc.client_name || null,
        });
      } else if (!smsCheck.ok) {
        console.log(`[paymentFailureSms] suppressed for proposal ${proposalId}: ${smsCheck.reason}`);
      }
    } catch (smsErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(smsErr, {
          tags: { webhook: 'stripe', component: 'paymentFailedClient', issue: 'sms' },
        });
      }
      console.error('Client payment-failure SMS failed (non-blocking):', smsErr.message);
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
