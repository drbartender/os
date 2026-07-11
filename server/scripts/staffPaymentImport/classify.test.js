// Classifier + dictionary tests. Pure, no DB (CC fixtures seed the dictionary).
// Run: node --test server/scripts/staffPaymentImport/classify.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { classify } = require('./classify');
const { buildDictionary, RAW_ALIASES } = require('./dictionary');

const fx = (n) => path.join(__dirname, '__fixtures__', n);
const dict = buildDictionary({
  ccContactsCsv: fx('cc-contacts.csv'),
  ccExpensesCsv: fx('cc-expenses.csv'),
});

test('dictionary hit → staff-pay', () => {
  const r = classify({ payee: 'Test Person', memo: 'DrB 4/12', kind: 'payment' }, dict);
  assert.strictEqual(r.verdict, 'staff-pay');
  assert.strictEqual(r.reason, 'dictionary');
  assert.ok(r.person);
});

test('a cross-platform alias resolves to its canonical cluster', () => {
  // Pull a sanctioned alias pair from RAW_ALIASES rather than typing real names.
  const [aliasSrc, aliasTgt] = Object.entries(RAW_ALIASES)[0];
  const r = classify({ payee: aliasSrc, memo: '', kind: 'payment' }, dict);
  assert.strictEqual(r.verdict, 'staff-pay');
  assert.strictEqual(r.person, aliasTgt);
});

test('Massage memo → ignore (pattern)', () => {
  const r = classify({ payee: 'Test Masseuse', memo: 'Massage', kind: 'payment' }, dict);
  assert.strictEqual(r.verdict, 'ignore');
  assert.match(r.reason, /massage/);
});

test('funding row → ignore', () => {
  const r = classify({ payee: 'Whoever', memo: '', kind: 'funding' }, dict);
  assert.strictEqual(r.verdict, 'ignore');
  assert.strictEqual(r.reason, 'funding');
});

test('agency (Qwick) → ignore agency', () => {
  const r = classify({ payee: 'Qwick', memo: '', kind: 'payment' }, dict);
  assert.strictEqual(r.verdict, 'ignore');
  assert.strictEqual(r.reason, 'agency');
});

test('unknown payee → unsure', () => {
  const r = classify({ payee: 'Test Unknownpayee', memo: '', kind: 'payment' }, dict);
  assert.strictEqual(r.verdict, 'unsure');
});
