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

const { SEED_ROWS, SNAPSHOTS, runFixtures, stripIds } = require('./potionCatalog.test.js');
const { buildCatalogSlices } = require('./potionCatalog');
const { generateShoppingList, buildGeneratorInputFromConsult } = require('./shoppingList');
const {
  loadCatalog, matchCustomNames, resolveDrinkIds, reportUnresolvedIngredients,
  buildPlannerGeneratorInput, buildDerivation, buildDerivationForPlan, applyAdminSetHolds,
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

// ─── Recipe quantity (par_items.recipe_qty_per_100) ─────────────────────────
// Margarita salt only reaches a list through a recipe, where the legacy policy
// bought 1 per 25 guests (4 at 100) plus 1 per extra drink. Every approved list
// in prod cut it back to one container by hand (admin_set, 2026-08/09), even
// with a Margarita AND a Paloma. A row's own recipe quantity replaces the rule
// and takes no per-drink +1; a row without one keeps the rule exactly. Rows
// arrive raw from pg, so NUMERIC is a string here, as in production.

const SALT_ROW = {
  id: 'margarita-salt', item: 'Margarita Salt', size: 'container', qty_per_100: '1',
  section: 'everythingElse', role: 'garnish', spirit_key: null, style_key: null,
  paired_spirits: [], ingredient_aliases: ['margarita salt'], in_full_bar: false,
  is_active: true, sort_order: 900, recipe_qty_per_100: '1',
};
const saltCatalog = (recipeQty) => buildCatalogSlices([...SEED_ROWS, { ...SALT_ROW, recipe_qty_per_100: recipeQty }]);
const saltDrink = (name) => ({ name, ingredients: [
  { ingredient: 'Blanco Tequila', amount: 2, unit: 'oz' },
  { ingredient: 'Margarita Salt', amount: 1, unit: 'each', note: 'rim' },
] });
const listFor = (guestCount, drinks, cat) => generateShoppingList({
  guestCount, serviceStyle: 'sig_beer_wine', signatureCocktails: drinks, mixersForSignatureDrinks: false,
}, cat);
const qtyOf = (list, item) => (list.everythingElse.find((i) => i.item === item) || {}).qty;

test('a row with its own recipe quantity buys that many per 100 guests, not 1 per 25', () => {
  const cat = saltCatalog('1');
  assert.equal(qtyOf(listFor(100, [saltDrink('Margarita')], cat), 'Margarita Salt'), 1, '100 guests: one container (was 4)');
  assert.equal(qtyOf(listFor(15, [saltDrink('Margarita')], cat), 'Margarita Salt'), 1, 'never below one');
  assert.equal(qtyOf(listFor(150, [saltDrink('Margarita')], cat), 'Margarita Salt'), 2, '150 guests: ceil(1.5)');
  assert.equal(qtyOf(listFor(150, [saltDrink('Margarita')], saltCatalog('0.5')), 'Margarita Salt'), 1, 'a fraction scales too');
});

test('a row with its own recipe quantity takes no +1 for a second drink that uses it', () => {
  const list = listFor(50, [saltDrink('Margarita'), saltDrink('Paloma')], saltCatalog('1'));
  assert.equal(qtyOf(list, 'Margarita Salt'), 1, 'plan 121 shape: Margarita + Paloma at 50 guests (was 3)');
  // The tequila the same two drinks share still gets the legacy +1.
  const tequila = list.liquorBeerWine.find((i) => i.item === '1800 Blanco Tequila');
  assert.equal(tequila.qty, 3, 'ceil(50/25)=2, +1 for the second drink');
});

test('a row without a recipe quantity keeps 1 per 25 guests plus the per-drink +1', () => {
  for (const unset of [null, undefined, '0', 'junk']) {
    const list = listFor(100, [saltDrink('Margarita'), saltDrink('Paloma')], saltCatalog(unset));
    assert.equal(qtyOf(list, 'Margarita Salt'), 5, `recipe_qty_per_100=${unset}: ceil(100/25)=4, +1`);
  }
  // A seed row that never had the column at all (the legacy shape).
  const mule = { name: 'Mule', ingredients: [{ ingredient: 'Ginger Beer', amount: 4, unit: 'oz' }] };
  assert.equal(qtyOf(listFor(100, [mule], catalog), 'Ginger Beer'), 4, 'ginger beer is untouched');
});

test('a set recipe quantity never changes a line another path already listed', () => {
  const withSet = buildCatalogSlices(SEED_ROWS.map((r) => (r.id === 'limes' ? { ...r, recipe_qty_per_100: '1' } : r)));
  const twoLimeDrinks = [
    { name: 'Daiquiri', ingredients: [{ ingredient: 'Lime wedge', amount: 1, unit: 'each' }] },
    { name: 'Gimlet', ingredients: [{ ingredient: 'lime wheel', amount: 1, unit: 'each' }] },
  ];
  const fullBar = (cat) => generateShoppingList({ guestCount: 100, serviceStyle: 'full_bar', signatureCocktails: twoLimeDrinks }, cat);
  // full_bar lists Limes from the baseline first, so the recipe merge only
  // boosts it: the same line, +1 for the second drink, whether or not it is set.
  assert.equal(qtyOf(fullBar(withSet), 'Limes'), qtyOf(fullBar(catalog), 'Limes'));
  // With no baseline the recipe is what adds Limes, so the set number decides.
  assert.equal(qtyOf(listFor(100, twoLimeDrinks, withSet), 'Limes'), 1);
});

// ─── No duplicate lines (a drink ingredient already on the list) ─────────────
// Every recipe merges LAST, against the complete baseline: an ingredient that
// is already a stock line (mixer, garnish, wine style, supply) gets no second
// line; the stock par stands, +1 per additional drink using it. The full_bar
// branch always worked this way; sig_beer_wine, consult and mocktails merged
// first and then pushed the baseline blind (prod plans 103, 106, 134).

function duplicateItems(list) {
  const dups = [];
  for (const section of ['liquorBeerWine', 'everythingElse']) {
    const seen = new Set();
    for (const line of list[section]) {
      const k = line.item.toLowerCase();
      if (seen.has(k)) dups.push(`${section}:${line.item}`);
      seen.add(k);
    }
  }
  return dups;
}

test('no fixture lists an item twice in a section (catalog and legacy paths)', () => {
  for (const cat of [catalog, null]) {
    const out = runFixtures(generateShoppingList, cat);
    for (const name of Object.keys(out)) {
      assert.deepEqual(duplicateItems(out[name]), [], `${name} (${cat ? 'catalog' : 'legacy'})`);
    }
  }
});

test('sig_beer_wine: a drink ingredient already on the list is not added again', () => {
  const spritz = {
    name: 'Spritz',
    ingredients: [
      { ingredient: 'Prosecco', amount: 3, unit: 'oz' },
      { ingredient: 'Soda Water', amount: 1, unit: 'oz' },
    ],
  };
  const rickey = {
    name: 'Rickey',
    ingredients: [
      { ingredient: 'Soda Water', amount: 4, unit: 'oz' },
      { ingredient: 'Lime wedge', amount: 1, unit: 'each' },
    ],
  };
  const out = generateShoppingList({
    guestCount: 100, serviceStyle: 'sig_beer_wine',
    signatureCocktails: [spritz, rickey], wineSelections: ['Sparkling'],
    mixersForSignatureDrinks: true,
  }, catalog);
  assert.deepEqual(duplicateItems(out), []);
  const line = (section, item) => out[section].filter(i => i.item === item);
  // Wine style par stands; the drink needs no extra line.
  assert.deepEqual(line('liquorBeerWine', 'Champagne').map(i => i.qty), [12]);
  // Stock mixer par 6, +1 because two drinks use it.
  assert.deepEqual(line('everythingElse', 'Club Soda').map(i => i.qty), [7]);
  assert.deepEqual(line('everythingElse', 'Limes').map(i => i.qty), [12]);
});

test('consult full mixers: a drink ingredient already on the list is not added again', () => {
  const input = buildGeneratorInputFromConsult({
    barType: 'sig_beer_wine', spirits: ['vodka'], beer: false, wine: [], mixers: 'full',
    customCocktails: [{ name: 'Mojito', ingredients: ['rum', 'simple syrup', 'soda water', 'lime wedge'] }],
    customMocktails: [], mocktailsEnabled: false, notes: '',
  }, { clientName: 'X', guestCount: 160, eventDate: '2026-08-01' }, [], []);
  const out = generateShoppingList(input, catalog);
  assert.deepEqual(duplicateItems(out), []);
  const qty = (item) => out.everythingElse.filter(i => i.item === item).map(i => i.qty);
  assert.deepEqual(qty('Simple Syrup'), [4]);
  assert.deepEqual(qty('Club Soda'), [10]);
  assert.deepEqual(qty('Limes'), [20]);
});

test('consult matching mixers: a paired mixer the drink also uses keeps its par', () => {
  // Matching mode never doubled (addMatchingMixers skips names already
  // listed), but the old order let the recipe line win at 1 per 25 guests.
  // Merge-last makes the par stand here too, as in every other branch.
  const input = buildGeneratorInputFromConsult({
    barType: 'sig_beer_wine', spirits: ['vodka'], beer: false, wine: [], mixers: 'matching',
    customCocktails: [{ name: 'Screwdriver', ingredients: ['vodka', 'orange juice'] }],
    customMocktails: [], mocktailsEnabled: false, notes: '',
  }, { clientName: 'X', guestCount: 120, eventDate: '2026-08-01' }, [], []);
  const out = generateShoppingList(input, catalog);
  assert.deepEqual(duplicateItems(out), []);
  assert.deepEqual(out.everythingElse.filter(i => i.item === 'Orange Juice').map(i => i.qty), [2]);
});

test('mocktails: a drink ingredient that is a stock supply is not added again', () => {
  const rows = SEED_ROWS.map(r => (r.id === 'water' ? { ...r, ingredient_aliases: ['still water'] } : r));
  const out = generateShoppingList({
    guestCount: 100, serviceStyle: 'mocktails',
    signatureCocktails: [{ name: 'Cucumber Cooler', ingredients: ['still water'] }],
  }, buildCatalogSlices(rows));
  assert.deepEqual(duplicateItems(out), []);
  assert.deepEqual(out.everythingElse.filter(i => i.item === 'Water').map(i => i.qty), [4]);
});

test('a self-provided syrup the recipes already put on the list is not added again', () => {
  const rows = SEED_ROWS.concat([{
    id: 'ginger-syrup', item: 'Ginger Syrup', size: '750mL', qty_per_100: '1',
    section: 'everythingElse', role: 'mixer', spirit_key: null, style_key: null,
    paired_spirits: [], ingredient_aliases: ['ginger syrup'], in_full_bar: false,
    is_active: true, sort_order: 400,
  }]);
  const out = generateShoppingList({
    guestCount: 100, serviceStyle: 'sig_beer_wine', mixersForSignatureDrinks: false,
    signatureCocktails: [{ name: 'Penicillin', ingredients: ['ginger syrup'] }],
    syrupSelfProvided: ['ginger'], syrupNamesById: { ginger: 'Ginger' },
  }, buildCatalogSlices(rows));
  assert.deepEqual(duplicateItems(out), []);
  // The recipe line (1 per 25 guests) already covers the self-provided bottle.
  assert.deepEqual(out.everythingElse.filter(i => i.item === 'Ginger Syrup').map(i => i.qty), [4]);

  // A stock syrup line below the self-provided count is raised, not doubled.
  const stock = buildCatalogSlices(rows.map(r => (r.id === 'ginger-syrup' ? { ...r, in_full_bar: true } : r)));
  const full = generateShoppingList({
    guestCount: 150, serviceStyle: 'full_bar',
    syrupSelfProvided: ['ginger'], syrupNamesById: { ginger: 'Ginger' },
  }, stock);
  assert.deepEqual(full.everythingElse.filter(i => i.item === 'Ginger Syrup').map(i => i.qty), [3]);
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

test('matchCustomNames: request_aliases keep matching after a rename', () => {
  const { matched, needsRecipe } = matchCustomNames(
    ["jenny's spicy MARG!!"],
    [{
      name: 'Spicy Margarita',
      ingredients: [{ ingredient: 'tequila', amount: 2, unit: 'oz' }],
      request_aliases: ["Jenny's spicy marg"],
    }]
  );
  assert.deepEqual(needsRecipe, []);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, 'Spicy Margarita');
});

test('matchCustomNames: a drink NAME beats another drink\'s alias', () => {
  const paloma = { name: 'Paloma', ingredients: [{ ingredient: 'tequila', amount: 2, unit: 'oz' }] };
  const squatter = {
    name: 'Grapefruit Thing',
    ingredients: [{ ingredient: 'vodka', amount: 2, unit: 'oz' }],
    request_aliases: ['Paloma'],
  };
  // Alias-carrying row listed FIRST so a single-pass index would wrongly win.
  const { matched } = matchCustomNames(['paloma'], [squatter, paloma]);
  assert.equal(matched[0].name, 'Paloma');
});

test('matchCustomNames: apostrophe variants match (jennys hits Jenny\'s)', () => {
  const { matched, needsRecipe } = matchCustomNames(
    ['jennys spicy marg'],
    [{
      name: 'Spicy Margarita',
      ingredients: [{ ingredient: 'tequila', amount: 2, unit: 'oz' }],
      request_aliases: ["Jenny's spicy marg"],
    }]
  );
  assert.deepEqual(needsRecipe, []);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, 'Spicy Margarita');
});

test('matchCustomNames: curly open quote and backtick strip like a straight apostrophe', () => {
  const jenny = { name: "Jenny's Lemonade", ingredients: ['lemon'] };
  const { matched, needsRecipe } = matchCustomNames(['jenny‘s lemonade', 'jenny`s lemonade'], [jenny]);
  assert.deepEqual(needsRecipe, []);
  assert.equal(matched.length, 2);
});

test('matchCustomNames: duplicate normalized names are first-wins (candidate order is the contract)', () => {
  const gin = { name: 'Twin Drink', ingredients: [{ ingredient: 'gin', amount: 2, unit: 'oz' }] };
  const rum = { name: 'TWIN DRINK', ingredients: [{ ingredient: 'rum', amount: 2, unit: 'oz' }] };
  const { matched } = matchCustomNames(['twin drink'], [gin, rum]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].ingredients[0].ingredient, 'gin');
});

