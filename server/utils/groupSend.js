// Grouped "send options" flow. Transitions every draft member of an option group
// to 'sent' in ONE transaction, WITHOUT per-option invoice creation (deferred to
// the winning option's settle) or per-option proposalSent email/SMS (suppressed —
// a single proposalOptionsSent compare email goes out instead). The post-commit
// email is best-effort and idempotent against a double-click: a resend that finds
// no newly-draft members sends nothing.
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');
const { NotFoundError, ConflictError } = require('./errors');

async function sendGroup(groupId, { actorUserId = null } = {}) {
  const db = await pool.connect();
  let groupToken;
  let sentIds = [];
  let clientRow = null;
  try {
    await db.query('BEGIN');
    const g = await db.query(
      'SELECT id, token, chosen_proposal_id FROM proposal_groups WHERE id = $1 FOR UPDATE', [groupId]);
    if (!g.rows[0]) throw new NotFoundError('Comparison not found');
    if (g.rows[0].chosen_proposal_id) throw new ConflictError('This comparison is already decided');
    groupToken = g.rows[0].token;

    // Transition every draft member to sent (all-or-nothing). Deliberately NO
    // createInvoiceOnSend (deferred to the winner) and NO per-option proposalSent
    // (suppressed in favor of the single compare email below).
    const upd = await db.query(
      `UPDATE proposals SET status = 'sent', sent_at = COALESCE(sent_at, NOW())
        WHERE group_id = $1 AND status = 'draft' RETURNING id`, [groupId]);
    sentIds = upd.rows.map((r) => r.id);

    if (sentIds.length) {
      await db.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         SELECT UNNEST($1::int[]), 'group_sent', 'admin', $2, $3`,
        [sentIds, actorUserId, JSON.stringify({ group_id: groupId })]);
    }

    // Client + a representative event label for the one compare email (all options
    // share the client + event).
    const cr = await db.query(
      `SELECT c.name AS client_name, c.email AS client_email, m.event_type, m.event_type_custom
         FROM proposal_groups g
         JOIN clients c ON c.id = g.client_id
         LEFT JOIN LATERAL (
           SELECT event_type, event_type_custom FROM proposals
            WHERE group_id = g.id ORDER BY created_at ASC LIMIT 1
         ) m ON true
        WHERE g.id = $1`, [groupId]);
    clientRow = cr.rows[0] || null;

    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }

  // Post-commit: exactly one compare email, only when something was newly sent
  // (a no-op resend with no new draft options sends nothing — dedupe by design).
  if (sentIds.length && clientRow && clientRow.client_email) {
    try {
      const eventTypeLabel = getEventTypeLabel({
        event_type: clientRow.event_type, event_type_custom: clientRow.event_type_custom,
      });
      const tpl = emailTemplates.proposalOptionsSent({
        clientName: clientRow.client_name,
        eventTypeLabel,
        compareUrl: `${PUBLIC_SITE_URL}/compare/${groupToken}`,
      });
      await sendEmail({ to: clientRow.client_email, ...tpl, meta: { groupId, messageType: 'proposal_options_sent' } });
    } catch (err) {
      console.error('proposalOptionsSent email failed (non-blocking) for group', groupId, err);
    }
  }

  return { groupToken, sentCount: sentIds.length };
}

module.exports = { sendGroup };
