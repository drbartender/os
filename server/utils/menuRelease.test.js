process.env.NODE_ENV = 'test';
require('dotenv').config();
// The held print file's release (spec 2026-10-19 section 10.3; lane
// menu-approve-send): releaseHeldPrint's five guards and their reasons, its
// writes on success, Put it back (restoreReleasedPrint) and the v1 stamp,
// against fixture rows on the shared dev DB. Each call runs in its own
// transaction on one pooled client, committed as the routes commit it; every
// row is the suite's own (invented proposals, their drafts and proofs) and is
// removed by id at the end. Nothing here reaches R2, a provider or the email.
//
// Run: node --test server/utils/menuRelease.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (process.env.NODE_ENV === 'production') throw new Error('menuRelease.test.js refuses to run against production');

const { pool } = require('../db');
const { chicagoTodayYmd } = require('./businessTime');
const { __setLegalHoldIdsForTest } = require('./legalHold');
const { releaseHeldPrint, restoreReleasedPrint, stampV1Release } = require('./menuRelease');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const proposalIds = [];
let userId;
let todayYmd;

const keyOf = (id, name) => `menu-print/${id}/${name}-${NONCE}.jpg`;

// A proposal (offset days out, or no date), its draft at 4/2, approved at 4/2
// holding the 'held' key unless approve is false, and a proof of that pair
// unless proof is false.
async function event({ offset = 10, noDate = false, approve = true, proof = true, printKey = null, released = null, marked = false } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (status, event_type, event_date, menu_print_key, menu_not_required)
     VALUES ('confirmed', 'corporate', CASE WHEN $1::boolean THEN NULL ELSE $2::date + $3::int END, $4, $5) RETURNING id`,
    [noDate, todayYmd, offset, null, marked]);
  proposalIds.push(p.id);
  const held = keyOf(p.id, 'held');
  const { rows: [d] } = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint, version, art_version,
                              approved_version, approved_art_version, approved_print_key, approved_at, approved_by,
                              released_print_key, released_at, released_via)
     VALUES ($1, gen_random_uuid(), '{}', '{}', '{}', 4, 2,
             CASE WHEN $2::boolean THEN 4 END, CASE WHEN $2::boolean THEN 2 END, CASE WHEN $2::boolean THEN $3 END,
             CASE WHEN $2::boolean THEN NOW() - INTERVAL '2 days' END, CASE WHEN $2::boolean THEN $4::int END,
             $5, CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() - INTERVAL '5 days' END,
             CASE WHEN $5::text IS NULL THEN NULL ELSE 'admin' END)
     RETURNING id`, [p.id, approve, held, userId, released]);
  if (printKey) await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [p.id, printKey]);
  let proofRow = null;
  if (proof) {
    proofRow = (await pool.query(
      `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status)
       VALUES ($1, $2, 4, 2, $3, 'sent') RETURNING id`, [d.id, p.id, `menu-proof/${p.id}/${crypto.randomUUID()}.jpg`])).rows[0];
  }
  return { proposalId: p.id, draftId: d.id, held, proofId: proofRow && proofRow.id };
}

