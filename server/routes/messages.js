const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { sendSMS, normalizePhone } = require('../utils/sms');
const { getEventTypeLabel } = require('../utils/eventTypes');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const crypto = require('crypto');

const router = express.Router();

const VALID_TYPES = ['general', 'invitation', 'reminder', 'announcement'];

// ─── Get eligible SMS recipients (staff with consent + phone) ────

router.get('/recipients', auth, adminOnly, asyncHandler(async (req, res) => {
  const search = req.query.search || '';
  let query = `
    SELECT u.id AS user_id, cp.preferred_name, u.email, cp.phone, ag.sms_consent
    FROM users u
    JOIN contractor_profiles cp ON cp.user_id = u.id
    JOIN agreements ag ON ag.user_id = u.id
    WHERE ag.sms_consent = true
      AND cp.phone IS NOT NULL
      AND cp.phone != ''
      AND u.role IN ('staff', 'manager')
      AND u.onboarding_status IN ('approved', 'reviewed', 'submitted')
  `;
  const params = [];

  if (search.trim()) {
    params.push(`%${search.trim()}%`);
    query += ` AND (cp.preferred_name ILIKE $1 OR u.email ILIKE $1)`;
  }

  query += ` ORDER BY cp.preferred_name ASC`;

  const result = await pool.query(query, params);
  res.json({ recipients: result.rows });
}));

// ─── Send SMS to one or more staff ───────────────────────────────

router.post('/send', auth, adminOnly, asyncHandler(async (req, res) => {
  const { recipient_ids, body, message_type = 'general', shift_id = null } = req.body;

  const fieldErrors = {};
  if (!body || !body.trim()) {
    fieldErrors.body = 'Message body is required';
  } else if (body.length > 1600) {
    fieldErrors.body = 'Message must be 1600 characters or fewer';
  }
  if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
    fieldErrors.recipient_ids = 'At least one recipient is required';
  }
  if (!VALID_TYPES.includes(message_type)) {
    fieldErrors.message_type = 'Invalid message type';
  }
  if (message_type === 'invitation' && !shift_id) {
    fieldErrors.shift_id = 'Shift is required for invitation messages';
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }

  const group_id = crypto.randomUUID();

  // Fetch recipients with consent verification
  const recipientResult = await pool.query(`
    SELECT u.id AS user_id, cp.preferred_name, cp.phone, ag.sms_consent
    FROM users u
    JOIN contractor_profiles cp ON cp.user_id = u.id
    JOIN agreements ag ON ag.user_id = u.id
    WHERE u.id = ANY($1)
  `, [recipient_ids]);

  const results = [];
  let sentCount = 0;
  let failedCount = 0;

  for (const recipient of recipientResult.rows) {
    const normalized = normalizePhone(recipient.phone);

    // Check consent and phone validity
    if (!recipient.sms_consent) {
      failedCount++;
      await pool.query(
        `INSERT INTO sms_messages (group_id, sender_id, recipient_id, recipient_phone, recipient_name, body, message_type, shift_id, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', 'No SMS consent')`,
        [group_id, req.user.id, recipient.user_id, recipient.phone || 'none', recipient.preferred_name, body.trim(), message_type, shift_id]
      );
      results.push({ recipient_id: recipient.user_id, status: 'failed', error_message: 'No SMS consent' });
      continue;
    }

    if (!normalized) {
      failedCount++;
      await pool.query(
        `INSERT INTO sms_messages (group_id, sender_id, recipient_id, recipient_phone, recipient_name, body, message_type, shift_id, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', 'Invalid phone number')`,
        [group_id, req.user.id, recipient.user_id, recipient.phone || 'none', recipient.preferred_name, body.trim(), message_type, shift_id]
      );
      results.push({ recipient_id: recipient.user_id, status: 'failed', error_message: 'Invalid phone number' });
      continue;
    }

    try {
      const message = await sendSMS({ to: normalized, body: body.trim() });
      sentCount++;
      await pool.query(
        `INSERT INTO sms_messages (group_id, sender_id, recipient_id, recipient_phone, recipient_name, body, message_type, shift_id, twilio_sid, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'sent')`,
        [group_id, req.user.id, recipient.user_id, normalized, recipient.preferred_name, body.trim(), message_type, shift_id, message.sid]
      );
      results.push({ recipient_id: recipient.user_id, status: 'sent' });
    } catch (smsErr) {
      // Per-recipient Twilio failure: record and continue (batch semantics — partial success allowed)
      failedCount++;
      await pool.query(
        `INSERT INTO sms_messages (group_id, sender_id, recipient_id, recipient_phone, recipient_name, body, message_type, shift_id, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', $9)`,
        [group_id, req.user.id, recipient.user_id, normalized || recipient.phone, recipient.preferred_name, body.trim(), message_type, shift_id, smsErr.message]
      );
      results.push({ recipient_id: recipient.user_id, status: 'failed', error_message: smsErr.message });
    }
  }

  res.json({ group_id, total: recipientResult.rows.length, sent: sentCount, failed: failedCount, results });
}));

