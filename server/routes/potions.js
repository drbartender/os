// Potions (bar program) API: par catalog CRUD + reorder + shopping-list
// preview, plus the shared recipe-row validator the cocktails/mocktails
// routers consume (exported alongside the router, drinkPlanConsult precedent).
// Spec: docs/superpowers/specs/2026-07-09-potions-bar-program-design.md §4.
//
// Mounted at /api/potions on its own prefix so no static path can collide
// with a greedy /:id in another router (proposals mount-order precedent).
const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');
const { buildCatalogSlices, resolveRecipeRow, normalizeName } = require('../utils/potionCatalog');
const { generateShoppingList } = require('../utils/shoppingList');
const { loadCatalog, reportUnresolvedIngredients } = require('../utils/shoppingListGen');

const router = express.Router();

const SECTIONS = ['liquorBeerWine', 'everythingElse'];
const ROLES = ['spirit', 'wine', 'beer', 'mixer', 'garnish', 'supplies'];
const RECIPE_UNITS = ['oz', 'dash', 'each', 'splash'];
const PREVIEW_MODES = ['full_bar', 'spirit_driven'];

function slugify(name) {
  return normalizeName(name).replace(/ /g, '-').slice(0, 100);
}

// ─── Shared recipe-row validation (cocktails.js + mocktails.js import this) ──
// Accepts the structured contract rows AND legacy plain-string rows (the
// frozen Menu tab still round-trips ingredients as CSV strings). Returns the
// normalized array to store, or throws ValidationError naming the bad row.
//
// Menu-tab artifact guard: the frozen CocktailMenuDashboard populates its CSV
// input from row.ingredients.join(...), which stringifies structured rows to
// "[object Object]". Those artifact strings are dropped; if dropping them
// empties a submitted array that WAS all artifacts, the caller must treat
// ingredients as "not provided" (preserve the stored recipe) — signaled by
// returning { rows, allArtifacts: true }.
function validateRecipeRows(rawRows) {
  if (rawRows === undefined || rawRows === null) return { rows: null, allArtifacts: false };
  if (!Array.isArray(rawRows)) {
    throw new ValidationError({ ingredients: 'Ingredients must be an array of recipe rows.' });
  }
  if (rawRows.length > 50) {
    throw new ValidationError({ ingredients: 'A recipe can hold at most 50 rows.' });
  }
  const rows = [];
  let artifactCount = 0;
  rawRows.forEach((row, i) => {
    const label = `ingredients[${i}]`;
    if (typeof row === 'string') {
      const trimmed = row.trim();
      if (!trimmed) return; // dashboard's empty-CSV artifact
      if (trimmed === '[object Object]') { artifactCount += 1; return; }
      if (trimmed.length > 120) {
        throw new ValidationError({ [label]: 'Ingredient name must be 120 characters or fewer.' });
      }
      rows.push(trimmed);
      return;
    }
    if (typeof row !== 'object' || row === null) {
      throw new ValidationError({ [label]: 'Each recipe row must be an object or a string.' });
    }
    const ingredient = String(row.ingredient || '').trim();
    if (!ingredient || ingredient.length > 120) {
      throw new ValidationError({ [label]: 'Each row needs an ingredient name (120 characters max).' });
    }
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError({ [label]: `"${ingredient}" needs a numeric amount greater than 0.` });
    }
    if (!RECIPE_UNITS.includes(row.unit)) {
      throw new ValidationError({ [label]: `"${ingredient}" needs a unit: ${RECIPE_UNITS.join(', ')}.` });
    }
    const note = row.note === undefined || row.note === null ? '' : String(row.note);
    if (note.length > 200) {
      throw new ValidationError({ [label]: 'Note must be 200 characters or fewer.' });
    }
    const overrideId = row.override_item_id ? String(row.override_item_id).slice(0, 100) : null;
    const clean = { ingredient, amount, unit: row.unit };
    if (note) clean.note = note;
    if (overrideId) clean.override_item_id = overrideId;
    rows.push(clean);
  });
  // Any artifact present + nothing real surviving = the Menu tab's CSV
  // round-trip (possibly with stray empty strings); preserve the stored
  // recipe. A deliberate clear ([]) carries no artifacts and passes through.
  const allArtifacts = artifactCount > 0 && rows.length === 0;
  return { rows, allArtifacts };
}

