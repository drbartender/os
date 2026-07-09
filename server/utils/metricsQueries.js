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

// ── CC-era ledger legs (cc-import phase 2, 2026-07-07) ─────────────
//
// The CheckCherry era lives in the legacy_cc_* ledger tables (loaded once by
// scripts/cc-ledger-import.js), NOT in proposals — proposals.cc_id is NULL on
// every native row, so the ccClause above self-zeroes the native leg under
// 'only' and passes everything under 'all'/'exclude'. The tri-state therefore
// means: 'all' = native + ledger, 'exclude' = native only, 'only' = ledger
// only. Ledger money is SIGNED cents (refunds negative), so plain SUM() nets
// refunds. Funnel semantics: every ledger row was a quote (cc_created_at);
// a conversion is booked_at IS NOT NULL; value rides total_cost_cents of
// status='booked' rows. The era is closed, so it contributes nothing to
// pending/outstanding/pipeline metrics by design (see the phase-2 spec).

/** Whether the CC ledger contributes under this includeCc mode. */
function ccLedgerOn(includeCc) {
  return includeCc !== 'exclude';
}

/** Scalar subquery: CC-era collected CENTS (signed) over paid_on. '0' when off. */
function ccPaidLeg(from, to, params, includeCc) {
  if (!ccLedgerOn(includeCc)) return '0';
  const c = dateClause('lcp.paid_on', from, to, params);
  return `(SELECT COALESCE(SUM(lcp.payment_applied_cents),0) FROM legacy_cc_payments lcp WHERE TRUE${c})`;
}

/**
 * Scalar subquery: CC-era booked value in DOLLARS over booked_at|event_date.
 * '0' when off. Default rides status='booked' (mirrors native NOT_DEAD
 * exclusions); anyStatus=true values EVERY conversion (booked_at set,
 * cancelled bookings included) to mirror native qAccepted, whose count AND
 * value both survive a later archive.
 */
const CC_VALUE_COLUMNS = ['booked_at', 'event_date'];
function ccBookedValueLeg(column, from, to, params, includeCc, { anyStatus = false } = {}) {
  if (!CC_VALUE_COLUMNS.includes(column)) throw new Error(`ccBookedValueLeg: bad column ${column}`);
  if (!ccLedgerOn(includeCc)) return '0';
  const c = dateClause(`lcpr.${column}`, from, to, params);
  const scope = anyStatus ? 'lcpr.booked_at IS NOT NULL' : "lcpr.status = 'booked'";
  return `(SELECT COALESCE(SUM(lcpr.total_cost_cents),0)::float8/100.0 FROM legacy_cc_proposals lcpr WHERE ${scope}${c})`;
}

/** Scalar subquery: CC-era quote count over cc_created_at, optionally booked-only. '0' when off. */
function ccQuoteCountLeg(from, to, params, includeCc, { bookedOnly = false } = {}) {
  if (!ccLedgerOn(includeCc)) return '0';
  const c = dateClause('lcpr.cc_created_at', from, to, params);
  const booked = bookedOnly ? " AND lcpr.status = 'booked'" : '';
  return `(SELECT COUNT(*) FROM legacy_cc_proposals lcpr WHERE lcpr.cc_created_at IS NOT NULL${booked}${c})`;
}

/** Scalar subquery: CC-era quote value in DOLLARS over cc_created_at. '0' when off. */
function ccQuoteValueLeg(from, to, params, includeCc) {
  if (!ccLedgerOn(includeCc)) return '0';
  const c = dateClause('lcpr.cc_created_at', from, to, params);
  return `(SELECT COALESCE(SUM(lcpr.total_cost_cents),0)::float8/100.0 FROM legacy_cc_proposals lcpr WHERE lcpr.cc_created_at IS NOT NULL${c})`;
}

/** Scalar subquery: CC-era conversions (booked_at set) over booked_at. '0' when off. */
function ccBookedCountLeg(from, to, params, includeCc) {
  if (!ccLedgerOn(includeCc)) return '0';
  const c = dateClause('lcpr.booked_at', from, to, params);
  return `(SELECT COUNT(*) FROM legacy_cc_proposals lcpr WHERE lcpr.booked_at IS NOT NULL${c})`;
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
  // CC era: every ledger row was a sent quote; date axis = cc_created_at.
  const ccCount = ccQuoteCountLeg(f.from, f.to, params, f.includeCc);
  const ccValue = ccQuoteValueLeg(f.from, f.to, params, f.includeCc);
  return {
    sql: `SELECT (COUNT(*) + ${ccCount})::int AS count,
                 (COALESCE(SUM(total_price),0) + ${ccValue})::float8 AS value
          FROM proposals WHERE sent_at IS NOT NULL${c}${cc}`,
    params,
  };
}

