// Server-side shopping list generator. Mirrors
// client/src/components/ShoppingList/generateShoppingList.js + shoppingListPars.js +
// the syrup helper from client/src/data/syrups.js (getBottlesPerSyrup) so the
// drink-plan submit transaction can auto-generate a draft list for admin review
// without round-tripping through the browser. Keep the algorithm in sync — when
// you change one side, mirror the change to the other and update the unit-test
// fixtures (if any). Pure functions, no DB calls.

const crypto = require('crypto');
const { resolveRecipeRow, normalizeName } = require('./potionCatalog');

// ─── 100-guest baselines (mirror shoppingListPars.js) ────────────

const BEER_STYLE_MAP = {
  'Light / Easy Drinking': [
    { item: 'Michelob Ultra', size: '24pk', qty: 2 },
  ],
  'Craft / Local': [
    { item: 'Local Craft Beer', size: '24pk', qty: 2 },
  ],
  'IPA': [
    { item: 'IPA (Lagunitas / Voodoo Ranger)', size: '12pk', qty: 2 },
  ],
  'Seltzer': [
    { item: 'White Claw Variety', size: '12pk', qty: 2 },
  ],
  'Non-Alcoholic': [
    { item: 'Athletic Brewing NA', size: '12pk', qty: 1 },
  ],
};

const WINE_STYLE_MAP = {
  'Red': [
    { item: 'Cabernet Sauvignon', size: '750mL', qty: 6 },
    { item: 'Pinot Noir', size: '750mL', qty: 6 },
  ],
  'White': [
    { item: 'Moscato', size: '750mL', qty: 6 },
    { item: 'Sauvignon Blanc', size: '750mL', qty: 6 },
  ],
  'Sparkling': [
    { item: 'Champagne', size: '750mL', qty: 12 },
  ],
};

const BASIC_MIXERS = [
  { item: 'Coca Cola',           size: '12 pack', qty: 2 },
  { item: 'Diet Coke',           size: '12 pack', qty: 1 },
  { item: 'Sprite',              size: '12 pack', qty: 1 },
  { item: 'Club Soda',           size: '8 pack',  qty: 6 },
  { item: 'Tonic Water',         size: '1L',      qty: 2 },
  { item: 'Cranberry Juice',     size: '64oz',    qty: 2 },
  { item: 'Pineapple Juice',     size: '64oz',    qty: 2 },
  { item: 'Orange Juice',        size: '64oz',    qty: 1 },
  { item: 'Lemon Juice',         size: '31oz',    qty: 1 },
  { item: 'Lime Juice (UNSWEET)',size: '15oz',    qty: 1 },
  { item: 'Simple Syrup',        size: '1L',      qty: 2 },
  { item: 'Angostura Bitters',   size: '4oz',     qty: 1 },
];

const GARNISHES = [
  { item: 'Premium Cherries',    size: 'ea.',     qty: 1 },
  { item: 'Lemons',              size: 'ea.',     qty: 4 },
  { item: 'Limes',               size: 'ea.',     qty: 12 },
  { item: 'Oranges',             size: 'ea.',     qty: 2 },
];

const ALWAYS_INCLUDE = [
  { item: 'Water',               size: '24pk',    qty: 4 },
  { item: 'Cups (9oz)',          size: '500',     qty: 1 },
  { item: 'Straws',              size: 'box',     qty: 1 },
  { item: 'Napkins',             size: '100',     qty: 1 },
  { item: 'Ice',                 size: 'lbs',     qty: 150 },
];

