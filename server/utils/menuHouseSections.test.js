process.env.NODE_ENV = 'test';
// server/utils/menuHouseSections.test.js
// PURE unit tests, no DB and no provider (spec 2026-10-19 section 9.3; plan
// lane menu-house-card). The server port and its client twin,
// client/src/pages/plan/data/menuSections.js, run on the same fixtures and
// must agree (the eventTypes.js pair precedent); the client file is loaded as
// the ES module it is. Then the house card's bar sections on each side, and
// the house drink entry.
//   node --test server/utils/menuHouseSections.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { extractMenuSections, houseSections, houseDrink, HOUSE_TITLE } = require('./menuHouseSections');
const { normalizePlan } = require('./menuDrinkSource');

const TWIN = path.join(__dirname, '../../client/src/pages/plan/data/menuSections.js');
const SERVER = path.join(__dirname, 'menuHouseSections.js');
const twin = () => import(pathToFileURL(TWIN).href);

const COCKTAILS = [{ id: 'old-fashioned', name: 'Old Fashioned' }, { id: 'paloma', name: 'Paloma' }];
const MOCKTAILS = [{ id: 'berry-spritz', name: 'Berry Spritz' }];

// [name, selections, activeModules]
const FIXTURES = [
  ['the full bar key family', { signatureDrinks: ['paloma'], beerFromFullBar: ['Light / Easy Drinking', 'Seltzer'], wineFromFullBar: ['Red', 'White'] }, { fullBar: true }],
  ['the beer and wine key family', { beerFromBeerWine: ['IPA'], wineFromBeerWine: ['Sparkling', 'Other'] }, { beerWineOnly: true }],
  ['both key families merged', { beerFromFullBar: ['Seltzer'], beerFromBeerWine: ['Craft / Local'], wineFromFullBar: ['White'], wineFromBeerWine: ['Red'] }, {}],
  ['a Non-Alcoholic pick rolls into Beer', { beerFromFullBar: ['Non-Alcoholic'] }, {}],
  ['the Athletic pick rolls into Beer too', { beerFromBeerWine: ['Non-Alcoholic (Athletic Brewing)', 'Seltzer'] }, {}],
  ['a full bar with no signatures is Call Drinks', { spirits: ['Vodka', 'Gin'], wineFromFullBar: ['Red'] }, { fullBar: true }],
  ['spirits are never listed', { signatureDrinks: ['old-fashioned'], spirits: ['Vodka', 'Tequila'], spiritsOther: 'Mezcal' }, { fullBar: true }],
  ['cocktails and mocktails resolve by id, repeats once, unknown ids dropped', { signatureDrinks: ['paloma', 'paloma', 'nope'], mocktails: ['berry-spritz'] }, {}],
  ['nothing picked', {}, {}],
  ['no active modules at all', { beerFromFullBar: ['IPA'] }, undefined],
  // The planner's None checkbox stores the one-item list ['None'] (FullBarBeerWineStep.js, BeerWineStep.js): no pick.
  ['a beer pick of None beside a wine pick', { beerFromBeerWine: ['None'], wineFromBeerWine: ['White'] }, { beerWineOnly: true }],
  ['beer None with wine None', { beerFromFullBar: ['None'], wineFromFullBar: ['None'] }, {}],
  ['the full bar family: beer None beside Red', { signatureDrinks: ['paloma'], beerFromFullBar: ['None'], wineFromFullBar: ['Red'] }, { fullBar: true }],
];

test('parity: the server port and the client file give the same sections on every fixture', async () => {
  const C = await twin();
  for (const [name, selections, modules] of FIXTURES) {
    assert.deepEqual(extractMenuSections(selections, modules, COCKTAILS, MOCKTAILS),
      C.extractMenuSections(selections, modules, COCKTAILS, MOCKTAILS), name);
  }
});

