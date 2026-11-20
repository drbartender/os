// The proposals list query (filters, open balance, sort, paging, counts): the read behind GET /api/proposals.
//
// Moved out of server/routes/proposals/list.js (lane connector-shared-reads,
// spec 2026-11-19 law 4) so the admin proposals list, its cohort drill-outs,
// the phone list and the Claude connector's money-owed tool share one copy of
// every predicate. The route hands in req.query and shapes the response; with
// no options the rows, the counts and their order are exactly what the route
// always sent (list.response.test.js pins the row, crud.filters.test.js the
// filters, list.sort.test.js the order, list.phone.test.js the envelope).
//
// Two options, both opt-in, neither of which the admin route passes:
//   - owed: each row also carries amount_owed, qOutstanding's own expression
//     (metricsQueries.js, GREATEST(total_price - amount_paid, 0) in SQL, in
//     dollars as stored), and days_past_due, the Chicago business day minus
//     balance_due_date in SQL (positive: that many days overdue; 0: due
//     today; negative: due in that many days; null: no due date). With no
//     ?sort the rows run by due date, earliest first, no due date last.
//   - exclude (legalHold.holdExclusion()): the held proposal ids and the held
//     clients' every proposal are left out by two int[] parameters in the
//     WHERE every query shares, so the page, the total and the envelope counts
//     never show a gap.
// `now` (a Date, default the call's own time) is the instant whose Chicago day
// days_past_due counts from; it is a test seam and only read under owed.

const { pool } = require('../../db');
// dateClause + NOT_DEAD are imported (not re-declared) so the list drill-outs
// and the metrics endpoints share ONE date/predicate definition and cannot
// drift: a WHERE mismatch here is silent and would break funnel reconciliation.
const { dateClause, NOT_DEAD } = require('../metricsQueries');
const { readExclusion } = require('./exclusion');

// User input never reaches SQL as text: axis/cohort/status map to fixed
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
// Whitelisted sort columns for the admin list. A client's ?sort= value is a KEY
// here and nothing else: each maps to a fixed SQL expression, so no user text
// reaches SQL (same contract as axis/cohort above). ?dir is asc|desc (default
// desc). An unknown/absent ?sort falls back to created_at DESC. The keys mirror
// ProposalsDashboard's SortableTh sortKeys exactly, plus `created_at`: the phone
// list's "Newest lead" order (lane ma-f1) names the fallback explicitly so it
// can sit beside event_date in one apparatus. Desktop columns are unchanged.
const SORT_COLUMNS = {
  client: 'LOWER(c.name)',
  event: "LOWER(COALESCE(NULLIF(TRIM(p.event_type_custom), ''), p.event_type, ''))",
  event_date: 'p.event_date',
  package: 'LOWER(sp.name)',
  status: 'p.status',
  sent: 'p.sent_at',
  last_viewed: 'p.last_viewed_at',
  total: 'p.total_price',
  created_at: 'p.created_at',
};

// qOutstanding's per-row expression (metricsQueries.js), on this query's alias.
// proposalList.test.js holds the two copies to one text.
const OWED_SQL = 'GREATEST(p.total_price - COALESCE(p.amount_paid,0),0)';
const BUSINESS_TZ = 'America/Chicago';

const SELECT_COLUMNS = `
    SELECT p.id, p.token, p.client_id, p.event_type, p.event_type_custom,
           p.event_type_category, p.event_date, p.event_start_time,
           p.event_duration_hours, p.event_location, p.guest_count, p.num_bars,
           p.num_bartenders, p.package_id, p.group_id, p.status, p.archive_reason, p.source, p.total_price, p.amount_paid,
           p.deposit_amount, p.balance_due_date, p.payment_type, p.autopay_enrolled,
           p.sent_at, p.accepted_at, p.client_signed_at, p.last_viewed_at, p.view_count,
           p.created_at, p.updated_at, p.cc_id AS proposal_cc_id,
           c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
           c.cc_id AS client_cc_id,
           sp.name AS package_name, sp.slug AS package_slug`;
