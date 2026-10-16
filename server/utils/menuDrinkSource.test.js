process.env.NODE_ENV = 'test';
// menuDrinkSource.js (spec 2026-10-01-menu-art-generator section 5.2, decision
// 8). Pure: fixture rows and stub db objects, no database.
//
// Run: node --test server/utils/menuDrinkSource.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { performance } = require('node:perf_hooks');

const {
  loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint, fingerprintHash,
  drinkKey, slugifyTyped,
} = require('./menuDrinkSource');
const { buildAlsoAtBar } = require('./menuAlsoAtBar');

// The route's piece-key pattern (spec 7): every drink key must pass it.
const PIECE_KEY = /^(background|(cocktail|mocktail|custom):[a-z0-9-]{1,100})$/;

const CATALOG_ROWS = [
  { kind: 'cocktail', id: 'margarita', name: 'Margarita', description: 'Tequila, lime and a salted rim.',
    ingredients: [{ ingredient: 'Blanco Tequila', amount: 2, unit: 'oz' }, { ingredient: 'Lime Juice', amount: 1, unit: 'oz' }] },
  { kind: 'cocktail', id: 'old-fashioned', name: 'Old Fashioned', description: 'Bourbon, bitters, orange peel.',
    ingredients: [{ ingredient: 'Bourbon', amount: 2, unit: 'oz' }] },
  { kind: 'cocktail', id: 'spicy-margarita', name: 'Spicy Margarita', description: 'Jalapeno tequila and lime.',
    ingredients: [{ ingredient: 'Tequila', amount: 2, unit: 'oz' }] },
  // Deactivated (soft-deleted), still carries its description.
  { kind: 'cocktail', id: 'retired-sour', name: 'Retired Sour', description: 'Off the menu, still poured.',
    ingredients: [{ ingredient: 'Whiskey', amount: 2, unit: 'oz' }] },
  // No recipe, so never a matcher candidate.
  { kind: 'cocktail', id: 'paloma', name: 'Paloma', description: 'Grapefruit and tequila.', ingredients: [] },
  { kind: 'mocktail', id: 'nojito', name: 'Nojito', description: 'Mint, lime and soda.', ingredients: ['mint', 'lime'] },
  { kind: 'mocktail', id: 'pink-lemonade', name: 'Pink Lemonade', description: 'Berry lemonade.', ingredients: ['lemon'] },
];
const ALIASES = { 'spicy-margarita': ["Jenny's spicy marg"] };
const CANDIDATE_ROWS = CATALOG_ROWS
  .filter((r) => r.ingredients.length > 0)
  .map((r) => ({
    id: r.id, name: r.name, description: r.description, ingredients: r.ingredients,
    request_aliases: ALIASES[r.id] || [], kind: r.kind,
  }));

function stubDb(handler) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); } };
}

function catalogDb() {
  return stubDb((sql) => (sql.includes('request_aliases') ? { rows: CANDIDATE_ROWS } : { rows: CATALOG_ROWS }));
}

let maps;
test.before(async () => { maps = await loadCatalogMaps(catalogDb()); });

const keys = (n) => n.drinks.map((d) => d.key);

// ─── Loaders ─────────────────────────────────────────────────────────────────

test('loadCatalogMaps keys every row by kind and id and ignores is_active', async () => {
  const db = catalogDb();
  const m = await loadCatalogMaps(db);
  assert.equal(m.catalogById.size, CATALOG_ROWS.length);
  assert.equal(m.catalogById.get('cocktail:margarita').name, 'Margarita');
  assert.equal(m.catalogById.get('mocktail:nojito').name, 'Nojito');
  assert.equal(m.catalogById.get('cocktail:nojito'), undefined);
  assert.equal(m.candidates, CANDIDATE_ROWS);
  const catalogSql = db.calls[0].sql;
  assert.match(catalogSql, /FROM cocktails/);
  assert.match(catalogSql, /FROM mocktails/);
  assert.doesNotMatch(catalogSql, /is_active/);
  assert.match(db.calls[1].sql, /request_aliases/);
});

test('loadCatalogMaps sends both queries before either one answers', async () => {
  const pending = [];
  const db = {
    calls: [],
    query(sql) {
      this.calls.push(sql);
      return new Promise((resolve) => {
        pending.push(() => resolve({ rows: sql.includes('request_aliases') ? CANDIDATE_ROWS : CATALOG_ROWS }));
      });
    },
  };
  const loading = loadCatalogMaps(db);
  assert.equal(db.calls.length, 2);   // one after the other would show 1 here
  for (const release of pending) release();
  const m = await loading;
  assert.equal(m.catalogById.size, CATALOG_ROWS.length);
  assert.equal(m.candidates, CANDIDATE_ROWS);
});

