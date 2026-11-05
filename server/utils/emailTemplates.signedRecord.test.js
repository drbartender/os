// The sign-time emails carry the terms as signed (audit ESIG-05): the
// sign-only confirmation and both shapes of the signed-and-paid email print
// the agreement version and revised date, the signer and time, every row the
// page drew, the gratuity line and the acknowledged total when handed the
// row's signed record, and keep their old bodies without one. Pure.
//
// Run: node --test server/utils/emailTemplates.signedRecord.test.js

require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { proposalSignedConfirmation, signedAndPaidClient } = require('./emailTemplates');
const { signedRecordFromRow } = require('./signedRecordEmail');

const RECORD = signedRecordFromRow({
  client_signed_name: 'Test Signer',
  client_signed_at: '2026-10-01T15:00:00.000Z',
  client_signature_document_version: 'event-services-agreement-v4',
  client_signed_snapshot: {
    record_version: 1, document_version: 'event-services-agreement-v4',
    rows: [{ key: 'package', label: 'Test Flat', amount: 476.55 }, { key: 'bar-rental', label: 'Bar Rental', amount: 50 }],
    gratuity_amount: 80, gratuity_label: 'Gratuity', total: 606.55, snapshot: { total: 606.55 },
  },
});

function assertCarriesRecord(body, label) {
  for (const re of [/What you signed/, /event-services-agreement-v4/, /revised September 27, 2026/, /signed by Test Signer/,
    /October 1, 2026 at 10:00 AM Central/, /Test Flat/, /\$476\.55/, /Bar Rental/, /\$50\.00/, /Gratuity/, /\$80\.00/, /\$606\.55/]) {
    assert.match(body, re, `${label} carries ${re}`);
  }
  assert.ok(!body.includes('undefined'), `${label} has no undefined`);
}

test('proposalSignedConfirmation with the signed record carries the version, name, time, rows and total in html and text', () => {
  const out = proposalSignedConfirmation({ clientName: 'Test Signer', eventTypeLabel: 'wedding', signedRecord: RECORD });
  assert.equal(out.subject, 'Proposal Signed: your wedding - Dr. Bartender');
  assertCarriesRecord(out.html, 'html');
  assertCarriesRecord(out.text, 'text');
  assert.match(out.text, /Total: \$606\.55/);
  assert.match(out.text, /Next step: submit your deposit/);
  assert.match(out.text, /Cheers, Dallas$/);
});

test('proposalSignedConfirmation without a record keeps the short body', () => {
  const out = proposalSignedConfirmation({ clientName: 'Test Signer', eventTypeLabel: 'wedding' });
  assert.ok(!out.html.includes('What you signed'));
  assert.ok(!out.text.includes('What you signed'));
  assert.match(out.text, /Next step: submit your deposit to lock in your date\. Cheers, Dallas/);
  assert.deepEqual(out, proposalSignedConfirmation({ clientName: 'Test Signer', eventTypeLabel: 'wedding', signedRecord: null }));
});

test('signedAndPaidClient carries the record in the short shape and in the orientation shape, and not without one', () => {
  const short = signedAndPaidClient({ clientName: 'Test Signer', eventTypeLabel: 'wedding', amount: '100.00', paymentType: 'deposit', signedRecord: RECORD });
  assertCarriesRecord(short.html, 'short html');
  assertCarriesRecord(short.text, 'short text');
  assert.match(short.text, /Your date is officially on the books\./);

  const orientation = signedAndPaidClient({
    clientName: 'Test Signer', eventTypeLabel: 'wedding', amount: '100.00', paymentType: 'deposit',
    bookingBlock: { formattedEventDate: 'Saturday, June 12, 2027', formattedStartTime: '6:00 PM', eventLocation: '123 Test St', guestCount: 50, packageName: 'Test Flat' },
    receiptBlock: { depositPaid: '100.00', balanceRemaining: '506.55', paidInFull: false, autopayEnrolled: false, dueLabel: 'due on', formattedBalanceDueDate: 'May 29, 2027' },
    potionPlannerUrl: 'https://example.com/plan/abc',
    timelineLines: ['Drink plan: pick yours any time'],
    signedRecord: RECORD,
  });
  assertCarriesRecord(orientation.html, 'orientation html');
  assertCarriesRecord(orientation.text, 'orientation text');
  assert.match(orientation.html, /Receipt/);
  assert.match(orientation.html, /Pick your drinks/);

  const without = signedAndPaidClient({ clientName: 'Test Signer', eventTypeLabel: 'wedding', amount: '100.00', paymentType: 'deposit' });
  assert.ok(!without.html.includes('What you signed') && !without.text.includes('What you signed'));
});