function qAccepted(f) {
  const params = [];
  const c = dateClause('accepted_at', f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  // CC era: a conversion is booked_at IS NOT NULL (cancelled bookings still
  // converted, mirroring native accepted_at surviving an archive). BOTH axes
  // use that scope — the per-lane database review caught a count/value
  // mismatch when the value leg filtered status='booked' (214 counted, 204
  // valued, $800 dropped).
  const ccCount = ccBookedCountLeg(f.from, f.to, params, f.includeCc);
  const ccValue = ccBookedValueLeg('booked_at', f.from, f.to, params, f.includeCc, { anyStatus: true });
  return {
    sql: `SELECT (COUNT(*) + ${ccCount})::int AS count,
                 (COALESCE(SUM(total_price),0) + ${ccValue})::float8 AS value
          FROM proposals WHERE accepted_at IS NOT NULL${c}${cc}`,
    params,
  };
}

function qWinRate(f) {
  const params = [];
  const c = dateClause('sent_at', f.from, f.to, params);
  const cc = ccClause('', f.includeCc);
  // CC cohort: quotes created in-window; converted-from-cohort = the subset
  // that ended status='booked'. The era is closed, so it adds NOTHING to
  // pending — CC 'quote_open' rows are zombies, not live pipeline.
  const ccCohort = ccQuoteCountLeg(f.from, f.to, params, f.includeCc);
  const ccBookedFromCohort = ccQuoteCountLeg(f.from, f.to, params, f.includeCc, { bookedOnly: true });
  return {
    sql: `SELECT (COUNT(*) + ${ccCohort})::int AS sent_cohort,
                 (COUNT(*) FILTER (WHERE accepted_at IS NOT NULL AND status <> 'archived') + ${ccBookedFromCohort})::int AS accepted_from_cohort,
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
    // The CC leg is signed cents, so it nets its own refunds.
    if (f.includeCc === 'all') {
      const refunds = refundsInWindow(f.from, f.to, params, 'all');
      const ccLeg = ccPaidLeg(f.from, f.to, params, f.includeCc);
      return {
        sql: `SELECT (COALESCE(SUM(pp.amount),0) - ${refunds} + ${ccLeg})::float8 AS value
              FROM proposal_payments pp WHERE pp.status = 'succeeded'${c}`,
        params,
        cents: true,
      };
    }
    const cc = ccClause('p.', f.includeCc);
    const refunds = refundsInWindow(f.from, f.to, params, f.includeCc);
    const ccLeg = ccPaidLeg(f.from, f.to, params, f.includeCc);
    return {
      sql: `SELECT (COALESCE(SUM(pp.amount),0) - ${refunds} + ${ccLeg})::float8 AS value
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
  // CC leg mirrors the basis: booked value over booked_at, scheduled over event_date.
  const ccLeg = ccBookedValueLeg(f.basis === 'scheduled' ? 'event_date' : 'booked_at', f.from, f.to, params, f.includeCc);
  return {
    sql: `SELECT (COALESCE(SUM(total_price),0) + ${ccLeg})::float8 AS value
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
  const ccOn = ccLedgerOn(f.includeCc);
  let lo;
  let hi;
  if (f.from && f.to) {
    params.push(f.from); lo = `date_trunc('month', $${params.length}::date)`;
    params.push(f.to); hi = `date_trunc('month', $${params.length}::date)`;
  } else {
    const nativeMin = f.basis === 'paid'
      ? "(SELECT MIN(created_at) FROM proposal_payments WHERE status='succeeded')"
      : f.basis === 'scheduled'
        ? `(SELECT MIN(event_date) FROM proposals WHERE accepted_at IS NOT NULL AND ${NOT_DEAD})`
        : `(SELECT MIN(accepted_at) FROM proposals WHERE accepted_at IS NOT NULL AND ${NOT_DEAD})`;
    // Auto bounds follow the mode: the CC era starts earlier than native data,
    // so 'all' takes the earliest of both mins (LEAST ignores NULLs) and
    // 'only' uses the ledger min alone. The trailing-24-month cap still rules.
    const ccMin = f.basis === 'paid'
      ? '(SELECT MIN(paid_on) FROM legacy_cc_payments)'
      : f.basis === 'scheduled'
        ? "(SELECT MIN(event_date) FROM legacy_cc_proposals WHERE status = 'booked')"
        : "(SELECT MIN(booked_at) FROM legacy_cc_proposals WHERE status = 'booked')";
    const minExpr = f.includeCc === 'only' ? ccMin
      : ccOn ? `LEAST(${nativeMin}, ${ccMin})` : nativeMin;
    lo = `GREATEST(
            date_trunc('month', COALESCE(${minExpr}, NOW() - INTERVAL '11 months')),
            date_trunc('month', NOW()) - INTERVAL '23 months')`;
    hi = `date_trunc('month', NOW())`;
  }
  const ccPrefixed = ccClause('p.', f.includeCc);
  // Per-month CC-era legs, correlated on `ms`. Signed cents net refunds on the
  // paid leg; the booked/scheduled leg rides status='booked' event totals.
  const ccPaidMonthly = ccOn
    ? ` + (SELECT COALESCE(SUM(lcp.payment_applied_cents),0)::float8/100.0 FROM legacy_cc_payments lcp
          WHERE lcp.paid_on >= ms::date AND lcp.paid_on < (ms + INTERVAL '1 month')::date)`
    : '';
  const ccValueMonthly = ccOn
    ? (f.basis === 'scheduled'
      ? ` + (SELECT COALESCE(SUM(lcpr.total_cost_cents),0)::float8/100.0 FROM legacy_cc_proposals lcpr
            WHERE lcpr.status = 'booked' AND lcpr.event_date >= ms::date AND lcpr.event_date < (ms + INTERVAL '1 month')::date)`
      : ` + (SELECT COALESCE(SUM(lcpr.total_cost_cents),0)::float8/100.0 FROM legacy_cc_proposals lcpr
            WHERE lcpr.status = 'booked' AND lcpr.booked_at >= ms AND lcpr.booked_at < ms + INTERVAL '1 month')`)
    : '';
  // For the paid branch we keep the join-less subquery on the default `all`
  // path so the existing performance characteristics are preserved. Only when
  // a cc filter is active do we join to proposals.
  const paidValueSub = f.includeCc === 'all'
    ? `((SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_payments pp
        WHERE pp.status='succeeded' AND pp.created_at >= ms AND pp.created_at < ms + INTERVAL '1 month')
       - (SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_refunds pr
          WHERE pr.status='succeeded' AND pr.created_at >= ms AND pr.created_at < ms + INTERVAL '1 month')${ccPaidMonthly})`
    : `((SELECT COALESCE(SUM(pp.amount),0)::float8/100.0 FROM proposal_payments pp
        JOIN proposals p ON p.id = pp.proposal_id
        WHERE pp.status='succeeded' AND pp.created_at >= ms AND pp.created_at < ms + INTERVAL '1 month'${ccPrefixed})
       - (SELECT COALESCE(SUM(pr.amount),0)::float8/100.0 FROM proposal_refunds pr
          JOIN proposals p ON p.id = pr.proposal_id
          WHERE pr.status='succeeded' AND pr.created_at >= ms AND pr.created_at < ms + INTERVAL '1 month'${ccPrefixed})${ccPaidMonthly})`;
  const valueSub = f.basis === 'paid'
    ? paidValueSub
    : `((SELECT COALESCE(SUM(total_price),0)::float8 FROM proposals p
        WHERE p.accepted_at IS NOT NULL AND p.${NOT_DEAD}
          AND p.${f.basis === 'scheduled' ? 'event_date' : 'accepted_at'} >= ms
          AND p.${f.basis === 'scheduled' ? 'event_date' : 'accepted_at'} < ms + INTERVAL '1 month'${ccPrefixed})${ccValueMonthly})`;
  // The paid monthly value (payments minus refunds) is identical whether it
  // feeds `value` (paid basis) or the `paid` sibling column, so compute it ONCE
  // per month in a LATERAL instead of duplicating both subqueries (4 -> 2).
  const valueExpr = f.basis === 'paid' ? 'pv.paid' : valueSub;
  return {
    sql: `SELECT to_char(ms,'YYYY-MM') AS key,
                 to_char(ms,'Mon')     AS m,
                 ${valueExpr} AS value,
                 pv.paid AS paid
          FROM generate_series(${lo}, ${hi}, INTERVAL '1 month') AS ms
          CROSS JOIN LATERAL (SELECT ${paidValueSub} AS paid) pv
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

module.exports = {
  resolveFilters, priorPeriod, dateClause, ccClause, refundsInWindow, toDollars,
  ccLedgerOn, ccPaidLeg, ccBookedValueLeg, ccQuoteCountLeg, ccQuoteValueLeg, ccBookedCountLeg,
  BASES, INCLUDE_CC_VALUES, NOT_DEAD, ...builders,
};