test('loadEventPlan reads the lowest-id plan for the proposal, parameterized, or null', async () => {
  const row = { id: 7, serving_type: 'full_bar', selections: {}, consult_selections: null, shopping_list_source: null };
  const db = stubDb(() => ({ rows: [row] }));
  assert.equal(await loadEventPlan(42, db), row);
  const { sql, params } = db.calls[0];
  assert.deepEqual(params, [42]);
  assert.match(sql, /WHERE proposal_id = \$1/);
  assert.match(sql, /ORDER BY id\s+LIMIT 1/);
  for (const col of ['selections', 'consult_selections', 'shopping_list_source', 'serving_type']) {
    assert.match(sql, new RegExp(`\\b${col}\\b`));
  }
  assert.equal(await loadEventPlan(43, stubDb(() => ({ rows: [] }))), null);
});

// ─── Sides ───────────────────────────────────────────────────────────────────

const PLANNER_PLAN = {
  id: 1,
  serving_type: 'full_bar',
  shopping_list_source: 'planner',
  client_name: 'Pat Example',
  selections: {
    signatureDrinks: ['margarita', 'old-fashioned'],
    customCocktails: ['Lavender Gin Fizz', 'Grandpa Joe\'s Punch'],
    mocktails: ['nojito'],
    beerFromFullBar: ['Light / Easy Drinking', 'IPA', 'Non-Alcoholic (Athletic Brewing)'],
    wineFromFullBar: ['Red', 'Other'],
    beerFromBeerWine: ['Seltzer'],          // stale key family: not poured
    wineFromBeerWine: ['Sparkling'],
    spirits: ['Vodka', 'Gin', 'Other'],
    spiritsOther: '  Mezcal ',
    menuStyle: 'custom',
    menuTheme: 'Garden party, blush and sage',
    drinkNaming: 'Name them after our dogs',
    menuDesignNotes: 'Script font please',
    _logoFilename: 'drink-plan-logos/1-1700000000000.png',
    companyLogo: '/api/drink-plans/t/abc/logo',
  },
  consult_selections: {
    signatureDrinks: ['spicy-margarita'], customCocktails: [], beer: false, wine: [],
  },
};

test('planner side: catalog picks, typed names and mocktails in order, with every field', () => {
  const n = normalizePlan(PLANNER_PLAN, maps);
  assert.equal(n.side, 'planner');
  assert.deepEqual(keys(n), [
    'cocktail:margarita', 'cocktail:old-fashioned',
    'custom:lavender-gin-fizz', 'custom:grandpa-joe-s-punch',
    'mocktail:nojito',
  ]);
  assert.deepEqual(n.drinks[0], {
    key: 'cocktail:margarita', group: 'sig', source: 'catalog', catalog_kind: 'cocktail',
    catalog_id: 'margarita', name: 'Margarita', description: 'Tequila, lime and a salted rim.',
    typed_name: null, ingredients: ['Blanco Tequila', 'Lime Juice'],
  });
  assert.deepEqual(n.drinks[2], {
    key: 'custom:lavender-gin-fizz', group: 'sig', source: 'custom', catalog_kind: null,
    catalog_id: null, name: 'Lavender Gin Fizz', description: null,
    typed_name: 'Lavender Gin Fizz', ingredients: [],
  });
  assert.equal(n.drinks[4].group, 'mock');
  assert.equal(n.drinks[4].catalog_kind, 'mocktail');
  assert.deepEqual(n.brief, {
    theme: 'Garden party, blush and sage', naming: 'Name them after our dogs', notes: 'Script font please',
  });
  assert.equal(n.plannerImageKey, 'drink-plan-logos/1-1700000000000.png');
  for (const k of keys(n)) assert.match(k, PIECE_KEY);
  // Only plan selections are read: nothing from the client row leaks in.
  assert.equal(JSON.stringify(n).includes('Pat Example'), false);
});

test('planner bar: the shopping list key family, NA split out, spiritsOther appended', () => {
  const n = normalizePlan(PLANNER_PLAN, maps);
  assert.deepEqual(n.bar, {
    beer: ['Light / Easy Drinking', 'IPA'],
    wine: ['Red', 'Other'],
    spirits: ['Vodka', 'Gin', 'Other', 'Mezcal'],
    na: ['Non-Alcoholic (Athletic Brewing)'],
  });
  // A beer-and-wine plan reads the BeerWine keys and stocks no spirits, even
  // with stale full-bar picks left behind (prod plan shape, 2026-10-16).
  const bw = normalizePlan({
    ...PLANNER_PLAN,
    serving_type: 'sig_beer_wine',
    selections: { ...PLANNER_PLAN.selections, beerFromBeerWine: ['Seltzer', 'Non-Alcoholic', 'None'] },
  }, maps);
  assert.deepEqual(bw.bar, { beer: ['Seltzer', 'None'], wine: ['Sparkling'], spirits: [], na: ['Non-Alcoholic'] });
});

