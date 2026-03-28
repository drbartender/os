// generateShoppingList.js — scales pars to guest count and merges signature cocktail ingredients
import { PARS_100 } from './shoppingListPars';

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
function shouldUseBottles(guestCount) {
  return guestCount <= 50;
}

/**
 * Generate a shopping list from event data.
 *
 * @param {object} eventData
 * @param {string} eventData.clientName
 * @param {number} eventData.guestCount
 * @param {Array}  eventData.signatureCocktails - [{ name, ingredients: [string] }]
 * @param {string} eventData.eventDate
 * @param {string} eventData.notes
 * @returns {{ clientName, guestCount, eventDate, signatureCocktailNames, liquorBeerWine, everythingElse }}
 */
export function generateShoppingList(eventData) {
  const { clientName, guestCount, signatureCocktails = [], eventDate, notes } = eventData;
  const scale = (qty) => scaleQty(qty, guestCount);
  const bottles = shouldUseBottles(guestCount);

  // Build base lists from pars, scaling qty and swapping sizes for small events
  let liquorBeerWine = PARS_100.liquorBeerWine.map(item => ({
    ...item,
    size: (bottles && item.size === '1.75L') ? '750mL' : item.size,
    qty: scale(item.qty),
  }));

  let everythingElse = PARS_100.everythingElse.map(item => ({
    ...item,
    qty: scale(item.qty),
  }));

  // Collect all ingredient strings from all signature cocktails
  const allIngredients = signatureCocktails.flatMap(c =>
    (c.ingredients || []).map(i => i.toLowerCase().trim())
  );

  // Add missing ingredients from signature cocktails
  allIngredients.forEach(ingredient => {
    const matchKey = Object.keys(INGREDIENT_MAP).find(k => ingredient.includes(k));
    if (!matchKey) return;

    const mapped = INGREDIENT_MAP[matchKey];
    const targetList = mapped.section === 'liquorBeerWine' ? liquorBeerWine : everythingElse;
    const exists = targetList.find(i => i.item.toLowerCase() === mapped.item.toLowerCase());

    if (!exists) {
      targetList.push({
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

  return {
    clientName,
    guestCount,
    eventDate,
    notes,
    signatureCocktailNames: signatureCocktails.map(c => c.name),
    liquorBeerWine,
    everythingElse,
  };
}
