'use strict';

// Pure per-role staffing classification. Given an event's positions_needed
// (already parsed to a flat canonical array) and a map of approved-active
// counts per role, compute how many slots remain per role, and classify a
// single request as actionable (has an open slot for one of its ranked roles)
// or waitlisted (none of its ranked roles is open). An empty requested list
// is treated as "any role" (legacy rows backfilled from a single position,
// or pre-migration rows with no ranking).

const { rosterCounts } = require('./positionsNeeded');

function computeRemaining(positionsNeeded, approvedByRole = {}) {
  const needed = rosterCounts(positionsNeeded);
  const remaining = {};
  for (const role of Object.keys(needed)) {
    remaining[role] = needed[role] - (approvedByRole[role] || 0);
  }
  return remaining;
}

function classifyRequest(requestedPositions, remaining) {
  const ranked = (Array.isArray(requestedPositions) && requestedPositions.length)
    ? requestedPositions
    : Object.keys(remaining); // empty = any role, in roster order
  for (const role of ranked) {
    if ((remaining[role] || 0) > 0) return { state: 'actionable', resolvableRole: role };
  }
  return { state: 'waitlisted', resolvableRole: null };
}

function isEventFullyStaffed(remaining) {
  return Object.values(remaining).every((n) => n <= 0);
}

// How many of a shift's slots are filled, counted BY ROLE: a slot is filled
// only by someone approved for that role, so an extra bartender never fills an
// open barback slot, and an approval in a role the roster never declared fills
// nothing. An approval with no role on file takes the first role with room, in
// roster order. A roster that declares no roles is one slot any approval fills.
// CJS twin of roleFill in client/src/components/adminos/shifts.js (keep in sync
// manually, the eventTypes.js pattern), and the rule openSlotsSql
// (positionsNeeded.js) states in SQL; openSlotsSql.test.js pins the two.
function roleFill(roster, approvedByRole = {}, roleless = 0) {
  const needed = rosterCounts(roster);
  const roleOrder = Object.keys(needed);
  const byRole = { ...approvedByRole };
  for (let i = 0; i < roleless; i++) {
    const room = roleOrder.find((role) => needed[role] - (byRole[role] || 0) > 0) || roleOrder[0];
    if (room) byRole[room] = (byRole[room] || 0) + 1;
  }
  const remaining = computeRemaining(roster, byRole);
  const slots = (Array.isArray(roster) ? roster.length : 0) || 1;
  const approvedTotal = Object.values(approvedByRole).reduce((a, n) => a + n, 0) + roleless;
  const open = roleOrder.length === 0
    ? Math.max(0, slots - approvedTotal)
    : roleOrder.reduce((sum, role) => sum + Math.max(0, remaining[role] || 0), 0);
  return { slots, open, filled: Math.max(0, slots - open), remaining, approvedByRole: byRole };
}

module.exports = { computeRemaining, classifyRequest, isEventFullyStaffed, roleFill };
