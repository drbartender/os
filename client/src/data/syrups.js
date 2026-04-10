/**
 * Housemade Syrups — data, pricing, and drink-to-syrup mappings.
 */

// Pricing constants
export const SYRUP_PRICE_SINGLE = 30;
export const SYRUP_PRICE_3PACK = 75;

export const SYRUP_CATEGORIES = [
  { key: 'fruit', label: 'Fruit' },
  { key: 'heat', label: 'Heat' },
  { key: 'botanical', label: 'Botanical & Spice' },
  { key: 'specialty', label: 'Specialty' },
];

export const SYRUPS = [
  // Fruit
  { id: 'mixed-berry', name: 'Mixed Berry', category: 'fruit' },
  { id: 'blackberry', name: 'Blackberry', category: 'fruit' },
  { id: 'strawberry', name: 'Strawberry', category: 'fruit' },
  { id: 'mango', name: 'Mango', category: 'fruit' },
  { id: 'passion-fruit', name: 'Passion Fruit', category: 'fruit' },
  { id: 'pineapple', name: 'Pineapple', category: 'fruit' },
  { id: 'peach', name: 'Peach', category: 'fruit' },
  { id: 'watermelon', name: 'Watermelon', category: 'fruit', seasonal: true },
  { id: 'grenadine', name: 'Grenadine (Pomegranate)', category: 'fruit' },
  { id: 'cherry', name: 'Cherry (Dark/Tart)', category: 'fruit' },

  // Heat
  { id: 'jalapeno', name: 'Jalape\u00f1o', category: 'heat' },
  { id: 'habanero', name: 'Habanero', category: 'heat' },
  { id: 'cherry-habanero', name: 'Cherry Habanero', category: 'heat' },
  { id: 'reaper-ghost', name: 'Carolina Reaper / Ghost Pepper', category: 'heat', seasonal: true },

  // Botanical & Spice
  { id: 'lavender', name: 'Lavender', category: 'botanical' },
  { id: 'ginger', name: 'Ginger', category: 'botanical' },
  { id: 'cinnamon', name: 'Cinnamon', category: 'botanical' },
  { id: 'vanilla-bean', name: 'Vanilla Bean', category: 'botanical' },
  { id: 'rosemary', name: 'Rosemary', category: 'botanical' },
  { id: 'mint', name: 'Mint', category: 'botanical' },

  // Specialty
  { id: 'honey', name: 'Honey', category: 'specialty' },
  { id: 'demerara', name: 'Demerara', category: 'specialty' },
  { id: 'orgeat', name: 'Orgeat (Almond)', category: 'specialty' },
  { id: 'hibiscus', name: 'Hibiscus', category: 'specialty' },
];

/**
 * Drink-to-syrup upgrade/variation mapping.
 * Keys are cocktail IDs from cocktailMenu.js.
 * Each entry has recommended syrup IDs and optional notes per syrup.
 */
