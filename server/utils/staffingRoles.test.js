'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { canonicalizeRole, isBartender, CANONICAL_LABELS } = require('./staffingRoles');

test('canonicalizeRole maps case + legacy Server', () => {
  assert.equal(canonicalizeRole('bartender'), 'Bartender');
  assert.equal(canonicalizeRole('BARTENDER'), 'Bartender');
  assert.equal(canonicalizeRole('Server'), 'Banquet Server');
  assert.equal(canonicalizeRole('banquet server'), 'Banquet Server');
  assert.equal(canonicalizeRole('Barback'), 'Barback');
  assert.equal(canonicalizeRole('  bartender '), 'Bartender');
  assert.equal(canonicalizeRole('chef'), null);
  assert.equal(canonicalizeRole(null), null);
  assert.equal(canonicalizeRole(undefined), null);
});

test('isBartender is case-insensitive', () => {
  assert.equal(isBartender('bartender'), true);
  assert.equal(isBartender('Bartender'), true);
  assert.equal(isBartender('  BARTENDER '), true);
  assert.equal(isBartender('Banquet Server'), false);
  assert.equal(isBartender(null), false);
});

test('CANONICAL_LABELS is the three roles in order', () => {
  assert.deepEqual(CANONICAL_LABELS, ['Bartender', 'Banquet Server', 'Barback']);
});
