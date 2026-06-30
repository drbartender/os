'use strict';

// Staff-facing staffing emails. Currently: the low-key "you're on the waitlist"
// note sent when a staffer requests an event that is already fully staffed.

const Sentry = require('@sentry/node');
const { sendEmail } = require('./email');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Notify a staffer that they have been added to the waitlist for a fully-staffed
 * event. Email-only and deliberately low-key. Non-throwing: gated by
 * SEND_NOTIFICATIONS through sendEmail's own log-and-skip path, and wrapped so a
 * Resend hiccup can never break the request flow. The "only send on the
 * transition INTO waitlisted" dedup lives at the call site (the request
 * endpoint), so this fires once, not on every re-rank.
 *
 * @param {object} args
 * @param {string} args.to         staffer email
 * @param {string} [args.staffName] preferred name (falls back to a greeting)
 * @param {string} [args.eventLabel] human event label (already resolved by caller)
 */
async function sendWaitlistJoinEmail({ to, staffName, eventLabel } = {}) {
  if (!to) return;
  const name = staffName || 'there';
  const event = eventLabel || 'that event';
  const subject = `You're on the waitlist for ${event}`;
  const html = `<p>Hi ${esc(name)},</p>
<p>Thanks for offering to work <strong>${esc(event)}</strong>. It is currently fully staffed, so we have added you to the waitlist. If a spot opens up we will reach out, no action needed on your end.</p>
<p>You can leave the waitlist any time from your shifts list.</p>
<p>The Dr. Bartender Team</p>`;
  const text = `Hi ${name}, thanks for offering to work ${event}. It is currently fully staffed, so we have added you to the waitlist. If a spot opens up we will reach out. You can leave the waitlist any time from your shifts list. The Dr. Bartender Team`;
  try {
    await sendEmail({ to, subject, html, text });
  } catch (err) {
    console.error('[staffingEmailTemplates] waitlist-join email failed:', err.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'staffing-waitlist', channel: 'email' } });
    }
  }
}

module.exports = { sendWaitlistJoinEmail };
