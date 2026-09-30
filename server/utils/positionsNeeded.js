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

// SQL twin of canonicalizeRole (staffingRoles.js): the canonical label for a
// role text, or NULL. Trims whitespace and folds case; 'server' is Banquet
// Server. Anything else, NULL included, is NULL.
function canonRoleSql(expr) {
  return `(CASE lower(regexp_replace(${expr}, '^\\s+|\\s+$', '', 'g'))
      WHEN 'bartender' THEN 'Bartender'
      WHEN 'banquet server' THEN 'Banquet Server'
      WHEN 'server' THEN 'Banquet Server'
      WHEN 'barback' THEN 'Barback'
    END)`;
}

// A shift's OPEN SLOTS, counted BY ROLE, as one scalar SQL expression over the
// shift alias. The staffing rule every surface shares (lane
// staffing-rule-by-role, 2026-09-30): roleFill in staffingClassification.js and
// its client twin in client/src/components/adminos/shifts.js say it in JS, and
// openSlotsSql.test.js pins this fragment to roleFill row by row.
//   - The roster is parsePositionsNeeded's reading of positions_needed: a JSON
//     string is one slot of its role; a JSON object is `count` slots of its
//     `position` (a number or a decimal string such as "2", " 2 ", "+1", ".5"
//     or "5.", ceiled and floored at 0; true is 1; anything else 0); an unknown
//     role, and any other element, fills nothing. A count is capped at 1000 per
//     element, so an absurd one can never overflow the ::int below and 500 the
//     badge (the JS parser would loop that many times; the write path is the
//     real fix, on the fix list). The pattern pads with ASCII whitespace only
//     and trims the same class: Postgres \s also matches Unicode spaces (a
//     no-break space) that ::numeric rejects, and one such row would raise
//     22P02 and 500 every query this sits in. JS coercions not mirrored, none
//     ever held by a row: counts Number() reads beyond ASCII-padded decimals
//     (hex, exponent, Infinity, Unicode-space padding) are 0 here, and a nested
//     one-element array (String(["Bartender"]) is "Bartender") fills nothing.
//   - A NULL, malformed or non-array column is an empty roster. IS JSON ARRAY is
//     a CRASH GUARD: positions_needed is TEXT, and a bare ::jsonb cast raises
//     22P02 on one bad row and 500s every query this sits in.
//   - Approved = status 'approved' AND dropped_at IS NULL (a drop leaves the
//     status approved). A canonical position is NAMED; NULL or unknown text is
//     ROLELESS.
//   - With roles: open = max(0, sum of max(0, needed - named) per roster role,
//     minus roleless), since each roleless approval fills one open slot while
//     any remains, which is what roleFill's "first role with room" does to the
//     total. A named approval in a role the roster never declared fills nothing.
//   - With no roles: one slot, open = max(0, 1 - every approval).
function openSlotsSql(shiftAlias = 's') {
  const a = shiftAlias;
  return `(WITH roster AS (
      SELECT role, SUM(n) AS need FROM (
        SELECT ${canonRoleSql(`CASE jsonb_typeof(e) WHEN 'string' THEN e #>> '{}' WHEN 'object' THEN e ->> 'position' END`)} AS role,
               CASE WHEN jsonb_typeof(e) <> 'object' THEN 1
                    WHEN jsonb_typeof(e -> 'count') = 'number'
                      THEN LEAST(1000, GREATEST(0, CEIL((e ->> 'count')::numeric)))
                    WHEN jsonb_typeof(e -> 'count') = 'string'
                         AND (e ->> 'count') ~ '^[ \\t\\r\\n]*\\+?([0-9]+\\.?[0-9]*|\\.[0-9]+)[ \\t\\r\\n]*$'
                      THEN LEAST(1000, CEIL(regexp_replace(e ->> 'count', '^[ \\t\\r\\n]+|[ \\t\\r\\n]+$', '', 'g')::numeric))
                    WHEN (e -> 'count') = 'true'::jsonb THEN 1
                    ELSE 0 END AS n
          FROM jsonb_array_elements(CASE WHEN ${a}.positions_needed IS JSON ARRAY
                                         THEN ${a}.positions_needed::jsonb ELSE '[]'::jsonb END) e
      ) el
      WHERE role IS NOT NULL
      GROUP BY role
    ), approved AS (
      SELECT ${canonRoleSql('sr.position')} AS role
        FROM shift_requests sr
       WHERE sr.shift_id = ${a}.id AND sr.status = 'approved' AND sr.dropped_at IS NULL
    )
    SELECT (CASE
      WHEN COALESCE((SELECT SUM(need) FROM roster), 0) = 0
        THEN GREATEST(0, 1 - (SELECT COUNT(*) FROM approved))
      ELSE GREATEST(0,
        (SELECT COALESCE(SUM(GREATEST(0, r.need - (SELECT COUNT(*) FROM approved ap WHERE ap.role = r.role))), 0) FROM roster r)
        - (SELECT COUNT(*) FROM approved WHERE role IS NULL))
    END)::int)`;
}

module.exports = { parsePositionsNeeded, rosterCounts, canonRoleSql, openSlotsSql };
