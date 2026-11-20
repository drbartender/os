require('dotenv').config();

// getProposalDetail under the legal-hold exclusion (spec 2026-11-19 law 1). The
// admin answer with no exclusion is pinned by
// routes/proposals/getOne.detail.test.js; this suite asserts what the
// exclusion changes and nothing more. The held booking is synthetic (added
// through __setLegalHoldIdsForTest) and the held client ids come from
// holdExclusion() over a db that drops the real held ids before it queries.
//
// Shared dev DB (run through scripts/run-suites.js). Fixtures are deleted by
// recorded id in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const { holdExclusion, __setLegalHoldIdsForTest } = require('../legalHold');
const { LEGAL_HOLD_PROPOSAL_IDS } = require('../staleProposalSweep');
const { getProposalDetail } = require('./proposalDetail');

if (process.env.NODE_ENV === 'production') throw new Error('proposalDetail.test.js refuses to run against production');

const RUN = `rd-pd-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const made = { clients: [], proposals: [] };
const fx = {};
const REAL_HELD = new Set(LEGAL_HOLD_PROPOSAL_IDS.map(Number));
const syntheticOnly = { query: (sql, [ids]) => pool.query(sql, [ids.filter((id) => !REAL_HELD.has(id))]) };

async function client(tag) {
  const { rows: [c] } = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id', [`Read ${tag} ${RUN}`, `${RUN}-${tag}@example.test`]);
  made.clients.push(c.id);
  return c.id;
}
async function proposal(clientId, status) {
  const { rows: [p] } = await pool.query(
    "INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid) VALUES ($1, $2, 'birthday-party', 900, 300) RETURNING id",
    [clientId, status]
  );
  made.proposals.push(p.id);
  return p.id;
}

before(async () => {
  fx.held = await client('held');
  fx.heldBooking = await proposal(fx.held, 'confirmed');
  fx.heldOther = await proposal(fx.held, 'sent');
  fx.free = await client('free');
  fx.freeBooking = await proposal(fx.free, 'deposit_paid');
  fx.orphan = await proposal(null, 'draft'); // a proposal with no client
  __setLegalHoldIdsForTest([fx.heldBooking]);
  fx.exclude = await holdExclusion(syntheticOnly);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  await pool.end();
});

test('the held proposal and its client\'s other booking answer null under the exclusion; the admin call still answers both', async () => {
  assert.deepEqual(fx.exclude.clientIds, [fx.held]);
  assert.equal(await getProposalDetail(fx.heldBooking, { exclude: fx.exclude }), null, 'the held proposal');
  assert.equal(await getProposalDetail(fx.heldOther, { exclude: fx.exclude }), null, 'the held client\'s other booking');
  assert.equal(await getProposalDetail(String(fx.heldOther), { exclude: fx.exclude }), null);
  const admin = await getProposalDetail(fx.heldBooking);
  assert.deepEqual([admin.id, admin.legal_hold], [fx.heldBooking, true]);
  assert.deepEqual([(await getProposalDetail(fx.heldOther)).id], [fx.heldOther]);
});

test('a held id answers null under the exclusion even when the caller left it out of the lists (isLegalHold first)', async () => {
  assert.equal(await getProposalDetail(fx.heldBooking, { exclude: { proposalIds: [], clientIds: [] } }), null);
});

test('another booking, and one with no client, answer the same body with or without the exclusion', async () => {
  for (const id of [fx.freeBooking, fx.orphan]) {
    const plain = await getProposalDetail(id);
    const excluded = await getProposalDetail(id, { exclude: fx.exclude });
    assert.deepEqual(excluded, plain);
    assert.equal(excluded.id, id);
    assert.equal(excluded.legal_hold, false);
  }
});

test('under the exclusion an id that does not read as a positive integer is not found; a malformed exclusion throws', async () => {
  for (const id of [`${fx.freeBooking}.0`, `+${fx.freeBooking}`, ` ${fx.freeBooking}`, '0', 'abc', undefined]) {
    assert.equal(await getProposalDetail(id, { exclude: fx.exclude }), null, String(id));
  }
  assert.equal(await getProposalDetail(987654, { exclude: fx.exclude }), null, 'a missing id: the same null');
  await assert.rejects(getProposalDetail(fx.freeBooking, { exclude: { proposalIds: 'all', clientIds: [] } }), TypeError);
});