const PARS_100 = {
  liquorBeerWine: [
    { item: "Tito's Vodka",        size: "1.75L",   qty: 5 },
    { item: "Tanqueray Gin",       size: "1.75L",   qty: 1 },
    { item: "Bacardi Rum",         size: "1.75L",   qty: 2 },
    { item: "Bulleit Bourbon",     size: "1.75L",   qty: 4 },
    { item: "1800 Blanco Tequila", size: "1.75L",   qty: 4 },
    { item: "Cabernet Sauvignon",  size: "750mL",   qty: 6 },
    { item: "Pinot Noir",          size: "750mL",   qty: 6 },
    { item: "Moscato",             size: "750mL",   qty: 6 },
    { item: "Sauvignon Blanc",     size: "750mL",   qty: 6 },
    { item: "Champagne",           size: "750mL",   qty: 12 },
    { item: "Michelob Ultra",      size: "24pk",    qty: 2 },
    { item: "Corona / Light",      size: "24pk",    qty: 3 },
    { item: "Yuengling",           size: "24pk",    qty: 2 },
  ],
  everythingElse: [
    { item: "Coca Cola",           size: "12 pack", qty: 2 },
    { item: "Diet Coke",           size: "12 pack", qty: 1 },
    { item: "Sprite",              size: "12 pack", qty: 1 },
    { item: "Club Soda",           size: "8 pack",  qty: 6 },
    { item: "Tonic Water",         size: "1L",      qty: 2 },
    { item: "Cranberry Juice",     size: "64oz",    qty: 2 },
    { item: "Pineapple Juice",     size: "64oz",    qty: 2 },
    { item: "Orange Juice",        size: "64oz",    qty: 1 },
    { item: "Lemon Juice",         size: "31oz",    qty: 1 },
    { item: "Lime Juice (UNSWEET)",size: "15oz",    qty: 1 },
    { item: "Simple Syrup",        size: "1L",      qty: 2 },
    { item: "Angostura Bitters",   size: "4oz",     qty: 1 },
    { item: "Premium Cherries",    size: "ea.",     qty: 1 },
    { item: "Lemons",              size: "ea.",     qty: 4 },
    { item: "Limes",               size: "ea.",     qty: 12 },
    { item: "Oranges",             size: "ea.",     qty: 2 },
    { item: "Water",               size: "24pk",    qty: 4 },
    { item: "Cups (9oz)",          size: "500",     qty: 1 },
    { item: "Straws",              size: "box",     qty: 1 },
    { item: "Napkins",             size: "100",     qty: 1 },
    { item: "Ice",                 size: "lbs",     qty: 150 },
  ],
};

const INGREDIENT_MAP = {
  "raspberry vodka":    { item: "Raspberry Vodka",      size: "750mL",   section: "liquorBeerWine" },
  "coconut rum":        { item: "Malibu Coconut Rum",   size: "750mL",   section: "liquorBeerWine" },
  "island blue pucker": { item: "Island Blue Pucker",   size: "750mL",   section: "liquorBeerWine" },
  "blue curacao":       { item: "Blue Curacao",         size: "750mL",   section: "liquorBeerWine" },
  "vodka":              { item: "Tito's Vodka",         size: "750mL",   section: "liquorBeerWine" },
  "rum":                { item: "Bacardi Rum",          size: "750mL",   section: "liquorBeerWine" },
  // Ginger keys MUST precede "gin": matching is ingredient.includes(key) and
  // "ginger beer"/"ginger ale" both contain "gin" — "gin" first would win.
  "ginger beer":        { item: "Ginger Beer",          size: "4 pack",  section: "everythingElse" },
  "ginger ale":         { item: "Ginger Ale",           size: "12 pack", section: "everythingElse" },
  "gin":                { item: "Tanqueray Gin",        size: "750mL",   section: "liquorBeerWine" },
  "bourbon":            { item: "Bulleit Bourbon",      size: "750mL",   section: "liquorBeerWine" },
  "tequila":            { item: "1800 Blanco Tequila",  size: "750mL",   section: "liquorBeerWine" },
  "lemonade":           { item: "Lemonade (REAL)",      size: "1G",      section: "everythingElse" },
  "sprite":             { item: "Sprite",               size: "12 pack", section: "everythingElse" },
  "orange juice":       { item: "Orange Juice",         size: "64oz",    section: "everythingElse" },
  "pineapple juice":    { item: "Pineapple Juice",      size: "64oz",    section: "everythingElse" },
  "sour":               { item: "Sour Mix",             size: "64oz",    section: "everythingElse" },
  "cranberry":          { item: "Cranberry Juice",      size: "64oz",    section: "everythingElse" },
};

