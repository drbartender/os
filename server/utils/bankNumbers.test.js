require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decrypt, encrypt } = require('./encryption');
const { ValidationError } = require('./errors');
const {
  isValidRoutingNumber,
  isValidAccountNumber,
  isMaskedBankValue,
  maskBankNumber,
  resolveBankFields,
} = require('./bankNumbers');

// 011000015 and 021000021 are published Federal Reserve and bank routing numbers,
// not anyone's account; the account numbers are made up.

test('routing numbers pass the ABA checksum and nothing else does', () => {
  assert.equal(isValidRoutingNumber('011000015'), true);
  assert.equal(isValidRoutingNumber('021000021'), true);
  assert.equal(isValidRoutingNumber('011000016'), false); // one digit off
  assert.equal(isValidRoutingNumber('123456789'), false);
  assert.equal(isValidRoutingNumber('01100001'), false);
  assert.equal(isValidRoutingNumber('0110000150'), false);
  assert.equal(isValidRoutingNumber('01100001a'), false);
  assert.equal(isValidRoutingNumber(11000015), false);
});

test('account numbers are 4 to 17 digits', () => {
  assert.equal(isValidAccountNumber('0001'), true);
  assert.equal(isValidAccountNumber('12345678901234567'), true);
  assert.equal(isValidAccountNumber('001'), false);
  assert.equal(isValidAccountNumber('123456789012345678'), false);
  assert.equal(isValidAccountNumber('12-34'), false);
});

test('the masked display value is recognized, a real number is not', () => {
  // What the GETs build: four stars plus the stored value's last four characters,
  // whatever they are, including a legacy number with a dash or a space near its
  // end and a row that already holds a stored mask (eight stars).
  for (const v of ['****', '****0015', '****1', ' ****4321 ', '****9-99', '**** 999', '****99-9', '********']) {
    assert.equal(isMaskedBankValue(v), true, v);
  }
  for (const v of ['011000015', '0001', '****12345', '12**34', '*1234', '**9876', '', null, undefined]) {
    assert.equal(isMaskedBankValue(v), false, String(v));
  }
});

test('a legacy stored number shown masked is kept, not refused', () => {
  assert.deepEqual(resolveBankFields({ routing_number: '****-999', account_number: '****8-90' }, { blank: 'clear' }), {
    routing_number: { keep: true, value: null },
    account_number: { keep: true, value: null },
  });
});

test('a masked value means keep, for both fields', () => {
  const out = resolveBankFields({ routing_number: '****0015', account_number: '****3456' }, { blank: 'require' });
  assert.deepEqual(out, {
    routing_number: { keep: true, value: null },
    account_number: { keep: true, value: null },
  });
});

test('a valid value is encrypted and decrypts back, trimmed', () => {
  const out = resolveBankFields({ routing_number: ' 011000015 ', account_number: '000123456' }, { blank: 'clear' });
  assert.equal(out.routing_number.keep, false);
  assert.equal(decrypt(out.routing_number.value), '011000015');
  assert.equal(decrypt(out.account_number.value), '000123456');
});

test('a field left out of the request means unchanged, in both modes', () => {
  const kept = { routing_number: { keep: true, value: null }, account_number: { keep: true, value: null } };
  assert.deepEqual(resolveBankFields({}, { blank: 'clear' }), kept);
  assert.deepEqual(resolveBankFields({}, { blank: 'require' }), kept);
});

test('a blank clears on the admin form and is refused for direct deposit', () => {
  assert.deepEqual(resolveBankFields({ routing_number: '', account_number: null }, { blank: 'clear' }), {
    routing_number: { keep: false, value: null },
    account_number: { keep: false, value: null },
  });
  assert.throws(
    () => resolveBankFields({ routing_number: '', account_number: '' }, { blank: 'require' }),
    (err) => err instanceof ValidationError
      && Boolean(err.fieldErrors.routing_number) && Boolean(err.fieldErrors.account_number),
  );
});

test('invalid values are refused together, keyed to each field', () => {
  assert.throws(
    () => resolveBankFields({ routing_number: '123456789', account_number: '12' }, { blank: 'clear' }),
    (err) => err instanceof ValidationError
      && /routing number/i.test(err.fieldErrors.routing_number)
      && /4 to 17 digits/.test(err.fieldErrors.account_number),
  );
  // Four stars and five more characters is longer than any mask, so it is checked
  // as a number and refused.
  assert.throws(
    () => resolveBankFields({ routing_number: '****00150', account_number: '****3456' }, { blank: 'clear' }),
    (err) => err instanceof ValidationError && Boolean(err.fieldErrors.routing_number) && !err.fieldErrors.account_number,
  );
});

// POUT-08 (audit 2026-11-05): the one safe mask, shared by GET /api/payment and
// the admin user record. Under a real key a good ciphertext masks to its last
// four; one that cannot be decrypted (a rotated key, a corrupted row) masks to
// '****' instead of throwing, so one bad row never 500s a whole profile read.
test('maskBankNumber masks to the last four, and to four stars alone when the ciphertext cannot be decrypted', () => {
  const prev = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  try {
    assert.equal(maskBankNumber(encrypt('011000015')), '****0015');
    assert.equal(maskBankNumber(null), null);
    assert.equal(maskBankNumber(''), '');
    // Well-formed ciphertext under some other key: decrypt() throws on the auth tag.
    const underAnotherKey = `enc:${'0'.repeat(32)}:${'0'.repeat(32)}:${'0'.repeat(32)}`;
    assert.throws(() => decrypt(underAnotherKey), 'premise: decrypt itself refuses the value');
    assert.equal(maskBankNumber(underAnotherKey, { userId: 1, column: 'routing_number' }), '****');
    assert.equal(isMaskedBankValue('****'), true, 'the degraded mask still round-trips as unchanged');
  } finally {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = prev;
  }
});
