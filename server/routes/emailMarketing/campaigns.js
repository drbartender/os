/**
 * Campaign CRUD, the blast send, and scheduling.
 * sendBlastEmails is the background sender the send route fires and
 * deliberately does not await.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { sendEmail } = require('../../utils/email');
const { wrapMarketingEmail } = require('../../utils/emailTemplates');
const { sanitizeHtml } = require('../../utils/emailSanitize');
const asyncHandler = require('../../middleware/asyncHandler');
const { compileEmailDesign } = require('./shared');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { API_URL } = require('../../utils/urls');

const router = express.Router();
// ─── Campaign Management ──────────────────────────────────────────

/** GET /campaigns — list campaigns. Explicit columns — exclude html_body,
 *  text_body, html_draft (can be MB-scale with TipTap inline images). */
router.get('/campaigns', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { type, status } = req.query;
  let query = `
    SELECT c.id, c.name, c.type, c.status, c.subject, c.from_email, c.reply_to,
           c.target_sources, c.target_event_types, c.created_by, c.created_at,
           c.updated_at, c.sent_at,
      (SELECT COUNT(*) FROM email_sends WHERE campaign_id = c.id) AS total_sends,
      (SELECT COUNT(*) FROM email_sends WHERE campaign_id = c.id AND status = 'opened') AS total_opens,
      (SELECT COUNT(*) FROM email_sends WHERE campaign_id = c.id AND status = 'clicked') AS total_clicks
    FROM email_campaigns c WHERE 1=1`;
  const params = [];

  if (type) {
    params.push(type);
    query += ` AND c.type = $${params.length}`;
  }
  if (status) {
    params.push(status);
    query += ` AND c.status = $${params.length}`;
  }

  query += ' ORDER BY c.created_at DESC';
  const result = await pool.query(query, params);
  res.json(result.rows);
}));

