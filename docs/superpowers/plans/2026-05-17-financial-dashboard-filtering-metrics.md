# Financial + Dashboard Filtering & Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add date-range + money-lens (Booked/Scheduled/Paid) filtering to the admin Dashboard and Financials pages, plus a sales-funnel metric set (sent, accepted, cohort win rate, time-to-accept, pipeline-outstanding, lost value) with period-over-period deltas.

**Architecture:** A pure server helper (`server/utils/metricsQueries.js`, mirroring `bookingWindow.js`) is the single source of truth for filter parsing and SQL fragment building. The existing `/proposals/dashboard-stats` and `/proposals/financials` endpoints consume it and grow `?from=&to=&basis=` params. A URL-synced React hook (`useMetricsFilter`, mirroring `useDrawerParam.js`) drives a shared presentational `MetricsFilterBar`. Filtering is server-side (indexed `WHERE`) because ~1.5 years of Check Cherry history is coming in a later project.

**Tech Stack:** Node 18 / Express 4, raw SQL via `pg`, Postgres (Neon), React 18 + React Router 6, `node:test` for unit tests (no jest on the server; run with `node --test`).

**Spec:** `docs/superpowers/specs/2026-05-17-financial-dashboard-filtering-metrics-design.md`

**Two deviations from the spec, with rationale:**
1. Shared component lives at `client/src/components/adminos/MetricsFilterBar.js` (not the generic `components/` path). Every dashboard component the two pages import (`AreaChart`, `StaffPills`, `StatusChip`, `format`) lives in `components/adminos/`; that is the admin-dashboard component home. Staying consistent beats the spec's illustrative path.
2. Spec said "four new indexes." Inspection of `server/db/schema.sql` shows `proposals(event_date)` (line 1216) and `proposals(created_at)` (line 971) already exist. Only **three** are missing: `proposals(sent_at)`, `proposals(accepted_at)`, `proposal_payments(created_at)`.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/utils/metricsQueries.js` | **New.** Pure: `resolveFilters`, `priorPeriod`, `dateClause`, `toDollars` + per-metric `{sql,params}` builders. No DB calls, no `require('../db')`. |
| `server/utils/metricsQueries.test.js` | **New.** `node:test` unit tests for the four pure helpers. |
| `server/routes/proposals/metadata.js` | **Modify.** Rewrite `/financials` (70-116) and `/dashboard-stats` (118-190) to parse params via `metricsQueries` and return the new shapes; `/dashboard-stats` also returns top-level `paidCount` (from `qPaidCount`) for ProposalsDashboard's Paid-tab badge. Executes the builders; no SQL strings of its own. |
| `server/db/schema.sql` | **Modify (append).** Three idempotent `CREATE INDEX IF NOT EXISTS`. |
| `client/src/hooks/useMetricsFilter.js` | **New.** URL-synced `{from,to,basis}` state + preset math. Mirrors `useDrawerParam.js`. |
| `client/src/components/adminos/MetricsFilterBar.js` | **New.** Presentational filter bar (preset dropdown, custom date inputs, Booked/Scheduled/Paid toggle). Dumb — driven by `useMetricsFilter`. |
| `client/src/pages/admin/Dashboard.js` | **Modify.** Mount filter bar; split fetch (stats vs operational); render money/funnel zones + lens-aware chart; label exempt widgets "Live". |
| `client/src/pages/admin/FinancialsDashboard.js` | **Modify.** Mount filter bar; range+lens summary; payments "in range"; tables filter by `event_date`. |
| `client/src/pages/admin/ProposalsDashboard.js` | **Modify (review C-followup).** Pre-existing 3rd consumer of `/dashboard-stats`. Its Paid-tab badge read `totals.events_count` (removed in the rewrite). Switch line ~67 from `r.data?.totals?.events_count` to `r.data?.paidCount`. Its other reads (`pipeline[]`, lines 62-66) are unchanged. |
| `README.md`, `ARCHITECTURE.md` | **Modify.** New util/hook/component in folder tree; index note. |

**Wire contract (all money in DOLLARS; Paid is summed in cents server-side then converted before JSON):**

```
GET /api/proposals/dashboard-stats?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=booked|scheduled|paid
{
  filters: { from, to, basis },                       // resolved echo; from/to null = All time
  money: {
    basis,
    value, priorValue, deltaPct,                       // headline for basis; deltaPct null if no prior
    outstanding, outstandingPrior, outstandingDeltaPct
  },
  funnel: {
    sent:     { count, value },
    accepted: { count, value },
    winRate:  { sentCohort, acceptedFromCohort, pending, pct },  // pct null if sentCohort 0
    timeToAcceptMedianDays,                             // number|null
    lostValue,                                          // dollars
    pipelineOutstanding: { count, value }               // live snapshot, range-independent
  },
  revenue:  [ { key, m, value, paid } ],                // monthly; value=basis $, paid=collected $
  pipeline: [ { key, label, count, value } ],           // UNCHANGED existing draft→accepted bars
  paidCount                                             // int — range-independent COUNT of paid-status proposals; restores old totals.events_count for ProposalsDashboard's Paid-tab badge
}

GET /api/proposals/financials?from=&to=&basis=&page=&limit=
{
  filters: { from, to, basis },
  summary: { booked, collected, outstanding, avgEvent },// dollars; avgEvent = booked / accepted-count-in-range
  proposals: [ ... ],                                   // event_date in range, existing columns + pagination
  recentPayments: [ ... ],                              // succeeded payments, created_at in range (was: last 20)
  pagination: { page, limit, total }
}
```

---

### Task 1: Schema indexes

**Files:**
- Modify: `server/db/schema.sql` (append at end of file — established migration pattern here; idempotent)

- [ ] **Step 1: Append the index block**

Open `server/db/schema.sql`, go to the very end of the file, and append:

```sql

-- ─── Metrics filtering: date-column indexes (2026-05-17) ──────────
-- Dashboard/Financials filter by sent_at, accepted_at, and payment
-- date. proposals(event_date) [idx_proposals_event_date] and
-- proposals(created_at) [idx_proposals_created_at] already exist.
CREATE INDEX IF NOT EXISTS idx_proposals_sent_at ON proposals(sent_at);
CREATE INDEX IF NOT EXISTS idx_proposals_accepted_at ON proposals(accepted_at);
CREATE INDEX IF NOT EXISTS idx_proposal_payments_created_at ON proposal_payments(created_at);
```

- [ ] **Step 2: Verify idempotency by inspection**

Run: `grep -n "idx_proposals_sent_at\|idx_proposals_accepted_at\|idx_proposal_payments_created_at" server/db/schema.sql`
Expected: exactly the three lines just added, each `CREATE INDEX IF NOT EXISTS` (re-runnable, no duplicates created on re-apply).

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "perf(db): index proposals.sent_at/accepted_at + proposal_payments.created_at for metrics filtering"
```

---

### Task 2: Pure metrics helper + tests (TDD)

