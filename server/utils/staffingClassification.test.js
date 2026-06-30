'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeRemaining, classifyRequest, isEventFullyStaffed } = require('./staffingClassification');

test('computeRemaining = needed - approved per role', () => {
  assert.deepEqual(
    computeRemaining(['Bartender', 'Bartender', 'Banquet Server'], { Bartender: 2 }),
    { Bartender: 0, 'Banquet Server': 1 },
  );
});

test('computeRemaining can go negative on an over-fill', () => {
  assert.deepEqual(
    computeRemaining(['Bartender'], { Bartender: 2 }),
    { Bartender: -1 },
  );
});

test('classify actionable picks top ranked open role', () => {
  assert.deepEqual(
    classifyRequest(['Bartender', 'Banquet Server'], { Bartender: 0, 'Banquet Server': 1 }),
    { state: 'actionable', resolvableRole: 'Banquet Server' },
  );
});

test('classify waitlisted when no ranked role open', () => {
  assert.deepEqual(
    classifyRequest(['Bartender'], { Bartender: 0, 'Banquet Server': 1 }),
    { state: 'waitlisted', resolvableRole: null },
  );
});

test('empty requested = any role (first open in roster order)', () => {
  assert.deepEqual(
    classifyRequest([], { Bartender: 0, 'Banquet Server': 1 }),
    { state: 'actionable', resolvableRole: 'Banquet Server' },
  );
});

test('fully staffed when all <= 0', () => {
  assert.equal(isEventFullyStaffed({ Bartender: 0, 'Banquet Server': 0 }), true);
  assert.equal(isEventFullyStaffed({ Bartender: 0, 'Banquet Server': 1 }), false);
  assert.equal(isEventFullyStaffed({ Bartender: -1 }), true);
});
