const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');

/**
 * Send the client-facing refund notification email for a proposal. The caller
 * is responsible for calling applyRefundReconciliation first and only invoking
 * this when recon.applied === true (to avoid double-emails on idempotent
 * retries between the in-app refund route and the charge.refunded webhook).
 * Non-blocking: errors are captured to Sentry and logged, never thrown.
 */
async function sendRefundClientNotification({ proposalId, amountCents, source }) {
  try {
    const { rows } = await pool.query(
      `SELECT p.total_price, p.amount_paid,
              c.name AS client_name, c.email AS client_email
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1`,
      [proposalId]
    );
    const a = rows[0];
    if (!a?.client_email) return;
    const newBalance = Number(a.total_price) - Number(a.amount_paid);
    const tpl = emailTemplates.refundNotificationClient({
      clientName: a.client_name,
      refundAmount: amountCents / 100,
      last4: null,
      newBalance,
    });
    await sendEmail({ to: a.client_email, ...tpl });
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { component: 'refundClientNotify', source: source || 'unknown' },
        extra: { proposalId },
      });
    }
    console.error('Refund client notification email failed (non-blocking):', err);
  }
}

module.exports = { sendRefundClientNotification };