**Files:**
- Create: `server/utils/metricsQueries.js`
- Test: `server/utils/metricsQueries.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/metricsQueries.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveFilters, priorPeriod, dateClause, toDollars,
} = require('./metricsQueries');

// ── resolveFilters ──
test('resolveFilters: defaults basis to booked, no dates = All time', () => {
  assert.deepEqual(resolveFilters({}), { from: null, to: null, basis: 'booked' });
});

test('resolveFilters: valid range + basis passes through', () => {
  assert.deepEqual(
    resolveFilters({ from: '2026-04-01', to: '2026-04-30', basis: 'paid' }),
    { from: '2026-04-01', to: '2026-04-30', basis: 'paid' }
  );
});

test('resolveFilters: unknown basis throws', () => {
  assert.throws(() => resolveFilters({ basis: 'bogus' }), /basis/);
});

test('resolveFilters: malformed date throws', () => {
  assert.throws(() => resolveFilters({ from: '2026-13-99', to: '2026-04-30' }), /date/i);
});

test('resolveFilters: only one bound throws (ambiguous)', () => {
  assert.throws(() => resolveFilters({ from: '2026-04-01' }), /both/i);
});

test('resolveFilters: from after to throws', () => {
  assert.throws(() => resolveFilters({ from: '2026-05-01', to: '2026-04-01' }), /before/i);
});

test('resolveFilters: rolled-over calendar date (Feb 30) throws — not silently accepted', () => {
  assert.throws(() => resolveFilters({ from: '2026-02-30', to: '2026-03-31' }), /date/i);
});

test('resolveFilters: April 31 (impossible day) throws', () => {
  assert.throws(() => resolveFilters({ from: '2026-04-01', to: '2026-04-31' }), /date/i);
});

test('resolveFilters: non-leap Feb 29 throws', () => {
  assert.throws(() => resolveFilters({ from: '2025-02-29', to: '2025-03-01' }), /date/i);
});

// ── priorPeriod ──
test('priorPeriod: April 2026 → March 2026 (equal length, immediately prior)', () => {
  assert.deepEqual(
    priorPeriod('2026-04-01', '2026-04-30'),
    { from: '2026-03-02', to: '2026-03-31' }
  );
});

test('priorPeriod: 7-day window shifts back exactly 7 days', () => {
  assert.deepEqual(
    priorPeriod('2026-04-08', '2026-04-14'),
    { from: '2026-04-01', to: '2026-04-07' }
  );
});

test('priorPeriod: All time (null) → null', () => {
  assert.equal(priorPeriod(null, null), null);
});

// ── dateClause ──
test('dateClause: null range → empty fragment, params untouched', () => {
  const params = [];
  assert.equal(dateClause('p.sent_at', null, null, params), '');
  assert.deepEqual(params, []);
});

test('dateClause: half-open range, 1-based param placeholders', () => {
  const params = [];
  const frag = dateClause('p.accepted_at', '2026-04-01', '2026-04-30', params);
  assert.equal(frag, ' AND p.accepted_at >= $1::date AND p.accepted_at < ($2::date + 1)');
  assert.deepEqual(params, ['2026-04-01', '2026-04-30']);
});

test('dateClause: appends to existing params with correct offset', () => {
  const params = ['x'];
  const frag = dateClause('pp.created_at', '2026-01-01', '2026-01-31', params);
  assert.equal(frag, ' AND pp.created_at >= $2::date AND pp.created_at < ($3::date + 1)');
  assert.deepEqual(params, ['x', '2026-01-01', '2026-01-31']);
});

// ── toDollars ──
test('toDollars: passthrough for dollar values', () => {
  assert.equal(toDollars(1234.5), 1234.5);
  assert.equal(toDollars(null), 0);
});

test('toDollars: divides by 100 when fromCents', () => {
  assert.equal(toDollars(65000, { fromCents: true }), 650);
  assert.equal(toDollars(null, { fromCents: true }), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/metricsQueries.test.js`
Expected: FAIL — `Cannot find module './metricsQueries'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/utils/metricsQueries.js`:

```js
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
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s) {
  if (!ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * @param {{from?:string,to?:string,basis?:string}} q
 * @returns {{from:string|null,to:string|null,basis:string}}
 */
function resolveFilters(q = {}) {
  const basis = q.basis == null || q.basis === '' ? 'booked' : String(q.basis);
  if (!BASES.includes(basis)) {
    throw new ValidationError({ basis: `basis must be one of ${BASES.join(', ')}` });
  }
  const hasFrom = q.from != null && q.from !== '';
  const hasTo = q.to != null && q.to !== '';
  if (!hasFrom && !hasTo) return { from: null, to: null, basis };
  if (hasFrom !== hasTo) {
    throw new ValidationError({ from: 'both from and to are required for a custom range' });
  }
  if (!isRealDate(q.from)) throw new ValidationError({ from: 'from must be a valid YYYY-MM-DD date' });
  if (!isRealDate(q.to)) throw new ValidationError({ to: 'to must be a valid YYYY-MM-DD date' });
  if (q.from > q.to) throw new ValidationError({ from: 'from must be on or before to' });
  return { from: q.from, to: q.to, basis };
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

module.exports = { resolveFilters, priorPeriod, dateClause, toDollars, BASES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/metricsQueries.test.js`
Expected: PASS — all assertions green.

- [ ] **Step 5: Lint**

Run: `npx eslint server/utils/metricsQueries.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/utils/metricsQueries.js server/utils/metricsQueries.test.js
git commit -m "feat(metrics): pure filter-parsing + SQL-fragment helpers with unit tests"
```

---

### Task 3: Add SQL builders to the metrics helper (TDD-by-shape)

