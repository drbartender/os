const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePreferredName, validatePreferredNameChange } = require('./staffDisplayName.validate');

// Real names MUST pass. Rejecting someone's actual name to catch a handle is a
// bad trade (spec §3.4), so this is the higher-priority half of the suite.
const ACCEPTED = [
  'McKenna', 'DeShawn', 'LaToya', "O'Brien", 'Mary-Kate', 'D.J.', 'DJ',
  'Chip', 'Shea', 'Fareed', 'Alexis', 'Jo', 'Billie Jean', 'Tashea Coates',
  // Documented: a well-formed handle passes every mechanical check and always
  // will. The copy prevents it, not this function (spec §9).
  'LumpyIceCream',
  // Unicode letters are letters (widened 2026-08-14): accented and non-Latin
  // names must be SETTABLE, not merely grandfathered.
  'José', 'Renée', 'Zoë', 'Núñez', "D'Ángelo", 'Søren', '李娜',
];

for (const name of ACCEPTED) {
  test(`accepts ${JSON.stringify(name)}`, () => {
    const r = validatePreferredName(name);
    assert.equal(r.valid, true, r.error);
  });
}

const REJECTED = [
  ['', 'blank'],
  ['   ', 'whitespace only'],
  ['J', 'one character'],
  ['Miss Taylor', 'leading title'],
  ['Mrs. Smith', 'leading title with period'],
  ['Dr Bob', 'leading title'],
  ['Nicholas or Nick', 'three words'],
  ['Bar2Go', 'contains a digit'],
  ['Chip!', 'contains a symbol'],
  ['J0sé', 'digit hiding among unicode letters'],
  ['🍸Bartender', 'emoji is not a letter (\\p{L} excludes it)'],
  ['Abcdefghijklmnopqrstuvwxyzabcd', 'thirty characters, over the 20 cap'],
];

for (const [name, why] of REJECTED) {
  test(`rejects ${JSON.stringify(name)} (${why})`, () => {
    const r = validatePreferredName(name);
    assert.equal(r.valid, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
  });
}

test('normalizes surrounding and internal whitespace on the accepted value', () => {
  assert.equal(validatePreferredName('  Billie   Jean  ').value, 'Billie Jean');
  assert.equal(validatePreferredName('Elisa ').value, 'Elisa');
});

// UNICODE FORM (2026-08-14 push-gate residual, fixed 2026-08-20). Both of these
// arrive from ordinary keyboards: iOS and macOS substitute a curly apostrophe
// for a typed one, and a decomposed accent is what a paste out of some editors
// carries. Both used to hit the generic letters-only refusal, which named
// apostrophes as allowed while rejecting the apostrophe the phone had inserted.
test('a DECOMPOSED accent is the same name as a composed one', () => {
  const composed = 'Jos\u00e9';
  const decomposed = 'Jose\u0301';
  assert.notEqual(composed, decomposed, 'the two forms really are different strings');
  const r = validatePreferredName(decomposed);
  // \p{L} does not match a combining mark, so the NFD form failed a test the
  // NFC form passes, for the same name.
  assert.equal(r.valid, true);
  assert.equal(r.value, composed, 'and it is stored in one canonical form');
});

test('an iOS curly apostrophe is accepted, folded to the plain one', () => {
  const r = validatePreferredName('O\u2019Brien');
  assert.equal(r.valid, true);
  assert.equal(r.value, "O'Brien");
});

test('a LETTER apostrophe is left alone, because it is already a letter', () => {
  // U+02BB (the Hawaiian okina) is \p{Lm} and always passed. Folding it to an
  // ASCII quote would corrupt an orthography to fix a problem it does not have.
  const r = validatePreferredName('Ke\u02bbala');
  assert.equal(r.valid, true);
  assert.equal(r.value, 'Ke\u02bbala');
});

test('grandfathering still recognizes an unchanged name across both folds', () => {
  const stored = 'O\u2019Brien';
  const r = validatePreferredNameChange(stored, stored);
  assert.equal(r.valid, true);
  // Deliberate: an unchanged submission normalizes on its way through, so a
  // legacy curly or decomposed name repairs itself the next time that row is
  // saved. It cannot lock anyone out, because the compare normalizes both sides.
  assert.equal(r.value, "O'Brien");
});

test('error copy contains no em dashes', () => {
  for (const [name] of REJECTED) {
    assert.ok(!validatePreferredName(name).error.includes('—'));
  }
});

// GRANDFATHERING (spec §3.4). Without this, the staffer stored as
// "Nicholas or Nick" opens his profile, the field pre-fills with the value we
// accepted years ago, and he is locked out of saving his own phone number.
test('an unchanged legacy value passes even though it would fail as a new entry', () => {
  assert.equal(validatePreferredName('Nicholas or Nick').valid, false);
  assert.equal(validatePreferredNameChange('Nicholas or Nick', 'Nicholas or Nick').valid, true);
  assert.equal(validatePreferredNameChange('Miss Taylor', 'Miss Taylor').valid, true);
});

test('grandfathering tolerates whitespace drift but not a real edit', () => {
  assert.equal(validatePreferredNameChange('  Nicholas or Nick ', 'Nicholas or Nick').valid, true);
  assert.equal(validatePreferredNameChange('Nicholas or Nicky', 'Nicholas or Nick').valid, false);
});

test('grandfathering does not let a blank stored value wave through new junk', () => {
  assert.equal(validatePreferredNameChange('Bar2Go', null).valid, false);
  assert.equal(validatePreferredNameChange('', '').valid, false);
});
