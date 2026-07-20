// Stripe payment-notification emails + SMS (lifted out of the webhook handler so
// server/routes/stripe.js and server/routes/stripeWebhook.js stay under the size cap).
// Pure post-commit notifier: takes (proposalId, amountCents, paymentType), reads the
// proposal/client, and sends the client receipt/orientation + the admin notification.
// Self-contained — depends only on its args and these module-level helpers.
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { notifyAdminCategory } = require('./adminNotifications');
const { renderEventIcs } = require('./icsCalendar');
const { buildOrientationPayload } = require('./orientationData');
const { shouldSendImmediate } = require('./messageSuppression');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('./urls');
const { eventLabelFor } = require('./stripeRouteHelpers');
const { formatEventDateForSms } = require('./smsEventDate');

async function sendPaymentNotifications(proposalId, amountCents, paymentType) {
  try {
    const payInfo = await pool.query(`
      SELECT p.event_type, p.event_type_custom, p.client_signed_at, p.last_minute_hold,
             p.autopay_enrolled, p.status, p.client_id, p.event_date,
             c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
             c.communication_preferences, c.email_status, c.phone_status
      FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1
    `, [proposalId]);
    const pi = payInfo.rows[0];
    const amountFormatted = (amountCents / 100).toFixed(2);
    const payLabel = paymentType === 'full' ? 'full payment' : paymentType === 'balance' ? 'balance payment' : paymentType === 'invoice' ? 'invoice payment' : 'deposit';
    const eventLabel = eventLabelFor(pi);

    // Coupled sign+pay: if the client signed within the last 6 hours and this
    // is a first-time payment (deposit or full), send ONE combined email in
    // place of the separate sign + payment emails the sign route would
    // otherwise have already fired.
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const isCoupledSigning =
      !!pi?.client_signed_at
      && (Date.now() - new Date(pi.client_signed_at).getTime()) < SIX_HOURS_MS
      && (paymentType === 'deposit' || paymentType === 'full');

    if (pi?.client_email) {
      // last_minute_hold was set in-tx and committed before this post-commit
      // notifier runs, so the flag is readable here. Append the cancellation
      // caveat to the first-payment client email when the booking is ≤72h out.
      const lastMinute = !!pi?.last_minute_hold;

      // Respect the same suppression rules the dispatcher applies on scheduled rows.
      const proposalForCheck = { id: proposalId, status: pi.status || 'deposit_paid' };
      const clientForCheck = {
        id: pi.client_id,
        communication_preferences: pi.communication_preferences,
        email_status: pi.email_status,
        phone_status: pi.phone_status,
      };
      const sendCheck = await shouldSendImmediate({
        proposal: proposalForCheck,
        client: clientForCheck,
        channel: 'email',
      });
      if (!sendCheck.ok) {
        console.log(`[orientation] suppressed for proposal ${proposalId}: ${sendCheck.reason}`);
        // Skip the client-email branch; downstream admin email still fires.
      } else if (isCoupledSigning) {
        // FULL ORIENTATION: assemble payload, build .ics, send with attachment.
        try {
          const payload = await buildOrientationPayload(proposalId, { publicSiteUrl: PUBLIC_SITE_URL });
          if (!payload) {
            console.error(`[orientation] could not load proposal ${proposalId}, skipping`);
          } else {
            const bookingBlock = {
              formattedEventDate: payload.formattedEventDate,
              formattedStartTime: payload.formattedStartTime,
              eventLocation: payload.eventLocation,
              guestCount: payload.guestCount,
              packageName: payload.packageName,
            };
            const receiptBlock = {
              depositPaid: amountFormatted,
              balanceRemaining: payload.balance.balanceRemaining.toFixed(2),
              paidInFull: payload.balance.paidInFull,
              autopayEnrolled: payload.balance.autopayEnrolled,
              dueLabel: payload.balance.dueLabel,
              formattedBalanceDueDate: payload.balance.formattedBalanceDueDate,
            };

            // Arrival is the published 30-to-90 range, NOT
            // payload.setupMinutesBefore. The derived per-proposal arrival is
            // back-of-house (setupTime.js); stating it here commits us in
            // writing at booking time to a minute count the crew has to beat.
            const timelineLines = [
              payload.potionPlannerUrl
                ? 'Drink plan: pick yours any time'
                : 'Drink plan: we will be in touch with your planner link',
              payload.balance.paidInFull
                ? 'Balance: paid in full'
                : `Balance: ${payload.balance.dueLabel}${payload.balance.formattedBalanceDueDate ? ` ${payload.balance.formattedBalanceDueDate}` : ''}`,
              'Bartender assignment: about 14 days before the event',
              'Day-of: your bartender arrives 30 to 90 minutes before your start time to set up',
            ];

            const attachments = [];
            if (payload.utc) {
              const ics = renderEventIcs({
                uid: `proposal-${proposalId}@drbartender.com`,
                startUtc: payload.utc.startUtc,
                endUtc: payload.utc.endUtc,
                summary: `${eventLabel} with Dr. Bartender`,
                location: payload.eventLocation,
                description: `Your booking with Dr. Bartender. Reply to this email with any questions.`,
                stampUtc: new Date(),
              });
              attachments.push({ filename: 'event.ics', content: Buffer.from(ics, 'utf8') });
            }

            const tpl = emailTemplates.signedAndPaidClient({
              clientName: pi.client_name,
              eventTypeLabel: eventLabel,
              amount: amountFormatted,
              paymentType: payLabel,
              lastMinute,
              bookingBlock,
              receiptBlock,
              potionPlannerUrl: payload.potionPlannerUrl,
              timelineLines,
            });
            await sendEmail({
              to: pi.client_email,
              ...tpl,
              ...(attachments.length ? { attachments } : {}), meta: { proposalId, messageType: 'signed_and_paid' },
            });
          }
        } catch (orientationErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(orientationErr, {
              tags: { route: '/webhook', step: 'orientation_email', proposalId: String(proposalId) },
            });
          }
          console.error('[orientation] failed (non-blocking):', orientationErr);
          // Fall back to the old short-form path so the client at least hears back.
          const tpl = emailTemplates.signedAndPaidClient({
            clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute,
          });
          await sendEmail({ to: pi.client_email, ...tpl, meta: { proposalId, messageType: 'signed_and_paid' } });
        }

        // Phase 3 (spec 2.1): sign+pay confirmation SMS, sent alongside the
        // orientation email. Best-effort — own try/catch, never rethrown into
        // the webhook handler. Gated by the same SMS suppression rule the
        // dispatcher applies to scheduled rows.
        try {
          const smsCheck = await shouldSendImmediate({
            proposal: proposalForCheck,
            client: clientForCheck,
            channel: 'sms',
          });
          if (smsCheck.ok) {
            const { sendAndLogSms } = require('./sms');
            const smsTemplates = require('./smsTemplates');
            await sendAndLogSms({
              to: pi.client_phone,
              body: smsTemplates.signPayConfirmationSms({ eventDate: formatEventDateForSms(pi.event_date) }),
              clientId: pi.client_id || null,
              messageType: 'sign_pay_confirmation',
              recipientName: pi.client_name || null,
            });
          } else {
            console.log(`[signPaySms] suppressed for proposal ${proposalId}: ${smsCheck.reason}`);
          }
        } catch (smsErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(smsErr, {
              tags: { webhook: 'stripe', route: '/webhook', step: 'sign_pay_sms' },
            });
          }
          console.error('Sign+pay confirmation SMS failed (non-blocking):', smsErr);
        }
      } else {
        // Non-coupled payment. Detect autopay-driven balance charge so the
        // autopay-specific receipt copy variant fires.
        const isAutopaySuccess = paymentType === 'balance' && pi?.autopay_enrolled === true;
        const tpl = emailTemplates.paymentReceivedClient({
          clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute, autopay: isAutopaySuccess,
        });
        await sendEmail({ to: pi.client_email, ...tpl, meta: { proposalId, messageType: 'payment_received' } });
      }
    }
    // Admin notification consolidation: the standalone clientSignedAdmin fires
    // from the public-token signing route. In the canonical sign+pay coupled
    // flow, the payment arrives within ~6 hours of the signature, and the
    // post-commit notifier here suppresses the standalone paymentReceivedAdmin
    // in favor of signedAndPaidAdmin (urgent_booking); a standalone balance
    // payment routes to routine_finance. Spec section 6.
    const adminUrl = `${ADMIN_URL}/proposals/${proposalId}`;
    const adminTpl = isCoupledSigning
      ? emailTemplates.signedAndPaidAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl })
      : emailTemplates.paymentReceivedAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl });
    await notifyAdminCategory({ category: isCoupledSigning ? 'urgent_booking' : 'routine_finance', subject: adminTpl.subject, emailHtml: adminTpl.html, emailText: adminTpl.text });
  } catch (emailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(emailErr, {
        tags: { webhook: 'stripe', route: '/webhook' },
      });
    }
    console.error('Payment notification email failed (non-blocking):', emailErr);
  }
}

module.exports = { sendPaymentNotifications };