The pure helpers are tested. The query builders below are exercised by the manual matrix in Task 6 (no DB in the unit env — consistent with this codebase's pure-only unit tests). Each builder returns `{ sql, params }`.

**Files:**
- Modify: `server/utils/metricsQueries.js`

- [ ] **Step 1: Add the builders before `module.exports`**

Insert into `server/utils/metricsQueries.js` immediately above the `module.exports` line:

```js
// ── SQL builders. Each returns { sql, params }. `f` = { from, to, basis }. ──

const NOT_DEAD = "status <> 'cancelled'";

function qSent(f) {
  const params = [];
  const c = dateClause('sent_at', f.from, f.to, params);
  return {
    sql: `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals WHERE sent_at IS NOT NULL${c}`,
    params,
  };
}

function qAccepted(f) {
  const params = [];
  const c = dateClause('accepted_at', f.from, f.to, params);
  return {
    sql: `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals WHERE accepted_at IS NOT NULL${c}`,
    params,
  };
}

function qWinRate(f) {
  const params = [];
  const c = dateClause('sent_at', f.from, f.to, params);
  return {
    sql: `SELECT COUNT(*)::int AS sent_cohort,
                 COUNT(*) FILTER (WHERE accepted_at IS NOT NULL AND status <> 'cancelled')::int AS accepted_from_cohort,
                 COUNT(*) FILTER (WHERE accepted_at IS NULL AND status <> 'cancelled')::int AS pending
          FROM proposals WHERE sent_at IS NOT NULL${c}`,
    params,
  };
}

function qTimeToAccept(f) {
  const params = [];
  const c = dateClause('accepted_at', f.from, f.to, params);
  return {
    sql: `SELECT percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (accepted_at - sent_at))/86400.0
                 ) AS median_days
          FROM proposals
          WHERE accepted_at IS NOT NULL AND sent_at IS NOT NULL${c}`,
    params,
  };
}

function qLostValue(f) {
  const params = [];
  const c = dateClause('sent_at', f.from, f.to, params);
  return {
    sql: `SELECT COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals
          WHERE sent_at IS NOT NULL AND status = 'cancelled'${c}`,
    params,
  };
}

function qPipelineOutstanding() {
  return {
    sql: `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals WHERE status IN ('sent','viewed','modified')`,
    params: [],
  };
}

/** Headline money for the basis. Paid returns cents in `value` (caller → toDollars fromCents). */
function qMoney(f) {
  const params = [];
  if (f.basis === 'paid') {
    const c = dateClause('pp.created_at', f.from, f.to, params);
    return {
      sql: `SELECT COALESCE(SUM(pp.amount),0)::float8 AS value
            FROM proposal_payments pp WHERE pp.status = 'succeeded'${c}`,
      params,
      cents: true,
    };
  }
  const col = f.basis === 'scheduled' ? 'event_date' : 'accepted_at';
  const c = dateClause(col, f.from, f.to, params);
  return {
    sql: `SELECT COALESCE(SUM(total_price),0)::float8 AS value
          FROM proposals
          WHERE accepted_at IS NOT NULL AND ${NOT_DEAD}${c}`,
    params,
    cents: false,
  };
}

function qOutstanding(f) {
  const params = [];
  const c = dateClause('event_date', f.from, f.to, params);
  return {
    sql: `SELECT COALESCE(SUM(GREATEST(total_price - COALESCE(amount_paid,0),0)),0)::float8 AS value
          FROM proposals
          WHERE accepted_at IS NOT NULL AND ${NOT_DEAD}${c}`,
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
  const valueSub = f.basis === 'paid'
    ? `(SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_payments pp
        WHERE pp.status='succeeded' AND pp.created_at >= ms AND pp.created_at < ms + INTERVAL '1 month')`
    : `(SELECT COALESCE(SUM(total_price),0)::float8 FROM proposals p
        WHERE p.accepted_at IS NOT NULL AND p.${NOT_DEAD}
          AND p.${f.basis === 'scheduled' ? 'event_date' : 'accepted_at'} >= ms
          AND p.${f.basis === 'scheduled' ? 'event_date' : 'accepted_at'} < ms + INTERVAL '1 month')`;
  return {
    sql: `SELECT to_char(ms,'YYYY-MM') AS key,
                 to_char(ms,'Mon')     AS m,
                 ${valueSub} AS value,
                 (SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_payments pp
                   WHERE pp.status='succeeded' AND pp.created_at >= ms
                     AND pp.created_at < ms + INTERVAL '1 month') AS paid
          FROM generate_series(${lo}, ${hi}, INTERVAL '1 month') AS ms
          ORDER BY ms`,
    params,
  };
}

/** Range-independent count of proposals in a paid status. Restores the old
 *  dashboard-stats `totals.events_count` consumed by ProposalsDashboard's Paid tab. */
function qPaidCount() {
  return {
    sql: `SELECT COUNT(*)::int AS count
          FROM proposals
          WHERE status IN ('deposit_paid','balance_paid','confirmed','completed')`,
    params: [],
  };
}

const builders = {
  qSent, qAccepted, qWinRate, qTimeToAccept, qLostValue,
  qPipelineOutstanding, qMoney, qOutstanding, qRevenue, qPaidCount,
};
```

Then change the export line to include the builders:

```js
module.exports = { resolveFilters, priorPeriod, dateClause, toDollars, BASES, ...builders };
```

- [ ] **Step 2: Re-run the pure helper tests (regression — builders must not break them)**

Run: `node --test server/utils/metricsQueries.test.js`
Expected: PASS — all Task 2 assertions still green.

- [ ] **Step 3: Smoke-check builder output shape**

Run:
```bash
node -e "const m=require('./server/utils/metricsQueries');const r=m.qMoney({from:'2026-04-01',to:'2026-04-30',basis:'paid'});console.log(r.sql.includes('proposal_payments'),r.cents,r.params);"
```
Expected: `true true [ '2026-04-01', '2026-04-30' ]`

- [ ] **Step 4: Lint**

Run: `npx eslint server/utils/metricsQueries.js`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/utils/metricsQueries.js
git commit -m "feat(metrics): per-metric SQL builders (funnel, money lens, revenue series)"
```

---

### Task 4: Rewrite the two endpoints to consume the helper

**Files:**
- Modify: `server/routes/proposals/metadata.js` (replace lines 70-190; keep 1-69 and 192-193)

- [ ] **Step 1: Update the import line**

In `server/routes/proposals/metadata.js`, line 6 currently:

```js
const { ValidationError } = require('../../utils/errors');
```

Replace with:

```js
const { ValidationError } = require('../../utils/errors');
const metrics = require('../../utils/metricsQueries');
```

- [ ] **Step 2: Replace `/financials` (lines 70-116)**

Replace the entire `router.get('/financials', ...)` handler with:

```js
router.get('/financials', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const f = metrics.resolveFilters(req.query); // throws ValidationError on bad input
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const money = metrics.qMoney(f);
  const out = metrics.qOutstanding(f);
  const acc = metrics.qAccepted(f);

  // Proposals + payments lists filter by event_date / payment date (NOT the
  // lens) — a list is rows of events; event_date is the intuitive axis.
  const listParams = [];
  const propDate = metrics.dateClause('p.event_date', f.from, f.to, listParams);
  const payParams = [];
  const payDate = metrics.dateClause('pp.created_at', f.from, f.to, payParams);

  const [moneyR, outR, accR, totalR, proposalsR, paymentsR] = await Promise.all([
    pool.query(money.sql, money.params),
    pool.query(out.sql, out.params),
    pool.query(acc.sql, acc.params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM proposals p
       WHERE p.status NOT IN ('draft')${propDate}`, listParams),
    pool.query(`
      SELECT p.id, p.event_type, p.event_type_custom, p.event_date, p.total_price, p.amount_paid,
             p.deposit_amount, p.status, p.created_at,
             c.name AS client_name, c.email AS client_email,
             sp.name AS package_name
      FROM proposals p
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.status NOT IN ('draft')${propDate}
      ORDER BY p.event_date DESC NULLS LAST
      LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}
    `, [...listParams, limit, offset]),
    pool.query(`
      SELECT pp.id, pp.proposal_id, pp.payment_type, pp.amount, pp.status AS payment_status,
             pp.created_at, p.event_type, p.event_type_custom, c.name AS client_name,
             ip.invoice_id, i.token AS invoice_token
      FROM proposal_payments pp
      JOIN proposals p ON p.id = pp.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN invoice_payments ip ON ip.payment_id = pp.id
      LEFT JOIN invoices i ON i.id = ip.invoice_id
      WHERE pp.status = 'succeeded'${payDate}
      ORDER BY pp.created_at DESC
      LIMIT 200
    `, payParams),
  ]);

  const booked = metrics.toDollars(moneyR.rows[0].value, { fromCents: !!money.cents });
  const collectedRow = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS c FROM proposal_payments
     WHERE status='succeeded'${metrics.dateClause('created_at', f.from, f.to, [])
       ? '' : ''}`); // collected total = all succeeded (lifetime) — see note below
  const acceptedCount = accR.rows[0].count;

  res.json({
    filters: { from: f.from, to: f.to, basis: f.basis },
    summary: {
      booked,
      collected: metrics.toDollars(collectedRow.rows[0].c, { fromCents: true }),
      outstanding: metrics.toDollars(outR.rows[0].value),
      avgEvent: acceptedCount > 0 ? Math.round(booked / acceptedCount) : 0,
    },
    proposals: proposalsR.rows,
    recentPayments: paymentsR.rows,
    pagination: { page, limit, total: totalR.rows[0].total },
  });
}));
```

> **Correctness note (read before implementing the line above):** the `collectedRow` block as written is wrong-by-construction (the `dateClause(... , [])` discards params). Replace the `collectedRow` computation with this exact, correct version instead:

```js
  const collParams = [];
  const collClause = metrics.dateClause('created_at', f.from, f.to, collParams);
  const collectedRow = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS c FROM proposal_payments
     WHERE status='succeeded'${collClause}`, collParams);
```

