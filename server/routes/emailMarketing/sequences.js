/**
 * Sequence steps, plus campaign activate and pause.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { sanitizeHtml } = require('../../utils/emailSanitize');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();
// ─── Sequence Steps ───────────────────────────────────────────────

/** GET /campaigns/:id/steps — list sequence steps */
router.get('/campaigns/:id/steps', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM email_sequence_steps WHERE campaign_id = $1 ORDER BY step_order',
    [req.params.id]
  );
  res.json(result.rows);
}));

/** POST /campaigns/:id/steps — add step */
router.post('/campaigns/:id/steps', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { subject, html_body, text_body, delay_days, delay_hours } = req.body;

  const fieldErrors = {};
  if (!subject) fieldErrors.subject = 'Subject is required.';
  if (!html_body) fieldErrors.html_body = 'Email body is required.';
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }

  // Get next step order
  const maxStep = await pool.query(
    'SELECT COALESCE(MAX(step_order), 0) AS max_order FROM email_sequence_steps WHERE campaign_id = $1',
    [req.params.id]
  );
  const nextOrder = maxStep.rows[0].max_order + 1;

  const result = await pool.query(
    // Sanitize html_body server-side before persisting
    `INSERT INTO email_sequence_steps (campaign_id, step_order, subject, html_body, text_body, delay_days, delay_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.params.id, nextOrder, subject, sanitizeHtml(html_body), text_body || null, delay_days || 0, delay_hours || 0]
  );
  res.status(201).json(result.rows[0]);
}));

/** PUT /campaigns/:id/steps/:stepId — update step */
router.put('/campaigns/:id/steps/:stepId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { subject, html_body, text_body, delay_days, delay_hours } = req.body;
  const result = await pool.query(`
    UPDATE email_sequence_steps SET
      subject = COALESCE($1, subject), html_body = COALESCE($2, html_body),
      text_body = COALESCE($3, text_body), delay_days = COALESCE($4, delay_days),
      delay_hours = COALESCE($5, delay_hours)
    WHERE id = $6 AND campaign_id = $7 RETURNING *
  `, [subject, sanitizeHtml(html_body), text_body, delay_days, delay_hours, req.params.stepId, req.params.id]);

  if (!result.rows[0]) throw new NotFoundError('Step not found.');
  res.json(result.rows[0]);
}));

/** DELETE /campaigns/:id/steps/:stepId — remove step and reorder */
router.delete('/campaigns/:id/steps/:stepId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const step = await client.query(
      'SELECT step_order FROM email_sequence_steps WHERE id = $1 AND campaign_id = $2',
      [req.params.stepId, req.params.id]
    );
    if (!step.rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Step not found.');
    }

    await client.query('DELETE FROM email_sequence_steps WHERE id = $1', [req.params.stepId]);

    // Reorder remaining steps
    await client.query(
      `UPDATE email_sequence_steps SET step_order = step_order - 1
       WHERE campaign_id = $1 AND step_order > $2`,
      [req.params.id, step.rows[0].step_order]
    );

    await client.query('COMMIT');
    res.json({ message: 'Step deleted.' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}));

/** POST /campaigns/:id/activate — activate sequence */
router.post('/campaigns/:id/activate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const steps = await pool.query(
    'SELECT COUNT(*) FROM email_sequence_steps WHERE campaign_id = $1',
    [req.params.id]
  );
  if (parseInt(steps.rows[0].count, 10) === 0) {
    throw new ValidationError({ steps: 'Add at least one step before activating.' });
  }

  const result = await pool.query(
    `UPDATE email_campaigns SET status = 'active' WHERE id = $1 AND type = 'sequence' RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Sequence not found.');
  res.json(result.rows[0]);
}));

/** POST /campaigns/:id/pause — pause sequence */
router.post('/campaigns/:id/pause', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `UPDATE email_campaigns SET status = 'paused' WHERE id = $1 AND type = 'sequence' RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Sequence not found.');
  res.json(result.rows[0]);
}));

module.exports = router;
