const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
// dateClause is imported (not re-declared) so this endpoint shares ONE half-open
// [from, to+1) date fragment with the metrics builders and the list drill-outs.
// A WHERE mismatch here would silently break funnel reconciliation.
const { dateClause } = require('../../utils/metricsQueries');
const { ValidationError } = require('../../utils/errors');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CAP = 12;

// Real-date guard: structural shape AND a round-trip check, so a well-shaped but
// nonexistent value ('2099-13-99') is treated as no filter rather than reaching a
// ::date cast (a bad cast 500s — the UUID-token failure class). Stricter than the
// list route's structural-only DATE_RE on purpose; both from AND to are guarded.
function realDate(s) {
  if (!DATE_RE.test(s || '')) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s) ? s : null;
}

// Whitelisted, FIXED segment key expressions. `by` selects one by object key;
// any other value throws a ValidationError (400) — user input never reaches SQL
// as text. The only free value is from/to, and those flow in solely as
// parameterized dateClause bind values.
//   event_type: TRIM → collapse whitespace runs to '-' → lowercase; NULL/empty
//               fold to the sentinel `__untyped`. This merges the twin
//               vocabularies (native slug `wedding-reception` + Thumbtack human
//               string "Wedding Reception") into one segment (spec §4).
//   source:     NULL folds to 'direct' (mirrors the list's manual = NULL mapping).
const KEY_EXPRS = {
  event_type: "COALESCE(NULLIF(LOWER(REGEXP_REPLACE(TRIM(p.event_type), '\\s+', '-', 'g')), ''), '__untyped')",
  source: "COALESCE(p.source, 'direct')",
};

/**
 * GET /api/proposals/metrics-split?by=source|event_type&from&to
 *
 * Sibling to the LAW dashboard-stats funnel: the same sent/accepted math, split
 * by a segment key. Native-era only (no basis / include_cc) — the frozen CC
 * ledger keeps no type or source detail, so this file never touches the cc
 * tables. Two GROUP BY queries merged by key server-side:
 *   sent cohort  → mirrors qSent's native leg (sent_at IS NOT NULL, date on
 *                  sent_at) + qWinRate's per-segment cohort (status <> archived).
 *   won axis     → mirrors qAccepted's native leg (accepted_at IS NOT NULL, date
 *                  on accepted_at, NO status filter — an accepted-then-archived
 *                  row still wins).
 * Values are proposal DOLLARS. Response sends keys only; labels resolve client-side.
 */
router.get('/metrics-split', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { by, from, to } = req.query;
  const keyExpr = KEY_EXPRS[by];
  if (!keyExpr) {
    const msg = 'by must be source or event_type';
    throw new ValidationError({ by: msg }, msg);
  }
  // Malformed dates are ignored (treated as no range), never cast.
  const validFrom = realDate(from);
  const validTo = realDate(to);

  // (1) Sent-cohort axis. sent_count/sent_value feed the segment's Quoted line;
  // accepted_from_cohort + pending are the qWinRate cohort math (status-archived
  // excluded on BOTH so close rate and pending mirror the board per segment).
  const sentParams = [];
  const sentDate = dateClause('p.sent_at', validFrom, validTo, sentParams);
  const sentSql = `
    SELECT ${keyExpr} AS key,
           COUNT(*)::int AS sent_count,
           COALESCE(SUM(p.total_price),0)::float8 AS sent_value,
           COUNT(*) FILTER (WHERE p.accepted_at IS NOT NULL AND p.status <> 'archived')::int AS accepted_from_cohort,
           COUNT(*) FILTER (WHERE p.accepted_at IS NULL AND p.status <> 'archived')::int AS pending
    FROM proposals p
    WHERE p.sent_at IS NOT NULL${sentDate}
    GROUP BY ${keyExpr}`;

  // (2) Won axis. NO status filter — an accepted-then-archived row still counts,
  // exactly like qAccepted (whose count AND value both survive a later archive).
  const wonParams = [];
  const wonDate = dateClause('p.accepted_at', validFrom, validTo, wonParams);
  const wonSql = `
    SELECT ${keyExpr} AS key,
           COUNT(*)::int AS won_count,
           COALESCE(SUM(p.total_price),0)::float8 AS won_value
    FROM proposals p
    WHERE p.accepted_at IS NOT NULL${wonDate}
    GROUP BY ${keyExpr}`;

  const [sentR, wonR] = await Promise.all([
    pool.query(sentSql, sentParams),
    pool.query(wonSql, wonParams),
  ]);

  // Merge both axes by key. A key can appear in either query alone (e.g. a row
  // accepted-in-range but sent-before-range shows only in the won axis).
  const merged = new Map();
  const bucket = (key) => {
    let s = merged.get(key);
    if (!s) {
      s = { key, sentCount: 0, sentValue: 0, acceptedFromCohort: 0, pending: 0, wonCount: 0, wonValue: 0 };
      merged.set(key, s);
    }
    return s;
  };
  for (const r of sentR.rows) {
    const s = bucket(r.key);
    s.sentCount = r.sent_count;
    s.sentValue = r.sent_value;
    s.acceptedFromCohort = r.accepted_from_cohort;
    s.pending = r.pending;
  }
  for (const r of wonR.rows) {
    const s = bucket(r.key);
    s.wonCount = r.won_count;
    s.wonValue = r.won_value;
  }

  const closeRate = (accepted, cohort) => (cohort > 0 ? Math.round((accepted / cohort) * 100) : null);
  const toSegment = (s) => ({
    key: s.key,
    sent: { count: s.sentCount, value: s.sentValue },
    won: { count: s.wonCount, value: s.wonValue },
    closeRatePct: closeRate(s.acceptedFromCohort, s.sentCount),
    pending: s.pending,
  });

  // Order by sent count desc; cap at 12; roll the remainder into ONE __other row
  // (summed numeric fields, close rate recomputed from the rolled-up cohort).
  const ranked = [...merged.values()].sort((a, b) => b.sentCount - a.sentCount);
  const kept = ranked.slice(0, CAP);
  const rest = ranked.slice(CAP);
  const segments = kept.map(toSegment);
  let truncated = null;
  if (rest.length) {
    const agg = rest.reduce((a, s) => {
      a.sentCount += s.sentCount;
      a.sentValue += s.sentValue;
      a.acceptedFromCohort += s.acceptedFromCohort;
      a.pending += s.pending;
      a.wonCount += s.wonCount;
      a.wonValue += s.wonValue;
      return a;
    }, { key: '__other', sentCount: 0, sentValue: 0, acceptedFromCohort: 0, pending: 0, wonCount: 0, wonValue: 0 });
    segments.push(toSegment(agg));
    truncated = { segments: rest.length, sent: agg.sentCount };
  }

  res.json({
    by,
    filters: { from: validFrom, to: validTo },
    segments,
    truncated,
  });
}));

module.exports = router;
