const { pool } = require('../db');
const { SuppressMessageError } = require('./errors');
const { computeEventStartUtc } = require('./staffShiftHandlers');

const BEO_MESSAGE_TYPE = 'beo_unack_nudge_sms';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Status-aware idempotent insert for a BEO nudge row. Skip if any 'pending'
 * or 'sent' row already exists on the natural key; insert otherwise (so a
 * prior 'suppressed' row from Unfinalize doesn't block re-insertion).
 * Belt-and-suspenders: also `ON CONFLICT DO NOTHING` via the existing partial
 * unique index on scheduled_messages.
 *
 * @param {{query: Function}} executor pg pool or client (for transactional callers)
 * @param {{proposalId: number, userId: number, scheduledFor: Date}} args
 */
async function insertBeoNudgeIfMissing(executor, { proposalId, userId, scheduledFor }) {
  const existing = await executor.query(
    `SELECT id FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type=$2
        AND recipient_type='staff' AND recipient_id=$3
        AND channel='sms'
        AND status IN ('pending', 'sent')
      LIMIT 1`,
    [proposalId, BEO_MESSAGE_TYPE, userId]
  );
  if (existing.rows.length > 0) return;
  await executor.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', $2, 'staff', $3, 'sms', $4)
     ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
       WHERE status = 'pending'
     DO NOTHING`,
    [proposalId, BEO_MESSAGE_TYPE, userId, scheduledFor]
  );
}

/**
 * Schedule BEO nudge rows for every approved staffer on every non-cancelled
 * shift linked to the proposal. All queries run on `executor` (transaction
 * client when called from Finalize). Idempotent: re-running after a partial
 * run inserts only the missing rows.
 *
 * Skips entirely when:
 *   - proposal has no event_start_time (TBD-time event)
 *   - computed eventStartUtc < NOW() (past event)
 *
 * scheduled_for = MAX(eventStartUtc - 3 days, NOW() + 5 minutes).
 *
 * @param {number} proposalId
 * @param {{query: Function}} executor
 * @returns {Promise<{inserted: number, skipped?: string, scheduledFor?: Date}>}
 */
async function scheduleBeoNudgesForProposal(proposalId, executor) {
  const propRes = await executor.query(
    `SELECT event_date, event_start_time, event_duration_hours, event_timezone
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || !proposal.event_start_time) return { inserted: 0, skipped: 'no_start_time' };
  const eventStartUtc = computeEventStartUtc(proposal);
  if (!eventStartUtc || eventStartUtc.getTime() < Date.now()) {
    return { inserted: 0, skipped: 'past_or_unparseable' };
  }
  const scheduledFor = new Date(Math.max(
    eventStartUtc.getTime() - THREE_DAYS_MS,
    Date.now() + FIVE_MINUTES_MS,
  ));

  // Only 'approved' is the active-staffer status per the users_onboarding_status_check
  // (in_progress / applied / interviewing / hired / submitted / reviewed are pre-approval
  // pipeline; rejected / suspended / deactivated are out of pool).
  const staffRes = await executor.query(
    `SELECT DISTINCT sr.user_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN users u ON u.id = sr.user_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND s.status != 'cancelled'
        AND u.onboarding_status = 'approved'`,
    [proposalId]
  );

  let inserted = 0;
  for (const row of staffRes.rows) {
    await insertBeoNudgeIfMissing(executor, { proposalId, userId: row.user_id, scheduledFor });
    inserted += 1;
  }
  return { inserted, scheduledFor };
}

/**
 * UPDATE every pending BEO nudge row for this proposal to suppressed with
 * the given reason. Sent rows are preserved (audit trail).
 *
 * @param {number} proposalId
 * @param {{query: Function}} executor
 * @param {string} reason
 * @returns {Promise<{suppressed: number}>}
 */
async function suppressBeoNudgesForProposal(proposalId, executor, reason) {
  const result = await executor.query(
    `UPDATE scheduled_messages
        SET status='suppressed', error_message=$2
      WHERE entity_type='proposal'
        AND entity_id=$1
        AND message_type=$3
        AND status='pending'`,
    [proposalId, reason, BEO_MESSAGE_TYPE]
  );
  return { suppressed: result.rowCount };
}

/**
 * UPDATE pending BEO rows for the given staffers on the given proposal to
 * suppressed, BUT only when the staffer has no remaining approved active
 * shift on the same proposal. Used by cancel-or-unassign, PUT request deny,
 * DELETE shift, DELETE request, generic PUT cancel.
 *
 * @param {number} proposalId
 * @param {number[]} userIds
 * @param {{query: Function}} executor
 * @param {string} [reason]
 * @returns {Promise<{suppressed: number}>}
 */
async function suppressBeoNudgesForStaffers(proposalId, userIds, executor, reason = 'staffer_unassigned: shift mutation') {
  if (!userIds || userIds.length === 0) return { suppressed: 0 };
  const result = await executor.query(
    `UPDATE scheduled_messages sm
        SET status='suppressed', error_message=$3
      WHERE sm.entity_type='proposal'
        AND sm.entity_id=$1
        AND sm.message_type=$4
        AND sm.recipient_id = ANY($2)
        AND sm.status='pending'
        AND NOT EXISTS (
          SELECT 1 FROM shift_requests sr
            JOIN shifts s ON s.id = sr.shift_id
           WHERE sr.user_id = sm.recipient_id
             AND sr.status = 'approved'
             AND s.proposal_id = $1
             AND s.status != 'cancelled'
        )`,
    [proposalId, userIds, reason, BEO_MESSAGE_TYPE]
  );
  return { suppressed: result.rowCount };
}

/**
 * Re-anchor pending BEO nudge rows after a proposal reschedule. Skipped when
 * the proposal is archived. Past-event reschedule SUPPRESSES pending rows
 * in-band (the row's existing scheduled_for may still be in the future, in
 * which case the dispatcher would never pick it up and the row would sit
 * pending forever).
 *
 * @param {number} proposalId
 * @param {{query: Function}} executor
 * @returns {Promise<{updated?: number, suppressed?: number}>}
 */
async function reanchorBeoForProposal(proposalId, executor) {
  const propRes = await executor.query(
    `SELECT event_date, event_start_time, event_duration_hours, event_timezone, status
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || proposal.status === 'archived') return { updated: 0 };
  if (!proposal.event_start_time) return { updated: 0 };
  const eventStartUtc = computeEventStartUtc(proposal);
  if (!eventStartUtc) return { updated: 0 };
  if (eventStartUtc.getTime() < Date.now()) {
    const sup = await executor.query(
      `UPDATE scheduled_messages
          SET status='suppressed', error_message='event_in_past: rescheduled'
        WHERE entity_type='proposal' AND entity_id=$1
          AND message_type=$2 AND status='pending'`,
      [proposalId, BEO_MESSAGE_TYPE]
    );
    return { suppressed: sup.rowCount };
  }
  const scheduledFor = new Date(Math.max(
    eventStartUtc.getTime() - THREE_DAYS_MS,
    Date.now() + FIVE_MINUTES_MS,
  ));
  const result = await executor.query(
    `UPDATE scheduled_messages
        SET scheduled_for=$2
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type=$3 AND status='pending'`,
    [proposalId, scheduledFor, BEO_MESSAGE_TYPE]
  );
  return { updated: result.rowCount };
}

module.exports = {
  BEO_MESSAGE_TYPE,
  insertBeoNudgeIfMissing,
  scheduleBeoNudgesForProposal,
  suppressBeoNudgesForProposal,
  suppressBeoNudgesForStaffers,
  reanchorBeoForProposal,
};
