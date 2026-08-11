const test = require('node:test');
const assert = require('node:assert');
const {
  TIP_METHOD_TOKENS, computeOrderedMethods, deriveAvailableMethods, readSideNormalize,
} = require('./tipMethods');

test('token list is the canonical five, in natural fallback order', () => {
  assert.deepStrictEqual(TIP_METHOD_TOKENS, ['card', 'venmo', 'cashapp', 'paypal', 'zelle']);
});

test('no saved order falls back to natural order', () => {
  assert.deepStrictEqual(
    computeOrderedMethods(new Set(['venmo', 'card', 'zelle']), null),
    ['card', 'venmo', 'zelle']
  );
});

test('saved order wins, natural order fills the tail', () => {
  assert.deepStrictEqual(
    computeOrderedMethods(new Set(['card', 'venmo', 'cashapp']), ['venmo']),
    ['venmo', 'card', 'cashapp']
  );
});

test('saved tokens that are not available are skipped', () => {
  assert.deepStrictEqual(computeOrderedMethods(new Set(['card']), ['venmo', 'card']), ['card']);
});

test('unknown and duplicate saved tokens are ignored', () => {
  assert.deepStrictEqual(
    computeOrderedMethods(new Set(['card', 'venmo']), ['bogus', 'venmo', 'venmo']),
    ['venmo', 'card']
  );
});

test('nothing available yields an empty list', () => {
  assert.deepStrictEqual(computeOrderedMethods(new Set(), ['venmo']), []);
});

test('a non-array saved order is tolerated', () => {
  assert.deepStrictEqual(computeOrderedMethods(new Set(['venmo']), 'venmo'), ['venmo']);
  assert.deepStrictEqual(computeOrderedMethods(new Set(['venmo']), undefined), ['venmo']);
});

test('availability keys off the NORMALIZED paypal/zelle, not the raw columns', () => {
  const a = deriveAvailableMethods({
    stripe_payment_link_url: 'https://buy.stripe.com/x',
    venmo_handle: '@m',
    cashapp_handle: null,
    paypalUrl: null, // failed read-side validation
    zelleHandle: null,
  });
  assert.deepStrictEqual([...a].sort(), ['card', 'venmo']);
});

test('availability is empty for a profile with nothing set', () => {
  assert.strictEqual(deriveAvailableMethods({}).size, 0);
});

test('readSideNormalize drops a malformed paypal_url instead of throwing', () => {
  const out = readSideNormalize(
    { paypal_url: 'https://evil.example.com/pay', zelle_handle: null },
    { route: 'test', tokenPrefix: 'abcd1234' }
  );
  assert.strictEqual(out.paypalUrl, null);
});

test('readSideNormalize canonicalizes a good paypal_url and zelle_handle', () => {
  const out = readSideNormalize(
    { paypal_url: 'paypal.me/marcus', zelle_handle: 'Marcus@Example.COM' },
    { route: 'test', tokenPrefix: 'abcd1234' }
  );
  assert.strictEqual(out.paypalUrl, 'https://paypal.me/marcus');
  assert.strictEqual(out.zelleHandle, 'marcus@example.com');
});
