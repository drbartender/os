process.env.NODE_ENV = 'test';
// server/utils/menuAlsoAtBar.test.js
// PURE unit tests, no DB. Spec 5.2 (Bar lines) and 10.3 (pairing ids).
//   node --test server/utils/menuAlsoAtBar.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAlsoAtBar, LINE_LABELS, HOUSE_BEER_MIX, TEXT_MAX } = require('./menuAlsoAtBar');
const { FONT_PAIRING_IDS, isFontPairingId } = require('./menuFontPairings');
const { BEER_STYLE_MAP } = require('./shoppingList');

function line(lines, label) {
  const found = lines.find((l) => l.label === label);
  return found ? found.text : undefined;
}

function timed(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

test('every planner beer label maps through the table', () => {
  const lines = buildAlsoAtBar({ beer: ['Light / Easy Drinking', 'Craft / Local', 'IPA', 'Seltzer'] });
  assert.deepEqual(lines, [{ label: 'Beer and Wine', text: 'Light beer, Craft beer, IPA, Seltzer.' }]);
});

test('every wine label maps through the table, in table order', () => {
  const lines = buildAlsoAtBar({ wine: ['Sparkling', 'White', 'Red'] });
  assert.deepEqual(lines, [{ label: 'Beer and Wine', text: 'Red, White, Sparkling.' }]);
});

test('beer and wine share one line, beer first', () => {
  const lines = buildAlsoAtBar({ beer: ['IPA'], wine: ['Red'] });
  assert.equal(line(lines, 'Beer and Wine'), 'IPA, Red.');
});

test('both non-alcoholic labels become one Athletic Brewing NA on the Non-Alcoholic line', () => {
  for (const label of ['Non-Alcoholic', 'Non-Alcoholic (Athletic Brewing)']) {
    const lines = buildAlsoAtBar({ beer: [label] });
    assert.deepEqual(lines, [{ label: 'Non-Alcoholic', text: 'Athletic Brewing NA.' }], label);
  }
  const both = buildAlsoAtBar({ beer: ['Non-Alcoholic', 'IPA'], na: ['Non-Alcoholic (Athletic Brewing)'] });
  assert.equal(line(both, 'Non-Alcoholic'), 'Athletic Brewing NA.');
  assert.equal(line(both, 'Beer and Wine'), 'IPA.');
});

test('"None" and "Other" render nothing', () => {
  assert.deepEqual(buildAlsoAtBar({ beer: ['None'], wine: ['None'], spirits: ['Other'] }), []);
  assert.deepEqual(buildAlsoAtBar({ wine: ['Other', 'None'] }), []);
  const mixed = buildAlsoAtBar({ wine: ['Other', 'White'], spirits: ['Other', 'Gin'] });
  assert.equal(line(mixed, 'Beer and Wine'), 'White.');
  assert.equal(line(mixed, 'Spirits'), 'Gin.');
});

test('spirits are listed by name, with spiritsOther appended as typed', () => {
  const lines = buildAlsoAtBar({
    spirits: ['Whiskey', 'Vodka', 'Other', 'Scotch', 'Tequila', 'Gin', 'Rum'],
    spiritsOther: '  Fireball  ',
  });
  assert.equal(line(lines, 'Spirits'), 'Vodka, Gin, Rum, Tequila, Whiskey, Scotch, Fireball.');
});

test('spiritsOther alone still makes a Spirits line; a trailing period is not doubled', () => {
  const lines = buildAlsoAtBar({ spirits: ['Other'], spiritsOther: 'Hennessy.' });
  assert.deepEqual(lines, [{ label: 'Spirits', text: 'Hennessy.' }]);
});

test('consult beer: true is the house mix; false or missing renders nothing', () => {
  assert.deepEqual(HOUSE_BEER_MIX, ['Light / Easy Drinking', 'Craft / Local', 'IPA']);
  // The house mix is the same three styles the shopping list maps.
  for (const style of HOUSE_BEER_MIX) assert.ok(BEER_STYLE_MAP[style], style);
  assert.equal(line(buildAlsoAtBar({ beer: true }), 'Beer and Wine'), 'Light beer, Craft beer, IPA.');
  assert.deepEqual(buildAlsoAtBar({ beer: false }), []);
  assert.deepEqual(buildAlsoAtBar({ beer: undefined }), []);
});

test('consult lowercase wine categories and spirit slugs map to the same words', () => {
  const lines = buildAlsoAtBar({
    beer: true,
    wine: ['red', 'sparkling', 'white'],
    spirits: ['vodka', 'bourbon', 'mezcal'],
  });
  assert.deepEqual(lines, [
    { label: 'Beer and Wine', text: 'Light beer, Craft beer, IPA, Red, White, Sparkling.' },
    { label: 'Spirits', text: 'Vodka, Bourbon, Mezcal.' },
  ]);
});

test('a full bar gives three lines in order: Beer and Wine, Spirits, Non-Alcoholic', () => {
  const lines = buildAlsoAtBar({
    beer: ['IPA', 'Seltzer', 'Non-Alcoholic (Athletic Brewing)'],
    wine: ['Red'],
    spirits: ['Vodka'],
  });
  assert.deepEqual(lines.map((l) => l.label), [LINE_LABELS.beerWine, LINE_LABELS.spirits, LINE_LABELS.na]);
});

test('duplicates across fullBar and beerWine picks print once', () => {
  const lines = buildAlsoAtBar({ beer: ['IPA', 'IPA', 'Seltzer'], wine: ['Red', 'red'] });
  assert.equal(line(lines, 'Beer and Wine'), 'IPA, Seltzer, Red.');
});

test('an unknown beer or wine label renders nothing (fixed table)', () => {
  assert.deepEqual(buildAlsoAtBar({ beer: ['Stout'], wine: ['Rose'] }), []);
});

test('an already-mapped line maps to itself (idempotent)', () => {
  const lines = buildAlsoAtBar({ beer: ['Light beer', 'Craft beer'], na: ['Athletic Brewing NA'] });
  assert.equal(line(lines, 'Beer and Wine'), 'Light beer, Craft beer.');
  assert.equal(line(lines, 'Non-Alcoholic'), 'Athletic Brewing NA.');
});

test('an empty bar gives []', () => {
  assert.deepEqual(buildAlsoAtBar({}), []);
  assert.deepEqual(buildAlsoAtBar({ beer: [], wine: [], spirits: [], na: [] }), []);
  assert.deepEqual(buildAlsoAtBar(null), []);
  assert.deepEqual(buildAlsoAtBar(undefined), []);
});

test('a long spiritsOther is cut so the line stays within the PATCH text limit', () => {
  const long = 'Fireball, Malibu, Jameson, Crown Royal, Hennessy, Patron, Grey Goose, Bacardi Superior, Captain Morgan, Jack Daniels';
  const lines = buildAlsoAtBar({ spirits: ['Vodka', 'Gin'], spiritsOther: long });
  const text = line(lines, 'Spirits');
  assert.ok(text.length <= TEXT_MAX, `length ${text.length}`);
  assert.equal(TEXT_MAX, 120);
  assert.ok(text.startsWith('Vodka, Gin, Fireball'));
  assert.ok(text.endsWith('.'));
});

test('20,000 distinct spirits finish fast and the line stays within TEXT_MAX', () => {
  const spirits = Array.from({ length: 20000 }, (_, i) => `Spirit ${i}`);
  const { result, ms } = timed(() => buildAlsoAtBar({ spirits }));
  assert.ok(ms < 100, `took ${ms.toFixed(1)} ms`);
  const text = line(result, 'Spirits');
  assert.ok(text.length <= TEXT_MAX, `length ${text.length}`);
  assert.ok(text.startsWith('Spirit 0, Spirit 1, Spirit 2'), text);
  assert.ok(text.endsWith('.'));
});

test('a 40 KB run of trailing-trim characters finishes fast (no regex backtracking)', () => {
  const long = `a${'.,'.repeat(20000)}b`;
  const { result, ms } = timed(() => buildAlsoAtBar({
    beer: [long], na: [long], wine: [long], spirits: [long], spiritsOther: long,
  }));
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
  assert.deepEqual(result, [{ label: 'Spirits', text: 'a.' }]);
});

test('each list keeps its first 50 entries and each entry its first 200 characters', () => {
  const brands = Array.from({ length: 50 }, (_, i) => `Brand ${i}`);
  // Table words print first, so Vodka leads the line only when it was read.
  const fiftyFirst = line(buildAlsoAtBar({ spirits: [...brands, 'Vodka'] }), 'Spirits');
  assert.ok(fiftyFirst.startsWith('Brand 0, Brand 1'), fiftyFirst);
  const fiftieth = line(buildAlsoAtBar({ spirits: [...brands.slice(0, 49), 'Vodka'] }), 'Spirits');
  assert.ok(fiftieth.startsWith('Vodka, Brand 0'), fiftieth);
  // A word that starts past character 200 is cut off; one at character 200 stays.
  assert.deepEqual(buildAlsoAtBar({ beer: [`${' '.repeat(200)}IPA`], spiritsOther: `${' '.repeat(200)}Fireball` }), []);
  assert.deepEqual(buildAlsoAtBar({ spiritsOther: `${' '.repeat(199)}F` }), [{ label: 'Spirits', text: 'F.' }]);
});

test('FONT_PAIRING_IDS are the six fixed ids (spec 10.3)', () => {
  assert.deepEqual([...FONT_PAIRING_IDS], ['elegant-script', 'rustic', 'modern-clean', 'retro', 'spooky', 'tropical']);
  assert.ok(Object.isFrozen(FONT_PAIRING_IDS));
  assert.equal(isFontPairingId('retro'), true);
  assert.equal(isFontPairingId('script'), false);
  assert.equal(isFontPairingId(null), false);
});
