// Add-on category display order and labels
export const ADDON_CATEGORIES = [
  { key: 'byob_support', label: 'BYOB Support Options', icon: '\ud83e\uddca', glyph: '\u2697', blurb: 'Ice, cups, mixers and garnishes, \u00e0 la carte' },
  { key: 'premium', label: 'Premium Enhancements', icon: '\u2728', glyph: '\u2726', blurb: 'Glass, bubbles, fanfare' },
  { key: 'beverage', label: 'Beverage Options', icon: '\ud83e\udd64', glyph: '\u25c9', blurb: 'Mocktails and non-alcoholic options' },
  { key: 'craft_ingredients', label: 'Craft Upgrades', icon: '\ud83e\uddea', glyph: '\u273a', blurb: 'Smoke, syrups, novelty' },
  { key: 'staffing', label: 'Staffing & Equipment', icon: '\ud83d\udc64', glyph: '\u273b', blurb: 'Extra hands at the bar' },
  { key: 'logistics', label: 'Event Logistics', icon: '\ud83d\udce6', glyph: '\u2b21', blurb: 'Parking and the practical details' },
];

// Per-addon placeholder icons (keyed by slug, replaceable with images later)
export const ADDON_ICONS = {
  'real-glassware': '\ud83e\udd43',
  'champagne-toast': '\ud83e\udd42',
  'champagne-coupe-upgrade': '\ud83c\udf77',
  'flavor-blaster-rental': '\ud83d\udca8',
  'soft-drink-addon': '\ud83e\udd64',
  'mocktail-bar': '\ud83c\udf79',
  'pre-batched-mocktail': '\ud83e\uddc3',
  'banquet-server': '\ud83e\udd35',
  'barback': '\ud83d\udc64',
  'parking-fee': '\ud83c\udd7f\ufe0f',
  'garnish-package-only': '\ud83c\udf4b',
  'handcrafted-syrups': '\ud83e\uddea',
  'handcrafted-syrups-3pack': '\ud83e\uddea',
  'the-foundation': '\ud83e\uddca',
  'the-formula': '\u2697\ufe0f',
  'the-full-compound': '\ud83d\udd2c',
  'ice-delivery-only': '\ud83e\uddca',
  'cups-disposables-only': '\ud83e\udd64',
  'bottled-water-only': '\ud83d\udca7',
  'signature-mixers-only': '\ud83c\udf78',
  'full-mixers-only': '\ud83c\udf78',
  'house-made-ginger-beer': '\ud83e\udeb5',
  'carbonated-cocktails': '\ud83e\uddeb',
  'smoked-cocktail-kit': '\ud83d\udd25',
  'additional-bartender': '\ud83c\udf78',
  'non-alcoholic-beer': '\ud83c\udf7a',
  'zero-proof-spirits': '\ud83e\udeb6',
};

// Add-ons to hide when a specific package is selected (redundant offerings)
export const PACKAGE_EXCLUDED_ADDONS = {
  'the-clear-reaction': ['mocktail-bar', 'pre-batched-mocktail'],
};