test('the fixtures say what the Standard Menu card says', () => {
  const run = (i) => extractMenuSections(FIXTURES[i][1], FIXTURES[i][2], COCKTAILS, MOCKTAILS).sections;
  assert.deepEqual(run(2), [{ kind: 'beer-wine', title: 'Beer & Wine', items: ['Beer', 'Seltzer', 'Red', 'White'] }]);
  assert.deepEqual(run(3), [{ kind: 'beer-wine', title: 'Beer & Wine', items: ['Beer'] }]);
  assert.deepEqual(run(5).map((s) => [s.kind, s.items]), [['beer-wine', ['Red']], ['bar-service', ['Call Drinks']]]);
  assert.deepEqual(run(6).map((s) => s.kind), ['cocktails'], 'no spirits section, ever');
  assert.deepEqual(run(7).map((s) => [s.kind, s.items]), [['cocktails', ['Paloma']], ['mocktails', ['Berry Spritz']]]);
  assert.deepEqual(extractMenuSections({}, {}, [], []), { sections: [], isEmpty: true });
  // A beer pick of None is no pick: it adds no Beer, and a section with no labels is not printed.
  assert.deepEqual(run(10), [{ kind: 'beer-wine', title: 'Beer & Wine', items: ['White'] }]);
  assert.deepEqual(run(11), [], 'a client who declined beer and wine gets no Beer & Wine section');
  assert.deepEqual(run(12).map((s) => [s.kind, s.items]), [['cocktails', ['Paloma']], ['beer-wine', ['Red']]]);
});

test('the house card prints no Beer for a client who declined beer', () => {
  const declined = planRow({ signatureDrinks: ['paloma'], beerFromFullBar: ['None'], wineFromFullBar: ['None'], activeModules: { fullBar: true } });
  assert.deepEqual(houseSections(declined, normalizePlan(declined)), []);
  const wineOnly = planRow({ signatureDrinks: ['paloma'], beerFromFullBar: ['None'], wineFromFullBar: ['Sparkling'], activeModules: { fullBar: true } });
  assert.deepEqual(houseSections(wineOnly, normalizePlan(wineOnly)), [{ kind: 'beer-wine', title: 'Beer & Wine', items: ['Sparkling'] }]);
});

test('each twin names the other in its header', () => {
  const head = (file) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const end = lines.findIndex((l) => !l.startsWith('//'));
    return lines.slice(0, end === -1 ? lines.length : end).join('\n');
  };
  assert.match(head(TWIN), /server\/utils\/menuHouseSections\.js/);
  assert.match(head(SERVER), /client\/src\/pages\/plan\/data\/menuSections\.js/);
});

test('a malformed selections list reads as none on the server, never throws', () => {
  const sel = { beerFromFullBar: 'IPA', wineFromFullBar: 5, signatureDrinks: { a: 1 }, mocktails: null };
  assert.deepEqual(extractMenuSections(sel, { fullBar: true }, COCKTAILS, MOCKTAILS).sections,
    [{ kind: 'bar-service', title: 'Bar Service', items: ['Call Drinks'] }]);
  assert.deepEqual(extractMenuSections(null, null, null, null), { sections: [], isEmpty: true });
});

// ── The house card's bar sections (houseSections) ──────────────────────────
const planRow = (selections, extra = {}) => ({ id: 1, serving_type: null, selections, consult_selections: null, shopping_list_source: 'planner', ...extra });

test('planner side: the Standard Menu bar wording only; cocktails and mocktails come from the drafts drinks, not here', () => {
  const plan = planRow({
    signatureDrinks: ['paloma'], mocktails: ['berry-spritz'], beerFromFullBar: ['Non-Alcoholic', 'Seltzer'],
    wineFromBeerWine: ['Red'], spirits: ['Vodka'], activeModules: { fullBar: true },
  });
  assert.deepEqual(houseSections(plan, normalizePlan(plan)), [{ kind: 'beer-wine', title: 'Beer & Wine', items: ['Beer', 'Seltzer', 'Red'] }]);
  const callDrinks = planRow({ customCocktails: ['Lavender Fizz'], spirits: ['Gin'], activeModules: { fullBar: true } });
  assert.deepEqual(houseSections(callDrinks, normalizePlan(callDrinks)), [{ kind: 'bar-service', title: 'Bar Service', items: ['Call Drinks'] }],
    "Call Drinks keys on the plan's signature picks, as the Standard Menu card does");
  assert.deepEqual(houseSections(planRow({ customCocktails: ['A'] }), normalizePlan(planRow({ customCocktails: ['A'] }))), []);
});

