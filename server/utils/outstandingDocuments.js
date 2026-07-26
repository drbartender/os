const { pool } = require('../db');

// Two questions that sound like one.
//
// "What do I still owe?" is informational, asked by a recruit about themselves.
// Both documents, everyone mid-onboarding. Nobody is harmed by an over-broad
// to-do list on their own page.
//
// "Who can work a shift with no certification?" is a compliance alert, asked by
// the admin about everyone. Certification only, and only people who can
// actually be assigned. Sized against production, the naive version (both
// documents, all onboarding statuses) returns 50 rows into a 6-row strip, of
// which 50 lack a resume and 2 are genuine risk.
//
// LEFT JOINs throughout, deliberately. The sibling queries in admin/hiring.js
// INNER JOIN applications, which is right for funnel stats but would hide
// exactly the people this exists for: direct hires who never completed the
// application. A missing row means missing documents, not an absent person.

// Anyone still moving through onboarding, including 'applied' and 'interviewing'.
// Those two cannot currently reach a fileless state (the submit gate still
// applies to them), and RequireHired would not render the notice for them
// anyway. They are included so this stays the honest answer to "what does this
// person owe" for any caller, rather than a list shaped around today's single
// consumer.
const ONBOARDING_STATUSES = [
  'applied', 'interviewing', 'in_progress', 'hired', 'submitted', 'reviewed', 'approved',
];

// Mirrors the assignment gate in server/routes/shifts.approval.js:233. Keep in
// sync: this list IS the definition of "can be put in front of a client".
const STAFFABLE_STATUSES = ['submitted', 'reviewed', 'approved'];

const DOC_JOINS = `
  LEFT JOIN applications a ON a.user_id = u.id
  LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
`;

// Either storage location satisfies the requirement.
const RESUME_MISSING = 'COALESCE(cp.resume_file_url, a.resume_file_url) IS NULL';
const CERT_MISSING = 'COALESCE(cp.alcohol_certification_file_url, a.basset_file_url) IS NULL';

const DISPLAY_NAME = 'COALESCE(cp.preferred_name, a.full_name, u.email)';

// One row in, labels out. Shared so the per-user answer and the admin list
// cannot phrase or compute the same fact differently.
function labelsFor(row) {
  const owed = [];
  if (row.needs_resume) owed.push('resume');
  if (row.needs_cert) owed.push('alcohol certification');
  return owed;
}

async function outstandingFor(userId) {
  const result = await pool.query(`
    SELECT ${RESUME_MISSING} AS needs_resume,
           ${CERT_MISSING}   AS needs_cert
    FROM users u ${DOC_JOINS}
    WHERE u.id = $1
      AND u.role IN ('staff', 'manager')
      AND u.onboarding_status = ANY($2)
  `, [userId, ONBOARDING_STATUSES]);

  const row = result.rows[0];
  if (!row) return [];   // Not onboarding: owes nothing by definition.
  return labelsFor(row);
}

// Certification only, staffable only, soonest upcoming shift first.
//
// The lateral join is what separates "eligible but idle" from "about to pour
// drinks uncertified". Both belong in the list; only the second is urgent.
async function listUncertifiedStaffable() {
  const result = await pool.query(`
    SELECT u.id AS user_id,
           ${DISPLAY_NAME} AS name,
           ns.shift_id     AS next_shift_id,
           ns.event_date   AS next_shift_date
    FROM users u ${DOC_JOINS}
    LEFT JOIN LATERAL (
      SELECT s.id AS shift_id, s.event_date
      FROM shift_requests r
      JOIN shifts s ON s.id = r.shift_id
      WHERE r.user_id = u.id
        AND r.status = 'approved'
        AND r.dropped_at IS NULL
        AND s.event_date >= CURRENT_DATE
      ORDER BY s.event_date
      LIMIT 1
    ) ns ON true
    WHERE u.role IN ('staff', 'manager')
      AND u.onboarding_status = ANY($1)
      AND ${CERT_MISSING}
    ORDER BY ns.event_date ASC NULLS LAST, u.id DESC
  `, [STAFFABLE_STATUSES]);

  return result.rows;
}

module.exports = {
  outstandingFor, listUncertifiedStaffable,
  ONBOARDING_STATUSES, STAFFABLE_STATUSES,
};