// The real bar output through the real line builder (menuAlsoAtBar.js): the
// two modules agree on the shape with no translation step in between.
test('normalizePlan bar feeds buildAlsoAtBar: planner side', () => {
  assert.deepEqual(buildAlsoAtBar(normalizePlan(PLANNER_PLAN, maps).bar), [
    { label: 'Beer and Wine', text: 'Light beer, IPA, Red.' },
    { label: 'Spirits', text: 'Vodka, Gin, Mezcal.' },
    { label: 'Non-Alcoholic', text: 'Athletic Brewing NA.' },
  ]);
  const bw = normalizePlan({
    ...PLANNER_PLAN,
    serving_type: 'sig_beer_wine',
    selections: { ...PLANNER_PLAN.selections, beerFromBeerWine: ['Seltzer', 'Non-Alcoholic', 'None'] },
  }, maps);
  assert.deepEqual(buildAlsoAtBar(bw.bar), [
    { label: 'Beer and Wine', text: 'Seltzer, Sparkling.' },
    { label: 'Non-Alcoholic', text: 'Athletic Brewing NA.' },
  ]);
});

test('shopping_list_source null (and anything but consult) means the planner side', () => {
  for (const source of [null, undefined, 'planner', 'bogus']) {
    const n = normalizePlan({ ...PLANNER_PLAN, shopping_list_source: source }, maps);
    assert.equal(n.side, 'planner');
    assert.equal(n.drinks[0].key, 'cocktail:margarita');
  }
});

const CONSULT_PLAN = {
  id: 2,
  serving_type: 'full_bar',
  shopping_list_source: 'consult',
  selections: {
    signatureDrinks: ['margarita'],          // planner side: ignored for drinks
    menuTheme: '  Speakeasy  ',
    drinkNaming: null,
    menuDesignNotes: undefined,
  },
  consult_selections: {
    barType: 'full_bar',
    spirits: ['vodka', 'bourbon', 'mezcal'],
    signatureDrinks: ['old-fashioned'],
    customCocktails: [{ name: 'Smoky Rosemary Sour', ingredients: ['mezcal', 'lemon', { ingredient: 'rosemary syrup', amount: 0.5, unit: 'oz' }] }],
    mocktailsEnabled: true,
    mocktails: ['pink-lemonade'],
    customMocktails: [{ name: 'Cucumber Cooler', ingredients: ['cucumber', 'lime'] }],
    beer: true,
    wine: ['red', 'SPARKLING', 'rose'],
    mixers: 'full',
    notes: 'consult notes are not a brief',
  },
};

test('consult side: object customs with ingredients, customMocktails, beer boolean, lowercase wine, brief from selections', () => {
  const n = normalizePlan(CONSULT_PLAN, maps);
  assert.equal(n.side, 'consult');
  assert.deepEqual(keys(n), [
    'cocktail:old-fashioned', 'custom:smoky-rosemary-sour', 'mocktail:pink-lemonade', 'custom:cucumber-cooler',
  ]);
  assert.deepEqual(n.drinks.map((d) => d.group), ['sig', 'sig', 'mock', 'mock']);
  assert.deepEqual(n.drinks[1].ingredients, ['mezcal', 'lemon', 'rosemary syrup']);
  assert.equal(n.drinks[1].description, null);
  assert.deepEqual(n.drinks[3].ingredients, ['cucumber', 'lime']);
  assert.deepEqual(n.bar, {
    beer: ['Light / Easy Drinking', 'Craft / Local', 'IPA'],
    wine: ['Red', 'Sparkling'],
    spirits: ['Vodka', 'Bourbon', 'Mezcal'],
    na: [],
  });
  assert.deepEqual(n.brief, { theme: 'Speakeasy', naming: '', notes: '' });
  assert.equal(n.plannerImageKey, null);
});

test('normalizePlan bar feeds buildAlsoAtBar: consult side', () => {
  assert.deepEqual(buildAlsoAtBar(normalizePlan(CONSULT_PLAN, maps).bar), [
    { label: 'Beer and Wine', text: 'Light beer, Craft beer, IPA, Red, Sparkling.' },
    { label: 'Spirits', text: 'Vodka, Bourbon, Mezcal.' },
  ]);
  const dry = normalizePlan({
    ...CONSULT_PLAN,
    consult_selections: { ...CONSULT_PLAN.consult_selections, beer: false, wine: [], spirits: [] },
  }, maps);
  assert.deepEqual(buildAlsoAtBar(dry.bar), []);
});

