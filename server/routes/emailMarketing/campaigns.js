/**
 * Campaign CRUD. The blast send and its scheduler were RETIRED in lane mkt-f:
 * their audience query read email_leads only and so could not honor
 * clients.marketing_excluded. Both routes now refuse; lane mkt-g owns the
 * replacement that takes explicit client_ids and re-checks each recipient.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { sanitizeHtml } = require('../../utils/emailSanitize');
const asyncHandler = require('../../middleware/asyncHandler');
const { compileEmailDesign } = require('./shared');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
// The send owns the definition of a live run; the archive guard below defers
// to it rather than keeping a second one.
const { RUN_STALE_MINUTES, sendNotLiveSql } = require('../marketingSend');

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
            -- A send names EITHER a lead or a client (email_sends_recipient_check).
            -- These were INNER JOINs, so every client send disappeared from this
            -- table while the stats block above still counted it: the page read
            -- "40 sends" over an empty list. COALESCE so one column pair serves
            -- both recipient kinds.
            COALESCE(el.name, cl.name) AS lead_name,
            COALESCE(el.email, cl.email) AS lead_email
     FROM email_sends es
     LEFT JOIN email_leads el ON el.id = es.lead_id
     LEFT JOIN clients cl ON cl.id = es.client_id
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
      -- 'sending' is the campaign send's MUTEX (marketingSend.js), so this PUT
      -- must not be able to set it or clear it. Setting it parks a campaign as
      -- permanently sending and blocks admin sends; clearing it mid-run lets a
      -- second run claim alongside the first. This route is
      -- requireAdminOrManager while the send is adminOnly, so without this a
      -- manager could do either to an admin's send.
      status = CASE
                 WHEN $9::text = 'sending' THEN status
                 WHEN status = 'sending' THEN status
                 ELSE COALESCE($9, status)
               END,
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
  // Never archive mid-send: the run would keep mailing while the release
  // UPDATE matches nothing, stranding the campaign archived with a
  // claim-stamp sent_at (2026-08-13 push-gate finding).
  //
  // Mid-send is the SEND's definition, staleness escape included. A bare
  // `status <> 'sending'` had none, so a process death mid-send wedged the
  // campaign in 'sending' and this route refused it forever, with no way back
  // except hand-editing the database -- while the run claim would have handed
  // that same abandoned claim to the next run without hesitating.
  const result = await pool.query(
    `UPDATE email_campaigns SET status = 'archived'
      WHERE id = $1 AND ${sendNotLiveSql('$2')} RETURNING *`,
    [req.params.id, RUN_STALE_MINUTES]
  );
  if (!result.rows[0]) {
    const existing = await pool.query('SELECT status FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) throw new NotFoundError('Campaign not found.');
    throw new ConflictError('This campaign is mid-send; archive it after the run finishes.');
  }
  res.json(result.rows[0]);
}));

/**
 * POST /campaigns/:id/send — RETIRED (lane mkt-f).
 *
 * This path cannot honor the suppression rules, and the reason is structural
 * rather than an oversight: its audience query reads `email_leads` and nothing
 * else, while the house do-not-contact flag lives on `clients.marketing_excluded`.
 * A different table cannot be filtered by a column it does not have. Nine of
 * the sixteen `email_leads` rows are also clients, so a contact marked
 * do-not-contact in the Marketing screen would still be blasted from here, with
 * the operator reasonably believing the exclusion held.
 *
 * That was survivable while nothing used the marketing surface. It stops being
 * survivable the moment the redesign teaches an operator that excluding
 * somebody means something.
 *
 * Refuses BEFORE opening a transaction or reading anything. The replacement is
 * lane mkt-g's send, which takes explicit client_ids, re-checks isMailable per
 * recipient, and dedupes by lowercased address. Deliberately disabled rather
 * than deleted, so mkt-g replaces a named thing instead of resurrecting one.
 */
router.post('/campaigns/:id/send', auth, requireAdminOrManager, asyncHandler(async (_req, _res) => {
  throw new ConflictError(
    'This send path is retired: it mails the lead list without checking the '
    + 'do-not-contact list, so it can email someone you excluded. Use the new '
    + 'Marketing section to pick recipients.'
  );
}));

/**
 * POST /campaigns/:id/schedule — RETIRED (lane mkt-f).
 *
 * Scheduling only ever armed the send path above, so it inherits exactly the
 * same defect and hiding one without the other would leave the hole reachable
 * on a timer instead of a click.
 */
router.post('/campaigns/:id/schedule', auth, requireAdminOrManager, asyncHandler(async (_req, _res) => {
  throw new ConflictError(
    'Scheduling is retired along with the old send path. Use the new Marketing section.'
  );
}));

module.exports = router;
