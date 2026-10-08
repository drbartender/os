'use strict';

// The context card (spec 4.2), loaded per opened item. Shapes live in
// contextFormat.js (pure); this file only reads. The staff card uses the
// canonical predicates: shiftNotFinishedSql for "upcoming" and openSlotsSql for
// the roster fill (settings.js:133-150 records what drift costs).

const { pool } = require('../../db');
const { shiftNotFinishedSql } = require('../shiftEndInstant');
const { openSlotsSql, parsePositionsNeeded } = require('../positionsNeeded');
const { canonicalizeRole } = require('../staffingRoles');
const { parsePersonKey } = require('./personKey');
const { latestPhoneOf } = require('./people');
const { clientContext, staffContext, ttLeadContext, unknownContext } = require('./contextFormat');

const CLIENT_PROPOSALS_SQL = `
  SELECT id, status, to_char(event_date, 'YYYY-MM-DD') AS event_date, event_start_time, event_type, event_type_custom,
         guest_count, venue_name, venue_city, event_location, total_price, amount_paid,
         to_char(balance_due_date, 'YYYY-MM-DD') AS balance_due_date, client_signed_at, created_at
    FROM proposals
   WHERE client_id = $1`;

// The next approved, unfinished shift (4.2). The outer alias is req because
// openSlotsSql's own subquery uses sr.
const NEXT_SHIFT_SQL = `
  SELECT s.id, to_char(s.event_date, 'YYYY-MM-DD') AS event_date, s.start_time, s.location,
         s.event_type, s.event_type_custom, s.positions_needed, req.position,
         ${openSlotsSql('s')} AS open_slots
    FROM shift_requests req
    JOIN shifts s ON s.id = req.shift_id
    LEFT JOIN proposals p ON p.id = s.proposal_id
   WHERE req.user_id = $1 AND req.status = 'approved' AND req.dropped_at IS NULL
     AND COALESCE(s.status, '') <> 'cancelled'
     AND ${shiftNotFinishedSql('s', 'p')}
   ORDER BY s.event_date ASC, s.id ASC
   LIMIT 1`;

const USER_ROLE_SQL = 'SELECT role FROM users WHERE id = $1';

// A key parsePersonKey rejects has no card (the route checks first; this is
// for any other caller).
async function loadContext({ personKey, index, events, todayYmd, legalHoldIds = [] }, db = pool) {
  const key = parsePersonKey(personKey);
  if (!key) return { context: null, legalHold: false };
  const holds = new Set(legalHoldIds.map(Number));
  if (key.type === 'c') {
    const { rows } = await db.query(CLIENT_PROPOSALS_SQL, [Number(key.id)]);
    return {
      context: clientContext({ clientId: Number(key.id), proposals: rows, todayYmd }),
      legalHold: rows.some((p) => holds.has(Number(p.id))),
    };
  }
  if (key.type === 's') {
    const [shiftRes, userRes] = await Promise.all([
      db.query(NEXT_SHIFT_SQL, [Number(key.id)]),
      db.query(USER_ROLE_SQL, [Number(key.id)]),
    ]);
    const shift = shiftRes.rows[0] || null;
    const fallback = userRes.rows[0] && userRes.rows[0].role === 'manager' ? 'Manager' : 'Staff';
    const role = (shift && canonicalizeRole(shift.position)) || fallback;
    const card = shift ? { ...shift, total: parsePositionsNeeded(shift.positions_needed).length || 1 } : null;
    return { context: staffContext({ userId: Number(key.id), role, shift: card, todayYmd }), legalHold: false };
  }
  if (key.type === 't') return { context: ttLeadContext(index.leadsByNegotiation.get(key.id) || null, key.id), legalHold: false };
  return { context: unknownContext(latestPhoneOf(events)), legalHold: false };
}

module.exports = { loadContext, CLIENT_PROPOSALS_SQL, NEXT_SHIFT_SQL };
