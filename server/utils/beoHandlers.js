const { pool } = require('../db');
const { SuppressMessageError } = require('./errors');

const BEO_MESSAGE_TYPE = 'beo_unack_nudge_sms';

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

module.exports = {
  BEO_MESSAGE_TYPE,
  insertBeoNudgeIfMissing,
};
