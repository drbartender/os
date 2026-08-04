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
