// Server-side shopping list generator. Mirrors
// client/src/components/ShoppingList/generateShoppingList.js + shoppingListPars.js +
// the syrup helper from client/src/data/syrups.js (getBottlesPerSyrup) so the
// drink-plan submit transaction can auto-generate a draft list for admin review
// without round-tripping through the browser. Keep the algorithm in sync — when
// you change one side, mirror the change to the other and update the unit-test
// fixtures (if any). Pure functions, no DB calls.

const crypto = require('crypto');

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
  { item: 'Ginger Ale',          size: '12 pack', qty: 1 },
  { item: 'Ginger Beer',         size: '4 pack',  qty: 3 },
  { item: 'Sprite',              size: '12 pack', qty: 1 },
  { item: 'Club Soda',           size: '1L',      qty: 6 },
  { item: 'Tonic Water',         size: '1L',      qty: 2 },
  { item: 'Lemonade (REAL)',     size: '1G',      qty: 1 },
  { item: 'Cranberry Juice',     size: '64oz',    qty: 2 },
  { item: 'Pineapple Juice',     size: '64oz',    qty: 2 },
  { item: 'Orange Juice',        size: '1G',      qty: 1 },
  { item: 'Sour Mix',            size: '64oz',    qty: 1 },
  { item: 'Lemon Juice',         size: '31oz',    qty: 1 },
  { item: 'Lime Juice (UNSWEET)',size: '15oz',    qty: 1 },
  { item: 'Simple Syrup',        size: '1L',      qty: 2 },
];

const GARNISHES = [
  { item: 'Angostura Bitters',   size: '4oz',     qty: 1 },
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
    { item: "Malibu Coconut Rum",  size: "1.75L",   qty: 2 },
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
    { item: "Ginger Ale",          size: "12 pack", qty: 1 },
    { item: "Ginger Beer",         size: "4 pack",  qty: 3 },
    { item: "Sprite",              size: "12 pack", qty: 1 },
    { item: "Club Soda",           size: "1L",      qty: 6 },
    { item: "Tonic Water",         size: "1L",      qty: 2 },
    { item: "Lemonade (REAL)",     size: "1G",      qty: 1 },
    { item: "Cranberry Juice",     size: "64oz",    qty: 2 },
    { item: "Pineapple Juice",     size: "64oz",    qty: 2 },
    { item: "Orange Juice",        size: "1G",      qty: 1 },
    { item: "Sour Mix",            size: "64oz",    qty: 1 },
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
  "gin":                { item: "Tanqueray Gin",        size: "750mL",   section: "liquorBeerWine" },
  "bourbon":            { item: "Bulleit Bourbon",      size: "750mL",   section: "liquorBeerWine" },
  "tequila":            { item: "1800 Blanco Tequila",  size: "750mL",   section: "liquorBeerWine" },
  "lemonade":           { item: "Lemonade (REAL)",      size: "1G",      section: "everythingElse" },
  "sprite":             { item: "Sprite",               size: "12 pack", section: "everythingElse" },
  "orange juice":       { item: "Orange Juice",         size: "1G",      section: "everythingElse" },
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
  tequila: ['Lime Juice (UNSWEET)', 'Sour Mix', 'Simple Syrup', 'Club Soda', 'Limes'],
  bourbon: ['Coca Cola', 'Club Soda', 'Ginger Ale', 'Angostura Bitters', 'Premium Cherries'],
  whiskey: ['Coca Cola', 'Club Soda', 'Ginger Ale', 'Angostura Bitters', 'Premium Cherries'],
  scotch:  ['Club Soda'],
  mezcal:  ['Lime Juice (UNSWEET)', 'Simple Syrup', 'Limes'],
};

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

function buildBeerItems(beerSelections, guestCount, bottles) {
  const items = [];
  for (const style of beerSelections) {
    if (style === 'None') continue;
    const mapped = BEER_STYLE_MAP[style];
    if (!mapped) continue;
    items.push(...scaleItems(mapped, guestCount, bottles));
  }
  return items;
}

function buildWineItems(wineSelections, guestCount, bottles) {
  const items = [];
  for (const style of wineSelections) {
    if (style === 'None' || style === 'Other') continue;
    const mapped = WINE_STYLE_MAP[style];
    if (!mapped) continue;
    items.push(...scaleItems(mapped, guestCount, bottles));
  }
  return items;
}

function mergeSignatureIngredients(signatureCocktails, liquorBeerWine, everythingElse, guestCount) {
  const allIngredients = signatureCocktails.flatMap(c =>
    (c.ingredients || []).map(i => String(i).toLowerCase().trim())
  );

  // Add missing ingredients
  allIngredients.forEach(ingredient => {
    const matchKey = Object.keys(INGREDIENT_MAP).find(k => ingredient.includes(k));
    if (!matchKey) return;
    const mapped = INGREDIENT_MAP[matchKey];
    const targetList = mapped.section === 'liquorBeerWine' ? liquorBeerWine : everythingElse;
    const exists = targetList.find(i => i.item.toLowerCase() === mapped.item.toLowerCase());
    if (!exists) {
      targetList.push({
        _id: uid(),
        item: mapped.item,
        size: mapped.size,
        qty: Math.max(1, Math.ceil(guestCount / 25)),
      });
    }
  });

  // Boost items used by multiple signature cocktails (+1 per additional cocktail)
  const ingredientCounts = {};
  allIngredients.forEach(ing => {
    const matchKey = Object.keys(INGREDIENT_MAP).find(k => ing.includes(k));
    if (matchKey) ingredientCounts[matchKey] = (ingredientCounts[matchKey] || 0) + 1;
  });
  Object.entries(ingredientCounts).forEach(([key, count]) => {
    if (count < 2) return;
    const mapped = INGREDIENT_MAP[key];
    const targetList = mapped.section === 'liquorBeerWine' ? liquorBeerWine : everythingElse;
    const item = targetList.find(i => i.item.toLowerCase() === mapped.item.toLowerCase());
    if (item) item.qty += count - 1;
  });
}

