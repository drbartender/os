import { computeDisplayName, validatePreferredName } from './preferredName';

// PARITY TABLE. Must stay identical to server/utils/staffDisplayName.test.js.
// If you change one, change both.
const CASES = [
  ['Fareed', 'Mohammad F Shafiuddin', 'Fareed S.'],
  ['Teah', 'Teah Teriele', 'Teah T.'],
  ['Dallas', 'Dallas Raby', 'Dallas R.'],
  ['Joey', 'Joseph Key', 'Joey K.'],
  ['Nikki', 'Monique Lundy', 'Nikki L.'],
  ['Tashea Coates', 'Tashea Coates', 'Tashea C.'],
  ['Evan Williams', 'Evan Williams', 'Evan W.'],
  ['Billie', 'Billie Jean Barrone', 'Billie B.'],
  ['Billie Jean', 'Billie Jean Barrone', 'Billie Jean B.'],
  ['Mark Holt', 'Mark', 'Mark H.'],
  ['Ariel  D. Smith', 'Ariel Smith', 'Ariel S.'],
  ['Adelle M. Reynolds', null, 'Adelle R.'],
  ['veronica martinez', 'veronica martinez', 'Veronica M.'],
  ['Jasmine Jeff', 'Jasmine jeff', 'Jasmine J.'],
  ['Zul', 'Zul', 'Zul'],
  ['Dallas', null, 'Dallas'],
  [null, 'Nevver Sayles', 'Nevver S.'],
  ['', 'Joseph Key', 'Joseph K.'],
  [null, 'Zul', 'Zul'],
  [null, null, null],
  ['Nicholas or Nick', 'Nicholas George DiCristina', 'Nicholas or Nick D.'],
];

test.each(CASES)('computeDisplayName(%s, %s) === %s', (preferredName, legalFullName, expected) => {
  expect(computeDisplayName({ preferredName, legalFullName })).toBe(expected);
});

test.each([
  'McKenna', 'DeShawn', 'LaToya', "O'Brien", 'Mary-Kate', 'D.J.', 'DJ', 'LumpyIceCream',
  // Unicode letters are letters (widened 2026-08-14, mirrors the server).
  'José', 'Renée', 'Zoë', 'Núñez', "D'Ángelo", 'Søren', '李娜',
])('accepts %s', (name) => {
  expect(validatePreferredName(name).valid).toBe(true);
});

test.each([
  'Miss Taylor', 'Nicholas or Nick', 'Bar2Go', 'J', '', 'Abcdefghijklmnopqrstuvwxyz',
  'J0sé', '🍸Bartender',
])('rejects %s', (name) => {
  expect(validatePreferredName(name).valid).toBe(false);
});

// PARITY with server/utils/staffDisplayName.test.js's astral test. This port
// used charAt(0) for the last initial until 2026-08-20, so the live preview
// could show half a surrogate pair for a name the server stored correctly.
test('an astral-plane initial is a whole character, never half a surrogate pair', () => {
  const out = computeDisplayName({ preferredName: 'Amy', legalFullName: 'Amy \u{1D4AE}mith' });
  expect(out).toBe('Amy \u{1D4AE}.');
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  expect(computeDisplayName({ preferredName: '\u{1D49C}my', legalFullName: '\u{1D49C}my Smith' }))
    .toBe('\u{1D49C}my S.');
});

// PARITY with the server validator's unicode-form tests. The preview and the
// server must agree about what is acceptable, or the field rejects a name the
// server would have taken (or the reverse, which is worse).
test('a decomposed accent and a curly apostrophe both pass, folded to one form', () => {
  // Escapes, not literals: the whole point is WHICH form the bytes are in, and a
  // literal is invisible in review and re-normalizable by an editor on save.
  const composed = 'Jos\u00e9';
  const decomposed = 'Jose\u0301';
  expect(decomposed).not.toBe(composed);
  expect(validatePreferredName(decomposed).valid).toBe(true);
  expect(validatePreferredName(decomposed).value).toBe(composed);
  expect(validatePreferredName('O\u2019Brien').valid).toBe(true);
  expect(validatePreferredName('O\u2019Brien').value).toBe("O'Brien");
  // U+02BB is a LETTER and always passed; folding it would corrupt the name.
  expect(validatePreferredName('Ke\u02bbala').value).toBe('Ke\u02bbala');
});