const RECIPE_REVIEW_STATES = ['empty', 'draft', 'reviewed'];

// Resolve the stored recipe_review to its next value for a write carrying
// `rows` (normalized recipe rows, [] = explicit clear, null = not provided)
// and an optional explicit body value. Auto-transition is strictly
// empty -> draft (spec §3.1); editing a reviewed recipe never demotes it.
// Returns null for "no change". Shared by cocktails.js and mocktails.js.
function nextRecipeReview(current, rows, explicit) {
  if (explicit !== undefined && explicit !== null) {
    if (!RECIPE_REVIEW_STATES.includes(explicit)) {
      throw new ValidationError({ recipe_review: `Must be one of: ${RECIPE_REVIEW_STATES.join(', ')}.` });
    }
    return explicit;
  }
  if (rows && rows.length > 0 && current === 'empty') return 'draft';
  if (rows && rows.length === 0) return 'empty';
  return null;
}

// Client-typed request aliases on drinks (Add-recipe flow). Strings only
// (no coercion: '[object Object]' must never become an alias), deduped, cap
// 20 entries post-dedup, 200 chars each (the planner's custom-name cap);
// undefined/null mean "not sent" (house null-tolerant convention).
function sanitizeRequestAliases(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
    throw new ValidationError({ request_aliases: 'Must be an array of at most 20 strings.' });
  }
  const clean = [...new Set(value.map((s) => s.trim().slice(0, 200)).filter(Boolean))];
  if (clean.length > 20) {
    throw new ValidationError({ request_aliases: 'Must be an array of at most 20 strings.' });
  }
  return clean;
}

// Batch-verify every override_item_id references an existing ACTIVE par row.
async function assertOverridesResolvable(rows, dbClient) {
  const overrideIds = [...new Set((rows || [])
    .filter((r) => typeof r === 'object' && r.override_item_id)
    .map((r) => r.override_item_id))];
  if (overrideIds.length === 0) return;
  const found = await dbClient.query(
    'SELECT id FROM par_items WHERE id = ANY($1::text[]) AND is_active = true',
    [overrideIds]
  );
  const ok = new Set(found.rows.map((r) => r.id));
  const missing = overrideIds.filter((id) => !ok.has(id));
  if (missing.length > 0) {
    throw new ValidationError({
      ingredients: `Override item(s) not found in the active par catalog: ${missing.join(', ')}.`,
    });
  }
}

// One pass over every recipe (both tables) resolving each row against the
// live catalog: par id -> [{ id, name, table }]. Serves GET /pars used_by
// and the DELETE reference guard.
async function computeUsedByMap(dbClient) {
  const [parsResult, cocktailsResult, mocktailsResult] = await Promise.all([
    dbClient.query('SELECT * FROM par_items ORDER BY section, sort_order, id'),
    dbClient.query(`SELECT id, name, ingredients FROM cocktails WHERE ingredients IS NOT NULL AND ingredients::text <> '[]'`),
    dbClient.query(`SELECT id, name, ingredients FROM mocktails WHERE ingredients IS NOT NULL AND ingredients::text <> '[]'`),
  ]);
  const catalog = buildCatalogSlices(parsResult.rows);
  const usedBy = new Map();
  const scan = (drinks, table) => {
    for (const drink of drinks) {
      const seen = new Set();
      for (const row of drink.ingredients || []) {
        const resolved = resolveRecipeRow(row, catalog);
        if (!resolved || !resolved.itemId || seen.has(resolved.itemId)) continue;
        seen.add(resolved.itemId);
        if (!usedBy.has(resolved.itemId)) usedBy.set(resolved.itemId, []);
        usedBy.get(resolved.itemId).push({ id: drink.id, name: drink.name, table });
      }
    }
  };
  scan(cocktailsResult.rows, 'cocktails');
  scan(mocktailsResult.rows, 'mocktails');
  return { usedBy, parRows: parsResult.rows };
}

