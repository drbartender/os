const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toUsE164, isUsE164 } = require('./usPhone');

test('toUsE164: accepts 10-digit US in any format → +1 E.164', () => {
  assert.equal(toUsE164('3125551234'), '+13125551234');
  assert.equal(toUsE164('(312) 555-1234'), '+13125551234');
  assert.equal(toUsE164('312-555-1234'), '+13125551234');
  assert.equal(toUsE164('312.555.1234'), '+13125551234');
});

test('toUsE164: accepts 11-digit leading-1 and already-E.164 US', () => {
  assert.equal(toUsE164('13125551234'), '+13125551234');
  assert.equal(toUsE164('+13125551234'), '+13125551234');
  assert.equal(toUsE164('1 (312) 555-1234'), '+13125551234');
});

test('toUsE164: rejects international numbers (not +1 NANP)', () => {
  assert.equal(toUsE164('+639171234567'), null); // PH — VA_CELL must never come through here
  assert.equal(toUsE164('+442071234567'), null); // UK
  assert.equal(toUsE164('+5215512345678'), null); // MX
});

test('toUsE164: rejects premium 900/976 area codes', () => {
  assert.equal(toUsE164('9005551234'), null);
  assert.equal(toUsE164('+19005551234'), null);
  assert.equal(toUsE164('9765551234'), null);
  assert.equal(toUsE164('+19765551234'), null);
});

test('toUsE164: rejects foreign NANP nations (Caribbean IRSF targets), keeps US', () => {
  // These share +1 and pass the NANP shape check, but are foreign toll-fraud
  // destinations — must be rejected.
  assert.equal(toUsE164('+18095551234'), null); // Dominican Republic (809)
  assert.equal(toUsE164('8095551234'), null);   // DR, un-prefixed
  assert.equal(toUsE164('+18765551234'), null); // Jamaica (876)
  assert.equal(toUsE164('+12425551234'), null); // Bahamas (242)
  // A normal US number is still accepted.
  assert.equal(toUsE164('+13125551234'), '+13125551234');
  assert.equal(toUsE164('3125551234'), '+13125551234');
});

test('isUsE164: rejects foreign NANP area codes but allows US territories', () => {
  assert.equal(isUsE164('+18095551234'), false); // DR
  assert.equal(isUsE164('+18765551234'), false); // Jamaica
  assert.equal(isUsE164('+17875551234'), true);  // Puerto Rico (US territory) stays allowed
  assert.equal(isUsE164('+13125551234'), true);  // mainland US
});

test('toUsE164: rejects invalid NANP shapes (area/exchange leading 0 or 1)', () => {
  assert.equal(toUsE164('1125551234'), null); // area code starts with 1
  assert.equal(toUsE164('0125551234'), null); // area code starts with 0
});

test('toUsE164: rejects junk / wrong length / falsy', () => {
  assert.equal(toUsE164('not-a-phone'), null);
  assert.equal(toUsE164('5551234'), null);   // 7 digits
  assert.equal(toUsE164('312555123456'), null); // 12 digits
  assert.equal(toUsE164(''), null);
  assert.equal(toUsE164(null), null);
  assert.equal(toUsE164(undefined), null);
});

test('isUsE164: strict predicate over already-formatted strings', () => {
  assert.equal(isUsE164('+13125551234'), true);
  assert.equal(isUsE164('+19005551234'), false); // 900 blocked
  assert.equal(isUsE164('+19765551234'), false); // 976 blocked
  assert.equal(isUsE164('3125551234'), false);   // not yet E.164
  assert.equal(isUsE164('+639171234567'), false); // intl
  assert.equal(isUsE164(''), false);
  assert.equal(isUsE164(null), false);
  assert.equal(isUsE164(12345), false);
});