test('consult mocktails count only with mocktailsEnabled or barType mocktails', () => {
  const base = { ...CONSULT_PLAN.consult_selections, mocktailsEnabled: false };
  const off = normalizePlan({ ...CONSULT_PLAN, consult_selections: base }, maps);
  assert.deepEqual(keys(off), ['cocktail:old-fashioned', 'custom:smoky-rosemary-sour']);
  const onlyMocks = normalizePlan({
    ...CONSULT_PLAN,
    consult_selections: { ...base, barType: 'mocktails', signatureDrinks: [], customCocktails: [] },
  }, maps);
  assert.deepEqual(keys(onlyMocks), ['mocktail:pink-lemonade', 'custom:cucumber-cooler']);
  // beer false and no wine render nothing.
  const dry = normalizePlan({ ...CONSULT_PLAN, consult_selections: { ...base, beer: false, wine: [], spirits: [] } }, maps);
  assert.deepEqual(dry.bar, { beer: [], wine: [], spirits: [], na: [] });
});

test('the order is sig picks, typed cocktails, mocktail picks, typed mocktails', () => {
  const n = normalizePlan({
    ...CONSULT_PLAN,
    consult_selections: {
      mocktailsEnabled: true,
      customMocktails: [{ name: 'Cucumber Cooler', ingredients: [] }],
      mocktails: ['nojito'],
      customCocktails: [{ name: 'House Punch', ingredients: [] }],
      signatureDrinks: ['margarita'],
    },
  }, maps);
  assert.deepEqual(keys(n), ['cocktail:margarita', 'custom:house-punch', 'mocktail:nojito', 'custom:cucumber-cooler']);
});

// ─── Matching and dedup ──────────────────────────────────────────────────────

test('a typed name that hits an alias becomes that catalog drink', () => {
  const n = normalizePlan({ ...PLANNER_PLAN, selections: { customCocktails: ['jennys SPICY marg!'] } }, maps);
  assert.equal(n.drinks.length, 1);
  assert.deepEqual(n.drinks[0], {
    key: 'cocktail:spicy-margarita', group: 'sig', source: 'catalog', catalog_kind: 'cocktail',
    catalog_id: 'spicy-margarita', name: 'Spicy Margarita', description: 'Jalapeno tequila and lime.',
    typed_name: 'jennys SPICY marg!', ingredients: ['Tequila'],
  });
});

test('a typed cocktail that names a mocktail keeps its group and takes the catalog kind', () => {
  const n = normalizePlan({ ...PLANNER_PLAN, selections: { customCocktails: ['NOJITO'] } }, maps);
  assert.equal(n.drinks[0].key, 'mocktail:nojito');
  assert.equal(n.drinks[0].group, 'sig');
  assert.equal(n.drinks[0].catalog_kind, 'mocktail');
});

test('a drink both picked and typed appears once, in the picked place', () => {
  const n = normalizePlan({
    ...PLANNER_PLAN,
    selections: {
      signatureDrinks: ['margarita', 'paloma'],
      customCocktails: ['MARGARITA!!', 'paloma', 'nojito'],   // paloma has no recipe: plain-name fold
      mocktails: ['nojito'],
    },
  }, maps);
  assert.deepEqual(keys(n), ['cocktail:margarita', 'cocktail:paloma', 'mocktail:nojito']);
  assert.equal(n.drinks[2].group, 'mock');
  assert.equal(n.drinks[0].typed_name, null);
});

test('two typed names with one slug are one drink, first kept', () => {
  const n = normalizePlan({
    ...PLANNER_PLAN,
    selections: { customCocktails: ['Blue Moon!', 'blue   moon', 'BLUE-MOON', 'Sunset'] },
  }, maps);
  assert.deepEqual(keys(n), ['custom:blue-moon', 'custom:sunset']);
  assert.equal(n.drinks[0].typed_name, 'Blue Moon!');
  assert.equal(n.drinks[0].name, 'Blue Moon!');
});

test('a repeated catalog id appears once', () => {
  const n = normalizePlan({ ...PLANNER_PLAN, selections: { signatureDrinks: ['margarita', 'margarita'] } }, maps);
  assert.deepEqual(keys(n), ['cocktail:margarita']);
});

test('an inactive catalog row keeps its name and description', () => {
  const n = normalizePlan({ ...PLANNER_PLAN, selections: { signatureDrinks: ['retired-sour'] } }, maps);
  assert.equal(n.drinks[0].key, 'cocktail:retired-sour');
  assert.equal(n.drinks[0].source, 'catalog');
  assert.equal(n.drinks[0].description, 'Off the menu, still poured.');
});

