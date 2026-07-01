require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveFilters, priorPeriod, dateClause, ccClause, toDollars,
  qSent, qAccepted, qWinRate, qTimeToAccept, qLostValue,
  qPipelineOutstanding, qOutstanding, qPaidCount, qMoney, qRevenue,
} = require('./metricsQueries');

// ── refund netting (Lane A / A1, A2) ──
test('qMoney paid all-path nets refunds via scalar subquery, no JOIN', () => {
  const q = qMoney({ from: null, to: null, basis: 'paid', includeCc: 'all' });
  assert.match(q.sql, /FROM proposal_payments pp WHERE pp\.status = 'succeeded'/);
  assert.match(q.sql, /- \(SELECT COALESCE\(SUM\(pr\.amount\),0\) FROM proposal_refunds pr/);
  assert.doesNotMatch(q.sql, /JOIN proposals/);
});
test('qMoney paid cc-filtered nets refunds joined through proposals', () => {
  const q = qMoney({ from: '2026-06-01', to: '2026-06-30', basis: 'paid', includeCc: 'only' });
  assert.match(q.sql, /FROM proposal_refunds pr\s+JOIN proposals p2/);
  assert.match(q.sql, /p2\.cc_id IS NOT NULL/);
});
test('qRevenue paid series subtracts monthly refunds', () => {
  const q = qRevenue({ from: null, to: null, basis: 'paid', includeCc: 'all' });
  assert.match(q.sql, /FROM proposal_refunds pr[\s\S]*pr\.created_at >= ms[\s\S]*ms \+ INTERVAL '1 month'/);
});
test('qRevenue paid: value + paid share one LATERAL (no duplicate 4-subquery fan-out)', () => {
  // Explicit date range so the series bounds use date_trunc($n), NOT a
  // MIN(created_at) subquery — then the only payments/refunds subqueries are the
  // single shared LATERAL (the paid fan-out was 2 payments + 2 refunds; now 1+1).
  const q = qRevenue({ from: '2026-01-01', to: '2026-06-30', basis: 'paid', includeCc: 'all' });
  assert.match(q.sql, /CROSS JOIN LATERAL \(SELECT[\s\S]*\) pv/);
  assert.match(q.sql, /pv\.paid AS value/);   // paid basis reuses the lateral for value
  assert.match(q.sql, /pv\.paid AS paid/);
  assert.equal((q.sql.match(/FROM proposal_payments/g) || []).length, 1);
  assert.equal((q.sql.match(/FROM proposal_refunds/g) || []).length, 1);
});
test('qRevenue booked (non-paid): value uses total_price, paid still nets via the LATERAL', () => {
  const q = qRevenue({ from: null, to: null, basis: 'booked', includeCc: 'all' });
  assert.match(q.sql, /SUM\(total_price\)[\s\S]*AS value/);
  assert.match(q.sql, /pv\.paid AS paid/);
  assert.match(q.sql, /CROSS JOIN LATERAL/);
});

// ── resolveFilters ──
test('resolveFilters: defaults basis to booked, no dates = All time', () => {
  assert.deepEqual(resolveFilters({}), { from: null, to: null, basis: 'booked', includeCc: 'all' });
});

test('resolveFilters: valid range + basis passes through', () => {
  assert.deepEqual(
    resolveFilters({ from: '2026-04-01', to: '2026-04-30', basis: 'paid' }),
    { from: '2026-04-01', to: '2026-04-30', basis: 'paid', includeCc: 'all' }
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

// ── resolveFilters: include_cc tri-state ──
test('resolveFilters: include_cc defaults to all when missing/empty', () => {
  assert.equal(resolveFilters({}).includeCc, 'all');
  assert.equal(resolveFilters({ include_cc: '' }).includeCc, 'all');
});

test('resolveFilters: accepts all | exclude | only', () => {
  for (const v of ['all', 'exclude', 'only']) {
    assert.equal(resolveFilters({ include_cc: v }).includeCc, v);
  }
});

test('resolveFilters: rejects unknown include_cc with ValidationError mentioning the field', () => {
  assert.throws(
    () => resolveFilters({ include_cc: 'bogus' }),
    /include_cc/
  );
});

// ── ccClause helper ──
test("ccClause: 'only' → IS NOT NULL with prefix", () => {
  assert.equal(ccClause('p.', 'only'), ' AND p.cc_id IS NOT NULL');
  assert.equal(ccClause('', 'only'), ' AND cc_id IS NOT NULL');
});

test("ccClause: 'exclude' → IS NULL with prefix", () => {
  assert.equal(ccClause('p.', 'exclude'), ' AND p.cc_id IS NULL');
  assert.equal(ccClause('', 'exclude'), ' AND cc_id IS NULL');
});

test("ccClause: 'all' (or anything else) → empty string", () => {
  assert.equal(ccClause('p.', 'all'), '');
  assert.equal(ccClause('', undefined), '');
});

// ── Per-builder SQL inspection: single-table proposals builders ──
const F_BASE = { from: null, to: null, basis: 'booked' };

const singleTableBuilders = [
  ['qSent', qSent],
  ['qAccepted', qAccepted],
  ['qWinRate', qWinRate],
  ['qTimeToAccept', qTimeToAccept],
  ['qLostValue', qLostValue],
  ['qPipelineOutstanding', qPipelineOutstanding],
  ['qOutstanding', qOutstanding],
  ['qPaidCount', qPaidCount],
];

for (const [name, fn] of singleTableBuilders) {
  test(`${name}: include_cc=only adds cc_id IS NOT NULL`, () => {
    const { sql } = fn({ ...F_BASE, includeCc: 'only' });
    assert.match(sql, /cc_id IS NOT NULL/);
    assert.doesNotMatch(sql, /cc_id IS NULL/);
  });
  test(`${name}: include_cc=exclude adds cc_id IS NULL`, () => {
    const { sql } = fn({ ...F_BASE, includeCc: 'exclude' });
    assert.match(sql, /cc_id IS NULL/);
    assert.doesNotMatch(sql, /cc_id IS NOT NULL/);
  });
  test(`${name}: include_cc=all leaves SQL clean (no cc_id mention)`, () => {
    const { sql } = fn({ ...F_BASE, includeCc: 'all' });
    assert.doesNotMatch(sql, /cc_id/);
  });
}

// ── qMoney: per-basis branches ──
test('qMoney booked branch: include_cc=only → cc_id IS NOT NULL', () => {
  const { sql } = qMoney({ from: null, to: null, basis: 'booked', includeCc: 'only' });
  assert.match(sql, /cc_id IS NOT NULL/);
});
test('qMoney booked branch: include_cc=exclude → cc_id IS NULL', () => {
  const { sql } = qMoney({ from: null, to: null, basis: 'booked', includeCc: 'exclude' });
  assert.match(sql, /cc_id IS NULL/);
});
test('qMoney scheduled branch: include_cc=only → cc_id IS NOT NULL', () => {
  const { sql } = qMoney({ from: null, to: null, basis: 'scheduled', includeCc: 'only' });
  assert.match(sql, /cc_id IS NOT NULL/);
});

test('qMoney paid branch with include_cc=only: JOINs proposals + p.cc_id IS NOT NULL', () => {
  const { sql } = qMoney({ from: null, to: null, basis: 'paid', includeCc: 'only' });
  assert.match(sql, /JOIN proposals p ON p\.id = pp\.proposal_id/);
  assert.match(sql, /p\.cc_id IS NOT NULL/);
});
test('qMoney paid branch with include_cc=exclude: JOINs proposals + p.cc_id IS NULL', () => {
  const { sql } = qMoney({ from: null, to: null, basis: 'paid', includeCc: 'exclude' });
  assert.match(sql, /JOIN proposals p ON p\.id = pp\.proposal_id/);
  assert.match(sql, /p\.cc_id IS NULL/);
});
test('qMoney paid branch with include_cc=all: NO JOIN to proposals (perf-protect default)', () => {
  const { sql } = qMoney({ from: null, to: null, basis: 'paid', includeCc: 'all' });
  assert.doesNotMatch(sql, /JOIN proposals/);
  assert.doesNotMatch(sql, /cc_id/);
});

// ── qRevenue: per-basis branches ──
test('qRevenue booked branch: include_cc=only → cc_id IS NOT NULL in valueSub', () => {
  const { sql } = qRevenue({ from: null, to: null, basis: 'booked', includeCc: 'only' });
  assert.match(sql, /p\.cc_id IS NOT NULL/);
});
test('qRevenue scheduled branch: include_cc=exclude → cc_id IS NULL in valueSub', () => {
  const { sql } = qRevenue({ from: null, to: null, basis: 'scheduled', includeCc: 'exclude' });
  assert.match(sql, /p\.cc_id IS NULL/);
});

test('qRevenue paid branch with include_cc=only: subqueries JOIN proposals + filter', () => {
  const { sql } = qRevenue({ from: null, to: null, basis: 'paid', includeCc: 'only' });
  assert.match(sql, /JOIN proposals p ON p\.id = pp\.proposal_id/);
  assert.match(sql, /p\.cc_id IS NOT NULL/);
});
test('qRevenue paid branch with include_cc=exclude: subqueries JOIN proposals + filter', () => {
  const { sql } = qRevenue({ from: null, to: null, basis: 'paid', includeCc: 'exclude' });
  assert.match(sql, /JOIN proposals p ON p\.id = pp\.proposal_id/);
  assert.match(sql, /p\.cc_id IS NULL/);
});
test('qRevenue paid branch with include_cc=all: NO JOIN in payment subqueries (perf-protect default)', () => {
  const { sql } = qRevenue({ from: null, to: null, basis: 'paid', includeCc: 'all' });
  assert.doesNotMatch(sql, /JOIN proposals/);
  assert.doesNotMatch(sql, /cc_id/);
});

// ── Integration: math identity all == exclude + only against real DB ──
// Builder-layer integration test (lighter than HTTP). Seeds 4 proposals (2 native,
// 2 cc-imported), each accepted with one payment, then runs qMoney + qOutstanding
// in all three modes and asserts the identity holds.
//
// Skipped when DATABASE_URL is missing (e.g. CI without env wired up).
const hasDb = !!process.env.DATABASE_URL;
const integTest = hasDb ? test : test.skip;

integTest('integration: all.value == exclude.value + only.value for qMoney and qOutstanding', async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('metricsQueries.test.js refuses to run against production');
  }
  const { pool } = require('../db');
  const ids = [];
  const ccTag = `cc-test-batch10-${Date.now()}`;
  try {
    // 2 native + 2 cc-imported proposals, all accepted with one payment each.
    for (let i = 0; i < 4; i++) {
      const ccId = i < 2 ? null : `${ccTag}-${i}`;
      const r = await pool.query(
        `INSERT INTO proposals
           (client_id, event_date, status, event_type, event_start_time,
            event_duration_hours, total_price, amount_paid, accepted_at,
            sent_at, cc_id)
         VALUES (NULL, '2026-05-15', 'deposit_paid', 'wedding', '6:00 PM', 4,
                 1000, 250, NOW(), NOW(), $1)
         RETURNING id`,
        [ccId]
      );
      ids.push(r.rows[0].id);
      await pool.query(
        `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, created_at)
         VALUES ($1, 'deposit', 25000, 'succeeded', NOW())`,
        [r.rows[0].id]
      );
    }

    // Run qMoney (booked basis: total_price) and qOutstanding for each mode.
    const runs = await Promise.all(['all', 'exclude', 'only'].map(async (mode) => {
      const f = { from: null, to: null, basis: 'booked', includeCc: mode };
      const m = qMoney(f);
      const o = qOutstanding(f);
      const [mr, or] = await Promise.all([
        pool.query(m.sql, m.params),
        pool.query(o.sql, o.params),
      ]);
      return {
        mode,
        money: Number(mr.rows[0].value),
        outstanding: Number(or.rows[0].value),
      };
    }));

    const byMode = Object.fromEntries(runs.map(r => [r.mode, r]));
    // Identity: all == exclude + only (across the whole DB, not just our seeds).
    assert.equal(
      byMode.all.money,
      byMode.exclude.money + byMode.only.money,
      `qMoney identity failed: all=${byMode.all.money} exclude=${byMode.exclude.money} only=${byMode.only.money}`
    );
    assert.equal(
      byMode.all.outstanding,
      byMode.exclude.outstanding + byMode.only.outstanding,
      `qOutstanding identity failed: all=${byMode.all.outstanding} exclude=${byMode.exclude.outstanding} only=${byMode.only.outstanding}`
    );
  } finally {
    if (ids.length) {
      await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
    }
  }
});

after(async () => {
  if (hasDb) {
    const { pool } = require('../db');
    await pool.end();
  }
});
