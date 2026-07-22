const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { shouldSendImmediate } = require('./messageSuppression');
const { isPlaceholderEmail } = require('./emailValidation');

// Dependency seam for tests (mirrors crud.js/actions.js __setDeps).
let _deps = { sendEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

/**
 * Send the client-facing refund notification email for a proposal. The caller
 * is responsible for calling applyRefundReconciliation first and only invoking
 * this when recon.applied === true (to avoid double-emails on idempotent
 * retries between the in-app refund route and the charge.refunded webhook),
 * AND — notify-client contract, 2026-07-22 — only when the admin opted in
 * (in-app route: notify_client === true; cancel flow: the dialog's
 * suppress_client_email checkbox not set). The webhook/sweeper backstops keep
 * calling unconditionally: a refund the admin never saw land still notifies.
 *
 * Suppression gate: prefs + hard-bounce + placeholder, but deliberately NOT
 * the archived-status check — the cancel-refund fires on a just-archived
 * proposal by design, and money going back is the one legitimate touch to a
 * cancelled booking. Hence proposal is passed WITHOUT status below.
 *
 * Non-blocking: errors are captured to Sentry and logged, never thrown.
 * @returns {{ email: 'sent'|'failed'|'skipped', skip_reasons: object, email_error?: string }}
 */
async function sendRefundClientNotification({ proposalId, amountCents, source }) {
  try {
    const { rows } = await pool.query(
      `SELECT p.total_price, p.amount_paid,
              c.id AS client_id, c.name AS client_name, c.email AS client_email,
              c.communication_preferences, c.email_status, c.phone_status
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1`,
      [proposalId]
    );
    const a = rows[0];
    if (!a?.client_email) {
      return { email: 'skipped', skip_reasons: { email: 'No email on file for this client.' } };
    }
    if (isPlaceholderEmail(a.client_email)) {
      return { email: 'skipped', skip_reasons: { email: 'Placeholder address (.invalid) from the CC import; no real email exists.' } };
    }
    // No status on purpose: see the doc block (archived must not suppress here).
    const gate = await shouldSendImmediate({
      proposal: { id: proposalId },
      client: a,
      channel: 'email',
    });
    if (!gate.ok) {
      console.log(`[refundClientNotify] suppressed for proposal ${proposalId}: ${gate.reason}`);
      return { email: 'skipped', skip_reasons: { email: `Suppressed: ${gate.reason}.` } };
    }
    const newBalance = Number(a.total_price) - Number(a.amount_paid);
    const tpl = emailTemplates.refundNotificationClient({
      clientName: a.client_name,
      refundAmount: amountCents / 100,
      last4: null,
      newBalance,
    });
    const r = await _deps.sendEmail({
      to: a.client_email, ...tpl,
      meta: { proposalId, clientId: a.client_id || null, messageType: 'refund_notice' },
    });
    if (r && r.id === 'skipped-invalid') {
      // Defense in depth behind the placeholder gate above.
      return { email: 'skipped', skip_reasons: { email: 'Placeholder address (.invalid); no email was sent.' } };
    }
    return { email: 'sent', skip_reasons: {} };
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { component: 'refundClientNotify', source: source || 'unknown' },
        extra: { proposalId },
      });
    }
    console.error('Refund client notification email failed (non-blocking):', err);
    return { email: 'failed', skip_reasons: {}, email_error: err.message || 'Email send failed.' };
  }
}

module.exports = { sendRefundClientNotification };
module.exports.__setDeps = __setDeps;
