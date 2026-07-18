// Hosted-coverage context loader for the planner v2 public payload and the
// submit-side fence re-derivation. Bridges the pure coverageEngine to the DB:
// loads par catalog slices, the package's eligible-item union, the
// class->addon gap map, and addon pricing, then exposes per-drink classify.
//
// Callers pass their own db handle (pool OR a held transaction client) so the
// one-connection rule holds inside submit's money transaction.
//
// Plan: docs/superpowers/plans/2026-07-18-potion-planner-v2.md (pp2-planner).
const { buildCatalogSlices } = require('../../utils/potionCatalog');
const { classify, mocktailAddonFor } = require('../../utils/coverageEngine');

/**
 * Load the coverage context for a hosted package.
 * @returns null when the package has no package_items rows (content-readiness
 *   switch: the client renders the legacy hosted flow until contents exist).
 */
async function loadHostedCoverageContext(db, packageId) {
  if (!packageId) return null;
  const itemsRes = await db.query(
    'SELECT eligible_item_ids FROM package_items WHERE package_id = $1',
    [packageId]
  );
  if (itemsRes.rows.length === 0) return null;

  // Sequential on purpose: db may be a HELD transaction client (submit's money
  // path), and pg deprecates — pg@9 will reject — concurrent query() calls on
  // a single client. The pool-handle callers lose only trivial parallelism.
  const parsRes = await db.query('SELECT * FROM par_items WHERE is_active = true ORDER BY section, sort_order, id');
  const classRes = await db.query('SELECT class_key, addon_slug FROM ingredient_class_addons');
  const addonsRes = await db.query('SELECT slug, rate, billing_type FROM service_addons WHERE is_active = true');

  const catalog = buildCatalogSlices(parsRes.rows);
  const eligibleItemIds = new Set(itemsRes.rows.flatMap((r) => r.eligible_item_ids || []));
  const classAddonMap = new Map(classRes.rows.map((r) => [r.class_key, r.addon_slug]));
  const pkgContext = { eligibleItemIds, catalog, classAddonMap, addonPricing: addonsRes.rows };

  return {
    hasContents: true,
    classifyDrink: (drink) => classify(drink, pkgContext),
  };
}

/**
 * Classify every hosted-visible active drink for the public planner payload.
 * Returns the minimal per-drink coverage rows the v2 picker renders; recipe
 * internals (ingredients, missing lists) never leave the server.
 */
async function buildHostedCoveragePayload(db, packageId) {
  const ctx = await loadHostedCoverageContext(db, packageId);
  if (!ctx) return { has_contents: false };

  const [cocktailsRes, mocktailsRes] = await Promise.all([
    db.query('SELECT id, ingredients, batchable FROM cocktails WHERE is_active = true AND hosted_visible = true'),
    db.query('SELECT id, ingredients, batchable FROM mocktails WHERE is_active = true AND hosted_visible = true'),
  ]);

  const rows = [];
  for (const [table, list] of [['cocktails', cocktailsRes.rows], ['mocktails', mocktailsRes.rows]]) {
    for (const drink of list) {
      const verdict = ctx.classifyDrink(drink);
      if (verdict.status === 'unmakeable' || verdict.status === 'no_recipe') {
        // The hosted picker hides these; the admin makeability panel is where
        // they surface. Omitting them keeps the public payload lean.
        continue;
      }
      rows.push({
        id: drink.id,
        table,
        status: verdict.status,
        gap_per_guest: verdict.gapPerGuest,
        gap_addon_slugs: verdict.gapAddonSlugs,
        batchable: drink.batchable === true,
      });
    }
  }
  return { has_contents: true, drinks: rows };
}

module.exports = { loadHostedCoverageContext, buildHostedCoveragePayload, mocktailAddonFor };
