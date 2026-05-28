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

module.exports = {
  BEO_MESSAGE_TYPE,
  insertBeoNudgeIfMissing,
  scheduleBeoNudgesForProposal,
};
