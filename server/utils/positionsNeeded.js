'use strict';

// Shape-tolerant parser for shifts.positions_needed. Production holds two
// historical shapes: a flat string array ["Bartender","Bartender"] and a
// legacy object array [{position:'bartender',count:2}]. Every reader of
// positions_needed must go through this, never a bare JSON.parse, or legacy
// object-shaped rows render as garbage. Malformed input normalizes to [].

const { canonicalizeRole } = require('./staffingRoles');

function parsePositionsNeeded(raw) {
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

function rosterCounts(positionsArray) {
  const counts = {};
  for (const role of positionsArray) counts[role] = (counts[role] || 0) + 1;
  return counts;
}

module.exports = { parsePositionsNeeded, rosterCounts };
