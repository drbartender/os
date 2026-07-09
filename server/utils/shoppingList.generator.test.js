// Lane potions-b behavior tests: the catalog-driven generator must reproduce
// the legacy generator's output byte-for-byte on the lane-A frozen snapshots
// (sole carve-out: consult matching-mixer ORDER, compared as multisets), plus
// coverage for the newly connected paths (planner customs, mocktail table
// fix, needsRecipe, fallback discipline).
//
// Requiring potionCatalog.test.js re-registers its 13 parity tests in this
// run — intentional; everything here is pure and DB-free.
//
// Run: node -r dotenv/config --test server/utils/shoppingList.generator.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { SEED_ROWS, SNAPSHOTS, runFixtures } = require('./potionCatalog.test.js');
const { buildCatalogSlices } = require('./potionCatalog');
const { generateShoppingList } = require('./shoppingList');
const {
  loadCatalog, matchCustomNames, resolveDrinkIds, reportUnresolvedIngredients,
} = require('./shoppingListGen');

const catalog = buildCatalogSlices(SEED_ROWS);

// The generator output gained two additive fields; snapshots predate them.
// Strip for the byte-parity comparison, assert them separately below.
function stripNewFields(list) {
  const { needsRecipe, _unresolvedIngredients, ...rest } = list;
  return rest;
}

function sortedByItem(rows) {
  return rows.slice().sort((a, b) => a.item.localeCompare(b.item) || String(a.size).localeCompare(String(b.size)));
}

test('catalog-driven generator reproduces every frozen snapshot (matching order excepted)', () => {
  const out = runFixtures(generateShoppingList, catalog);
  for (const name of Object.keys(SNAPSHOTS)) {
    const actual = stripNewFields(out[name]);
    const expected = SNAPSHOTS[name];
    if (name === 'consult_matching_120') {
      // Accepted delta (spec goal 6): identical CONTENT, order may differ.
      const { everythingElse: actEE, liquorBeerWine: actLBW, ...actRest } = actual;
      const { everythingElse: expEE, liquorBeerWine: expLBW, ...expRest } = expected;
      assert.deepEqual(actRest, expRest, `${name} scalar fields`);
      assert.deepEqual(actLBW, expLBW, `${name} liquorBeerWine`);
      assert.deepEqual(sortedByItem(actEE), sortedByItem(expEE), `${name} everythingElse as multiset`);
    } else {
      assert.deepEqual(actual, expected, `snapshot ${name}`);
    }
  }
});

test('legacy fallback path (no catalog) still reproduces every snapshot byte-identical', () => {
  const out = runFixtures(generateShoppingList, null);
  for (const name of Object.keys(SNAPSHOTS)) {
    assert.deepEqual(stripNewFields(out[name]), SNAPSHOTS[name], `fallback snapshot ${name}`);
  }
});

test('unresolved ingredients are collected, not silently dropped', () => {
  // House Mule's free-text 'lime' matches no alias (legacy dropped it too).
  const out = runFixtures(generateShoppingList, catalog);
  assert.deepEqual(out.consult_full_120._unresolvedIngredients,
    [{ drink: 'House Mule', ingredient: 'lime' }]);
  // Baseline-only fixture: nothing unresolved.
  assert.deepEqual(out.beer_wine_80._unresolvedIngredients, []);
});

test('needsRecipe passes through the generator untouched and defaults empty', () => {
  const withNeeds = generateShoppingList({
    guestCount: 100, serviceStyle: 'full_bar',
    needsRecipe: [{ name: 'Lavender Gin Fizz' }],
  }, catalog);
  assert.deepEqual(withNeeds.needsRecipe, [{ name: 'Lavender Gin Fizz' }]);
  const without = generateShoppingList({ guestCount: 100, serviceStyle: 'full_bar' }, catalog);
  assert.deepEqual(without.needsRecipe, []);
});

test('structured recipe rows merge with the size rule and note rows resolve via aliases', () => {
  const structuredDrink = {
    name: 'Test Margarita',
    ingredients: [
      { ingredient: 'Blanco Tequila', amount: 2, unit: 'oz' },
      { ingredient: 'Triple Sec', amount: 0.75, unit: 'oz' },      // no such row in lane-A seed -> unresolved
      { ingredient: 'Lime Juice', amount: 1, unit: 'oz' },
      { ingredient: 'Lime wedge', amount: 1, unit: 'each', note: 'garnish only' },
      { ingredient: 'Rum', amount: 0, unit: 'oz', override_item_id: 'malibu-coconut-rum' },
    ],
  };
  const out = generateShoppingList({
    guestCount: 100, serviceStyle: 'sig_beer_wine',
    signatureCocktails: [structuredDrink], mixersForSignatureDrinks: false,
  }, catalog);
  const lbw = out.liquorBeerWine.map(i => `${i.item}|${i.size}`);
  const ee = out.everythingElse.map(i => i.item);
  assert.ok(lbw.includes('1800 Blanco Tequila|750mL'), 'spirit added at 750mL per merge-size rule');
  assert.ok(lbw.includes('Malibu Coconut Rum|750mL'), 'override_item_id resolved');
  assert.ok(ee.includes('Lime Juice (UNSWEET)'), 'alias-resolved mixer added');
  assert.ok(ee.includes('Limes'), 'garnish alias resolved');
  assert.deepEqual(out._unresolvedIngredients, [{ drink: 'Test Margarita', ingredient: 'Triple Sec' }]);
});