test('matchCustomNames: rows without request_aliases behave exactly as before', () => {
  const { matched, needsRecipe } = matchCustomNames(
    ['Mystery Drink'],
    [{ name: 'Old Fashioned', ingredients: [{ ingredient: 'bourbon', amount: 2, unit: 'oz' }] }]
  );
  assert.deepEqual(matched, []);
  assert.deepEqual(needsRecipe, [{ name: 'Mystery Drink' }]);
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

// ─── pp2-quantity-review: derivation metadata + admin-set holds ──────────────

// The submit-time auto-gen list-build path, replicated exactly (build input ->
// generate -> conditionally attach _derivation). Proves the derivation is
// attached the same way the real autoGenerateShoppingList does it, without
// needing a live DB for the UPDATE.
async function buildListWithDerivation(plan, db) {
  const input = await buildPlannerGeneratorInput(plan, db);
  const list = generateShoppingList(input, catalog);
  const derivation = await buildDerivationForPlan(plan, db);
  if (derivation) list._derivation = derivation;
  return { list, input };
}

// A fake DB that serves the drink-resolution + settings queries the build path
// makes. No custom drinks here, so only the settings query actually fires.
function fakeDb(settingsRows = SETTINGS_ROWS) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM cocktails WHERE id')) return { rows: [] };
      if (sql.includes('FROM mocktails WHERE id')) return { rows: [] };
      if (sql.includes('FROM app_settings')) return { rows: settingsRows };
      if (sql.includes('UNION ALL')) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    },
  };
}

