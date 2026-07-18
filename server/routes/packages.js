// Admin package-model API (potion planner v2, lane pp2-core): structured
// package contents (package_items category pars with split-par eligible
// bottles), signature-slot config, the makeability preview, and the
// DIRECTIONAL margin sketch. Pricing that bills clients lives in
// pricingEngine/proposals — nothing here touches money paths.
//
// Mounted at /api/admin/packages (server/index.js).
// Spec: docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md §4.3/§6.2/§6.3.
const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { buildCatalogSlices } = require('../utils/potionCatalog');
const { classify } = require('../utils/coverageEngine');

const router = express.Router();
router.use(auth, requireAdminOrManager);

const SLOT_KINDS = ['hard', 'featured'];

function validateItemBody(body) {
  const category = String(body.category || '').trim();
  if (!category || category.length > 100) {
    throw new ValidationError({ category: 'Category is required (100 characters max).' });
  }
  const par = Number(body.par_per_100);
  if (!Number.isFinite(par) || par < 0) {
    throw new ValidationError({ par_per_100: 'Par per 100 guests must be a number >= 0.' });
  }
  const unit = String(body.unit || 'btl').trim().slice(0, 50) || 'btl';
  const ids = body.eligible_item_ids;
  if (!Array.isArray(ids) || ids.some((s) => typeof s !== 'string' || !s.trim() || s.length > 100)) {
    throw new ValidationError({ eligible_item_ids: 'Must be an array of par-item id strings.' });
  }
  const eligible = [...new Set(ids.map((s) => s.trim()))];
  if (eligible.length > 25) {
    throw new ValidationError({ eligible_item_ids: 'At most 25 eligible bottles per category.' });
  }
  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;
  return { category, par, unit, eligible, sortOrder };
}

async function assertParItemsExist(ids) {
  if (ids.length === 0) return;
  const found = await pool.query('SELECT id FROM par_items WHERE id = ANY($1::text[])', [ids]);
  const ok = new Set(found.rows.map((r) => r.id));
  const missing = ids.filter((id) => !ok.has(id));
  if (missing.length > 0) {
    throw new ValidationError({ eligible_item_ids: `Not in the par catalog: ${missing.join(', ')}.` });
  }
}

async function getPackageOr404(id) {
  const result = await pool.query('SELECT * FROM service_packages WHERE id = $1', [id]);
  if (!result.rows[0]) throw new NotFoundError('Package not found.');
  return result.rows[0];
}

// ─── Package list + detail ───────────────────────────────────────

/** GET /api/admin/packages — the ladder, retired included, with item counts. */
router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT sp.*, COALESCE(pi.item_count, 0)::int AS item_count
    FROM service_packages sp
    LEFT JOIN (
      SELECT package_id, COUNT(*) AS item_count FROM package_items GROUP BY package_id
    ) pi ON pi.package_id = sp.id
    ORDER BY sp.category, sp.sort_order, sp.id
  `);
  res.json(result.rows);
}));

/** GET /api/admin/packages/:id — package + its contents rows. */
router.get('/:id(\\d+)', asyncHandler(async (req, res) => {
  const pkg = await getPackageOr404(req.params.id);
  const items = await pool.query(
    'SELECT * FROM package_items WHERE package_id = $1 ORDER BY sort_order, id',
    [req.params.id]
  );
  res.json({ ...pkg, items: items.rows });
}));

/** PUT /api/admin/packages/:id — slots config + active flag ONLY. Pricing
 *  columns stay admin-dashboard/SQL territory; this surface is contents. */
router.put('/:id(\\d+)', asyncHandler(async (req, res) => {
  const { slot_count, slot_kind, is_active } = req.body;
  // Provided-key semantics (fleet finding, database-review): an absent key
  // keeps the stored value; only an explicitly-present key writes, and an
  // explicit null clears. Otherwise a partial PUT (e.g. retiring a package
  // with is_active only) would silently wipe the slot config.
  const slotCountProvided = Object.prototype.hasOwnProperty.call(req.body, 'slot_count');
  const slotKindProvided = Object.prototype.hasOwnProperty.call(req.body, 'slot_kind');
  if (slotKindProvided && slot_kind !== null && !SLOT_KINDS.includes(slot_kind)) {
    throw new ValidationError({ slot_kind: `Must be one of: ${SLOT_KINDS.join(', ')} (or null).` });
  }
  let slotCount = null;
  if (slotCountProvided && slot_count !== null) {
    slotCount = Number(slot_count);
    if (!Number.isInteger(slotCount) || slotCount < 0 || slotCount > 10) {
      throw new ValidationError({ slot_count: 'Must be an integer between 0 and 10 (or null).' });
    }
  }
  const result = await pool.query(
    `UPDATE service_packages SET
       slot_count = CASE WHEN $1 THEN $2::integer ELSE slot_count END,
       slot_kind  = CASE WHEN $3 THEN $4 ELSE slot_kind END,
       is_active  = COALESCE($5, is_active)
     WHERE id = $6 RETURNING *`,
    [slotCountProvided, slotCount, slotKindProvided, slot_kind || null, is_active ?? null, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Package not found.');
  res.json(result.rows[0]);
}));

// ─── Contents rows (category pars with split-par eligible bottles) ───

/** POST /api/admin/packages/:id/items */
router.post('/:id(\\d+)/items', asyncHandler(async (req, res) => {
  await getPackageOr404(req.params.id);
  const { category, par, unit, eligible, sortOrder } = validateItemBody(req.body);
  await assertParItemsExist(eligible);
  const result = await pool.query(
    `INSERT INTO package_items (package_id, category, par_per_100, unit, eligible_item_ids, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.params.id, category, par, unit, eligible, sortOrder]
  );
  res.status(201).json(result.rows[0]);
}));