test('an id with no row at all becomes client-typed at the end of its group', () => {
  const n = normalizePlan({
    ...PLANNER_PLAN,
    selections: {
      signatureDrinks: ['ghost-drink', 'margarita'],
      customCocktails: ['Typed One'],
      mocktails: ['vanished-mock'],
    },
  }, maps);
  assert.deepEqual(keys(n), ['cocktail:margarita', 'custom:typed-one', 'custom:ghost-drink', 'custom:vanished-mock']);
  const ghost = n.drinks[2];
  assert.equal(ghost.source, 'custom');
  assert.equal(ghost.group, 'sig');
  assert.equal(ghost.typed_name, 'ghost-drink');
  assert.equal(n.drinks[3].group, 'mock');
});

test('a missing id that names a real drink resolves through the matcher', () => {
  const n = normalizePlan({ ...PLANNER_PLAN, selections: { signatureDrinks: ['spicy margarita'] } }, maps);
  assert.equal(n.drinks[0].key, 'cocktail:spicy-margarita');
});

test('null plan gives null; an empty plan gives no drinks', () => {
  assert.equal(normalizePlan(null, maps), null);
  const n = normalizePlan({ id: 3, selections: null, consult_selections: null, shopping_list_source: null }, maps);
  assert.deepEqual(n.drinks, []);
  assert.deepEqual(n.brief, { theme: '', naming: '', notes: '' });
  assert.equal(n.plannerImageKey, null);
});

// ─── Caps on client lists ────────────────────────────────────────────────────

const CAP = 50;
const many = (count, make) => Array.from({ length: count }, (_, i) => make(i));
// A 150-row candidate pool, so every matcher call does real work: uncapped,
// 10,000 ids per list here take seconds.
const BIG_MAPS = {
  catalogById: new Map(),
  candidates: many(150, (i) => ({
    id: `pool-${i}`, name: `Pool Drink ${i}`, description: '', ingredients: ['x'],
    request_aliases: [`pool alias ${i}`], kind: i % 2 ? 'mocktail' : 'cocktail',
  })),
};
const timed = (fn) => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};
const fromPrefix = (n, prefix) => n.drinks.filter((d) => (d.typed_name || '').startsWith(prefix)).length;

test('10,000 bogus ids normalize in well under 200 ms and each list yields at most the cap', (t) => {
  const plannerPlan = {
    ...PLANNER_PLAN,
    selections: {
      signatureDrinks: many(10000, (i) => `ghost-sig-${i}`),
      customCocktails: many(10000, (i) => `Typed Sig ${i}`),
      mocktails: many(10000, (i) => `ghost-mock-${i}`),
    },
  };
  const consultPlan = {
    ...CONSULT_PLAN,
    consult_selections: {
      mocktailsEnabled: true,
      signatureDrinks: many(10000, (i) => `ghost-sig-${i}`),
      customCocktails: many(10000, (i) => ({ name: `Typed Sig ${i}`, ingredients: ['lime'] })),
      mocktails: many(10000, (i) => `ghost-mock-${i}`),
      customMocktails: many(10000, (i) => ({ name: `Typed Mock ${i}`, ingredients: [] })),
    },
  };
  const planner = timed(() => normalizePlan(plannerPlan, BIG_MAPS));
  const consult = timed(() => normalizePlan(consultPlan, BIG_MAPS));
  t.diagnostic(`10,000 per list: planner ${planner.ms.toFixed(1)} ms, consult ${consult.ms.toFixed(1)} ms`);
  assert.ok(planner.ms < 200, `planner took ${planner.ms} ms`);
  assert.ok(consult.ms < 200, `consult took ${consult.ms} ms`);

  for (const n of [planner.value, consult.value]) {
    assert.equal(fromPrefix(n, 'ghost-sig-'), CAP);
    assert.equal(fromPrefix(n, 'ghost-mock-'), CAP);
    assert.equal(fromPrefix(n, 'Typed Sig '), CAP);
    // The first CAP of each list are the ones kept, in order.
    assert.equal(n.drinks.find((d) => d.typed_name === 'ghost-sig-0').group, 'sig');
    assert.equal(n.drinks.some((d) => d.typed_name === `ghost-sig-${CAP}`), false);
  }
  assert.equal(fromPrefix(consult.value, 'Typed Mock '), CAP);
  assert.equal(consult.value.drinks.length, 4 * CAP);
  assert.equal(planner.value.drinks.length, 3 * CAP);
});