const SETTINGS_ROWS = [
  { key: 'pour_split_cocktails', value: '45' },
  { key: 'pour_split_beer', value: '30' },
  { key: 'pour_split_wine', value: '25' },
  { key: 'pour_pace_per_hour', value: '1.0' },
  { key: 'shopping_buffer_spirits', value: '1.25' },
  { key: 'shopping_buffer_mixers', value: '1.4' },
  { key: 'shopping_buffer_garnish', value: '1.5' },
  { key: 'shopping_buffer_supplies', value: '1.25' },
];

const LEGACY_PLAN = {
  client_name: 'Legacy Co', guest_count: 100, event_date: null, admin_notes: '',
  serving_type: 'full_bar', event_duration_hours: 4,
  // NO `crowd` key — every legacy plan + every consult plan.
  selections: { signatureDrinks: [], mocktails: [], customCocktails: [] },
};

test('ABSENT-SAFE: a plan without selections.crowd generates a byte-identical list (no derivation)', async () => {
  const db = fakeDb();
  // Baseline: the unchanged pure generator on the same input.
  const input = await buildPlannerGeneratorInput(LEGACY_PLAN, db);
  const baseline = generateShoppingList(input, catalog);

  // The full auto-gen build path (with the conditional derivation attach).
  const { list } = await buildListWithDerivation(LEGACY_PLAN, db);

  assert.equal(await buildDerivationForPlan(LEGACY_PLAN, db), null,
    'no crowd -> no derivation');
  assert.ok(!('_derivation' in list), 'no _derivation key attached');
  // stripIds normalizes the generator's inherent per-call random _id UUIDs
  // (the same normalization the snapshot suite uses); everything else must be
  // byte-identical to the unchanged pure generator's output.
  assert.deepEqual(stripIds(list), stripIds(baseline),
    'crowd-absent list is byte-identical to the unchanged pure generator output');
});

