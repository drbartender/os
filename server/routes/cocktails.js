const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicReadLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { validateRecipeRows, assertOverridesResolvable, nextRecipeReview, sanitizeRequestAliases, validateEnhancements, validateSyrupId } = require('./potions');
const { normalizeName } = require('../utils/potionCatalog');

const router = express.Router();

// Explicit public column list: recipe_review is internal workflow state and
// never ships to the unauthenticated planner. `ingredients` stays public by
// accepted spec decision (§4: matches the menu's ingredient-gist descriptions
// and powers bartender prep on shift pages).
const PUBLIC_COCKTAIL_COLUMNS = `c.id, c.name, c.category_id, c.emoji, c.description,
       c.sort_order, c.is_active, c.created_at, c.updated_at, c.base_spirit,
       c.ingredients, c.upgrade_addon_slugs`;

// ─── Public routes ────────────────────────────────────────────────

/** GET /api/cocktails — active cocktails with category info (for client questionnaire) */
router.get('/', publicReadLimiter, asyncHandler(async (req, res) => {
  const [catsResult, cocktailsResult] = await Promise.all([
    pool.query('SELECT * FROM cocktail_categories ORDER BY sort_order'),
    pool.query(
      `SELECT ${PUBLIC_COCKTAIL_COLUMNS}, cc.label AS category_label, cc.sort_order AS category_sort_order
       FROM cocktails c
       LEFT JOIN cocktail_categories cc ON cc.id = c.category_id
       WHERE c.is_active = true
       ORDER BY cc.sort_order, c.sort_order`
    ),
  ]);
  res.json({ categories: catsResult.rows, cocktails: cocktailsResult.rows });
}));

/** GET /api/cocktails/admin — all cocktails including inactive (admin) */
router.get('/admin', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
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
}));

/** GET /api/cocktails/categories — all categories (public) */
router.get('/categories', publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM cocktail_categories ORDER BY sort_order');
  res.json(result.rows);
}));

// ─── Admin — bulk reorder ─────────────────────────────────────────

/** POST /api/cocktails/reorder — bulk update sort_order for cocktails */
router.post('/reorder', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { items } = req.body; // [{ id, sort_order }, ...]
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError({ items: 'items array required.' });
  }
  const ids = items.map(x => x.id);
  const orders = items.map(x => x.sort_order);
  await pool.query(
    `UPDATE cocktails c SET sort_order = v.so
     FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
     WHERE c.id = v.id`,
    [ids, orders]
  );
  res.json({ success: true });
}));

/** POST /api/cocktails/categories/reorder — bulk update sort_order for categories */
router.post('/categories/reorder', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError({ items: 'items array required.' });
  }
  const ids = items.map(x => x.id);
  const orders = items.map(x => x.sort_order);
  await pool.query(
    `UPDATE cocktail_categories c SET sort_order = v.so
     FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
     WHERE c.id = v.id`,
    [ids, orders]
  );
  res.json({ success: true });
}));

// ─── Admin — category management ─────────────────────────────────

/** POST /api/cocktails/categories — create category */
router.post('/categories', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { id, label, sort_order } = req.body;
  const fieldErrors = {};
  if (!id) fieldErrors.id = 'ID is required.';
  if (!label) fieldErrors.label = 'Label is required.';
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  try {
    const result = await pool.query(
      'INSERT INTO cocktail_categories (id, label, sort_order) VALUES ($1, $2, $3) RETURNING *',
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

/** PUT /api/cocktails/categories/:id — update category */
router.put('/categories/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { label, sort_order } = req.body;
  const result = await pool.query(
    `UPDATE cocktail_categories SET
      label = COALESCE($1, label),
      sort_order = COALESCE($2, sort_order)
     WHERE id = $3 RETURNING *`,
    [label || null, sort_order ?? null, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Category not found.');
  res.json(result.rows[0]);
}));

/** DELETE /api/cocktails/categories/:id — delete category (blocked if cocktails reference it) */
router.delete('/categories/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const check = await pool.query(
    'SELECT COUNT(*) FROM cocktails WHERE category_id = $1',
    [req.params.id]
  );
  if (parseInt(check.rows[0].count) > 0) {
    throw new ConflictError('Cannot delete category — remove or reassign its cocktails first.');
  }
  const result = await pool.query(
    'DELETE FROM cocktail_categories WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Category not found.');
  res.json({ success: true });
}));

