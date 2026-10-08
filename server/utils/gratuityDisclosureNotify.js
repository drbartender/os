'use strict';

// Staffing-driven gratuity disclosure (spec 2026-08-03 section 7), moved out of
// routes/proposals/crud.js PATCH /:id for the file-size ratchet (Inbox spec
// 2026-10-06, lane send-attribution). The crew grew, so the gratuity total rose
// at the SAME rate the client agreed to. Email only (not SMS), best-effort,
// post-commit: this never throws, so a failure can never 500 the committed
// PATCH.
//
// DELIBERATELY AUTOMATIC, not part of the notify opt-in (owner decision
// 2026-07-22): this is a billing disclosure. The invoice cascade mints or grows
// a payable invoice with no email of its own, so this is the only thing telling
// the client they owe more. Only the suppression gate applies: a missing or
// placeholder address, a permanent bounce (email_status 'bad'), or an archived
// proposal (the PATCH does not refuse one); a client has no email preference.
// See the notify-client spec reversal note before ever folding this into the
// popup.

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { shouldSendImmediate } = require('./messageSuppression');
const { isPlaceholderEmail } = require('./emailValidation');

// Dependency seam for tests (mirrors refundClientNotify.__setDeps).
let _deps = { sendEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

/**
 * @param {object} a
 * @param {number} a.proposalId
 * @param {number|null} [a.sentBy] the admin whose PATCH changed the staffing,
 *   a VALUE from the route (this helper never reads req.user)
 * @returns {Promise<void>} never rejects
 */
async function sendGratuityStaffingDisclosure({ proposalId, sentBy = null } = {}) {
  try {
    const full = await pool.query(
      `SELECT p.client_id, p.total_price, p.pricing_snapshot, p.status AS current_status,
              c.email AS client_email, c.name AS client_name,
              c.communication_preferences, c.email_status, c.phone_status
         FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
      [proposalId]
    );
    const row = full.rows[0];
    const gate = row ? await shouldSendImmediate({
      proposal: { id: proposalId, status: row.current_status },
      client: row,
      channel: 'email',
    }) : { ok: false, reason: 'bad_contact' };
    if (row && row.client_email && !isPlaceholderEmail(row.client_email) && gate.ok) {
      await _deps.sendEmail({
        to: row.client_email,
        ...emailTemplates.gratuityStaffingChange({
          name: row.client_name,
          newTotal: Number(row.total_price),
          gratuity: (row.pricing_snapshot && row.pricing_snapshot.gratuity) || null,
        }),
        // Its own type, its proposal and the editing admin (Inbox spec
        // 2026-10-06, section 9): with no meta it logged as 'other' against the
        // client's newest proposal. It never closes an Inbox item.
        meta: { proposalId, clientId: row.client_id || null, messageType: 'gratuity_disclosure', sentBy },
      });
    } else {
      console.log(`[gratuityDisclosure] suppressed for proposal ${proposalId}: ${!row || !row.client_email ? 'no email on file' : isPlaceholderEmail(row.client_email) ? 'placeholder address' : gate.reason}`);
    }
  } catch (mailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(mailErr, { tags: { route: 'proposals/update', issue: 'gratuity-staffing-email' } });
    }
    console.error('Gratuity staffing-change email failed (non-blocking):', mailErr);
  }
}

module.exports = { sendGratuityStaffingDisclosure };
module.exports.__setDeps = __setDeps;