// ─── Pars CRUD ────────────────────────────────────────────────────

/** GET /api/potions/pars — active catalog, each row with used_by drinks */
router.get('/pars', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { usedBy, parRows } = await computeUsedByMap(pool);
  const pars = parRows
    .filter((r) => r.is_active)
    .map((r) => ({ ...r, used_by: usedBy.get(r.id) || [] }));
  res.json({ pars });
}));

function validateParFields(body, { requireCore }) {
  const fieldErrors = {};
  const out = {};
  if (body.item !== undefined || requireCore) {
    const item = String(body.item || '').trim();
    if (!item || item.length > 255) fieldErrors.item = 'Item name is required (255 characters max).';
    else out.item = item;
  }
  if (body.size !== undefined) {
    const size = body.size === null ? null : String(body.size).trim().slice(0, 50);
    out.size = size || null;
  }
  if (body.qty_per_100 !== undefined || requireCore) {
    const qty = Number(body.qty_per_100);
    if (!Number.isFinite(qty) || qty < 0) fieldErrors.qty_per_100 = 'Qty at 100 guests must be a number of 0 or more.';
    else out.qty_per_100 = qty;
  }
  if (body.section !== undefined || requireCore) {
    if (!SECTIONS.includes(body.section)) fieldErrors.section = `Section must be one of: ${SECTIONS.join(', ')}.`;
    else out.section = body.section;
  }
  if (body.role !== undefined || requireCore) {
    if (!ROLES.includes(body.role)) fieldErrors.role = `Role must be one of: ${ROLES.join(', ')}.`;
    else out.role = body.role;
  }
  if (body.spirit_key !== undefined) out.spirit_key = body.spirit_key ? String(body.spirit_key).trim().toLowerCase().slice(0, 30) : null;
  if (body.style_key !== undefined) out.style_key = body.style_key ? String(body.style_key).trim().slice(0, 50) : null;
  for (const key of ['paired_spirits', 'ingredient_aliases']) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key]) || body[key].length > 20) {
      fieldErrors[key] = 'Must be an array of at most 20 short strings.';
      continue;
    }
    out[key] = body[key].map((s) => String(s).trim().toLowerCase().slice(0, 60)).filter(Boolean);
  }
  if (body.in_full_bar !== undefined) out.in_full_bar = body.in_full_bar === true;
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);
  return out;
}

