process.env.NODE_ENV = 'test';
// The menu art generator's additive matcher fields (spec 2026-10-01 section
// 5.2): matchCustomNames hands back the candidate row it resolved to, and
// loadRecipeCandidates additionally selects id, description and kind. Pure:
// fixture rows and a stub db, no database.
//
// Run: node --test server/utils/shoppingListGen.matchRow.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchCustomNames, loadRecipeCandidates, buildPlannerGeneratorInput,
} = require('./shoppingListGen');
const { generateShoppingList } = require('./shoppingList');

const margarita = {
  id: 'margarita', kind: 'cocktail', name: 'Margarita', description: 'Tequila, lime, salt.',
  ingredients: [{ ingredient: 'Blanco Tequila', amount: 2, unit: 'oz' }], request_aliases: [],
};
const spicy = {
  id: 'spicy-margarita', kind: 'cocktail', name: 'Spicy Margarita', description: 'With a kick.',
  ingredients: [{ ingredient: 'tequila', amount: 2, unit: 'oz' }], request_aliases: ["Jenny's spicy marg"],
};
const nojito = {
  id: 'nojito', kind: 'mocktail', name: 'Nojito', description: 'Mint and lime.',
  ingredients: ['mint', 'lime'], request_aliases: [],
};

test('a matched entry carries row: the candidate object itself', () => {
  const candidates = [margarita, spicy, nojito];
  const { matched, needsRecipe } = matchCustomNames(['MARGARITA!!', 'nojito', 'Lavender Fizz'], candidates);
  assert.equal(matched.length, 2);
  assert.equal(matched[0].row, margarita);
  assert.equal(matched[1].row, nojito);
  assert.equal(matched[1].row.kind, 'mocktail');
  assert.deepEqual(needsRecipe, [{ name: 'Lavender Fizz' }]);
});

test('name and ingredients are unchanged on a matched entry', () => {
  const { matched } = matchCustomNames(['margarita'], [margarita]);
  assert.equal(matched[0].name, 'Margarita');
  assert.equal(matched[0].ingredients, margarita.ingredients);
  // A row with no ingredients still yields [] as before.
  const bare = { id: 'bare', kind: 'cocktail', name: 'Bare' };
  const { matched: m2 } = matchCustomNames(['bare'], [bare]);
  assert.deepEqual(m2[0].ingredients, []);
  assert.equal(m2[0].row, bare);
});

test('an alias hit carries the alias-owning row', () => {
  const { matched } = matchCustomNames(['jennys spicy marg'], [margarita, spicy]);
  assert.equal(matched[0].name, 'Spicy Margarita');
  assert.equal(matched[0].row, spicy);
  assert.equal(matched[0].row.id, 'spicy-margarita');
});

test('row is invisible to serialization, spread and deep equality', () => {
  const { matched } = matchCustomNames(['margarita'], [margarita]);
  assert.deepEqual(Object.keys(matched[0]), ['name', 'ingredients']);
  assert.equal(
    JSON.stringify(matched[0]),
    JSON.stringify({ name: 'Margarita', ingredients: margarita.ingredients })
  );
  assert.equal('row' in { ...matched[0] }, false);
  assert.deepStrictEqual(matched[0], { name: 'Margarita', ingredients: margarita.ingredients });
});

test('the persisted shopping-list blob is unchanged: _signatureCocktails carries no row', async () => {
  // buildPlannerGeneratorInput feeds matched customs into generateShoppingList,
  // whose _signatureCocktails rides the stored shopping_list JSONB.
  const fakeDb = {
    query: async (sql) => {
      if (sql.includes('FROM cocktails WHERE id')) return { rows: [] };
      if (sql.includes('FROM mocktails WHERE id')) return { rows: [] };
      if (sql.includes('UNION ALL')) return { rows: [margarita, spicy] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const plan = {
    client_name: 'X', guest_count: 100, event_date: null, admin_notes: '',
    serving_type: 'full_bar',
    selections: { signatureDrinks: [], customCocktails: ['Margarita', 'jennys spicy marg'] },
  };
  const input = await buildPlannerGeneratorInput(plan, fakeDb);
  const list = generateShoppingList(input, null);
  const stored = JSON.parse(JSON.stringify(list));
  assert.deepEqual(stored._signatureCocktails, [
    { name: 'Margarita', ingredients: margarita.ingredients },
    { name: 'Spicy Margarita', ingredients: spicy.ingredients },
  ]);
  assert.equal(JSON.stringify(list).includes('request_aliases'), false);
  assert.equal(JSON.stringify(list).includes('"row"'), false);
});

test('loadRecipeCandidates selects id, description and kind, keeps the tiebreak ORDER BY, returns rows as-is', async () => {
  let seenSql = null;
  const rows = [margarita, nojito];
  const stub = { query: async (sql, params) => { seenSql = sql; assert.equal(params, undefined); return { rows }; } };
  const out = await loadRecipeCandidates(stub);
  assert.equal(out, rows);
  const outer = seenSql.split('FROM (')[0];
  for (const col of ['id', 'name', 'description', 'ingredients', 'request_aliases', 'kind']) {
    assert.match(outer, new RegExp(`\\b${col}\\b`), `outer select lists ${col}`);
  }
  assert.match(seenSql, /1 AS src, 'cocktail' AS kind FROM cocktails/);
  assert.match(seenSql, /2 AS src, 'mocktail' AS kind FROM mocktails/);
  assert.match(seenSql, /ORDER BY is_active DESC NULLS LAST, created_at ASC, name ASC, src ASC/);
  // Still only drinks that carry a recipe, active or not.
  assert.equal((seenSql.match(/WHERE ingredients IS NOT NULL AND ingredients::text <> '\[\]'/g) || []).length, 2);
  assert.doesNotMatch(seenSql, /is_active\s*=/);
});
