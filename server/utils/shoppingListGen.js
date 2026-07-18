// Shared helpers for assembling generateShoppingList() inputs from a drink_plans
// row. Keeps drinkPlans.js and drinkPlanConsult.js small and aligned: both the
// planner auto-gen path and the admin consult path call into these helpers so
// the shopping list shape stays identical regardless of input source.

const { generateShoppingList, buildGeneratorInputFromConsult } = require('./shoppingList');
const { buildCatalogSlices, normalizeName } = require('./potionCatalog');
const { computeDemand } = require('./quantityEngine');

// Load the live par catalog and derive slices. Returns null on ANY failure
// (empty table, missing table mid-deploy, transient DB error) so the pure
// generator falls back to its legacy constants instead of aborting a caller's
// transaction — callers must load OUTSIDE any BEGIN. Both failure shapes are
// Sentry-reported: a silently thin prod list is the one unacceptable outcome.
async function loadCatalog(dbClient) {
  try {
    const result = await dbClient.query(
      'SELECT * FROM par_items WHERE is_active = true ORDER BY section, sort_order, id'
    );
    if (!result.rows.length) {
      reportCatalogIssue('par_catalog_empty', null);
      return null;
    }
    return buildCatalogSlices(result.rows);
  } catch (err) {
    reportCatalogIssue('par_catalog_read_failed', err);
    return null;
  }
}

function reportCatalogIssue(tag, err) {
  console.error(`Shopping list catalog issue: ${tag}`, err ? err.message : '');
  if (process.env.SENTRY_DSN_SERVER) {
    const Sentry = require('@sentry/node');
    if (err) Sentry.captureException(err, { tags: { op: tag } });
    else Sentry.captureMessage(tag, 'warning');
  }
}

// Report recipe/free-text rows that resolved to no catalog item during a
// generation (spec §5: silent wrong-list regressions must be visible in prod,
// not just on the Recipes tab). No-throw; safe to call with any list shape.
function reportUnresolvedIngredients(list, opTag) {
  const unresolved = (list && list._unresolvedIngredients) || [];
  if (!unresolved.length) return;
  console.warn(`Shopping list unresolved ingredients (${opTag}):`, JSON.stringify(unresolved));
  if (process.env.SENTRY_DSN_SERVER) {
    const Sentry = require('@sentry/node');
    Sentry.captureMessage('unresolved_ingredient', {
      level: 'warning',
      tags: { op: opTag },
      extra: { unresolved },
    });
  }
}

// Mirror of client/src/data/syrups.js SYRUPS — id → display name. Keep in sync
// when adding new flavors. Only used for shopping-list rendering of the
// self-provided syrup line items, so a missing entry just drops that flavor
// from the list (no crash).
const SYRUP_NAME_LOOKUP = {
  'mixed-berry': 'Mixed Berry', 'blackberry': 'Blackberry', 'strawberry': 'Strawberry',
  'mango': 'Mango', 'passion-fruit': 'Passion Fruit', 'pineapple': 'Pineapple',
  'peach': 'Peach', 'watermelon': 'Watermelon', 'grenadine': 'Grenadine (Pomegranate)',
  'cherry': 'Cherry (Dark/Tart)',
  'jalapeno': 'Jalapeño', 'habanero': 'Habanero', 'cherry-habanero': 'Cherry Habanero',
  'reaper-ghost': 'Carolina Reaper / Ghost Pepper',
  'lavender': 'Lavender', 'rosemary': 'Rosemary', 'thyme': 'Thyme', 'basil': 'Basil',
  'mint': 'Mint', 'ginger': 'Ginger', 'cardamom': 'Cardamom', 'cinnamon': 'Cinnamon',
  'vanilla': 'Vanilla', 'lemongrass': 'Lemongrass', 'hibiscus': 'Hibiscus',
  'rose': 'Rose', 'elderflower': 'Elderflower',
  'honey': 'Honey', 'maple': 'Maple', 'salted-caramel': 'Salted Caramel',
  'brown-butter': 'Brown Butter', 'espresso': 'Espresso', 'chocolate': 'Chocolate',
  // Specialty flavors from client/src/data/syrups.js that were missing here
  // (found via the Enhancement Lab, which renders these names to clients).
  'vanilla-bean': 'Vanilla Bean', 'demerara': 'Demerara', 'orgeat': 'Orgeat (Almond)',
};

