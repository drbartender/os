'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeRemaining, classifyRequest, isEventFullyStaffed, roleFill } = require('./staffingClassification');

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

test('empty remaining map is vacuously fully staffed', () => {
  // Array.prototype.every on an empty list returns true, so an empty remaining
  // map reports fully staffed. Consumers with a genuinely empty roster must
  // special-case that BEFORE calling this (an event needing zero staff is not
  // the same thing as an event with every slot filled).
  assert.equal(isEventFullyStaffed({}), true);
  assert.equal(isEventFullyStaffed({ Bartender: 1 }), false);
  assert.equal(isEventFullyStaffed({ Bartender: 0 }), true);
});

// roleFill: the staffing rule by role (lane staffing-rule-by-role, 2026-09-30).
const MIXED = ['Bartender', 'Bartender', 'Barback'];
const pick = ({ slots, open, filled }) => ({ slots, open, filled });

test('roleFill: an over-filled role never fills another role\'s open slot', () => {
  assert.deepEqual(pick(roleFill(MIXED, { Bartender: 3 })), { slots: 3, open: 1, filled: 2 });
});

test('roleFill: an approval in a role the roster never declared fills nothing', () => {
  assert.deepEqual(pick(roleFill(['Bartender'], { Barback: 1 })), { slots: 1, open: 1, filled: 0 });
});

test('roleFill: a roleless approval takes the first role with room', () => {
  const f = roleFill(MIXED, { Bartender: 2 }, 1);
  assert.deepEqual(pick(f), { slots: 3, open: 0, filled: 3 });
  assert.deepEqual(f.approvedByRole, { Bartender: 2, Barback: 1 });
});

test('roleFill: a roleless approval with no room anywhere lands on the first role and fills nothing more', () => {
  const f = roleFill(['Bartender'], { Bartender: 1 }, 1);
  assert.deepEqual(pick(f), { slots: 1, open: 0, filled: 1 });
  assert.deepEqual(f.approvedByRole, { Bartender: 2 });
});

test('roleFill: an empty roster is one slot any approval fills', () => {
  assert.deepEqual(pick(roleFill([], {}, 0)), { slots: 1, open: 1, filled: 0 });
  assert.deepEqual(pick(roleFill([], { Barback: 1 }, 0)), { slots: 1, open: 0, filled: 1 });
  assert.deepEqual(pick(roleFill([], {}, 1)), { slots: 1, open: 0, filled: 1 });
});

test('roleFill: exactly filled mixed roster is full', () => {
  assert.deepEqual(pick(roleFill(MIXED, { Bartender: 2, Barback: 1 })), { slots: 3, open: 0, filled: 3 });
});
