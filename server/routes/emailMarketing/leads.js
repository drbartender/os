/**
 * Email-marketing lead CRUD and CSV import.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');

const router = express.Router();

// Must mirror the schema CHECK on email_leads.lead_source. If you add a new value
// here, add it to client/src/utils/leadSources.js and the DDL in schema.sql.
const VALID_LEAD_SOURCES = ['manual', 'csv_import', 'website', 'quote_wizard', 'potion_lab', 'thumbtack', 'referral', 'instagram', 'facebook', 'google', 'other'];
// ─── Lead Management ──────────────────────────────────────────────

/** GET /leads — list leads with search/filter/pagination */
router.get('/leads', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { search, status, lead_source } = req.query;
  // Bound pagination: a non-numeric limit otherwise casts to NaN and 22P02-500s;
  // page=0 yields a negative OFFSET. Clamp to [1, 100], default 50; page floors at 1.
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
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
}));

/** POST /leads — create a single lead */
router.post('/leads', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, email, company, event_type, location, lead_source, notes } = req.body;

  const fieldErrors = {};
  if (!name || !name.trim()) fieldErrors.name = 'Name is required.';
  if (!email || !email.trim()) fieldErrors.email = 'Email is required.';
  if (lead_source && !VALID_LEAD_SOURCES.includes(lead_source)) {
    fieldErrors.lead_source = `Must be one of: ${VALID_LEAD_SOURCES.join(', ')}`;
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(fieldErrors);
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
      throw new ConflictError('A lead with this email already exists.', 'DUPLICATE_LEAD');
    }
    throw err;
  }
}));

/** POST /leads/import — CSV bulk import */
router.post('/leads/import', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  if (!req.files || !req.files.file) {
    throw new ValidationError({ file: 'No CSV file uploaded.' });
  }

  const file = req.files.file;
  if (!file.name.endsWith('.csv') && file.mimetype !== 'text/csv') {
    throw new ValidationError({ file: 'File must be a CSV.' });
  }

  const csvText = file.data.toString('utf-8');
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length < 2) {
    throw new ValidationError({ csv: 'CSV must have a header row and at least one data row.' });
  }

  const MAX_IMPORT_ROWS = 10000;
  if (lines.length - 1 > MAX_IMPORT_ROWS) {
    throw new ValidationError({ csv: `CSV cannot exceed ${MAX_IMPORT_ROWS} rows.` });
  }

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const emailIdx = headers.indexOf('email');
  const nameIdx = headers.indexOf('name');

  if (emailIdx === -1 || nameIdx === -1) {
    throw new ValidationError({ csv: 'CSV must include both "name" and "email" columns.' });
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
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    client.release();
  }
}));

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
router.get('/leads/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Three independent lookups — run in parallel to save 2 round-trips.
  const [lead, sends, conversations] = await Promise.all([
    pool.query('SELECT * FROM email_leads WHERE id = $1', [req.params.id]),
    pool.query(
      `SELECT es.*, ec.name AS campaign_name
       FROM email_sends es
       LEFT JOIN email_campaigns ec ON ec.id = es.campaign_id
       WHERE es.lead_id = $1 ORDER BY es.sent_at DESC LIMIT 50`,
      [req.params.id]
    ),
    // Cap at 100 conversations to prevent unbounded load on lead profile
    pool.query(
      'SELECT * FROM email_conversations WHERE lead_id = $1 ORDER BY created_at ASC LIMIT 100',
      [req.params.id]
    ),
  ]);
  if (!lead.rows[0]) throw new NotFoundError('Lead not found.');

  res.json({ ...lead.rows[0], sends: sends.rows, conversations: conversations.rows });
}));

/** PUT /leads/:id — update lead */
router.put('/leads/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, email, company, event_type, location, lead_source, notes, status } = req.body;
  const result = await pool.query(`
    UPDATE email_leads SET
      name = COALESCE($1, name), email = COALESCE($2, email),
      company = COALESCE($3, company), event_type = COALESCE($4, event_type),
      location = COALESCE($5, location), lead_source = COALESCE($6, lead_source),
      notes = COALESCE($7, notes), status = COALESCE($8, status)
    WHERE id = $9 RETURNING *
  `, [name, email, company, event_type, location, lead_source, notes, status, req.params.id]);

  if (!result.rows[0]) throw new NotFoundError('Lead not found.');
  res.json(result.rows[0]);
}));

/** DELETE /leads/:id — soft-delete (unsubscribe) */
router.delete('/leads/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `UPDATE email_leads SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Lead not found.');
  res.json(result.rows[0]);
}));

module.exports = router;