// ─── Message history (grouped) ───────────────────────────────────

router.get('/history', auth, adminOnly, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const typeFilter = req.query.type || '';

  let query = `
    SELECT
      sm.group_id,
      MIN(sm.body) AS body,
      MIN(sm.message_type) AS message_type,
      MIN(sm.shift_id) AS shift_id,
      MIN(s.event_type) AS shift_event_type,
      MIN(s.event_type_custom) AS shift_event_type_custom,
      MIN(s.client_name) AS shift_client_name,
      MIN(sender.email) AS sender_email,
      COUNT(*) AS total_recipients,
      COUNT(*) FILTER (WHERE sm.status = 'sent') AS sent_count,
      COUNT(*) FILTER (WHERE sm.status = 'failed') AS failed_count,
      MAX(sm.created_at) AS created_at
    FROM sms_messages sm
    LEFT JOIN users sender ON sender.id = sm.sender_id
    LEFT JOIN shifts s ON s.id = sm.shift_id
  `;
  const params = [];
  const conditions = [];

  if (typeFilter && VALID_TYPES.includes(typeFilter)) {
    params.push(typeFilter);
    conditions.push(`sm.message_type = $${params.length}`);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` GROUP BY sm.group_id ORDER BY MAX(sm.created_at) DESC`;

  // Count total groups
  const countQuery = `SELECT COUNT(DISTINCT group_id) AS total FROM sms_messages${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`;
  const countResult = await pool.query(countQuery, params);
  const total = parseInt(countResult.rows[0].total);

  params.push(limit);
  query += ` LIMIT $${params.length}`;
  params.push(offset);
  query += ` OFFSET $${params.length}`;

  const result = await pool.query(query, params);

  // Derive human-readable event label for each group (frontend reads shift_event_type_label)
  const groups = result.rows.map(row => ({
    ...row,
    shift_event_type_label: row.shift_event_type
      ? getEventTypeLabel({ event_type: row.shift_event_type, event_type_custom: row.shift_event_type_custom })
      : null,
  }));

  res.json({
    groups,
    page,
    total_pages: Math.ceil(total / limit),
    total,
  });
}));

// ─── Message group detail ────────────────────────────────────────

router.get('/history/:groupId', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT sm.*,
      s.event_type AS shift_event_type,
      s.event_type_custom AS shift_event_type_custom,
      s.client_name AS shift_client_name
    FROM sms_messages sm
    LEFT JOIN shifts s ON s.id = sm.shift_id
    WHERE sm.group_id = $1
    ORDER BY sm.created_at ASC
  `, [req.params.groupId]);

  if (result.rows.length === 0) {
    throw new NotFoundError('Message group not found');
  }

  const messages = result.rows.map(row => ({
    ...row,
    shift_event_type_label: row.shift_event_type
      ? getEventTypeLabel({ event_type: row.shift_event_type, event_type_custom: row.shift_event_type_custom })
      : null,
  }));

  res.json({ messages });
}));

// ─── Message history for a specific user ─────────────────────────

router.get('/user/:userId', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT sm.*,
      s.event_type AS shift_event_type,
      s.event_type_custom AS shift_event_type_custom,
      s.client_name AS shift_client_name,
      sender.email AS sender_email
    FROM sms_messages sm
    LEFT JOIN shifts s ON s.id = sm.shift_id
    LEFT JOIN users sender ON sender.id = sm.sender_id
    WHERE sm.recipient_id = $1
    ORDER BY sm.created_at DESC
  `, [req.params.userId]);

  const messages = result.rows.map(row => ({
    ...row,
    shift_event_type_label: row.shift_event_type
      ? getEventTypeLabel({ event_type: row.shift_event_type, event_type_custom: row.shift_event_type_custom })
      : null,
  }));

  res.json({ messages });
}));

// ─── Available shifts for invitation picker ──────────────────────

router.get('/shifts', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT id, event_type, event_type_custom, client_name, event_date, start_time, end_time, location, positions_needed
    FROM shifts
    WHERE status = 'open' AND event_date >= CURRENT_DATE
    ORDER BY event_date ASC
  `);
  const shifts = result.rows.map(row => ({
    ...row,
    event_type_label: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
  }));
  res.json({ shifts });
}));

module.exports = router;