test("consult side: the consult bar's labelled lines, word by word, spirits never listed", () => {
  const plan = planRow({ beerFromFullBar: ['IPA'], activeModules: { fullBar: true } }, {
    shopping_list_source: 'consult',
    consult_selections: { signatureDrinks: [], beer: true, wine: ['red', 'sparkling'], spirits: ['vodka', 'gin'] },
  });
  assert.deepEqual(houseSections(plan, normalizePlan(plan)), [
    { kind: 'bar-line', title: 'Beer and Wine', items: ['Light beer', 'Craft beer', 'IPA', 'Red', 'Sparkling'] },
  ], 'the planner picks are not read on the consult side');
  const dry = planRow({}, { shopping_list_source: 'consult', consult_selections: { beer: false, wine: [], spirits: ['rum'] } });
  assert.deepEqual(houseSections(dry, normalizePlan(dry)), []);
});

test('no plan reads no sections', () => {
  assert.deepEqual(houseSections(null, null), []);
});

// ── The house drink entry (houseDrink) ─────────────────────────────────────
test('a house drink is its own name, no description, no art, with spec 6 thirteen fields', () => {
  const catalog = { key: 'cocktail:paloma', group: 'sig', source: 'catalog', catalog_kind: 'cocktail', catalog_id: 'paloma', name: 'Paloma', description: 'Tequila and grapefruit.' };
  assert.deepEqual(houseDrink(catalog), {
    key: 'cocktail:paloma', source: 'catalog', catalog_kind: 'cocktail', group: 'sig', catalog_id: 'paloma',
    display_name: 'Paloma', description: null, name_ai_suggested: false, description_ai_written: false, visual_note: '',
    hidden: false, has_art: false, added_by_sync: false,
  });
  const typed = { key: 'custom:x', group: 'mock', source: 'custom', catalog_kind: null, catalog_id: null, name: `  ${'N'.repeat(70)} `, description: null };
  const t = houseDrink(typed, { addedBySync: true });
  assert.equal(t.display_name, 'N'.repeat(60), 'cut to the PATCH name limit');
  assert.deepEqual([t.source, t.group, t.catalog_kind, t.added_by_sync, t.has_art], ['custom', 'mock', null, true, false]);
  assert.equal(houseDrink({ key: 'custom:y', name: '' }).display_name, 'custom:y', 'a blank name falls back to the key');
  assert.equal(HOUSE_TITLE, 'The Bar Menu');
});

// ── The house card's plan-changed baseline (draftFingerprint) ──────────────
// Spec 2026-10-19 sections 9.2 and 17: what is compared is what the menu
// prints. A house draft prints its bar sections, never the "Also at the bar"
// lines, so its bar baseline is the sections, one entry per printed section,
// stamped and read through one helper (Generate, the fill, Update draft and
// the read model). A custom draft's is buildFingerprint's, unchanged.
const { draftFingerprint } = require('./menuHouseSections');
const { buildFingerprint, foldReviewed } = require('./menuDrinkSource');
const { keyedBarLines } = require('./menuAlsoAtBar');
const read = require('./menuDraftRead');

const BAR = { beerFromFullBar: ['IPA'], wineFromFullBar: ['Red'], spirits: ['Vodka'], activeModules: { fullBar: true } };
const plannerPlan = (over = {}) => planRow({ customCocktails: ['Lavender Fizz', 'Rum Punch'], ...BAR, ...over });
const consultPlan = (over = {}) => planRow({ menuStyle: 'house' }, {
  shopping_list_source: 'consult',
  consult_selections: { customCocktails: [{ name: 'Lavender Fizz' }], beer: true, wine: ['red'], spirits: ['vodka'], ...over },
});
const HOUSE_LOOK = { look: 'house' };
// A draft as the house fill leaves it, for this plan.
function houseDraftFor(plan, look = 'house') {
  const n = normalizePlan(plan);
  const content = {
    words_status: 'done', look, drinks: n.drinks.map((d) => houseDrink(d)),
    house_sections: houseSections(plan, n), also_at_bar: keyedBarLines(n.bar),
  };
  return { plan_fingerprint: draftFingerprint(content, plan, n), content, dismissed_plan_hash: null };
}
const diffOn = (draft, plan) => read.computeDiff(draft, normalizePlan(plan), plan);
const barOf = (d) => [d.bar_changed, d.added.length, d.dropped.length, d.bar_unchecked];

