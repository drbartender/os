require('dotenv').config();

// listProposals' two opt-in options (spec 2026-11-19 laws 1, 4 and 10): the
// amount owed and the day counts (owed), and the legal-hold exclusion. The
// admin list with neither is pinned by routes/proposals/list.response.test.js
// and the filter suites; this one asserts what the options add. The held
// booking is synthetic (added through __setLegalHoldIdsForTest) and the held
// client ids come from holdExclusion() over a db that drops the real held ids
// before it queries.
//
// Shared dev DB (run through scripts/run-suites.js). Fixtures are deleted by
// recorded id in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const { holdExclusion, __setLegalHoldIdsForTest } = require('../legalHold');
const { LEGAL_HOLD_PROPOSAL_IDS } = require('../staleProposalSweep');
const { qOutstanding } = require('../metricsQueries');
const { listProposals, OWED_SQL } = require('./proposalList');

if (process.env.NODE_ENV === 'production') throw new Error('proposalList.test.js refuses to run against production');

const RUN = `rd-pl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const TAG = `OwedPin${crypto.randomBytes(4).toString('hex')}`;
const made = { clients: [], proposals: [] };
const fx = {};
const REAL_HELD = new Set(LEGAL_HOLD_PROPOSAL_IDS.map(Number));
const syntheticOnly = { query: (sql, [ids]) => pool.query(sql, [ids.filter((id) => !REAL_HELD.has(id))]) };
// 21:00 on Nov 19 in Chicago (CST), already Nov 20 in UTC: a count taken on
// the UTC day is one day off from the Chicago one.
const NOW = new Date('2026-11-20T03:00:00Z');
const QUERY = { view: 'all', balance: 'open', search: TAG };

async function client(tag) {
  const { rows: [c] } = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id', [`${TAG} ${tag}`, `${RUN}-${tag}@example.test`]);
  made.clients.push(c.id);
  return c.id;
}
async function booking(clientId, { status = 'deposit_paid', total, paid, due = null, ago }) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, sent_at, accepted_at, event_type, total_price, amount_paid, balance_due_date, created_at)
     VALUES ($1, $2, NOW() - INTERVAL '30 days', NOW() - INTERVAL '29 days', 'wedding-reception', $3, $4, $5, NOW() - $6::interval)
     RETURNING id`,
    [clientId, status, total, paid, due, ago]
  );
  made.proposals.push(p.id);
  return p.id;
}

before(async () => {
  fx.held = await client('held');
  fx.heldBooking = await booking(fx.held, { total: 1000, paid: 100, due: '2026-11-30', ago: '1 hour' });
  fx.heldOther = await booking(fx.held, { status: 'confirmed', total: 800, paid: 0, due: '2026-12-01', ago: '2 hours' });
  fx.free = await client('free');
  fx.overdue = await booking(fx.free, { total: 1200.5, paid: 200.25, due: '2026-11-12', ago: '3 hours' });
  fx.dueToday = await booking(fx.free, { total: 900, paid: 600, due: '2026-11-19', ago: '4 hours' });
  fx.upcoming = await booking(fx.free, { status: 'balance_paid', total: 500, paid: 450, due: '2026-11-25', ago: '5 hours' });
  fx.noDue = await booking(fx.free, { status: 'confirmed', total: 300, paid: 0, ago: '6 hours' });
  fx.paidUp = await booking(fx.free, { total: 400, paid: 400, due: '2026-11-10', ago: '7 hours' });
  __setLegalHoldIdsForTest([fx.heldBooking]);
  fx.exclude = await holdExclusion(syntheticOnly);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  await pool.end();
});

const ids = (list) => list.rows.map((r) => r.id);

test('under the exclusion the held proposal and its client\'s other booking are absent, the rest present', async () => {
  assert.deepEqual(fx.exclude.clientIds, [fx.held]);
  const plain = await listProposals(QUERY, { owed: true, now: NOW });
  assert.deepEqual(ids(plain), [fx.overdue, fx.dueToday, fx.upcoming, fx.heldBooking, fx.heldOther, fx.noDue]);
  const excluded = await listProposals(QUERY, { owed: true, now: NOW, exclude: fx.exclude });
  assert.deepEqual(ids(excluded), [fx.overdue, fx.dueToday, fx.upcoming, fx.noDue]);
  assert.equal(excluded.total, 4, 'the total leaves them out too');
  const admin = await listProposals(QUERY);
  assert.ok(ids(admin).includes(fx.heldBooking) && ids(admin).includes(fx.heldOther), 'the admin list is unchanged');
});

test('the exclusion is in the WHERE, so a page never shows a gap and the envelope counts agree', async () => {
  const first = await listProposals({ ...QUERY, limit: 2, envelope: '1' }, { owed: true, now: NOW, exclude: fx.exclude });
  assert.deepEqual(ids(first), [fx.overdue, fx.dueToday]);
  assert.deepEqual([first.total, first.bucketTotal, first.unviewedTotal], [4, 4, 0]);
  const second = await listProposals({ ...QUERY, limit: 2, page: 2 }, { owed: true, now: NOW, exclude: fx.exclude });
  assert.deepEqual(ids(second), [fx.upcoming, fx.noDue], 'the held rows take no slot on either page');
});

test('owed: the amount is qOutstanding\'s expression in SQL; days past due on the Chicago day; no due date reports none and sorts last', async () => {
  const list = await listProposals(QUERY, { owed: true, now: NOW, exclude: fx.exclude });
  const by = new Map(list.rows.map((r) => [r.id, r]));
  assert.deepEqual([fx.overdue, fx.dueToday, fx.upcoming, fx.noDue].map((id) => [by.get(id).amount_owed, by.get(id).days_past_due]), [
    ['1000.25', 7], ['300.00', 0], ['50.00', -6], ['300.00', null],
  ]);
  assert.equal(list.rows.at(-1).id, fx.noDue);
  // One hour earlier is still Nov 19 in Chicago; a day later moves every count by one.
  const earlier = await listProposals(QUERY, { owed: true, now: new Date('2026-11-20T02:00:00Z'), exclude: fx.exclude });
  assert.equal(earlier.rows.find((r) => r.id === fx.dueToday).days_past_due, 0);
  const nextDay = await listProposals(QUERY, { owed: true, now: new Date('2026-11-20T18:00:00Z'), exclude: fx.exclude });
  assert.equal(nextDay.rows.find((r) => r.id === fx.dueToday).days_past_due, 1);
  assert.ok(qOutstanding({}).sql.includes(OWED_SQL.replace(/p\./g, '')), 'the same expression text as the Outstanding figure');
});

test('without owed the rows carry no new column and keep the admin order', async () => {
  const admin = await listProposals(QUERY);
  for (const r of admin.rows) assert.ok(!('amount_owed' in r) && !('days_past_due' in r));
  assert.deepEqual(ids(admin), [fx.heldBooking, fx.heldOther, fx.overdue, fx.dueToday, fx.upcoming, fx.noDue], 'created_at DESC');
  const sorted = await listProposals({ ...QUERY, sort: 'total', dir: 'asc' }, { owed: true, now: NOW });
  assert.equal(sorted.rows[0].id, fx.noDue, 'an explicit sort still wins under owed: the lowest total, though it has no due date');
});

test('a malformed exclusion throws rather than excluding nothing', async () => {
  for (const bad of [{ proposalIds: [fx.heldBooking] }, { proposalIds: [0], clientIds: [] }, { proposalIds: ['6_00'], clientIds: [] }]) {
    await assert.rejects(listProposals(QUERY, { exclude: bad }), TypeError, JSON.stringify(bad));
  }
});
