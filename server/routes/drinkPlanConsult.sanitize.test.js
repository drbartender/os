// DB-free shape tests for sanitizeConsult, the ONLY writer of
// drink_plans.consult_selections.
//
// Why this file is separate from drinkPlanConsult.test.js: that suite is
// DB-backed (it seeds a client/proposal/plan to exercise the consults
// completion flip) and has to run serially against the shared dev database.
// sanitizeConsult is a pure function, so its rules get pinned here for free.
//
// Requiring the route module constructs the pg Pool but issues no query and
// opens no connection, so this suite touches Postgres in no way that matters.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeConsult } = require('./drinkPlanConsult');

test('sanitizeConsult: string ingredients pass through unchanged', () => {
  const out = sanitizeConsult({
    customCocktails: [{ name: 'House Mule', ingredients: ['vodka', 'ginger beer', 'lime'] }],
  });
  assert.deepEqual(out.customCocktails, [
    { name: 'House Mule', ingredients: ['vodka', 'ginger beer', 'lime'] },
  ]);
});

test('sanitizeConsult: structured ingredient rows persist as names, never [object Object]', () => {
  // This is the site that makes the bug permanent. consult_selections is JSONB;
  // a String() here does not just mis-render once, it WRITES '[object Object]'
  // to the row, round-trips it back into the consult form on re-open, and
  // poisons every shopping list regenerated from that plan afterwards.
  const out = sanitizeConsult({
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
  assert.deepEqual(out.customCocktails[0].ingredients, ['vodka', 'ginger beer', 'lime']);
  assert.deepEqual(out.customMocktails[0].ingredients, ['cucumber', 'soda water']);
  assert.doesNotMatch(JSON.stringify(out), /\[object Object\]/);
});

test('sanitizeConsult: the stored shape stays a flat array of strings', () => {
  // Every consumer (the consult form's re-open, formatConsultRecap's join,
  // buildGeneratorInputFromConsult) reads this as string[]. Normalizing at the
  // boundary is what lets those stay simple, so pin the contract itself.
  const out = sanitizeConsult({
    customCocktails: [{ name: 'Mixed Shapes', ingredients: ['gin', { ingredient: 'tonic' }] }],
  });
  for (const v of out.customCocktails[0].ingredients) {
    assert.equal(typeof v, 'string');
  }
});

test('sanitizeConsult: unusable ingredient rows are dropped, not stored empty', () => {
  const out = sanitizeConsult({
    customCocktails: [{
      name: 'Half Written',
      ingredients: ['gin', { amount: '2', unit: 'oz' }, null, '  ', { ingredient: '' }, { ingredient: 'tonic' }],
    }],
  });
  assert.deepEqual(out.customCocktails[0].ingredients, ['gin', 'tonic']);
});

test('sanitizeConsult: a structured row is still length-capped', () => {
  // The 200-char cap is a storage guard and must survive the normalizer.
  const out = sanitizeConsult({
    customCocktails: [{ name: 'Long', ingredients: [{ ingredient: 'x'.repeat(500) }] }],
  });
  assert.equal(out.customCocktails[0].ingredients[0].length, 200);
});

test('sanitizeConsult: existing validation still rejects bad drink shapes', () => {
  // The normalizer loosened row handling INSIDE ingredients; it must not have
  // loosened the surrounding allow-list. ValidationError carries a generic
  // message and puts the detail on .fieldErrors, so assert on that.
  const reason = (fn) => {
    try { fn(); } catch (e) { return (e.fieldErrors || {}).customCocktails || ''; }
    throw new Error('expected sanitizeConsult to throw');
  };
  assert.match(reason(() => sanitizeConsult({ customCocktails: ['just a name'] })), /must be an object/);
  assert.match(reason(() => sanitizeConsult({ customCocktails: [{ ingredients: ['gin'] }] })), /name required/);
  assert.match(reason(() => sanitizeConsult({ customCocktails: 'nope' })), /must be an array/);
  assert.match(
    reason(() => sanitizeConsult({ customCocktails: [{ name: 'Too Many', ingredients: new Array(31).fill('gin') }] })),
    /exceeds 30/
  );
});

test('sanitizeConsult: unknown keys are still stripped', () => {
  const out = sanitizeConsult({ notes: 'hi', somethingElse: 'drop me' });
  assert.equal(out.notes, 'hi');
  assert.equal('somethingElse' in out, false);
});
