const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicReadLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { validateRecipeRows, assertOverridesResolvable, nextRecipeReview, sanitizeRequestAliases, validateEnhancements, validateSyrupId } = require('./potions');
const { normalizeName } = require('../utils/potionCatalog');

const router = express.Router();

// Explicit public column list: recipe_review never ships to the public
// planner (spec §4); ingredients stays public (accepted spec decision).
const PUBLIC_MOCKTAIL_COLUMNS = `m.id, m.name, m.category_id, m.emoji, m.description,
       m.sort_order, m.is_active, m.created_at, m.updated_at, m.ingredients`;

// ─── Public routes ────────────────────────────────────────────────

/** GET /api/mocktails — active mocktails with category info */
router.get('/', publicReadLimiter, asyncHandler(async (req, res) => {
  const [catsResult, mocktailsResult] = await Promise.all([
    pool.query('SELECT * FROM mocktail_categories ORDER BY sort_order'),
    pool.query(
      `SELECT ${PUBLIC_MOCKTAIL_COLUMNS}, mc.label AS category_label, mc.sort_order AS category_sort_order
       FROM mocktails m
       LEFT JOIN mocktail_categories mc ON mc.id = m.category_id
       WHERE m.is_active = true
       ORDER BY mc.sort_order, m.sort_order`
    ),
  ]);
  res.json({ categories: catsResult.rows, mocktails: mocktailsResult.rows });
}));

/** GET /api/mocktails/admin — all mocktails including inactive */
router.get('/admin', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
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
}));

/** GET /api/mocktails/categories — all categories */
router.get('/categories', publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM mocktail_categories ORDER BY sort_order');
  res.json(result.rows);
}));

// ─── Admin — bulk reorder ─────────────────────────────────────────

/** POST /api/mocktails/reorder — bulk update sort_order for mocktails */
router.post('/reorder', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError({ items: 'items array required.' });
  }
  const ids = items.map(x => x.id);
  const orders = items.map(x => x.sort_order);
  await pool.query(
    `UPDATE mocktails m SET sort_order = v.so
     FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
     WHERE m.id = v.id`,
    [ids, orders]
  );
  res.json({ success: true });
}));

/** POST /api/mocktails/categories/reorder — bulk update sort_order for categories */
router.post('/categories/reorder', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError({ items: 'items array required.' });
  }
  const ids = items.map(x => x.id);
  const orders = items.map(x => x.sort_order);
  await pool.query(
    `UPDATE mocktail_categories m SET sort_order = v.so
     FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
     WHERE m.id = v.id`,
    [ids, orders]
  );
  res.json({ success: true });
}));

// ─── Admin — category management ─────────────────────────────────

/** POST /api/mocktails/categories — create category */
router.post('/categories', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { id, label, sort_order } = req.body;
  const fieldErrors = {};
  if (!id) fieldErrors.id = 'ID is required.';
  if (!label) fieldErrors.label = 'Label is required.';
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  try {
    const result = await pool.query(
      'INSERT INTO mocktail_categories (id, label, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [id, label, sort_order || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      throw new ConflictError('A category with that ID already exists.');
    }
    throw err;
  }
}));

/** PUT /api/mocktails/categories/:id — update category */
router.put('/categories/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { label, sort_order } = req.body;
  const result = await pool.query(
    `UPDATE mocktail_categories SET
      label = COALESCE($1, label),
      sort_order = COALESCE($2, sort_order)
     WHERE id = $3 RETURNING *`,
    [label || null, sort_order ?? null, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Category not found.');
  res.json(result.rows[0]);
}));

/** DELETE /api/mocktails/categories/:id — delete category */
router.delete('/categories/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const check = await pool.query(
    'SELECT COUNT(*) FROM mocktails WHERE category_id = $1',
    [req.params.id]
  );
  if (parseInt(check.rows[0].count) > 0) {
    throw new ConflictError('Cannot delete category — remove or reassign its mocktails first.');
  }
  const result = await pool.query(
    'DELETE FROM mocktail_categories WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Category not found.');
  res.json({ success: true });
}));

// ─── Admin — mocktail management ─────────────────────────────────

/** POST /api/mocktails — create mocktail. `id` optional (server slug, one
 *  `-2` retry); recipe rows validated; is_active honored (off-menu drinks). */
