// generateShoppingList.js — scales pars to guest count, filters by service style and selections
import { PARS_100, BEER_STYLE_MAP, WINE_STYLE_MAP, BASIC_MIXERS, GARNISHES, ALWAYS_INCLUDE } from './shoppingListPars';
import { SYRUPS, getBottlesPerSyrup } from '../../data/syrups';

/**
 * Ingredient → standard list item mapping.
 * When a signature cocktail contains one of these ingredients,
 * ensure the mapped item is on the list (add if missing, never remove).
 */
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

/** Scale a 100-guest quantity to actual guest count. Always ≥ 1. */
function scaleQty(qty100, guestCount) {
  return Math.max(1, Math.ceil((qty100 * guestCount) / 100));
}

/** Events with 50 or fewer guests get 750mL bottles instead of 1.75L handles. */
function needsBottles(guestCount) {
  return guestCount <= 50;
}

/** Generate a unique ID for list items. */
function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Scale and stamp a list of par items with _id, scaled qty, and size swap for small events. */
function scaleItems(items, guestCount, bottles) {
  return items.map(item => ({
    ...item,
    _id: uid(),
    size: (bottles && item.size === '1.75L') ? '750mL' : item.size,
    qty: scaleQty(item.qty, guestCount),
  }));
}

/** Build beer items from user selections via BEER_STYLE_MAP. */
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

/** Build wine items from user selections via WINE_STYLE_MAP. */
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

/**
 * Merge signature cocktail ingredients into the lists via INGREDIENT_MAP.
 * Adds missing items and boosts quantities for multi-use ingredients.
 */
function mergeSignatureIngredients(signatureCocktails, liquorBeerWine, everythingElse, guestCount) {
  const allIngredients = signatureCocktails.flatMap(c =>
    (c.ingredients || []).map(i => i.toLowerCase().trim())
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

/** Add self-provided syrups to the shopping list. */
function addSelfProvidedSyrups(syrupSelfProvided, everythingElse, guestCount) {
  if (syrupSelfProvided.length === 0) return;
  const bottlesPerFlavor = getBottlesPerSyrup(guestCount);
  for (const syrupId of syrupSelfProvided) {
    const syrup = SYRUPS.find(s => s.id === syrupId);
    if (!syrup) continue;
    everythingElse.push({
      _id: uid(),
      item: `${syrup.name} Syrup`,
      size: '750mL',
      qty: bottlesPerFlavor,
    });
  }
}

/**
 * Generate a shopping list from event data.
 *
 * @param {object} eventData
 * @param {string} eventData.clientName
 * @param {number} eventData.guestCount
 * @param {Array}  eventData.signatureCocktails - [{ name, ingredients: [string] }]
 * @param {string[]} [eventData.syrupSelfProvided] - Syrup IDs the client will source themselves
 * @param {string} eventData.eventDate
 * @param {string} eventData.notes
 * @param {string} [eventData.serviceStyle='full_bar'] - 'full_bar', 'sig_beer_wine', 'beer_wine', 'mocktails'
 * @param {string[]} [eventData.beerSelections] - Beer styles selected in BeerWineStep
 * @param {string[]} [eventData.wineSelections] - Wine styles selected in BeerWineStep
 * @param {boolean|null} [eventData.mixersForSignatureDrinks] - true/false/null
 * @returns {{ clientName, guestCount, eventDate, signatureCocktailNames, liquorBeerWine, everythingElse, ... }}
 */
export function generateShoppingList(eventData) {
  const {
    clientName,
    guestCount,
    signatureCocktails = [],
    syrupSelfProvided = [],
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
    // Full bar: use complete PARS_100 baseline (existing behavior)
    liquorBeerWine = scaleItems(PARS_100.liquorBeerWine, guestCount, bottles);
    everythingElse = scaleItems(PARS_100.everythingElse, guestCount, bottles);

    // Add/boost signature cocktail ingredients
    mergeSignatureIngredients(signatureCocktails, liquorBeerWine, everythingElse, guestCount);

  } else if (serviceStyle === 'sig_beer_wine') {
    // Signature drinks + beer & wine: build from selections, not full bar baseline

    // 1. Signature cocktail ingredients (spirits + cocktail-specific mixers)
    mergeSignatureIngredients(signatureCocktails, liquorBeerWine, everythingElse, guestCount);

    // 2. Beer from selections
    liquorBeerWine.push(...buildBeerItems(beerSelections, guestCount, bottles));

    // 3. Wine from selections
    liquorBeerWine.push(...buildWineItems(wineSelections, guestCount, bottles));

    // 4. Mixers — only if requested (true) or undecided (null/'undecided' — default to include)
    if (mixersForSignatureDrinks !== false) {
      everythingElse.push(...scaleItems(BASIC_MIXERS, guestCount, bottles));
      everythingElse.push(...scaleItems(GARNISHES, guestCount, bottles));
    }

    // 5. Always-include supplies
    everythingElse.push(...scaleItems(ALWAYS_INCLUDE, guestCount, bottles));

  } else if (serviceStyle === 'beer_wine') {
    // Beer & wine only: no spirits, no mixers

    // Beer from selections
    liquorBeerWine.push(...buildBeerItems(beerSelections, guestCount, bottles));

    // Wine from selections
    liquorBeerWine.push(...buildWineItems(wineSelections, guestCount, bottles));

    // Always-include supplies
    everythingElse.push(...scaleItems(ALWAYS_INCLUDE, guestCount, bottles));

  } else {
    // Mocktails or unknown: just supplies
    everythingElse.push(...scaleItems(ALWAYS_INCLUDE, guestCount, bottles));
  }

  // Add self-provided syrups (applies to all service styles with signatures)
  addSelfProvidedSyrups(syrupSelfProvided, everythingElse, guestCount);

  return {
    clientName,
    guestCount,
    eventDate,
    notes,
    signatureCocktailNames: signatureCocktails.map(c => c.name),
    liquorBeerWine,
    everythingElse,
    // Echo params for modal reset
    serviceStyle,
    beerSelections,
    wineSelections,
    mixersForSignatureDrinks,
    _signatureCocktails: signatureCocktails,
    _syrupSelfProvided: syrupSelfProvided,
  };
}
