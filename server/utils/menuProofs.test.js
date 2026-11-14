process.env.NODE_ENV = 'test';
require('dotenv').config();

// The client menu proof's token life, state and loaders (spec 2026-10-19
// sections 10.6 and 12; lane menu-proof-page). The token life is pure SQL
// evaluated with a pinned NOW (no table needed); the loaders run against
// fixture rows inserted directly, since nothing in the app creates a proof yet.
// The menu proofs block of schema.sql is applied first (additive and
// idempotent, the calcom suite's precedent), so the suite never depends on the
// dev server having restarted onto this code.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

if (process.env.NODE_ENV === 'production') throw new Error('menuProofs.test.js refuses to run against production');

const { pool } = require('../db');
const { chicagoTodayYmd } = require('./businessTime');
const {
  PROOF_STATES, PROOF_IMAGE_STATES, proofLinkEndSql, proofExpiredSql, proofState,
  loadProofByToken, loadLatestProof,
} = require('./menuProofs');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
const PROOF_DDL = SCHEMA_SQL.slice(
  SCHEMA_SQL.indexOf('-- ─── Menu proofs (spec 2026-10-19 sections 10.3 and 10.6) ───'),
  SCHEMA_SQL.indexOf('-- ─── end Menu proofs ───'));

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const proposalIds = [];
let clientId;
let todayYmd;

async function makeProposal({ eventOffsetDays = 10, noDate = false, status = 'confirmed' } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type)
     VALUES ($1, CASE WHEN $2 THEN NULL ELSE $3::date + $4::int END, '18:00', 4, 'America/Chicago', $5, 'corporate')
     RETURNING id`,
    [clientId, noDate, todayYmd, eventOffsetDays, status]);
  proposalIds.push(p.id);
  const { rows: [d] } = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint)
     VALUES ($1, $2, '{}', '{}', '{}') RETURNING id`, [p.id, crypto.randomUUID()]);
  return { proposalId: p.id, draftId: d.id };
}

async function makeProof({ proposalId, draftId }, cols = {}) {
  const c = { version: 2, art_version: 1, email_status: 'sent', sent_at: null, ...cols };
  const { rows: [row] } = await pool.query(
    `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status, sent_at,
                              answer, answer_note, answered_at, superseded_at, withdrawn_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, $9, $10, $11, $12)
     RETURNING id, token`,
    [draftId, proposalId, c.version, c.art_version, `menu-proof/${proposalId}/${crypto.randomUUID()}.jpg`,
      c.email_status, c.sent_at, c.answer || null, c.answer_note || null, c.answered_at || null,
      c.superseded_at || null, c.withdrawn_at || null]);
  return row;
}

before(async () => {
  await pool.query(PROOF_DDL);
  todayYmd = chicagoTodayYmd();
  const { rows: [c] } = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555553344') RETURNING id",
    [`MenuProofs Util ${NONCE}`, `menuproofs-util-${NONCE}@example.com`]);
  clientId = c.id;
});

