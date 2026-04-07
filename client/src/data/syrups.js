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
    syrups: ['honey', 'cherry-habanero'],
    notes: {
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
    syrups: ['passion-fruit'],
    notes: { 'passion-fruit': 'Tropical boost (orgeat still required)' },
  },
  'vodka-berry-lemonade': {
    syrups: ['mixed-berry'],
    notes: { 'mixed-berry': 'Included in base build' },
    required: true,
  },
};

/** Drinks that should never show syrup recommendations */
export const NO_SYRUP_DRINKS = [
  'martini', 'manhattan', 'sidecar', 'boulevardier',
  'black-manhattan', 'sazerac', 'corpse-reviver', 'last-word',
];

/**
 * Calculate syrup cost with 3-pack discount.
 * @param {number} count - Number of syrups selected
 * @returns {{ packs: number, singles: number, total: number }}
 */
export function calculateSyrupCost(count) {
  if (count <= 0) return { packs: 0, singles: 0, total: 0 };
  const packs = Math.floor(count / 3);
  const singles = count % 3;
  const total = packs * SYRUP_PRICE_3PACK + singles * SYRUP_PRICE_SINGLE;
  return { packs, singles, total };
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
