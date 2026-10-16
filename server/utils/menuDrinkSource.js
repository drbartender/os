// Turns an event's drink plan into the one shape the menu art generator reads,
// whichever side feeds it (spec 2026-10-01-menu-art-generator, 5.2, decision 8).
// - Drinks come from the side the shopping list uses (shopping_list_source), so
//   the menu matches what is poured. The brief (theme, naming, notes, planner
//   image) always comes from `selections`.
// - Order: signature cocktails (catalog ids), client-typed cocktails, mocktails
//   (catalog ids), client-typed mocktails. A picked id with no catalog row at
//   all is treated as client-typed and joins the end of its group's typed run.
// - Catalog lookups ignore is_active (drinks are soft-deleted only).
// - A typed name resolves to a catalog drink through the shopping list's own
//   matcher (exact normalized name, then request_aliases, first wins). A picked
//   drink always beats a typed one, and every drink appears once by key.
// All pure except loadEventPlan and loadCatalogMaps, which take the db.

const crypto = require('crypto');
const { buildGeneratorInputFromConsult } = require('./shoppingList');
const { recipeRowLabel } = require('./potionCatalog');
const {
  matchKey, matchCustomNames, loadRecipeCandidates, plannerServiceStyle,
} = require('./shoppingListGen');

// Every incoming drink list (picked ids, typed names, consult ids, consult
// customs) is cut to MAX_PICKS where it is read, before any per-item work: an
// unknown id runs the matcher once, so an uncapped list stalls the event loop
// (10,000 ids took 7 s). The 50 mirrors buildPlannerGeneratorInput and the
// consult sanitizer.
const MAX_PICKS = 50;
const MAX_TYPED_LEN = 200;
// Each bar list (beer, wine, spirits) is cut to MAX_BAR_ITEMS, and each item
// to MAX_BAR_ITEM_LEN characters, before cleanList or any per-item work.
const MAX_BAR_ITEMS = 50;
const MAX_BAR_ITEM_LEN = 200;
const SLUG_MAX = 60;
// Spec 7's piece key allows [a-z0-9-]{1,100} after the kind. A catalog id
// outside that (POST /api/cocktails stores a client-supplied id verbatim) is
// sanitized to at most CATALOG_SLUG_MAX characters plus a hash suffix.
const CATALOG_ID_OK = /^[a-z0-9-]{1,100}$/;
const CATALOG_SLUG_MAX = 90;
const CATALOG_KINDS = new Set(['cocktail', 'mocktail']);
// Planner beer picks that belong on the Non-Alcoholic line, not the beer line.
const NA_BEER = new Set(['Non-Alcoholic', 'Non-Alcoholic (Athletic Brewing)']);

const defaultDb = () => require('../db').pool;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const asText = (v) => (typeof v === 'string' ? v
  : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : '');
const cleanList = (arr) => [...new Set(asArray(arr).map((v) => asText(v).trim()).filter(Boolean))];
const capPicks = (list) => asArray(list).slice(0, MAX_PICKS);
const capBarList = (list) => asArray(list).slice(0, MAX_BAR_ITEMS).map((v) => asText(v).slice(0, MAX_BAR_ITEM_LEN));
const ingredientLabels = (list) => asArray(list).map(recipeRowLabel).filter(Boolean);
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const sha1Hex = (text, length) => crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, length);

// ─── Keys ────────────────────────────────────────────────────────────────────

// Lowercase, every run outside a-z0-9 becomes one hyphen, hyphens trimmed, at
// most 60 characters. A name with no ASCII letter or digit (an emoji, a
// non-Latin script) would slug to nothing, so it falls back to 'x' plus the
// first 8 hex of the trimmed name's SHA-1 (plan Review Focus 1).
function slugifyTyped(name) {
  const text = asText(name).trim();
  const slug = text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  if (slug) return slug;
  return `x${sha1Hex(text, 8)}`;
}

// A catalog id that already fits the piece key passes through. Any other id
// is slugged like a typed name but to at most 90 characters, then gets '-'
// and the first 6 hex of the original id's SHA-1, so 'Old_Fashioned' and
// 'old fashioned' stay two keys. The entry's catalog_id keeps the original.
function catalogKeyId(id) {
  if (CATALOG_ID_OK.test(id)) return id;
  const slug = id.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CATALOG_SLUG_MAX)
    .replace(/-+$/, '');
  return `${slug || 'x'}-${sha1Hex(id, 6)}`;
}

