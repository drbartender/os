const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

/** GET /api/clients — list all clients */
router.get('/', auth, requireAdmin, async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;
  try {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/clients — create a new client */
router.post('/', auth, requireAdmin, async (req, res) => {
  const { name, email, phone, source, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required.' });
  try {
    const result = await pool.query(
      `INSERT INTO clients (name, email, phone, source, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, email || null, phone || null, source || 'direct', notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/clients/:id — get client detail with proposals */
router.get('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const client = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!client.rows[0]) return res.status(404).json({ error: 'Client not found.' });

    const proposals = await pool.query(`
      SELECT p.*, sp.name AS package_name, sp.slug AS package_slug
      FROM proposals p
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.client_id = $1
      ORDER BY p.created_at DESC
    `, [req.params.id]);

    res.json({ ...client.rows[0], proposals: proposals.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/clients/:id — update client */
router.put('/:id', auth, requireAdmin, async (req, res) => {
  const { name, email, phone, source, notes } = req.body;
  try {
    const result = await pool.query(`
      UPDATE clients SET
        name = COALESCE($1, name), email = COALESCE($2, email),
        phone = COALESCE($3, phone), source = COALESCE($4, source),
        notes = COALESCE($5, notes)
      WHERE id = $6 RETURNING *
    `, [name, email, phone, source, notes, req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