Use the corrected block. (The first version is shown only so the reviewer sees the trap and why the param-array form is mandatory.)

- [ ] **Step 3: Replace `/dashboard-stats` (lines 118-190)**

Replace the entire `router.get('/dashboard-stats', ...)` handler with:

```js
router.get('/dashboard-stats', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const f = metrics.resolveFilters(req.query);
  const prior = metrics.priorPeriod(f.from, f.to);

  const money = metrics.qMoney(f);
  const out = metrics.qOutstanding(f);
  const sent = metrics.qSent(f);
  const acc = metrics.qAccepted(f);
  const wr = metrics.qWinRate(f);
  const tta = metrics.qTimeToAccept(f);
  const lost = metrics.qLostValue(f);
  const pipeOut = metrics.qPipelineOutstanding();
  const rev = metrics.qRevenue(f);

  // Prior-period variants (null when All time → no prior window).
  const priorF = prior ? { ...f, from: prior.from, to: prior.to } : null;
  const moneyPrior = priorF ? metrics.qMoney(priorF) : null;
  const outPrior = priorF ? metrics.qOutstanding(priorF) : null;

  const PIPELINE_STATUSES = "('draft', 'sent', 'viewed', 'modified', 'accepted')";

  const [
    moneyR, outR, sentR, accR, wrR, ttaR, lostR, pipeOutR, revR,
    pipelineR, moneyPriorR, outPriorR,
  ] = await Promise.all([
    pool.query(money.sql, money.params),
    pool.query(out.sql, out.params),
    pool.query(sent.sql, sent.params),
    pool.query(acc.sql, acc.params),
    pool.query(wr.sql, wr.params),
    pool.query(tta.sql, tta.params),
    pool.query(lost.sql, lost.params),
    pool.query(pipeOut.sql, pipeOut.params),
    pool.query(rev.sql, rev.params),
    pool.query(`
      SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
      FROM proposals WHERE status IN ${PIPELINE_STATUSES} GROUP BY status
    `),
    moneyPrior ? pool.query(moneyPrior.sql, moneyPrior.params) : Promise.resolve(null),
    outPrior ? pool.query(outPrior.sql, outPrior.params) : Promise.resolve(null),
  ]);

  const PIPELINE_ORDER = [
    { key: 'draft', label: 'Draft' }, { key: 'sent', label: 'Sent' },
    { key: 'viewed', label: 'Viewed' }, { key: 'modified', label: 'Modified' },
    { key: 'accepted', label: 'Accepted' },
  ];
  const pipelineByStatus = Object.fromEntries(
    pipelineR.rows.map(r => [r.status, { count: r.count, value: r.value }])
  );
  const pipeline = PIPELINE_ORDER.map(b => ({
    key: b.key, label: b.label,
    count: pipelineByStatus[b.key]?.count || 0,
    value: pipelineByStatus[b.key]?.value || 0,
  }));

  const fc = { fromCents: !!money.cents };
  const value = metrics.toDollars(moneyR.rows[0].value, fc);
  const priorValue = moneyPriorR ? metrics.toDollars(moneyPriorR.rows[0].value, fc) : null;
  const outstanding = metrics.toDollars(outR.rows[0].value);
  const outstandingPrior = outPriorR ? metrics.toDollars(outPriorR.rows[0].value) : null;
  const pct = (cur, pre) =>
    pre == null ? null : pre === 0 ? null : Math.round(((cur - pre) / pre) * 100);
  const sc = wrR.rows[0].sent_cohort;
  const md = ttaR.rows[0].median_days;

  res.json({
    filters: { from: f.from, to: f.to, basis: f.basis },
    money: {
      basis: f.basis,
      value, priorValue, deltaPct: pct(value, priorValue),
      outstanding, outstandingPrior, outstandingDeltaPct: pct(outstanding, outstandingPrior),
    },
    funnel: {
      sent: { count: sentR.rows[0].count, value: metrics.toDollars(sentR.rows[0].value) },
      accepted: { count: accR.rows[0].count, value: metrics.toDollars(accR.rows[0].value) },
      winRate: {
        sentCohort: sc,
        acceptedFromCohort: wrR.rows[0].accepted_from_cohort,
        pending: wrR.rows[0].pending,
        pct: sc > 0 ? Math.round((wrR.rows[0].accepted_from_cohort / sc) * 100) : null,
      },
      timeToAcceptMedianDays: md == null ? null : Math.round(Number(md) * 10) / 10,
      lostValue: metrics.toDollars(lostR.rows[0].value),
      pipelineOutstanding: { count: pipeOutR.rows[0].count, value: metrics.toDollars(pipeOutR.rows[0].value) },
    },
    revenue: revR.rows,
    pipeline,
  });
}));
```

- [ ] **Step 4: Restart the dev server and smoke-test both endpoints**

The dev server is a Claude-managed background process with no auto-reload — restart it (kill the `:5000` PID, relaunch `npm run dev`) so the route changes load.

Run (with a valid admin JWT in `$T`):
```bash
curl -s -H "Authorization: Bearer $T" "http://localhost:5000/api/proposals/dashboard-stats?from=2026-04-01&to=2026-04-30&basis=booked" | head -c 400
curl -s -H "Authorization: Bearer $T" "http://localhost:5000/api/proposals/dashboard-stats?basis=paid" | head -c 400
curl -s -H "Authorization: Bearer $T" "http://localhost:5000/api/proposals/financials?from=2026-04-01&to=2026-04-30&basis=scheduled" | head -c 400
curl -s -H "Authorization: Bearer $T" "http://localhost:5000/api/proposals/dashboard-stats?basis=bogus"
```
Expected: first three return JSON matching the wire contract (`filters`, `money`, `funnel`, `revenue`, `pipeline` / `summary`, `proposals`, `pagination`); the fourth returns a 400 `VALIDATION_ERROR` body mentioning `basis`.

- [ ] **Step 5: Lint**

Run: `npx eslint server/routes/proposals/metadata.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/metadata.js
git commit -m "feat(api): from/to/basis filtering on dashboard-stats + financials"
```

---

### Task 5: URL filter hook + shared filter bar

**Files:**
- Create: `client/src/hooks/useMetricsFilter.js`
- Create: `client/src/components/adminos/MetricsFilterBar.js`

- [ ] **Step 1: Create the hook**

Create `client/src/hooks/useMetricsFilter.js`:

```js
import { useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * URL-synced metrics filter state. Three representable selections:
 *   - named preset → ?from=YYYY-MM-DD&to=YYYY-MM-DD   (no `range` param)
 *   - All time     → ?range=all                       (no from/to; API omits the date predicate)
 *   - Custom       → ?range=custom&from=...&to=...
 * No params at all → default = Last 12 months (deliberately DISTINCT from All time).
 * Mirrors useDrawerParam.js — layered on other params, never clobbers them.
 */
const iso = (d) => d.toISOString().slice(0, 10);

export function presetRange(preset, today = new Date()) {
  const y = today.getUTCFullYear();
  const mo = today.getUTCMonth();
  const d0 = (Y, M, D) => new Date(Date.UTC(Y, M, D));
  switch (preset) {
    case 'this-month':   return { from: iso(d0(y, mo, 1)), to: iso(d0(y, mo + 1, 0)) };
    case 'last-month':   return { from: iso(d0(y, mo - 1, 1)), to: iso(d0(y, mo, 0)) };
    case 'this-quarter': {
      const q = Math.floor(mo / 3) * 3;
      return { from: iso(d0(y, q, 1)), to: iso(d0(y, q + 3, 0)) };
    }
    case 'ytd':          return { from: iso(d0(y, 0, 1)), to: iso(d0(y, mo, today.getUTCDate())) };
    case 'last-12':      return { from: iso(d0(y, mo - 11, 1)), to: iso(d0(y, mo + 1, 0)) };
    default:             return { from: null, to: null };
  }
}

const NAMED = ['this-month', 'last-month', 'this-quarter', 'ytd', 'last-12'];

export default function useMetricsFilter() {
  const [params, setParams] = useSearchParams();
  const range = params.get('range');            // 'all' | 'custom' | null
  const from = params.get('from');
  const to = params.get('to');
  const basis = params.get('basis') || 'booked';

  // What the consuming page sends to the API.
  const effective = useMemo(() => {
    if (range === 'all') return { from: null, to: null, basis };  // true all-time
    if (from && to) return { from, to, basis };
    return { ...presetRange('last-12'), basis };                   // no params → default
  }, [range, from, to, basis]);

  const write = useCallback((mut) => {
    const p = new URLSearchParams(params);
    mut(p);
    setParams(p, { replace: false });
  }, [params, setParams]);

  // key ∈ NAMED ∪ { 'all', 'custom' }
  const setPreset = useCallback((key) => {
    if (key === 'all') {
      write((p) => { p.set('range', 'all'); p.delete('from'); p.delete('to'); });
    } else if (key === 'custom') {
      const seed = (from && to) ? { from, to } : presetRange('last-12');
      write((p) => { p.set('range', 'custom'); p.set('from', seed.from); p.set('to', seed.to); });
    } else {
      const r = presetRange(key);
      write((p) => { p.delete('range'); p.set('from', r.from); p.set('to', r.to); });
    }
  }, [write, from, to]);

  const setCustom = useCallback((next) => {
    write((p) => {
      p.set('range', 'custom');
      if (next.from) p.set('from', next.from); else p.delete('from');
      if (next.to) p.set('to', next.to); else p.delete('to');
    });
  }, [write]);

  const setBasis = useCallback((b) => {
    write((p) => p.set('basis', b));
  }, [write]);

  // Which dropdown option is active.
  const activePreset = useMemo(() => {
    if (range === 'all') return 'all';
    if (range === 'custom') return 'custom';
    if (!from && !to) return 'last-12';                 // no params → default
    for (const k of NAMED) {
      const r = presetRange(k);
      if (r.from === from && r.to === to) return k;
    }
    return 'custom';                                    // shared link, off-preset dates
  }, [range, from, to]);

  return { ...effective, rawFrom: from, rawTo: to, activePreset, setPreset, setCustom, setBasis };
}
```

- [ ] **Step 2: Create the filter bar**

Create `client/src/components/adminos/MetricsFilterBar.js`:

```js
import React from 'react';

const PRESETS = [
  ['this-month', 'This month'], ['last-month', 'Last month'],
  ['this-quarter', 'This quarter'], ['ytd', 'Year to date'],
  ['last-12', 'Last 12 months'], ['all', 'All time'], ['custom', 'Custom'],
];
const LENSES = [['booked', 'Booked'], ['scheduled', 'Scheduled'], ['paid', 'Paid']];

export default function MetricsFilterBar({ filter }) {
  const { basis, rawFrom, rawTo, activePreset, setPreset, setCustom, setBasis } = filter;
  const isCustom = activePreset === 'custom';

  return (
    <div className="hstack" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 'var(--gap)' }}>
      <select className="input" value={activePreset}
        onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
        {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {isCustom && (
        <>
          <input type="date" className="input" aria-label="From date"
            value={rawFrom || ''} max={rawTo || undefined}
            onChange={(e) => setCustom({ from: e.target.value, to: rawTo })} />
          <span className="muted tiny">to</span>
          <input type="date" className="input" aria-label="To date"
            value={rawTo || ''} min={rawFrom || undefined}
            onChange={(e) => setCustom({ from: rawFrom, to: e.target.value })} />
        </>
      )}

      <div className="seg" role="group" aria-label="Money lens" style={{ marginLeft: 'auto' }}>
        {LENSES.map(([v, l]) => (
          <button key={v} type="button"
            className={`seg-btn${basis === v ? ' is-active' : ''}`}
            aria-pressed={basis === v}
            onClick={() => setBasis(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify the client compiles**

Run: `cd client && CI=true npx react-scripts build 2>&1 | tail -20`
Expected: `Compiled successfully` (or only pre-existing warnings; no error referencing `useMetricsFilter` or `MetricsFilterBar`). Then `cd ..`.

> If `.seg`/`.seg-btn` styles do not exist in `client/src/index.css`, the bar still works (unstyled buttons). Styling polish is Task 6 Step 4.

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/useMetricsFilter.js client/src/components/adminos/MetricsFilterBar.js
git commit -m "feat(ui): URL-synced metrics filter hook + shared MetricsFilterBar"
```

---

### Task 6: Wire Dashboard + Financials, docs, verification

**Files:**
- Modify: `client/src/pages/admin/Dashboard.js`
- Modify: `client/src/pages/admin/FinancialsDashboard.js`
- Modify: `client/src/index.css` (segmented-control styles)
- Modify: `README.md`, `ARCHITECTURE.md`

- [ ] **Step 1: Rewrite `Dashboard.js`**

Replace the full contents of `client/src/pages/admin/Dashboard.js` with:

```jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { getEventTypeLabel } from '../../utils/eventTypes';
import Icon from '../../components/adminos/Icon';
import StaffPills from '../../components/adminos/StaffPills';
import AreaChart from '../../components/adminos/AreaChart';
import MetricsFilterBar from '../../components/adminos/MetricsFilterBar';
import useMetricsFilter from '../../hooks/useMetricsFilter';
import { fmt$, fmtDate, relDay, dayDiff } from '../../components/adminos/format';
import { shiftPositions, parsePositionsCount, approvedCount, eventStatusChip } from '../../components/adminos/shifts';
import ClickableRow from '../../components/ClickableRow';

const PIPELINE_COLORS = {
  draft: 'var(--ink-3)',
  sent: 'hsl(var(--info-h) var(--info-s) 62%)',
  viewed: 'var(--accent)',
  modified: 'hsl(var(--violet-h) var(--violet-s) 65%)',
  accepted: 'hsl(var(--ok-h) var(--ok-s) 52%)',
};

function eventRoute(e) {
  return e?.proposal_id ? `/events/${e.proposal_id}` : `/events/shift/${e?.id}`;
}

const EMPTY_STATS = {
  filters: { from: null, to: null, basis: 'booked' },
  money: { basis: 'booked', value: 0, priorValue: null, deltaPct: null, outstanding: 0, outstandingPrior: null, outstandingDeltaPct: null },
  funnel: {
    sent: { count: 0, value: 0 }, accepted: { count: 0, value: 0 },
    winRate: { sentCohort: 0, acceptedFromCohort: 0, pending: 0, pct: null },
    timeToAcceptMedianDays: null, lostValue: 0, pipelineOutstanding: { count: 0, value: 0 },
  },
  revenue: [], pipeline: [],
};

const LENS_LABEL = { booked: 'Booked', scheduled: 'Scheduled', paid: 'Paid' };

function Delta({ pct }) {
  if (pct == null) return null;
  const up = pct >= 0;
  return (
    <span className="tiny" style={{ color: up ? 'hsl(var(--ok-h) var(--ok-s) 45%)' : 'hsl(var(--danger-h) var(--danger-s) 55%)' }}>
      {up ? '▲' : '▼'} {Math.abs(pct)}% vs prior
    </span>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const filter = useMetricsFilter();
  const { from, to, basis } = filter;

  const [stats, setStats] = useState(EMPTY_STATS);
  const [shifts, setShifts] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);

  // Analytics zone — refetches on filter change.
  useEffect(() => {
    const params = { basis };
    if (from && to) { params.from = from; params.to = to; }
    api.get('/proposals/dashboard-stats', { params })
      .then(r => setStats(r.data || EMPTY_STATS))
      .catch(() => toast.error('Dashboard metrics failed to load. Try refreshing.'));
  }, [from, to, basis, toast]);

  // Operational zone — exempt from the filter, loads once.
  useEffect(() => {
    let anyFailed = false;
    Promise.all([
      api.get('/shifts').then(r => r.data).catch(() => { anyFailed = true; return []; }),
      api.get('/proposals').then(r => r.data).catch(() => { anyFailed = true; return []; }),
      api.get('/admin/applications').then(r => r.data).catch(() => { anyFailed = true; return { applications: [] }; }),
    ]).then(([s, p, a]) => {
      setShifts(s || []);
      setProposals(p || []);
      setApplications(a?.applications || a || []);
      if (anyFailed) toast.error('Some dashboard data failed to load. Try refreshing.');
    }).finally(() => setLoading(false));
  }, [toast]);

  const upcoming = useMemo(() =>
    shifts.filter(e => e.event_date && dayDiff(e.event_date.slice(0, 10)) >= 0)
      .sort((a, b) => a.event_date.localeCompare(b.event_date)), [shifts]);
  const unstaffed = useMemo(() =>
    upcoming.filter(e => approvedCount(e) < parsePositionsCount(e)), [upcoming]);
  const openShifts = useMemo(() =>
    upcoming.reduce((s, e) => s + Math.max(0, parsePositionsCount(e) - approvedCount(e)), 0), [upcoming]);
  const newApplications = useMemo(() =>
    Array.isArray(applications) ? applications.filter(a => a.onboarding_status === 'applied').length : 0, [applications]);

  const actionQueue = useMemo(() => {
    const items = [];
    unstaffed.slice(0, 3).forEach(e => {
      const open = parsePositionsCount(e) - approvedCount(e);
      const days = dayDiff(e.event_date.slice(0, 10));
      items.push({
        id: 'unstaffed-' + e.id, type: 'unstaffed', priority: days < 7 ? 'danger' : 'warn',
        title: `${e.client_name || 'Event'} needs ${open} ${open === 1 ? 'bartender' : 'bartenders'}`,
        sub: `${getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })} · ${fmtDate(e.event_date.slice(0, 10))} · ${days}d out`,
        meta: `${open} open`, target: e.proposal_id ? 'event' : 'shift', ref: e.proposal_id || e.id,
      });
    });
    proposals.filter(p => ['sent', 'viewed', 'modified'].includes(p.status)).slice(0, 2).forEach(p => {
      items.push({
        id: 'prop-' + p.id, type: 'proposal', priority: 'info',
        title: `${p.client_name || p.client_email} proposal — ${p.status}`,
        sub: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
        meta: fmt$(Number(p.total_price || 0)), target: 'proposal', ref: p.id,
      });
    });
    if (newApplications > 0) {
      items.push({
        id: 'apps', type: 'application', priority: 'info',
        title: `${newApplications} new ${newApplications === 1 ? 'application' : 'applications'}`,
        sub: 'Review in hiring', meta: `${newApplications} new`, target: 'hiring', ref: null,
      });
    }
    return items;
  }, [unstaffed, proposals, newApplications]);

  const m = stats.money || EMPTY_STATS.money;
  const fn = stats.funnel || EMPTY_STATS.funnel;
  const pipeline = stats.pipeline || [];
  const maxPipelineValue = Math.max(1, ...pipeline.map(p => Number(p.value || 0)));
  const wr = fn.winRate || EMPTY_STATS.funnel.winRate;

  if (loading) {
    return <div className="page"><div className="muted">Loading dashboard…</div></div>;
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">
            {upcoming.length} upcoming {upcoming.length === 1 ? 'event' : 'events'}
            {unstaffed.length > 0 && ` · ${unstaffed.length} need staff`}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/financials')}>
            <Icon name="external" />Financials
          </button>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/proposals/new')}>
            <Icon name="plus" />New proposal
          </button>
        </div>
      </div>

      <MetricsFilterBar filter={filter} />

      {/* Money zone — driven by the lens toggle */}
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat" onClick={() => navigate('/financials')}>
          <div className="stat-label">{LENS_LABEL[m.basis]}</div>
          <div className="stat-value">{fmt$(m.value)}</div>
          <div className="stat-sub"><Delta pct={m.deltaPct} /></div>
        </div>
        <div className="stat" onClick={() => navigate('/financials')}>
          <div className="stat-label">Outstanding</div>
          <div className="stat-value" style={{ color: m.outstanding > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
            {fmt$(m.outstanding)}
          </div>
          <div className="stat-sub"><Delta pct={m.outstandingDeltaPct} /></div>
        </div>
        <div className="stat">
          <div className="stat-label">Sent</div>
          <div className="stat-value">{fn.sent.count}</div>
          <div className="stat-sub"><span>{fmt$(fn.sent.value)} quoted</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Accepted</div>
          <div className="stat-value">{fn.accepted.count}</div>
          <div className="stat-sub"><span>{fmt$(fn.accepted.value)} won</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value">{wr.pct == null ? '—' : `${wr.pct}%`}</div>
          <div className="stat-sub">
            <span>{wr.acceptedFromCohort} of {wr.sentCohort} sent · {wr.pending} pending</span>
          </div>
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">Time to accept</div>
          <div className="stat-value">
            {fn.timeToAcceptMedianDays == null ? '—' : `${fn.timeToAcceptMedianDays}d`}
          </div>
          <div className="stat-sub"><span>median, accepted in range</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Pipeline <span className="k">Live</span></div>
          <div className="stat-value">{fn.pipelineOutstanding.count}</div>
          <div className="stat-sub"><span>{fmt$(fn.pipelineOutstanding.value)} in flight</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Lost</div>
          <div className="stat-value" style={{ color: fn.lostValue > 0 ? 'hsl(var(--danger-h) var(--danger-s) 55%)' : '' }}>
            {fmt$(fn.lostValue)}
          </div>
          <div className="stat-sub"><span>quoted then cancelled</span></div>
        </div>
      </div>

      <div className="dash-main">
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head">
              <div className="hstack">
                <h3>Revenue</h3>
                <span className="k">{LENS_LABEL[m.basis]} by month</span>
              </div>
              <div className="hstack" style={{ gap: 14 }}>
                <span className="hstack tiny muted" style={{ gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent)' }} />{LENS_LABEL[m.basis]}
                </span>
                <span className="hstack tiny muted" style={{ gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'hsl(var(--ok-h) var(--ok-s) 52%)' }} />Collected
                </span>
              </div>
            </div>
            <div className="card-body">
              {(stats.revenue || []).length === 0
                ? <div className="muted tiny" style={{ padding: '2rem 0', textAlign: 'center' }}>No revenue in this range.</div>
                : <AreaChart data={stats.revenue} keys={['value', 'paid']} />}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Upcoming events <span className="k">Live</span></h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/events')}>
                View all <Icon name="right" size={11} />
              </button>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Event</th><th>Date</th><th>Staffing</th><th>Status</th>
                    <th className="num">Total</th><th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.length === 0 && (
                    <tr><td colSpan={6} className="muted">No upcoming events</td></tr>
                  )}
                  {upcoming.slice(0, 6).map(e => {
                    const total = Number(e.proposal_total || 0);
                    const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
                    const bal = total - paid;
                    return (
                      <ClickableRow key={e.id} to={eventRoute(e)}>
                        <td>
                          <strong>{e.client_name || '—'}</strong>
                          <div className="sub">{getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })}</div>
                        </td>
                        <td>
                          <div>{fmtDate(e.event_date.slice(0, 10))}</div>
                          <div className="sub">{relDay(e.event_date.slice(0, 10))}</div>
                        </td>
                        <td><StaffPills positions={shiftPositions(e)} /></td>
                        <td>{eventStatusChip(e)}</td>
                        <td className="num">{total > 0 ? fmt$(total) : '—'}</td>
                        <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
                          {bal > 0 ? fmt$(bal) : '—'}
                        </td>
                      </ClickableRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head">
              <h3><Icon name="alert" size={12} /> Needs attention <span className="k">Live</span></h3>
              <span className="k">{actionQueue.length}</span>
            </div>
            <div>
              {actionQueue.length === 0 && (
                <div className="muted tiny" style={{ padding: '0.75rem 1rem' }}>Nothing pressing right now.</div>
              )}
              {actionQueue.map(a => (
                <div key={a.id} className="queue-item"
                  onClick={() => {
                    if (a.target === 'event') navigate(`/events/${a.ref}`);
                    else if (a.target === 'shift') navigate(`/events/shift/${a.ref}`);
                    else if (a.target === 'proposal') navigate(`/proposals/${a.ref}`);
                    else if (a.target === 'hiring') navigate('/hiring');
                  }}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}>
                  <div className={`queue-icon ${a.priority}`}>
                    <Icon name={a.type === 'unstaffed' ? 'userplus' : a.type === 'proposal' ? 'eye' : a.type === 'application' ? 'pen' : 'alert'} />
                  </div>
                  <div className="queue-main">
                    <div className="queue-title">{a.title}</div>
                    <div className="queue-sub">{a.sub}</div>
                  </div>
                  <div className="queue-meta">{a.meta}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Pipeline</h3><span className="k">Proposals</span></div>
            <div className="card-body" style={{ padding: '0.75rem 1rem' }}>
              {pipeline.length === 0 && <div className="muted tiny">No active proposals.</div>}
              {pipeline.map(row => {
                const value = Number(row.value || 0);
                return (
                  <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 50px 80px', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 12 }}>
                    <span style={{ color: 'var(--ink-2)' }}>{row.label}</span>
                    <div className="bar"><div className="bar-fill" style={{ width: `${Math.min(100, (value / maxPipelineValue) * 100)}%`, background: PIPELINE_COLORS[row.key] || 'var(--ink-3)' }} /></div>
                    <span className="num muted" style={{ textAlign: 'right' }}>{row.count}</span>
                    <span className="num" style={{ textAlign: 'right', color: 'var(--ink-1)', fontWeight: 600 }}>{fmt$(value)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `FinancialsDashboard.js`**

Replace the full contents of `client/src/pages/admin/FinancialsDashboard.js` with:

```jsx
import React, { useState, useEffect } from 'react';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';
import MetricsFilterBar from '../../components/adminos/MetricsFilterBar';
import useMetricsFilter from '../../hooks/useMetricsFilter';
import { fmt$, fmt$fromCents, fmtDate } from '../../components/adminos/format';
import ClickableRow from '../../components/ClickableRow';