test('derivation is metadata only: identical crowd/no-crowd purchase quantities', async () => {
  const db = fakeDb();
  const crowdPlan = {
    ...LEGACY_PLAN,
    selections: {
      ...LEGACY_PLAN.selections,
      crowd: { drinkers: 60, unsure: false, profile: 'cocktail_forward' },
    },
  };
  const { list: withCrowd } = await buildListWithDerivation(crowdPlan, db);
  const { list: withoutCrowd } = await buildListWithDerivation(LEGACY_PLAN, db);

  assert.ok(withCrowd._derivation, 'crowd plan carries a derivation block');
  // The purchase quantities are IDENTICAL with and without the crowd answer:
  // demand drives display, never the par-scaled quantity math (v1 conservative
  // scope). stripIds normalizes the generator's per-call random row _ids (two
  // independent generate() calls mint fresh UUIDs); everything else must match.
  assert.deepEqual(stripIds(withCrowd).liquorBeerWine, stripIds(withoutCrowd).liquorBeerWine);
  assert.deepEqual(stripIds(withCrowd).everythingElse, stripIds(withoutCrowd).everythingElse);
});

test('buildDerivation reproduces the quantity-review canvas hand-math', () => {
  // Canvas: 100 guests, 60 drinkers, 4h, pace 1.0, cocktail_forward on 45/30/25
  // -> 240 pours, 55/25/20 split, cocktails 132 / beer 60 / wine 48.
  const d = buildDerivation({
    crowd: { drinkers: 60, unsure: false, profile: 'cocktail_forward' },
    guestCount: 100,
    hours: 4,
    settings: {
      pour_split_cocktails: '45', pour_split_beer: '30', pour_split_wine: '25',
      pour_pace_per_hour: '1.0',
      shopping_buffer_spirits: '1.25', shopping_buffer_mixers: '1.4',
      shopping_buffer_garnish: '1.5', shopping_buffer_supplies: '1.25',
    },
  });
  assert.equal(d.drinkers, 60);
  assert.equal(d.estimated, false);
  assert.equal(d.pours, 240);
  assert.deepEqual(d.splitPct, { cocktails: 55, beer: 25, wine: 20 });
  assert.deepEqual(d.split, { cocktails: 132, beer: 60, wine: 48 });
  assert.deepEqual(d.buffers, { spirits: 1.25, mixers: 1.4, garnish: 1.5, supplies: 1.25 });
  assert.equal(d.perCategory[0].text, '55% of 240 pours ≈ 132 cocktails');
});