test('shared structured ingredient across drinks boosts once (+1 per extra drink)', () => {
  const mule = { name: 'Mule', ingredients: [{ ingredient: 'Vodka', amount: 1.5, unit: 'oz' }] };
  const screwdriver = { name: 'Screwdriver', ingredients: [{ ingredient: 'vodka', amount: 1.5, unit: 'oz' }] };
  const out = generateShoppingList({
    guestCount: 100, serviceStyle: 'sig_beer_wine',
    signatureCocktails: [mule, screwdriver], mixersForSignatureDrinks: false,
  }, catalog);
  const titos = out.liquorBeerWine.find(i => i.item === "Tito's Vodka");
  // 100 guests: base ceil(100/25)=4, +1 for the second drink sharing it.
  assert.equal(titos.qty, 5);
  assert.equal(titos.size, '750mL');
});

test('matchCustomNames: normalized exact equality only, never fuzzy', () => {
  const candidates = [
    { name: 'Espresso Martini', ingredients: [{ ingredient: 'Vodka', amount: 1.5, unit: 'oz' }] },
    { name: 'Piña Colada', ingredients: [] },
  ];
  const { matched, needsRecipe } = matchCustomNames(
    ['espresso  martini!', 'Pina Colada', 'Espresso', 'Lavender Gin Fizz', '  '],
    candidates
  );
  // punctuation/whitespace-insensitive exact match
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, 'Espresso Martini');
  // 'Pina Colada' does NOT match 'Piña Colada' (ñ normalizes away as
  // punctuation, leaving 'pi a colada' vs 'pina colada'): conservative miss.
  // 'Espresso' is a prefix, not an exact match: miss. Blank string: skipped.
  assert.deepEqual(needsRecipe, [{ name: 'Pina Colada' }, { name: 'Espresso' }, { name: 'Lavender Gin Fizz' }]);
});

test('loadCatalog degrades to null on throwing or empty reads (fallback discipline)', async () => {
  const throwing = { query: async () => { throw new Error('relation "par_items" does not exist'); } };
  assert.equal(await loadCatalog(throwing), null);
  const empty = { query: async () => ({ rows: [] }) };
  assert.equal(await loadCatalog(empty), null);
  const good = { query: async () => ({ rows: SEED_ROWS }) };
  const cat = await loadCatalog(good);
  assert.equal(cat.isEmpty, false);
  assert.equal(cat.pars100.liquorBeerWine.length, 13);
});

test('resolveDrinkIds queries the allowlisted table and rejects unknown tables', async () => {
  const captured = [];
  const fake = { query: async (sql, params) => { captured.push({ sql, params }); return { rows: [{ id: 'virgin-mojito', name: 'Virgin Mojito', ingredients: [] }] }; } };
  const rows = await resolveDrinkIds(['virgin-mojito'], 'mocktails', fake);
  assert.ok(captured[0].sql.includes('FROM mocktails'), 'mocktail ids hit the mocktails table');
  assert.deepEqual(rows, [{ name: 'Virgin Mojito', ingredients: [] }]);
  await assert.rejects(() => resolveDrinkIds(['x'], 'users; DROP TABLE', {}), /unknown table/);
});

test('mocktails-only serving style merges recipe ingredients (gate finding 1)', () => {
  const virginMojito = {
    name: 'Virgin Mojito',
    ingredients: [
      { ingredient: 'Lime Juice', amount: 1, unit: 'oz' },
      { ingredient: 'Simple Syrup', amount: 0.75, unit: 'oz' },
      { ingredient: 'Club Soda', amount: 3, unit: 'oz' },
    ],
  };
  const out = generateShoppingList({
    guestCount: 100, serviceStyle: 'mocktail', signatureCocktails: [virginMojito],
  }, catalog);
  const items = out.everythingElse.map(i => i.item);
  assert.ok(items.includes('Lime Juice (UNSWEET)'), 'recipe mixer merged');
  assert.ok(items.includes('Club Soda'), 'recipe soda merged');
  assert.ok(items.includes('Ice'), 'supplies still ride');
  assert.equal(out.liquorBeerWine.length, 0, 'no liquor on a mocktails-only list');
});

