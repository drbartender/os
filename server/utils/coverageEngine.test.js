// Pure-function tests for the coverage engine (no DB). Run:
//   node --test server/utils/coverageEngine.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildCatalogSlices } = require('./potionCatalog');
const { classify, mocktailAddonFor, toClassKey } = require('./coverageEngine');

// ─── Fixture catalog: a miniature par_items table ────────────────────
const PAR_ROWS = [
  { id: 'blanco-tequila', item: '1800 Blanco Tequila', size: '1.75L', qty_per_100: 4, section: 'liquorBeerWine', role: 'spirit', spirit_key: 'tequila', style_key: null, paired_spirits: [], ingredient_aliases: ['tequila', 'blanco tequila'], in_full_bar: true, is_active: true, sort_order: 1 },
  { id: 'triple-sec', item: 'Triple Sec', size: '1L', qty_per_100: 2, section: 'liquorBeerWine', role: 'spirit', spirit_key: null, style_key: null, paired_spirits: [], ingredient_aliases: ['triple sec', 'orange liqueur'], in_full_bar: true, is_active: true, sort_order: 2 },
  { id: 'lime-juice', item: 'Fresh Lime Juice', size: 'qt', qty_per_100: 2, section: 'everythingElse', role: 'mixer', spirit_key: null, style_key: null, paired_spirits: [], ingredient_aliases: ['lime juice', 'fresh lime', 'lime'], in_full_bar: true, is_active: true, sort_order: 1 },
  { id: 'simple-syrup', item: 'Simple Syrup', size: '750mL', qty_per_100: 1, section: 'everythingElse', role: 'mixer', spirit_key: null, style_key: null, paired_spirits: [], ingredient_aliases: ['simple syrup', 'simple'], in_full_bar: true, is_active: true, sort_order: 2 },
  { id: 'coffee-liqueur', item: 'Coffee Liqueur', size: '750mL', qty_per_100: 1, section: 'liquorBeerWine', role: 'spirit', spirit_key: null, style_key: null, paired_spirits: [], ingredient_aliases: ['coffee liqueur', 'kahlua'], in_full_bar: false, is_active: true, sort_order: 3 },
  { id: 'ginger-beer', item: 'Ginger Beer', size: '12 pack', qty_per_100: 1, section: 'everythingElse', role: 'mixer', spirit_key: null, style_key: null, paired_spirits: [], ingredient_aliases: ['ginger beer'], in_full_bar: false, is_active: true, sort_order: 3 },
];

const CATALOG = buildCatalogSlices(PAR_ROWS);

const MARGARITA = {
  ingredients: [
    { ingredient: 'tequila', amount: 2, unit: 'oz' },
    { ingredient: 'triple sec', amount: 0.75, unit: 'oz' },
    { ingredient: 'lime juice', amount: 1, unit: 'oz' },
  ],
};

// Enhanced-Solution-like package: tequila + triple sec + lime + simple.
const ENHANCED = {
  eligibleItemIds: ['blanco-tequila', 'triple-sec', 'lime-juice', 'simple-syrup'],
  catalog: CATALOG,
  classAddonMap: { coffee_liqueur: 'craft-coffee-addon', ginger_beer: 'house-made-ginger-beer' },
  addonPricing: [
    { slug: 'craft-coffee-addon', rate: '3.00', billing_type: 'per_guest' },
    { slug: 'house-made-ginger-beer', rate: '2.50', billing_type: 'per_guest' },
  ],
};

test('covered: every ingredient resolves to an eligible item', () => {
  const result = classify(MARGARITA, ENHANCED);
  assert.equal(result.status, 'covered');
  assert.deepEqual(result.gapAddonSlugs, []);
  assert.equal(result.gapPerGuest, null);
});

test('fenced: removing citrus from the package fences the margarita only if the gap is priced; unpriced gap = unmakeable (the F5 case)', () => {
  const noCitrus = { ...ENHANCED, eligibleItemIds: ['blanco-tequila', 'triple-sec', 'simple-syrup'] };
  // lime juice resolves to the lime-juice par row; no class prices it -> unmakeable
  const un = classify(MARGARITA, noCitrus);
  assert.equal(un.status, 'unmakeable');
  assert.deepEqual(un.missing, ['lime juice']);

  // price the class and the same drink becomes fenced at the addon rate
  const priced = {
    ...noCitrus,
    classAddonMap: { fresh_lime_juice: 'citrus-kit', lime_juice: 'citrus-kit' },
    addonPricing: [{ slug: 'citrus-kit', rate: '1.00', billing_type: 'per_guest' }],
  };
  const fenced = classify(MARGARITA, priced);
  assert.equal(fenced.status, 'fenced');
  assert.deepEqual(fenced.gapAddonSlugs, ['citrus-kit']);
  assert.equal(fenced.gapPerGuest, 1.0);
});

test('fenced: espresso-martini-style gap priced per guest via class map', () => {
  const espressoMartini = {
    ingredients: [
      { ingredient: 'tequila', amount: 1.5, unit: 'oz' }, // stand-in covered spirit
      { ingredient: 'coffee liqueur', amount: 1, unit: 'oz' },
    ],
  };
  const result = classify(espressoMartini, ENHANCED);
  assert.equal(result.status, 'fenced');
  assert.deepEqual(result.gapClasses, ['coffee_liqueur']);
  assert.deepEqual(result.gapAddonSlugs, ['craft-coffee-addon']);
  assert.equal(result.gapPerGuest, 3.0);
});

test('gap dedup: two ingredients hitting one class charge the addon once', () => {
  const doubleCoffee = {
    ingredients: [
      { ingredient: 'coffee liqueur', amount: 1, unit: 'oz' },
      'kahlua', // legacy string row, same par item, same class
    ],
  };
  const result = classify(doubleCoffee, ENHANCED);
  assert.equal(result.status, 'fenced');
  assert.equal(result.gapAddonSlugs.length, 1);
  assert.equal(result.gapPerGuest, 3.0);
});

test('no_recipe: empty or blank ingredient lists', () => {
  assert.equal(classify({ ingredients: [] }, ENHANCED).status, 'no_recipe');
  assert.equal(classify({ ingredients: ['', null] }, ENHANCED).status, 'no_recipe');
  assert.equal(classify({}, ENHANCED).status, 'no_recipe');
});

test('unmakeable: unresolvable ingredient with no class mapping', () => {
  const weird = { ingredients: [{ ingredient: 'unicorn tears', amount: 1, unit: 'oz' }] };
  const result = classify(weird, ENHANCED);
  assert.equal(result.status, 'unmakeable');
  assert.deepEqual(result.missing, ['unicorn tears']);
});

test('legacy string rows resolve through aliases like structured rows', () => {
  const stringMarg = { ingredients: ['tequila', 'triple sec', 'lime'] };
  assert.equal(classify(stringMarg, ENHANCED).status, 'covered');
});

test('mocktailAddonFor: the Jack rule (0 -> null, 1 -> pre-batched, 2+ -> mocktail bar)', () => {
  assert.equal(mocktailAddonFor(0), null);
  assert.equal(mocktailAddonFor(1), 'pre-batched-mocktail');
  assert.equal(mocktailAddonFor(2), 'mocktail-bar');
  assert.equal(mocktailAddonFor(7), 'mocktail-bar');
  assert.equal(mocktailAddonFor(undefined), null);
});

test('toClassKey normalizes to snake_case', () => {
  assert.equal(toClassKey('Coffee Liqueur'), 'coffee_liqueur');
  assert.equal(toClassKey('  Fresh  Lime-Juice '), 'fresh_lime_juice');
});
