export const SERVING_TYPES = [
  {
    key: 'full-bar-signature',
    label: 'Full Bar + Signature Drinks',
    description: 'Complete open bar including your custom drinks and all standard mixed drinks served.',
    modules: ['signature', 'full-bar'],
    emoji: '🍸',
  },
  {
    key: 'signature-beer-wine',
    label: 'Signature Drinks + Beer & Wine',
    description: 'Your custom cocktails, beer, and wine. No other liquor or mixed drinks served.',
    modules: ['signature', 'beer-wine'],
    emoji: '🍷',
  },
  {
    key: 'signature-matching-mixers',
    label: 'Signature Drinks + Matching Mixers',
    description: 'Your custom cocktails plus basic mixed drinks using those same spirits.',
    modules: ['signature'],
    emoji: '🧉',
  },
  {
    key: 'signature-only',
    label: 'Signature Drinks Only',
    description: 'Strictly your custom menu items only. No beer, wine, or other drinks served.',
    modules: ['signature'],
    emoji: '✨',
  },
  {
    key: 'beer-wine-only',
    label: 'Beer & Wine Only',
    description: 'Guests choose from the beers and wines you want — no cocktails required.',
    modules: ['beer-wine'],
    emoji: '🍺',
  },
  {
    key: 'mocktail',
    label: 'Mocktail / Non-Alcoholic Bar',
    description: '0% alcohol. Unique, handcrafted drinks suitable for all ages to enjoy.',
    modules: ['mocktail'],
    emoji: '🧃',
  },
];

/** Map module key to the step component name used in the orchestrator */
export const MODULE_STEP_MAP = {
  'signature': 'moduleSignature',
  'full-bar': 'moduleFullBar',
  'beer-wine': 'moduleBeerWine',
  'mocktail': 'moduleMocktail',
};