// ─── Admin — cocktail management ─────────────────────────────────

/** POST /api/cocktails — create cocktail. `id` is optional (server slugs it
 *  from the name; one `-2` retry on collision). `is_active: false` creates an
 *  off-menu drink — the needs-recipe Add-recipe path (spec §5). */
router.post('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { id, name, category_id, emoji, description, sort_order, base_spirit, ingredients, upgrade_addon_slugs, is_active, recipe_review, request_aliases, enhancements, syrup_id, batchable, hosted_visible } = req.body;
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
        `INSERT INTO cocktails (id, name, category_id, emoji, description, sort_order, base_spirit, ingredients, upgrade_addon_slugs, is_active, recipe_review, request_aliases, enhancements, syrup_id, batchable, hosted_visible)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
        [
          attemptId, trimmedName, category_id || null, emoji || null, description || null,
          sort_order || 0, base_spirit || null, JSON.stringify(storedRows),
          Array.isArray(upgrade_addon_slugs) ? upgrade_addon_slugs : [],
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
          : 'A cocktail with that ID already exists.');
      }
      throw err;
    }
  }
}));

/** PUT /api/cocktails/:id — update cocktail. Structured recipe rows are
 *  validated; the frozen Menu tab's "[object Object]" CSV artifact is treated
 *  as "ingredients not provided" so a Menu-tab edit can never destroy a
 *  structured recipe. Review transitions: explicit recipe_review (enum) wins;
 *  otherwise a recipe write auto-flips empty -> draft only. */
router.put('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, category_id, emoji, description, sort_order, is_active, base_spirit, ingredients, upgrade_addon_slugs, recipe_review, enhancements, syrup_id, batchable, hosted_visible } = req.body;
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
    const current = await pool.query('SELECT recipe_review FROM cocktails WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) throw new NotFoundError('Cocktail not found.');
    review = nextRecipeReview(current.rows[0].recipe_review, effectiveRows, recipe_review);
  }

  const result = await pool.query(
    `UPDATE cocktails SET
      name        = COALESCE($1, name),
      category_id = COALESCE($2, category_id),
      emoji       = COALESCE($3, emoji),
      description = COALESCE($4, description),
      sort_order  = COALESCE($5, sort_order),
      is_active   = COALESCE($6, is_active),
      base_spirit = COALESCE($7, base_spirit),
      ingredients = COALESCE($8::jsonb, ingredients),
      upgrade_addon_slugs = COALESCE($9::text[], upgrade_addon_slugs),
      recipe_review = COALESCE($10, recipe_review),
      enhancements = COALESCE($11::jsonb, enhancements),
      syrup_id    = CASE WHEN $12 THEN $13 ELSE syrup_id END,
      batchable   = COALESCE($14, batchable),
      hosted_visible = COALESCE($15, hosted_visible)
     WHERE id = $16 RETURNING *`,
    [
      trimmedName,
      category_id || null,
      emoji || null,
      description || null,
      sort_order ?? null,
      is_active ?? null,
      base_spirit || null,
      effectiveRows ? JSON.stringify(effectiveRows) : null,
      Array.isArray(upgrade_addon_slugs) ? upgrade_addon_slugs : null,
      review,
      enhancementRows === null ? null : JSON.stringify(enhancementRows),
      syrup.provided,
      syrup.value,
      typeof batchable === 'boolean' ? batchable : null,
      typeof hosted_visible === 'boolean' ? hosted_visible : null,
      req.params.id,
    ]
  );
  if (!result.rows[0]) throw new NotFoundError('Cocktail not found.');
  res.json(result.rows[0]);
}));

/** DELETE /api/cocktails/:id — soft delete (sets is_active = false) */
router.delete('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'UPDATE cocktails SET is_active = false WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Cocktail not found.');
  res.json({ success: true });
}));

module.exports = router;
