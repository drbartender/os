// Potion catalog: derives every legacy shopping-list constant (PARS_100,
// SPIRIT_PARS, beer/wine style maps, BASIC_MIXERS, GARNISHES, ALWAYS_INCLUDE,
// SPIRIT_MIXER_PAIRINGS, INGREDIENT_MAP) as a slice of the ONE par_items
// catalog, and resolves recipe/free-text ingredient names to purchasable
// items through per-row aliases.
//
// Pure functions, no DB calls — callers (shoppingListGen.js, the potions
// routes) load `SELECT * FROM par_items WHERE is_active = true ORDER BY
// section, sort_order, id` and pass the rows in. Parity with the legacy
// constants is enforced by potionCatalog.test.js; do not change slice
// derivation rules without running it.
//
// Spec: docs/superpowers/specs/2026-07-09-potions-bar-program-design.md

// Normalize a name for alias / custom-drink matching: lowercase, trim,
// collapse whitespace, strip everything but letters/digits/spaces.
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Slice rows carry EXACTLY the legacy row shape { item, size, qty } so the
// parity test can deep-equal against the shoppingList.js constants.
function toSliceRow(row) {
  return { item: row.item, size: row.size, qty: Number(row.qty_per_100) };
}

/**
 * Build the catalog object from active par_items rows.
 * @param {Array} parRows rows of par_items (is_active filtering is honored
 *   here too, so callers may pass unfiltered rows)
 * @returns catalog: { pars100, spiritPars, beerStyleMap, wineStyleMap,
 *   basicMixers, garnishes, alwaysInclude, spiritMixerPairings,
 *   pairableItems, aliasIndex, byId, isEmpty }
 */
function buildCatalogSlices(parRows) {
  const rows = (parRows || [])
    .filter((r) => r.is_active !== false)
    .slice()
    .sort((a, b) =>
      a.section === b.section
        ? (a.sort_order - b.sort_order) || String(a.id).localeCompare(String(b.id))
        : String(a.section).localeCompare(String(b.section))
    );

  const bySection = { liquorBeerWine: [], everythingElse: [] };
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, row);
    if (bySection[row.section]) bySection[row.section].push(row);
  }

  // PARS_100 = in_full_bar rows, per section, in seed order.
  const pars100 = {
    liquorBeerWine: bySection.liquorBeerWine.filter((r) => r.in_full_bar).map(toSliceRow),
    everythingElse: bySection.everythingElse.filter((r) => r.in_full_bar).map(toSliceRow),
  };

  // SPIRIT_PARS = spirit rows keyed by spirit_key; legacy duplicated bourbon
  // under 'whiskey' (SPIRIT_PARS comment in shoppingList.js), preserved here.
  const spiritPars = {};
  for (const row of rows) {
    if (row.role === 'spirit' && row.spirit_key) spiritPars[row.spirit_key] = toSliceRow(row);
  }
  if (spiritPars.bourbon && !spiritPars.whiskey) spiritPars.whiskey = { ...spiritPars.bourbon };

  // Beer / wine style maps = beer/wine rows grouped by style_key, in order.
  const beerStyleMap = {};
  const wineStyleMap = {};
  for (const row of rows) {
    if (!row.style_key) continue;
    const map = row.role === 'beer' ? beerStyleMap : row.role === 'wine' ? wineStyleMap : null;
    if (!map) continue;
    if (!map[row.style_key]) map[row.style_key] = [];
    map[row.style_key].push(toSliceRow(row));
  }

  // Role slices (everythingElse order = seed order = legacy array order).
  // in_full_bar distinguishes the legacy baseline members from alias-only
  // rows (ginger-beer etc.), which legacy BASIC_MIXERS never contained.
  const basicMixers = bySection.everythingElse
    .filter((r) => r.role === 'mixer' && r.in_full_bar).map(toSliceRow);
  const garnishes = bySection.everythingElse
    .filter((r) => r.role === 'garnish' && r.in_full_bar).map(toSliceRow);
  const alwaysInclude = bySection.everythingElse
    .filter((r) => r.role === 'supplies' && r.in_full_bar).map(toSliceRow);

  // SPIRIT_MIXER_PAIRINGS inverted from paired_spirits tags. Per-spirit
  // mixer ORDER follows catalog row order (mixers then garnishes) — the one
  // accepted output delta vs the legacy hand-ordered arrays (spec goal 6).
  const spiritMixerPairings = {};
  const pairingSource = bySection.everythingElse.filter(
    (r) => (r.role === 'mixer' || r.role === 'garnish') && Array.isArray(r.paired_spirits)
  );
  for (const row of pairingSource) {
    for (const spirit of row.paired_spirits) {
      if (!spiritMixerPairings[spirit]) spiritMixerPairings[spirit] = [];
      spiritMixerPairings[spirit].push(row.item);
    }
  }

  // ALL active mixer/garnish rows as slice rows, for matching-mixers lookup.
  // The baseline basicMixers/garnishes slices are in_full_bar-filtered, so a
  // paired row outside the full-bar baseline was silently dropped by
  // addMatchingMixers (push-time second-opinion finding 4). Pairings decide
  // membership; this slice supplies the row data.
  const pairableItems = bySection.everythingElse
    .filter((r) => r.role === 'mixer' || r.role === 'garnish').map(toSliceRow);

  // Alias index, longest alias first, so specific names beat generic
  // substrings ("ginger beer" beats "gin", "diet coke" beats "coke").
  const aliasIndex = [];
  for (const row of rows) {
    for (const alias of row.ingredient_aliases || []) {
      const norm = normalizeName(alias);
      if (!norm) continue;
      aliasIndex.push({ alias: norm, itemId: row.id, item: row.item, size: row.size, section: row.section });
    }
  }
  aliasIndex.sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));

  return {
    pars100,
    spiritPars,
    beerStyleMap,
    wineStyleMap,
    basicMixers,
    garnishes,
    alwaysInclude,
    spiritMixerPairings,
    pairableItems,
    aliasIndex,
    byId,
    isEmpty: rows.length === 0,
  };
}