test('draftFingerprint: a custom draft is buildFingerprint exactly; a house draft keys its bar by the printed sections', () => {
  const plan = plannerPlan();
  const n = normalizePlan(plan);
  for (const content of [{}, { look: 'custom' }, null]) assert.deepEqual(draftFingerprint(content, plan, n), buildFingerprint(n));
  const house = draftFingerprint(HOUSE_LOOK, plan, n);
  const custom = buildFingerprint(n);
  assert.deepEqual(Object.keys(house.bar_lines).sort(), ['house:Bar Service', 'house:Beer & Wine']);
  assert.deepEqual([house.drink_keys, house.brief_hash, house.brief_fields, house.planner_image_key],
    [custom.drink_keys, custom.brief_hash, custom.brief_fields, custom.planner_image_key], 'only the bar part differs');
  assert.notEqual(house.bar_hash, custom.bar_hash);
  const consult = consultPlan();
  assert.deepEqual(Object.keys(draftFingerprint(HOUSE_LOOK, consult, normalizePlan(consult)).bar_lines), ['house:Beer and Wine']);
});

test('draftFingerprint: a pick the house card does not print never moves its bar; one it prints does', () => {
  const hash = (plan) => draftFingerprint(HOUSE_LOOK, plan, normalizePlan(plan)).bar_hash;
  const base = hash(plannerPlan());
  // Not printed: a spirit added or removed, an other spirit, a second beer style beside a beer, the pick order.
  for (const over of [{ spirits: ['Vodka', 'Gin'] }, { spirits: [] }, { spiritsOther: 'Mezcal' },
    { beerFromFullBar: ['IPA', 'Craft / Local'] }, { beerFromFullBar: ['IPA', 'Non-Alcoholic'] }]) {
    assert.equal(hash(plannerPlan(over)), base, JSON.stringify(over));
  }
  assert.equal(hash(plannerPlan({ wineFromFullBar: ['White', 'Red'] })), hash(plannerPlan({ wineFromFullBar: ['Red', 'White'] })));
  // Printed: a wine pick, the beer gone, Call Drinks gone, a Non-Alcoholic pick where there was no beer.
  for (const over of [{ wineFromFullBar: ['Red', 'Sparkling'] }, { beerFromFullBar: [] }, { activeModules: { fullBar: false } }]) {
    assert.notEqual(hash(plannerPlan(over)), base, JSON.stringify(over));
  }
  assert.notEqual(hash(plannerPlan({ beerFromFullBar: ['Non-Alcoholic'], wineFromFullBar: [] })), hash(plannerPlan({ beerFromFullBar: [], wineFromFullBar: [] })));
  // The consult side: a spirit is never printed, the beer and the wine are.
  const consult = hash(consultPlan());
  assert.equal(hash(consultPlan({ spirits: ['vodka', 'gin'] })), consult);
  assert.equal(hash(consultPlan({ spirits: [] })), consult);
  assert.notEqual(hash(consultPlan({ beer: false })), consult);
  assert.notEqual(hash(consultPlan({ wine: ['red', 'white'] })), consult);
});

test('the read model on a house draft: a spirit never raises Plan changed, a printed pick or a drink does; a custom draft is as today', () => {
  const draft = houseDraftFor(plannerPlan());
  assert.deepEqual(barOf(diffOn(draft, plannerPlan())), [false, 0, 0, 0]);
  for (const over of [{ spirits: ['Vodka', 'Gin'] }, { spirits: [] }, { spiritsOther: 'Mezcal' }]) {
    assert.deepEqual(barOf(diffOn(draft, plannerPlan(over))), [false, 0, 0, 0], JSON.stringify(over));
  }
  const wine = diffOn(draft, plannerPlan({ wineFromFullBar: ['Red', 'Sparkling'] }));
  assert.deepEqual([wine.bar_changed, wine.bar_changed_labels], [true, ['house:Beer & Wine']]);
  assert.deepEqual(diffOn(draft, plannerPlan({ activeModules: { fullBar: false } })).bar_changed_labels, ['house:Bar Service']);
  assert.deepEqual(barOf(diffOn(draft, plannerPlan({ customCocktails: ['Lavender Fizz', 'Rum Punch', 'Paloma Fresca'] }))), [false, 1, 0, 0]);
  // The consult side.
  const consult = houseDraftFor(consultPlan());
  assert.deepEqual(barOf(diffOn(consult, consultPlan({ spirits: ['vodka', 'gin'] }))), [false, 0, 0, 0]);
  assert.equal(diffOn(consult, consultPlan({ beer: false })).bar_changed, true);
  // A custom draft prints its Spirits line, so a spirit is a change there, as today.
  const custom = houseDraftFor(plannerPlan(), 'custom');
  assert.deepEqual(custom.plan_fingerprint, buildFingerprint(normalizePlan(plannerPlan())));
  assert.deepEqual(diffOn(custom, plannerPlan({ spirits: ['Vodka', 'Gin'] })).bar_changed_labels, ['Spirits']);
});