const STATUS = {
  draft: 'neutral', sent: 'info', viewed: 'accent', modified: 'violet',
  accepted: 'ok', deposit_paid: 'ok', balance_paid: 'ok', confirmed: 'ok', completed: 'ok',
  declined: 'danger',
};
const LENS_LABEL = { booked: 'Booked', scheduled: 'Scheduled', paid: 'Paid' };

export default function FinancialsDashboard() {
  const toast = useToast();
  const filter = useMetricsFilter();
  const { from, to, basis } = filter;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = { basis };
    if (from && to) { params.from = from; params.to = to; }
    api.get('/proposals/financials', { params })
      .then(r => setData(r.data))
      .catch((err) => toast.error(err.message || 'Failed to load financial data. Try refreshing.'))
      .finally(() => setLoading(false));
  }, [from, to, basis, toast]);

  const summary = data?.summary;
  const proposals = data?.proposals;
  const recentPayments = data?.recentPayments;
  const booked = Number(summary?.booked || 0);
  const collected = Number(summary?.collected || 0);
  const outstanding = Number(summary?.outstanding || 0);
  const avgEvent = Number(summary?.avgEvent || 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Financials</div>
          <div className="page-subtitle">Revenue, outstanding balances, and recent payments.</div>
        </div>
      </div>

      <MetricsFilterBar filter={filter} />

      {loading && <div className="muted">Loading…</div>}
      {!loading && !data && (
        <div className="chip danger">Couldn't load financial data. Try refreshing.</div>
      )}

      {!loading && data && (
        <>
          <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
            <div className="stat">
              <div className="stat-label">{LENS_LABEL[basis]}</div>
              <div className="stat-value">{fmt$(booked)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Collected</div>
              <div className="stat-value" style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }}>{fmt$(collected)}</div>
              <div className="stat-sub"><span>{booked > 0 ? Math.round((collected / booked) * 100) : 0}% of {LENS_LABEL[basis].toLowerCase()}</span></div>
            </div>
            <div className="stat">
              <div className="stat-label">Outstanding</div>
              <div className="stat-value" style={{ color: outstanding > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>{fmt$(outstanding)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Avg event</div>
              <div className="stat-value">{fmt$(avgEvent)}</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 'var(--gap)', overflow: 'hidden' }}>
            <div className="card-head"><h3>Proposals</h3><span className="k">{data.pagination?.total ?? proposals?.length ?? 0}</span></div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Client</th><th>Event</th><th>Date</th><th>Status</th>
                    <th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(!proposals || proposals.length === 0) && (
                    <tr><td colSpan={7} className="muted">No proposals in this range.</td></tr>
                  )}
                  {proposals && proposals.map(p => {
                    const total = Number(p.total_price || 0);
                    const paid = Number(p.amount_paid || 0);
                    const bal = total - paid;
                    return (
                      <ClickableRow key={p.id} to={`/proposals/${p.id}`}>
                        <td><strong>{p.client_name || '—'}</strong></td>
                        <td>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</td>
                        <td>{p.event_date ? fmtDate(String(p.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                        <td><StatusChip kind={STATUS[p.status] || 'neutral'}>{p.status || '—'}</StatusChip></td>
                        <td className="num">{fmt$(total)}</td>
                        <td className="num muted">{fmt$(paid)}</td>
                        <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
                          {bal > 0 ? fmt$(bal) : '—'}
                        </td>
                      </ClickableRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-head"><h3>Payments in range</h3><span className="k">{recentPayments?.length || 0}</span></div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Client</th><th>Event</th><th>Type</th><th className="num">Amount</th><th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {(!recentPayments || recentPayments.length === 0) && (
                    <tr><td colSpan={5} className="muted">No payments in this range.</td></tr>
                  )}
                  {recentPayments && recentPayments.map(pp => (
                    <ClickableRow key={pp.id} style={{ cursor: pp.invoice_token ? 'pointer' : 'default' }}
                      onActivate={() => pp.invoice_token && window.open(`/invoice/${pp.invoice_token}`, '_blank', 'noopener,noreferrer')}
                      title={pp.invoice_token ? 'View invoice' : ''}>
                      <td><strong>{pp.client_name || '—'}</strong></td>
                      <td>{getEventTypeLabel({ event_type: pp.event_type, event_type_custom: pp.event_type_custom })}</td>
                      <td className="muted" style={{ textTransform: 'capitalize' }}>{pp.payment_type}</td>
                      <td className="num">{fmt$fromCents(pp.amount)}</td>
                      <td className="muted">{fmtDate(pp.created_at && String(pp.created_at).slice(0, 10), { year: 'numeric' })}</td>
                    </ClickableRow>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add segmented-control styles**

Append to the end of `client/src/index.css`:

```css
/* Metrics filter bar — segmented lens toggle */
.seg { display: inline-flex; border: 1px solid var(--line-1); border-radius: 8px; overflow: hidden; }
.seg-btn { padding: 6px 14px; font-size: 12px; background: transparent; border: 0; border-right: 1px solid var(--line-1); color: var(--ink-2); cursor: pointer; }
.seg-btn:last-child { border-right: 0; }
.seg-btn.is-active { background: var(--accent); color: #fff; }
```

- [ ] **Step 4: Build the client (lint gate — local lint-staged skips `client/`)**

Run: `cd client && CI=true npx react-scripts build 2>&1 | tail -25 && cd ..`
Expected: `Compiled successfully.` No errors. Pre-existing unrelated warnings are acceptable; no warning/error referencing the changed files.

- [ ] **Step 5: Run the server unit tests (regression)**

Run: `node --test server/utils/metricsQueries.test.js`
Expected: PASS — all assertions green.

- [ ] **Step 6: Manual verification matrix**

Restart the Claude-managed dev server (kill `:5000` PID, relaunch `npm run dev`). In the browser, signed in as admin, open `/` (Dashboard) and `/financials`. For each row, confirm:

| Check | Expected |
|---|---|
| Lens = Booked, range = Last 12 months | Money card label "Booked"; revenue chart titled "Booked by month" |
| Toggle lens → Scheduled, then Paid | Money headline + chart change; **Sent/Accepted/Win rate/Time/Pipeline/Lost do NOT change** |
| Change preset → This month, Last month, YTD, All time | Money + funnel + chart update; **Upcoming events + Needs attention do NOT change** (labeled "Live") |
| Custom range, `from` after `to` via URL `?from=2026-06-01&to=2026-01-01` | Toast error; no crash |
| `?basis=bogus` in URL | Toast error; no crash |
| Range with zero sent proposals | Win rate shows "—" (not NaN/0%); chart shows "No revenue in this range." |
| Reconciliation identity (pick a closed past month) | `acceptedFromCohort + pending + lostCount` **= exactly** `sentCohort` (won = accepted_at set & not cancelled; pending = accepted_at NULL & not cancelled; lost = status='cancelled' — a true partition, equality is exact not approximate) |
| Scheduled lens, event dated the 1st of a month, custom range ending that month | Event lands in the correct month bucket — no off-by-one at the DATE/timestamptz month boundary under the deployment TZ |
| Refresh the page on a custom range | Filter persists (URL params round-trip) |

Record the matrix result. Any failure → stop, fix root cause, re-run.

- [ ] **Step 7: Update docs**

In `README.md` folder-structure tree, add under the client hooks/components and server utils sections:
- `client/src/hooks/useMetricsFilter.js` — URL-synced dashboard/financials filter state
- `client/src/components/adminos/MetricsFilterBar.js` — shared date-range + money-lens control
- `server/utils/metricsQueries.js` — pure metrics filter parsing + SQL builders

In `ARCHITECTURE.md`: in the API route table, annotate `GET /api/proposals/dashboard-stats` and `GET /api/proposals/financials` as accepting `?from=&to=&basis=`. In the Database Schema / indexes section, note the three new metrics indexes (`idx_proposals_sent_at`, `idx_proposals_accepted_at`, `idx_proposal_payments_created_at`).

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/admin/Dashboard.js client/src/pages/admin/FinancialsDashboard.js client/src/index.css README.md ARCHITECTURE.md
git commit -m "feat(dashboard): date-range + lens filtering, funnel metrics, deltas on Dashboard + Financials"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 filter control (presets, default Last 12 mo, lens default Booked, URL state) | Task 5 (`useMetricsFilter`, `MetricsFilterBar`) |
| §2 count metrics (sent, accepted, cohort win rate, time-to-accept, pipeline-outstanding, lost) | Task 3 builders; Task 4 assembly; Task 6 render |
| §2 money lens (booked/scheduled/paid + outstanding companion) | Task 3 `qMoney`/`qOutstanding`; Task 4 |
| §2 win rate = cohort | Task 3 `qWinRate`; Task 4 `winRate` shape + Task 6 display string |
| §3 params + whitelist→column, ValidationError, per-metric WHERE, prior-period, indexes, shared module | Task 1 (indexes), Task 2 (`resolveFilters`/`priorPeriod`/`dateClause`), Task 4 (assembly) |
| §3 revenue series generalization | Task 3 `qRevenue`; Task 6 chart |
| §4 Dashboard zones + lens-aware chart + exempt "Live" widgets | Task 6 Step 1 |
| §4 Financials range+lens summary, payments-in-range, tables by event_date, pagination | Task 4 `/financials`, Task 6 Step 2 |
| §5 null timestamps (`IS NOT NULL` guards) | Task 3 (every builder guards its driving timestamp) |
| §5 timezone (half-open `::date` range, no new constant) | Task 2 `dateClause` |
| §5 empty/divide-by-zero (`—`, COALESCE, empty chart) | Task 4 (pct/winRate null), Task 6 (render guards) |
| §5 prior=0 → "new"/suppressed; All time → no delta | Task 4 `pct()` returns null when prior 0 or null; `Delta` renders nothing |
| §5 reconciliation identity test | Task 6 Step 6 matrix |
| §5 unit tests on pure helper; build gate | Task 2; Task 6 Step 4/5 |
| Docs update | Task 6 Step 7 |

No spec requirement is unmapped. Check Cherry forward-compat is explicitly out of scope (Project 2) — correctly absent.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle appropriately". The one intentionally-wrong code block (Task 4 Step 2 `collectedRow`) is immediately followed by the corrected version with an explicit instruction to use the corrected block — this is a teaching guard against the param-array trap, not a placeholder.

**3. Type consistency:** `resolveFilters` → `{from,to,basis}` consumed unchanged by every `q*` builder and both endpoints. `dateClause(column, from, to, params)` signature identical at all call sites (Task 2 def, Task 3 builders, Task 4 list queries). `toDollars(value,{fromCents})` consistent. Wire contract keys (`money`, `funnel.winRate.pct`, `funnel.pipelineOutstanding`, `revenue[].value/paid`, `summary.avgEvent`, `pagination.total`) are produced in Task 4 and consumed with the same names in Task 6. `AreaChart` called with `keys={['value','paid']}` matching the `revenue` row shape. Consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-financial-dashboard-filtering-metrics.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
