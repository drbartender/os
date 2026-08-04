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
])('accepts %s', (name) => {
  expect(validatePreferredName(name).valid).toBe(true);
});

test.each([
  'Miss Taylor', 'Nicholas or Nick', 'Bar2Go', 'J', '', 'Abcdefghijklmnopqrstuvwxyz',
])('rejects %s', (name) => {
  expect(validatePreferredName(name).valid).toBe(false);
});