// Table allowlist for drink resolution. NEVER interpolate a caller-supplied
// string into the query; the table name comes only from this fixed map.
const DRINK_TABLES = { cocktails: 'cocktails', mocktails: 'mocktails' };

// Resolve drink IDs to [{name, ingredients}] preserving order. Missing IDs
// are dropped silently so a renamed/deactivated drink doesn't break a
// shopping list regen. Table-aware: consult/planner mocktail ids resolve
// against the mocktails table (they silently resolved to nothing before,
// because the old helper only ever queried cocktails).
async function resolveDrinkIds(ids, table, dbClient) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const tableName = Object.prototype.hasOwnProperty.call(DRINK_TABLES, table)
    ? DRINK_TABLES[table]
    : null;
  if (!tableName) throw new Error(`resolveDrinkIds: unknown table "${table}"`);
  const result = await dbClient.query(
    `SELECT id, name, ingredients FROM ${tableName} WHERE id = ANY($1::text[])`,
    [ids]
  );
  const byId = Object.fromEntries(result.rows.map(c => [c.id, c]));
  return ids
    .filter(id => byId[id])
    .map(id => ({ name: byId[id].name, ingredients: byId[id].ingredients || [] }));
}

// Back-compat alias (existing callers).
async function resolveCocktailIds(cocktailIds, dbClient) {
  return resolveDrinkIds(cocktailIds, 'cocktails', dbClient);
}

