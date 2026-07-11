// Venmo CSV parser tests (business + personal layouts). Pure, no DB.
// Run: node --test server/scripts/staffPaymentImport/parsers/venmoCsv.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { parseVenmoCsv } = require('./venmoCsv');

const fx = (n) => path.join(__dirname, '..', '__fixtures__', n);

test('business layout: only the outgoing completed Payment is emitted', () => {
  const rows = parseVenmoCsv(fx('venmo-business.csv'), { sourceAccount: 'venmo_business' });
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.amountCents, 10500);
  assert.strictEqual(r.payee, 'Test Person');
  assert.strictEqual(r.memo, 'Testman DrB 4/12');
  assert.strictEqual(r.txnId, '1111111111111111111'); // literal quotes stripped
  assert.strictEqual(r.date, '2025-04-12');
  assert.strictEqual(r.platform, 'venmo');
  assert.strictEqual(r.kind, 'payment');
});

test('personal layout: 2 title rows + ISO Datetime; only the outgoing Payment', () => {
  const rows = parseVenmoCsv(fx('venmo-personal.csv'), { sourceAccount: 'venmo_personal' });
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.amountCents, 20000);
  assert.strictEqual(r.payee, 'Test Recipient');
  assert.strictEqual(r.date, '2025-05-20'); // first 10 chars of ISO Datetime
  assert.strictEqual(r.txnId, '9999999999999999999');
});

test('throws (not silently []) on a file whose header cannot be found', () => {
  const tmp = path.join(os.tmpdir(), `venmo-bad-${process.pid}.csv`);
  fs.writeFileSync(tmp, 'just,some,garbage\n1,2,3\n');
  try {
    assert.throws(() => parseVenmoCsv(tmp, { sourceAccount: 'venmo_business' }), /header/i);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('incoming payments and non-Payment types are excluded (both layouts)', () => {
  const biz = parseVenmoCsv(fx('venmo-business.csv'), { sourceAccount: 'venmo_business' });
  const per = parseVenmoCsv(fx('venmo-personal.csv'), { sourceAccount: 'venmo_personal' });
  // business: incoming +$50 and Merchant Transaction dropped → 1 left
  assert.strictEqual(biz.length, 1);
  // personal: incoming +$10 and Merchant Transaction dropped → 1 left
  assert.strictEqual(per.length, 1);
});
