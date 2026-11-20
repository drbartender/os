require('dotenv').config();

// runGlobalSearch's legal-hold exclusion (spec 2026-11-19 law 1). The held
// client comes back without the exclusion and is absent with it, and each
// group still fills to its six when a held row would have been among the
// newest, because the exclusion sits in the SQL before the LIMIT. The held
// booking is synthetic (added through __setLegalHoldIdsForTest) and the held
// client ids come from holdExclusion() over a db that drops the real held ids
// before it queries. globalSearch.adminSql.test.js pins the admin search's own
// SQL text; globalSearch.test.js its answers.
//
// Shared dev DB (run through scripts/run-suites.js). Fixtures are deleted by
// recorded id in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { holdExclusion, __setLegalHoldIdsForTest } = require('./legalHold');
const { LEGAL_HOLD_PROPOSAL_IDS } = require('./staleProposalSweep');
const { runGlobalSearch } = require('./globalSearch');

if (process.env.NODE_ENV === 'production') throw new Error('globalSearch.exclusion.test.js refuses to run against production');

const TERM = `zqhold${crypto.randomBytes(4).toString('hex')}`;
const made = { clients: [], proposals: [] };
const fx = { free: [], freeSent: [], freeBooked: [] };
const REAL_HELD = new Set(LEGAL_HOLD_PROPOSAL_IDS.map(Number));
const syntheticOnly = { query: (sql, [ids]) => pool.query(sql, [ids.filter((id) => !REAL_HELD.has(id))]) };

async function client(n, hoursAgo) {
  const { rows: [c] } = await pool.query(
    "INSERT INTO clients (name, email, created_at) VALUES ($1, $2, NOW() - make_interval(hours => $3)) RETURNING id",
    [`Search ${TERM} ${n}`, `${TERM}-${n}@example.test`, hoursAgo]
  );
  made.clients.push(c.id);
  return c.id;
}
async function proposal(clientId, status, hoursAgo) {
  const { rows: [p] } = await pool.query(
    "INSERT INTO proposals (client_id, status, event_type, created_at) VALUES ($1, $2, 'birthday-party', NOW() - make_interval(hours => $3)) RETURNING id",
    [clientId, status, hoursAgo]
  );
  made.proposals.push(p.id);
  return p.id;
}

before(async () => {
  // The held client and both its bookings are the NEWEST rows of each group.
  fx.held = await client('held', 1);
  fx.heldOther = await proposal(fx.held, 'sent', 1);
  fx.heldBooking = await proposal(fx.held, 'confirmed', 1);
  for (let i = 0; i < 7; i += 1) {
    const id = await client(`free${i}`, 10 + i);
    fx.free.push(id);
    fx.freeSent.push(await proposal(id, 'sent', 10 + i));
    fx.freeBooked.push(await proposal(id, 'deposit_paid', 10 + i));
  }
  __setLegalHoldIdsForTest([fx.heldBooking]);
  fx.exclude = await holdExclusion(syntheticOnly);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  await pool.end();
});

const idsOf = (rows) => rows.map((r) => r.id);

test('without the exclusion the held client and both its bookings come back first', async () => {
  const r = await runGlobalSearch(TERM);
  assert.deepEqual(idsOf(r.clients), [fx.held, ...fx.free.slice(0, 5)]);
  assert.deepEqual(idsOf(r.proposals), [fx.heldOther, ...fx.freeSent.slice(0, 5)]);
  assert.deepEqual(idsOf(r.events), [fx.heldBooking, ...fx.freeBooked.slice(0, 5)]);
});

test('with the exclusion they are absent and every group still fills to six', async () => {
  assert.deepEqual(fx.exclude.clientIds, [fx.held]);
  const r = await runGlobalSearch(TERM, { exclude: fx.exclude });
  assert.deepEqual(idsOf(r.clients), fx.free.slice(0, 6));
  assert.deepEqual(idsOf(r.proposals), fx.freeSent.slice(0, 6));
  assert.deepEqual(idsOf(r.events), fx.freeBooked.slice(0, 6));
  const text = JSON.stringify(r);
  assert.ok(!text.includes(`${TERM} held`) && !text.includes(`${TERM}-held`), 'no trace of the held client in the answer');
});

test('an empty exclusion answers exactly what no exclusion does; a malformed one throws', async () => {
  const plain = await runGlobalSearch(TERM);
  assert.deepEqual(await runGlobalSearch(TERM, { exclude: { proposalIds: [], clientIds: [] } }), plain);
  await assert.rejects(runGlobalSearch(TERM, { exclude: { proposalIds: [fx.heldBooking], clientIds: 'all' } }), TypeError);
});
