// Mirror of server/utils/staffingRoles.js + positionsNeeded.js +
// staffingClassification.js. Keep in sync manually (same dual-file pattern as
// eventTypes.js). The exact label 'Bartender' is load-bearing for payroll on
// the server; here it drives per-role fill, the request picker, and waitlist
// classification.
//
// ONE DELIBERATE ASYMMETRY: `defaultAssignRole` (and ASSIGN_ROLE_PREFERENCE)
// live here only. Do NOT "sync" them onto the server. See the comment on the
// function for why.

export const ROLES = {
  BARTENDER: 'Bartender',
  BANQUET_SERVER: 'Banquet Server',
  BARBACK: 'Barback',
};

export const CANONICAL_LABELS = [ROLES.BARTENDER, ROLES.BANQUET_SERVER, ROLES.BARBACK];

export function canonicalizeRole(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'bartender') return ROLES.BARTENDER;
  if (v === 'banquet server' || v === 'server') return ROLES.BANQUET_SERVER;
  if (v === 'barback') return ROLES.BARBACK;
  return null;
}

export function isBartender(position) {
  return typeof position === 'string' && position.trim().toLowerCase() === 'bartender';
}

export function parsePositionsNeeded(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const entry of arr) {
    if (entry && typeof entry === 'object' && 'position' in entry) {
      const role = canonicalizeRole(entry.position);
      const count = Math.max(0, Number(entry.count) || 0);
      for (let i = 0; i < count; i++) if (role) out.push(role);
    } else {
      const role = canonicalizeRole(entry);
      if (role) out.push(role);
    }
  }
  return out;
}

export function rosterCounts(positionsArray) {
  const counts = {};
  for (const role of positionsArray) counts[role] = (counts[role] || 0) + 1;
  return counts;
}

export function computeRemaining(positionsNeeded, approvedByRole = {}) {
  const needed = rosterCounts(positionsNeeded);
  const remaining = {};
  for (const role of Object.keys(needed)) {
    remaining[role] = needed[role] - (approvedByRole[role] || 0);
  }
  return remaining;
}

export function classifyRequest(requestedPositions, remaining) {
  const ranked = (Array.isArray(requestedPositions) && requestedPositions.length)
    ? requestedPositions
    : Object.keys(remaining);
  for (const role of ranked) {
    if ((remaining[role] || 0) > 0) return { state: 'actionable', resolvableRole: role };
  }
  return { state: 'waitlisted', resolvableRole: null };
}

export function isEventFullyStaffed(remaining) {
  return Object.values(remaining).every((n) => n <= 0);
}

// Preference order for the assign-picker default. Its own constant rather than
// a reuse of CANONICAL_LABELS: that list's order is incidental, this one is a
// product decision (Bartender first; Banquet Server before Barback).
export const ASSIGN_ROLE_PREFERENCE = [
  ROLES.BARTENDER,
  ROLES.BANQUET_SERVER,
  ROLES.BARBACK,
];

// The role an admin-facing assign picker preselects for a shift. Walks the
// preference order and returns the first role with an open slot; if every role
// is full it returns the first preferred role the roster actually holds (the
// caller's over-fill confirm still gates the write); an empty or legacy roster
// falls back to 'Bartender'.
//
// CLIENT-ONLY BY DESIGN — do not mirror this onto the server. `position` is the
// column payroll's tip split keys on, and the server deliberately refuses to
// default it: POST /shifts/:id/assign 400s without an explicit canonical role
// (server/routes/shifts.approval.js). This preselects a VISIBLE, changeable
// value in a dropdown, so a human still sees the role before it is written.
// A server-side defaultAssignRole would turn that into a silent write.
export function defaultAssignRole(roster, remaining = {}) {
  const open = remaining && typeof remaining === 'object' ? remaining : {};
  for (const role of ASSIGN_ROLE_PREFERENCE) {
    if ((open[role] || 0) > 0) return role;
  }
  const rosterRoles = new Set(Array.isArray(roster) ? roster : []);
  for (const role of ASSIGN_ROLE_PREFERENCE) {
    if (rosterRoles.has(role)) return role;
  }
  return ROLES.BARTENDER;
}