// fn(client) in one committed transaction, as a route runs it; every
// statement it sends is recorded.
async function tx(fn) {
  const client = await pool.connect();
  const sql = [];
  const real = client.query;
  client.query = function q(text, ...rest) { sql.push(String(text).replace(/\s+/g, ' ').trim()); return real.call(this, text, ...rest); };
  try {
    await real.call(client, 'BEGIN');
    const out = await fn(client);
    await real.call(client, 'COMMIT');
    return { out, sql };
  } catch (err) {
    await real.call(client, 'ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.query = real;
    client.release();
  }
}

const rel = (ev, opts) => tx((c) => releaseHeldPrint(c, { draftId: ev.draftId, proposalId: ev.proposalId, ...opts }));
const restore = (ev, opts) => tx((c) => restoreReleasedPrint(c, { draftId: ev.draftId, proposalId: ev.proposalId, ...opts }));

async function rowsOf(ev) {
  const { rows: [r] } = await pool.query(
    `SELECT p.menu_print_key, p.menu_not_required, d.released_print_key, d.released_at, d.released_by, d.released_via
       FROM proposals p JOIN menu_drafts d ON d.proposal_id = p.id WHERE p.id = $1`, [ev.proposalId]);
  const { rows: log } = await pool.query(
    "SELECT actor_type, actor_id, details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'menu_released' ORDER BY id",
    [ev.proposalId]);
  return { ...r, log };
}

// Nothing moved: the key, the mark, the release stamp, the activity log.
async function assertNothing(ev, { printKey = null, marked = false, released = null } = {}) {
  const r = await rowsOf(ev);
  assert.deepEqual([r.menu_print_key, r.menu_not_required, r.released_print_key], [printKey, marked, released]);
  assert.deepEqual(r.log, []);
}

before(async () => {
  todayYmd = chicagoTodayYmd();
  const { rows: [u] } = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'admin', 'approved') RETURNING id",
    [`menurelease-${NONCE}@example.com`]);
  userId = u.id;
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

// ── Success ─────────────────────────────────────────────────────────────────

test('an admin release posts the held key through setMenuPrintKey, stamps the release and writes the activity row', async () => {
  const ev = await event();
  const { out, sql } = await rel(ev, { via: 'admin', actorId: userId });
  assert.deepEqual(out, { released: true, printKey: ev.held });
  const r = await rowsOf(ev);
  assert.equal(r.menu_print_key, ev.held);
  assert.deepEqual([r.released_print_key, r.released_by, r.released_via], [ev.held, userId, 'admin']);
  assert.ok(r.released_at instanceof Date);
  assert.deepEqual(r.log, [{ actor_type: 'admin', actor_id: userId, details: { draft_id: ev.draftId, version: 4, art_version: 2, via: 'admin' } }]);
  // The draft, then the proposal, FOR UPDATE, before the one key write (setMenuPrintKey's statement).
  const lockDraft = sql.findIndex((s) => /FROM menu_drafts .*FOR UPDATE$/.test(s));
  const lockProposal = sql.findIndex((s) => /FROM proposals .*FOR UPDATE$/.test(s));
  const setKey = sql.findIndex((s) => s.startsWith('UPDATE proposals SET menu_print_key = $1, menu_not_required = false, menu_not_required_by = NULL WHERE id = $2'));
  assert.ok(lockDraft >= 0 && lockDraft < lockProposal && lockProposal < setKey, JSON.stringify(sql));
  assert.equal(sql.filter((s) => /^UPDATE proposals/.test(s)).length, 1, 'one key write');
});

test('a client release stamps via client with no actor', async () => {
  const ev = await event();
  const { out } = await rel(ev, { via: 'client' });
  assert.equal(out.released, true);
  const r = await rowsOf(ev);
  assert.deepEqual([r.menu_print_key, r.released_by, r.released_via], [ev.held, null, 'client']);
  assert.deepEqual(r.log.map((l) => [l.actor_type, l.actor_id, l.details.via]), [['client', null, 'client']]);
});

test('beside the older released file staff still have (live previous), the release replaces it', async () => {
  const older = 'menu-print/0/older.jpg';
  const ev = await event({ released: older, printKey: older });
  const { out } = await rel(ev, { via: 'client' });
  assert.equal(out.released, true);
  const r = await rowsOf(ev);
  assert.deepEqual([r.menu_print_key, r.released_print_key], [ev.held, ev.held]);
});

// ── The five guards, in order ───────────────────────────────────────────────

test('guard 1, legal_hold: refused before any query, writing nothing, for the client and the admin alike', async () => {
  const ev = await event();
  __setLegalHoldIdsForTest([ev.proposalId]);
  try {
    for (const via of ['client', 'admin']) {
      const { out, sql } = await rel(ev, { via, actorId: userId, afterEvent: true });
      assert.deepEqual(out, { released: false, reason: 'legal_hold' });
      assert.deepEqual(sql, [], 'no query ran');
    }
    const { out } = await restore(ev, { actorId: userId });
    assert.deepEqual(out, { released: false, reason: 'legal_hold' });
  } finally {
    __setLegalHoldIdsForTest(null);
  }
  await assertNothing(ev);
});

test('guard 2, marked: the no-menu mark refuses the client and the admin and is never cleared', async () => {
  const ev = await event({ marked: true });
  for (const via of ['client', 'admin']) {
    const { out } = await rel(ev, { via, actorId: userId });
    assert.deepEqual(out, { released: false, reason: 'marked' }, via);
  }
  await assertNothing(ev, { marked: true });
});

test('guard 3, not_held: never approved, already released, no proof, a proof of another pair, a withdrawn proof, another proposal\'s draft', async () => {
  const cases = [
    await event({ approve: false }),
    await event({ proof: false }),
  ];
  const released = await event();
  await pool.query('UPDATE menu_drafts SET released_print_key = approved_print_key, released_at = NOW() WHERE id = $1', [released.draftId]);
  const otherPair = await event();
  await pool.query('UPDATE menu_proofs SET art_version = 1 WHERE id = $1', [otherPair.proofId]);
  const withdrawn = await event();
  await pool.query('UPDATE menu_proofs SET withdrawn_at = NOW() WHERE id = $1', [withdrawn.proofId]);
  for (const ev of [...cases, otherPair, withdrawn]) {
    const { out } = await rel(ev, { via: 'admin', actorId: userId });
    assert.deepEqual(out, { released: false, reason: 'not_held' }, String(ev.proposalId));
    await assertNothing(ev);
  }
  const again = await rel(released, { via: 'client' });
  assert.deepEqual(again.out, { released: false, reason: 'not_held' }, 'already released');
  const stranger = await event();
  const wrong = await tx((c) => releaseHeldPrint(c, { draftId: stranger.draftId, proposalId: released.proposalId, via: 'admin' }));
  assert.deepEqual(wrong.out, { released: false, reason: 'not_held' }, 'a draft that is not this proposal\'s');
  await assertNothing(stranger);
});

test('guard 4, file_changed: an admin upload live is never overwritten', async () => {
  const upload = 'menu-print/0/admin-upload.pdf';
  const ev = await event({ printKey: upload });
  for (const via of ['client', 'admin']) {
    const { out } = await rel(ev, { via, actorId: userId });
    assert.deepEqual(out, { released: false, reason: 'file_changed' }, via);
  }
  await assertNothing(ev, { printKey: upload });
});

test('guard 5, event_passed: a client after the event day always; the admin only without afterEvent; the event day itself releases', async () => {
  const past = await event({ offset: -1 });
  assert.deepEqual((await rel(past, { via: 'client', afterEvent: true })).out, { released: false, reason: 'event_passed' }, 'a client never releases after the day');
  assert.deepEqual((await rel(past, { via: 'admin', actorId: userId })).out, { released: false, reason: 'event_passed' });
  await assertNothing(past);
  assert.deepEqual((await rel(past, { via: 'admin', actorId: userId, afterEvent: true })).out, { released: true, printKey: past.held });
  const today = await event({ offset: 0 });
  assert.equal((await rel(today, { via: 'client' })).out.released, true, 'the event day itself');
  const undated = await event({ noDate: true });
  assert.equal((await rel(undated, { via: 'client' })).out.released, true, 'no event date');
});

test('the guards run in order: the mark ahead of an upload, an upload ahead of the event day', async () => {
  const both = await event({ marked: true, printKey: 'menu-print/0/u.pdf', offset: -3 });
  assert.equal((await rel(both, { via: 'client' })).out.reason, 'marked');
  const uploadPast = await event({ printKey: 'menu-print/0/u2.pdf', offset: -3 });
  assert.equal((await rel(uploadPast, { via: 'client' })).out.reason, 'file_changed');
});

test('a refusal never throws; a via that is neither client nor admin does', async () => {
  const ev = await event();
  await assert.rejects(rel(ev, { via: 'system' }), /via must be client or admin/);
  await assertNothing(ev);
});

// ── Put it back for staff ───────────────────────────────────────────────────

test('restore: the menu\'s own removed released file goes back, the release stamp untouched, a restored activity row', async () => {
  const own = 'menu-print/0/own-released.jpg';
  const ev = await event({ released: own });
  await pool.query('UPDATE menu_proofs SET withdrawn_at = NOW() WHERE id = $1', [ev.proofId]);
  const before = await rowsOf(ev);
  const { out } = await restore(ev, { actorId: userId });
  assert.deepEqual(out, { released: true, printKey: own });
  const r = await rowsOf(ev);
  assert.equal(r.menu_print_key, own);
  assert.deepEqual([r.released_print_key, r.released_at.toISOString(), r.released_via], [own, before.released_at.toISOString(), 'admin']);
  assert.deepEqual(r.log, [{ actor_type: 'admin', actor_id: userId, details: { draft_id: ev.draftId, version: null, art_version: null, via: 'admin', restored: true } }]);
  assert.deepEqual((await restore(ev, { actorId: userId })).out, { released: false, reason: 'not_held' }, 'already back');
});

test('restore: a v1 approval taken down goes back and is stamped released at its approval', async () => {
  const ev = await event({ proof: false });
  const { rows: [d0] } = await pool.query('SELECT approved_at FROM menu_drafts WHERE id = $1', [ev.draftId]);
  const { out } = await restore(ev, { actorId: userId });
  assert.deepEqual(out, { released: true, printKey: ev.held });
  const r = await rowsOf(ev);
  assert.deepEqual([r.menu_print_key, r.released_print_key, r.released_via, r.released_by], [ev.held, ev.held, 'admin', userId]);
  assert.equal(r.released_at.toISOString(), d0.approved_at.toISOString());
  assert.deepEqual(r.log[0].details, { draft_id: ev.draftId, version: 4, art_version: 2, via: 'admin', restored: true });
});

test('restore refuses: a held file (release it instead), nothing to restore, an upload live, the mark, after the event day without afterEvent', async () => {
  assert.deepEqual((await restore(await event(), { actorId: userId })).out, { released: false, reason: 'not_held' }, 'a held file');
  const never = await event({ approve: false, proof: false });
  assert.deepEqual((await restore(never, { actorId: userId })).out, { released: false, reason: 'not_held' });
  const proofed = await event();
  await pool.query('UPDATE menu_proofs SET withdrawn_at = NOW() WHERE id = $1', [proofed.proofId]);
  assert.deepEqual((await restore(proofed, { actorId: userId })).out, { released: false, reason: 'not_held' }, 'an approval with a proof and no release is not v1');
  const upload = await event({ released: 'menu-print/0/r.jpg', printKey: 'menu-print/0/up.pdf', proof: false });
  assert.deepEqual((await restore(upload, { actorId: userId })).out, { released: false, reason: 'file_changed' });
  const marked = await event({ released: 'menu-print/0/m.jpg', marked: true });
  assert.deepEqual((await restore(marked, { actorId: userId })).out, { released: false, reason: 'marked' });
  const past = await event({ released: 'menu-print/0/p.jpg', proof: false, offset: -2 });
  assert.deepEqual((await restore(past, { actorId: userId })).out, { released: false, reason: 'event_passed' });
  assert.equal((await restore(past, { actorId: userId, afterEvent: true })).out.released, true);
});

// ── The v1 stamp ────────────────────────────────────────────────────────────

test('stampV1Release: only a v1 approval whose file is live with no release recorded', async () => {
  const v1 = await event({ proof: false });
  await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [v1.proposalId, v1.held]);
  assert.equal((await tx((c) => stampV1Release(c, v1.draftId))).out, true);
  const r = await rowsOf(v1);
  assert.deepEqual([r.released_print_key, r.released_via, r.released_by, r.menu_print_key], [v1.held, 'admin', userId, v1.held]);
  assert.equal((await tx((c) => stampV1Release(c, v1.draftId))).out, false, 'once');
  const removed = await event({ proof: false });
  assert.equal((await tx((c) => stampV1Release(c, removed.draftId))).out, false, 'not live');
  const replaced = await event({ proof: false, printKey: 'menu-print/0/x.pdf' });
  assert.equal((await tx((c) => stampV1Release(c, replaced.draftId))).out, false, 'an upload is live');
  assert.deepEqual((await rowsOf(v1)).log, [], 'the stamp writes no activity row');
});
