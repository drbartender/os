require('dotenv').config();

// getClientDetail under the legal-hold exclusion (spec 2026-11-19 law 1). The
// admin answer with no exclusion is pinned by routes/clients.detail.test.js;
// this suite asserts what the exclusion changes and nothing more. The held
// booking is synthetic: its id is ADDED through __setLegalHoldIdsForTest, and
// the held client ids come from holdExclusion() over a db that drops the real
// held ids before it queries, so no suite reads the real held row.
//
// Shared dev DB (run through scripts/run-suites.js). Fixtures are deleted by
// recorded id in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');
const { holdExclusion, __setLegalHoldIdsForTest } = require('../legalHold');
const { LEGAL_HOLD_PROPOSAL_IDS } = require('../staleProposalSweep');
const { getClientDetail } = require('./clientDetail');

if (process.env.NODE_ENV === 'production') throw new Error('clientDetail.test.js refuses to run against production');

const RUN = `rd-cd-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
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
  const { rows: [p] } = await pool.query("INSERT INTO proposals (client_id, status, event_type) VALUES ($1, $2, 'birthday-party') RETURNING id", [clientId, status]);
  made.proposals.push(p.id);
  return p.id;
}

before(async () => {
  fx.held = await client('held');
  fx.heldBooking = await proposal(fx.held, 'confirmed');
  fx.heldOther = await proposal(fx.held, 'sent');
  fx.free = await client('free');
  fx.freeA = await proposal(fx.free, 'sent');
  fx.freeB = await proposal(fx.free, 'confirmed');
  __setLegalHoldIdsForTest([fx.heldBooking]);
  fx.exclude = await holdExclusion(syntheticOnly);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  await pool.end();
});

test('the exclusion holds the synthetic booking and its client (holdExclusion over the real SQL)', () => {
  assert.ok(fx.exclude.proposalIds.includes(fx.heldBooking));
  assert.deepEqual(fx.exclude.clientIds, [fx.held]);
});

test('the held client answers null under the exclusion, its every booking with it; the admin call still answers', async () => {
  assert.equal(await getClientDetail(fx.held, { exclude: fx.exclude }), null);
  assert.equal(await getClientDetail(String(fx.held), { exclude: fx.exclude }), null);
  const admin = await getClientDetail(fx.held);
  assert.deepEqual(admin.proposals.map((p) => p.id).sort(), [fx.heldBooking, fx.heldOther].sort());
});

test('another client answers the same body with or without the exclusion', async () => {
  const plain = await getClientDetail(fx.free);
  const excluded = await getClientDetail(fx.free, { exclude: fx.exclude });
  assert.deepEqual(excluded, plain);
  assert.deepEqual(excluded.proposals.map((p) => p.id).sort(), [fx.freeA, fx.freeB].sort());
});

test('a proposal id in the exclusion is left out of a client list it sits on', async () => {
  const detail = await getClientDetail(fx.free, { exclude: { proposalIds: [fx.freeA], clientIds: [] } });
  assert.deepEqual(detail.proposals.map((p) => p.id), [fx.freeB]);
});

test('under the exclusion an id that does not read as a positive integer is not found; a malformed exclusion throws', async () => {
  for (const id of [`${fx.free}.0`, `+${fx.free}`, '0', -1, 'abc', null]) {
    assert.equal(await getClientDetail(id, { exclude: fx.exclude }), null, String(id));
  }
  assert.equal(await getClientDetail(987654, { exclude: fx.exclude }), null, 'a missing id: the same null');
  for (const bad of [{}, { proposalIds: [1] }, { proposalIds: [1], clientIds: ['x'] }, [1, 2], 'all']) {
    await assert.rejects(getClientDetail(fx.free, { exclude: bad }), TypeError, JSON.stringify(bad));
  }
});
