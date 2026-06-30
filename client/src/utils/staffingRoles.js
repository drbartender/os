// Mirror of server/utils/staffingRoles.js + positionsNeeded.js +
// staffingClassification.js. Keep in sync manually (same dual-file pattern as
// eventTypes.js). The exact label 'Bartender' is load-bearing for payroll on
// the server; here it drives per-role fill, the request picker, and waitlist
// classification.

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
