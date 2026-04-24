const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');

const router = express.Router();

const VALID_SOURCES = ['direct', 'thumbtack', 'referral', 'website'];

/** GET /api/clients — list all clients */
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;
  let query = 'SELECT * FROM clients WHERE 1=1';
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`;
  }

  query += ' ORDER BY created_at DESC';
  params.push(Number(limit));
  query += ` LIMIT $${params.length}`;
  params.push((Number(page) - 1) * Number(limit));
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
  const result = await pool.query(
    `INSERT INTO clients (name, email, phone, source, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name.trim(), email || null, phone || null, source || 'direct', notes || null]
  );
  res.status(201).json(result.rows[0]);
}));

/** GET /api/clients/:id — get client detail with proposals */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Client and proposals are independent lookups — Promise.all saves one round-trip.
  // Explicit column allowlist on proposals excludes pricing_snapshot blob.
  const [client, proposals] = await Promise.all([
    pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]),
    pool.query(`
      SELECT p.id, p.token, p.client_id, p.event_type, p.event_type_custom,
             p.event_date, p.status, p.total_price, p.amount_paid, p.created_at,
             sp.name AS package_name, sp.slug AS package_slug
      FROM proposals p
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.client_id = $1
      ORDER BY p.created_at DESC
    `, [req.params.id]),
  ]);
  if (!client.rows[0]) throw new NotFoundError('Client not found.');

  res.json({ ...client.rows[0], proposals: proposals.rows });
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
  const result = await pool.query(`
    UPDATE clients SET
      name = COALESCE($1, name), email = COALESCE($2, email),
      phone = COALESCE($3, phone), source = COALESCE($4, source),
      notes = COALESCE($5, notes)
    WHERE id = $6 RETURNING *
  `, [name ? name.trim() : name, email, phone, source, notes, req.params.id]);

  if (!result.rows[0]) throw new NotFoundError('Client not found.');
  res.json(result.rows[0]);
}));

module.exports = router;
