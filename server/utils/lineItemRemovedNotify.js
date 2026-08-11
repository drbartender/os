/**
 * Client notice for a line-item removal that owed NO refund (cancel-line
 * spec, client comms): fires only when the admin opted in via the
 * notify-client confirmation toggle (notify_client === true) and no refund
 * fired (a refund carries the existing refund notice instead; never both).
 *
 * Structure and gates mirror refundClientNotify.js exactly: placeholder +
 * prefs/hard-bounce suppression, best-effort, Sentry on failure, __setDeps
 * test seam. The template lives in-module (emailTemplates.js is over the
 * file-size soft cap by standing decision).
 */

'use strict';

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { shouldSendImmediate } = require('./messageSuppression');
const { isPlaceholderEmail } = require('./emailValidation');
const { firstNameOf } = require('./firstName');

// Dependency seam for tests (mirrors refundClientNotify.__setDeps).
let _deps = { sendEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

function fmtUsd(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// HTML-escape interpolated fields (emailTemplates.js esc() convention;
// clientName/removedLabel are stored user/admin input).
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function lineItemRemovedNotice({ clientName, removedLabel, newTotal, newBalance, manualReturnCents }) {
  const balanceLine = manualReturnCents > 0
    ? `We owe you ${fmtUsd(manualReturnCents / 100)} back and will return it to you separately.`
    : newBalance > 0
      ? `Your remaining balance is ${fmtUsd(newBalance)}.`
      : 'Your account is fully settled.';
  const text = `Hi ${firstNameOf(clientName)},\n\n`
    + `We removed ${removedLabel} from your event at your request. `
    + `Your updated total is ${fmtUsd(newTotal)}. ${balanceLine}\n\n`
    + 'Reply to this email with any questions.\n\n'
    + 'Dr. Bartender';
  return {
    subject: 'Your event total was updated',
    text,
    html: text.split('\n\n').map((p) => `<p>${esc(p)}</p>`).join(''),
  };
}

/**
 * @param {object} a
 * @param {number|string} a.proposalId
 * @param {string} a.removedLabel
 * @param {number} a.newTotal  dollars
 * @param {number} [a.manualReturnCents]  external/CC overpayment returned by hand
 * @returns {Promise<{email:'sent'|'failed'|'skipped', skip_reasons:object, email_error?:string}>}
 */
async function sendLineItemRemovedNotice({ proposalId, removedLabel, newTotal, manualReturnCents = 0 }) {
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
      return { email: 'skipped', skip_reasons: { email: 'Placeholder address (.invalid); no real email exists.' } };
    }
    const gate = await shouldSendImmediate({
      proposal: { id: proposalId },
      client: a,
      channel: 'email',
    });
    if (!gate.ok) {
      console.log(`[lineItemRemovedNotify] suppressed for proposal ${proposalId}: ${gate.reason}`);
      return { email: 'skipped', skip_reasons: { email: `Suppressed: ${gate.reason}.` } };
    }
    const tpl = lineItemRemovedNotice({
      clientName: a.client_name,
      removedLabel,
      newTotal: Number(newTotal),
      newBalance: Math.max(0, Number(newTotal) - Number(a.amount_paid)),
      manualReturnCents: Number(manualReturnCents) || 0,
    });
    const r = await _deps.sendEmail({
      to: a.client_email, ...tpl,
      meta: { proposalId, clientId: a.client_id || null, messageType: 'line_item_removed_notice' },
    });
    if (r && r.id === 'skipped-invalid') {
      return { email: 'skipped', skip_reasons: { email: 'Placeholder address (.invalid); no email was sent.' } };
    }
    return { email: 'sent', skip_reasons: {} };
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { component: 'lineItemRemovedNotify' },
        extra: { proposalId },
      });
    }
    console.error('Line-item removal notice failed (non-blocking):', err);
    return { email: 'failed', skip_reasons: {}, email_error: err.message || 'Email send failed.' };
  }
}

module.exports = { sendLineItemRemovedNotice };
module.exports.__setDeps = __setDeps;
