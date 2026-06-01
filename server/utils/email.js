const { Resend } = require('resend');
const { notificationsEnabled } = require('./notificationsEnabled');

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
async function sendEmail({ to, subject, html, text, from, replyTo, attachments }) {
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
    throw new Error(error?.message || 'Resend send failed');
  }

  return data;
}

/**
 * Send batch emails via Resend (up to 100 per call)
 * @param {Array<{from?: string, to: string|string[], subject: string, html: string, text?: string, reply_to?: string}>} emails
 * @returns {Promise<Array<{id: string}>>}
 */
async function sendBatchEmails(emails) {
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
    throw new Error(`Failed to send batch: ${error.message}`);
  }

  const sent = data?.data ?? [];
  return sent;
}

module.exports = { sendEmail, sendBatchEmails, FROM_EMAIL };