/** POST /campaigns — create campaign */
router.post('/campaigns', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, type, subject, html_body, text_body, from_email, reply_to, target_sources, target_event_types, design_json } = req.body;

  const fieldErrors = {};
  if (!name || !name.trim()) fieldErrors.name = 'Campaign name is required.';
  if (type && !['blast', 'sequence'].includes(type)) {
    fieldErrors.type = 'Type must be "blast" or "sequence".';
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
  }

  // A designed email is the source of truth: html_body/text_body are rendered
  // from its blocks. Fall back to the legacy rich-text html_body otherwise.
  const compiled = compileEmailDesign(design_json);
  if (design_json !== undefined && design_json !== null && !compiled) {
    throw new ValidationError({ design_json: 'Design must be an object with at least one block.' });
  }
  const finalHtml = compiled ? compiled.html_body : (sanitizeHtml(html_body) || null);
  const finalText = compiled ? compiled.text_body : (text_body || null);
  const finalDesign = compiled ? JSON.stringify(compiled.design_json) : null;

  const result = await pool.query(
    `INSERT INTO email_campaigns (name, type, subject, html_body, text_body, design_json, from_email, reply_to, target_sources, target_event_types, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [name.trim(), type || 'blast', subject || null, finalHtml, finalText, finalDesign,
     from_email || null, reply_to || null,
     target_sources ? JSON.stringify(target_sources) : null,
     target_event_types ? JSON.stringify(target_event_types) : null,
     req.user.id]
  );
  res.status(201).json(result.rows[0]);
}));

/** GET /campaigns/:id — campaign detail with stats */
router.get('/campaigns/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const campaign = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
  if (!campaign.rows[0]) throw new NotFoundError('Campaign not found.');

  const stats = await pool.query(`
    SELECT
      COUNT(*) AS total_sends,
      COUNT(*) FILTER (WHERE status = 'delivered' OR status = 'opened' OR status = 'clicked') AS total_delivered,
      COUNT(*) FILTER (WHERE status = 'opened' OR status = 'clicked') AS total_opens,
      COUNT(*) FILTER (WHERE status = 'clicked') AS total_clicks,
      COUNT(*) FILTER (WHERE status = 'bounced') AS total_bounces,
      COUNT(*) FILTER (WHERE status = 'complained') AS total_complaints
    FROM email_sends WHERE campaign_id = $1
  `, [req.params.id]);

  // LIMIT 500 so a mature sequence blasted to 10k leads doesn't dump 10k rows per page load.
  const sends = await pool.query(
    `SELECT es.id, es.campaign_id, es.lead_id, es.subject, es.status,
            es.sent_at, es.opened_at, es.clicked_at, es.bounced_at, es.complained_at,
            es.error_message,
            el.name AS lead_name, el.email AS lead_email
     FROM email_sends es
     JOIN email_leads el ON el.id = es.lead_id
     WHERE es.campaign_id = $1 ORDER BY es.sent_at DESC LIMIT 500`,
    [req.params.id]
  );

  let steps = [];
  let enrollments = [];
  if (campaign.rows[0].type === 'sequence') {
    // Campaign detail loads all steps with their html_body (needed for edit view).
    const stepsResult = await pool.query(
      'SELECT * FROM email_sequence_steps WHERE campaign_id = $1 ORDER BY step_order',
      [req.params.id]
    );
    steps = stepsResult.rows;

    // LIMIT enrollments so a campaign with 10k leads doesn't ship every row on every page load.
    const enrollResult = await pool.query(
      `SELECT e.id, e.campaign_id, e.lead_id, e.status, e.current_step,
              e.next_step_due_at, e.enrolled_at, e.completed_at,
              el.name AS lead_name, el.email AS lead_email
       FROM email_sequence_enrollments e
       JOIN email_leads el ON el.id = e.lead_id
       WHERE e.campaign_id = $1 ORDER BY e.enrolled_at DESC LIMIT 500`,
      [req.params.id]
    );
    enrollments = enrollResult.rows;
  }

  res.json({
    ...campaign.rows[0],
    stats: stats.rows[0],
    sends: sends.rows,
    steps,
    enrollments,
  });
}));

/** PUT /campaigns/:id — update campaign */
router.put('/campaigns/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, subject, html_body, text_body, from_email, reply_to, target_sources, target_event_types, status, design_json } = req.body;

  // When a design is supplied, re-render html_body/text_body from it and store
  // the (sanitized) design so the builder can reload it. `design_json: null` is
  // an explicit clear (the composer saved in simple-text mode / emptied the
  // canvas): the stale design AND its derived text_body must go, or a reload
  // resurrects the old blocks over the newer body. COALESCE keeps every field a
  // partial PUT omits untouched.
  const clearDesign = design_json === null;
  const compiled = compileEmailDesign(design_json);
  if (design_json !== undefined && !clearDesign && !compiled) {
    throw new ValidationError({ design_json: 'Design must be an object with at least one block.' });
  }
  const nextHtml = compiled ? compiled.html_body : (html_body !== undefined ? sanitizeHtml(html_body) : null);
  const nextText = compiled ? compiled.text_body : (text_body !== undefined ? text_body : null);
  const nextDesign = compiled ? JSON.stringify(compiled.design_json) : null;
  // A compiled design owns text_body outright (even when its plain text is
  // empty); so does an explicit clear. Otherwise legacy COALESCE semantics.
  const setText = clearDesign || Boolean(compiled);

  const result = await pool.query(`
    UPDATE email_campaigns SET
      name = COALESCE($1, name), subject = COALESCE($2, subject),
      html_body = COALESCE($3, html_body),
      text_body = CASE WHEN $13::boolean THEN $4 ELSE COALESCE($4, text_body) END,
      from_email = COALESCE($5, from_email), reply_to = COALESCE($6, reply_to),
      target_sources = COALESCE($7, target_sources),
      target_event_types = COALESCE($8, target_event_types),
      status = COALESCE($9, status),
      design_json = CASE WHEN $12::boolean THEN NULL ELSE COALESCE($11, design_json) END
    WHERE id = $10 RETURNING *
  `, [name, subject, nextHtml, nextText, from_email, reply_to,
      target_sources ? JSON.stringify(target_sources) : null,
      target_event_types ? JSON.stringify(target_event_types) : null,
      status, req.params.id, nextDesign, clearDesign, setText]);

  if (!result.rows[0]) throw new NotFoundError('Campaign not found.');
  res.json(result.rows[0]);
}));

/** DELETE /campaigns/:id — archive campaign */
router.delete('/campaigns/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `UPDATE email_campaigns SET status = 'archived' WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Campaign not found.');
  res.json(result.rows[0]);
}));