// Match client free-text custom-drink requests against drinks that HAVE
// recipes (normalized EXACT equality only — a fuzzy server-side match could
// put the wrong bottles on a list). Pure; exported for tests.
// @returns { matched: [rows carrying {name, ingredients, request_aliases?}],
//            needsRecipe: [{name}] }
// Match keys additionally strip apostrophes BEFORE normalizing ("jennys" must
// hit "Jenny's": the shared normalizer maps punctuation to a space, which
// would keep them distinct). Scoped to matching only; slugs and par-alias
// resolution keep normalizeName untouched. Mirrored client-side in
// NeedsRecipeSection's reuse-before-create lookup.
function matchKey(s) {
  return normalizeName(String(s ?? '').replace(/['’]/g, ''));
}

function matchCustomNames(customStrings, candidateRows) {
  const byNorm = new Map();
  // Two passes, names first: a real drink name always beats another drink's
  // client-typed alias; first-wins is preserved within each pass.
  for (const row of candidateRows || []) {
    const norm = matchKey(row.name);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, row);
  }
  for (const row of candidateRows || []) {
    for (const alias of row.request_aliases || []) {
      const norm = matchKey(alias);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, row);
    }
  }
  const matched = [];
  const needsRecipe = [];
  for (const raw of customStrings || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const hit = byNorm.get(matchKey(name));
    if (hit) matched.push({ name: hit.name, ingredients: hit.ingredients || [] });
    else needsRecipe.push({ name });
  }
  return { matched, needsRecipe };
}

// All drinks (both tables, INCLUDING inactive/off-menu) that carry a recipe —
// the candidate pool for custom-request matching. Off-menu inclusion is the
// point: a one-off drink added via "Add recipe" stays matchable forever.
// Deterministic candidate order (spec §1): collisions resolve stably, active
// beats draft, oldest wins among peers; matchCustomNames is first-wins so
// this ORDER BY is the tiebreak contract.
async function loadRecipeCandidates(dbClient) {
  const result = await dbClient.query(
    `SELECT name, ingredients, request_aliases FROM (
       SELECT name, ingredients, request_aliases, is_active, created_at, 1 AS src FROM cocktails
        WHERE ingredients IS NOT NULL AND ingredients::text <> '[]'
       UNION ALL
       SELECT name, ingredients, request_aliases, is_active, created_at, 2 AS src FROM mocktails
        WHERE ingredients IS NOT NULL AND ingredients::text <> '[]'
     ) candidates
     ORDER BY is_active DESC NULLS LAST, created_at ASC, name ASC, src ASC`
  );
  return result.rows;
}

// ─── Quantity-review derivation metadata (pp2-quantity-review) ───────────────
// The derivation block is DISPLAY METADATA for the admin quantity-review strip:
// it shows how the demand model reads the crowd answers (drinkers x hours x pace
// -> pours, gently-nudged category split, per-role buffer policy). Per the plan
// lane's conservative v1 scope, demand informs ONLY this display block; it does
// NOT alter the existing par-scaled purchase quantities. It is attached under the
// underscore key `_derivation` so it (1) is stripped from the public token
// response by the existing underscore filter, and (2) is re-derived on every
// generate/regenerate (a generation-run diagnostic, like _unresolvedIngredients),
// never persisted through the modal's PUT save.
//
// ABSENT-SAFE: when the plan never answered the crowd question (every legacy
// plan, every consult plan), buildDerivationForPlan returns null, no block is
// attached, and the generated list is byte-identical to the pre-lane output.

const DERIVATION_SETTING_KEYS = [
  'pour_split_cocktails', 'pour_split_beer', 'pour_split_wine',
  'pour_pace_per_hour',
  'shopping_buffer_spirits', 'shopping_buffer_mixers',
  'shopping_buffer_garnish', 'shopping_buffer_supplies',
];

const CATEGORY_LABELS = { cocktails: 'Cocktails', beer: 'Beer', wine: 'Wine' };
const CATEGORY_KEYS = ['cocktails', 'beer', 'wine'];

function settingNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Pure. Build the derivation display block from the crowd answers, event hours,
// and settings, or return null when the crowd question was never answered.
// Quantities are NOT touched here — this is metadata only.
function buildDerivation({ crowd, guestCount, hours, settings = {}, counts = {} }) {
  if (!crowd || typeof crowd !== 'object') return null;
  const splitDefaults = {
    cocktails: settingNum(settings.pour_split_cocktails, 45),
    beer: settingNum(settings.pour_split_beer, 30),
    wine: settingNum(settings.pour_split_wine, 25),
  };
  const pace = settingNum(settings.pour_pace_per_hour, 1.0);
  const buffers = {
    spirits: settingNum(settings.shopping_buffer_spirits, 1.25),
    mixers: settingNum(settings.shopping_buffer_mixers, 1.4),
    garnish: settingNum(settings.shopping_buffer_garnish, 1.5),
    supplies: settingNum(settings.shopping_buffer_supplies, 1.25),
  };
  // "not sure" (crowd.unsure) or a null drinker count both mean the engine
  // falls back to its 75%-of-guests estimate.
  const drinkersInput = crowd.unsure || crowd.drinkers === null || crowd.drinkers === undefined
    ? null
    : Number(crowd.drinkers);
  const demand = computeDemand({
    guestCount, drinkers: drinkersInput, profile: crowd.profile,
    hours, pace, splitDefaults, counts,
  });
  const perCategory = CATEGORY_KEYS.map((cat) => {
    const pct = Math.round(demand.splitPct[cat]);
    const pours = demand.split[cat];
    return {
      category: cat,
      label: CATEGORY_LABELS[cat],
      pct,
      pours,
      // perDrinkPours is null when nothing in that category was selected.
      perDrink: demand.perDrinkPours[cat] === null ? null : Math.round(demand.perDrinkPours[cat] * 10) / 10,
      text: `${pct}% of ${demand.pours} pours ≈ ${pours} ${cat}`,
    };
  });
  return {
    drinkers: demand.drinkers,
    estimated: drinkersInput === null,   // true when the 75% fallback was used
    profile: crowd.profile || null,
    guestCount: Math.max(0, Number(guestCount) || 0),
    hours: Math.max(0, Number(hours) || 0),
    pace,
    pours: demand.pours,
    splitPct: {
      cocktails: Math.round(demand.splitPct.cocktails),
      beer: Math.round(demand.splitPct.beer),
      wine: Math.round(demand.splitPct.wine),
    },
    split: demand.split,
    perCategory,
    buffers,
  };
}

// Best-effort per-category selected-drink counts for the even per-drink split
// display ("44 pours each"). Missing/zero counts just drop the per-drink line.
function deriveCategoryCounts(plan, sel) {
  const isFullBar = (plan.serving_type || 'full_bar') === 'full_bar';
  const beer = isFullBar ? sel.beerFromFullBar : sel.beerFromBeerWine;
  const wine = isFullBar ? sel.wineFromFullBar : sel.wineFromBeerWine;
  const countStyles = (arr, skip) => (Array.isArray(arr)
    ? arr.filter((v) => v && !skip.includes(v)).length : 0);
  return {
    cocktails: Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks.length : 0,
    beer: countStyles(beer, ['None']),
    wine: countStyles(wine, ['None', 'Other']),
  };
}

// Load only the derivation-relevant flat settings keys. Never throws — a read
// failure degrades to engine defaults (buildDerivation coerces missing keys).
async function loadDerivationSettings(dbClient) {
  try {
    const r = await dbClient.query(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
      [DERIVATION_SETTING_KEYS]
    );
    const out = {};
    for (const row of r.rows) out[row.key] = row.value;
    return out;
  } catch (err) {
    return {};
  }
}

// DB-aware wrapper: derive the quantity-review metadata for a plan row, or null
// when the crowd question was never answered (absent-safe). Caller must have
// joined `proposals` for guest_count + event_duration_hours. Never throws:
// generation must never fail because derivation could not be computed.
async function buildDerivationForPlan(plan, dbClient) {
  try {
    const sel = plan.selections || {};
    if (!sel.crowd || typeof sel.crowd !== 'object') return null;
    const settings = await loadDerivationSettings(dbClient);
    return buildDerivation({
      crowd: sel.crowd,
      guestCount: plan.guest_count,
      hours: plan.event_duration_hours,
      settings,
      counts: deriveCategoryCounts(plan, sel),
    });
  } catch (err) {
    return null;
  }
}

// ─── Admin-set quantity holds (pp2-quantity-review) ──────────────────────────
// An admin's deliberate quantity override on a line is marked `admin_set: true`
// (set by the review modal's edit path). A regenerate pulls a FRESH list from
// the live catalog; without a hold it would silently clobber those overrides.
// applyAdminSetHolds merges the saved admin-set lines onto the fresh list:
//   - a matching fresh line (same item name + size) keeps the held qty + marker;
//   - an admin-set line with no fresh match (admin-added, or dropped from the
//     fresh gen) is appended so it survives.
// Blank-name holds are skipped so a never-filled-in "+ Add Item" row is not
// re-appended forever. Pure; mutates and returns the fresh list (which the
// regenerate path builds new each call, so in-place mutation is safe).

function holdKey(item) {
  return `${String(item.item || '').trim().toLowerCase()}|${String(item.size || '').trim().toLowerCase()}`;
}

function applyAdminSetHolds(freshList, currentList) {
  if (!freshList || typeof freshList !== 'object') return freshList;
  if (!currentList || typeof currentList !== 'object') return freshList;
  for (const section of ['liquorBeerWine', 'everythingElse']) {
    const heldMap = new Map();
    for (const item of (Array.isArray(currentList[section]) ? currentList[section] : [])) {
      if (item && item.admin_set && String(item.item || '').trim()) {
        heldMap.set(holdKey(item), item);
      }
    }
    if (heldMap.size === 0) continue;
    const fresh = Array.isArray(freshList[section]) ? freshList[section] : [];
    const matched = new Set();
    for (const line of fresh) {
      const k = holdKey(line);
      const held = heldMap.get(k);
      if (held) {
        line.qty = held.qty;
        line.admin_set = true;
        matched.add(k);
      }
    }
    for (const [k, held] of heldMap) {
      if (!matched.has(k)) fresh.push({ ...held, admin_set: true });
    }
    freshList[section] = fresh;
  }
  return freshList;
}

// Build generateShoppingList input from a plan row's planner-side selections.
// Caller must have already joined `proposals` for `guest_count`.
async function buildPlannerGeneratorInput(plan, dbClient) {
  const sel = plan.selections || {};
  const sigDrinkIds = Array.isArray(sel.signatureDrinks) ? sel.signatureDrinks : [];
  const mocktailIds = Array.isArray(sel.mocktails) ? sel.mocktails : [];
  const [resolvedSigs, resolvedMocktails] = await Promise.all([
    resolveDrinkIds(sigDrinkIds, 'cocktails', dbClient),
    resolveDrinkIds(mocktailIds, 'mocktails', dbClient),
  ]);

  // Client custom requests (free-text strings, stored on every submitted plan
  // but consumed by nothing until now): normalized-exact match against every
  // drink with a recipe (including off-menu); the rest surface as needsRecipe.
  // Caps mirror the consult path's sanitizer (MAX_LIST_ITEMS 50 / name 200):
  // the planner submit allowlist stores these uncapped, and unmatched names
  // ride the blob into admin + public renders, so bound them here.
  const customStrings = (Array.isArray(sel.customCocktails) ? sel.customCocktails : [])
    .slice(0, 50)
    .map(s => String(s || '').trim().slice(0, 200))
    .filter(Boolean);
  let matchedCustoms = [];
  let needsRecipe = [];
  if (customStrings.length > 0) {
    const candidates = await loadRecipeCandidates(dbClient);
    ({ matched: matchedCustoms, needsRecipe } = matchCustomNames(customStrings, candidates));
    // Dedup: a client who both SELECTS a menu drink and free-types its name
    // must not get its ingredients counted twice (quantity inflation).
    const alreadySelected = new Set(
      [...resolvedSigs, ...resolvedMocktails].map(d => normalizeName(d.name))
    );
    matchedCustoms = matchedCustoms.filter(d => !alreadySelected.has(normalizeName(d.name)));
  }

  const signatureCocktails = [...resolvedSigs, ...resolvedMocktails, ...matchedCustoms];
  const syrupSelfProvided = Array.isArray(sel.syrupSelfProvided) ? sel.syrupSelfProvided : [];
  const syrupNamesById = syrupSelfProvided.length > 0 ? SYRUP_NAME_LOOKUP : {};
  const isFullBar = (plan.serving_type || 'full_bar') === 'full_bar';
  const beerSelections = isFullBar ? (sel.beerFromFullBar || []) : (sel.beerFromBeerWine || []);
  const wineSelections = isFullBar ? (sel.wineFromFullBar || []) : (sel.wineFromBeerWine || []);
  return {
    clientName: plan.client_name,
    guestCount: plan.guest_count,
    signatureCocktails,
    needsRecipe,
    syrupSelfProvided,
    syrupNamesById,
    eventDate: plan.event_date,
    notes: plan.admin_notes || '',
    serviceStyle: plan.serving_type || 'full_bar',
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks: sel.mixersForSignatureDrinks ?? null,
    activeAddonSlugs: Object.entries(sel.addOns || {})
      .filter(([, meta]) => meta && meta.enabled)
      .map(([slug]) => slug),
  };
}

// Build generateShoppingList input from a plan row's consult-side selections.
async function buildConsultGeneratorInput(plan, dbClient) {
  const consult = plan.consult_selections || {};
  const sigIds = Array.isArray(consult.signatureDrinks) ? consult.signatureDrinks : [];
  const mockIds = Array.isArray(consult.mocktails) ? consult.mocktails : [];
  const [resolvedSigs, resolvedMocktails] = await Promise.all([
    resolveDrinkIds(sigIds, 'cocktails', dbClient),
    // Bug fix: mocktail ids previously resolved against the cocktails table
    // and silently contributed nothing.
    resolveDrinkIds(mockIds, 'mocktails', dbClient),
  ]);
  const generatorInput = buildGeneratorInputFromConsult(
    consult,
    {
      clientName: plan.client_name,
      guestCount: plan.guest_count,
      eventDate: plan.event_date,
    },
    resolvedSigs,
    resolvedMocktails
  );
  return {
    ...generatorInput,
    activeAddonSlugs: Object.entries(consult.addOns || {})
      .filter(([, meta]) => meta && meta.enabled)
      .map(([slug]) => slug),
  };
}

// Auto-generate a shopping list for a submitted drink plan and stage it as
// `pending_review`. Strict no-overwrite semantics: only generates when no list
// exists yet — the WHERE-clause `shopping_list IS NULL` guard keeps an admin's
// concurrent manual save (or already-approved list) from being clobbered by a
// late-firing auto-gen after submit COMMIT. Failures are non-fatal — admin can
// still trigger the manual generator from the modal as a fallback.
async function autoGenerateShoppingList(planId, dbClient) {
  const planRes = await dbClient.query(
    `SELECT dp.id, dp.serving_type, dp.selections, dp.client_name, dp.event_date,
            dp.admin_notes, dp.shopping_list IS NOT NULL AS has_list,
            p.guest_count, p.event_duration_hours
     FROM drink_plans dp
     LEFT JOIN proposals p ON p.id = dp.proposal_id
     WHERE dp.id = $1`,
    [planId]
  );
  const plan = planRes.rows[0];
  if (!plan || !plan.guest_count) return null;
  if (plan.has_list) return null;

  // Catalog load happens here, NOT inside any caller transaction; a failed
  // read degrades to the legacy constants (loadCatalog Sentry-reports it).
  const catalog = await loadCatalog(dbClient);
  const input = await buildPlannerGeneratorInput(plan, dbClient);
  const list = generateShoppingList(input, catalog);
  reportUnresolvedIngredients(list, 'auto_gen_shopping_list');
  // Attach the quantity-review derivation metadata when the crowd question was
  // answered (v2 plans). Null for every legacy/consult plan -> no _derivation
  // key -> list byte-identical to the pre-lane output. Metadata only; the
  // par-scaled purchase quantities above are untouched.
  const derivation = await buildDerivationForPlan(plan, dbClient);
  if (derivation) list._derivation = derivation;

  await dbClient.query(
    `UPDATE drink_plans
       SET shopping_list = $1::jsonb,
           shopping_list_status = 'pending_review',
           shopping_list_source = 'planner',
           updated_at = NOW()
     WHERE id = $2
       AND shopping_list IS NULL`,
    [JSON.stringify(list), planId]
  );
  return list;
}

// Fire-and-forget wrapper. Two routes (PUT /t/:token financial branch + fast
// path) post-commit kick off auto-gen the same way; collapsing into one helper
// keeps drinkPlans.js under the line-count ratchet and the failure handling in
// one place (console + optional Sentry capture).
function triggerShoppingListAutoGen(planId, opTag = 'auto_gen_shopping_list') {
  if (!planId) return;
  const { pool } = require('../db');
  const Sentry = require('@sentry/node');
  autoGenerateShoppingList(planId, pool).catch((genErr) => {
    console.error('Shopping list auto-gen failed:', genErr);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(genErr, { tags: { route: 'drinkPlans/putToken', op: opTag }, extra: { planId } });
    }
  });
}

module.exports = {
  SYRUP_NAME_LOOKUP,
  loadCatalog,
  reportUnresolvedIngredients,
  resolveDrinkIds,
  resolveCocktailIds,
  matchCustomNames,
  loadRecipeCandidates,
  buildPlannerGeneratorInput,
  buildConsultGeneratorInput,
  autoGenerateShoppingList,
  triggerShoppingListAutoGen,
  buildDerivation,
  buildDerivationForPlan,
  applyAdminSetHolds,
};
