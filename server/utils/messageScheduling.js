const { pool } = require('../db');
const { pickChannelsForUserAndCategory } = require('./notificationChannelResolver');

const VALID_ENTITY_TYPES = new Set(['proposal', 'shift', 'client', 'consult']);
const VALID_RECIPIENT_TYPES = new Set(['client', 'staff', 'admin']);
// 'push' widened in alongside the scheduled_messages_channel_check CHECK widening
// (server/db/schema.sql staff-portal additions). Required for the new staff-portal
// dispatcher push branch.
const VALID_CHANNELS = new Set(['email', 'sms', 'push']);

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

/**
 * Enqueue a category-driven message, fanning out to every channel the resolver
 * picks. Each row carries a shared `suppression_key` so the dispatcher's
 * sibling-suppression cascade can collapse them on first send (spec §6.13).
 *
 * If the resolver returns dead_letter (critical-path category with no
 * deliverable channel), the helper returns `{ enqueued: [], deadLetter: true }`
 * without inserting any rows. Caller surfaces the dead-letter to ops.
 *
 * @param {Object} args
 * @param {number} args.userId         recipient staff user id
 * @param {string} args.category       one of DEFAULT_CHANNELS keys (resolver fallback applies if missing)
 * @param {Object} args.payload        per-row JSON payload (title/body/url/sms_template/sms_args/...)
 * @param {Date|string} args.sendAt
 * @param {'proposal'|'shift'|'client'|'consult'} args.entityType
 * @param {number} args.entityId
 * @param {string} args.messageType    application-defined; used in suppression_key
 * @param {object} [client]            optional pg client / pool for transaction use
 * @returns {Promise<{enqueued: number[], deadLetter: boolean}>}
 */
async function enqueueCategorizedMessage({
  userId,
  category,
  payload,
  sendAt,
  entityType,
  entityId,
  messageType,
}, client = pool) {
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    throw new Error(`enqueueCategorizedMessage: invalid entityType '${entityType}'`);
  }
  if (!messageType || typeof messageType !== 'string') {
    throw new Error('enqueueCategorizedMessage: messageType is required');
  }
  if (!Number.isInteger(entityId) || !Number.isInteger(userId)) {
    throw new Error('enqueueCategorizedMessage: entityId and userId must be integers');
  }

  const resolved = await pickChannelsForUserAndCategory(userId, category);
  if (resolved.kind === 'dead_letter') {
    return { enqueued: [], deadLetter: true };
  }
  const channels = resolved.channels;
  if (channels.length === 0) {
    return { enqueued: [], deadLetter: false };
  }

  const suppressionKey = `${entityType}:${entityId}:${messageType}:${userId}`;
  const payloadWithCounter = { ...(payload || {}), re_resolve_count: 0 };

  const enqueued = [];
  for (const channel of channels) {
    const { rows } = await client.query(
      `INSERT INTO scheduled_messages
         (entity_id, entity_type, message_type, recipient_type, recipient_id,
          channel, scheduled_for, status, suppression_key, payload)
       VALUES ($1, $2, $3, 'staff', $4, $5, $6, 'pending', $7, $8::jsonb)
       ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
         WHERE status = 'pending'
       DO NOTHING
       RETURNING id`,
      [entityId, entityType, messageType, userId, channel, sendAt, suppressionKey, JSON.stringify(payloadWithCounter)]
    );
    if (rows.length > 0) enqueued.push(rows[0].id);
  }
  return { enqueued, deadLetter: false };
}

module.exports = { scheduleMessage, enqueueCategorizedMessage };
