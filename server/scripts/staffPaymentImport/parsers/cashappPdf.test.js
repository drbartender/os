// Cash App PDF parser tests. parseCashappText is fed pdftotext -layout OUTPUT
// (the fixture is text, not a real PDF). Pure, no DB.
// Run: node --test server/scripts/staffPaymentImport/parsers/cashappPdf.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseCashappText } = require('./cashappPdf');

const text = fs.readFileSync(path.join(__dirname, '..', '__fixtures__', 'cashapp-sample.txt'), 'utf8');

test('only outgoing person "To" Cash App payments are emitted', () => {
  const rows = parseCashappText(text, { sourceFile: 'June 2025.pdf', sourceAccount: 'cashapp_business' });
  // 2 Test Person rows; From (incoming), Card Order, canceled, Instant transfer all excluded.
  assert.strictEqual(rows.length, 2);
  for (const r of rows) {
    assert.strictEqual(r.amountCents, 17000);
    assert.strictEqual(r.payee, 'Test Person');
    assert.strictEqual(r.date, '2025-06-10');
    assert.strictEqual(r.txnId, null);
    assert.strictEqual(r.platform, 'cashapp');
    assert.strictEqual(r.kind, 'payment');
  }
});

test('same-day same-amount same-payee rows get distinct fingerprints via seq', () => {
  const rows = parseCashappText(text, { sourceFile: 'June 2025.pdf', sourceAccount: 'cashapp_business' });
  assert.notStrictEqual(rows[0].fingerprint, rows[1].fingerprint);
});

test('throws when the statement year cannot be resolved (no null-YYYY dates)', () => {
  const noHeader = 'Jun 10   To Test Person   Cash App payment   $0.00   $10.00\n';
  assert.throws(
    () => parseCashappText(noHeader, { sourceFile: 'mystery.pdf', sourceAccount: 'cashapp_business' }),
    /year/i,
  );
});

test('the " from <bank>" suffix is stripped from the payee', () => {
  const rows = parseCashappText(text, { sourceFile: 'June 2025.pdf', sourceAccount: 'cashapp_business' });
  assert.ok(rows.every((r) => !/from/i.test(r.payee)));
});