export const DRINK_SYRUP_MAP = {
  'old-fashioned': {
    syrups: ['demerara', 'honey', 'cherry', 'cherry-habanero'],
    notes: {
      demerara: 'Rich, caramel depth',
      honey: 'Smooth and warm',
      cherry: 'Dark fruit complexity',
      'cherry-habanero': 'Sweet heat finish',
    },
  },
  'espresso-martini': {
    syrups: ['vanilla-bean', 'demerara'],
    notes: {
      'vanilla-bean': 'Replaces vanilla vodka for richer flavor',
      demerara: 'Caramel-coffee pairing',
    },
  },
  'mojito': {
    syrups: ['mint', 'blackberry', 'strawberry'],
    notes: {
      mint: 'Replaces muddled mint for consistency',
      blackberry: 'Blackberry Mojito twist',
      strawberry: 'Strawberry Mojito twist',
    },
  },
  'whiskey-sour': {
    syrups: ['blackberry', 'honey', 'cherry-habanero'],
    notes: {
      blackberry: 'Blackberry Whiskey Sour',
      honey: 'Becomes a Gold Rush',
      'cherry-habanero': 'Sweet heat kick',
    },
  },
  'margarita': {
    syrups: ['jalapeno', 'habanero', 'mango', 'strawberry', 'passion-fruit'],
    notes: {
      jalapeno: 'Spicy Margarita',
      habanero: 'Extra-hot Margarita',
      mango: 'Mango Margarita',
      strawberry: 'Strawberry Margarita',
      'passion-fruit': 'Tropical Margarita',
    },
  },
  'paloma': {
    syrups: ['ginger'],
    notes: { ginger: 'Ginger-grapefruit twist' },
  },
  'moscow-mule': {
    syrups: ['jalapeno', 'passion-fruit', 'mango'],
    notes: {
      jalapeno: 'Spicy Mule',
      'passion-fruit': 'Tropical Mule',
      mango: 'Mango Mule',
    },
  },
  'daiquiri': {
    syrups: ['strawberry', 'mango', 'passion-fruit'],
    notes: {
      strawberry: 'Strawberry Daiquiri',
      mango: 'Mango Daiquiri',
      'passion-fruit': 'Passion Fruit Daiquiri',
    },
  },
  'cosmopolitan': {
    syrups: ['hibiscus'],
    notes: { hibiscus: 'Hibiscus Cosmo' },
  },
  'french-75': {
    syrups: ['lavender'],
    notes: { lavender: 'Lavender French 75' },
  },
  'smokey-pina': {
    syrups: ['pineapple'],
    notes: { pineapple: 'Extra tropical depth' },
  },
  'aperol-spritz': {
    syrups: ['passion-fruit', 'peach'],
    notes: {
      'passion-fruit': 'Tropical Spritz',
      peach: 'Peach Spritz',
    },
  },
  'negroni': {
    syrups: ['cherry'],
    notes: { cherry: 'Cherry Negroni' },
  },
  'paper-plane': {
    syrups: ['honey'],
    notes: { honey: 'Smoother finish' },
  },
  'mai-tai': {
    syrups: ['orgeat', 'passion-fruit'],
    featured: ['orgeat'],
    notes: {
      orgeat: 'The classic Mai Tai foundation — rich almond and floral',
      'passion-fruit': 'Tropical boost alongside orgeat',
    },
  },
  'vodka-berry-lemonade': {
    syrups: ['strawberry', 'blackberry', 'mango', 'peach', 'watermelon', 'grenadine', 'lavender', 'hibiscus'],
    notes: {
      strawberry: 'Strawberry Lemonade',
      blackberry: 'Blackberry Lemonade',
      mango: 'Mango Lemonade',
      peach: 'Peach Lemonade',
      watermelon: 'Watermelon Lemonade (seasonal)',
      grenadine: 'Pink Grenadine Lemonade',
      lavender: 'Lavender Lemonade',
      hibiscus: 'Hibiscus Lemonade',
    },
  },
};

/**
 * Get drink-grouped flavor data for the per-drink "Make It Yours" section.
 * Returns only drinks that have optional syrup mappings (excludes required-syrup drinks).
 * @param {string[]} selectedDrinkIds - IDs of drinks the client selected
 * @param {Array} cocktails - Full cocktail menu array (with id, name, emoji)
 * @returns {Array<{ drinkId, drinkName, drinkEmoji, flavors: Array<{ syrupId, syrupName, note }> }>}
 */
export function getDrinksWithFlavors(selectedDrinkIds, cocktails = []) {
  const results = [];
  for (const drinkId of selectedDrinkIds) {
    const mapping = DRINK_SYRUP_MAP[drinkId];
    if (!mapping || mapping.required) continue;

    const cocktail = cocktails.find(c => c.id === drinkId);
    const flavors = mapping.syrups.map(syrupId => {
      const syrup = SYRUPS.find(s => s.id === syrupId);
      if (!syrup) return null;
      return {
        syrupId,
        syrupName: syrup.name,
        note: mapping.notes?.[syrupId] || null,
      };
    }).filter(Boolean);

    if (flavors.length > 0) {
      results.push({
        drinkId,
        drinkName: cocktail?.name || drinkId,
        drinkEmoji: cocktail?.emoji || '',
        flavors,
      });
    }
  }
  return results;
}

