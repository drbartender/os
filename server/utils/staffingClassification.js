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

module.exports = { computeRemaining, classifyRequest, isEventFullyStaffed };
