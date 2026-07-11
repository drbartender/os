// Unit tests for the staging row + fingerprint + parseMoney (pure, no DB).
// Run: node --test server/scripts/staffPaymentImport/staging.test.js
const test = require('node:test');
const assert = require('node:assert');
const { makeRow, parseMoney, normalizeName } = require('./staging');
const config = require('./config');

test('parseMoney handles $, commas, cents, and signs', () => {
  assert.strictEqual(parseMoney('$0.01'), 1);
  assert.strictEqual(parseMoney('$1,043.74'), 104374);
  assert.strictEqual(parseMoney('- $105.00'), -10500);
  assert.strictEqual(parseMoney('- $1,000.00'), -100000);
  assert.strictEqual(parseMoney('204.99'), 20499);
  assert.strictEqual(parseMoney('+ $94.00'), 9400);
  assert.strictEqual(parseMoney('1,868.27'), 186827);
});

test('BOUNDARY constant exported from config', () => {
  assert.strictEqual(config.BOUNDARY, '2026-06-02');
});

test('makeRow returns a frozen row with an fp- prefixed fingerprint', () => {
  const row = makeRow({
    date: '2025-04-12', amountCents: 10500, platform: 'venmo',
    sourceAccount: 'venmo_business', payee: 'Test Person', memo: 'DrB 4/12',
    txnId: '4347181362501657994', sourceFile: 'apr-2025-statement.csv',
    seq: 0, kind: 'payment',
  });
  assert.ok(Object.isFrozen(row));
  assert.match(row.fingerprint, /^fp-[0-9a-f]{32}$/);
  assert.strictEqual(row.amountCents, 10500);
  assert.strictEqual(row.kind, 'payment');
});

test('fingerprint is stable across identical inputs (txn-id path)', () => {
  const base = {
    date: '2025-04-12', amountCents: 10500, platform: 'venmo',
    sourceAccount: 'venmo_business', payee: 'Test Person', memo: 'x',
    txnId: 'TESTID1', sourceFile: 'a.csv', seq: 0, kind: 'payment',
  };
  const a = makeRow(base);
  // Same txn id but different display fields / file → same fingerprint (id-based).
  const b = makeRow({ ...base, memo: 'different', sourceFile: 'b.csv', payee: 'Renamed' });
  assert.strictEqual(a.fingerprint, b.fingerprint);
});

test('fingerprint differs by seq for id-less rows (Cash App same-day dupes)', () => {
  const base = {
    date: '2025-06-10', amountCents: 17000, platform: 'cashapp',
    sourceAccount: 'cashapp_business', payee: 'Test Person', memo: '',
    txnId: null, sourceFile: 'June 2025.pdf', kind: 'payment',
  };
  const a = makeRow({ ...base, seq: 0 });
  const b = makeRow({ ...base, seq: 1 });
  assert.notStrictEqual(a.fingerprint, b.fingerprint);
});

test('id-less fingerprint is stable for the same positional inputs', () => {
  const base = {
    date: '2025-06-10', amountCents: 17000, platform: 'cashapp',
    sourceAccount: 'cashapp_business', payee: 'Test Person', memo: '',
    txnId: null, sourceFile: 'June 2025.pdf', seq: 0, kind: 'payment',
  };
  assert.strictEqual(makeRow(base).fingerprint, makeRow({ ...base }).fingerprint);
});

test('normalizeName lowercases, strips punctuation, collapses whitespace', () => {
  assert.strictEqual(normalizeName('  Test   Person! '), 'test person');
  assert.strictEqual(normalizeName("O'Brien-Smith"), 'obrien smith');
});
