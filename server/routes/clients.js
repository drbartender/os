// Client CRUD

const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { getClientDetail } = require('../utils/reads/clientDetail');

const router = express.Router();

const VALID_SOURCES = ['direct', 'thumbtack', 'referral', 'website', 'calcom', 'zola', 'instagram', 'checkcherry', 'other'];

// Normalize email to trimmed lowercase (mirrors clientDedup.js) so the
// case-sensitive partial-unique idx_clients_email_unique actually rejects
// case-variant duplicates ('Bob@x' vs 'bob@x'), and so this route stays consistent
// with every other clients.email write path. Non-string/blank/whitespace → null.
const normalizeEmail = (email) =>
  (typeof email === 'string' && email.trim()) ? email.trim().toLowerCase() : null;

/** GET /api/clients — list all clients with per-client aggregates.
 *  `events_count` counts paid/confirmed/completed proposals; `lifetime_value`
 *  sums their `amount_paid`. The aggregates feed the ClientsDashboard sort
 *  options and the Lifetime value column. Explicit column allowlist on
 *  clients excludes `notes` (potentially large free-text). */
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { search } = req.query;
  // Bound pagination: a non-numeric or oversized limit otherwise casts-and-throws (500) or
  // returns an unbounded result set. Clamp to [1, 200], default 50; page floors at 1.
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let query = `
    SELECT
      c.id, c.name, c.email, c.phone, c.source, c.created_at, c.updated_at, c.cc_id,
      -- The boolean only, to keep the list payload slim. This is NOT a
      -- privacy boundary: GET /clients/:id is SELECT * and PUT returns *,
      -- both behind this same requireAdminOrManager guard, so anyone who can
      -- read this list can read the reason with one more request.
      c.marketing_excluded,
      COALESCE(agg.events_count, 0)::int    AS events_count,
      COALESCE(agg.lifetime_value, 0)::float8 AS lifetime_value
    FROM clients c
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')) AS events_count,
        SUM(p.amount_paid) FILTER (WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')) AS lifetime_value
      FROM proposals p
      WHERE p.client_id = c.id
    ) agg ON true
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    query += ` AND (c.name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.phone ILIKE $${params.length})`;
  }

  query += ' ORDER BY c.created_at DESC';
  params.push(limit);
  query += ` LIMIT $${params.length}`;
  params.push((page - 1) * limit);
  query += ` OFFSET $${params.length}`;

  const result = await pool.query(query, params);
  res.json(result.rows);
}));

/** POST /api/clients — create a new client */
router.post('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, email, phone, source, notes } = req.body;
  if (!name || !name.trim()) {
    throw new ValidationError({ name: 'Client name is required.' });
  }
  if (source && !VALID_SOURCES.includes(source)) {
    throw new ValidationError({ source: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
  }
  let result;
  try {
    result = await pool.query(
      `INSERT INTO clients (name, email, phone, source, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim(), normalizeEmail(email), phone || null, source || 'direct', notes || null]
    );
  } catch (err) {
    // A duplicate email trips the partial-unique idx_clients_email_unique.
    // Mirror auth.js: surface a field-level validation error instead of letting
    // the raw 23505 fall through to a generic 500 (Sentry DRBARTENDER-SERVER-10).
    if (err.code === '23505' && err.constraint === 'idx_clients_email_unique') {
      throw new ValidationError({ email: 'A client with this email already exists.' });
    }
    throw err;
  }
  res.status(201).json(result.rows[0]);
}));

/** GET /api/clients/:id — get client detail with proposals. The read is
 *  shared with the Claude connector (server/utils/reads/clientDetail.js); the
 *  admin page passes no hold exclusion and gets the body it always did. */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const detail = await getClientDetail(req.params.id);
  if (!detail) throw new NotFoundError('Client not found.');
  res.json(detail);
}));

/** PUT /api/clients/:id — update client */
router.put('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, email, phone, source, notes } = req.body;
  if (name !== undefined && !name.trim()) {
    throw new ValidationError({ name: 'Client name cannot be empty.' });
  }
  if (source && !VALID_SOURCES.includes(source)) {
    throw new ValidationError({ source: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
  }
  let result;
  try {
    result = await pool.query(`
      UPDATE clients SET
        name = COALESCE($1, name), email = COALESCE($2, email),
        phone = COALESCE($3, phone), source = COALESCE($4, source),
        notes = COALESCE($5, notes)
      WHERE id = $6 RETURNING *
    `, [name ? name.trim() : name, normalizeEmail(email), phone, source, notes, req.params.id]);
  } catch (err) {
    // Editing a client's email to one another client already owns trips the
    // partial-unique idx_clients_email_unique — surface it as a field error
    // rather than a raw 500 (Sentry DRBARTENDER-SERVER-10).
    if (err.code === '23505' && err.constraint === 'idx_clients_email_unique') {
      throw new ValidationError({ email: 'A client with this email already exists.' });
    }
    throw err;
  }

  if (!result.rows[0]) throw new NotFoundError('Client not found.');
  res.json(result.rows[0]);
}));

module.exports = router;
