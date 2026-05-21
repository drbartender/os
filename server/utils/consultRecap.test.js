const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatConsultRecap, pickNextStepLine } = require('./consultRecap');

test('formatConsultRecap: full mix of selections renders human-readable bullets', () => {
  const lines = formatConsultRecap({
    barType: 'full_bar',
    spirits: ['vodka', 'tequila', 'whiskey'],
    signatureDrinks: ['Old Fashioned', 'Margarita'],
    customCocktails: [{ name: 'House Mule', ingredients: ['vodka', 'ginger beer', 'lime'] }],
    mocktailsEnabled: true,
    mocktails: ['Virgin Mojito'],
    beer: true,
    wine: ['Cabernet', 'Sauvignon Blanc'],
  });
  const blob = lines.join(' | ');
  assert.match(blob, /full bar/i);
  assert.match(blob, /vodka/i);
  assert.match(blob, /Old Fashioned/);
  assert.match(blob, /House Mule/);
  assert.match(blob, /Virgin Mojito/i);
  assert.match(blob, /beer/i);
  assert.match(blob, /Cabernet/);
});

test('formatConsultRecap: beer/wine-only event omits cocktail lines', () => {
  const lines = formatConsultRecap({
    barType: 'beer_wine',
    beer: true,
    wine: ['Rose'],
  });
  const blob = lines.join(' | ');
  assert.match(blob, /beer/i);
  assert.match(blob, /Rose/);
  assert.doesNotMatch(blob, /spirit/i);
  assert.doesNotMatch(blob, /cocktail/i);
});

test('formatConsultRecap: empty consult returns single notes-on-file line', () => {
  const lines = formatConsultRecap({});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no specific selections|notes are on file/i);
});

test('formatConsultRecap: custom-cocktail ingredients render inline in parens', () => {
  const lines = formatConsultRecap({
    customCocktails: [{ name: 'Smoky Maria', ingredients: ['mezcal', 'tomato', 'lime'] }],
  });
  assert.match(lines.find(l => /Smoky Maria/.test(l)), /\(mezcal, tomato, lime\)/);
});

test('pickNextStepLine: byob picks the shopping-list line', () => {
  assert.equal(
    pickNextStepLine('byob'),
    "We'll send your shopping list shortly."
  );
});

test('pickNextStepLine: hosted picks the bartender-prep line', () => {
  assert.equal(
    pickNextStepLine('hosted'),
    'Your bartender will prep based on this.'
  );
});

test('pickNextStepLine: unknown defaults to the BYOB line (safer default)', () => {
  assert.equal(
    pickNextStepLine(null),
    "We'll send your shopping list shortly."
  );
});