// House defaults for spirits the consult form can pick. Keys are the slugs the
// admin chip grid emits; values mirror the PARS_100 baseline rows so consult
// mode and full-bar mode produce identical line items for the same spirit.
const SPIRIT_PARS = {
  vodka:   { item: "Tito's Vodka",        size: '1.75L', qty: 5 },
  gin:     { item: 'Tanqueray Gin',       size: '1.75L', qty: 1 },
  rum:     { item: 'Bacardi Rum',         size: '1.75L', qty: 2 },
  tequila: { item: '1800 Blanco Tequila', size: '1.75L', qty: 4 },
  bourbon: { item: 'Bulleit Bourbon',     size: '1.75L', qty: 4 },
  whiskey: { item: 'Bulleit Bourbon',     size: '1.75L', qty: 4 },
  scotch:  { item: 'Scotch Whiskey',      size: '1.75L', qty: 1 },
  mezcal:  { item: 'Mezcal',              size: '750mL', qty: 1 },
};

// Mixer pairings used when the consult form picks `mixers: 'matching'`. For each
// selected spirit, the union of its paired mixer item names is included from
// BASIC_MIXERS + GARNISHES (matched by exact `item` name). Sig drink ingredients
// are added independently via mergeSignatureIngredients — these are additive.
const SPIRIT_MIXER_PAIRINGS = {
  vodka:   ['Cranberry Juice', 'Orange Juice', 'Tonic Water', 'Club Soda', 'Lime Juice (UNSWEET)', 'Limes'],
  gin:     ['Tonic Water', 'Club Soda', 'Lemon Juice', 'Simple Syrup', 'Lemons'],
  rum:     ['Coca Cola', 'Pineapple Juice', 'Orange Juice', 'Lime Juice (UNSWEET)', 'Limes'],
  tequila: ['Lime Juice (UNSWEET)', 'Simple Syrup', 'Club Soda', 'Limes'],
  bourbon: ['Coca Cola', 'Club Soda', 'Angostura Bitters', 'Premium Cherries'],
  whiskey: ['Coca Cola', 'Club Soda', 'Angostura Bitters', 'Premium Cherries'],
  scotch:  ['Club Soda'],
  mezcal:  ['Lime Juice (UNSWEET)', 'Simple Syrup', 'Limes'],
};

// Wrap the legacy constants in the potionCatalog slice shape so the generator
// has ONE consumption path. Used only when no live catalog is passed in
// (catalog missing/empty = par_items read failed or unseeded; callers Sentry-
// report that). aliasIndex mirrors INGREDIENT_MAP with itemId null, so the
// merge-size rule (which keys off byId roles) is a no-op on this path and the
// legacy map's own sizes (spirits already 750mL) flow through untouched.
let _legacySlices = null;
function legacySlices() {
  if (_legacySlices) return _legacySlices;
  const aliasIndex = Object.entries(INGREDIENT_MAP)
    .map(([alias, mapped]) => ({
      alias: normalizeName(alias), itemId: null,
      item: mapped.item, size: mapped.size, section: mapped.section,
    }))
    .sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  _legacySlices = {
    pars100: PARS_100,
    spiritPars: SPIRIT_PARS,
    beerStyleMap: BEER_STYLE_MAP,
    wineStyleMap: WINE_STYLE_MAP,
    basicMixers: BASIC_MIXERS,
    garnishes: GARNISHES,
    alwaysInclude: ALWAYS_INCLUDE,
    spiritMixerPairings: SPIRIT_MIXER_PAIRINGS,
    aliasIndex,
    byId: new Map(),
    isEmpty: false,
  };
  return _legacySlices;
}

// Mirrors getBottlesPerSyrup from client/src/data/syrups.js. 1 bottle / 50 guests.
function getBottlesPerSyrup(guestCount) {
  if (!guestCount || guestCount <= 50) return 1;
  return Math.ceil(guestCount / 50);
}

function scaleQty(qty100, guestCount) {
  return Math.max(1, Math.ceil((qty100 * guestCount) / 100));
}

function needsBottles(guestCount) {
  return guestCount <= 50;
}

function uid() {
  return crypto.randomUUID();
}

function scaleItems(items, guestCount, bottles) {
  return items.map(item => ({
    ...item,
    _id: uid(),
    size: (bottles && item.size === '1.75L') ? '750mL' : item.size,
    qty: scaleQty(item.qty, guestCount),
  }));
}