after(async () => {
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// ── The token life, pure SQL with a pinned NOW ──────────────────────────────

async function linkEnd(eventDate, sentAt) {
  const { rows } = await pool.query(
    `SELECT ${proofLinkEndSql()} AS ends
       FROM (SELECT $1::date AS event_date) p, (SELECT $2::timestamptz AS sent_at) mp`,
    [eventDate, sentAt]);
  return rows[0].ends.toISOString();
}

async function expiredAt(eventDate, sentAt, now) {
  const { rows } = await pool.query(
    `SELECT ${proofExpiredSql({ now: '$3::timestamptz' })} AS expired
       FROM (SELECT $1::date AS event_date) p, (SELECT $2::timestamptz AS sent_at) mp`,
    [eventDate, sentAt, now]);
  return rows[0].expired;
}

const SENT = '2026-11-12T15:00:00Z';

test('token life: the link ends at the Chicago midnight that closes the event day (CST, UTC-6)', async () => {
  assert.equal(await linkEnd('2026-11-20', SENT), '2026-11-21T06:00:00.000Z');
  assert.equal(await expiredAt('2026-11-20', SENT, '2026-11-21T05:59:59Z'), false, 'a second before the end');
  assert.equal(await expiredAt('2026-11-20', SENT, '2026-11-21T06:00:00Z'), true, 'expired at the end itself');
});

test('token life: 11:30 p.m. on the event day is still open though the GMT day is already the next day', async () => {
  // 11:30 p.m. CST on 2026-11-20 is 05:30 GMT on 2026-11-21.
  assert.equal(await expiredAt('2026-11-20', SENT, '2026-11-21T05:30:00Z'), false);
  // A Chicago evening the day before the event, whose GMT day is the event day itself.
  assert.equal(await expiredAt('2026-11-20', SENT, '2026-11-20T02:00:00Z'), false);
  // An evening of the event day after 6 p.m. Chicago: the GMT date is past the event date, the link is open.
  assert.equal(await expiredAt('2026-11-20', SENT, '2026-11-21T01:00:00Z'), false);
});

test('token life: a DST change moves the end with the clock (fall back and spring forward)', async () => {
  // DST ends at 2 a.m. on 2026-11-01: the event day starts on CDT and ends on CST.
  assert.equal(await linkEnd('2026-11-01', SENT), '2026-11-02T06:00:00.000Z');
  assert.equal(await expiredAt('2026-11-01', SENT, '2026-11-02T05:30:00Z'), false, '11:30 p.m. CST on the event day');
  assert.equal(await expiredAt('2026-11-01', SENT, '2026-11-02T06:00:00Z'), true);
  // DST starts at 2 a.m. on 2027-03-14: the day after begins at 05:00 GMT.
  assert.equal(await linkEnd('2027-03-14', SENT), '2027-03-15T05:00:00.000Z');
  assert.equal(await expiredAt('2027-03-14', SENT, '2027-03-15T04:30:00Z'), false, '11:30 p.m. CDT on the event day');
  assert.equal(await expiredAt('2027-03-14', SENT, '2027-03-15T05:00:00Z'), true);
  // A summer event: CDT, UTC-5.
  assert.equal(await linkEnd('2026-07-04', SENT), '2026-07-05T05:00:00.000Z');
});

test('token life: with no event date the link lives 30 days from sent_at', async () => {
  assert.equal(await linkEnd(null, '2026-12-01T12:00:00Z'), '2026-12-31T12:00:00.000Z');
  assert.equal(await expiredAt(null, '2026-12-01T12:00:00Z', '2026-12-31T11:59:59Z'), false);
  assert.equal(await expiredAt(null, '2026-12-01T12:00:00Z', '2026-12-31T12:00:00Z'), true);
});

test('token life: the SQL builders take only safe aliases and NOW() or a timestamptz placeholder', () => {
  assert.match(proofExpiredSql(), /NOW\(\) >= /);
  assert.match(proofExpiredSql({ proof: 'x', proposal: 'y' }), /y\.event_date/);
  assert.match(proofExpiredSql({ proof: 'x', proposal: 'y' }), /x\.sent_at/);
  assert.throws(() => proofExpiredSql({ proof: 'mp; DROP TABLE x' }), /alias/);
  assert.throws(() => proofLinkEndSql({ proposal: 'p.event_date' }), /alias/);
  assert.throws(() => proofExpiredSql({ now: "'2026-01-01'" }), /now/);
});

// ── The state, pure ──────────────────────────────────────────────────────────

test('state: each of the six states from its own row', () => {
  const base = { expired: false, superseded_at: null, withdrawn_at: null, answer: null };
  assert.equal(proofState(base), 'open');
  assert.equal(proofState({ ...base, answer: 'approved' }), 'approved');
  assert.equal(proofState({ ...base, answer: 'changes' }), 'changes');
  assert.equal(proofState({ ...base, superseded_at: new Date() }), 'superseded');
  assert.equal(proofState({ ...base, expired: true }), 'expired');
  assert.equal(proofState({ ...base, withdrawn_at: new Date() }), 'withdrawn');
  assert.deepEqual([...PROOF_STATES], ['open', 'approved', 'changes', 'superseded', 'expired', 'withdrawn']);
  assert.deepEqual([...PROOF_IMAGE_STATES], ['open', 'approved', 'changes']);
});

test('state: precedence is expired, then superseded, then withdrawn, then the answer, then open', () => {
  const at = new Date();
  assert.equal(proofState({ expired: true, superseded_at: at, withdrawn_at: at, answer: 'approved' }), 'expired');
  assert.equal(proofState({ expired: false, superseded_at: at, withdrawn_at: at, answer: 'approved' }), 'superseded');
  assert.equal(proofState({ expired: false, superseded_at: at, withdrawn_at: null, answer: 'changes' }), 'superseded');
  assert.equal(proofState({ expired: false, superseded_at: null, withdrawn_at: at, answer: 'approved' }), 'withdrawn');
  assert.equal(proofState({ expired: true, superseded_at: null, withdrawn_at: null, answer: 'approved' }), 'expired');
});

test('state: an unreadable row fails closed (never open)', () => {
  assert.throws(() => proofState(null));
  assert.throws(() => proofState({ expired: null, superseded_at: null, withdrawn_at: null, answer: null }), /expired/);
  assert.throws(() => proofState({ expired: false, superseded_at: null, withdrawn_at: null, answer: 'maybe' }), /answer/);
});

// ── The loaders, on fixture rows ────────────────────────────────────────────

test('loadProofByToken: each state from the database, with the live expiry', async () => {
  const ev = await makeProposal();
  const now = new Date();
  const cases = [
    [{}, 'open'],
    [{ answer: 'approved', answered_at: now }, 'approved'],
    [{ answer: 'changes', answer_note: 'Swap the Paloma', answered_at: now }, 'changes'],
    [{ superseded_at: now }, 'superseded'],
    [{ withdrawn_at: now }, 'withdrawn'],
  ];
  for (const [cols, state] of cases) {
    const p = await makeProof(ev, cols);
    const row = await loadProofByToken(pool, p.token);
    assert.equal(row.state, state, JSON.stringify(cols));
    assert.equal(row.id, p.id);
    assert.equal(row.proposal_id, ev.proposalId);
    assert.equal(row.expired, false);
  }
  const past = await makeProposal({ eventOffsetDays: -1 });
  const old = await makeProof(past);
  const row = await loadProofByToken(pool, old.token);
  assert.equal(row.expired, true);
  assert.equal(row.state, 'expired', 'an event that ended yesterday in Chicago');
});

test('loadProofByToken: an event today in Chicago is still open; no event date counts 30 days', async () => {
  const today = await makeProposal({ eventOffsetDays: 0 });
  assert.equal((await loadProofByToken(pool, (await makeProof(today)).token)).state, 'open');
  const undated = await makeProposal({ noDate: true });
  const fresh = await makeProof(undated, { sent_at: new Date(Date.now() - 29 * 86400000) });
  const stale = await makeProof(undated, { sent_at: new Date(Date.now() - 31 * 86400000) });
  assert.equal((await loadProofByToken(pool, fresh.token)).state, 'open');
  assert.equal((await loadProofByToken(pool, stale.token)).state, 'expired');
});

test('loadProofByToken: moving the event date moves the end of the link', async () => {
  const ev = await makeProposal({ eventOffsetDays: -1 });
  const p = await makeProof(ev);
  assert.equal((await loadProofByToken(pool, p.token)).state, 'expired');
  await pool.query('UPDATE proposals SET event_date = $2::date + 5 WHERE id = $1', [ev.proposalId, todayYmd]);
  assert.equal((await loadProofByToken(pool, p.token)).state, 'open', 'moved later: open again');
  await pool.query('UPDATE proposals SET event_date = $2::date - 2 WHERE id = $1', [ev.proposalId, todayYmd]);
  assert.equal((await loadProofByToken(pool, p.token)).state, 'expired', 'moved earlier: expired');
});

test('loadProofByToken: null for an unknown token, an archived proposal and a cascaded draft', async () => {
  assert.equal(await loadProofByToken(pool, crypto.randomUUID()), null);
  const archived = await makeProposal({ status: 'archived' });
  assert.equal(await loadProofByToken(pool, (await makeProof(archived)).token), null);
  const gone = await makeProposal();
  const p = await makeProof(gone);
  await pool.query('DELETE FROM menu_drafts WHERE id = $1', [gone.draftId]);
  assert.equal(await loadProofByToken(pool, p.token), null);
});

test('loadProofByToken: refuses a token that is not a UUID before any query', async () => {
  let queried = false;
  const db = { query: async () => { queried = true; return { rows: [] }; } };
  assert.equal(await loadProofByToken(db, 'not-a-uuid'), null);
  assert.equal(await loadProofByToken(db, undefined), null);
  assert.equal(queried, false);
});

test('loadLatestProof: the draft\'s one live proof (superseded_at IS NULL), with its state, or null', async () => {
  const ev = await makeProposal();
  assert.equal(await loadLatestProof(pool, ev.draftId), null, 'no proof yet');
  const older = await makeProof(ev, { version: 2, sent_at: new Date(Date.now() - 3600000) });
  await pool.query('UPDATE menu_proofs SET superseded_at = NOW() WHERE id = $1', [older.id]);
  assert.equal(await loadLatestProof(pool, ev.draftId), null, 'only a superseded proof');
  const newer = await makeProof(ev, { version: 3, answer: 'changes', answer_note: 'x', answered_at: new Date() });
  const latest = await loadLatestProof(pool, ev.draftId);
  assert.equal(latest.id, newer.id);
  assert.equal(latest.version, 3);
  assert.equal(latest.state, 'changes');
  assert.equal(latest.expired, false);
});
