const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatConsultRecap, consultRecapLines, humanizeDrinkId, unmatchedDrinkIds, pickNextStepLine,
} = require('./consultRecap');

test('formatConsultRecap: stored ids render as catalog names, in the shape the form writes', () => {
  const names = {
    cocktails: new Map([['old-fashioned', 'Old Fashioned'], ['margarita', 'Margarita']]),
    mocktails: new Map([['virgin-mojito', 'Virgin Mojito']]),
  };
  const lines = formatConsultRecap({
    barType: 'full_bar',
    spirits: ['vodka', 'tequila', 'whiskey'],
    signatureDrinks: ['old-fashioned', 'margarita'],
    customCocktails: [{ name: 'House Mule', ingredients: ['vodka', 'ginger beer', 'lime'] }],
    mocktailsEnabled: true,
    mocktails: ['virgin-mojito'],
    beer: true,
    wine: ['red', 'white'],
    mixers: 'full',
  }, names);
  assert.ok(lines.includes('Bar style: Full bar'));
  assert.ok(lines.includes('Spirits: Vodka, Tequila, Whiskey'));
  assert.ok(lines.includes('Signature cocktails: Old Fashioned, Margarita'));
  assert.ok(lines.includes('Custom cocktail: House Mule (vodka, ginger beer, lime)'));
  assert.ok(lines.includes('Mocktails: Virgin Mojito'));
  assert.ok(lines.includes('Beer: yes'));
  assert.ok(lines.includes('Wine: Red, White'));
  assert.ok(lines.includes('Mixers: Full set'));
  assert.doesNotMatch(lines.join(' | '), /old-fashioned|virgin-mojito/);
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

test('formatConsultRecap: structured ingredient rows render as names, not [object Object]', () => {
  // consult_selections is JSONB. Array.join() stringifies each element, so a
  // structured { ingredient, amount, unit } row (the shape cocktails.ingredients
  // uses) used to join as '[object Object]' in an email a CLIENT reads.
  const lines = formatConsultRecap({
    customCocktails: [{
      name: 'Structured Mule',
      ingredients: [
        { ingredient: 'vodka', amount: '2', unit: 'oz' },
        { ingredient: 'ginger beer', amount: '4', unit: 'oz' },
        { ingredient: 'lime', amount: '0.5', unit: 'oz', note: 'fresh' },
      ],
    }],
    customMocktails: [{
      name: 'Garden Fizz',
      ingredients: [{ ingredient: 'cucumber' }, { ingredient: 'soda water' }],
    }],
  });
  const blob = lines.join(' | ');
  assert.doesNotMatch(blob, /\[object Object\]/);
  assert.match(lines.find(l => /Structured Mule/.test(l)), /\(vodka, ginger beer, lime\)/);
  assert.match(lines.find(l => /Garden Fizz/.test(l)), /\(cucumber, soda water\)/);
  // Amount/unit/note are recipe detail, not shopping copy: they must not leak.
  assert.doesNotMatch(blob, /\boz\b|fresh/);
});

test('formatConsultRecap: unusable ingredient rows drop rather than leaving empty slots', () => {
  // Guards the rendering hazard the filter exists for: "(gin, , tonic)".
  const lines = formatConsultRecap({
    customCocktails: [{
      name: 'Half Written',
      ingredients: ['gin', { amount: '2', unit: 'oz' }, null, '   ', { ingredient: 'tonic' }],
    }],
  });
  assert.match(lines.find(l => /Half Written/.test(l)), /\(gin, tonic\)/);
});

test('formatConsultRecap: a custom drink with no usable ingredients still names the drink', () => {
  const lines = formatConsultRecap({
    customCocktails: [{ name: 'Bartender Choice', ingredients: [{}, null] }],
  });
  const line = lines.find(l => /Bartender Choice/.test(l));
  // No trailing empty parens, and the drink is not silently dropped.
  assert.equal(line, 'Custom cocktail: Bartender Choice');
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

test('formatConsultRecap: an id with no catalog name reads as words, never a slug', () => {
  const lines = formatConsultRecap({ signatureDrinks: ['french-75', 'long_gone_sour'], mocktails: ['no-name-spritz'] });
  assert.ok(lines.includes('Signature cocktails: French 75, Long Gone Sour'));
  assert.ok(lines.includes('Mocktails: No Name Spritz'));
});

test('formatConsultRecap: a picked id that is not a string or a number is skipped, never stringified', () => {
  const lines = formatConsultRecap({ signatureDrinks: ['margarita', { id: 'x' }, '', null, 7] });
  assert.ok(lines.includes('Signature cocktails: Margarita, 7'));
  assert.doesNotMatch(lines.join(' | '), /object Object/);
});

test('formatConsultRecap: the Mixers line prints only on the bars that offer the choice', () => {
  const mixers = (c) => formatConsultRecap(c).find((l) => l.startsWith('Mixers:'));
  assert.equal(mixers({ barType: 'full_bar', mixers: 'full' }), 'Mixers: Full set');
  assert.equal(mixers({ barType: 'sig_beer_wine', mixers: 'matching' }), 'Mixers: Only those that match your spirits');
  assert.equal(mixers({ barType: 'full_bar', mixers: 'none' }), 'Mixers: None beyond your signature cocktail ingredients');
  assert.equal(mixers({ barType: 'beer_wine', mixers: 'none' }), undefined);
  assert.equal(mixers({ barType: 'mocktails', mixers: 'none' }), undefined);
  assert.equal(mixers({ barType: 'full_bar', mixers: 'weird' }), undefined);
  assert.equal(mixers({ mixers: 'full' }), undefined);
});

test('humanizeDrinkId: dashes, underscores and spaces split; each word capitalised', () => {
  assert.equal(humanizeDrinkId('french-75'), 'French 75');
  assert.equal(humanizeDrinkId('mccoy-swamp-juice'), 'Mccoy Swamp Juice');
  assert.equal(humanizeDrinkId(''), '');
  assert.equal(humanizeDrinkId(null), '');
  // An id made only of separators keeps its raw form rather than vanishing.
  assert.equal(humanizeDrinkId('--'), '--');
});

test('formatConsultRecap: the notes stay off the client email; the staff lines keep them', () => {
  const consult = { barType: 'beer_wine', beer: true, notes: 'Bride hates gin, upsell the champagne toast' };
  const email = formatConsultRecap(consult);
  assert.ok(email.includes('Beer: yes'));
  assert.doesNotMatch(email.join(' | '), /Notes|hates gin|champagne/);
  const team = consultRecapLines(consult, {}, { includeNotes: true });
  assert.ok(team.includes('Notes: Bride hates gin, upsell the champagne toast'));
  // Client-safe by default: a caller that forgets the flag gets no notes.
  assert.doesNotMatch(consultRecapLines(consult).join(' | '), /Notes|hates gin/);
});

test('formatConsultRecap: a notes-only consult emails the placeholder, never the notes', () => {
  const consult = { spirits: [], notes: 'Call back about the venue bar' };
  assert.deepEqual(formatConsultRecap(consult), ['(no specific selections captured; notes are on file)']);
  assert.deepEqual(consultRecapLines(consult, {}, { includeNotes: true }), ['Notes: Call back about the venue bar']);
  assert.deepEqual(consultRecapLines(consult), []);
});

test('consultRecapLines: [] for a consult with nothing to say, where the email prints its placeholder', () => {
  assert.deepEqual(consultRecapLines({}), []);
  assert.deepEqual(consultRecapLines(null), []);
  assert.deepEqual(consultRecapLines({ spirits: [], notes: '   ' }), []);
  assert.deepEqual(
    formatConsultRecap({ spirits: [], notes: '   ' }),
    ['(no specific selections captured; notes are on file)']
  );
});

test('unmatchedDrinkIds: the picked ids the lookup did not name', () => {
  const names = { cocktails: new Map([['a', 'A']]), mocktails: new Map() };
  assert.deepEqual(unmatchedDrinkIds({ signatureDrinks: ['a', 'b'], mocktails: ['c'] }, names), ['b', 'c']);
  assert.deepEqual(unmatchedDrinkIds({}, names), []);
  assert.deepEqual(unmatchedDrinkIds(null), []);
});
