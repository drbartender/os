// Global record search. Powers GET /api/admin/search and the Cmd/Ctrl+K
// command palette: one query string matched against clients, proposals,
// events, and staff by partial name, email, or phone number. Proposal and
// event rows also carry the fields the phone search draws (phoneFields).

const { pool } = require('../db');
const { getEventTypeLabel } = require('./eventTypes');
const { readExclusion } = require('./reads/exclusion');

const GROUP_LIMIT = 6;

const STAFF_STATUS_LABELS = new Map([
  ['in_progress', 'Applicant (incomplete)'],
  ['applied', 'Applicant (applied)'],
  ['interviewing', 'Applicant (interviewing)'],
  ['hired', 'Onboarding'],
  ['submitted', 'Active bartender'],
  ['reviewed', 'Active bartender'],
  ['approved', 'Active bartender'],
  ['rejected', 'Rejected applicant'],
  ['deactivated', 'Deactivated'],
]);

// Escape LIKE metacharacters (and the escape char itself) so a typed `%` or
// `_` matches literally instead of expanding into a wildcard scan.
function escapeLikePattern(term) {
  return String(term).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// Strip everything but digits. Normalizes a typed phone fragment so it can be
// compared against an equally-normalized stored column.
function extractDigits(raw) {
  return String(raw === null || raw === undefined ? '' : raw).replace(/\D/g, '');
}

// Render a stored phone as (XXX) XXX-XXXX. Anything that is not a clean
// 10-digit number is returned unchanged so partial values still display.
function formatPhoneDisplay(raw) {
  const d = extractDigits(raw);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return raw === null || raw === undefined ? '' : String(raw);
}

// Map a user's onboarding_status to a short human label for the staff result.
function humanizeStaffStatus(status) {
  return STAFF_STATUS_LABELS.get(status) || 'Staff';
}

// Compose the sub-label for a proposal or event row: event type, then the
// formatted event date when one is set.
function eventDetail(row) {
  const label = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  return [label, row.event_date_label].filter(Boolean).join(' · ');
}

// The phone search (lane ma-f3) draws a proposal's status chip and an event's
// date rail and kind line, so those rows also carry the raw status, the date
// as YYYY-MM-DD (null when unset) and the kind label. The palette reads only
// type, id, name and detail; nothing it reads changes.
function phoneFields(row) {
  return {
    status: row.status,
    event_date: row.event_ymd || null,
    kind: getEventTypeLabel({
      event_type: row.event_type,
      event_type_custom: row.event_type_custom,
    }),
  };
}

// The four group queries. $1 the LIKE term, $2 the phone digits term (or
// NULL), $3 the group limit. The *_EXCLUDING variants add the legal-hold
// exclusion (spec 2026-11-19 law 1) as int[] parameters in the WHERE that
// picks the rows, BEFORE the LIMIT, so a group still fills to GROUP_LIMIT when
// a held row would have been among the newest: clients take $4 the held client
// ids; proposals and events take $4 the held proposal ids and $5 the held
// client ids (a held client's every booking). The staff group has no held
// rows. The plain texts are the ones the admin search always ran.
const CLIENT_MATCH = `LOWER(c.name) LIKE $1 ESCAPE '\\'
       OR LOWER(c.email) LIKE $1 ESCAPE '\\'
       OR ($2::text IS NOT NULL AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE $2)`;

const CLIENTS_SQL = `
    SELECT c.id, c.name, c.email, c.phone, c.cc_id
    FROM clients c
    WHERE ${CLIENT_MATCH}
    ORDER BY c.created_at DESC
    LIMIT $3
  `;
const CLIENTS_EXCLUDING_SQL = `
    SELECT c.id, c.name, c.email, c.phone, c.cc_id
    FROM clients c
    WHERE (${CLIENT_MATCH})
      AND NOT (c.id = ANY($4::int[]))
    ORDER BY c.created_at DESC
    LIMIT $3
  `;

// One proposal-side query for the two booking groups: `statusWhere` picks
// proposals (not yet booked, not archived) or events (booked).
const bookingSql = (statusWhere, excluding) => `
    SELECT p.id, c.name AS client_name, p.event_type, p.event_type_custom,
           p.status, to_char(p.event_date, 'YYYY-MM-DD') AS event_ymd,
           to_char(p.event_date, 'FMMon FMDD, YYYY') AS event_date_label,
           p.cc_id AS proposal_cc_id, c.cc_id AS client_cc_id
    FROM proposals p
    JOIN clients c ON c.id = p.client_id
    WHERE ${statusWhere}
      AND (
        LOWER(c.name) LIKE $1 ESCAPE '\\'
        OR LOWER(c.email) LIKE $1 ESCAPE '\\'
        OR ($2::text IS NOT NULL AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE $2)
      )${excluding ? `
      AND NOT (p.id = ANY($4::int[]))
      AND NOT (p.client_id = ANY($5::int[]))` : ''}
    ORDER BY p.created_at DESC
    LIMIT $3
  `;
const NOT_BOOKED = "p.status NOT IN ('deposit_paid','balance_paid','confirmed','completed','archived')";
const BOOKED = "p.status IN ('deposit_paid','balance_paid','confirmed','completed')";
const PROPOSALS_SQL = bookingSql(NOT_BOOKED, false);
const PROPOSALS_EXCLUDING_SQL = bookingSql(NOT_BOOKED, true);
const EVENTS_SQL = bookingSql(BOOKED, false);
const EVENTS_EXCLUDING_SQL = bookingSql(BOOKED, true);

const STAFF_SQL = `
    SELECT u.id,
           COALESCE(cp.display_name, cp.preferred_name, a.full_name, u.email) AS name,
           u.onboarding_status, u.cc_id
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    LEFT JOIN applications a ON a.user_id = u.id
    WHERE u.role IN ('staff','manager')
      AND (
        LOWER(u.email) LIKE $1 ESCAPE '\\'
        OR LOWER(cp.display_name) LIKE $1 ESCAPE '\\'
        OR LOWER(cp.preferred_name) LIKE $1 ESCAPE '\\'
        OR LOWER(cp.email) LIKE $1 ESCAPE '\\'
        OR LOWER(a.full_name) LIKE $1 ESCAPE '\\'
        OR ($2::text IS NOT NULL AND regexp_replace(cp.phone, '[^0-9]', '', 'g') LIKE $2)
        OR ($2::text IS NOT NULL AND regexp_replace(a.phone, '[^0-9]', '', 'g') LIKE $2)
      )
    ORDER BY u.created_at DESC
    LIMIT $3
  `;

// Run the global search. `rawQuery` is the user's typed string. Returns four
// capped, most-recent-first result groups. A query shorter than 2 characters
// or longer than 100 short-circuits to empty groups without touching the
// database; the upper bound caps the cost of the unindexed LIKE scans.
//
// `exclude` (optional, legalHold.holdExclusion(): { proposalIds, clientIds })
// leaves out the held proposals, the held clients and their every booking, in
// SQL (above). The admin search (GET /api/admin/search, the command palette)
// passes none and runs the plain texts. A malformed exclusion throws
// (reads/exclusion.js) rather than excluding nothing.
async function runGlobalSearch(rawQuery, { exclude } = {}) {
  const hold = readExclusion(exclude);
  const q = String(rawQuery === null || rawQuery === undefined ? '' : rawQuery).trim();
  const empty = { clients: [], proposals: [], events: [], staff: [] };
  if (q.length < 2 || q.length > 100) return empty;

  const likeTerm = '%' + escapeLikePattern(q.toLowerCase()) + '%';
  const digits = extractDigits(q);
  // Only match phone columns once at least 3 digits are typed, otherwise a
  // one- or two-digit fragment matches nearly every stored number.
  const phoneTerm = digits.length >= 3 ? '%' + digits + '%' : null;
  const params = [likeTerm, phoneTerm, GROUP_LIMIT];

  const [clients, proposals, events, staff] = await Promise.all(hold ? [
    pool.query(CLIENTS_EXCLUDING_SQL, [...params, hold.clientIds]),
    pool.query(PROPOSALS_EXCLUDING_SQL, [...params, hold.proposalIds, hold.clientIds]),
    pool.query(EVENTS_EXCLUDING_SQL, [...params, hold.proposalIds, hold.clientIds]),
    pool.query(STAFF_SQL, params),
  ] : [
    pool.query(CLIENTS_SQL, params),
    pool.query(PROPOSALS_SQL, params),
    pool.query(EVENTS_SQL, params),
    pool.query(STAFF_SQL, params),
  ]);

  return {
    clients: clients.rows.map((r) => ({
      type: 'client',
      id: r.id,
      name: r.name,
      detail: r.email || formatPhoneDisplay(r.phone),
      cc_id: r.cc_id,
    })),
    proposals: proposals.rows.map((r) => ({
      type: 'proposal',
      id: r.id,
      name: r.client_name,
      detail: eventDetail(r),
      proposal_cc_id: r.proposal_cc_id,
      client_cc_id: r.client_cc_id,
      ...phoneFields(r),
    })),
    events: events.rows.map((r) => ({
      type: 'event',
      id: r.id,
      name: r.client_name,
      detail: eventDetail(r),
      proposal_cc_id: r.proposal_cc_id,
      client_cc_id: r.client_cc_id,
      ...phoneFields(r),
    })),
    staff: staff.rows.map((r) => ({
      type: 'staff',
      id: r.id,
      name: r.name,
      detail: humanizeStaffStatus(r.onboarding_status),
      cc_id: r.cc_id,
    })),
  };
}

module.exports = {
  escapeLikePattern,
  extractDigits,
  formatPhoneDisplay,
  humanizeStaffStatus,
  runGlobalSearch,
};
