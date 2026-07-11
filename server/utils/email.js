const { Resend } = require('resend');
const { notificationsEnabled } = require('./notificationsEnabled');
const { QuotaExceededError } = require('./errors');
const { buildEmailLogEntry, logClientMessage } = require('./messageLog');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM_EMAIL = 'Dr. Bartender <no-reply@drbartender.com>';

if (!process.env.RESEND_API_KEY) {
  console.warn('[email] RESEND_API_KEY is NOT set — emails will be logged only, not sent');
} else if (!notificationsEnabled()) {
  console.log('[email] Resend initialized, but notifications are gated OFF (set SEND_NOTIFICATIONS=true to send) — emails will be logged only');
} else {
  console.log('[email] Resend initialized');
}

/**
 * Detect a Resend daily-quota / rate-limit rejection so callers (and the
 * scheduled-message dispatcher) can treat it as a transient, retryable
 * condition (defer + retry after reset) instead of a hard, terminal failure.
 */
function isQuotaError(error) {
  if (!error) return false;
  const name = String(error.name || '').toLowerCase();
  const msg = String(error.message || '').toLowerCase();
  const status = error.statusCode || error.status || null;
  return (
    status === 429 ||
    name.includes('rate_limit') ||
    name.includes('quota') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

/**
 * Send an email via Resend
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text fallback
 * @param {string} [options.from] - Override default from address
 * @param {string} [options.replyTo] - Reply-to address
 * @param {Array<{filename: string, content: Buffer|string}>} [options.attachments] - Resend attachments
 * @returns {Promise<{id: string}>}
 */
async function sendEmail({ to, subject, html, text, from, replyTo, attachments, meta }) {
  // RFC-2606 `.invalid` recipients are import placeholders (staff-payment
  // import, spec 2026-07-10) — a send to one is always a bug, so drop them
  // before any provider/gating logic.
  const recipients = (Array.isArray(to) ? to : [to])
    .filter((a) => !String(a).toLowerCase().trim().endsWith('.invalid'));
  if (recipients.length === 0) {
    console.log(`[email] skipped: all recipients .invalid → ${to} | Subject: ${subject}`);
    return { id: 'skipped-invalid' };
  }
  to = recipients.length === 1 ? recipients[0] : recipients;

  if (!resend || !notificationsEnabled()) {
    const why = !resend ? 'RESEND_API_KEY not set' : 'notifications gated off';
    console.log(`[DEV] Email skipped (${why}) → ${to} | Subject: ${subject}${attachments ? ` (with ${attachments.length} attachment(s))` : ''}`);
    return { id: 'dev-skipped' };
  }

  const effectiveReplyTo = replyTo || process.env.ADMIN_EMAIL || null;
  const { data, error } = await resend.emails.send({
    from: from || FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text && { text }),
    ...(effectiveReplyTo && { reply_to: effectiveReplyTo }),
    ...(attachments && attachments.length && { attachments }),
  });

  if (error) {
    console.error('[email] Resend send FAILED for', to, '—', error?.message || JSON.stringify(error));
    logClientMessage(buildEmailLogEntry({ to, subject, meta, error })); // fire-and-forget
    if (isQuotaError(error)) throw new QuotaExceededError(error?.message || 'Resend daily sending quota reached');
    throw new Error(error?.message || 'Resend send failed');
  }

  logClientMessage(buildEmailLogEntry({ to, subject, meta, result: data })); // fire-and-forget
  return data;
}

/**
 * Send batch emails via Resend (up to 100 per call)
 * @param {Array<{from?: string, to: string|string[], subject: string, html: string, text?: string, reply_to?: string}>} emails
 * @returns {Promise<Array<{id: string}>>}
 */
async function sendBatchEmails(emails) {
  // Same `.invalid` guard as sendEmail (spec 2026-07-10). Filter placeholder
  // recipients per message; a message left with no real recipient is dropped
  // from the batch entirely — never sent, never thrown. Runs before the
  // dev-skip mapping so a dropped message produces no return entry either.
  emails = emails.reduce((kept, e) => {
    const recipients = (Array.isArray(e.to) ? e.to : [e.to])
      .filter((a) => !String(a).toLowerCase().trim().endsWith('.invalid'));
    if (recipients.length === 0) {
      console.log(`[email] batch: dropped message with all-.invalid recipients → ${e.to} | Subject: ${e.subject}`);
      return kept;
    }
    kept.push({ ...e, to: recipients.length === 1 ? recipients[0] : recipients });
    return kept;
  }, []);

  if (!resend || !notificationsEnabled()) {
    const why = !resend ? 'RESEND_API_KEY not set' : 'notifications gated off';
    console.log(`[DEV] Batch email skipped (${why}) — ${emails.length} emails`);
    return emails.map(() => ({ id: 'dev-skipped' }));
  }

  const formatted = emails.map(e => ({
    from: e.from || FROM_EMAIL,
    to: Array.isArray(e.to) ? e.to : [e.to],
    subject: e.subject,
    html: e.html,
    ...(e.text && { text: e.text }),
    reply_to: e.reply_to || process.env.ADMIN_EMAIL || undefined,
  }));

  const { data, error } = await resend.batch.send(formatted);

  if (error) {
    console.error('Resend batch error:', error);
    if (isQuotaError(error)) throw new QuotaExceededError(error?.message || 'Resend daily sending quota reached');
    throw new Error(`Failed to send batch: ${error.message}`);
  }

  const sent = data?.data ?? [];
  return sent;
}

module.exports = { sendEmail, sendBatchEmails, FROM_EMAIL, isQuotaError };