/** PUT /api/admin/packages/:id/items/:itemId */
router.put('/:id(\\d+)/items/:itemId(\\d+)', asyncHandler(async (req, res) => {
  const { category, par, unit, eligible, sortOrder } = validateItemBody(req.body);
  await assertParItemsExist(eligible);
  const result = await pool.query(
    `UPDATE package_items SET category = $1, par_per_100 = $2, unit = $3,
       eligible_item_ids = $4, sort_order = $5
     WHERE id = $6 AND package_id = $7 RETURNING *`,
    [category, par, unit, eligible, sortOrder, req.params.itemId, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Package item not found.');
  res.json(result.rows[0]);
}));

/** DELETE /api/admin/packages/:id/items/:itemId */
router.delete('/:id(\\d+)/items/:itemId(\\d+)', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM package_items WHERE id = $1 AND package_id = $2 RETURNING id',
    [req.params.itemId, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Package item not found.');
  res.json({ success: true });
}));

// ─── Makeability preview ─────────────────────────────────────────

/** GET /api/admin/packages/:id/makeability — every active drink classified
 *  against the package: covered / fenced (+$/guest) / unmakeable / no_recipe.
 *  Recomputed live by the editor after any contents or recipe edit. */
router.get('/:id(\\d+)/makeability', asyncHandler(async (req, res) => {
  await getPackageOr404(req.params.id);
  const [parsRes, itemsRes, classRes, addonsRes, cocktailsRes, mocktailsRes] = await Promise.all([
    pool.query('SELECT * FROM par_items WHERE is_active = true ORDER BY section, sort_order, id'),
    pool.query('SELECT eligible_item_ids FROM package_items WHERE package_id = $1', [req.params.id]),
    pool.query('SELECT class_key, addon_slug FROM ingredient_class_addons'),
    pool.query('SELECT slug, rate, billing_type FROM service_addons WHERE is_active = true'),
    pool.query('SELECT id, name, ingredients, hosted_visible FROM cocktails WHERE is_active = true ORDER BY name'),
    pool.query('SELECT id, name, ingredients, hosted_visible FROM mocktails WHERE is_active = true ORDER BY name'),
  ]);

  const catalog = buildCatalogSlices(parsRes.rows);
  const eligibleItemIds = new Set(itemsRes.rows.flatMap((r) => r.eligible_item_ids || []));
  const classAddonMap = new Map(classRes.rows.map((r) => [r.class_key, r.addon_slug]));
  const pkgContext = { eligibleItemIds, catalog, classAddonMap, addonPricing: addonsRes.rows };

  const drinks = [
    ...cocktailsRes.rows.map((d) => ({ ...d, table: 'cocktails' })),
    ...mocktailsRes.rows.map((d) => ({ ...d, table: 'mocktails' })),
  ];
  const results = drinks.map((drink) => {
    const verdict = classify(drink, pkgContext);
    return {
      id: drink.id,
      name: drink.name,
      table: drink.table,
      hosted_visible: drink.hosted_visible,
      status: verdict.status,
      gap_classes: verdict.gapClasses,
      gap_addon_slugs: verdict.gapAddonSlugs,
      gap_per_guest: verdict.gapPerGuest,
      missing: verdict.missing,
    };
  });

  const counts = { covered: 0, fenced: 0, unmakeable: 0, no_recipe: 0 };
  for (const r of results) counts[r.status] += 1;
  res.json({ counts, drinks: results });
}));

// ─── Directional margin sketch ───────────────────────────────────

/** GET /api/admin/packages/:id/margin?guests=&hours=&labor=&supplies=
 *  Directional, not accounting: retires the pricing spreadsheet, never bills
 *  anyone. Revenue uses the package's own per-guest rates; liquor cost uses
 *  category pars x the MEAN cost of eligible bottles (split pars share the
 *  category volume, so extra "for show" labels never multiply cost). */
router.get('/:id(\\d+)/margin', asyncHandler(async (req, res) => {
  const pkg = await getPackageOr404(req.params.id);
  const guests = Math.max(1, Number(req.query.guests) || 100);
  const hours = Math.max(1, Number(req.query.hours) || 4);

  // Knob defaults live in settings (margin_labor_rate, margin_supplies_per_guest);
  // explicit query params override for the editor's what-if sliders.
  const settingsRes = await pool.query(
    "SELECT key, value FROM app_settings WHERE key IN ('margin_labor_rate', 'margin_supplies_per_guest')"
  );
  const settings = Object.fromEntries(settingsRes.rows.map((r) => [r.key, Number(r.value)]));
  const laborRate = Math.max(0, Number(req.query.labor) || settings.margin_labor_rate || 35);
  const suppliesPerGuest = Math.max(0, Number(req.query.supplies) || settings.margin_supplies_per_guest || 1.25);

  // Revenue (dollars; hosted per_guest model — flat packages get base rate).
  // Small-event threshold keys on the package's own min_guests, matching
  // pricingEngine's isSmall (fleet finding: hardcoded 50 diverges if a
  // package's min_guests ever changes).
  const small = !!pkg.min_guests && guests < Number(pkg.min_guests);
  let revenue;
  if (pkg.pricing_type === 'per_guest') {
    const base = Number((small ? pkg.base_rate_4hr_small : pkg.base_rate_4hr)
      ?? (small ? pkg.base_rate_4hr : pkg.base_rate_4hr_small)) || 0;
    const extra = Math.max(0, hours - 4) * (Number(pkg.extra_hour_rate) || 0);
    const billedGuests = Math.max(guests, Number(pkg.min_billed_guests) || 0);
    revenue = (base + extra) * billedGuests;
    if (pkg.min_total) revenue = Math.max(revenue, Number(pkg.min_total));
  } else {
    revenue = Number(pkg.base_rate_4hr ?? pkg.base_rate_3hr) || 0;
  }

  // Liquor & bottles cost from contents rows x par costs.
  const [itemsRes, parsRes] = await Promise.all([
    pool.query('SELECT * FROM package_items WHERE package_id = $1', [req.params.id]),
    pool.query('SELECT id, cost FROM par_items'),
  ]);
  const costById = new Map(parsRes.rows.map((r) => [r.id, r.cost === null ? null : Number(r.cost)]));
  let liquorCost = 0;
  let missingCosts = 0;
  for (const item of itemsRes.rows) {
    const costs = (item.eligible_item_ids || [])
      .map((id) => costById.get(id))
      .filter((c) => c !== null && c !== undefined && Number.isFinite(c));
    missingCosts += (item.eligible_item_ids || []).length - costs.length;
    if (costs.length === 0) continue;
    const meanCost = costs.reduce((s, c) => s + c, 0) / costs.length;
    liquorCost += Number(item.par_per_100) * (guests / 100) * meanCost;
  }

  const suppliesCost = suppliesPerGuest * guests;
  const bartenders = Math.max(1, Math.ceil(guests / (Number(pkg.guests_per_bartender) || 100)));
  const laborCost = bartenders * (hours + 2) * laborRate; // +2h setup/breakdown
  const totalCost = liquorCost + suppliesCost + laborCost;
  const margin = revenue - totalCost;

  res.json({
    directional: true,
    inputs: { guests, hours, labor_rate: laborRate, supplies_per_guest: suppliesPerGuest, bartenders },
    revenue: Math.round(revenue),
    liquor_cost: Math.round(liquorCost),
    supplies_cost: Math.round(suppliesCost),
    labor_cost: Math.round(laborCost),
    total_cost: Math.round(totalCost),
    margin: Math.round(margin),
    margin_pct: revenue > 0 ? Math.round((margin / revenue) * 100) : null,
    missing_costs: missingCosts,
  });
}));

module.exports = router;
