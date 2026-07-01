/**
 * Pure metrics query builders + filter parsing. No DB, no side effects —
 * the single source of truth for Dashboard/Financials filtering so the two
 * endpoints cannot drift. Mirrors the pricingEngine.js / bookingWindow.js style.
 *
 * Date handling: half-open ranges [from, to+1day) with ::date casts, matching
 * the existing precedent in metadata.js (no explicit TZ constant — Postgres
 * default, consistent with the rest of the date code in this codebase).
 */
const { ValidationError } = require('./errors');

const BASES = ['booked', 'scheduled', 'paid'];
const INCLUDE_CC_VALUES = ['all', 'exclude', 'only'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s) {
  if (!ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * @param {{from?:string,to?:string,basis?:string,include_cc?:string}} q
 * @returns {{from:string|null,to:string|null,basis:string,includeCc:'all'|'exclude'|'only'}}
 */
function resolveFilters(q = {}) {
  const basis = q.basis === null || q.basis === undefined || q.basis === '' ? 'booked' : String(q.basis);
  if (!BASES.includes(basis)) {
    const msg = `basis must be one of ${BASES.join(', ')}`;
    throw new ValidationError({ basis: msg }, msg);
  }
  const includeCc = q.include_cc === null || q.include_cc === undefined || q.include_cc === ''
    ? 'all'
    : String(q.include_cc);
  if (!INCLUDE_CC_VALUES.includes(includeCc)) {
    const msg = `include_cc must be one of ${INCLUDE_CC_VALUES.join(', ')}`;
    throw new ValidationError({ include_cc: msg }, msg);
  }
  const hasFrom = q.from !== null && q.from !== undefined && q.from !== '';
  const hasTo = q.to !== null && q.to !== undefined && q.to !== '';
  if (!hasFrom && !hasTo) return { from: null, to: null, basis, includeCc };
  if (hasFrom !== hasTo) {
    const msg = 'both from and to are required for a custom range';
    throw new ValidationError({ from: msg }, msg);
  }
  if (!isRealDate(q.from)) {
    const msg = 'from must be a valid YYYY-MM-DD date';
    throw new ValidationError({ from: msg }, msg);
  }
  if (!isRealDate(q.to)) {
    const msg = 'to must be a valid YYYY-MM-DD date';
    throw new ValidationError({ to: msg }, msg);
  }
  if (q.from > q.to) {
    const msg = 'from must be on or before to';
    throw new ValidationError({ from: msg }, msg);
  }
  return { from: q.from, to: q.to, basis, includeCc };
}

/**
 * Immediately-preceding equal-length window. null when either bound is null.
 * @returns {{from:string,to:string}|null}
 */
function priorPeriod(from, to) {
  if (!from || !to) return null;
  const DAY = 86400000;
  const f = Date.parse(from + 'T00:00:00Z');
  const t = Date.parse(to + 'T00:00:00Z');
  const lenDays = Math.round((t - f) / DAY) + 1; // inclusive
  const priorTo = new Date(f - DAY);
  const priorFrom = new Date(priorTo.getTime() - (lenDays - 1) * DAY);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(priorFrom), to: iso(priorTo) };
}

/**
 * Parameterized half-open date fragment. Pushes onto `params`, returns SQL
 * (leading space). Empty string + untouched params when range is null.
 * `column` is a trusted internal identifier — never user input.
 */
function dateClause(column, from, to, params) {
  if (!from || !to) return '';
  params.push(from);
  const a = params.length;
  params.push(to);
  const b = params.length;
  return ` AND ${column} >= $${a}::date AND ${column} < ($${b}::date + 1)`;
}

/** Number coercion; divides by 100 when the source column is integer cents. */
function toDollars(value, { fromCents = false } = {}) {
  const n = Number(value || 0);
  return fromCents ? n / 100 : n;
}

/**
 * cc_id tri-state filter fragment. `prefix` is a trusted internal alias prefix
 * (e.g. `'p.'` or `''`) — caller chooses based on whether the query already
 * aliased the proposals table. Empty string for the default `'all'` mode so the
 * builder paths stay byte-identical to the pre-filter SQL when no filter is set.
 */
function ccClause(prefix, includeCc) {
  if (includeCc === 'only') return ` AND ${prefix}cc_id IS NOT NULL`;
  if (includeCc === 'exclude') return ` AND ${prefix}cc_id IS NULL`;
  return '';
}

// ── SQL builders. Each returns { sql, params }. `f` = { from, to, basis }. ──

const NOT_DEAD = "status <> 'archived'";

/**
 * Scalar subquery string: succeeded refunds in [from,to) keyed on the refund's
 * own created_at (cash basis). ccMode 'all' stays join-less; 'only'/'exclude'
 * joins proposals for the cc filter. Pushes its own date params onto `params`,
 * so call it AFTER the payment-side dateClause so the $n positions line up.
 */
function refundsInWindow(from, to, params, ccMode) {
  const rc = dateClause('pr.created_at', from, to, params);
  if (ccMode === 'all') {
    return `(SELECT COALESCE(SUM(pr.amount),0) FROM proposal_refunds pr
             WHERE pr.status='succeeded'${rc})`;
  }
  const cc = ccMode === 'only' ? ' AND p2.cc_id IS NOT NULL'
    : ccMode === 'exclude' ? ' AND p2.cc_id IS NULL' : '';
  return `(SELECT COALESCE(SUM(pr.amount),0) FROM proposal_refunds pr
           JOIN proposals p2 ON p2.id = pr.proposal_id
           WHERE pr.status='succeeded'${rc}${cc})`;
}

function qSent(f) {
  const params = [];
  const c = dateClause('sent_at', f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals WHERE sent_at IS NOT NULL${c}${cc}`,
    params,
  };
}

function qAccepted(f) {
  const params = [];
  const c = dateClause('accepted_at', f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals WHERE accepted_at IS NOT NULL${c}${cc}`,
    params,
  };
}

function qWinRate(f) {
  const params = [];
  const c = dateClause('sent_at', f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT COUNT(*)::int AS sent_cohort,
                 COUNT(*) FILTER (WHERE accepted_at IS NOT NULL AND status <> 'archived')::int AS accepted_from_cohort,
                 COUNT(*) FILTER (WHERE accepted_at IS NULL AND status <> 'archived')::int AS pending
          FROM proposals WHERE sent_at IS NOT NULL${c}${cc}`,
    params,
  };
}

function qTimeToAccept(f) {
  const params = [];
  const c = dateClause('accepted_at', f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (accepted_at - sent_at))/86400.0
                 ) AS median_days
          FROM proposals
          WHERE accepted_at IS NOT NULL AND sent_at IS NOT NULL${c}${cc}`,
    params,
  };
}

function qLostValue(f) {
  const params = [];
  const c = dateClause('sent_at', f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals
          WHERE sent_at IS NOT NULL AND status = 'archived'${c}${cc}`,
    params,
  };
}

function qPipelineOutstanding(f = {}) {
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals WHERE status IN ('sent','viewed','modified')${cc}`,
    params: [],
  };
}

/** Headline money for the basis. Paid returns cents in `value` (caller → toDollars fromCents). */
function qMoney(f) {
  const params = [];
  if (f.basis === 'paid') {
    const c = dateClause('pp.created_at', f.from, f.to, params);
    // Default `all` path keeps the join-less form for performance parity with
    // the pre-filter query. Only join to proposals when filtering by cc_id.
    // Refunds are netted via a scalar subquery so the `all` path stays join-less.
    if (f.includeCc === 'all') {
      const refunds = refundsInWindow(f.from, f.to, params, 'all');
      return {
        sql: `SELECT (COALESCE(SUM(pp.amount),0) - ${refunds})::float8 AS value
              FROM proposal_payments pp WHERE pp.status = 'succeeded'${c}`,
        params,
        cents: true,
      };
    }
    const cc = ccClause('p.', f.includeCc);
    const refunds = refundsInWindow(f.from, f.to, params, f.includeCc);
    return {
      sql: `SELECT (COALESCE(SUM(pp.amount),0) - ${refunds})::float8 AS value
            FROM proposal_payments pp
            JOIN proposals p ON p.id = pp.proposal_id
            WHERE pp.status = 'succeeded'${c}${cc}`,
      params,
      cents: true,
    };
  }
  const col = f.basis === 'scheduled' ? 'event_date' : 'accepted_at';
  const c = dateClause(col, f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals
          WHERE accepted_at IS NOT NULL AND ${NOT_DEAD}${c}${cc}`,
    params,
    cents: false,
  };
}

function qOutstanding(f) {
  const params = [];
  const c = dateClause('event_date', f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT COALESCE(SUM(GREATEST(total_price - COALESCE(amount_paid,0),0)),0)::float8 AS value
          FROM proposals
          WHERE accepted_at IS NOT NULL AND ${NOT_DEAD}${c}${cc}`,
    params,
  };
}

/**
 * Monthly series. `value` = basis $ per month, `paid` = succeeded payments $.
 * Bounds: explicit [from,to] when given; else data MIN → now, capped to the
 * trailing 24 months so a stray ancient row can't create a pathological series.
 */
function qRevenue(f) {
  const params = [];
  let lo;
  let hi;
  if (f.from && f.to) {
    params.push(f.from); lo = `date_trunc('month', $${params.length}::date)`;
    params.push(f.to); hi = `date_trunc('month', $${params.length}::date)`;
  } else {
    const minExpr = f.basis === 'paid'
      ? "(SELECT MIN(created_at) FROM proposal_payments WHERE status='succeeded')"
      : f.basis === 'scheduled'
        ? `(SELECT MIN(event_date) FROM proposals WHERE accepted_at IS NOT NULL AND ${NOT_DEAD})`
        : `(SELECT MIN(accepted_at) FROM proposals WHERE accepted_at IS NOT NULL AND ${NOT_DEAD})`;
    lo = `GREATEST(
            date_trunc('month', COALESCE(${minExpr}, NOW() - INTERVAL '11 months')),
            date_trunc('month', NOW()) - INTERVAL '23 months')`;
    hi = `date_trunc('month', NOW())`;
  }
  const ccPrefixed = ccClause('p.', f.includeCc);
  // For the paid branch we keep the join-less subquery on the default `all`
  // path so the existing performance characteristics are preserved. Only when
  // a cc filter is active do we join to proposals.
  const paidValueSub = f.includeCc === 'all'
    ? `((SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_payments pp
        WHERE pp.status='succeeded' AND pp.created_at >= ms AND pp.created_at < ms + INTERVAL '1 month')
       - (SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_refunds pr
          WHERE pr.status='succeeded' AND pr.created_at >= ms AND pr.created_at < ms + INTERVAL '1 month'))`
    : `((SELECT COALESCE(SUM(pp.amount),0)::float8/100.0 FROM proposal_payments pp
        JOIN proposals p ON p.id = pp.proposal_id
        WHERE pp.status='succeeded' AND pp.created_at >= ms AND pp.created_at < ms + INTERVAL '1 month'${ccPrefixed})
       - (SELECT COALESCE(SUM(pr.amount),0)::float8/100.0 FROM proposal_refunds pr
          JOIN proposals p ON p.id = pr.proposal_id
          WHERE pr.status='succeeded' AND pr.created_at >= ms AND pr.created_at < ms + INTERVAL '1 month'${ccPrefixed}))`;
  const paidSiblingSub = f.includeCc === 'all'
    ? `((SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_payments pp
        WHERE pp.status='succeeded' AND pp.created_at >= ms
          AND pp.created_at < ms + INTERVAL '1 month')
       - (SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_refunds pr
          WHERE pr.status='succeeded' AND pr.created_at >= ms
          AND pr.created_at < ms + INTERVAL '1 month'))`
    : `((SELECT COALESCE(SUM(pp.amount),0)::float8/100.0 FROM proposal_payments pp
        JOIN proposals p ON p.id = pp.proposal_id
        WHERE pp.status='succeeded' AND pp.created_at >= ms
          AND pp.created_at < ms + INTERVAL '1 month'${ccPrefixed})
       - (SELECT COALESCE(SUM(pr.amount),0)::float8/100.0 FROM proposal_refunds pr
          JOIN proposals p ON p.id = pr.proposal_id
          WHERE pr.status='succeeded' AND pr.created_at >= ms
          AND pr.created_at < ms + INTERVAL '1 month'${ccPrefixed}))`;
  const valueSub = f.basis === 'paid'
    ? paidValueSub
    : `(SELECT COALESCE(SUM(total_price),0)::float8 FROM proposals p
        WHERE p.accepted_at IS NOT NULL AND p.${NOT_DEAD}
          AND p.${f.basis === 'scheduled' ? 'event_date' : 'accepted_at'} >= ms
          AND p.${f.basis === 'scheduled' ? 'event_date' : 'accepted_at'} < ms + INTERVAL '1 month'${ccPrefixed})`;
  return {
    sql: `SELECT to_char(ms,'YYYY-MM') AS key,
                 to_char(ms,'Mon')     AS m,
                 ${valueSub} AS value,
                 ${paidSiblingSub} AS paid
          FROM generate_series(${lo}, ${hi}, INTERVAL '1 month') AS ms
          ORDER BY ms`,
    params,
  };
}

/** Range-independent count of proposals in a paid status. Restores the old
 *  dashboard-stats `totals.events_count` consumed by ProposalsDashboard's Paid tab. */
function qPaidCount(f = {}) {
  const cc = ccClause('', f.includeCc);
  return {
    sql: `SELECT COUNT(*)::int AS count
          FROM proposals
          WHERE status IN ('deposit_paid','balance_paid','confirmed','completed')${cc}`,
    params: [],
  };
}

const builders = {
  qSent, qAccepted, qWinRate, qTimeToAccept, qLostValue,
  qPipelineOutstanding, qMoney, qOutstanding, qRevenue, qPaidCount,
};

module.exports = { resolveFilters, priorPeriod, dateClause, ccClause, refundsInWindow, toDollars, BASES, INCLUDE_CC_VALUES, ...builders };
