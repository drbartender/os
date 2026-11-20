// GET /api/proposals, the admin proposals list: the shared list read, answered as a bare array or the phone envelope.

const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
// The query itself (every filter, the open-balance predicate, the sort and the
// counts) is the shared read in server/utils/reads/proposalList.js, which the
// Claude connector's money-owed tool also calls. This route passes no option
// to it, so its rows and counts are the ones this list always answered.
const { listProposals } = require('../../utils/reads/proposalList');

const router = express.Router();

// The columns the phone's stored list must not hold (the envelope rows below).
const AT_REST_OMIT = ['token', 'client_email', 'client_phone'];
function withoutAtRestFields(row) {
  const out = { ...row };
  for (const key of AT_REST_OMIT) delete out[key];
  return out;
}

/** GET /api/proposals — list all proposals. Explicit column list — do NOT ship
 *  pricing_snapshot / admin_notes / questionnaire_data / signature_data / stripe_*
 *  to list responses (blobs, PII, can each be 10-50 KB × 50 rows = 2.5 MB). */
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const list = await listProposals(req.query);
  // Non-breaking pagination signal: total in a header, body stays a bare array
  // so existing consumers are unaffected. CORS sets no global
  // Access-Control-Expose-Headers, so expose this header per-route.
  res.set('X-Total-Count', String(list.total));
  res.set('Access-Control-Expose-Headers', 'X-Total-Count');
  if (req.query.envelope !== '1') return res.json(list.rows);
  // ?envelope=1 (the phone list, lane ma-f1) answers an object: the service
  // worker's stored copy is read by body, so the phone's totals travel in the
  // body, never in the header. Nothing that does not send it sees a change.
  // The worker keeps that body on the phone, so its rows leave out the public
  // token and the client's contact (spec 2026-08-13-mobile-admin section 3,
  // Plan decisions of 2026-11-05, At rest); nothing the phone list draws reads
  // them, and the bare array above keeps every column for the desktop.
  res.json({
    rows: list.rows.map(withoutAtRestFields),
    total: list.total,
    bucket_total: list.bucketTotal,
    unviewed_total: list.unviewedTotal,
    page: list.page,
    limit: list.limit,
    has_more: list.page * list.limit < list.total,
  });
}));

module.exports = router;
