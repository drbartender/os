// Chase statement parser tests — Zelle primary payments + Venmo/CashApp/PayPal
// funding mirrors. Fed pdftotext -layout OUTPUT (fixture is text). Pure, no DB.
// Run: node --test server/scripts/staffPaymentImport/parsers/chasePdf.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseChaseText } = require('./chasePdf');

const text = fs.readFileSync(path.join(__dirname, '..', '__fixtures__', 'chase-sample.txt'), 'utf8');
const opts = { sourceFile: '2025-08 August.pdf', sourceAccount: 'chase_6835', statementYear: 2025, statementMonth: 8 };

test('exactly one Zelle payment + three funding mirrors; ordinary debit dropped', () => {
  const rows = parseChaseText(text, opts);
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows.filter((r) => r.kind === 'payment').length, 1);
  assert.strictEqual(rows.filter((r) => r.kind === 'funding').length, 3);
});

test('Zelle payment carries the ref as txnId, name as payee, positive amount', () => {
  const pay = parseChaseText(text, opts).find((r) => r.kind === 'payment');
  assert.strictEqual(pay.platform, 'zelle');
  assert.strictEqual(pay.txnId, 'Jpm99Test123');
  assert.strictEqual(pay.payee, 'Test Freyer');
  assert.strictEqual(pay.amountCents, 20000);
  assert.strictEqual(pay.date, '2025-08-03');
});

test('funding rows classify fundingOf venmo/cashapp/paypal; cashapp carries payee', () => {
  const funding = parseChaseText(text, opts).filter((r) => r.kind === 'funding');
  const byPlat = Object.fromEntries(funding.map((r) => [r.fundingOf, r]));
  assert.deepStrictEqual(Object.keys(byPlat).sort(), ['cashapp', 'paypal', 'venmo']);
  assert.strictEqual(byPlat.venmo.amountCents, 15750);
  assert.strictEqual(byPlat.cashapp.amountCents, 40000);
  assert.strictEqual(byPlat.cashapp.payee, 'Test Person');
  assert.strictEqual(byPlat.paypal.amountCents, 24111);
});

test('throws when the statement year is unknown (unparseable file name)', () => {
  assert.throws(
    () => parseChaseText('08/03  Zelle Payment To Test Person 25000000000  50.00\n',
      { sourceFile: 'mystery.pdf', sourceAccount: 'chase_6835', statementYear: null, statementMonth: null }),
    /year/i,
  );
});

test('December rows in a January statement resolve to the prior year', () => {
  const decText = '12/28   Zelle Payment To Test Person 25000000000                 50.00\n';
  const rows = parseChaseText(decText, { sourceFile: '2025-01 January.pdf', sourceAccount: 'chase_6835', statementYear: 2025, statementMonth: 1 });
  assert.strictEqual(rows[0].date, '2024-12-28');
});