/** POST /api/potions/pars — create a catalog item (server-generated slug id) */
router.post('/pars', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const fields = validateParFields(req.body || {}, { requireCore: true });
  const sortResult = await pool.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM par_items WHERE section = $1',
    [fields.section]
  );
  const sortOrder = Number.isFinite(Number(req.body.sort_order))
    ? Number(req.body.sort_order)
    : sortResult.rows[0].next;

  const baseSlug = slugify(fields.item);
  if (!baseSlug) throw new ValidationError({ item: 'Item name must contain letters or numbers.' });
  const attempts = [baseSlug, `${baseSlug}-2`];
  for (const id of attempts) {
    try {
      const result = await pool.query(
        `INSERT INTO par_items (id, item, size, qty_per_100, section, role, spirit_key, style_key, paired_spirits, ingredient_aliases, in_full_bar, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          id, fields.item, fields.size ?? null, fields.qty_per_100, fields.section, fields.role,
          fields.spirit_key ?? null, fields.style_key ?? null,
          fields.paired_spirits ?? [], fields.ingredient_aliases ?? [],
          fields.in_full_bar ?? false, sortOrder,
        ]
      );
      return res.status(201).json({ par: { ...result.rows[0], used_by: [] } });
    } catch (err) {
      if (err.code === '23505' && id !== attempts[attempts.length - 1]) continue;
      if (err.code === '23505') throw new ConflictError('An item with that name already exists in the catalog.');
      throw err;
    }
  }
}));

/** PUT /api/potions/pars/:id — partial update */
router.put('/pars/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const fields = validateParFields(req.body || {}, { requireCore: false });
  const result = await pool.query(
    `UPDATE par_items SET
       item              = COALESCE($1, item),
       size              = CASE WHEN $2::boolean THEN $3 ELSE size END,
       qty_per_100       = COALESCE($4, qty_per_100),
       section           = COALESCE($5, section),
       role              = COALESCE($6, role),
       spirit_key        = CASE WHEN $7::boolean THEN $8 ELSE spirit_key END,
       style_key         = CASE WHEN $9::boolean THEN $10 ELSE style_key END,
       paired_spirits    = COALESCE($11::text[], paired_spirits),
       ingredient_aliases = COALESCE($12::text[], ingredient_aliases),
       in_full_bar       = COALESCE($13, in_full_bar),
       sort_order        = COALESCE($14, sort_order)
     WHERE id = $15 AND is_active = true
     RETURNING *`,
    [
      fields.item ?? null,
      'size' in fields, fields.size ?? null,
      fields.qty_per_100 ?? null,
      fields.section ?? null,
      fields.role ?? null,
      'spirit_key' in fields, fields.spirit_key ?? null,
      'style_key' in fields, fields.style_key ?? null,
      fields.paired_spirits ?? null,
      fields.ingredient_aliases ?? null,
      fields.in_full_bar ?? null,
      Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : null,
      req.params.id,
    ]
  );
  if (!result.rows[0]) throw new NotFoundError('Catalog item not found.');
  res.json({ par: result.rows[0] });
}));

/** DELETE /api/potions/pars/:id — soft delete; blocked while recipes resolve to it */
router.delete('/pars/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { usedBy } = await computeUsedByMap(pool);
  const refs = usedBy.get(req.params.id) || [];
  if (refs.length > 0) {
    const names = refs.map((d) => d.name).join(', ');
    throw new ConflictError(`Used by: ${names}. Re-point those recipes before removing this item.`);
  }
  const result = await pool.query(
    'UPDATE par_items SET is_active = false WHERE id = $1 AND is_active = true RETURNING id',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Catalog item not found.');
  res.json({ success: true });
}));

/** POST /api/potions/pars/reorder — bulk sort_order (cocktails.js unnest pattern) */
router.post('/pars/reorder', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    throw new ValidationError({ items: 'items array required (500 max).' });
  }
  const ids = items.map((x) => String(x.id));
  const orders = items.map((x) => Number(x.sort_order));
  if (orders.some((n) => !Number.isFinite(n))) {
    throw new ValidationError({ items: 'Every item needs a numeric sort_order.' });
  }
  await pool.query(
    `UPDATE par_items p SET sort_order = v.so
     FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS so) AS v
     WHERE p.id = v.id`,
    [ids, orders]
  );
  res.json({ success: true });
}));

// ─── Preview ──────────────────────────────────────────────────────

/** GET /api/potions/preview?guests=175&mode=full_bar|spirit_driven — run the
 *  generator against the live catalog with a synthetic input. Read-only. */
router.get('/preview', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const guests = Number(req.query.guests);
  if (!Number.isInteger(guests) || guests < 1 || guests > 1000) {
    throw new ValidationError({ guests: 'Guests must be a whole number between 1 and 1000.' });
  }
  const mode = req.query.mode || 'full_bar';
  if (!PREVIEW_MODES.includes(mode)) {
    throw new ValidationError({ mode: `Mode must be one of: ${PREVIEW_MODES.join(', ')}.` });
  }
  const catalog = await loadCatalog(pool);
  const input = mode === 'full_bar'
    ? { clientName: 'Preview', guestCount: guests, serviceStyle: 'full_bar', signatureCocktails: [] }
    : {
        clientName: 'Preview', guestCount: guests, signatureCocktails: [],
        beerSelections: [], wineSelections: [],
        additionalSpirits: catalog ? Object.keys(catalog.spiritPars) : [],
        mixerMode: 'matching',
      };
  const list = generateShoppingList(input, catalog);
  reportUnresolvedIngredients(list, 'potions_preview');
  res.json({ list });
}));

module.exports = router;
module.exports.validateRecipeRows = validateRecipeRows;
module.exports.assertOverridesResolvable = assertOverridesResolvable;
module.exports.nextRecipeReview = nextRecipeReview;
module.exports.sanitizeRequestAliases = sanitizeRequestAliases;