test('buildDerivation: "not sure" drinkers uses the 75% fallback and flags estimated', () => {
  const d = buildDerivation({
    crowd: { drinkers: null, unsure: true, profile: 'even' },
    guestCount: 100, hours: 4, settings: {},
  });
  assert.equal(d.drinkers, 75, '75% of 100 guests');
  assert.equal(d.estimated, true);
  assert.equal(d.pours, 300);
});

test('buildDerivation returns null when the crowd question was never answered', () => {
  assert.equal(buildDerivation({ crowd: null, guestCount: 100, hours: 4 }), null);
  assert.equal(buildDerivation({ crowd: undefined, guestCount: 100, hours: 4 }), null);
});

test('buildDerivationForPlan tolerates a settings read failure (engine defaults)', async () => {
  const db = {
    query: async (sql) => {
      if (sql.includes('FROM app_settings')) throw new Error('db down');
      return { rows: [] };
    },
  };
  const plan = {
    guest_count: 100, event_duration_hours: 4, serving_type: 'full_bar',
    selections: { crowd: { drinkers: 60, unsure: false, profile: 'cocktail_forward' } },
  };
  const d = await buildDerivationForPlan(plan, db);
  // Defaults (45/30/25, pace 1.0) still produce the canvas numbers.
  assert.equal(d.pours, 240);
  assert.deepEqual(d.split, { cocktails: 132, beer: 60, wine: 48 });
});

