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
 *
 * It renders only the descriptor applyLineItemCancel decided from the locked
 * row (result.clientNotice; spec 2026-10-16 section 4.3): { kind: 'removed',
 * label } names a shown line ("We removed <label> from your event at your
 * request."), and { kind: 'package_adjusted', amountCents } describes a
 * hidden one by the change in the total ("We adjusted your package price by
 * $X at your request.", wording approved by Dallas 2026-10-17), never by its
 * label. Anything else (no descriptor, an unknown kind, a bad amount, a blank
 * label, or a bare label under an old parameter name) sends nothing rather
 * than guess.
 */

'use strict';

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { shouldSendImmediate, suppressionMessage } = require('./messageSuppression');
const { isPlaceholderEmail } = require('./emailValidation');
const { firstNameOf } = require('./firstName');

// Dependency seam for tests (mirrors refundClientNotify.__setDeps).
let _deps = { sendEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

function fmtUsd(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// HTML-escape interpolated fields (emailTemplates.js esc() convention;
// clientName and a removed line's label are stored user/admin input).
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The notice's opening sentence for a well-formed descriptor, else null (the
// caller then sends nothing).
function noticeOpening(clientNotice) {
  if (!clientNotice || typeof clientNotice !== 'object') return null;
  if (clientNotice.kind === 'removed') {
    const { label } = clientNotice;
    return typeof label === 'string' && label.trim() !== ''
      ? `We removed ${label} from your event at your request.`
      : null;
  }
  if (clientNotice.kind === 'package_adjusted') {
    const { amountCents } = clientNotice;
    return Number.isSafeInteger(amountCents) && amountCents >= 0
      ? `We adjusted your package price by ${fmtUsd(amountCents / 100)} at your request.`
      : null;
  }
  return null;
}

function lineItemRemovedNotice({ clientName, opening, newTotal, newBalance, manualReturnCents }) {
  const balanceLine = manualReturnCents > 0
    ? `We owe you ${fmtUsd(manualReturnCents / 100)} back and will return it to you separately.`
    : newBalance > 0
      ? `Your remaining balance is ${fmtUsd(newBalance)}.`
      : 'Your account is fully settled.';
  const text = `Hi ${firstNameOf(clientName)},\n\n`
    + `${opening} `
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
 * @param {{kind:'removed', label:string}|{kind:'package_adjusted', amountCents:number}} a.clientNotice
 *   applyLineItemCancel's result.clientNotice, never the admin's removedLabel
 * @param {number} a.newTotal  dollars
 * @param {number} [a.manualReturnCents]  external/CC overpayment returned by hand
 * @param {number|null} [a.sentBy]  the admin who executed the removal, a value from the route (message_log.sent_by)
 * @returns {Promise<{email:'sent'|'failed'|'skipped', skip_reasons:object, email_error?:string}>}
 */
async function sendLineItemRemovedNotice({ proposalId, clientNotice, newTotal, manualReturnCents = 0, sentBy = null }) {
  try {
    // Fail closed: no well-formed descriptor means no email, so a caller can
    // never send the admin's label (a hidden line's own name) by accident.
    // The message reaches the admin's toast ("the client notice failed to
    // send: ..."), so it is plain words, not a code identifier.
    const opening = noticeOpening(clientNotice);
    if (!opening) {
      throw new Error('the notice for this line could not be written. Tell the client directly.');
    }
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
      return { email: 'skipped', skip_reasons: { email: suppressionMessage(gate.reason, 'email') } };
    }
    const tpl = lineItemRemovedNotice({
      clientName: a.client_name,
      opening,
      newTotal: Number(newTotal),
      newBalance: Math.max(0, Number(newTotal) - Number(a.amount_paid)),
      manualReturnCents: Number(manualReturnCents) || 0,
    });
    const r = await _deps.sendEmail({
      to: a.client_email, ...tpl,
      meta: { proposalId, clientId: a.client_id || null, messageType: 'line_item_removed_notice', sentBy },
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