test('20,000 spirits (and beer, and wine) cap at 50 items of at most 200 characters', (t) => {
  const long = 'L'.repeat(1000);
  const plannerPlan = {
    ...PLANNER_PLAN,
    selections: {
      spirits: [long, ...many(20000, (i) => `Spirit ${i}`)],
      spiritsOther: `  ${long}  `,
      beerFromFullBar: many(20000, (i) => `Beer ${i}`),
      wineFromFullBar: many(20000, (i) => `Wine ${i}`),
    },
  };
  const consultPlan = {
    ...CONSULT_PLAN,
    consult_selections: {
      beer: true,
      spirits: many(20000, (i) => `spirit${i}`),
      wine: many(20000, (i) => (i % 2 ? 'red' : `wine${i}`)),
      customCocktails: many(20000, (i) => ({ name: `Custom ${i}`, ingredients: ['lime'] })),
    },
  };
  const planner = timed(() => normalizePlan(plannerPlan, maps));
  const consult = timed(() => normalizePlan(consultPlan, maps));
  t.diagnostic(`20,000 per bar list: planner ${planner.ms.toFixed(1)} ms, consult ${consult.ms.toFixed(1)} ms`);
  assert.ok(planner.ms < 200, `planner took ${planner.ms} ms`);
  assert.ok(consult.ms < 200, `consult took ${consult.ms} ms`);

  const pb = planner.value.bar;
  assert.equal(pb.spirits.length, CAP);
  assert.equal(pb.spirits[0], 'L'.repeat(200));
  assert.equal(pb.spirits[CAP - 1], `Spirit ${CAP - 2}`);
  assert.equal(pb.beer.length, CAP);
  assert.equal(pb.wine.length, CAP);
  for (const list of Object.values(pb)) {
    for (const item of list) assert.ok(item.length <= 200);
  }
  const cb = consult.value.bar;
  assert.equal(cb.spirits.length, CAP);
  assert.equal(cb.spirits[0], 'Spirit0');
  assert.deepEqual(cb.wine, ['Red']);
  assert.deepEqual(cb.beer, ['Light / Easy Drinking', 'Craft / Local', 'IPA']);
  // spiritsOther is still read when the picks leave room.
  const withOther = normalizePlan({
    ...PLANNER_PLAN, selections: { spirits: ['Vodka'], spiritsOther: `  ${long}  ` },
  }, maps);
  assert.deepEqual(withOther.bar.spirits, ['Vodka', 'L'.repeat(200)]);
});

// ─── Keys and the slug fallback (Review Focus 1) ─────────────────────────────

const sha1x = (s) => `x${crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 8)}`;

test('slugifyTyped: lowercase, runs to one hyphen, trimmed, at most 60', () => {
  assert.equal(slugifyTyped('  Grandpa Joe\'s -- PUNCH!! '), 'grandpa-joe-s-punch');
  assert.equal(slugifyTyped('Señorita'), 'se-orita');
  const long = slugifyTyped(`${'a'.repeat(59)} bcd`);
  assert.equal(long, 'a'.repeat(59));                     // cut at 60, trailing hyphen trimmed
  assert.ok(slugifyTyped('word '.repeat(40)).length <= 60);
  assert.doesNotMatch(slugifyTyped('word '.repeat(40)), /-$/);
});

test('an emoji-only or non-Latin name falls back to x plus 8 hex of its SHA-1, never an empty slug', () => {
  assert.equal(slugifyTyped('🍹'), sha1x('🍹'));
  assert.equal(slugifyTyped('  🍹  '), sha1x('🍹'));
  assert.equal(slugifyTyped('日本酒'), sha1x('日本酒'));
  assert.match(slugifyTyped('!!!'), /^x[0-9a-f]{8}$/);
  assert.notEqual(slugifyTyped('🍹'), slugifyTyped('🍸'));
  const entry = { source: 'custom', typed_name: '🍹' };
  assert.equal(drinkKey(entry), `custom:${sha1x('🍹')}`);
  assert.notEqual(drinkKey(entry), 'custom:');

  const n = normalizePlan({ ...PLANNER_PLAN, selections: { customCocktails: ['🍹', '日本酒', '🍹'] } }, maps);
  assert.deepEqual(keys(n), [`custom:${sha1x('🍹')}`, `custom:${sha1x('日本酒')}`]);
  assert.equal(n.drinks[0].name, '🍹');
  for (const k of keys(n)) assert.match(k, PIECE_KEY);
});

test('drinkKey: catalog entries by kind and id, everything else by slug', () => {
  assert.equal(drinkKey({ source: 'catalog', catalog_kind: 'cocktail', catalog_id: 'margarita' }), 'cocktail:margarita');
  assert.equal(drinkKey({ source: 'catalog', catalog_kind: 'mocktail', catalog_id: 'nojito' }), 'mocktail:nojito');
  assert.equal(drinkKey({ source: 'custom', typed_name: 'House Punch' }), 'custom:house-punch');
  // A catalog entry missing its kind or id cannot claim a catalog key.
  assert.equal(drinkKey({ source: 'catalog', catalog_kind: null, catalog_id: 'x', name: 'Odd One' }), 'custom:odd-one');
});

