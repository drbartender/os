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
  } = eventData;
  const bottles = needsBottles(guestCount);

  let liquorBeerWine = [];
  let everythingElse = [];

  if (serviceStyle === 'full_bar') {
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

module.exports = { generateShoppingList, getBottlesPerSyrup };