function addSpiritsByKey(spiritKeys, liquorBeerWine, guestCount, bottles) {
  for (const raw of spiritKeys) {
    if (!raw) continue;
    const par = SPIRIT_PARS[String(raw).toLowerCase()];
    if (!par) continue;
    if (liquorBeerWine.some(i => i.item.toLowerCase() === par.item.toLowerCase())) continue;
    liquorBeerWine.push(...scaleItems([par], guestCount, bottles));
  }
}

function addMatchingMixers(spiritKeys, everythingElse, guestCount, bottles) {
  const wantedNames = new Set();
  for (const raw of spiritKeys) {
    if (!raw) continue;
    const list = SPIRIT_MIXER_PAIRINGS[String(raw).toLowerCase()];
    if (!list) continue;
    for (const name of list) wantedNames.add(name);
  }
  if (wantedNames.size === 0) return;
  const lookup = [...BASIC_MIXERS, ...GARNISHES];
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
function generateShoppingList(eventData) {
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
    additionalSpirits = null,
    mixerMode = null,
  } = eventData;
  const bottles = needsBottles(guestCount);

  let liquorBeerWine = [];
  let everythingElse = [];

  // Consult-mode path: distinguished by `mixerMode` being explicitly set.
  // The admin's chip-grid spirit picks become the source of truth (instead of
  // the PARS_100 full-bar baseline), beer/wine flow through the existing
  // builders, and the mixer mode controls whether the additional bar mixers
  // are full / spirit-paired / none. Sig ingredients are merged regardless.
  if (mixerMode) {
    if (Array.isArray(additionalSpirits) && additionalSpirits.length > 0) {
      addSpiritsByKey(additionalSpirits, liquorBeerWine, guestCount, bottles);
    }
    if (Array.isArray(beerSelections) && beerSelections.length > 0) {
      liquorBeerWine.push(...buildBeerItems(beerSelections, guestCount, bottles));
    }
    if (Array.isArray(wineSelections) && wineSelections.length > 0) {
      liquorBeerWine.push(...buildWineItems(wineSelections, guestCount, bottles));
    }
    mergeSignatureIngredients(signatureCocktails, liquorBeerWine, everythingElse, guestCount);
    if (mixerMode === 'full') {
      everythingElse.push(...scaleItems(BASIC_MIXERS, guestCount, bottles));
      everythingElse.push(...scaleItems(GARNISHES, guestCount, bottles));
    } else if (mixerMode === 'matching') {
      addMatchingMixers(additionalSpirits || [], everythingElse, guestCount, bottles);
    }
    everythingElse.push(...scaleItems(ALWAYS_INCLUDE, guestCount, bottles));
  } else if (serviceStyle === 'full_bar') {
    liquorBeerWine = scaleItems(PARS_100.liquorBeerWine, guestCount, bottles);
    everythingElse = scaleItems(PARS_100.everythingElse, guestCount, bottles);
    mergeSignatureIngredients(signatureCocktails, liquorBeerWine, everythingElse, guestCount);
  } else if (serviceStyle === 'sig_beer_wine') {
    mergeSignatureIngredients(signatureCocktails, liquorBeerWine, everythingElse, guestCount);
    liquorBeerWine.push(...buildBeerItems(beerSelections, guestCount, bottles));
    liquorBeerWine.push(...buildWineItems(wineSelections, guestCount, bottles));
    if (mixersForSignatureDrinks !== false) {
      everythingElse.push(...scaleItems(BASIC_MIXERS, guestCount, bottles));
      everythingElse.push(...scaleItems(GARNISHES, guestCount, bottles));
    }
    everythingElse.push(...scaleItems(ALWAYS_INCLUDE, guestCount, bottles));
  } else if (serviceStyle === 'beer_wine') {
    liquorBeerWine.push(...buildBeerItems(beerSelections, guestCount, bottles));
    liquorBeerWine.push(...buildWineItems(wineSelections, guestCount, bottles));
    everythingElse.push(...scaleItems(ALWAYS_INCLUDE, guestCount, bottles));
  } else {
    // mocktails / unknown — supplies only
    everythingElse.push(...scaleItems(ALWAYS_INCLUDE, guestCount, bottles));
  }

  addSelfProvidedSyrups(syrupSelfProvided, syrupNamesById, everythingElse, guestCount);

  return {
    clientName,
    guestCount,
    eventDate,
    notes,
    signatureCocktailNames: signatureCocktails.map(c => c.name),
    liquorBeerWine,
    everythingElse,
    serviceStyle,
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks,
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

  const signatureCocktails = [
    ...resolvedSigs,
    ...customSigs,
    ...(safe.mocktailsEnabled ? [...resolvedMocktails, ...customMocktails] : []),
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

module.exports = { generateShoppingList, getBottlesPerSyrup, buildGeneratorInputFromConsult };