// $n is the instant whose Chicago day the counts run from (bound as a
// timestamptz; the session's own zone never enters).
const owedColumns = (n) => `,
           ${OWED_SQL} AS amount_owed,
           ((($${n}::timestamptz) AT TIME ZONE '${BUSINESS_TZ}')::date - p.balance_due_date) AS days_past_due`;

const FROM_WHERE = `
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    WHERE 1=1`;

// (6) Phone apparatus (spec 2026-08-13-mobile-admin section 5, lane ma-f1).
// ?unviewed=1 keeps the sent proposals the client has never opened. It is a
// server-side predicate on purpose: a client-side filter over one 50-row page
// would return a wrong subset. `modified` implies viewed, so status = 'sent'
// is the whole test, and it adds no parameters.
const UNVIEWED_SQL = " AND p.last_viewed_at IS NULL AND p.status = 'sent'";

/**
 * Run the proposals list.
 * @param {object} query - req.query's shape: status, view, search, source,
 *   page, limit, axis, event_type, balance, cohort, from, to, sort, dir,
 *   unviewed, envelope (each read exactly as GET /api/proposals reads it)
 * @param {{exclude?: {proposalIds: number[], clientIds: number[]}, owed?: boolean, now?: Date}} [opts]
 * @returns {Promise<{rows: object[], total: number, bucketTotal: number|null,
 *   unviewedTotal: number|null, page: number, limit: number}>} the rows carry
 *   the list's columns (and amount_owed, days_past_due under owed); the two
 *   bucket counts are null unless query.envelope is '1'
 */
