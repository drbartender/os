/**
 * Mandatory staff notice when an admin removes or lowers a client's prepaid
 * gratuity below the $50 no-jar floor (cancel-line spec, per-kind registry:
 * "staff must be made known they can have a tip jar").
 *
 * Email only, by deliberate cost rule (SMS costs money; the staff BEO page is
 * the durable record and already renders live tip-jar status via
 * GratuityTipsCard <- GET /api/beo/:proposalId). Recipients are the same
 * people a reschedule notice reaches: approved, non-dropped shift_requests
 * for the proposal's shift(s) (query copied from
 * staffShiftHandlers.notifyStaffOfScheduleChange).
 *
 * Best-effort throughout: failures are Sentry-captured and counted, never
 * thrown. Zero recipients (nobody approved yet) is a clean no-op; future
 * assignees learn from the BEO page. Always writes a
 * 'gratuity_removed_staff_notified' activity row so the audit trail shows the
 * notice fired (or that there was nobody to notify).
 */

'use strict';

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { getEventTypeLabel } = require('./eventTypes');
const { formatEventDateLong } = require('./staffShiftHandlers');
const { firstNameOf } = require('./firstName');

// Dependency seam for tests (mirrors refundClientNotify.__setDeps).
let _deps = { sendEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

// HTML-escape interpolated fields (emailTemplates.js esc() convention;
// staffName/event labels are stored user input).
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function gratuityRemovedStaffNotice({ staffName, eventTypeLabel, eventDateLocal, newRate }) {
  const change = newRate > 0
    ? `The client's prepaid gratuity for this event was lowered to $${newRate}/staff/hr.`
    : "The client's prepaid gratuity for this event was removed.";
  const text = `Hi ${firstNameOf(staffName)},\n\n`
    + `${change} You are welcome to set out a tip jar at this event.\n\n`
    + `Event: ${eventTypeLabel} on ${eventDateLocal}\n\n`
    + 'Your event details page reflects the current tip jar status.\n\n'
    + 'Dr. Bartender';
  return {
    subject: `Tip jar update for ${eventTypeLabel}`,
    text,
    html: text.split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''),
  };
}

/**
 * @param {object} a
 * @param {number|string} a.proposalId
 * @param {number} a.newRate  the post-change gratuity rate (0 = removed)
 * @returns {Promise<{sent:number, failed:number}>}
 */
async function sendGratuityRemovedStaffNotice({ proposalId, newRate }) {
  const result = { sent: 0, failed: 0 };
  let recipients = [];
  try {
    // staff_name uses the derived display name, falling back to the raw
    // preferred name, exactly as the sibling staff notices do
    // (staffShiftHandlers.notifyStaffOfScheduleChange, beoHandlers). Both NULL
    // (no contractor_profiles row) degrades to firstNameOf's 'there' fallback
    // rather than an empty greeting.
    const { rows } = await pool.query(
      `SELECT DISTINCT sr.user_id, u.email AS staff_email,
              COALESCE(cp.display_name, cp.preferred_name) AS staff_name,
              p.event_type, p.event_type_custom, p.event_date, p.event_timezone
         FROM shifts s
         JOIN shift_requests sr ON sr.shift_id = s.id AND sr.status = 'approved' AND sr.dropped_at IS NULL
         JOIN users u ON u.id = sr.user_id
         LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
         LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE s.proposal_id = $1`,
      [proposalId]
    );
    recipients = rows;
    for (const row of rows) {
      if (!row.staff_email) continue;
      const tpl = gratuityRemovedStaffNotice({
        staffName: row.staff_name,
        eventTypeLabel: getEventTypeLabel({
          event_type: row.event_type, event_type_custom: row.event_type_custom,
        }),
        eventDateLocal: formatEventDateLong(row),
        newRate: Number(newRate) || 0,
      });
      try {
        await _deps.sendEmail({
          to: row.staff_email, ...tpl,
          meta: { proposalId, messageType: 'gratuity_removed_staff_notice' },
        });
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, {
            tags: { component: 'gratuityStaffNotice' },
            extra: { proposalId, userId: row.user_id },
          });
        }
        console.error('[gratuityStaffNotice] send failed (non-blocking):', err.message);
      }
    }
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { component: 'gratuityStaffNotice' }, extra: { proposalId } });
    }
    console.error('[gratuityStaffNotice] recipient query failed (non-blocking):', err.message);
    return result;
  }
  try {
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'gratuity_removed_staff_notified', 'system', NULL, $2)`,
      [proposalId, JSON.stringify({
        new_rate: Number(newRate) || 0,
        recipients: recipients.map((r) => r.user_id),
        sent: result.sent,
        failed: result.failed,
      })]
    );
  } catch (err) {
    console.error('[gratuityStaffNotice] activity log failed (non-blocking):', err.message);
  }
  return result;
}

module.exports = { sendGratuityRemovedStaffNotice };
module.exports.__setDeps = __setDeps;