// POST /api/cocktails stores a client-supplied id verbatim, so a catalog id
// can hold anything. Its key must still pass spec 7's piece-key pattern.
const sha1hex6 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 6);
const LONG_ID = 'Long_Name_'.repeat(15);   // 150 characters
const ODD_ROWS = [
  { kind: 'cocktail', id: 'Old_Fashioned', name: 'Underscore Fashioned', description: 'Odd id one.',
    ingredients: ['bourbon'], request_aliases: ['undies'] },
  { kind: 'cocktail', id: 'old fashioned', name: 'Spaced Fashioned', description: 'Odd id two.',
    ingredients: ['bourbon'], request_aliases: [] },
  { kind: 'cocktail', id: 'BIG!!', name: 'Big Bang', description: 'Odd id three.',
    ingredients: ['rum'], request_aliases: ['kaboom'] },
  { kind: 'mocktail', id: LONG_ID, name: 'Long Story', description: 'Odd id four.',
    ingredients: ['soda'], request_aliases: [] },
  { kind: 'mocktail', id: '🍹', name: 'Emoji Id', description: 'Odd id five.',
    ingredients: ['soda'], request_aliases: [] },
  { kind: 'cocktail', id: 'a'.repeat(150), name: 'Many As', description: 'Odd id six.',
    ingredients: ['gin'], request_aliases: [] },
];
const ODD_MAPS = {
  catalogById: new Map([...CATALOG_ROWS, ...ODD_ROWS].map((r) => [`${r.kind}:${r.id}`, r])),
  candidates: [...CANDIDATE_ROWS, ...ODD_ROWS],
};

test('a catalog id outside the piece-key pattern keys by a sanitized slug plus 6 hex of its SHA-1', () => {
  const key = (kind, id) => drinkKey({ source: 'catalog', catalog_kind: kind, catalog_id: id });
  assert.equal(key('cocktail', 'Old_Fashioned'), `cocktail:old-fashioned-${sha1hex6('Old_Fashioned')}`);
  assert.equal(key('cocktail', 'old fashioned'), `cocktail:old-fashioned-${sha1hex6('old fashioned')}`);
  assert.equal(key('cocktail', 'BIG!!'), `cocktail:big-${sha1hex6('BIG!!')}`);
  assert.equal(key('mocktail', '🍹'), `mocktail:x-${sha1hex6('🍹')}`);
  // Slugged to 149, cut to 90 (ending in a hyphen), trimmed to 89, then the suffix.
  assert.equal(key('mocktail', LONG_ID), `mocktail:${'long-name-'.repeat(9)}${sha1hex6(LONG_ID)}`);
  assert.equal(key('cocktail', 'a'.repeat(150)), `cocktail:${'a'.repeat(90)}-${sha1hex6('a'.repeat(150))}`);
  // Ids already in the pattern pass through untouched, numbers included.
  assert.equal(key('cocktail', 'old-fashioned'), 'cocktail:old-fashioned');
  assert.equal(key('cocktail', 42), 'cocktail:42');
  assert.equal(key('cocktail', 'a'.repeat(100)), `cocktail:${'a'.repeat(100)}`);
  // Two ids that sanitize alike stay two keys.
  assert.notEqual(key('cocktail', 'Old_Fashioned'), key('cocktail', 'old fashioned'));
  assert.notEqual(key('cocktail', 'Old_Fashioned'), key('cocktail', 'old-fashioned'));
});

test('every key the module emits passes spec 7, picked or matched, and catalog_id keeps the original id', () => {
  const n = normalizePlan({
    ...PLANNER_PLAN,
    selections: {
      signatureDrinks: ['Old_Fashioned', 'old fashioned', 'BIG!!', 'old-fashioned', 'a'.repeat(150)],
      // 'kaboom' is BIG!!'s alias: the matcher hit must fold into the pick by key.
      customCocktails: ['kaboom', 'undies', 'Long Story', 'emoji id', 'Typed Plain'],
      mocktails: [LONG_ID, '🍹'],
    },
  }, ODD_MAPS);
  for (const k of keys(n)) assert.match(k, PIECE_KEY);
  assert.equal(new Set(keys(n)).size, n.drinks.length);
  assert.deepEqual(n.drinks.map((d) => d.catalog_id), [
    'Old_Fashioned', 'old fashioned', 'BIG!!', 'old-fashioned', 'a'.repeat(150),
    null, LONG_ID, '🍹',
  ]);
  assert.equal(n.drinks[5].key, 'custom:typed-plain');
  for (const d of n.drinks.filter((e) => e.source === 'catalog')) {
    assert.equal(d.key, drinkKey({ source: 'catalog', catalog_kind: d.catalog_kind, catalog_id: d.catalog_id }));
  }
  // Every helper path too: the fingerprint carries the same keys.
  for (const k of buildFingerprint(n).drink_keys) assert.match(k, PIECE_KEY);
  for (const name of ['🍹', '日本酒', '!!!', 'x'.repeat(500), 'A_b C-d', '']) {
    assert.match(drinkKey({ source: 'custom', typed_name: name }), PIECE_KEY);
  }
});