router.post('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { id, name, category_id, emoji, description, sort_order, ingredients, is_active, recipe_review, request_aliases, enhancements, syrup_id, batchable, hosted_visible } = req.body;
  const trimmedName = String(name || '').trim();
  if (!trimmedName || trimmedName.length > 255) {
    throw new ValidationError({ name: 'Name is required (255 characters max).' });
  }

  const { rows: recipeRows } = validateRecipeRows(ingredients);
  const storedRows = recipeRows || [];
  await assertOverridesResolvable(storedRows, pool);
  const review = nextRecipeReview('empty', storedRows, recipe_review) || 'empty';
  const requestAliases = sanitizeRequestAliases(request_aliases);
  const enhancementRows = validateEnhancements(enhancements) || [];
  const syrup = validateSyrupId(syrup_id);

  const serverSlugged = !id;
  const baseSlug = serverSlugged ? normalizeName(trimmedName).replace(/ /g, '-').slice(0, 100) : String(id);
  if (!baseSlug) throw new ValidationError({ name: 'Name must contain letters or numbers.' });
  const attempts = serverSlugged ? [baseSlug, `${baseSlug}-2`] : [baseSlug];

  for (const attemptId of attempts) {
    try {
      const result = await pool.query(
        `INSERT INTO mocktails (id, name, category_id, emoji, description, sort_order, ingredients, is_active, recipe_review, request_aliases, enhancements, syrup_id, batchable, hosted_visible)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [
          attemptId, trimmedName, category_id || null, emoji || null, description || null,
          sort_order || 0, JSON.stringify(storedRows),
          is_active === false ? false : true, review, requestAliases,
          JSON.stringify(enhancementRows), syrup.value,
          batchable === true, hosted_visible === false ? false : true,
        ]
      );
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      if (err.code === '23505' && attemptId !== attempts[attempts.length - 1]) continue;
      if (err.code === '23505') {
        throw new ConflictError(serverSlugged
          ? 'A drink with that name already exists.'
          : 'A mocktail with that ID already exists.');
      }
      throw err;
    }
  }
}));

/** PUT /api/mocktails/:id — update mocktail. Same recipe validation, Menu-tab
 *  "[object Object]" artifact guard, and empty->draft review transition as
 *  the cocktails router. */
router.put('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, category_id, emoji, description, sort_order, is_active, ingredients, recipe_review, enhancements, syrup_id, batchable, hosted_visible } = req.body;
  const enhancementRows = validateEnhancements(enhancements);
  const syrup = validateSyrupId(syrup_id);

  let trimmedName = null;
  if (name !== undefined && name !== null) {
    trimmedName = String(name).trim();
    if (!trimmedName || trimmedName.length > 255) {
      throw new ValidationError({ name: 'Name is required (255 characters max).' });
    }
  }

  const { rows: recipeRows, allArtifacts } = validateRecipeRows(ingredients);
  const effectiveRows = allArtifacts ? null : recipeRows;
  if (effectiveRows) await assertOverridesResolvable(effectiveRows, pool);

  let review = null;
  if (recipe_review !== undefined || effectiveRows) {
    const current = await pool.query('SELECT recipe_review FROM mocktails WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) throw new NotFoundError('Mocktail not found.');
    review = nextRecipeReview(current.rows[0].recipe_review, effectiveRows, recipe_review);
  }

  const result = await pool.query(
    `UPDATE mocktails SET
      name        = COALESCE($1, name),
      category_id = COALESCE($2, category_id),
      emoji       = COALESCE($3, emoji),
      description = COALESCE($4, description),
      sort_order  = COALESCE($5, sort_order),
      is_active   = COALESCE($6, is_active),
      ingredients = COALESCE($7::jsonb, ingredients),
      recipe_review = COALESCE($8, recipe_review),
      enhancements = COALESCE($9::jsonb, enhancements),
      syrup_id    = CASE WHEN $10 THEN $11 ELSE syrup_id END,
      batchable   = COALESCE($12, batchable),
      hosted_visible = COALESCE($13, hosted_visible)
     WHERE id = $14 RETURNING *`,
    [
      trimmedName,
      category_id || null,
      emoji || null,
      description || null,
      sort_order ?? null,
      is_active ?? null,
      effectiveRows ? JSON.stringify(effectiveRows) : null,
      review,
      enhancementRows === null ? null : JSON.stringify(enhancementRows),
      syrup.provided,
      syrup.value,
      typeof batchable === 'boolean' ? batchable : null,
      typeof hosted_visible === 'boolean' ? hosted_visible : null,
      req.params.id,
    ]
  );
  if (!result.rows[0]) throw new NotFoundError('Mocktail not found.');
  res.json(result.rows[0]);
}));

/** DELETE /api/mocktails/:id — soft delete */
router.delete('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'UPDATE mocktails SET is_active = false WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Mocktail not found.');
  res.json({ success: true });
}));

module.exports = router;
