/**
 * Admin CC-Import picker endpoints — Section 9.2 §2 and §3.
 *
 * Three GET endpoints powering the Review page's typeaheads + the
 * unmatched-payee link-preview modal:
 *
 *   GET /admin/cc-import/search/proposals?q=&limit=&offset=
 *     Powers the orphan-payment "link to proposal" picker.
 *     Matches on client name (ILIKE) OR proposal cc_id exact.
 *
 *   GET /admin/cc-import/search/users?q=&include_stubs=&limit=&offset=
 *     Powers the unmatched-payee "link to user" picker.
 *     Stubs (cc_id LIKE 'legacy_cc:%') are excluded by default; include_stubs
 *     is admin-only and 403s for managers because the `.local` stub email could
 *     expose contractor-identity-derived data (Section 9.2 §3). Even when an
 *     admin omits include_stubs, the redaction below is defense-in-depth.
 *
 *   GET /admin/cc-import/review/unmatched-payee/:legacy_payout_id/link-preview?user_id=
 *     Pre-flight counts for the link-confirmation modal (Section 9.3.E).
 *     Reads the stub_user_id from legacy_cc_payouts.payee_user_id, then runs
 *     the precheck SELECT against shift_requests. Returns zeros when the stub
 *     has no shift_requests (payouts-only stub).
 */

const express = require('express');
const { pool } = require('../../../db');
const { auth, requireAdminOrManager } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../../utils/errors');

const router = express.Router();

function parseQ(req) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2 || q.length > 100) {
    throw new ValidationError(undefined, 'q must be 2-100 chars');
  }
  return q;
}

function parsePagination(req) {
  return {
    limit: Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25)),
    offset: Math.max(0, parseInt(req.query.offset, 10) || 0),
  };
}

// ── GET /search/proposals ─────────────────────────────────────────
// Orphan-payment picker. Matches on client name (ILIKE) OR proposal cc_id
// equality. Ordered by event_date DESC so recent events surface first when
// the operator is reconciling a fresh payment.
router.get(
  '/search/proposals',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const q = parseQ(req);
    const { limit, offset } = parsePagination(req);
    const like = `%${q}%`;
    const { rows: items } = await pool.query(
      `SELECT p.id, p.cc_id, c.name AS client_name, p.event_date, p.total_price
         FROM proposals p
         JOIN clients c ON c.id = p.client_id
        WHERE c.name ILIKE $1 OR p.cc_id = $2
        ORDER BY p.event_date DESC NULLS LAST, p.id DESC
        LIMIT $3 OFFSET $4`,
      [like, q, limit, offset]
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM proposals p
         JOIN clients c ON c.id = p.client_id
        WHERE c.name ILIKE $1 OR p.cc_id = $2`,
      [like, q]
    );
    res.json({ items, total: countRows[0].total });
  })
);

// ── GET /search/users ─────────────────────────────────────────────
// Unmatched-payee picker. Stubs excluded by default; include_stubs is
// admin-only (managers get 403 — see file header for rationale). When called
// by a non-admin (even without include_stubs), we still redact any stub-email
// that leaks through as defense-in-depth.
router.get(
  '/search/users',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const q = parseQ(req);
    const { limit, offset } = parsePagination(req);
    const includeStubs = req.query.include_stubs === 'true';
    if (includeStubs && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'include_stubs requires admin role' });
    }
    const like = `%${q}%`;
    const stubFilter = includeStubs
      ? ''
      : `AND (u.cc_id IS NULL OR u.cc_id NOT LIKE 'legacy_cc:%')`;
    const { rows: items } = await pool.query(
      `SELECT u.id,
              COALESCE(cp.preferred_name, u.email) AS name,
              u.email, u.cc_id, u.onboarding_status
         FROM users u
         LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
        WHERE (cp.preferred_name ILIKE $1 OR u.email ILIKE $1)
          ${stubFilter}
        ORDER BY u.id ASC
        LIMIT $2 OFFSET $3`,
      [like, limit, offset]
    );
    // Defense-in-depth: redact stub email when caller is not admin. The stub
    // filter above already excludes them when include_stubs=false; this also
    // covers the rare case where a non-admin somehow received a stub row.
    if (req.user.role !== 'admin') {
      for (const r of items) {
        if (/^legacy_cc:/.test(String(r.cc_id || ''))) r.email = '(redacted)';
      }
    }
    res.json({ items });
  })
);

// ── GET /review/unmatched-payee/:legacy_payout_id/link-preview ────
// Pre-flight counts for the link-confirmation modal (Section 9.3.E). The
// modal pluralization rules (1 vs many, drop-the-clause-when-0) are applied
// client-side from these raw counts.
//
// If the legacy_cc_payouts row has no stub user (payee_user_id IS NULL),
// returns all-zero counts so the modal can still show the "this stub had
// no event participation" copy.
router.get(
  '/review/unmatched-payee/:legacy_payout_id/link-preview',
  auth,
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const legacyPayoutId = parseInt(req.params.legacy_payout_id, 10);
    const userId = parseInt(req.query.user_id, 10);
    if (!Number.isInteger(legacyPayoutId) || !Number.isInteger(userId)) {
      throw new ValidationError(undefined, 'legacy_payout_id and user_id must be integers');
    }
    const lookupStub = await pool.query(
      `SELECT payee_user_id FROM legacy_cc_payouts WHERE id = $1`,
      [legacyPayoutId]
    );
    if (lookupStub.rowCount === 0) {
      throw new NotFoundError('legacy_cc_payouts row not found');
    }
    const stubUserId = lookupStub.rows[0].payee_user_id;
    if (stubUserId === null || stubUserId === undefined) {
      return res.json({
        shifts_reassigned: 0,
        shifts_merged: 0,
        shifts_real_user_status_cleared: 0,
        proposals: 0,
      });
    }
    const { rows: [counts] } = await pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE NOT EXISTS (
             SELECT 1 FROM shift_requests sr2
              WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $1
           )
         ) AS shifts_reassigned,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM shift_requests sr2
              WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $1 AND sr2.status = 'approved'
           )
         ) AS shifts_merged,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM shift_requests sr2
              WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $1 AND sr2.status IN ('pending','denied')
           )
         ) AS shifts_real_user_status_cleared,
         COUNT(DISTINCT s.proposal_id) AS proposals
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       WHERE sr.user_id = $2`,
      [userId, stubUserId]
    );
    res.json({
      shifts_reassigned: Number(counts.shifts_reassigned),
      shifts_merged: Number(counts.shifts_merged),
      shifts_real_user_status_cleared: Number(counts.shifts_real_user_status_cleared),
      proposals: Number(counts.proposals),
    });
  })
);

module.exports = router;