// ─── Fingerprint ─────────────────────────────────────────────────────────────

function briefPlan(brief, logo) {
  return normalizePlan({
    ...PLANNER_PLAN,
    selections: {
      signatureDrinks: ['old-fashioned', 'margarita'],
      menuTheme: brief.theme, drinkNaming: brief.naming, menuDesignNotes: brief.notes,
      ...(logo === undefined ? {} : { _logoFilename: logo }),
    },
  }, maps);
}

test('fingerprint: drink keys sorted, per-field hashes, planner image key', () => {
  const fp = buildFingerprint(briefPlan({ theme: 'Speakeasy', naming: '', notes: 'Gold foil' }, 'drink-plan-logos/1-1.png'));
  assert.deepEqual(fp.drink_keys, ['cocktail:margarita', 'cocktail:old-fashioned']);
  assert.match(fp.brief_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(fp.brief_fields).sort(), ['naming', 'notes', 'theme']);
  assert.equal(fp.planner_image_key, 'drink-plan-logos/1-1.png');
});

test('brief hash: null equals empty equals whitespace, and internal runs collapse', () => {
  const a = buildFingerprint(briefPlan({ theme: null, naming: '', notes: '   \n\t ' }));
  const b = buildFingerprint(briefPlan({ theme: '', naming: undefined, notes: null }));
  assert.equal(a.brief_hash, b.brief_hash);
  assert.deepEqual(a.brief_fields, b.brief_fields);
  const c = buildFingerprint(briefPlan({ theme: 'Garden   party\n\nblush', naming: 'x', notes: '' }));
  const d = buildFingerprint(briefPlan({ theme: '  Garden party blush ', naming: ' x', notes: null }));
  assert.equal(c.brief_hash, d.brief_hash);
  // The three fields are not interchangeable.
  const e = buildFingerprint(briefPlan({ theme: 'x', naming: '', notes: '' }));
  const f = buildFingerprint(briefPlan({ theme: '', naming: 'x', notes: '' }));
  assert.notEqual(e.brief_hash, f.brief_hash);
});

test('one field changing moves only that field hash (and the brief hash)', () => {
  const base = buildFingerprint(briefPlan({ theme: 'Speakeasy', naming: 'Puns', notes: 'Gold' }));
  const edited = buildFingerprint(briefPlan({ theme: 'Speakeasy', naming: 'Dog names', notes: 'Gold' }));
  assert.notEqual(edited.brief_hash, base.brief_hash);
  assert.notEqual(edited.brief_fields.naming, base.brief_fields.naming);
  assert.equal(edited.brief_fields.theme, base.brief_fields.theme);
  assert.equal(edited.brief_fields.notes, base.brief_fields.notes);
  assert.deepEqual(edited.drink_keys, base.drink_keys);
});

test('planner_image_key follows _logoFilename: set, replaced, removed', () => {
  const brief = { theme: 'a', naming: 'b', notes: 'c' };
  const set = buildFingerprint(briefPlan(brief, 'drink-plan-logos/1-100.png'));
  const replaced = buildFingerprint(briefPlan(brief, 'drink-plan-logos/1-200.jpg'));
  const removed = buildFingerprint(briefPlan(brief));
  const blank = buildFingerprint(briefPlan(brief, ''));
  assert.equal(set.planner_image_key, 'drink-plan-logos/1-100.png');
  assert.equal(replaced.planner_image_key, 'drink-plan-logos/1-200.jpg');
  assert.equal(removed.planner_image_key, null);
  assert.equal(blank.planner_image_key, null);
  assert.equal(set.brief_hash, removed.brief_hash);
  assert.notEqual(fingerprintHash(set), fingerprintHash(replaced));
  assert.notEqual(fingerprintHash(set), fingerprintHash(removed));
});

test('fingerprintHash is stable across a JSONB round trip and moves with any part', () => {
  const fp = buildFingerprint(briefPlan({ theme: 'Speakeasy', naming: '', notes: '' }, 'drink-plan-logos/1-1.png'));
  // JSONB hands keys back reordered; the hash must not care.
  const reordered = {
    planner_image_key: fp.planner_image_key,
    brief_fields: { notes: fp.brief_fields.notes, theme: fp.brief_fields.theme, naming: fp.brief_fields.naming },
    drink_keys: [...fp.drink_keys].reverse(),
    brief_hash: fp.brief_hash,
  };
  assert.equal(fingerprintHash(reordered), fingerprintHash(fp));
  assert.match(fingerprintHash(fp), /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprintHash({ ...fp, drink_keys: [...fp.drink_keys, 'custom:new'] }), fingerprintHash(fp));
  assert.notEqual(fingerprintHash({ ...fp, brief_hash: 'other' }), fingerprintHash(fp));
});
