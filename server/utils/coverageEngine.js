// Coverage engine: can a package pour a drink, and if not, what does the gap
// cost? Pure functions, no DB — callers load par_items (catalog slices via
// potionCatalog.buildCatalogSlices), package_items rows, ingredient_class_addons
// rows, and addon pricing, and pass them in.
//
// Spec: docs/superpowers/specs/2026-07-18-potion-planner-v2-design.md §4.3.
// Plan: docs/superpowers/plans/2026-07-18-potion-planner-v2.md (pp2-core).
//
// Statuses:
//   'covered'    every recipe ingredient resolves to a package-eligible item
//   'fenced'     every gap ingredient maps to a priced add-on class
//   'unmakeable' at least one gap ingredient has no priced class (e.g. a
//                spirit the package lacks with no add-on that supplies it)
//   'no_recipe'  the drink has no recipe rows to classify
// The planner's hosted picker shows covered in-tier, fenced with the price
// badge, and hides unmakeable; the admin makeability panel shows all four.

const { normalizeName, resolveRecipeRow } = require('./potionCatalog');

// A class key is snake_case ('coffee_liqueur'); derive candidates for an
// ingredient in priority order: the resolved par row's spirit/style keys and
// id, then the normalized names. First candidate present in the class map wins.
function classCandidates(row, resolved, catalog) {
  const candidates = [];
  if (resolved && catalog && catalog.byId) {
    const parRow = catalog.byId.get(resolved.itemId);
    if (parRow) {
      if (parRow.spirit_key) candidates.push(toClassKey(parRow.spirit_key));
      if (parRow.style_key) candidates.push(toClassKey(parRow.style_key));
      candidates.push(parRow.id);
      candidates.push(toClassKey(parRow.item));
    }
  }
  const rawName = typeof row === 'string' ? row : (row && row.ingredient) || '';
  const nameKey = toClassKey(rawName);
  if (nameKey) candidates.push(nameKey);
  return [...new Set(candidates.filter(Boolean))];
}

function toClassKey(value) {
  return normalizeName(value).replace(/ /g, '_');
}

/**
 * Classify one drink against a package's contents.
 * @param {object} drink       { ingredients: [] } (structured rows or strings)
 * @param {object} pkg         {
 *   eligibleItemIds: string[] | Set  — union of package_items.eligible_item_ids
 *   catalog:        potionCatalog.buildCatalogSlices output
 *   classAddonMap:  Map(class_key -> addon_slug) | plain object
 *   addonPricing:   [{ slug, rate, billing_type }]
 * }
 * @returns { status, gapClasses: [], gapAddonSlugs: [], gapPerGuest: number|null,
 *            missing: [] }  — gapPerGuest is null when status is not 'fenced'.
 */
function classify(drink, pkg) {
  const rows = Array.isArray(drink && drink.ingredients) ? drink.ingredients : [];
  const realRows = rows.filter((r) => r !== null && r !== undefined && String(typeof r === 'string' ? r : r.ingredient || '').trim() !== '');
  if (realRows.length === 0) {
    return { status: 'no_recipe', gapClasses: [], gapAddonSlugs: [], gapPerGuest: null, missing: [] };
  }

  const eligible = pkg.eligibleItemIds instanceof Set
    ? pkg.eligibleItemIds
    : new Set(pkg.eligibleItemIds || []);
  const classMap = pkg.classAddonMap instanceof Map
    ? pkg.classAddonMap
    : new Map(Object.entries(pkg.classAddonMap || {}));

  const gapClasses = [];
  const gapAddonSlugs = [];
  const missing = [];

  for (const row of realRows) {
    const resolved = resolveRecipeRow(row, pkg.catalog);
    if (resolved && eligible.has(resolved.itemId)) continue; // covered ingredient

    const candidates = classCandidates(row, resolved, pkg.catalog);
    const hit = candidates.find((c) => classMap.has(c));
    if (hit) {
      if (!gapClasses.includes(hit)) gapClasses.push(hit);
      const slug = classMap.get(hit);
      if (!gapAddonSlugs.includes(slug)) gapAddonSlugs.push(slug);
    } else {
      const rawName = typeof row === 'string' ? row : row.ingredient;
      missing.push(String(rawName).trim());
    }
  }

  if (missing.length > 0) {
    return { status: 'unmakeable', gapClasses, gapAddonSlugs, gapPerGuest: null, missing };
  }
  if (gapAddonSlugs.length === 0) {
    return { status: 'covered', gapClasses: [], gapAddonSlugs: [], gapPerGuest: null, missing: [] };
  }

  let perGuest = 0;
  for (const slug of gapAddonSlugs) {
    const pricing = (pkg.addonPricing || []).find((a) => a.slug === slug);
    if (pricing && pricing.billing_type === 'per_guest') perGuest += Number(pricing.rate) || 0;
  }
  return { status: 'fenced', gapClasses, gapAddonSlugs, gapPerGuest: perGuest, missing: [] };
}

/**
 * The Jack rule (spec §3.2): on a hosted package that does not include
 * mocktails, ONE picked flavor rides the pre-batched add-on; two or more
 * flips to the full Mocktail Bar. Money logic — the server re-derives this
 * at submit and never trusts the client's addOns.
 */
function mocktailAddonFor(count) {
  const n = Number(count) || 0;
  if (n <= 0) return null;
  if (n === 1) return 'pre-batched-mocktail';
  return 'mocktail-bar';
}

module.exports = { classify, mocktailAddonFor, toClassKey };