test('applyAdminSetHolds: matched line keeps the held qty + marker, others regenerate', () => {
  const fresh = {
    liquorBeerWine: [
      { _id: 'a', item: "Tito's Vodka", size: '1.75L', qty: 2 },
      { _id: 'b', item: 'Bacardi Rum', size: '1.75L', qty: 2 },
    ],
    everythingElse: [
      { _id: 'c', item: 'Limes', size: 'ea.', qty: 17 },
    ],
  };
  const saved = {
    liquorBeerWine: [
      { _id: 'x', item: "Tito's Vodka", size: '1.75L', qty: 3, admin_set: true },
      { _id: 'y', item: 'Bacardi Rum', size: '1.75L', qty: 9 }, // not admin_set -> not held
    ],
    everythingElse: [
      { _id: 'z', item: 'Limes', size: 'ea.', qty: 20, admin_set: true },
    ],
  };
  const out = applyAdminSetHolds(fresh, saved);
  const vodka = out.liquorBeerWine.find(i => i.item === "Tito's Vodka");
  const rum = out.liquorBeerWine.find(i => i.item === 'Bacardi Rum');
  const limes = out.everythingElse.find(i => i.item === 'Limes');
  assert.equal(vodka.qty, 3, 'admin-set qty held');
  assert.equal(vodka.admin_set, true, 'marker carried');
  assert.equal(rum.qty, 2, 'non-admin-set line takes the fresh qty (not held)');
  assert.equal(limes.qty, 20, 'admin-set garnish held');
});

test('applyAdminSetHolds: an admin-added line with no fresh match is appended (survives)', () => {
  const fresh = { liquorBeerWine: [{ _id: 'a', item: 'Vodka', size: '1.75L', qty: 2 }], everythingElse: [] };
  const saved = {
    liquorBeerWine: [{ _id: 'x', item: 'Elderflower Liqueur', size: '750mL', qty: 2, admin_set: true }],
    everythingElse: [{ _id: 'y', item: '', size: '', qty: 1, admin_set: true }], // blank -> skipped
  };
  const out = applyAdminSetHolds(fresh, saved);
  assert.ok(out.liquorBeerWine.some(i => i.item === 'Elderflower Liqueur' && i.admin_set),
    'admin-added line survives the regenerate');
  assert.equal(out.everythingElse.length, 0, 'blank admin-set row is not re-appended');
});

test('applyAdminSetHolds: no-op when the saved list carries no admin_set lines', () => {
  const fresh = { liquorBeerWine: [{ _id: 'a', item: 'Vodka', size: '1.75L', qty: 4 }], everythingElse: [] };
  const saved = { liquorBeerWine: [{ _id: 'x', item: 'Vodka', size: '1.75L', qty: 9 }], everythingElse: [] };
  const out = applyAdminSetHolds(fresh, saved);
  assert.equal(out.liquorBeerWine[0].qty, 4, 'fresh qty untouched when nothing is held');
  // null/absent saved list is also a no-op.
  assert.deepEqual(applyAdminSetHolds(fresh, null), fresh);
});

// ─── serving_type is a label; activeModules is the truth (2026-09-14) ────────
// A legacy v1 "Custom Setup" plan stores serving_type 'custom', a label the
// generator never knew. It fell into the mocktails/unknown branch and read
// beer/wine from the beer-wine-only keys (empty on a full-bar plan), so a
// full-bar client's list shipped with no pars, no beer, no wine (plan 82,
// 2026-09-12). The generator style now derives from selections.activeModules
// whenever the stored label is not one of the four generator keys. Known keys
// and a null label keep today's behavior byte-for-byte.

