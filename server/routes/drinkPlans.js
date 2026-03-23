const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// ─── Permission helper ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

// ─── Public routes (token-based) ─────────────────────────────────

/** GET /api/drink-plans/t/:token — fetch plan by token (public) */
router.get('/t/:token', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, token, client_name, client_email, event_name, event_date, status, serving_type, selections, submitted_at, created_at FROM drink_plans WHERE token = $1',
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/drink-plans/t/:token — save draft or submit (public) */
router.put('/t/:token', async (req, res) => {
  const { serving_type, selections, status } = req.body;
  try {
    // Check plan exists and is not already submitted
    const existing = await pool.query(
      'SELECT id, status FROM drink_plans WHERE token = $1',
      [req.params.token]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    if (existing.rows[0].status === 'submitted' || existing.rows[0].status === 'reviewed') {
      return res.status(400).json({ error: 'This plan has already been submitted.' });
    }

    const newStatus = status === 'submitted' ? 'submitted' : 'draft';

    const result = await pool.query(`
      UPDATE drink_plans SET
        serving_type = COALESCE($1, serving_type),
        selections = COALESCE($2::jsonb, selections),
        status = $3,
        submitted_at = CASE WHEN $3 = 'submitted' THEN NOW() ELSE submitted_at END
      WHERE token = $4
      RETURNING id, token, status, serving_type, selections, submitted_at
    `, [
      serving_type || null,
      selections ? JSON.stringify(selections) : null,
      newStatus,
      req.params.token
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin routes (auth required) ────────────────────────────────

/** GET /api/drink-plans — list all plans */
router.get('/', auth, requireAdmin, async (req, res) => {
  const { status, search } = req.query;
  try {
    let query = `
      SELECT dp.*, u.email AS created_by_email
      FROM drink_plans dp
      LEFT JOIN users u ON u.id = dp.created_by
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND dp.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (dp.client_name ILIKE $${params.length} OR dp.event_name ILIKE $${params.length} OR dp.client_email ILIKE $${params.length})`;
    }

    query += ' ORDER BY dp.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/drink-plans — create a new plan */
router.post('/', auth, requireAdmin, async (req, res) => {
  const { client_name, client_email, event_name, event_date } = req.body;
  if (!client_name) {
    return res.status(400).json({ error: 'Client name is required.' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO drink_plans (client_name, client_email, event_name, event_date, created_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [
      client_name,
      client_email || null,
      event_name || null,
      event_date || null,
      req.user.id
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/drink-plans/by-proposal/:proposalId — fetch plan by proposal id */
router.get('/by-proposal/:proposalId', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.*, u.email AS created_by_email
       FROM drink_plans dp
       LEFT JOIN users u ON u.id = dp.created_by
       WHERE dp.proposal_id = $1`,
      [req.params.proposalId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'No drink plan found for this proposal.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/drink-plans/:id — fetch single plan by id */
router.get('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.*, u.email AS created_by_email
       FROM drink_plans dp
       LEFT JOIN users u ON u.id = dp.created_by
       WHERE dp.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/drink-plans/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdmin, async (req, res) => {
  const { admin_notes } = req.body;
  try {
    const result = await pool.query(
      'UPDATE drink_plans SET admin_notes = $1 WHERE id = $2 RETURNING id, admin_notes',
      [admin_notes || '', req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/drink-plans/:id/status — update plan status */
router.patch('/:id/status', auth, requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'draft', 'submitted', 'reviewed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const result = await pool.query(
      'UPDATE drink_plans SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/drink-plans/:id — delete a plan */
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM drink_plans WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