/** POST /campaigns/:id/send — execute blast send */
router.post('/campaigns/:id/send', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const campaign = await client.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (!campaign.rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Campaign not found.');
    }
    const c = campaign.rows[0];
    if (c.type !== 'blast') {
      await client.query('ROLLBACK');
      throw new ValidationError({ type: 'Only blast campaigns can be sent this way. Use activate for sequences.' });
    }
    const fieldErrors = {};
    if (!c.subject) fieldErrors.subject = 'Subject is required to send.';
    if (!c.html_body) fieldErrors.html_body = 'Email body is required to send.';
    if (Object.keys(fieldErrors).length > 0) {
      await client.query('ROLLBACK');
      throw new ValidationError(fieldErrors);
    }

    // Build audience query
    let leadQuery = "SELECT id, email, name FROM email_leads WHERE status = 'active'";
    const leadParams = [];

    if (c.target_sources && c.target_sources.length > 0) {
      leadParams.push(c.target_sources);
      leadQuery += ` AND lead_source = ANY($${leadParams.length})`;
    }
    if (c.target_event_types && c.target_event_types.length > 0) {
      leadParams.push(c.target_event_types);
      leadQuery += ` AND event_type = ANY($${leadParams.length})`;
    }

    // Allow manual lead selection via request body
    if (req.body.lead_ids && req.body.lead_ids.length > 0) {
      leadParams.push(req.body.lead_ids);
      leadQuery += ` AND id = ANY($${leadParams.length})`;
    }

    const leads = await client.query(leadQuery, leadParams);

    if (leads.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new ValidationError({ audience: 'No active leads match the targeting criteria.' });
    }

    // Update campaign status
    await client.query(
      `UPDATE email_campaigns SET status = 'sending', sent_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    await client.query('COMMIT');

    // Send emails in background (don't block response). Unsubscribe is
    // server-rendered by Express — must hit API_URL, not the Vercel SPA.
    const unsubscribeBase = `${API_URL}/api/email-marketing/unsubscribe`;
    sendBlastEmails(c, leads.rows, unsubscribeBase).catch(err => {
      console.error('Blast send error:', err);
    });

    res.json({ message: `Sending to ${leads.rows.length} leads...`, count: leads.rows.length });
  } catch (err) {
    // Only rollback if we haven't already done so above
    try { await client.query('ROLLBACK'); } catch (_e) { /* already rolled back or committed */ }
    throw err;
  } finally {
    client.release();
  }
}));

/** Background blast email sender */
async function sendBlastEmails(campaign, leads, unsubscribeBase) {
  const BATCH_SIZE = 100;
  const BATCH_DELAY = 600; // ms between batches

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);

    const emailPromises = batch.map(async (lead) => {
      const unsubscribeToken = jwt.sign({ leadId: lead.id }, process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET, { expiresIn: '365d' });
      const unsubscribeUrl = `${unsubscribeBase}?token=${unsubscribeToken}`;
      const html = wrapMarketingEmail(campaign.html_body, unsubscribeUrl);

      try {
        const result = await sendEmail({
          to: lead.email,
          subject: campaign.subject,
          html,
          text: campaign.text_body || undefined,
          from: campaign.from_email || undefined,
          replyTo: campaign.reply_to || undefined,
          meta: { skipLog: true }, // lead campaign blast — never enters the client message log
        });

        await pool.query(
          `INSERT INTO email_sends (campaign_id, lead_id, resend_id, subject, status, sent_at)
           VALUES ($1, $2, $3, $4, 'sent', NOW())`,
          [campaign.id, lead.id, result.id, campaign.subject]
        );
      } catch (err) {
        console.error(`Failed to send to ${lead.email}:`, err);
        await pool.query(
          `INSERT INTO email_sends (campaign_id, lead_id, subject, status, error_message, sent_at)
           VALUES ($1, $2, $3, 'failed', $4, NOW())`,
          [campaign.id, lead.id, campaign.subject, err.message]
        );
      }
    });

    await Promise.all(emailPromises);

    if (i + BATCH_SIZE < leads.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }

  // Mark campaign as sent
  await pool.query(
    `UPDATE email_campaigns SET status = 'sent' WHERE id = $1`,
    [campaign.id]
  );
}

/** POST /campaigns/:id/schedule — schedule blast for future */
router.post('/campaigns/:id/schedule', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { scheduled_at } = req.body;
  if (!scheduled_at) {
    throw new ValidationError({ scheduled_at: 'Scheduled date/time is required.' });
  }
  const result = await pool.query(
    `UPDATE email_campaigns SET status = 'scheduled', scheduled_at = $1 WHERE id = $2 RETURNING *`,
    [scheduled_at, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Campaign not found.');
  res.json(result.rows[0]);
}));

module.exports = router;