function drinkKey(entry) {
  const e = entry || {};
  const id = e.catalog_id === null || e.catalog_id === undefined ? '' : String(e.catalog_id);
  if (e.source === 'catalog' && CATALOG_KINDS.has(e.catalog_kind) && id) {
    return `${e.catalog_kind}:${catalogKeyId(id)}`;
  }
  return `custom:${slugifyTyped(e.typed_name ?? e.name)}`;
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

// The event's plan is the lowest-id plan on the proposal (proposal_id is not
// unique), the GET /api/drink-plans/by-proposal rule. serving_type rides along
// so the planner bar reads the same beer and wine keys the shopping list does.
async function loadEventPlan(proposalId, db = defaultDb()) {
  const result = await db.query(
    `SELECT id, serving_type, selections, consult_selections, shopping_list_source
       FROM drink_plans
      WHERE proposal_id = $1
      ORDER BY id
      LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}

// Every catalog drink, active or not, keyed 'cocktail:<id>' / 'mocktail:<id>'
// (the raw id: a lookup map, never an emitted key), plus the matcher's
// candidate pool. The two queries run together; a pg Client queues them.
// Callers inside a transaction must pass their client, never the pool default.
async function loadCatalogMaps(db = defaultDb()) {
  const [result, candidates] = await Promise.all([
    db.query(
      `SELECT 'cocktail' AS kind, id, name, description, ingredients FROM cocktails
       UNION ALL
       SELECT 'mocktail' AS kind, id, name, description, ingredients FROM mocktails`
    ),
    loadRecipeCandidates(db),
  ]);
  const catalogById = new Map();
  for (const row of result.rows) catalogById.set(`${row.kind}:${row.id}`, row);
  return { catalogById, candidates };
}

// ─── Normalizing ─────────────────────────────────────────────────────────────

// Every drink entry carries the same fields: key, group ('sig' | 'mock'),
// source ('catalog' | 'custom'), catalog_kind, catalog_id, name, description
// (the catalog text verbatim, null for a typed drink), typed_name (what was
// typed, null for a pick) and ingredients (labels).
function catalogEntry(kind, id, row, group, typedName) {
  const entry = {
    key: null, group, source: 'catalog', catalog_kind: kind, catalog_id: String(id),
    name: asText(row.name).trim(), description: asText(row.description) || null,
    typed_name: typedName || null, ingredients: ingredientLabels(row.ingredients),
  };
  entry.key = drinkKey(entry);
  return entry;
}

function customEntry(typedName, group, ingredients) {
  const entry = {
    key: null, group, source: 'custom', catalog_kind: null, catalog_id: null,
    name: typedName, description: null, typed_name: typedName, ingredients: ingredientLabels(ingredients),
  };
  entry.key = drinkKey(entry);
  return entry;
}

function plannerTyped(list) {
  return capPicks(list)
    .map((s) => asText(s).trim().slice(0, MAX_TYPED_LEN))
    .filter(Boolean)
    .map((name) => ({ name, ingredients: [] }));
}

function consultTyped(list) {
  return capPicks(list)
    .filter(isObject)
    .map((c) => ({ name: asText(c.name).trim().slice(0, MAX_TYPED_LEN), ingredients: c.ingredients }))
    .filter((c) => c.name);
}

function plannerBar(plan, sel) {
  // The shopping list's rule (plannerServiceStyle): a stale pick left in the
  // other key family by a mid-plan bar-style switch is not poured, so it is not
  // printed. Spirits are stocked only on a full bar. spiritsOther is one more
  // piece on the spirits list, which stays within MAX_BAR_ITEMS overall.
  const fullBar = plannerServiceStyle(plan) === 'full_bar';
  const beer = cleanList(capBarList(fullBar ? sel.beerFromFullBar : sel.beerFromBeerWine));
  const spirits = fullBar
    ? cleanList([...capBarList(sel.spirits), asText(sel.spiritsOther).trim().slice(0, MAX_BAR_ITEM_LEN)])
      .slice(0, MAX_BAR_ITEMS)
    : [];
  return {
    beer: beer.filter((v) => !NA_BEER.has(v)),
    wine: cleanList(capBarList(fullBar ? sel.wineFromFullBar : sel.wineFromBeerWine)),
    spirits,
    na: beer.filter((v) => NA_BEER.has(v)),
  };
}

function consultBar(consult) {
  // The shopping list's own translation: beer true is the house mix, wine
  // categories become the planner's labels. Consult spirits are stored as
  // lowercase one-word slugs ('vodka', 'mezcal'); capitalized, they read like
  // the planner's labels, so one vocabulary leaves this module. Only the three
  // bar fields go in, capped, so the translation never walks the custom lists.
  const input = buildGeneratorInputFromConsult({
    beer: consult.beer,
    wine: capBarList(consult.wine),
    spirits: capBarList(consult.spirits),
  }, {}, [], []);
  const spirits = cleanList(input.additionalSpirits).map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return {
    beer: cleanList(input.beerSelections),
    wine: cleanList(input.wineSelections),
    spirits: [...new Set(spirits)],
    na: [],
  };
}

function normalizePlan(plan, { catalogById = new Map(), candidates = [] } = {}) {
  if (!plan) return null;
  const sel = isObject(plan.selections) ? plan.selections : {};
  const side = plan.shopping_list_source === 'consult' ? 'consult' : 'planner';

  let sigIds; let mockIds; let typedSigs; let typedMocks; let bar;
  if (side === 'consult') {
    const consult = isObject(plan.consult_selections) ? plan.consult_selections : {};
    const includeMocktails = Boolean(consult.mocktailsEnabled) || consult.barType === 'mocktails';
    sigIds = capPicks(consult.signatureDrinks);
    typedSigs = consultTyped(consult.customCocktails);
    mockIds = includeMocktails ? capPicks(consult.mocktails) : [];
    typedMocks = includeMocktails ? consultTyped(consult.customMocktails) : [];
    bar = consultBar(consult);
  } else {
    sigIds = capPicks(sel.signatureDrinks);
    typedSigs = plannerTyped(sel.customCocktails);
    mockIds = capPicks(sel.mocktails);
    typedMocks = [];
    bar = plannerBar(plan, sel);
  }

  // Picked drinks first, both kinds, so a typed duplicate of any pick (by
  // matcher hit or by plain name) folds into the pick and keeps its place.
  const resolvePicked = (ids, kind, group) => {
    const entries = [];
    const missing = [];
    for (const raw of ids) {
      const id = asText(raw).trim();
      if (!id) continue;
      const row = catalogById.get(`${kind}:${id}`);
      if (row) entries.push(catalogEntry(kind, id, row, group, null));
      else missing.push({ name: id.slice(0, MAX_TYPED_LEN), ingredients: [] });
    }
    return { entries, missing };
  };
  const sigPicked = resolvePicked(sigIds, 'cocktail', 'sig');
  const mockPicked = resolvePicked(mockIds, 'mocktail', 'mock');
  const picked = [...sigPicked.entries, ...mockPicked.entries];
  const pickedKeys = new Set(picked.map((e) => e.key));
  const pickedNames = new Set(picked.map((e) => matchKey(e.name)).filter(Boolean));

  const resolveTyped = (items, group) => {
    const out = [];
    for (const item of items) {
      const norm = matchKey(item.name);
      if (norm && pickedNames.has(norm)) continue;
      const { matched } = matchCustomNames([item.name], candidates);
      const row = matched.length ? matched[0].row : null;
      let entry;
      // A typed cocktail that resolves to a mocktail takes the catalog kind but
      // keeps the group it was typed in ('sig'): a recorded judgment call.
      if (row && CATALOG_KINDS.has(row.kind) && row.id !== null && row.id !== undefined && String(row.id)) {
        const lookup = `${row.kind}:${row.id}`;
        entry = catalogEntry(row.kind, row.id, catalogById.get(lookup) || row, group, item.name);
      } else {
        entry = customEntry(item.name, group, item.ingredients);
      }
      if (!pickedKeys.has(entry.key)) out.push(entry);
    }
    return out;
  };
  const typedSigEntries = resolveTyped([...typedSigs, ...sigPicked.missing], 'sig');
  const typedMockEntries = resolveTyped([...typedMocks, ...mockPicked.missing], 'mock');

  const drinks = [];
  const seen = new Set();
  for (const entry of [...sigPicked.entries, ...typedSigEntries, ...mockPicked.entries, ...typedMockEntries]) {
    if (seen.has(entry.key)) continue; // first kept: repeats and slug collisions
    seen.add(entry.key);
    drinks.push(entry);
  }

  const logoKey = sel._logoFilename;
  return {
    side,
    drinks,
    bar,
    brief: {
      theme: asText(sel.menuTheme).trim(),
      naming: asText(sel.drinkNaming).trim(),
      notes: asText(sel.menuDesignNotes).trim(),
    },
    plannerImageKey: typeof logoKey === 'string' && logoKey ? logoKey : null,
  };
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

// Null, empty and whitespace-only are one value; internal runs collapse.
function normalizeBriefField(value) {
  return asText(value).replace(/\s+/g, ' ').trim();
}

function buildFingerprint(normalized) {
  const n = normalized || {};
  const brief = n.brief || {};
  const theme = normalizeBriefField(brief.theme);
  const naming = normalizeBriefField(brief.naming);
  const notes = normalizeBriefField(brief.notes);
  return {
    drink_keys: asArray(n.drinks).map((d) => d && d.key).filter(Boolean).sort(),
    brief_hash: sha256(JSON.stringify([theme, naming, notes])),
    brief_fields: { theme: sha256(theme), naming: sha256(naming), notes: sha256(notes) },
    planner_image_key: n.plannerImageKey || null,
  };
}

// One hash over a fingerprint (the dismissed_plan_hash value, spec 9), built
// from a canonical array so a fingerprint read back from JSONB (which reorders
// object keys) hashes the same as a freshly built one. brief_hash already
// covers the three brief fields.
function fingerprintHash(fingerprint) {
  const f = fingerprint || {};
  return sha256(JSON.stringify([
    asArray(f.drink_keys).map(String).sort(),
    f.brief_hash || null,
    f.planner_image_key || null,
  ]));
}

module.exports = {
  loadEventPlan,
  loadCatalogMaps,
  normalizePlan,
  buildFingerprint,
  fingerprintHash,
  drinkKey,
  slugifyTyped,
};
