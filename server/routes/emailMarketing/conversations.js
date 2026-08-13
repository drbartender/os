/**
 * Two-way lead conversations: threads, replies, read and replied state.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { sendEmail } = require('../../utils/email');
const { wrapMarketingEmail } = require('../../utils/emailTemplates');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ExternalServiceError } = require('../../utils/errors');

const router = express.Router();
// ─── Conversations ────────────────────────────────────────────────

/** GET /conversations — list conversations grouped by lead */
router.get('/conversations', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const result = await pool.query(`
    SELECT el.id AS lead_id, el.name, el.email,
      (SELECT COUNT(*) FROM email_conversations ec WHERE ec.lead_id = el.id AND ec.read_at IS NULL AND ec.direction = 'inbound') AS unread_count,
      (SELECT MAX(ec2.created_at) FROM email_conversations ec2 WHERE ec2.lead_id = el.id) AS last_message_at
    FROM email_leads el
    WHERE EXISTS (SELECT 1 FROM email_conversations ec WHERE ec.lead_id = el.id)
    ORDER BY last_message_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  res.json(result.rows);
}));

/** GET /conversations/:leadId — conversation thread */
router.get('/conversations/:leadId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = (page - 1) * limit;
  const result = await pool.query(
    'SELECT * FROM email_conversations WHERE lead_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3',
    [req.params.leadId, limit, offset]
  );
  res.json(result.rows);
}));

/** POST /conversations/:leadId/reply — admin sends reply */
router.post('/conversations/:leadId/reply', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { subject, body_html, body_text } = req.body;
  if (!body_html && !body_text) {
    throw new ValidationError({ body: 'Message body is required.' });
  }

  const lead = await pool.query('SELECT * FROM email_leads WHERE id = $1', [req.params.leadId]);
  if (!lead.rows[0]) throw new NotFoundError('Lead not found.');

  let emailResult;
  try {
    emailResult = await sendEmail({
      to: lead.rows[0].email,
      subject: subject || `Re: Dr. Bartender`,
      html: wrapMarketingEmail(body_html || `<p>${body_text}</p>`),
      text: body_text || undefined,
      meta: { skipLog: true }, // lead-conversation reply — lead funnel, not a client-about-event touch
    });
  } catch (err) {
    throw new ExternalServiceError('Resend', err, 'Email sending temporarily unavailable. Please try again.');
  }

  const convo = await pool.query(
    `INSERT INTO email_conversations (lead_id, direction, subject, body_text, body_html, resend_id, admin_id)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6) RETURNING *`,
    [req.params.leadId, subject || 'Re: Dr. Bartender', body_text || null, body_html || null, emailResult.id, req.user.id]
  );

  res.status(201).json(convo.rows[0]);
}));

/** PUT /conversations/:conversationId/read — mark as read */
router.put('/conversations/:conversationId/read', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'UPDATE email_conversations SET read_at = NOW() WHERE id = $1 RETURNING *',
    [req.params.conversationId]
  );
  if (!result.rows[0]) throw new NotFoundError('Conversation not found.');
  res.json(result.rows[0]);
}));

/** POST /conversations/:leadId/mark-replied — manual mark as replied */
router.post('/conversations/:leadId/mark-replied', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { notes } = req.body;
  const convo = await pool.query(
    `INSERT INTO email_conversations (lead_id, direction, subject, body_text, admin_id)
     VALUES ($1, 'inbound', 'Manual reply noted', $2, $3) RETURNING *`,
    [req.params.leadId, notes || 'Reply received (marked manually)', req.user.id]
  );
  res.status(201).json(convo.rows[0]);
}));

module.exports = router;
