// signedRecordEmail (audit ESIG-05): the row-to-record reader and the block
// both sign-time templates render. Pure; no database.
//
// Run: node --test server/utils/signedRecordEmail.test.js

require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signedRecordFromRow, signedRecordBlock, dollarsLabel } = require('./signedRecordEmail');

const ROW = {
  client_signed_name: 'Test Signer',
  client_signed_at: '2026-10-01T15:00:00.000Z',
  client_signature_document_version: 'event-services-agreement-v4',
  client_signed_snapshot: {
    record_version: 1,
    document_version: 'event-services-agreement-v4',
    rows: [{ key: 'package', label: 'Test Flat <Bar>', amount: 476.55 }, { key: 'addon-0', label: 'Test Add-on', amount: 40 }],
    gratuity_amount: 80,
    gratuity_label: 'Gratuity',
    total: 596.55,
    snapshot: { total: 596.55 },
  },
};

test('dollarsLabel prints through integer cents', () => {
  assert.equal(dollarsLabel(0), '$0.00');
  assert.equal(dollarsLabel('1234.5'), '$1,234.50');
  assert.equal(dollarsLabel(596.55), '$596.55');
  assert.equal(dollarsLabel(-5), '-$5.00');
  assert.equal(dollarsLabel(0.1 + 0.2), '$0.30');
  assert.equal(dollarsLabel('x'), '');
  assert.equal(dollarsLabel(null), '$0.00');
});

test('signedRecordFromRow reads the record off the row and resolves the revised date', () => {
  const r = signedRecordFromRow(ROW);
  assert.equal(r.documentVersion, 'event-services-agreement-v4');
  assert.equal(r.revisedDate, '2026-09-27');
  assert.equal(r.signedName, 'Test Signer');
  assert.equal(r.signedAt, ROW.client_signed_at);
  assert.equal(r.rows.length, 2);
  assert.equal(r.gratuityAmount, 80);
  assert.equal(r.gratuityLabel, 'Gratuity');
  assert.equal(r.total, 596.55);
  // A version with no date, and the snapshot's version when the column is empty.
  assert.equal(signedRecordFromRow({ ...ROW, client_signature_document_version: 'event-services-agreement-v2' }).revisedDate, null);
  assert.equal(signedRecordFromRow({ ...ROW, client_signature_document_version: null }).documentVersion, 'event-services-agreement-v4');
});

test('signedRecordFromRow is null for an unsigned row or a signature with no stored record', () => {
  assert.equal(signedRecordFromRow(null), null);
  assert.equal(signedRecordFromRow({ ...ROW, client_signed_at: null }), null);
  assert.equal(signedRecordFromRow({ ...ROW, client_signed_snapshot: null }), null);
  assert.equal(signedRecordFromRow({ ...ROW, client_signed_snapshot: 'not a record' }), null);
  assert.deepEqual(signedRecordBlock(null), { html: '', text: '' });
});

test('the block carries the version, the revised date, the signer, the time, every row, the gratuity and the total', () => {
  const { html, text } = signedRecordBlock(signedRecordFromRow(ROW));
  for (const body of [html, text]) {
    assert.match(body, /What you signed/);
    assert.match(body, /event-services-agreement-v4/);
    assert.match(body, /revised September 27, 2026/);
    assert.match(body, /signed by Test Signer/);
    assert.match(body, /October 1, 2026 at 10:00 AM Central/);
    assert.match(body, /Test Add-on/);
    assert.match(body, /\$476\.55/);
    assert.match(body, /\$40\.00/);
    assert.match(body, /Gratuity/);
    assert.match(body, /\$80\.00/);
    assert.match(body, /\$596\.55/);
    assert.ok(!body.includes('undefined') && !body.includes('NaN'), body);
  }
  assert.match(html, /Test Flat &lt;Bar&gt;/, 'labels are escaped in the HTML');
  assert.match(text, /Test Flat <Bar>: \$476\.55/);
  assert.match(text, /Total: \$596\.55/);
});

test('a record with no gratuity, no total and no name still renders cleanly', () => {
  const { html, text } = signedRecordBlock({ documentVersion: null, revisedDate: null, signedName: null, signedAt: 'junk', rows: [{ key: 'package', label: null, amount: 10 }], gratuityAmount: 0, total: null });
  assert.match(text, /Event Services Agreement; signed\./);
  assert.match(text, /Your package: \$10\.00/);
  assert.ok(!/Total:/.test(text));
  assert.ok(!/Gratuity/.test(html));
  assert.ok(!html.includes('undefined') && !html.includes('Invalid Date'));
});