/** Drinks that should never show syrup recommendations */
export const NO_SYRUP_DRINKS = [
  'martini', 'manhattan', 'sidecar', 'boulevardier',
  'black-manhattan', 'sazerac', 'corpse-reviver', 'last-word',
];

/**
 * Calculate how many bottles of a single syrup are needed based on guest count.
 * Each 750ml bottle makes ~35 cocktails; not every guest orders the flavored
 * variant, so we estimate 1 bottle per 50 guests (minimum 1).
 * @param {number|null} guestCount
 * @returns {number}
 */
export function getBottlesPerSyrup(guestCount) {
  if (!guestCount || guestCount <= 50) return 1;
  return Math.ceil(guestCount / 50);
}

/**
 * Calculate syrup cost with 3-pack discount applied to total bottles.
 * Every 3 bottles = $75 (regardless of flavor), remainder at $30 each.
 * @param {number} uniqueFlavors - Number of unique syrups selected
 * @param {number} [bottlesPerFlavor=1] - Bottles needed per flavor (from getBottlesPerSyrup)
 * @returns {{ packs: number, singles: number, bottlesPerFlavor: number, totalBottles: number, total: number }}
 */
export function calculateSyrupCost(uniqueFlavors, bottlesPerFlavor = 1) {
  if (uniqueFlavors <= 0) return { packs: 0, singles: 0, bottlesPerFlavor: 1, totalBottles: 0, total: 0 };
  const totalBottles = uniqueFlavors * bottlesPerFlavor;
  const packs = Math.floor(totalBottles / 3);
  const singles = totalBottles % 3;
  const total = packs * SYRUP_PRICE_3PACK + singles * SYRUP_PRICE_SINGLE;
  return { packs, singles, bottlesPerFlavor, totalBottles, total };
}

/**
 * Flatten a per-drink syrup selections map to a deduplicated array of syrup IDs.
 * Handles backward compatibility with legacy flat arrays.
 * @param {Object|Array} syrupSelections - { drinkId: [syrupId, ...] } or legacy [syrupId, ...]
 * @returns {string[]} Unique syrup IDs
 */
export function getAllUniqueSyrups(syrupSelections) {
  if (!syrupSelections) return [];
  if (Array.isArray(syrupSelections)) return syrupSelections; // legacy flat array
  return [...new Set(Object.values(syrupSelections).flat())];
}

/**
 * Get syrup IDs selected for a specific drink.
 * @param {Object|Array} syrupSelections - per-drink map or legacy flat array
 * @param {string} drinkId
 * @returns {string[]}
 */
export function getDrinkSyrupSelections(syrupSelections, drinkId) {
  if (!syrupSelections) return [];
  if (Array.isArray(syrupSelections)) return syrupSelections; // legacy: all syrups shared
  return syrupSelections[drinkId] || [];
}

/**
 * Get syrup recommendations for a list of selected drink IDs.
 * Returns only syrups that are upgrades (not required base builds).
 */
export function getRecommendedSyrups(selectedDrinkIds) {
  const recommendations = [];
  const seen = new Set();

  for (const drinkId of selectedDrinkIds) {
    const mapping = DRINK_SYRUP_MAP[drinkId];
    if (!mapping || mapping.required) continue;

    for (const syrupId of mapping.syrups) {
      if (seen.has(syrupId)) continue;
      seen.add(syrupId);

      const syrup = SYRUPS.find(s => s.id === syrupId);
      if (!syrup) continue;

      // Collect all drinks that recommend this syrup
      const forDrinks = selectedDrinkIds
        .filter(did => {
          const m = DRINK_SYRUP_MAP[did];
          return m && !m.required && m.syrups.includes(syrupId);
        })
        .map(did => ({
          drinkId: did,
          note: DRINK_SYRUP_MAP[did]?.notes?.[syrupId] || null,
        }));

      recommendations.push({ ...syrup, forDrinks });
    }
  }

  return recommendations;
}
