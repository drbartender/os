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

module.exports = { sendEmail, FROM_EMAIL };