function buildBeerItems(beerSelections, guestCount, bottles, slices) {
  const items = [];
  for (const style of beerSelections) {
    if (style === 'None') continue;
    const mapped = slices.beerStyleMap[style];
    if (!mapped) continue;
    items.push(...scaleItems(mapped, guestCount, bottles));
  }
  return items;
}

function buildWineItems(wineSelections, guestCount, bottles, slices) {
  const items = [];
  for (const style of wineSelections) {
    if (style === 'None' || style === 'Other') continue;
    const mapped = slices.wineStyleMap[style];
    if (!mapped) continue;
    items.push(...scaleItems(mapped, guestCount, bottles));
  }
  return items;
}

// Recipe-aware replacement for the old mergeSignatureIngredients. Rows may be
// structured recipe objects OR legacy free-text strings; both resolve through
// the catalog (potionCatalog.resolveRecipeRow: override-active-first, then
// alias exact-then-longest-substring). Quantity POLICY is deliberately
// unchanged from legacy (spec: "quantities are usually right"): a missing
// item lands at 1 per 25 guests, and an item shared by multiple drinks gets
// +1 per additional use. Per-serving amounts do not drive purchase math in
// v1. Unresolved rows are collected for the caller to report (never a silent
// wrong match, never a silent drop without a trace).
function mergeSignatureRecipes(signatureCocktails, liquorBeerWine, everythingElse, guestCount, slices, unresolved) {
  const resolvedRows = [];
  for (const drink of signatureCocktails) {
    for (const row of (drink.ingredients || [])) {
      const resolved = resolveRecipeRow(row, slices);
      if (!resolved) {
        const label = typeof row === 'string' ? row : (row && row.ingredient) || '';
        if (String(label).trim()) unresolved.push({ drink: drink.name, ingredient: String(label).trim() });
        continue;
      }
      // Merge-size rule (spec §3.2): sig-drink spirits are added as 750mL
      // bottles even though the baseline par row stocks 1.75L. Legacy-map
      // entries carry itemId null (no byId hit), and their sizes are already
      // the map's own — so this transform is a no-op on the fallback path.
      const parRow = slices.byId ? slices.byId.get(resolved.itemId) : null;
      const size = (parRow && parRow.role === 'spirit' && resolved.size === '1.75L') ? '750mL' : resolved.size;
      resolvedRows.push({
        key: resolved.itemId || resolved.item.toLowerCase(),
        item: resolved.item,
        size,
        section: resolved.section,
      });
    }
  }

  // Add missing items (legacy policy: first occurrence wins, 1 per 25 guests).
  for (const r of resolvedRows) {
    const targetList = r.section === 'liquorBeerWine' ? liquorBeerWine : everythingElse;
    const exists = targetList.find(i => i.item.toLowerCase() === r.item.toLowerCase());
    if (!exists) {
      targetList.push({
        _id: uid(),
        item: r.item,
        size: r.size,
        qty: Math.max(1, Math.ceil(guestCount / 25)),
      });
    }
  }

  // Boost items used by multiple signature drinks (+1 per additional use,
  // applied once per resolved item — legacy applied once per map key).
  const counts = {};
  for (const r of resolvedRows) counts[r.key] = (counts[r.key] || 0) + 1;
  const boosted = new Set();
  for (const r of resolvedRows) {
    if (counts[r.key] < 2 || boosted.has(r.key)) continue;
    boosted.add(r.key);
    const targetList = r.section === 'liquorBeerWine' ? liquorBeerWine : everythingElse;
    const item = targetList.find(i => i.item.toLowerCase() === r.item.toLowerCase());
    if (item) item.qty += counts[r.key] - 1;
  }
}

function addSpiritsByKey(spiritKeys, liquorBeerWine, guestCount, bottles, slices) {
  for (const raw of spiritKeys) {
    if (!raw) continue;
    const par = slices.spiritPars[String(raw).toLowerCase()];
    if (!par) continue;
    if (liquorBeerWine.some(i => i.item.toLowerCase() === par.item.toLowerCase())) continue;
    liquorBeerWine.push(...scaleItems([par], guestCount, bottles));
  }
}

