// Quick-pick options (Screen 1)
export const QUICK_PICKS = [
  {
    key: 'full_bar',
    label: 'Full Bar Experience',
    description: 'Complete open bar with signature cocktails, spirits, beer & wine.',
    emoji: '🍸',
    activeModules: { signatureDrinks: true, mocktails: false, fullBar: true, beerWineOnly: false },
  },
  {
    key: 'sig_beer_wine',
    label: 'Signature Drinks + Beer & Wine',
    description: 'Custom cocktails plus beer and wine. No other mixed drinks.',
    emoji: '🍷',
    activeModules: { signatureDrinks: true, mocktails: false, fullBar: false, beerWineOnly: true },
  },
  {
    key: 'beer_wine',
    label: 'Beer & Wine Only',
    description: 'Curated beer and wine selection — no cocktails.',
    emoji: '🍺',
    activeModules: { signatureDrinks: false, mocktails: false, fullBar: false, beerWineOnly: true },
  },
  {
    key: 'mocktails',
    label: 'Mocktails Only',
    description: 'Non-alcoholic handcrafted drinks for all ages.',
    emoji: '🧃',
    activeModules: { signatureDrinks: false, mocktails: true, fullBar: false, beerWineOnly: false },
  },
  {
    key: 'custom',
    label: 'Custom Setup',
    description: 'Mix and match exactly what you want.',
    emoji: '🧪',
    activeModules: null, // routes to custom setup screen
  },
];

// Module flow order
export const MODULE_ORDER = [
  'signatureDrinks',
  'syrupUpsell',
  'mocktails',
  'fullBar',
  'beerWineOnly',
  'menuDesign',
  'logistics',
];

// Map module key to step identifier used by orchestrator
export const MODULE_STEP_MAP = {
  signatureDrinks: 'stepSignatureDrinks',
  syrupUpsell: 'stepSyrupUpsell',
  mocktails: 'stepMocktails',
  fullBar: 'stepFullBar',
  beerWineOnly: 'stepBeerWineOnly',
  menuDesign: 'stepMenuDesign',
  logistics: 'stepLogistics',
};

/** Build ordered step queue from activeModules */
export function buildStepQueue(activeModules) {
  const steps = [];
  for (const mod of MODULE_ORDER) {
    if (mod === 'menuDesign' || mod === 'logistics') {
      steps.push(MODULE_STEP_MAP[mod]);
    } else if (mod === 'syrupUpsell') {
      if (activeModules.signatureDrinks) {
        steps.push(MODULE_STEP_MAP[mod]);
      }
    } else if (activeModules[mod]) {
      if (mod === 'beerWineOnly' && activeModules.fullBar) continue;
      steps.push(MODULE_STEP_MAP[mod]);
    }
  }
  return steps;
}