async function listProposals(query = {}, { exclude, owed = false, now } = {}) {
  const hold = readExclusion(exclude);
  const { status, view = 'active', search, source, page = 1, limit = 50,
    axis, event_type: eventType, balance, cohort, from, to, sort, dir,
    unviewed, envelope } = query;
  // Bound pagination: a non-numeric limit (?limit=abc) otherwise casts to NaN and
  // 22P02-500s; ?page=0 yields a negative OFFSET. Clamp to [1, 200], default 50;
  // page floors at 1 (matches clients.js).
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const pg = Math.max(1, parseInt(page, 10) || 1);
  // Shared FROM + WHERE built once so the data SELECT and the COUNT(*) cover the
  // exact same filtered set. whereParams holds ONLY the filter params (status /
  // search / date / event_type / exclusion); pagination (LIMIT/OFFSET) is
  // appended to the data query alone.
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
      // Default 'active' bucket: exclude paid (moved to Events) and archived.
      whereClause += ` AND p.status NOT IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived')`;
    }
  }
  if (search) {
    whereParams.push(`%${search}%`);
    whereClause += ` AND (c.name ILIKE $${whereParams.length} OR c.email ILIKE $${whereParams.length})`;
  }

  // Origin filter. Fixed literals only (no user value into SQL): safe.
  if (source === 'thumbtack') {
    whereClause += " AND p.source = 'thumbtack'";
  } else if (source === 'manual') {
    whereClause += ' AND p.source IS NULL';
  }

  // (3) Date range on the cohort's own column, else the human-facing axis (event
  // date by default). dateClause is the SHARED half-open [from, to+1) fragment
  // from metricsQueries: NEVER hand-roll `col <= $n`: sent_at/accepted_at are
  // timestamptz and an inclusive `<=` casts the bound to midnight and silently
  // drops same-day-evening rows. from/to must be YYYY-MM-DD; a malformed value is
  // ignored, never cast to date (a bad cast 500s: the UUID-token failure class).
  const validFrom = DATE_RE.test(from || '') ? from : null;
  const validTo = DATE_RE.test(to || '') ? to : null;
  const dateCol = cohortDef ? cohortDef.dateCol : (AXIS_COL[axis] || 'p.event_date');
  whereClause += dateClause(dateCol, validFrom, validTo, whereParams);

  // axis=sent excludes never-sent rows by definition (only meaningful without a
  // cohort: a cohort already pins its own axis).
  if (!cohortDef && axis === 'sent') {
    whereClause += ' AND p.sent_at IS NOT NULL';
  }

  // (4) Event type, normalized on BOTH sides so a split-by drill-out lands on
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

  // (5) Open balance: accepted-side rows still owing. NOT_DEAD is the shared
  // unprefixed literal ("status <> 'archived'"); this query aliases proposals as
  // p, so prefix at the call site.
  if (balance === 'open') {
    whereClause += ` AND p.accepted_at IS NOT NULL AND p.${NOT_DEAD} AND (p.total_price - COALESCE(p.amount_paid,0)) > 0`;
  }

  // (5b) The legal-hold exclusion (opt-in; the admin list never passes one):
  // in the shared WHERE, so the page, the total and both envelope counts agree.
  if (hold) {
    whereParams.push(hold.proposalIds);
    whereClause += ` AND NOT (p.id = ANY($${whereParams.length}::int[]))`;
    whereParams.push(hold.clientIds);
    whereClause += ` AND (p.client_id IS NULL OR NOT (p.client_id = ANY($${whereParams.length}::int[])))`;
  }

  // (6) `bucketWhere` is the same set WITHOUT the unviewed predicate, so the
  // envelope's bucket_total and unviewed_total describe the bucket whether or
  // not the chip is on.
  const bucketWhere = whereClause;
  if (unviewed === '1') whereClause += UNVIEWED_SQL;

  // Whitelisted ORDER BY. sortExpr comes from the fixed SORT_COLUMNS map and
  // sortDir from a literal branch: no user text is interpolated into SQL.
  // NULLS LAST keeps blank dates/prices at the bottom in BOTH directions; the
  // p.id tiebreaker makes the 50-row LIMIT page deterministic.
  // typeof guard: a bare SORT_COLUMNS[sort] can resolve to an inherited
  // Object.prototype member (?sort=toString / constructor / __proto__ …), truthy
  // but not a column expression, which would stringify into the clause and 500.
  // Only a string value from our own map counts; anything else falls back.
  const rawSortExpr = SORT_COLUMNS[sort];
  const sortExpr = typeof rawSortExpr === 'string' ? rawSortExpr : null;
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
  let orderBy = 'ORDER BY p.created_at DESC, p.id DESC';
  if (sortExpr) orderBy = `ORDER BY ${sortExpr} ${sortDir} NULLS LAST, p.id DESC`;
  else if (owed) orderBy = 'ORDER BY p.balance_due_date ASC NULLS LAST, p.id ASC';

  const params = [...whereParams];
  let columns = SELECT_COLUMNS;
  if (owed) {
    params.push(now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString());
    columns += owedColumns(params.length);
  }
  let sql = `${columns}
    ${FROM_WHERE}${whereClause}
    ${orderBy}`;
  params.push(lim);
  sql += ` LIMIT $${params.length}`;
  params.push((pg - 1) * lim);
  sql += ` OFFSET $${params.length}`;

  // Data + total run in parallel; COUNT(*) reuses the identical FROM/WHERE and
  // whereParams (no LIMIT/OFFSET) so the count matches the full filtered set.
  // The envelope's two bucket counts reuse bucketWhere with the same params.
  // Every fragment is a fixed text from this file; each user value is a $n.
  const wantEnvelope = envelope === '1';
  const countSql = `SELECT COUNT(*) ${FROM_WHERE}${whereClause}`;
  const bucketSql = `SELECT COUNT(*) ${FROM_WHERE}${bucketWhere}`;
  const unviewedSql = `SELECT COUNT(*) ${FROM_WHERE}${bucketWhere}${UNVIEWED_SQL}`;
  const [result, countResult, bucketResult, unviewedResult] = await Promise.all([
    pool.query(sql, params),
    pool.query(countSql, whereParams),
    wantEnvelope ? pool.query(bucketSql, whereParams) : null,
    wantEnvelope ? pool.query(unviewedSql, whereParams) : null,
  ]);
  return {
    rows: result.rows,
    total: Number(countResult.rows[0]?.count) || 0,
    bucketTotal: wantEnvelope ? Number(bucketResult.rows[0]?.count) || 0 : null,
    unviewedTotal: wantEnvelope ? Number(unviewedResult.rows[0]?.count) || 0 : null,
    page: pg,
    limit: lim,
  };
}

module.exports = { listProposals, OWED_SQL };
