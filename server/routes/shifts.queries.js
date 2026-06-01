/**
 * Long SQL strings for server/routes/shifts.js (Task 28 projections).
 *
 * Extracted so shifts.js stays under its 1000-line hard cap when adding the
 * cover_requested_at + cover_for_first_initial + payout_id projections.
 * The LATERAL subqueries are not reused elsewhere (yet) but live here as
 * sibling exports to keep the route handler readable.
 */

// Staff-side GET /api/shifts list. Projects BEO (drink plan + own ack) and
// cover (any active cover-requesting shift_request on this shift + the
// requester's first initial). Cover LATERAL returns NULL columns when no
// teammate has flipped cover on the shift.
const STAFF_OPEN_SHIFTS_SQL = `
  SELECT s.*,
    sr.id   AS my_request_id,
    sr.status AS my_request_status,
    sr.position AS my_request_position,
    sr.beo_acknowledged_at AS my_beo_acknowledged_at,
    dp.finalized_at AS drink_plan_finalized_at,
    dp.status AS drink_plan_status,
    cov.cover_requested_at,
    cov.cover_for_first_initial
  FROM shifts s
  LEFT JOIN shift_requests sr ON sr.shift_id = s.id AND sr.user_id = $1
  LEFT JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
  LEFT JOIN LATERAL (
    SELECT csr.cover_requested_at,
           UPPER(LEFT(TRIM(COALESCE(cp2.preferred_name, '?')), 1)) AS cover_for_first_initial
      FROM shift_requests csr
      LEFT JOIN contractor_profiles cp2 ON cp2.user_id = csr.user_id
     WHERE csr.shift_id = s.id AND csr.cover_requested_at IS NOT NULL
       AND csr.status = 'approved' AND csr.dropped_at IS NULL
     ORDER BY csr.cover_requested_at ASC LIMIT 1
  ) cov ON true
  WHERE s.status = 'open' AND s.event_date >= CURRENT_DATE
  ORDER BY s.event_date ASC LIMIT 500
`;

// User events history (GET /api/shifts/user/:userId/events). Projects the
// user's payout_id for each past row via a LATERAL JOIN restricted to the
// user's own payout (payouts is keyed on contractor_id).
const USER_EVENTS_SQL = `
  SELECT s.id, s.proposal_id, s.event_date, s.start_time, s.end_time, s.location,
         s.setup_minutes_before,
         s.event_type, s.event_type_custom,
         sr.position, sr.status AS request_status,
         sr.beo_acknowledged_at AS my_beo_acknowledged_at,
         p.event_type AS proposal_event_type,
         p.event_type_custom AS proposal_event_type_custom,
         COALESCE(c.name, s.client_name) AS client_name,
         COALESCE(p.guest_count, s.guest_count) AS guest_count,
         dp.finalized_at AS drink_plan_finalized_at,
         dp.status AS drink_plan_status,
         pay.payout_id
  FROM shift_requests sr
  JOIN shifts s ON s.id = sr.shift_id
  LEFT JOIN proposals p ON p.id = s.proposal_id
  LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
  LEFT JOIN LATERAL (
    SELECT pe.payout_id FROM payout_events pe
      JOIN payouts po ON po.id = pe.payout_id
     WHERE pe.shift_id = s.id AND po.contractor_id = $1 LIMIT 1
  ) pay ON true
  WHERE sr.user_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL
  ORDER BY s.event_date DESC LIMIT 500
`;

module.exports = { STAFF_OPEN_SHIFTS_SQL, USER_EVENTS_SQL };