test('on a house draft Dismiss holds through a spirit change and goes with a printed one; Mark reviewed clears the notes', () => {
  const draft = houseDraftFor(plannerPlan());
  const moved = plannerPlan({ wineFromFullBar: ['Red', 'Sparkling'] });
  const dismissed = { ...draft, dismissed_plan_hash: read.dismissalHash(draft, normalizePlan(moved), moved) };
  const shown = (plan) => read.shownDiff(dismissed, normalizePlan(plan), plan);
  assert.deepEqual([shown(moved).dismissed, shown(moved).bar_changed], [true, false]);
  const spirit = plannerPlan({ wineFromFullBar: ['Red', 'Sparkling'], spirits: ['Rum'] });
  assert.deepEqual([shown(spirit).dismissed, shown(spirit).bar_changed], [true, false], 'a spirit the card does not print keeps the dismissal');
  const beer = plannerPlan({ wineFromFullBar: ['Red', 'Sparkling'], beerFromFullBar: [] });
  assert.deepEqual([shown(beer).dismissed, shown(beer).bar_changed], [false, true], 'a printed change brings it back');
  // Mark reviewed folds the notes it names into the fingerprint; the read then shows none.
  const notes = plannerPlan({ menuDesignNotes: 'Gold foil' });
  assert.deepEqual(diffOn(draft, notes).brief_edited, ['notes']);
  const reviewed = { ...draft, plan_fingerprint: foldReviewed(draft.plan_fingerprint, buildFingerprint(normalizePlan(notes)), { brief: true, image: false }) };
  assert.deepEqual([diffOn(reviewed, notes).brief_edited, diffOn(reviewed, notes).bar_changed], [[], false]);
});

// The plan-hash echo (spec 17) is computed over the same form the read shows
// for the draft: the GET's diff.plan_hash and the routes' check agree through
// draftPlanHash, so on a house draft a spirit moved while the page is open is
// no refusal, while a printed pick still is. A custom draft's is planHash.
test('draftPlanHash: the echo over the form the read shows; a custom draft is planHash exactly', () => {
  const { draftPlanHash } = require('./menuHouseSections');
  const { planHash } = require('./menuDrinkSource');
  const plan = plannerPlan();
  const n = normalizePlan(plan);
  for (const content of [{}, { look: 'custom' }, null, undefined]) assert.equal(draftPlanHash(content, plan, n), planHash(n));
  const house = (p) => draftPlanHash(HOUSE_LOOK, p, normalizePlan(p));
  assert.equal(house(plannerPlan({ spirits: ['Vodka', 'Gin'] })), house(plan), 'a spirit the card does not print');
  assert.notEqual(house(plannerPlan({ wineFromFullBar: ['Red', 'Sparkling'] })), house(plan), 'a printed pick');
  assert.notEqual(house(plannerPlan({ customCocktails: ['Lavender Fizz'] })), house(plan), 'a drink dropped');
  assert.notEqual(planHash(normalizePlan(plannerPlan({ spirits: ['Vodka', 'Gin'] }))), planHash(n), 'a custom draft prints its spirits');
  // The GET's plan_hash is the same hash.
  assert.equal(read.shownDiff(houseDraftFor(plan), n, plan).plan_hash, house(plan));
  assert.equal(read.shownDiff(houseDraftFor(plan, 'custom'), n, plan).plan_hash, planHash(n));
});