const { plannerServiceStyle } = require('./shoppingListGen');

function labelledPlan(serving_type, activeModules, extra = {}) {
  return {
    client_name: 'Label Co', guest_count: 140, event_date: null, admin_notes: '',
    serving_type, event_duration_hours: 4,
    selections: {
      ...(activeModules ? { activeModules } : {}),
      signatureDrinks: [], mocktails: [], customCocktails: [],
      beerFromFullBar: ['Light / Easy Drinking', 'Craft / Local'],
      wineFromFullBar: ['Red', 'White'],
      beerFromBeerWine: ['Craft / Local'],
      wineFromBeerWine: ['Rosé'],
      ...extra,
    },
  };
}

const FULL_BAR_MODULES = { fullBar: true, signatureDrinks: true, mocktails: true, beerWineOnly: false };

test('custom label + fullBar modules generates exactly what the full_bar preset generates', async () => {
  const custom = labelledPlan('custom', FULL_BAR_MODULES);
  const preset = labelledPlan('full_bar', FULL_BAR_MODULES);
  const [customInput, presetInput] = await Promise.all([
    buildPlannerGeneratorInput(custom, fakeDb()),
    buildPlannerGeneratorInput(preset, fakeDb()),
  ]);
  assert.equal(customInput.serviceStyle, 'full_bar');
  assert.deepEqual(customInput.beerSelections, ['Light / Easy Drinking', 'Craft / Local'],
    'beer read from the full-bar keys, not the beer-wine-only keys');
  assert.deepEqual(customInput.wineSelections, ['Red', 'White']);
  assert.deepEqual(
    stripIds(generateShoppingList(customInput, catalog)),
    stripIds(generateShoppingList(presetInput, catalog)),
    'custom-labelled full-bar plan builds the same list as the preset'
  );
});

test('custom label derives every non-full-bar style from activeModules', () => {
  const style = (am) => plannerServiceStyle(labelledPlan('custom', am));
  assert.equal(style({ fullBar: false, signatureDrinks: true, mocktails: false, beerWineOnly: true }), 'sig_beer_wine');
  assert.equal(style({ fullBar: false, signatureDrinks: true, mocktails: true, beerWineOnly: false }), 'sig_beer_wine',
    'signature drinks with no beer/wine still get the mixer + garnish recipe');
  assert.equal(style({ fullBar: false, signatureDrinks: false, mocktails: false, beerWineOnly: true }), 'beer_wine');
  assert.equal(style({ fullBar: false, signatureDrinks: false, mocktails: true, beerWineOnly: false }), 'mocktails');
});

test('custom label + beer/wine modules reads beer and wine from the beer-wine keys', async () => {
  const plan = labelledPlan('custom', { fullBar: false, signatureDrinks: false, mocktails: false, beerWineOnly: true });
  const input = await buildPlannerGeneratorInput(plan, fakeDb());
  assert.equal(input.serviceStyle, 'beer_wine');
  assert.deepEqual(input.beerSelections, ['Craft / Local']);
  assert.deepEqual(input.wineSelections, ['Rosé']);
});

test('a known generator key wins over activeModules (v1 presets and every v2 plan unchanged)', () => {
  assert.equal(plannerServiceStyle(labelledPlan('beer_wine', FULL_BAR_MODULES)), 'beer_wine');
  assert.equal(plannerServiceStyle(labelledPlan('sig_beer_wine', FULL_BAR_MODULES)), 'sig_beer_wine');
  assert.equal(plannerServiceStyle(labelledPlan('mocktails', FULL_BAR_MODULES)), 'mocktails');
  assert.equal(plannerServiceStyle(labelledPlan('full_bar', null)), 'full_bar');
});

test('null label keeps the full_bar default even when activeModules is present (hosted v2 shape)', () => {
  assert.equal(plannerServiceStyle(labelledPlan(null, null)), 'full_bar');
  assert.equal(plannerServiceStyle(labelledPlan(undefined, null)), 'full_bar');
  const hosted = { fullBar: false, signatureDrinks: true, mocktails: true, beerWineOnly: false };
  assert.equal(plannerServiceStyle(labelledPlan(null, hosted)), 'full_bar');
});

