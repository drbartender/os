// Quick-pick options (Screen 1)
export const QUICK_PICKS = [
  {
    key: 'full_bar',
    label: 'Full Bar Experience',
    description: 'Complete open bar with signature cocktails, spirits, beer & wine.',
    emoji: '\uD83C\uDF78',
    activeModules: { signatureDrinks: true, mocktails: false, fullBar: true, beerWineOnly: false },
  },
  {
    key: 'sig_beer_wine',
    label: 'Signature Drinks + Beer & Wine',
    description: 'Custom cocktails plus beer and wine. No other mixed drinks.',
    emoji: '\uD83C\uDF77',
    activeModules: { signatureDrinks: true, mocktails: false, fullBar: false, beerWineOnly: true },
  },
  {
    key: 'beer_wine',
    label: 'Beer & Wine Only',
    description: 'Curated beer and wine selection \u2014 no cocktails.',
    emoji: '\uD83C\uDF7A',
    activeModules: { signatureDrinks: false, mocktails: false, fullBar: false, beerWineOnly: true },
  },
  {
    key: 'mocktails',
    label: 'Mocktails Only',
    description: 'Non-alcoholic handcrafted drinks for all ages.',
    emoji: '\uD83E\uDDC3',
    activeModules: { signatureDrinks: false, mocktails: true, fullBar: false, beerWineOnly: false },
  },
  {
    key: 'custom',
    label: 'Custom Setup',
    description: 'Mix and match exactly what you want.',
    emoji: '\uD83E\uDDEA',
    activeModules: null, // routes to custom setup screen
  },
];

// fullBar split into fullBarSpirits + fullBarBeerWine
export const MODULE_ORDER = [
  'signatureDrinks',
  'mocktails',
  'fullBarSpirits',
  'fullBarBeerWine',
  'beerWineOnly',
  'menuDesign',
  'logistics',
];

// Map module key to step identifier used by orchestrator
export const MODULE_STEP_MAP = {
  signatureDrinks: 'stepSignatureDrinks',
  mocktails: 'stepMocktails',
  fullBarSpirits: 'stepFullBarSpirits',
  fullBarBeerWine: 'stepFullBarBeerWine',
  beerWineOnly: 'stepBeerWineOnly',
  menuDesign: 'stepMenuDesign',
  logistics: 'stepLogistics',
};

// Exploration phase steps
export const EXPLORATION_STEPS = [
  'stepVibe',
  'stepFlavorDirection',
  'stepExplorationBrowse',
  'stepMocktailInterest',
];

/** Build exploration step queue */
export function buildExplorationQueue() {
  return [...EXPLORATION_STEPS];
}

/** Build ordered step queue from activeModules (refinement phase) */
export function buildStepQueue(activeModules) {
  const steps = [];
  for (const mod of MODULE_ORDER) {
    if (mod === 'menuDesign' || mod === 'logistics') {
      steps.push(MODULE_STEP_MAP[mod]);
    } else if (mod === 'fullBarSpirits' || mod === 'fullBarBeerWine') {
      // Both fullBar sub-steps are included when fullBar is active
      if (activeModules.fullBar) {
        steps.push(MODULE_STEP_MAP[mod]);
      }
    } else if (activeModules[mod]) {
      if (mod === 'beerWineOnly' && activeModules.fullBar) continue;
      steps.push(MODULE_STEP_MAP[mod]);
    }
  }
  return steps;
}

// Phase derivation from proposal status
const EXPLORATION_STATUSES = ['sent', 'viewed', 'modified', 'accepted'];
const REFINEMENT_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];

export function derivePhase(proposalStatus) {
  if (!proposalStatus || EXPLORATION_STATUSES.includes(proposalStatus)) return 'exploration';
  if (REFINEMENT_STATUSES.includes(proposalStatus)) return 'refinement';
  return 'exploration';
}
