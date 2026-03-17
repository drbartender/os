const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

// ─── Public routes ────────────────────────────────────────────────

/** GET /api/mocktails — active mocktails with category info */
router.get('/', async (req, res) => {
  try {
    const [catsResult, mocktailsResult] = await Promise.all([
      pool.query('SELECT * FROM mocktail_categories ORDER BY sort_order'),
      pool.query(
        `SELECT m.*, mc.label AS category_label, mc.sort_order AS category_sort_order
         FROM mocktails m
         LEFT JOIN mocktail_categories mc ON mc.id = m.category_id
         WHERE m.is_active = true
         ORDER BY mc.sort_order, m.sort_order`
      ),
    ]);
    res.json({ categories: catsResult.rows, mocktails: mocktailsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/mocktails/admin — all mocktails including inactive */
router.get('/admin', auth, requireAdmin, async (req, res) => {
  try {
    const [catsResult, mocktailsResult] = await Promise.all([
      pool.query('SELECT * FROM mocktail_categories ORDER BY sort_order'),
      pool.query(
        `SELECT m.*, mc.label AS category_label, mc.sort_order AS category_sort_order
         FROM mocktails m
         LEFT JOIN mocktail_categories mc ON mc.id = m.category_id
         ORDER BY mc.sort_order, m.sort_order`
      ),
    ]);
    res.json({ categories: catsResult.rows, mocktails: mocktailsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/mocktails/categories — all categories */
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM mocktail_categories ORDER BY sort_order');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin — bulk reorder ─────────────────────────────────────────

/** POST /api/mocktails/reorder — bulk update sort_order for mocktails */
router.post('/reorder', auth, requireAdmin, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required.' });
  try {
    const ids = items.map(x => x.id);
    const orders = items.map(x => x.sort_order);
    await pool.query(
      `UPDATE mocktails m SET sort_order = v.so
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
       WHERE m.id = v.id`,
      [ids, orders]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/mocktails/categories/reorder — bulk update sort_order for categories */
router.post('/categories/reorder', auth, requireAdmin, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required.' });
  try {
    const ids = items.map(x => x.id);
    const orders = items.map(x => x.sort_order);
    await pool.query(
      `UPDATE mocktail_categories m SET sort_order = v.so
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
       WHERE m.id = v.id`,
      [ids, orders]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin — category management ─────────────────────────────────

/** POST /api/mocktails/categories — create category */
router.post('/categories', auth, requireAdmin, async (req, res) => {
  const { id, label, sort_order } = req.body;
  if (!id || !label) return res.status(400).json({ error: 'id and label are required.' });
  try {
    const result = await pool.query(
      'INSERT INTO mocktail_categories (id, label, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [id, label, sort_order || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with that ID already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/mocktails/categories/:id — update category */
router.put('/categories/:id', auth, requireAdmin, async (req, res) => {
  const { label, sort_order } = req.body;
  try {
    const result = await pool.query(
      `UPDATE mocktail_categories SET
        label = COALESCE($1, label),
        sort_order = COALESCE($2, sort_order)
       WHERE id = $3 RETURNING *`,
      [label || null, sort_order ?? null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Category not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/mocktails/categories/:id — delete category */
router.delete('/categories/:id', auth, requireAdmin, async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT COUNT(*) FROM mocktails WHERE category_id = $1',
      [req.params.id]
    );
    if (parseInt(check.rows[0].count) > 0) {
      return res.status(409).json({
        error: 'Cannot delete category — remove or reassign its mocktails first.',
      });
    }
    const result = await pool.query(
      'DELETE FROM mocktail_categories WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Category not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin — mocktail management ─────────────────────────────────

/** POST /api/mocktails — create mocktail */
router.post('/', auth, requireAdmin, async (req, res) => {
  const { id, name, category_id, emoji, description, sort_order } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required.' });
  try {
    const result = await pool.query(
      `INSERT INTO mocktails (id, name, category_id, emoji, description, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, name, category_id || null, emoji || null, description || null, sort_order || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A mocktail with that ID already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/mocktails/:id — update mocktail */
router.put('/:id', auth, requireAdmin, async (req, res) => {
  const { name, category_id, emoji, description, sort_order, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE mocktails SET
        name        = COALESCE($1, name),
        category_id = COALESCE($2, category_id),
        emoji       = COALESCE($3, emoji),
        description = COALESCE($4, description),
        sort_order  = COALESCE($5, sort_order),
        is_active   = COALESCE($6, is_active)
       WHERE id = $7 RETURNING *`,
      [
        name || null,
        category_id || null,
        emoji || null,
        description || null,
        sort_order ?? null,
        is_active ?? null,
        req.params.id,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Mocktail not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/mocktails/:id — soft delete */
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE mocktails SET is_active = false WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Mocktail not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
