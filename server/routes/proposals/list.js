const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
// dateClause + NOT_DEAD are imported (not re-declared) so the list drill-outs
// and the metrics endpoints share ONE date/predicate definition and cannot
// drift: a WHERE mismatch here is silent and would break funnel reconciliation.
const { dateClause, NOT_DEAD } = require('../../utils/metricsQueries');

const router = express.Router();

// User input never reaches SQL as text — axis/cohort/status map to fixed
// server-side fragments; event_type is the only free value and it is a
// parameterized WHERE value.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AXIS_COL = { event: 'p.event_date', sent: 'p.sent_at' };
const VALID_STATUSES = ['draft', 'sent', 'viewed', 'modified', 'accepted',
  'deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived'];
// Predicates mirror metricsQueries EXACTLY (reconciliation contract, spec §5/§6):
// quoted → qSent, won → qAccepted, lost → qLostValue. Each cohort implies its own
// date column (quoted/lost on sent_at, won on accepted_at), matching the metric.
const COHORTS = {
  quoted: { dateCol: 'p.sent_at',     where: 'p.sent_at IS NOT NULL' },
  won:    { dateCol: 'p.accepted_at', where: 'p.accepted_at IS NOT NULL' },
  lost:   { dateCol: 'p.sent_at',     where: "p.sent_at IS NOT NULL AND p.status = 'archived'" },
};