function addMatchingMixers(spiritKeys, everythingElse, guestCount, bottles, slices) {
  const wantedNames = new Set();
  for (const raw of spiritKeys) {
    if (!raw) continue;
    const list = slices.spiritMixerPairings[String(raw).toLowerCase()];
    if (!list) continue;
    for (const name of list) wantedNames.add(name);
  }
  if (wantedNames.size === 0) return;
  const lookup = [...slices.basicMixers, ...slices.garnishes];
  for (const name of wantedNames) {
    const found = lookup.find(m => m.item === name);
    if (!found) continue;
    if (everythingElse.some(i => i.item.toLowerCase() === name.toLowerCase())) continue;
    everythingElse.push(...scaleItems([found], guestCount, bottles));
  }
}

function addSelfProvidedSyrups(syrupSelfProvided, syrupNamesById, everythingElse, guestCount) {
  if (!syrupSelfProvided || syrupSelfProvided.length === 0) return;
  const bottlesPerFlavor = getBottlesPerSyrup(guestCount);
  for (const syrupId of syrupSelfProvided) {
    const name = syrupNamesById?.[syrupId];
    if (!name) continue;
    everythingElse.push({
      _id: uid(),
      item: `${name} Syrup`,
      size: '750mL',
      qty: bottlesPerFlavor,
    });
  }
}

/**
 * Generate a shopping list. Mirrors the client-side generator.
 *
 * @param {object} eventData
 * @param {string} [eventData.clientName]
 * @param {number} eventData.guestCount
 * @param {Array<{name: string, ingredients: string[]}>} [eventData.signatureCocktails]
 * @param {string[]} [eventData.syrupSelfProvided]      Syrup IDs self-provided
 * @param {Object<string,string>} [eventData.syrupNamesById]  id → display name
 * @param {string} [eventData.eventDate]
 * @param {string} [eventData.notes]
 * @param {'full_bar'|'sig_beer_wine'|'beer_wine'|'mocktails'} [eventData.serviceStyle='full_bar']
 * @param {string[]} [eventData.beerSelections]
 * @param {string[]} [eventData.wineSelections]
 * @param {boolean|null} [eventData.mixersForSignatureDrinks]
 * @param {string[]} [eventData.additionalSpirits]   Consult mode: spirit slugs picked in chip grid
 * @param {'full'|'matching'|'none'|null} [eventData.mixerMode]  Consult mode: 3-state mixer override
 */
// Consult-mode branch: admin's chip-grid spirit picks are the source of truth
// (not PARS_100 full-bar baseline). Beer/wine flow through normal builders;
// mixerMode controls whether additional bar mixers are full / paired / none.
function buildConsultLists(eventData, bottles, slices, unresolved) {
  const {
    guestCount,
    signatureCocktails = [],
    beerSelections = [],
    wineSelections = [],
    additionalSpirits = null,
    mixerMode,
  } = eventData;
  const liquorBeerWine = [];
  const everythingElse = [];

  if (Array.isArray(additionalSpirits) && additionalSpirits.length > 0) {
    addSpiritsByKey(additionalSpirits, liquorBeerWine, guestCount, bottles, slices);
  }
  if (Array.isArray(beerSelections) && beerSelections.length > 0) {
    liquorBeerWine.push(...buildBeerItems(beerSelections, guestCount, bottles, slices));
  }
  if (Array.isArray(wineSelections) && wineSelections.length > 0) {
    liquorBeerWine.push(...buildWineItems(wineSelections, guestCount, bottles, slices));
  }
  mergeSignatureRecipes(signatureCocktails, liquorBeerWine, everythingElse, guestCount, slices, unresolved);
  if (mixerMode === 'full') {
    everythingElse.push(...scaleItems(slices.basicMixers, guestCount, bottles));
    everythingElse.push(...scaleItems(slices.garnishes, guestCount, bottles));
  } else if (mixerMode === 'matching') {
    addMatchingMixers(additionalSpirits || [], everythingElse, guestCount, bottles, slices);
  }
  everythingElse.push(...scaleItems(slices.alwaysInclude, guestCount, bottles));

  return { liquorBeerWine, everythingElse };
}

