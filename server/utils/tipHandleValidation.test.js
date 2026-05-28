const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeVenmoHandle,
  normalizeCashappHandle,
  normalizePaypalUrl,
  normalizeZelleHandle,
  normalizeTipHandlesInPlace,
} = require('./tipHandleValidation');

test('normalizeVenmoHandle > strips leading @ and validates', () => {
  assert.strictEqual(normalizeVenmoHandle('@rosa'), 'rosa');
  assert.strictEqual(normalizeVenmoHandle('rosa.m'), 'rosa.m');
  assert.strictEqual(normalizeVenmoHandle(null), null);
  assert.strictEqual(normalizeVenmoHandle(''), null);
});

test('normalizeVenmoHandle > rejects garbage', () => {
  assert.throws(() => normalizeVenmoHandle('rosa space'), (err) => err.fieldErrors && 'venmo_handle' in err.fieldErrors);
  assert.throws(() => normalizeVenmoHandle('a'.repeat(31)), (err) => err.fieldErrors && 'venmo_handle' in err.fieldErrors);
});

test('normalizeCashappHandle > strips leading $ and validates', () => {
  assert.strictEqual(normalizeCashappHandle('$rosa'), 'rosa');
  assert.strictEqual(normalizeCashappHandle('rosa_m'), 'rosa_m');
});

test('normalizePaypalUrl > canonicalizes to https://paypal.me/<user>', () => {
  assert.strictEqual(normalizePaypalUrl('@rosa'), 'https://paypal.me/rosa');
  assert.strictEqual(normalizePaypalUrl('rosa'), 'https://paypal.me/rosa');
  assert.strictEqual(normalizePaypalUrl('https://paypal.me/rosa'), 'https://paypal.me/rosa');
  assert.strictEqual(normalizePaypalUrl('paypal.me/rosa'), 'https://paypal.me/rosa');
  assert.strictEqual(normalizePaypalUrl('www.paypal.me/rosa'), 'https://paypal.me/rosa');
});

test('normalizePaypalUrl > rejects non-paypal.me URLs', () => {
  assert.throws(() => normalizePaypalUrl('https://example.com/rosa'), (err) => err.fieldErrors && 'paypal_url' in err.fieldErrors);
  assert.throws(() => normalizePaypalUrl('javascript:alert(1)'), (err) => err.fieldErrors && 'paypal_url' in err.fieldErrors);
});

// ─── Zelle (Task 6) ───
test('normalizeZelleHandle > accepts email and lowercases', () => {
  assert.strictEqual(normalizeZelleHandle('Rosa@Example.COM'), 'rosa@example.com');
  assert.strictEqual(normalizeZelleHandle('rosa.m@example.com'), 'rosa.m@example.com');
});

test('normalizeZelleHandle > accepts US phone (formatted) and normalizes to E.164', () => {
  assert.strictEqual(normalizeZelleHandle('(312) 555-1234'), '+13125551234');
  assert.strictEqual(normalizeZelleHandle('312-555-1234'), '+13125551234');
  assert.strictEqual(normalizeZelleHandle('312.555.1234'), '+13125551234');
  assert.strictEqual(normalizeZelleHandle('3125551234'), '+13125551234');
});

test('normalizeZelleHandle > accepts E.164 phone as-is', () => {
  assert.strictEqual(normalizeZelleHandle('+13125551234'), '+13125551234');
  assert.strictEqual(normalizeZelleHandle('+447911123456'), '+447911123456');
});

test('normalizeZelleHandle > null on empty/null input', () => {
  assert.strictEqual(normalizeZelleHandle(null), null);
  assert.strictEqual(normalizeZelleHandle(''), null);
  assert.strictEqual(normalizeZelleHandle('   '), null);
});

test('normalizeZelleHandle > rejects garbage', () => {
  assert.throws(() => normalizeZelleHandle('not a phone or email'), (err) => err.fieldErrors && 'zelle_handle' in err.fieldErrors);
  assert.throws(() => normalizeZelleHandle('123'), (err) => err.fieldErrors && 'zelle_handle' in err.fieldErrors);
  assert.throws(() => normalizeZelleHandle('rosa@'), (err) => err.fieldErrors && 'zelle_handle' in err.fieldErrors);
});

test('normalizeTipHandlesInPlace > processes zelle_handle alongside other handles', () => {
  const updates = {
    venmo_handle: '@rosa',
    zelle_handle: '(312) 555-1234',
    paypal_url: 'paypal.me/rosa',
  };
  normalizeTipHandlesInPlace(updates);
  assert.strictEqual(updates.venmo_handle, 'rosa');
  assert.strictEqual(updates.zelle_handle, '+13125551234');
  assert.strictEqual(updates.paypal_url, 'https://paypal.me/rosa');
});

test('normalizeTipHandlesInPlace > leaves keys absent from the update untouched', () => {
  const updates = { zelle_handle: 'rosa@example.com' };
  normalizeTipHandlesInPlace(updates);
  assert.strictEqual(updates.zelle_handle, 'rosa@example.com');
  assert.ok(!('venmo_handle' in updates));
});