/** GET /api/proposals — list all proposals. Explicit column list — do NOT ship
 *  pricing_snapshot / admin_notes / questionnaire_data / signature_data / stripe_*
 *  to list responses (blobs, PII, can each be 10-50 KB × 50 rows = 2.5 MB). */
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { status, view = 'active', search, source, page = 1, limit = 50,
    axis, event_type: eventType, balance, cohort, from, to } = req.query;
  // Bound pagination: a non-numeric limit (?limit=abc) otherwise casts to NaN and
  // 22P02-500s; ?page=0 yields a negative OFFSET. Clamp to [1, 200], default 50;
  // page floors at 1 (matches clients.js).
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const pg = Math.max(1, parseInt(page, 10) || 1);
  // Shared FROM + WHERE built once so the data SELECT and the COUNT(*) cover the
  // exact same filtered set. whereParams holds ONLY the filter params (status /
  // search / date / event_type); pagination (LIMIT/OFFSET) is appended to the
  // data query alone.
  const fromWhere = `
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    WHERE 1=1`;
  const whereParams = [];
  let whereClause = '';

  const cohortDef = COHORTS[cohort]; // valid cohort or undefined (invalid ignored)

  if (cohortDef) {
    // (1) A valid cohort supersedes the status/view bucket ENTIRELY. The drill-out
    // must reconcile with the funnel metric it came from, so it carries only the
    // mirrored predicate + its own date axis; status/view/axis are ignored.
    whereClause += ` AND ${cohortDef.where}`;
  } else {
    // (2) Existing status/view logic. `status` is a CSV of whitelisted values;
    // when ≥1 recognized value is present it OVERRIDES the view bucket (a strict
    // generalization of the pre-existing single-value `p.status = $n` override,
    // now `p.status = ANY($n)`). Unrecognized values are dropped silently so a
    // stale drill-out link degrades, never errors; if nothing valid remains the
    // view bucket applies as though no status was sent.
    const validStatuses = typeof status === 'string' && status.length
      ? status.split(',').map((s) => s.trim()).filter((s) => VALID_STATUSES.includes(s))
      : [];
    if (validStatuses.length) {
      whereParams.push(validStatuses);
      whereClause += ` AND p.status = ANY($${whereParams.length})`;
    } else if (view === 'paid') {
      whereClause += ` AND p.status IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed')`;
    } else if (view === 'archive') {
      whereClause += ` AND p.status = 'archived'`;
    } else if (view === 'all') {
      whereClause += ` AND p.status != 'archived'`;
    } else {
      // Default 'active' bucket — exclude paid (moved to Events) and archived.
      whereClause += ` AND p.status NOT IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived')`;
    }
  }
  if (search) {
    whereParams.push(`%${search}%`);
    whereClause += ` AND (c.name ILIKE $${whereParams.length} OR c.email ILIKE $${whereParams.length})`;
  }

  // Origin filter. Fixed literals only (no user value into SQL) — safe.
  if (source === 'thumbtack') {
    whereClause += " AND p.source = 'thumbtack'";
  } else if (source === 'manual') {
    whereClause += ' AND p.source IS NULL';
  }

  // (3) Date range on the cohort's own column, else the human-facing axis (event
  // date by default). dateClause is the SHARED half-open [from, to+1) fragment
  // from metricsQueries: NEVER hand-roll `col <= $n` — sent_at/accepted_at are
  // timestamptz and an inclusive `<=` casts the bound to midnight and silently
  // drops same-day-evening rows. from/to must be YYYY-MM-DD; a malformed value is
  // ignored, never cast to date (a bad cast 500s — the UUID-token failure class).
  const validFrom = DATE_RE.test(from || '') ? from : null;
  const validTo = DATE_RE.test(to || '') ? to : null;
  const dateCol = cohortDef ? cohortDef.dateCol : (AXIS_COL[axis] || 'p.event_date');
  whereClause += dateClause(dateCol, validFrom, validTo, whereParams);

  // axis=sent excludes never-sent rows by definition (only meaningful without a
  // cohort — a cohort already pins its own axis).
  if (!cohortDef && axis === 'sent') {
    whereClause += ' AND p.sent_at IS NOT NULL';
  }

  // (4) Event type — normalized on BOTH sides so a split-by drill-out lands on
  // ALL of a segment's rows across the twin vocabularies (native slug
  // `wedding-reception` + Thumbtack human string "Wedding Reception"). The value
  // is parameterized; the normalization is a FIXED SQL fragment (spec §7). An
  // exact-slug caller still matches (a slug normalizes to itself), so this is
  // backward compatible. The sentinel `__untyped` maps to NULL/empty event_type
  // (mirrors the metrics-split KEY_EXPR).
  if (eventType === '__untyped') {
    whereClause += ` AND (p.event_type IS NULL OR TRIM(p.event_type) = '')`;
  } else if (eventType) {
    whereParams.push(eventType);
    whereClause += ` AND LOWER(REGEXP_REPLACE(TRIM(p.event_type), '\\s+', '-', 'g'))`
      + ` = LOWER(REGEXP_REPLACE(TRIM($${whereParams.length}), '\\s+', '-', 'g'))`;
  }

  // (5) Open balance — accepted-side rows still owing. NOT_DEAD is the shared
  // unprefixed literal ("status <> 'archived'"); this query aliases proposals as
  // p, so prefix at the call site.
  if (balance === 'open') {
    whereClause += ` AND p.accepted_at IS NOT NULL AND p.${NOT_DEAD} AND (p.total_price - COALESCE(p.amount_paid,0)) > 0`;
  }

  let query = `
    SELECT p.id, p.token, p.client_id, p.event_type, p.event_type_custom,
           p.event_type_category, p.event_date, p.event_start_time,
           p.event_duration_hours, p.event_location, p.guest_count, p.num_bars,
           p.num_bartenders, p.package_id, p.group_id, p.status, p.source, p.total_price, p.amount_paid,
           p.deposit_amount, p.balance_due_date, p.payment_type, p.autopay_enrolled,
           p.sent_at, p.accepted_at, p.client_signed_at, p.last_viewed_at, p.view_count,
           p.created_at, p.updated_at, p.cc_id AS proposal_cc_id,
           c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
           c.cc_id AS client_cc_id,
           sp.name AS package_name, sp.slug AS package_slug
    ${fromWhere}${whereClause}
    ORDER BY p.created_at DESC`;
  const params = [...whereParams];
  params.push(lim);
  query += ` LIMIT $${params.length}`;
  params.push((pg - 1) * lim);
  query += ` OFFSET $${params.length}`;

  // Data + total run in parallel; COUNT(*) reuses the identical FROM/WHERE and
  // whereParams (no LIMIT/OFFSET) so the count matches the full filtered set.
  const [result, countResult] = await Promise.all([
    pool.query(query, params),
    pool.query(`SELECT COUNT(*) ${fromWhere}${whereClause}`, whereParams),
  ]);
  const total = Number(countResult.rows[0]?.count) || 0;
  // Non-breaking pagination signal: total in a header, body stays a bare array
  // so existing consumers are unaffected. CORS sets no global
  // Access-Control-Expose-Headers, so expose this header per-route.
  res.set('X-Total-Count', String(total));
  res.set('Access-Control-Expose-Headers', 'X-Total-Count');
  res.json(result.rows);
}));

module.exports = router;
