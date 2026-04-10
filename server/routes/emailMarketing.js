const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { wrapMarketingEmail } = require('../utils/emailTemplates');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

const VALID_LEAD_SOURCES = ['manual', 'csv_import', 'website', 'thumbtack', 'referral', 'instagram', 'facebook', 'google', 'other'];

// ─── Lead Management ──────────────────────────────────────────────

/** GET /leads — list leads with search/filter/pagination */
router.get('/leads', auth, requireAdmin, async (req, res) => {
  const { search, status, lead_source, page = 1, limit = 50 } = req.query;
  try {
    let query = 'SELECT * FROM email_leads WHERE 1=1';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR company ILIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (lead_source) {
      params.push(lead_source);
      query += ` AND lead_source = $${params.length}`;
    }

    // Get total count for pagination
    const countResult = await pool.query(query.replace('SELECT *', 'SELECT COUNT(*)'), params);
    const total = parseInt(countResult.rows[0].count, 10);

    query += ' ORDER BY created_at DESC';
    params.push(Number(limit));
    query += ` LIMIT $${params.length}`;
    params.push((Number(page) - 1) * Number(limit));
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ leads: result.rows, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('Error fetching leads:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /leads — create a single lead */
router.post('/leads', auth, requireAdmin, async (req, res) => {
  const { name, email, company, event_type, location, lead_source, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required.' });
  if (lead_source && !VALID_LEAD_SOURCES.includes(lead_source)) {
    return res.status(400).json({ error: `Invalid lead source. Must be one of: ${VALID_LEAD_SOURCES.join(', ')}` });
  }
  try {
    const result = await pool.query(
      `INSERT INTO email_leads (name, email, company, event_type, location, lead_source, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name.trim(), email.trim().toLowerCase(), company || null, event_type || null, location || null, lead_source || 'manual', notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A lead with this email already exists.' });
    }
    console.error('Error creating lead:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /leads/import — CSV bulk import */
router.post('/leads/import', auth, requireAdmin, async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).json({ error: 'No CSV file uploaded.' });
  }

  const file = req.files.file;
  if (!file.name.endsWith('.csv') && file.mimetype !== 'text/csv') {
    return res.status(400).json({ error: 'File must be a CSV.' });
  }

  const csvText = file.data.toString('utf-8');
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV must have a header row and at least one data row.' });
  }

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const emailIdx = headers.indexOf('email');
  const nameIdx = headers.indexOf('name');

  if (emailIdx === -1 || nameIdx === -1) {
    return res.status(400).json({ error: 'CSV must have "name" and "email" columns.' });
  }

  const companyIdx = headers.indexOf('company');
  const eventTypeIdx = headers.indexOf('event_type');
  const locationIdx = headers.indexOf('location');
  const sourceIdx = headers.indexOf('lead_source');
  const notesIdx = headers.indexOf('notes');

  const client = await pool.connect();
  let imported = 0;
  let skipped = 0;
  const errors = [];

  try {
    await client.query('BEGIN');

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const name = cols[nameIdx]?.trim();
      const email = cols[emailIdx]?.trim().toLowerCase();

      if (!name || !email) {
        skipped++;
        errors.push(`Row ${i + 1}: missing name or email`);
        continue;
      }

      const company = companyIdx >= 0 ? cols[companyIdx]?.trim() || null : null;
      const eventType = eventTypeIdx >= 0 ? cols[eventTypeIdx]?.trim() || null : null;
      const loc = locationIdx >= 0 ? cols[locationIdx]?.trim() || null : null;
      const source = sourceIdx >= 0 ? cols[sourceIdx]?.trim() || null : null;
      const notes = notesIdx >= 0 ? cols[notesIdx]?.trim() || null : null;

      try {
        await client.query(
          `INSERT INTO email_leads (name, email, company, event_type, location, lead_source, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (email) DO UPDATE SET
             name = COALESCE(NULLIF(EXCLUDED.name, ''), email_leads.name),
             company = COALESCE(EXCLUDED.company, email_leads.company),
             event_type = COALESCE(EXCLUDED.event_type, email_leads.event_type),
             location = COALESCE(EXCLUDED.location, email_leads.location),
             notes = COALESCE(EXCLUDED.notes, email_leads.notes)`,
          [name, email, company, eventType, loc, source || 'csv_import', notes]
        );
        imported++;
      } catch (rowErr) {
        skipped++;
        errors.push(`Row ${i + 1}: ${rowErr.message}`);
      }
    }

    await client.query('COMMIT');
    res.json({ imported, skipped, errors: errors.slice(0, 10) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('CSV import error:', err);
    res.status(500).json({ error: 'Import failed.' });
  } finally {
    client.release();
  }
});

/** Simple CSV line parser (handles quoted fields) */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/** GET /leads/:id — lead detail with send history */
router.get('/leads/:id', auth, requireAdmin, async (req, res) => {
  try {
    const lead = await pool.query('SELECT * FROM email_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows[0]) return res.status(404).json({ error: 'Lead not found.' });

    const sends = await pool.query(
      `SELECT es.*, ec.name AS campaign_name
       FROM email_sends es
       LEFT JOIN email_campaigns ec ON ec.id = es.campaign_id
       WHERE es.lead_id = $1 ORDER BY es.sent_at DESC LIMIT 50`,
      [req.params.id]
    );

    const conversations = await pool.query(
      'SELECT * FROM email_conversations WHERE lead_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({ ...lead.rows[0], sends: sends.rows, conversations: conversations.rows });
  } catch (err) {
    console.error('Error fetching lead:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /leads/:id — update lead */
router.put('/leads/:id', auth, requireAdmin, async (req, res) => {
  const { name, email, company, event_type, location, lead_source, notes, status } = req.body;
  try {
    const result = await pool.query(`
      UPDATE email_leads SET
        name = COALESCE($1, name), email = COALESCE($2, email),
        company = COALESCE($3, company), event_type = COALESCE($4, event_type),
        location = COALESCE($5, location), lead_source = COALESCE($6, lead_source),
        notes = COALESCE($7, notes), status = COALESCE($8, status)
      WHERE id = $9 RETURNING *
    `, [name, email, company, event_type, location, lead_source, notes, status, req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Lead not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating lead:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /leads/:id — soft-delete (unsubscribe) */
router.delete('/leads/:id', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE email_leads SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Lead not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error deleting lead:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Campaign Management ──────────────────────────────────────────

/** GET /campaigns — list campaigns */
router.get('/campaigns', auth, requireAdmin, async (req, res) => {
  const { type, status } = req.query;
  try {
    let query = `
      SELECT c.*,
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
  } catch (err) {
    console.error('Error fetching campaigns:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /campaigns — create campaign */
router.post('/campaigns', auth, requireAdmin, async (req, res) => {
  const { name, type, subject, html_body, text_body, from_email, reply_to, target_sources, target_event_types } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Campaign name is required.' });
  if (type && !['blast', 'sequence'].includes(type)) {
    return res.status(400).json({ error: 'Type must be "blast" or "sequence".' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO email_campaigns (name, type, subject, html_body, text_body, from_email, reply_to, target_sources, target_event_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [name.trim(), type || 'blast', subject || null, html_body || null, text_body || null,
       from_email || null, reply_to || null,
       target_sources ? JSON.stringify(target_sources) : null,
       target_event_types ? JSON.stringify(target_event_types) : null,
       req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating campaign:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /campaigns/:id — campaign detail with stats */
router.get('/campaigns/:id', auth, requireAdmin, async (req, res) => {
  try {
    const campaign = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (!campaign.rows[0]) return res.status(404).json({ error: 'Campaign not found.' });

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

    const sends = await pool.query(
      `SELECT es.*, el.name AS lead_name, el.email AS lead_email
       FROM email_sends es
       JOIN email_leads el ON el.id = es.lead_id
       WHERE es.campaign_id = $1 ORDER BY es.sent_at DESC`,
      [req.params.id]
    );

    let steps = [];
    let enrollments = [];
    if (campaign.rows[0].type === 'sequence') {
      const stepsResult = await pool.query(
        'SELECT * FROM email_sequence_steps WHERE campaign_id = $1 ORDER BY step_order',
        [req.params.id]
      );
      steps = stepsResult.rows;

      const enrollResult = await pool.query(
        `SELECT e.*, el.name AS lead_name, el.email AS lead_email
         FROM email_sequence_enrollments e
         JOIN email_leads el ON el.id = e.lead_id
         WHERE e.campaign_id = $1 ORDER BY e.enrolled_at DESC`,
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
  } catch (err) {
    console.error('Error fetching campaign:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /campaigns/:id — update campaign */
router.put('/campaigns/:id', auth, requireAdmin, async (req, res) => {
  const { name, subject, html_body, text_body, from_email, reply_to, target_sources, target_event_types, status } = req.body;
  try {
    const result = await pool.query(`
      UPDATE email_campaigns SET
        name = COALESCE($1, name), subject = COALESCE($2, subject),
        html_body = COALESCE($3, html_body), text_body = COALESCE($4, text_body),
        from_email = COALESCE($5, from_email), reply_to = COALESCE($6, reply_to),
        target_sources = COALESCE($7, target_sources),
        target_event_types = COALESCE($8, target_event_types),
        status = COALESCE($9, status)
      WHERE id = $10 RETURNING *
    `, [name, subject, html_body, text_body, from_email, reply_to,
        target_sources ? JSON.stringify(target_sources) : null,
        target_event_types ? JSON.stringify(target_event_types) : null,
        status, req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Campaign not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating campaign:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /campaigns/:id — archive campaign */
router.delete('/campaigns/:id', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE email_campaigns SET status = 'archived' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Campaign not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error archiving campaign:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /campaigns/:id/send — execute blast send */
router.post('/campaigns/:id/send', auth, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const campaign = await client.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (!campaign.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found.' });
    }
    const c = campaign.rows[0];
    if (c.type !== 'blast') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only blast campaigns can be sent this way. Use activate for sequences.' });
    }
    if (!c.subject || !c.html_body) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Campaign must have a subject and body.' });
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
      return res.status(400).json({ error: 'No active leads match the targeting criteria.' });
    }

    // Update campaign status
    await client.query(
      `UPDATE email_campaigns SET status = 'sending', sent_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    await client.query('COMMIT');

    // Send emails in background (don't block response)
    const unsubscribeBase = `${process.env.CLIENT_URL || 'http://localhost:3000'}/api/email-marketing/unsubscribe`;
    sendBlastEmails(c, leads.rows, unsubscribeBase).catch(err => {
      console.error('Blast send error:', err);
    });

    res.json({ message: `Sending to ${leads.rows.length} leads...`, count: leads.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error sending campaign:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

/** Background blast email sender */
async function sendBlastEmails(campaign, leads, unsubscribeBase) {
  const BATCH_SIZE = 100;
  const BATCH_DELAY = 600; // ms between batches

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);

    const emailPromises = batch.map(async (lead) => {
      const unsubscribeToken = jwt.sign({ leadId: lead.id }, process.env.JWT_SECRET, { expiresIn: '365d' });
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
router.post('/campaigns/:id/schedule', auth, requireAdmin, async (req, res) => {
  const { scheduled_at } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at is required.' });
  try {
    const result = await pool.query(
      `UPDATE email_campaigns SET status = 'scheduled', scheduled_at = $1 WHERE id = $2 RETURNING *`,
      [scheduled_at, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Campaign not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error scheduling campaign:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Sequence Steps ───────────────────────────────────────────────

/** GET /campaigns/:id/steps — list sequence steps */
router.get('/campaigns/:id/steps', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM email_sequence_steps WHERE campaign_id = $1 ORDER BY step_order',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching steps:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /campaigns/:id/steps — add step */
router.post('/campaigns/:id/steps', auth, requireAdmin, async (req, res) => {
  const { subject, html_body, text_body, delay_days, delay_hours } = req.body;
  if (!subject || !html_body) return res.status(400).json({ error: 'Subject and body are required.' });
  try {
    // Get next step order
    const maxStep = await pool.query(
      'SELECT COALESCE(MAX(step_order), 0) AS max_order FROM email_sequence_steps WHERE campaign_id = $1',
      [req.params.id]
    );
    const nextOrder = maxStep.rows[0].max_order + 1;

    const result = await pool.query(
      `INSERT INTO email_sequence_steps (campaign_id, step_order, subject, html_body, text_body, delay_days, delay_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.id, nextOrder, subject, html_body, text_body || null, delay_days || 0, delay_hours || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding step:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /campaigns/:id/steps/:stepId — update step */
router.put('/campaigns/:id/steps/:stepId', auth, requireAdmin, async (req, res) => {
  const { subject, html_body, text_body, delay_days, delay_hours } = req.body;
  try {
    const result = await pool.query(`
      UPDATE email_sequence_steps SET
        subject = COALESCE($1, subject), html_body = COALESCE($2, html_body),
        text_body = COALESCE($3, text_body), delay_days = COALESCE($4, delay_days),
        delay_hours = COALESCE($5, delay_hours)
      WHERE id = $6 AND campaign_id = $7 RETURNING *
    `, [subject, html_body, text_body, delay_days, delay_hours, req.params.stepId, req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Step not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating step:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /campaigns/:id/steps/:stepId — remove step and reorder */
router.delete('/campaigns/:id/steps/:stepId', auth, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const step = await client.query(
      'SELECT step_order FROM email_sequence_steps WHERE id = $1 AND campaign_id = $2',
      [req.params.stepId, req.params.id]
    );
    if (!step.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Step not found.' });
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
    await client.query('ROLLBACK');
    console.error('Error deleting step:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

/** POST /campaigns/:id/activate — activate sequence */
router.post('/campaigns/:id/activate', auth, requireAdmin, async (req, res) => {
  try {
    const steps = await pool.query(
      'SELECT COUNT(*) FROM email_sequence_steps WHERE campaign_id = $1',
      [req.params.id]
    );
    if (parseInt(steps.rows[0].count, 10) === 0) {
      return res.status(400).json({ error: 'Add at least one step before activating.' });
    }

    const result = await pool.query(
      `UPDATE email_campaigns SET status = 'active' WHERE id = $1 AND type = 'sequence' RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Sequence not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error activating sequence:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /campaigns/:id/pause — pause sequence */
router.post('/campaigns/:id/pause', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE email_campaigns SET status = 'paused' WHERE id = $1 AND type = 'sequence' RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Sequence not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error pausing sequence:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Enrollment ───────────────────────────────────────────────────

/** POST /campaigns/:id/enroll — enroll leads in a sequence */
router.post('/campaigns/:id/enroll', auth, requireAdmin, async (req, res) => {
  const { lead_ids } = req.body;
  if (!lead_ids || !lead_ids.length) {
    return res.status(400).json({ error: 'lead_ids array is required.' });
  }
  try {
    const campaign = await pool.query(
      'SELECT * FROM email_campaigns WHERE id = $1 AND type = $2',
      [req.params.id, 'sequence']
    );
    if (!campaign.rows[0]) return res.status(404).json({ error: 'Sequence campaign not found.' });

    // Get first step delay to calculate next_step_due_at
    const firstStep = await pool.query(
      'SELECT delay_days, delay_hours FROM email_sequence_steps WHERE campaign_id = $1 ORDER BY step_order LIMIT 1',
      [req.params.id]
    );

    let enrolled = 0;
    for (const leadId of lead_ids) {
      try {
        if (firstStep.rows[0]) {
          const { delay_days, delay_hours } = firstStep.rows[0];
          await pool.query(
            `INSERT INTO email_sequence_enrollments (campaign_id, lead_id, next_step_due_at)
             VALUES ($1, $2, NOW() + MAKE_INTERVAL(days => $3, hours => $4))
             ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
            [req.params.id, leadId, delay_days, delay_hours]
          );
        } else {
          await pool.query(
            `INSERT INTO email_sequence_enrollments (campaign_id, lead_id, next_step_due_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
            [req.params.id, leadId]
          );
        }
        enrolled++;
      } catch (enrollErr) {
        console.error(`Error enrolling lead ${leadId}:`, enrollErr);
      }
    }

    res.json({ enrolled });
  } catch (err) {
    console.error('Error enrolling leads:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /campaigns/:id/enrollments — list enrollments */
router.get('/campaigns/:id/enrollments', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*, el.name AS lead_name, el.email AS lead_email
       FROM email_sequence_enrollments e
       JOIN email_leads el ON el.id = e.lead_id
       WHERE e.campaign_id = $1 ORDER BY e.enrolled_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching enrollments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Analytics ────────────────────────────────────────────────────

/** GET /analytics/overview — aggregate stats */
router.get('/analytics/overview', auth, requireAdmin, async (req, res) => {
  try {
    const [leadsResult, campaignsResult, sendsResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'active') AS active FROM email_leads`),
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'sent' OR status = 'active') AS active FROM email_campaigns`),
      pool.query(`
        SELECT
          COUNT(*) AS total_sends,
          COUNT(*) FILTER (WHERE status IN ('delivered','opened','clicked')) AS total_delivered,
          COUNT(*) FILTER (WHERE status IN ('opened','clicked')) AS total_opens,
          COUNT(*) FILTER (WHERE status = 'clicked') AS total_clicks,
          COUNT(*) FILTER (WHERE status = 'bounced') AS total_bounces,
          COUNT(*) FILTER (WHERE status = 'complained') AS total_complaints
        FROM email_sends
      `),
    ]);

    const sends = sendsResult.rows[0];
    const totalSends = parseInt(sends.total_sends, 10) || 0;

    res.json({
      leads: leadsResult.rows[0],
      campaigns: campaignsResult.rows[0],
      sends: {
        ...sends,
        open_rate: totalSends > 0 ? (parseInt(sends.total_opens, 10) / totalSends * 100).toFixed(1) : '0.0',
        click_rate: totalSends > 0 ? (parseInt(sends.total_clicks, 10) / totalSends * 100).toFixed(1) : '0.0',
        bounce_rate: totalSends > 0 ? (parseInt(sends.total_bounces, 10) / totalSends * 100).toFixed(1) : '0.0',
      },
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Conversations ────────────────────────────────────────────────

/** GET /conversations — list conversations grouped by lead */
router.get('/conversations', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT el.id AS lead_id, el.name, el.email,
        (SELECT COUNT(*) FROM email_conversations ec WHERE ec.lead_id = el.id AND ec.read_at IS NULL AND ec.direction = 'inbound') AS unread_count,
        (SELECT MAX(ec2.created_at) FROM email_conversations ec2 WHERE ec2.lead_id = el.id) AS last_message_at
      FROM email_leads el
      WHERE EXISTS (SELECT 1 FROM email_conversations ec WHERE ec.lead_id = el.id)
      ORDER BY last_message_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /conversations/:leadId — conversation thread */
router.get('/conversations/:leadId', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM email_conversations WHERE lead_id = $1 ORDER BY created_at ASC',
      [req.params.leadId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching conversation:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /conversations/:leadId/reply — admin sends reply */
router.post('/conversations/:leadId/reply', auth, requireAdmin, async (req, res) => {
  const { subject, body_html, body_text } = req.body;
  if (!body_html && !body_text) return res.status(400).json({ error: 'Message body is required.' });

  try {
    const lead = await pool.query('SELECT * FROM email_leads WHERE id = $1', [req.params.leadId]);
    if (!lead.rows[0]) return res.status(404).json({ error: 'Lead not found.' });

    const emailResult = await sendEmail({
      to: lead.rows[0].email,
      subject: subject || `Re: Dr. Bartender`,
      html: wrapMarketingEmail(body_html || `<p>${body_text}</p>`),
      text: body_text || undefined,
    });

    const convo = await pool.query(
      `INSERT INTO email_conversations (lead_id, direction, subject, body_text, body_html, resend_id, admin_id)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.leadId, subject || 'Re: Dr. Bartender', body_text || null, body_html || null, emailResult.id, req.user.id]
    );

    res.status(201).json(convo.rows[0]);
  } catch (err) {
    console.error('Error sending reply:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /conversations/:conversationId/read — mark as read */
router.put('/conversations/:conversationId/read', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE email_conversations SET read_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.conversationId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Conversation not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error marking read:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /conversations/:leadId/mark-replied — manual mark as replied */
router.post('/conversations/:leadId/mark-replied', auth, requireAdmin, async (req, res) => {
  const { notes } = req.body;
  try {
    const convo = await pool.query(
      `INSERT INTO email_conversations (lead_id, direction, subject, body_text, admin_id)
       VALUES ($1, 'inbound', 'Manual reply noted', $2, $3) RETURNING *`,
      [req.params.leadId, notes || 'Reply received (marked manually)', req.user.id]
    );
    res.status(201).json(convo.rows[0]);
  } catch (err) {
    console.error('Error marking replied:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Public Unsubscribe ───────────────────────────────────────────

/** GET /unsubscribe — public unsubscribe endpoint */
router.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Invalid unsubscribe link.');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    await pool.query(
      `UPDATE email_leads SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE id = $1`,
      [decoded.leadId]
    );
    // Also pause any active enrollments
    await pool.query(
      `UPDATE email_sequence_enrollments SET status = 'unsubscribed' WHERE lead_id = $1 AND status = 'active'`,
      [decoded.leadId]
    );
    res.send(`
      <html><body style="font-family:Georgia,serif;text-align:center;padding:60px;">
        <h2>You've been unsubscribed</h2>
        <p>You will no longer receive marketing emails from Dr. Bartender.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(400).send('Invalid or expired unsubscribe link.');
  }
});

module.exports = router;
