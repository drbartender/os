/**
 * Drink Upgrades — per-drink service addon mappings and champagne toast config.
 *
 * Service addon upgrades (carbonation, smoke, ginger beer) are billed per-event
 * via selections.addOns. Syrup recommendations are handled separately via
 * DRINK_SYRUP_MAP in client/src/data/syrups.js and stored in selections.syrupSelections.
 */

// --- Service addon upgrades (per-event billing via addOns state) ---
export const DRINK_UPGRADES = [
  {
    addonSlug: 'carbonated-cocktails',
    label: 'Sparkling Upgrade',
    emoji: '\u{1FAD7}',
    applicableDrinks: [
      'margarita', 'daiquiri', 'sidecar', 'cosmopolitan',
      'paloma', 'whiskey-sour', 'paper-plane', 'corpse-reviver', 'last-word',
    ],
    perDrinkPitch: {
      'margarita': 'Fresh carbonation \u2014 a sparkling margarita with effervescent citrus',
      'daiquiri': 'Carbonated at the bar \u2014 a fizzy, refreshing Daiquiri',
      'sidecar': 'Sparkling Sidecar \u2014 effervescent cognac and citrus',
      'cosmopolitan': 'Sparkling Cosmo \u2014 bubbly, bright, and balanced',
      'paloma': 'Fresh carbonation \u2014 extra fizz for the grapefruit bite',
      'whiskey-sour': 'Carbonated at the bar \u2014 a fizzy twist on the classic',
      'paper-plane': 'Sparkling Paper Plane \u2014 bright, bitter, and bubbly',
      'corpse-reviver': 'Sparkling Corpse Reviver \u2014 fizzy and hauntingly good',
      'last-word': 'Sparkling Last Word \u2014 herbaceous with a crisp finish',
    },
    defaultPitch: 'Fresh carbonation made live at the bar',
  },
  {
    addonSlug: 'house-made-ginger-beer',
    label: 'Craft Ginger Beer',
    emoji: '\u{1FAD0}',
    featured: true,
    selfProvidable: true,
    applicableDrinks: ['moscow-mule'],
    perDrinkPitch: {
      'moscow-mule': 'Hand-pressed ginger, citrus, and cane sugar \u2014 the real deal',
    },
    defaultPitch: 'House-made craft ginger beer',
  },
  {
    addonSlug: 'smoked-cocktail-kit',
    label: 'Smoked Cocktail',
    emoji: '\uD83D\uDD25',
    applicableDrinks: [
      'old-fashioned', 'manhattan', 'boulevardier', 'sazerac',
      'negroni', 'black-manhattan', 'whiskey-sour', 'amaretto-sour',
      'smokey-pina', 'mai-tai', 'paper-plane', 'last-word',
    ],
    perDrinkPitch: {
      'old-fashioned': 'Classic smoked presentation \u2014 enhances depth and warmth',
      'manhattan': 'Smoke adds richness and rounds out vermouth and whiskey',
      'boulevardier': 'Smoke softens bitterness and adds a layered finish',
      'sazerac': 'Smoke complements the absinthe and rye spice \u2014 mysterious and lingering',
      'negroni': 'Smoke balances bitterness and adds depth \u2014 best with citrus peel',
      'black-manhattan': 'Enhances herbal, amaro-driven complexity \u2014 deep and dark',
      'whiskey-sour': 'Light smoke adds contrast to citrus brightness \u2014 subtlety is key',
      'amaretto-sour': 'Smoke cuts sweetness and adds structure \u2014 almond meets wood',
      'smokey-pina': 'Torch smoke amplifies the grilled fruit vibe \u2014 mezcal + pineapple',
      'mai-tai': 'Toasted, tiki-adjacent layer \u2014 light, controlled smoke',
      'paper-plane': 'Smoke adds contrast to bright citrus and amaro \u2014 use lightly',
      'last-word': 'Subtle smoke adds intrigue \u2014 delicate and unexpected',
    },
    defaultPitch: 'Torch-smoked at the bar on demand',
  },
  {
    addonSlug: 'flavor-blaster-rental',
    label: 'Smoke Bubble',
    emoji: '\uD83D\uDCA8',
    requiresAddon: 'real-glassware',
    requiresAddonMessage: 'Aromatic finishing bubbles require proper glassware to form and present correctly. This enhancement is available with our real glassware upgrade.',
    applicableDrinks: [
      'old-fashioned', 'manhattan', 'black-manhattan', 'negroni',
      'boulevardier', 'sazerac', 'espresso-martini', 'amaretto-sour',
      'whiskey-sour', 'smokey-pina', 'martini', 'last-word', 'paper-plane',
    ],
    perDrinkPitch: {
      'old-fashioned': 'A smoke-filled bubble that bursts with aroma at first sip',
      'manhattan': 'Aromatic smoke bubble \u2014 a showstopper garnish',
      'black-manhattan': 'Smoke and amaro \u2014 dark, layered, unforgettable',
      'negroni': 'Smoke bubble \u2014 bitter, bold, and dramatic',
      'boulevardier': 'Smoke bubble \u2014 whiskey, bitters, and drama',
      'sazerac': 'Herbaceous smoke bubble \u2014 absinthe meets aroma',
      'espresso-martini': 'Coffee-infused smoke bubble \u2014 pure theater',
      'amaretto-sour': 'Aromatic bubble \u2014 almond and citrus in the air',
      'whiskey-sour': 'Citrus smoke bubble \u2014 bright and bold',
      'smokey-pina': 'Tropical smoke bubble \u2014 wood and island vibes',
      'martini': 'Aromatic bubble \u2014 elegant and unexpected',
      'last-word': 'Herbal smoke bubble \u2014 Chartreuse on the nose',
      'paper-plane': 'Citrus smoke bubble \u2014 bright, bitter, aromatic',
    },
    defaultPitch: 'Aromatic smoke bubble garnish',
    bubbleFlavors: {
      'old-fashioned': ['wood', 'lemon'],
      'manhattan': ['apple', 'wood'],
      'black-manhattan': ['wood', 'apple'],
      'negroni': ['lemon', 'apple'],
      'boulevardier': ['wood', 'lemon'],
      'sazerac': ['wood', 'lemon'],
      'espresso-martini': ['coffee', 'apple'],
      'amaretto-sour': ['apple', 'lemon'],
      'whiskey-sour': ['lemon', 'wood'],
      'smokey-pina': ['wood', 'apple'],
      'martini': ['lemon', 'apple'],
      'last-word': ['lemon', 'apple'],
      'paper-plane': ['lemon', 'apple'],
    },
  },
];

// --- Champagne toast config ---
export const CHAMPAGNE_TOAST = {
  addonSlug: 'champagne-toast',
  label: 'Champagne Toast',
  coupeUpgradeSlug: 'champagne-coupe-upgrade',
  servingStyles: [
    { value: 'passed', label: 'Passed on trays by staff' },
    { value: 'bar-pickup', label: 'Guests pick up at bar' },
    { value: 'pre-placed', label: 'Pre-placed at tables' },
    { value: 'undecided', label: 'Not sure yet \u2014 help me decide' },
  ],
};

// --- Helpers ---

/** Returns upgrade addons applicable to a specific drink */
export function getUpgradesForDrink(drinkId) {
  return DRINK_UPGRADES.filter(u => u.applicableDrinks.includes(drinkId));
}

/** Returns all unique upgrade addons applicable to any of the given drinks */
export function getUpgradesForDrinks(drinkIds) {
  return DRINK_UPGRADES.filter(u =>
    u.applicableDrinks.some(id => drinkIds.includes(id))
  );
}

/** Get pitch text for a specific upgrade + drink combo */
export function getPitch(upgrade, drinkId) {
  return upgrade.perDrinkPitch[drinkId] || upgrade.defaultPitch;
}