test('paired mixer outside the full-bar baseline survives matching mode (gate finding 4)', () => {
  const rows = SEED_ROWS.concat([{
    id: 'yuzu-soda', item: 'Yuzu Soda', size: '4 pack', qty_per_100: '2',
    section: 'everythingElse', role: 'mixer', spirit_key: null, style_key: null,
    paired_spirits: ['vodka'], ingredient_aliases: [], in_full_bar: false,
    is_active: true, sort_order: 400,
  }]);
  const cat = buildCatalogSlices(rows);
  assert.ok(cat.spiritMixerPairings.vodka.includes('Yuzu Soda'), 'pairing derived');
  const out = generateShoppingList({
    guestCount: 100, mixerMode: 'matching', additionalSpirits: ['vodka'],
    signatureCocktails: [], beerSelections: [], wineSelections: [],
  }, cat);
  assert.ok(out.everythingElse.some(i => i.item === 'Yuzu Soda'),
    'non-baseline paired mixer included (was silently dropped)');
  // Baseline parity holds: the pairableItems slice changes nothing when all
  // paired rows are baseline (snapshot test above already proves it).
});

test("Peychaud's Bitters resolves to its own row, never Angostura (gate finding 3)", () => {
  const { resolveIngredient } = require('./potionCatalog');
  const rows = SEED_ROWS.concat([{
    id: 'peychauds-bitters', item: "Peychaud's Bitters", size: '10oz', qty_per_100: '1',
    section: 'liquorBeerWine', role: 'spirit', spirit_key: null, style_key: null,
    paired_spirits: [], ingredient_aliases: ['peychauds', 'peychaud', 'peychaud s bitters', 'peychauds bitters'],
    in_full_bar: false, is_active: true, sort_order: 300,
  }]);
  const cat = buildCatalogSlices(rows);
  assert.equal(resolveIngredient("Peychaud's Bitters", cat).item, "Peychaud's Bitters");
  assert.equal(resolveIngredient('peychauds bitters', cat).item, "Peychaud's Bitters");
  assert.equal(resolveIngredient('Peychauds', cat).item, "Peychaud's Bitters");
  // The generic alias still serves generic asks.
  assert.equal(resolveIngredient('bitters', cat).item, 'Angostura Bitters');
});

test('reportUnresolvedIngredients tolerates any list shape (no-throw)', () => {
  reportUnresolvedIngredients(null, 'test');
  reportUnresolvedIngredients({}, 'test');
  reportUnresolvedIngredients({ _unresolvedIngredients: [] }, 'test');
});

test('compound free text resolves to the head noun, not the longest flavor alias', () => {
  const { resolveIngredient } = require('./potionCatalog');
  // "cherry vodka" is a vodka: without head-noun preference the longer
  // 'cherry' alias (Premium Cherries) would win — a silently wrong bottle.
  assert.equal(resolveIngredient('cherry vodka', catalog).item, "Tito's Vodka");
  // Legacy insertion-order semantics preserved: 'whiskey sour' -> Sour Mix.
  assert.equal(resolveIngredient('whiskey sour', catalog).item, 'Sour Mix');
  // Exact matches are untouched by the fallback.
  assert.equal(resolveIngredient('cherry', catalog).item, 'Premium Cherries');
  // No token match falls back to longest-substring as before.
  assert.equal(resolveIngredient('cranberry cooler', catalog).item, 'Cranberry Juice');
});

test('planner customs dedup against already-selected drinks (no double count)', async () => {
  const { buildPlannerGeneratorInput } = require('./shoppingListGen');
  const margarita = { id: 'margarita', name: 'Margarita', ingredients: [{ ingredient: 'Blanco Tequila', amount: 2, unit: 'oz' }] };
  const fakeDb = {
    query: async (sql, params) => {
      if (sql.includes('FROM cocktails WHERE id')) return { rows: [margarita] };
      if (sql.includes('FROM mocktails WHERE id')) return { rows: [] };
      if (sql.includes('UNION ALL')) return { rows: [{ name: 'Margarita', ingredients: margarita.ingredients }, { name: 'Paper Plane', ingredients: [] }] };
      throw new Error('unexpected query: ' + sql);
    },
  };
  const plan = {
    client_name: 'X', guest_count: 100, event_date: null, admin_notes: '',
    serving_type: 'full_bar',
    selections: {
      signatureDrinks: ['margarita'],
      customCocktails: ['MARGARITA!!', 'Paper Plane', 'Lavender Gin Fizz'],
    },
  };
  const input = await buildPlannerGeneratorInput(plan, fakeDb);
  const names = input.signatureCocktails.map(d => d.name);
  // Margarita appears ONCE (selected wins; free-typed duplicate dropped).
  assert.deepEqual(names, ['Margarita', 'Paper Plane']);
  assert.deepEqual(input.needsRecipe, [{ name: 'Lavender Gin Fizz' }]);
});
