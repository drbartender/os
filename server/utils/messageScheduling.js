const { pool } = require('../db');

const VALID_ENTITY_TYPES = new Set(['proposal', 'shift', 'client', 'consult']);
const VALID_RECIPIENT_TYPES = new Set(['client', 'staff', 'admin']);
const VALID_CHANNELS = new Set(['email', 'sms']);

/**
 * Schedule a future message delivery. Idempotent on the tuple
 * (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
 * for rows still in 'pending' status — uses the partial unique index added in
 * Plan 2a Task 1.
 *
 * Returns the inserted row on success, or `null` when the tuple already has a
 * pending row (the caller can treat that as "already scheduled — no-op").
 *
 * @param {Object} args
 * @param {'proposal'|'shift'|'client'|'consult'} args.entityType
 * @param {number} args.entityId
 * @param {string} args.messageType - free-form identifier (e.g. 'balance_reminder_autopay_t3')
 * @param {'client'|'staff'|'admin'} args.recipientType
 * @param {number} args.recipientId
 * @param {'email'|'sms'} args.channel
 * @param {Date|string} args.scheduledFor
 * @returns {Promise<{id: number, status: string} | null>}
 */
async function scheduleMessage({
  entityType,
  entityId,
  messageType,
  recipientType,
  recipientId,
  channel,
  scheduledFor,
}) {
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    throw new Error(`scheduleMessage: invalid entityType '${entityType}'`);
  }
  if (!VALID_RECIPIENT_TYPES.has(recipientType)) {
    throw new Error(`scheduleMessage: invalid recipientType '${recipientType}'`);
  }
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`scheduleMessage: invalid channel '${channel}'`);
  }
  if (!messageType || typeof messageType !== 'string') {
    throw new Error('scheduleMessage: messageType is required');
  }
  if (!Number.isInteger(entityId) || !Number.isInteger(recipientId)) {
    throw new Error('scheduleMessage: entityId and recipientId must be integers');
  }

  const result = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
       WHERE status = 'pending'
     DO NOTHING
     RETURNING id, status`,
    [entityId, entityType, messageType, recipientType, recipientId, channel, scheduledFor]
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

module.exports = { scheduleMessage };