test('an unknown label with no activeModules passes through unchanged (pre-modules legacy rows)', () => {
  assert.equal(plannerServiceStyle(labelledPlan('full-bar-signature', null)), 'full-bar-signature');
  assert.equal(plannerServiceStyle(labelledPlan('custom', null)), 'custom');
  assert.equal(plannerServiceStyle(labelledPlan('custom', 'not-an-object')), 'custom');
  assert.equal(plannerServiceStyle(labelledPlan('custom', {})), 'custom',
    'all-false modules derive nothing; the label passes through');
});

test('custom label + fullBar modules counts beer/wine from the full-bar keys in the derivation', async () => {
  const plan = labelledPlan('custom', FULL_BAR_MODULES, {
    crowd: { drinkers: 80, unsure: false, profile: 'even' },
  });
  const preset = { ...plan, serving_type: 'full_bar' };
  const [d, dPreset] = await Promise.all([
    buildDerivationForPlan(plan, fakeDb()),
    buildDerivationForPlan(preset, fakeDb()),
  ]);
  assert.ok(d, 'crowd answered -> derivation present');
  // The fixture's beer-wine keys hold ONE style each and the full-bar keys
  // TWO, so the per-drink split differs by key set: equality with the preset
  // proves the counts came from the full-bar keys.
  assert.deepEqual(d.perCategory, dPreset.perCategory,
    'custom-labelled full-bar plan derives the same per-drink split as the preset');
  const beer = d.perCategory.find((c) => c.category === 'beer');
  assert.equal(beer.perDrink, Math.round((beer.pours / 2) * 10) / 10, 'split across the two full-bar beer styles');
});

test('custom label + mocktails + beer/wine (no cocktails) keeps the mocktail recipes on the list', async () => {
  // CustomSetupStep lets a client toggle mocktails + beer or wine with liquor
  // and cocktails off. The beer_wine recipe never merges drink recipes, so
  // that shape must route through sig_beer_wine (which merges signature
  // cocktails AND mocktails, then beer/wine from the beer-wine keys).
  const am = { fullBar: false, signatureDrinks: false, mocktails: true, beerWineOnly: true };
  assert.equal(plannerServiceStyle(labelledPlan('custom', am)), 'sig_beer_wine');
  const shirley = { id: 'shirley', name: 'Pineapple Fizz', ingredients: [{ ingredient: 'pineapple juice', amount: 3, unit: 'oz' }] };
  const db = {
    query: async (sql) => {
      if (sql.includes('FROM cocktails WHERE id')) return { rows: [] };
      if (sql.includes('FROM mocktails WHERE id')) return { rows: [shirley] };
      if (sql.includes('FROM app_settings')) return { rows: SETTINGS_ROWS };
      if (sql.includes('UNION ALL')) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    },
  };
  // mixersForSignatureDrinks:false switches the basic-mixer slice off, so the
  // juice (a basic mixer in the seed catalog) can only arrive via the recipe.
  const input = await buildPlannerGeneratorInput(
    labelledPlan('custom', am, { mocktails: ['shirley'], mixersForSignatureDrinks: false }), db
  );
  assert.equal(input.serviceStyle, 'sig_beer_wine');
  assert.deepEqual(input.beerSelections, ['Craft / Local']);
  assert.deepEqual(input.wineSelections, ['Rosé']);
  const hasJuice = (l) => l.everythingElse.some((i) => i.item === 'Pineapple Juice');
  assert.ok(hasJuice(generateShoppingList(input, catalog)),
    'the selected mocktail\'s recipe ingredient is on the list');
  // Two controls prove the RECIPE MERGE put it there: the beer_wine recipe
  // (the old routing for this shape) drops it, and so does sig_beer_wine
  // with no drinks selected.
  assert.ok(!hasJuice(generateShoppingList({ ...input, serviceStyle: 'beer_wine' }, catalog)),
    'beer_wine would have dropped the mocktail ingredient');
  assert.ok(!hasJuice(generateShoppingList({ ...input, signatureCocktails: [] }, catalog)),
    'sig_beer_wine with no drinks does not stock it on its own');
});
