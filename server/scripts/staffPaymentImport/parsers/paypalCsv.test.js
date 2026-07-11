// PayPal CSV parser tests — person-payment types + PHP→USD resolution. No DB.
// Run: node --test server/scripts/staffPaymentImport/parsers/paypalCsv.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { parsePaypalCsv } = require('./paypalCsv');

const fx = path.join(__dirname, '..', '__fixtures__', 'paypal-sample.csv');

test('only outgoing completed General/Mobile Payments are emitted', () => {
  const rows = parsePaypalCsv(fx, { sourceAccount: 'paypal_contact' });
  // USD Mobile + PHP General; PreApproved, incoming, and the conversion rows dropped.
  assert.strictEqual(rows.length, 2);
});

test('USD payment uses Gross directly (abs cents)', () => {
  const rows = parsePaypalCsv(fx, { sourceAccount: 'paypal_contact' });
  const usd = rows.find((r) => r.txnId === 'TESTUSD1');
  assert.strictEqual(usd.amountCents, 16250);
  assert.strictEqual(usd.payee, 'Test Zul');
  assert.strictEqual(usd.payeeEmail, 'testzul@example.com');
  assert.strictEqual(usd.platform, 'paypal');
  assert.strictEqual(usd.unresolvedCurrency, false);
});

test('PHP payment resolves USD via the linked General Currency Conversion (ref txn id)', () => {
  const rows = parsePaypalCsv(fx, { sourceAccount: 'paypal_contact' });
  const php = rows.find((r) => r.txnId === 'TESTPHP1');
  assert.strictEqual(php.amountCents, 24111); // -241.11 USD conversion
  assert.strictEqual(php.unresolvedCurrency, false);
});

test('throws (not silently []) when required columns are missing', () => {
  const tmp = path.join(os.tmpdir(), `paypal-bad-${process.pid}.csv`);
  fs.writeFileSync(tmp, '"Foo","Bar"\n"a","b"\n');
  try {
    assert.throws(() => parsePaypalCsv(tmp, { sourceAccount: 'paypal_contact' }), /column|header/i);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('unresolvable PHP payment yields amountCents null + unresolvedCurrency true', () => {
  const header = fs.readFileSync(fx, 'utf8').split(/\r?\n/)[0];
  const orphan = '"12/20/2025","09:00:00","PST","Test Ghost","General Payment","Completed","PHP","-9,999.00","0.00","-9,999.00","contact@drbartender.com","ghost@example.com","ORPHANPHP","","","","","0.00","0.00","0.00","","","","","","","","0","","0.00"';
  const tmp = path.join(os.tmpdir(), `paypal-orphan-${process.pid}.csv`);
  fs.writeFileSync(tmp, `${header}\n${orphan}\n`);
  try {
    const rows = parsePaypalCsv(tmp, { sourceAccount: 'paypal_contact' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].amountCents, null);
    assert.strictEqual(rows[0].unresolvedCurrency, true);
  } finally {
    fs.unlinkSync(tmp);
  }
});