// Planner-mode branch: client-submitted serviceStyle picks the recipe.
function buildPlannerLists(eventData, bottles, slices, unresolved) {
  const {
    guestCount,
    signatureCocktails = [],
    serviceStyle = 'full_bar',
    beerSelections = [],
    wineSelections = [],
    mixersForSignatureDrinks = null,
  } = eventData;
  let liquorBeerWine = [];
  let everythingElse = [];

  if (serviceStyle === 'full_bar') {
    liquorBeerWine = scaleItems(slices.pars100.liquorBeerWine, guestCount, bottles);
    everythingElse = scaleItems(slices.pars100.everythingElse, guestCount, bottles);
    mergeSignatureRecipes(signatureCocktails, liquorBeerWine, everythingElse, guestCount, slices, unresolved);
  } else if (serviceStyle === 'sig_beer_wine') {
    mergeSignatureRecipes(signatureCocktails, liquorBeerWine, everythingElse, guestCount, slices, unresolved);
    liquorBeerWine.push(...buildBeerItems(beerSelections, guestCount, bottles, slices));
    liquorBeerWine.push(...buildWineItems(wineSelections, guestCount, bottles, slices));
    if (mixersForSignatureDrinks !== false) {
      everythingElse.push(...scaleItems(slices.basicMixers, guestCount, bottles));
      everythingElse.push(...scaleItems(slices.garnishes, guestCount, bottles));
    }
    everythingElse.push(...scaleItems(slices.alwaysInclude, guestCount, bottles));
  } else if (serviceStyle === 'beer_wine') {
    liquorBeerWine.push(...buildBeerItems(beerSelections, guestCount, bottles, slices));
    liquorBeerWine.push(...buildWineItems(wineSelections, guestCount, bottles, slices));
    everythingElse.push(...scaleItems(slices.alwaysInclude, guestCount, bottles));
  } else {
    // mocktails / unknown — supplies only
    everythingElse.push(...scaleItems(slices.alwaysInclude, guestCount, bottles));
  }

  return { liquorBeerWine, everythingElse };
}

function generateShoppingList(eventData, catalog) {
  // Lazy require breaks a circular dependency: shoppingListAddonCoverage.js
  // requires this module for BASIC_MIXERS/GARNISHES, so a top-level require
  // here would hand it this module's still-incomplete exports.
  const { computeStripSet } = require('./shoppingListAddonCoverage');
  const {
    clientName,
    guestCount,
    signatureCocktails = [],
    syrupSelfProvided = [],
    syrupNamesById = {},
    eventDate,
    notes,
    serviceStyle = 'full_bar',
    beerSelections = [],
    wineSelections = [],
    mixersForSignatureDrinks = null,
    mixerMode = null,
    needsRecipe = [],
  } = eventData;
  const bottles = needsBottles(guestCount);

  // Live catalog slices when provided; legacy constants otherwise (callers
  // Sentry-report the miss). Purity holds: the catalog arrives as an
  // argument, never via a DB call from here.
  const slices = (catalog && !catalog.isEmpty) ? catalog : legacySlices();
  const unresolved = [];

  // mixerMode being explicitly set distinguishes consult mode from planner mode.
  const { liquorBeerWine, everythingElse } = mixerMode
    ? buildConsultLists(eventData, bottles, slices, unresolved)
    : buildPlannerLists(eventData, bottles, slices, unresolved);

  addSelfProvidedSyrups(syrupSelfProvided, syrupNamesById, everythingElse, guestCount);

  // Final pass: subtract items covered by static BYOB-support add-ons.
  // See server/utils/shoppingListAddonCoverage.js. Empty strip set when
  // no covering add-ons are active, in which case this is a no-op.
  const stripSet = computeStripSet({ activeAddonSlugs: eventData.activeAddonSlugs });
  const filteredLiquorBeerWine = stripSet.size > 0
    ? liquorBeerWine.filter((i) => !stripSet.has(i.item))
    : liquorBeerWine;
  const filteredEverythingElse = stripSet.size > 0
    ? everythingElse.filter((i) => !stripSet.has(i.item))
    : everythingElse;

  return {
    clientName,
    guestCount,
    eventDate,
    notes,
    signatureCocktailNames: signatureCocktails.map(c => c.name),
    liquorBeerWine: filteredLiquorBeerWine,
    everythingElse: filteredEverythingElse,
    serviceStyle,
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks,
    // Client custom requests that matched no recipe (spec §5 needs-recipe
    // flow): passed through by the input builders, rendered as a distinct
    // block by the modal/public page/PDF, persisted with the saved blob.
    needsRecipe: Array.isArray(needsRecipe) ? needsRecipe : [],
    // Recipe/free-text rows that resolved to no catalog item this run.
    // Callers report these (Sentry 'unresolved_ingredient'); the field also
    // rides the blob so the admin modal can surface them.
    _unresolvedIngredients: unresolved,
    _signatureCocktails: signatureCocktails,
    _syrupSelfProvided: syrupSelfProvided,
  };
}

