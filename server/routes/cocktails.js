const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

// ─── Public routes ────────────────────────────────────────────────

/** GET /api/cocktails — active cocktails with category info (for client questionnaire) */
router.get('/', publicLimiter, async (req, res) => {
  try {
    const [catsResult, cocktailsResult] = await Promise.all([
      pool.query('SELECT * FROM cocktail_categories ORDER BY sort_order'),
      pool.query(
        `SELECT c.*, cc.label AS category_label, cc.sort_order AS category_sort_order
         FROM cocktails c
         LEFT JOIN cocktail_categories cc ON cc.id = c.category_id
         WHERE c.is_active = true
         ORDER BY cc.sort_order, c.sort_order`
      ),
    ]);
    res.json({ categories: catsResult.rows, cocktails: cocktailsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/cocktails/admin — all cocktails including inactive (admin) */
router.get('/admin', auth, requireAdmin, async (req, res) => {
  try {
    const [catsResult, cocktailsResult] = await Promise.all([
      pool.query('SELECT * FROM cocktail_categories ORDER BY sort_order'),
      pool.query(
        `SELECT c.*, cc.label AS category_label, cc.sort_order AS category_sort_order
         FROM cocktails c
         LEFT JOIN cocktail_categories cc ON cc.id = c.category_id
         ORDER BY cc.sort_order, c.sort_order`
      ),
    ]);
    res.json({ categories: catsResult.rows, cocktails: cocktailsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/cocktails/categories — all categories (public) */
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cocktail_categories ORDER BY sort_order');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin — bulk reorder ─────────────────────────────────────────

/** POST /api/cocktails/reorder — bulk update sort_order for cocktails */
router.post('/reorder', auth, requireAdmin, async (req, res) => {
  const { items } = req.body; // [{ id, sort_order }, ...]
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required.' });
  try {
    const ids = items.map(x => x.id);
    const orders = items.map(x => x.sort_order);
    await pool.query(
      `UPDATE cocktails c SET sort_order = v.so
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
       WHERE c.id = v.id`,
      [ids, orders]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/cocktails/categories/reorder — bulk update sort_order for categories */
router.post('/categories/reorder', auth, requireAdmin, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required.' });
  try {
    const ids = items.map(x => x.id);
    const orders = items.map(x => x.sort_order);
    await pool.query(
      `UPDATE cocktail_categories c SET sort_order = v.so
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
       WHERE c.id = v.id`,
      [ids, orders]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin — category management ─────────────────────────────────

/** POST /api/cocktails/categories — create category */
router.post('/categories', auth, requireAdmin, async (req, res) => {
  const { id, label, sort_order } = req.body;
  if (!id || !label) return res.status(400).json({ error: 'id and label are required.' });
  try {
    const result = await pool.query(
      'INSERT INTO cocktail_categories (id, label, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [id, label, sort_order || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with that ID already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/cocktails/categories/:id — update category */
router.put('/categories/:id', auth, requireAdmin, async (req, res) => {
  const { label, sort_order } = req.body;
  try {
    const result = await pool.query(
      `UPDATE cocktail_categories SET
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

/** DELETE /api/cocktails/categories/:id — delete category (blocked if cocktails reference it) */
router.delete('/categories/:id', auth, requireAdmin, async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT COUNT(*) FROM cocktails WHERE category_id = $1',
      [req.params.id]
    );
    if (parseInt(check.rows[0].count) > 0) {
      return res.status(409).json({
        error: 'Cannot delete category — remove or reassign its cocktails first.',
      });
    }
    const result = await pool.query(
      'DELETE FROM cocktail_categories WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Category not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Admin — cocktail management ─────────────────────────────────

/** POST /api/cocktails — create cocktail */
router.post('/', auth, requireAdmin, async (req, res) => {
  const { id, name, category_id, emoji, description, sort_order, base_spirit, ingredients } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required.' });
  try {
    const result = await pool.query(
      `INSERT INTO cocktails (id, name, category_id, emoji, description, sort_order, base_spirit, ingredients)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, name, category_id || null, emoji || null, description || null, sort_order || 0, base_spirit || null, JSON.stringify(ingredients || [])]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A cocktail with that ID already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/cocktails/:id — update cocktail */
router.put('/:id', auth, requireAdmin, async (req, res) => {
  const { name, category_id, emoji, description, sort_order, is_active, base_spirit, ingredients } = req.body;
  try {
    const result = await pool.query(
      `UPDATE cocktails SET
        name        = COALESCE($1, name),
        category_id = COALESCE($2, category_id),
        emoji       = COALESCE($3, emoji),
        description = COALESCE($4, description),
        sort_order  = COALESCE($5, sort_order),
        is_active   = COALESCE($6, is_active),
        base_spirit = COALESCE($7, base_spirit),
        ingredients = COALESCE($8::jsonb, ingredients)
       WHERE id = $9 RETURNING *`,
      [
        name || null,
        category_id || null,
        emoji || null,
        description || null,
        sort_order ?? null,
        is_active ?? null,
        base_spirit || null,
        ingredients !== undefined ? JSON.stringify(ingredients) : null,
        req.params.id,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Cocktail not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/cocktails/:id — soft delete (sets is_active = false) */
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE cocktails SET is_active = false WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Cocktail not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
