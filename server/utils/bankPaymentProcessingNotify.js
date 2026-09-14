// server/utils/bankPaymentProcessingNotify.js
'use strict';
// Client-facing "we received your bank payment" email (spec 2026-09-14
// section 9). Post-commit, best effort: owns its try/catch and never throws
// into the webhook handler. Email only, no SMS (Dallas, 2026-09-14). Gated
// the same way the payment receipt is (stripePaymentNotifications.js):
// shouldSendImmediate with the client's email_status and preferences, so a bad
// address gets nothing, as today. Takes its own pooled connection, so it must
// run AFTER the handler has released its transaction client.
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { bankPaymentProcessingClient } = require('./lifecycleEmailTemplates');
const { shouldSendImmediate } = require('./messageSuppression');
const { getEventTypeLabel } = require('./eventTypes');
const { proposalUrl } = require('./urls');
const { formatEventDateLong } = require('./staffShiftHandlers');
const { notifyAdminCategory } = require('./adminNotifications');
const { ADMIN_URL } = require('./urls');
const { esc } = require('./htmlEscape');

async function notifyClientBankPaymentProcessing({ proposalId, amountCents, paymentType }) {
  try {
    const { rows } = await pool.query(
      `SELECT p.token, p.status, p.event_type, p.event_type_custom, p.event_date, p.event_timezone,
              c.id AS client_id, c.name AS client_name, c.email AS client_email,
              c.communication_preferences, c.email_status, c.phone_status
         FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1`,
      [proposalId]
    );
    const pc = rows[0];
    if (!pc || !pc.client_email) return { sent: false, reason: 'no_email' };
    const check = await shouldSendImmediate({
      proposal: { id: proposalId, status: pc.status },
      client: {
        id: pc.client_id,
        communication_preferences: pc.communication_preferences,
        email_status: pc.email_status,
        phone_status: pc.phone_status,
      },
      channel: 'email',
    });
    if (!check.ok) return { sent: false, reason: check.reason };
    // Only a parseable date is formatted; the formatter's own fallback string
    // is never compared against, so a reworded fallback cannot leak into copy.
    const eventDate = pc.event_date && !Number.isNaN(new Date(pc.event_date).getTime())
      ? formatEventDateLong({ event_date: pc.event_date, event_timezone: pc.event_timezone })
      : null;
    const tpl = bankPaymentProcessingClient({
      clientName: pc.client_name,
      amountCents,
      paymentType,
      eventTypeLabel: getEventTypeLabel({ event_type: pc.event_type, event_type_custom: pc.event_type_custom }),
      eventDate,
      proposalUrl: proposalUrl(pc.token),
    });
    await sendEmail({ to: pc.client_email, ...tpl });
    return { sent: true };
  } catch (err) {
    console.error('notifyClientBankPaymentProcessing failed (non-blocking):', err && err.message);
    return { sent: false, reason: 'error' };
  }
}

// The admin half (spec review 2026-09-14, M2). The signing route suppresses
// its "client signed" admin email when an intent is pending, on the premise
// that a "Signed and Paid" email follows the succeeded webhook; for a bank
// debit that is days away, so this is the only admin signal in the window.
// Initial-booking types (deposit, full) are a booking with money in flight and
// go to urgent_booking, like the signed email would have; everything else is
// routine finance. Best effort, never throws.
async function notifyAdminBankPaymentProcessing({ proposalId, amountCents, paymentType }) {
  try {
    const { rows } = await pool.query(
      `SELECT p.event_type, p.event_type_custom, c.name AS client_name
         FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1`,
      [proposalId]
    );
    const pc = rows[0];
    if (!pc) return { sent: false, reason: 'no_proposal' };
    const dollars = `$${(Number(amountCents || 0) / 100).toFixed(2)}`;
    const label = getEventTypeLabel({ event_type: pc.event_type, event_type_custom: pc.event_type_custom });
    const client = pc.client_name || 'A client';
    const initial = paymentType === 'deposit' || paymentType === 'full';
    const line = `${client} paid ${dollars} (${paymentType}) toward their ${label} by bank debit. It is processing at Stripe and clears in four to six business days; the proposal shows it as processing until then. Nothing to do unless it bounces, which arrives as a payment failure.`;
    const url = `${ADMIN_URL}/proposals/${proposalId}`;
    await notifyAdminCategory({
      category: initial ? 'urgent_booking' : 'routine_finance',
      subject: `Bank payment processing: ${client} (${label})`,
      emailText: `${line} ${url}`,
      emailHtml: `<p>${esc(line)}</p><p><a href="${url}">Open proposal #${proposalId}</a></p>`,
    });
    return { sent: true };
  } catch (err) {
    console.error('notifyAdminBankPaymentProcessing failed (non-blocking):', err && err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { notifyClientBankPaymentProcessing, notifyAdminBankPaymentProcessing };