// Translate a consult-form payload into the eventData shape generateShoppingList
// expects. Pure function — caller resolves cocktail IDs to {name, ingredients}
// rows beforehand (DB lookup) and passes them as `resolvedSigs`/`resolvedMocktails`.
// Custom drinks from the form are merged in here so the generator sees a flat
// signatureCocktails list.
function buildGeneratorInputFromConsult(consult, eventCtx, resolvedSigs = [], resolvedMocktails = []) {
  const safe = consult || {};
  const customSigs = (safe.customCocktails || []).map(c => ({
    name: String(c.name || '').trim(),
    ingredients: Array.isArray(c.ingredients)
      ? c.ingredients.map(i => String(i).trim()).filter(Boolean)
      : [],
  })).filter(c => c.name);
  const customMocktails = (safe.customMocktails || []).map(c => ({
    name: String(c.name || '').trim(),
    ingredients: Array.isArray(c.ingredients)
      ? c.ingredients.map(i => String(i).trim()).filter(Boolean)
      : [],
  })).filter(c => c.name);

  // mocktail-only mode always includes mocktails regardless of mocktailsEnabled
  // — the consult form coerces the flag to true on submit, but a hand-crafted
  // PUT could bypass that, so we treat barType==='mocktails' as the source of
  // truth here. Defensive cross-field check.
  const includeMocktails = safe.mocktailsEnabled || safe.barType === 'mocktails';
  const signatureCocktails = [
    ...resolvedSigs,
    ...customSigs,
    ...(includeMocktails ? [...resolvedMocktails, ...customMocktails] : []),
  ];

  // Beer y/n → default house mix when "yes". Admin tweaks specifics in the
  // existing edit modal post-generation.
  const beerSelections = safe.beer === true
    ? ['Light / Easy Drinking', 'Craft / Local', 'IPA']
    : [];

  // Wine multi-cat → existing wine style keys.
  const wineCatToStyle = { red: 'Red', white: 'White', sparkling: 'Sparkling' };
  const wineSelections = Array.isArray(safe.wine)
    ? safe.wine.map(c => wineCatToStyle[String(c).toLowerCase()]).filter(Boolean)
    : [];

  const mixerMode = ['full', 'matching', 'none'].includes(safe.mixers) ? safe.mixers : 'full';

  return {
    clientName: eventCtx.clientName || '',
    guestCount: Number(safe.guestCountOverride) || eventCtx.guestCount || 0,
    eventDate: safe.eventDateOverride || eventCtx.eventDate || null,
    notes: String(safe.notes || ''),
    signatureCocktails,
    syrupSelfProvided: [],
    syrupNamesById: {},
    serviceStyle: safe.barType || 'sig_beer_wine',
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks: mixerMode !== 'none',
    additionalSpirits: Array.isArray(safe.spirits) ? safe.spirits : [],
    mixerMode,
  };
}

// The nine legacy data constants are exported (names unchanged) so the
// potionCatalog parity test compares against the LIVE values, never copies,
// and so the catalog-miss fallback can wrap them. shoppingListAddonCoverage
// keeps importing BASIC_MIXERS/GARNISHES exactly as before.
module.exports = {
  generateShoppingList, getBottlesPerSyrup, buildGeneratorInputFromConsult,
  PARS_100, SPIRIT_PARS, INGREDIENT_MAP, BEER_STYLE_MAP, WINE_STYLE_MAP,
  BASIC_MIXERS, GARNISHES, ALWAYS_INCLUDE, SPIRIT_MIXER_PAIRINGS,
};
