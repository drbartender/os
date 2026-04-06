const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

if (!resend) console.warn('⚠️  RESEND_API_KEY not set — emails will be logged but not sent');

const FROM_EMAIL = 'Dr. Bartender <no-reply@drbartender.com>';

/**
 * Send an email via Resend
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text fallback
 * @param {string} [options.from] - Override default from address
 * @param {string} [options.replyTo] - Reply-to address
 * @returns {Promise<{id: string}>}
 */
async function sendEmail({ to, subject, html, text, from, replyTo }) {
  if (!resend) {
    console.log(`[DEV] Email skipped → ${to} | Subject: ${subject}`);
    return { id: 'dev-skipped' };
  }

  const { data, error } = await resend.emails.send({
    from: from || FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text && { text }),
    ...(replyTo && { reply_to: replyTo }),
  });

  if (error) {
    console.error('Resend email error:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }

  console.log(`Email sent successfully: ${data.id} → ${to}`);
  return data;
}

/**
 * Send batch emails via Resend (up to 100 per call)
 * @param {Array<{from?: string, to: string|string[], subject: string, html: string, text?: string, reply_to?: string}>} emails
 * @returns {Promise<Array<{id: string}>>}
 */
async function sendBatchEmails(emails) {
  if (!resend) {
    console.log(`[DEV] Batch email skipped — ${emails.length} emails`);
    return emails.map(() => ({ id: 'dev-skipped' }));
  }

  const formatted = emails.map(e => ({
    from: e.from || FROM_EMAIL,
    to: Array.isArray(e.to) ? e.to : [e.to],
    subject: e.subject,
    html: e.html,
    ...(e.text && { text: e.text }),
    ...(e.reply_to && { reply_to: e.reply_to }),
  }));

  const { data, error } = await resend.batch.send(formatted);

  if (error) {
    console.error('Resend batch error:', error);
    throw new Error(`Failed to send batch: ${error.message}`);
  }

  console.log(`Batch sent: ${data.data.length} emails`);
  return data.data;
}

module.exports = { sendEmail, sendBatchEmails, FROM_EMAIL };
