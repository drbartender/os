// Shared helpers for assembling generateShoppingList() inputs from a drink_plans
// row. Keeps drinkPlans.js and drinkPlanConsult.js small and aligned: both the
// planner auto-gen path and the admin consult path call into these helpers so
// the shopping list shape stays identical regardless of input source.

const { generateShoppingList, buildGeneratorInputFromConsult } = require('./shoppingList');
const { buildCatalogSlices, normalizeName } = require('./potionCatalog');

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
// @returns { matched: [{name, ingredients}], needsRecipe: [{name}] }
function matchCustomNames(customStrings, candidateRows) {
  const byNorm = new Map();
  for (const row of candidateRows || []) {
    const norm = normalizeName(row.name);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, row);
  }
  const matched = [];
  const needsRecipe = [];
  for (const raw of customStrings || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const hit = byNorm.get(normalizeName(name));
    if (hit) matched.push({ name: hit.name, ingredients: hit.ingredients || [] });
    else needsRecipe.push({ name });
  }
  return { matched, needsRecipe };
}

// All drinks (both tables, INCLUDING inactive/off-menu) that carry a recipe —
// the candidate pool for custom-request matching. Off-menu inclusion is the
// point: a one-off drink added via "Add recipe" stays matchable forever.
async function loadRecipeCandidates(dbClient) {
  const result = await dbClient.query(
    `SELECT name, ingredients FROM cocktails
      WHERE ingredients IS NOT NULL AND ingredients::text <> '[]'
     UNION ALL
     SELECT name, ingredients FROM mocktails
      WHERE ingredients IS NOT NULL AND ingredients::text <> '[]'`
  );
  return result.rows;
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
            p.guest_count
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
};