/**
 * Resolve a free-text ingredient name to a purchasable catalog item.
 * Exact normalized alias match first, then longest-alias substring fallback
 * (preserves legacy INGREDIENT_MAP `includes` behavior). Never fuzzy.
 * @returns { itemId, item, size, section } | null
 */
function resolveIngredient(name, catalog) {
  const norm = normalizeName(name);
  if (!norm || !catalog || !catalog.aliasIndex) return null;
  for (const entry of catalog.aliasIndex) {
    if (entry.alias === norm) {
      return { itemId: entry.itemId, item: entry.item, size: entry.size, section: entry.section };
    }
  }
  // Substring fallback (compound free text). English names its base LAST
  // ("cherry vodka" is a vodka), so among substring hits prefer one whose
  // alias contains the final token; otherwise longest-alias-first. Without
  // the head-noun preference, "cherry vodka" would resolve to the cherries
  // row ('cherry', 6 chars) instead of the vodka row ('vodka', 5 chars) —
  // a silently wrong bottle, the one outcome this module must never produce.
  // This also preserves legacy insertion-order semantics on the known
  // divergences ('whiskey sour' -> Sour Mix, flavored spirits -> the spirit).
  const lastToken = norm.split(' ').pop();
  let fallback = null;
  for (const entry of catalog.aliasIndex) {
    if (!norm.includes(entry.alias)) continue;
    if (entry.alias.split(' ').includes(lastToken)) {
      return { itemId: entry.itemId, item: entry.item, size: entry.size, section: entry.section };
    }
    if (!fallback) fallback = entry;
  }
  if (fallback) {
    return { itemId: fallback.itemId, item: fallback.item, size: fallback.size, section: fallback.section };
  }
  return null;
}

/**
 * Resolve one recipe row (structured object or legacy plain string).
 * Override wins when it points at an ACTIVE catalog row; a missing or
 * inactive override falls through to alias resolution (never a silent drop,
 * never a resurrected item). @returns { itemId, item, size, section } | null
 */
function resolveRecipeRow(row, catalog) {
  if (row === null || row === undefined) return null;
  if (typeof row === 'string') return resolveIngredient(row, catalog);
  if (row.override_item_id && catalog && catalog.byId) {
    const target = catalog.byId.get(row.override_item_id);
    if (target && target.is_active !== false) {
      return { itemId: target.id, item: target.item, size: target.size, section: target.section };
    }
  }
  return resolveIngredient(row.ingredient, catalog);
}

module.exports = { normalizeName, buildCatalogSlices, resolveIngredient, resolveRecipeRow };
