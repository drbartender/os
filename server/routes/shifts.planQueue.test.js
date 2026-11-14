require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { readPrintState, PRINT_STATES } = require('../utils/menuPrintState');
const { loadLatestProof } = require('../utils/menuProofs');
const {
  MENU_TASKS_SQL, menuTaskParams, mapMenuTaskRows, __setMenuTaskDeps, __resetMenuTaskDeps,
} = require('../utils/inbox/readMenuTasks');
const shiftsRouter = require('./shifts');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.planQueue.test.js refuses to run against production');
}

// The admin GET /shifts feed carries the Plan-column facts (2026-08-25):
// shopping_list_status, plan_input_landed, consult_at, menu_done, package_category,
// package_name, menu_with_client and menu_answer_waiting (spec 2026-10-19
// section 14: the print state is held and the latest proof has no answer; held
// and answered, or a change request the Inbox holds open, released or not).
// The menu fixtures below pin both flags, row by row, to menuPrintState's own
// readPrintState and to the Inbox reader's own menu_changes tasks on the same
// rows, so the SQL cannot drift from either rule it restates.
//
// The load-bearing assertion here is the FAN-OUT one. drink_plans.proposal_id
// has an index but no unique constraint, so the obvious `LEFT JOIN drink_plans`
// would duplicate the EVENT ROW once a proposal grew a second plan, silently
// double-listing an event on the admin list. planQueueSql uses a LATERAL with
// ORDER BY id DESC LIMIT 1 instead; this suite proves it.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken;
let clientId, twoPlanPid, twoPlanShift, consultPid, consultShift, menuPid, menuShift;
let hostedPkgId, hostedPid, hostedShift;
// The menu fixtures: label -> { pid, shift }. Every proposal and shift lands in
// these arrays the moment it exists, so a setup that throws halfway is still
// cleaned up.
const M = {};
const menuPids = [];
const menuShifts = [];

async function mkProposal(status, extraCols = '', extraVals = '') {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                            event_timezone, status, event_type, total_price, amount_paid,
                            pricing_snapshot${extraCols})
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago', $2, 'planqueue-fixture',
             1000, 400, '{"addons":[]}'${extraVals})
     RETURNING id`,
    [clientId, status]
  );
  return r.rows[0].id;
}

async function mkShift(proposalId, label) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name,
                         positions_needed, proposal_id)
     VALUES (CURRENT_DATE + 30, '18:00', '22:00', 'open', 'X', $1, '["Bartender"]', $2)
     RETURNING id`,
    [`${label} ${NONCE}`, proposalId]
  );
  return r.rows[0].id;
}

const keyOf = (pid, name) => `menu-print/${pid}/${name}-${NONCE}.jpg`;

// One fixed instant the release and answer times count back from, so a release
// "at" an answer is the same timestamp, not two NOW() calls a few ms apart.
const BASE = new Date().toISOString();

// A menu event (spec 2026-10-19 sections 10.3 and 14): a proposal and its
// shift, a draft at version 5 / art 3 (version moves it on), approved at 5/3
// holding the 'new' key unless approved is false, released as the named key
// (null for none) releasedAgo hours before BASE, the named key live on the
// proposal, and its proofs in send order, oldest first, each sent two hours
// apart and answered answeredAgo hours before BASE; the last unsuperseded one
// is the latest. Key names are 'new', 'old' or 'upload'.
async function mkMenuEvent(label, {
  approved = true, released = null, releasedAgo = 72, live = null, marked = false, version = 5, proofs = [],
} = {}) {
  const pid = await mkProposal('confirmed', ', menu_not_required', `, ${marked ? 'true' : 'false'}`);
  menuPids.push(pid);
  const shift = await mkShift(pid, `Menu-${label}`);
  menuShifts.push(shift);
  M[label] = { pid, shift };
  const key = (name) => (name ? keyOf(pid, name) : null);
  const { rows: [d] } = await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint, version, art_version,
                              approved_version, approved_art_version, approved_print_key, approved_at,
                              released_print_key, released_at, released_via)
     VALUES ($1, gen_random_uuid(), '{}', '{}', '{}', $2, 3,
             CASE WHEN $3::text IS NULL THEN NULL ELSE 5 END, CASE WHEN $3::text IS NULL THEN NULL ELSE 3 END,
             $3, CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() - INTERVAL '1 day' END,
             $4, CASE WHEN $4::text IS NULL THEN NULL ELSE $5::timestamptz - make_interval(hours => $6::int) END,
             CASE WHEN $4::text IS NULL THEN NULL ELSE 'admin' END)
     RETURNING id`,
    [pid, version, approved ? key('new') : null, key(released), BASE, releasedAgo]
  );
  if (live) await pool.query('UPDATE proposals SET menu_print_key = $2 WHERE id = $1', [pid, key(live)]);
  // Older proofs are sent earlier, so the latest by sent_at is the last one listed.
  for (const [i, pr] of proofs.entries()) {
    await pool.query(
      `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status, sent_at,
                                answer, answered_at, withdrawn_at, superseded_at)
       VALUES ($1, $2, $3, $4, $5, 'sent', $10::timestamptz - make_interval(hours => $6::int),
               $7::text, CASE WHEN $7::text IS NULL THEN NULL ELSE $10::timestamptz - make_interval(hours => $11::int) END,
               CASE WHEN $8::boolean THEN NOW() END, CASE WHEN $9::boolean THEN NOW() END)`,
      [d.id, pid, pr.version ?? 5, pr.art ?? 3, `menu-proof/${pid}/${crypto.randomUUID()}.jpg`,
        (proofs.length - i) * 2, pr.answer ?? null, pr.withdrawn === true, pr.superseded === true,
        BASE, pr.answeredAgo ?? 0]
    );
  }
}

// The held rule as the read model applies it (menuDraftRead.printBlock): the
// draft's columns, the latest proof by loadLatestProof, through readPrintState.
const DRAFT_STATE_SQL = `
  SELECT id, version, art_version, approved_version, approved_art_version, approved_print_key,
         approved_planner_image_key, released_print_key, inputs
    FROM menu_drafts WHERE proposal_id = $1`;
async function printStateOf(pid) {
  const { rows: [p] } = await pool.query('SELECT menu_print_key, menu_not_required FROM proposals WHERE id = $1', [pid]);
  const { rows: [draft] } = await pool.query(DRAFT_STATE_SQL, [pid]);
  const latestProof = draft ? await loadLatestProof(pool, draft.id) : null;
  const { state, live } = readPrintState({
    menuPrintKey: p.menu_print_key || null,
    menuNotRequired: p.menu_not_required === true,
    draft: draft || null,
    latestProof,
  });
  return {
    state, live,
    unanswered: Boolean(latestProof) && latestProof.answer === null,
    answered: Boolean(latestProof) && latestProof.answer !== null,
  };
}

// The Inbox's open change request on the same rows: the reader's own query and
// mapper (server/utils/inbox/readMenuTasks.js), its menu_changes tasks by
// proposal id. No legal-hold ids: no fixture is held.
async function openChangeRequestPids() {
  const now = new Date();
  const floor = new Date(Date.parse(BASE) - 7 * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(MENU_TASKS_SQL, menuTaskParams({ floor, now, legalHoldIds: [] }));
  return new Set(mapMenuTaskRows(rows, { now })
    .filter((t) => t.kind === 'menu_changes')
    .map((t) => t.meta.proposalId));
}

before(async () => {
  // The reader reports a row it cannot read to Sentry; nothing here may.
  __setMenuTaskDeps({ sentry: { captureMessage: () => {} } });
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`planqueue-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`PlanQueue Client ${NONCE}`, `planqueue-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  // (1) TWO drink plans on one proposal: the shape the schema permits and the
  // LATERAL exists to survive. Newest (highest id) must win.
  twoPlanPid = await mkProposal('confirmed');
  twoPlanShift = await mkShift(twoPlanPid, 'TwoPlan');
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, client_name, status, shopping_list_status)
     VALUES ($1, $2, 'submitted', 'pending_review'), ($1, $2, 'reviewed', 'approved')`,
    [twoPlanPid, `TwoPlan ${NONCE}`]
  );

  // (2) Consults: one CANCELLED later slot and one live earlier slot. The
  // cancelled one must not win despite being scheduled later.
  consultPid = await mkProposal('deposit_paid');
  consultShift = await mkShift(consultPid, 'Consult');
  await pool.query(
    `INSERT INTO consults (client_id, proposal_id, scheduled_at, status) VALUES
       ($1, $2, NOW() + INTERVAL '3 days', 'scheduled'),
       ($1, $2, NOW() + INTERVAL '9 days', 'cancelled')`,
    [clientId, consultPid]
  );

  // (3) menu_not_required alone must settle menu_done, with no uploaded key.
  menuPid = await mkProposal('confirmed', ', menu_not_required', ", true");
  menuShift = await mkShift(menuPid, 'Menu');

  // (4) A hosted package with a SUBMITTED plan and no list. Hosted never gets
  // a shopping list, so the Plan column reads input-landed off
  // plan_input_landed here instead of off shopping_list_status.
  const pkg = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'PlanQueue Hosted', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [`planqueue-hosted-${NONCE}`]
  );
  hostedPkgId = pkg.rows[0].id;
  hostedPid = await mkProposal('confirmed', ', package_id', `, ${hostedPkgId}`);
  hostedShift = await mkShift(hostedPid, 'Hosted');
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, client_name, status, submitted_at)
     VALUES ($1, $2, 'submitted', NOW())`,
    [hostedPid, `Hosted ${NONCE}`]
  );

  // (5) The menu print states (spec 10.3, 10.7), one event each.
  const OPEN = {};
  // Held, live none: the client's move.
  await mkMenuEvent('heldOpen', { proofs: [OPEN] });
  // Held, the client asked for changes, or said it looks great and the release
  // was refused (Client approved): the owner's move.
  await mkMenuEvent('heldChanges', { proofs: [{ answer: 'changes' }] });
  await mkMenuEvent('heldApproved', { proofs: [{ answer: 'approved' }] });
  // The owner released it before any answer: approved, not held.
  await mkMenuEvent('released', { released: 'new', live: 'new', proofs: [OPEN] });
  // Held, live previous: the older released file keeps menu_done true.
  await mkMenuEvent('besideOlder', {
    released: 'old', live: 'old',
    proofs: [{ version: 4, art: 2, answer: 'approved', superseded: true }, OPEN],
  });
  // The owner's mark or upload withdrew the proof.
  await mkMenuEvent('withdrawn', { proofs: [{ withdrawn: true }] });
  // No proof: a draft never approved, and a v1 approval (live, no release).
  await mkMenuEvent('neverApproved', { approved: false });
  await mkMenuEvent('v1Approved', { live: 'new' });
  // An admin upload live beside an open proof (replaced), and the no-menu mark
  // beside one (not_required): both shapes the routes prevent, pinned anyway.
  await mkMenuEvent('upload', { live: 'upload', proofs: [OPEN] });
  await mkMenuEvent('marked', { marked: true, proofs: [OPEN] });
  // The released file moved on since (edited), and removed by the owner.
  await mkMenuEvent('edited', { version: 6, released: 'new', live: 'new', proofs: [{ answer: 'approved' }] });
  await mkMenuEvent('removed', { released: 'new', proofs: [OPEN] });
  // The latest proof wins: an open one superseded by an answered one, and a
  // latest proof for another pair than the approved one.
  await mkMenuEvent('supersededOpen', { proofs: [{ superseded: true }, { answer: 'changes' }] });
  await mkMenuEvent('otherPair', { proofs: [{ version: 4, art: 2 }] });
  // An answer on a held file is the owner's move (menu_answer_waiting): a
  // change request beside an older released file that keeps menu_done true.
  await mkMenuEvent('changesBesideOlder', {
    released: 'old', live: 'old',
    proofs: [{ version: 4, art: 2, answer: 'approved', superseded: true }, { answer: 'changes' }],
  });
  // A change request sent after the owner released the file: not held, but
  // the Inbox holds it open (menu_changes), so it is still the owner's move.
  await mkMenuEvent('releasedChanges', {
    released: 'new', releasedAgo: 1, live: 'new', proofs: [{ answer: 'changes' }],
  });
  // A release after the change request, or at its very instant, settles it.
  await mkMenuEvent('changesThenRelease', {
    released: 'new', releasedAgo: 0, live: 'new', proofs: [{ answer: 'changes', answeredAgo: 1 }],
  });
  await mkMenuEvent('changesReleasedAtAnswer', {
    released: 'new', releasedAgo: 1, live: 'new', proofs: [{ answer: 'changes', answeredAgo: 1 }],
  });
  // Withdrawn: Close request on a released file, and the owner's upload on a
  // held one.
  await mkMenuEvent('closedRequest', {
    released: 'new', releasedAgo: 1, live: 'new', proofs: [{ answer: 'changes', withdrawn: true }],
  });
  await mkMenuEvent('withdrawnChanges', { proofs: [{ answer: 'changes', withdrawn: true }] });
  // Superseded: the owner approved again after the change request, on a held
  // file and after a release (the change request was on the released 4/2).
  await mkMenuEvent('supersededChanges', { proofs: [{ answer: 'changes', superseded: true }, OPEN] });
  await mkMenuEvent('reapprovedAfterRelease', {
    released: 'old', live: 'old',
    proofs: [{ version: 4, art: 2, answer: 'changes', superseded: true }, OPEN],
  });

  const app = express();
  app.use(express.json());
  app.use('/api/shifts', shiftsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  __resetMenuTaskDeps();
  if (server) await new Promise((r) => server.close(r));
  const pids = [twoPlanPid, consultPid, menuPid, hostedPid, ...menuPids].filter(Boolean);
  const sids = [twoPlanShift, consultShift, menuShift, hostedShift, ...menuShifts].filter(Boolean);
  if (sids.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [sids]);
  if (pids.length) {
    await pool.query('DELETE FROM consults WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM menu_proofs WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM menu_drafts WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [pids]);
  }
  if (hostedPkgId) await pool.query('DELETE FROM service_packages WHERE id = $1', [hostedPkgId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

const rowsFor = (body, id) => body.filter((r) => r.id === id);

test('the admin feed carries every Plan-column field', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const row = rowsFor(r.body, twoPlanShift)[0];
  assert.ok(row, 'the fixture event is listed');
  for (const k of ['shopping_list_status', 'plan_input_landed', 'consult_at', 'menu_done', 'menu_with_client', 'menu_answer_waiting', 'package_category', 'package_bar_type', 'package_name']) {
    assert.ok(k in row, `feed carries ${k}`);
  }
});

test('a proposal with TWO drink plans lists its event ONCE, newest plan winning', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(r.status, 200);
  const rows = rowsFor(r.body, twoPlanShift);
  assert.equal(rows.length, 1, `event must appear once, saw ${rows.length} (LATERAL fan-out guard)`);
  assert.equal(rows[0].shopping_list_status, 'approved', 'the higher-id plan wins');
});

test('consult_at takes the live consult and ignores a cancelled later one', async () => {
  const r = await get('/api/shifts', adminToken);
  const rows = rowsFor(r.body, consultShift);
  assert.equal(rows.length, 1, 'two consults must not duplicate the event row');
  const at = new Date(rows[0].consult_at);
  const days = Math.round((at - Date.now()) / 86400000);
  assert.equal(days, 3, `expected the live 3-day-out consult, got ${rows[0].consult_at}`);
});

test('menu_not_required alone settles menu_done', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = rowsFor(r.body, menuShift)[0];
  assert.equal(row.menu_done, true, 'an explicit not-required flag counts as settled');
});

test('an event with no drink plan and no consult reports nulls, not a missing row', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = rowsFor(r.body, menuShift)[0];
  assert.equal(row.shopping_list_status, null);
  assert.equal(row.consult_at, null);
});

test('a hosted submitted plan reports input landed with no list', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = rowsFor(r.body, hostedShift)[0];
  assert.ok(row, 'the hosted fixture event is listed');
  assert.equal(row.package_category, 'hosted');
  assert.equal(row.package_bar_type, 'full_bar', 'bar_type rides along for the class exception');
  assert.equal(row.plan_input_landed, true, 'submitted_at is the hosted input signal');
  assert.equal(row.shopping_list_status, null, 'hosted never carries a list');
});

test('plan_input_landed is null with no plan and false on a plan never submitted', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(rowsFor(r.body, menuShift)[0].plan_input_landed, null);
  // The two-plan fixture seeds its lists directly with no submitted_at, so the
  // winning plan reads false here; BYOB rows read input off the list anyway.
  assert.equal(rowsFor(r.body, twoPlanShift)[0].plan_input_landed, false);
});

// ─── menu_with_client (spec 2026-10-19 section 14) ─────────────────────────

const menuRow = (body, label) => {
  const rows = rowsFor(body, M[label].shift);
  assert.equal(rows.length, 1, `${label}: the event is listed once`);
  return rows[0];
};

test('menu_with_client is true while a held file waits on an unanswered proof', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(r.status, 200);
  const row = menuRow(r.body, 'heldOpen');
  assert.equal(row.menu_with_client, true);
  assert.equal(row.menu_done, false, 'the held file is not with staff, so menu_done stays false');
});

test('menu_with_client is false once the client answers, changes or looks great', async () => {
  const r = await get('/api/shifts', adminToken);
  for (const label of ['heldChanges', 'heldApproved', 'supersededOpen']) {
    const row = menuRow(r.body, label);
    assert.equal(row.menu_with_client, false, `${label}: the answer hands it back to the owner`);
    assert.equal(row.menu_done, false, `${label}: nothing is with staff`);
  }
});

test('menu_with_client is false once the file is released, even with no answer', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = menuRow(r.body, 'released');
  assert.equal(row.menu_with_client, false);
  assert.equal(row.menu_done, true);
});

test('menu_with_client is true beside an older released file, which keeps menu_done true', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = menuRow(r.body, 'besideOlder');
  assert.equal(row.menu_with_client, true, 'the new proof is still out');
  assert.equal(row.menu_done, true, 'staff still have the older file, so menu_done is unchanged');
});

test('menu_with_client is false for a withdrawn proof', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(menuRow(r.body, 'withdrawn').menu_with_client, false);
});

test('menu_with_client is false with no proof, and with no menu draft at all', async () => {
  const r = await get('/api/shifts', adminToken);
  assert.equal(menuRow(r.body, 'neverApproved').menu_with_client, false);
  assert.equal(menuRow(r.body, 'v1Approved').menu_with_client, false);
  for (const id of [twoPlanShift, menuShift, hostedShift]) {
    assert.equal(rowsFor(r.body, id)[0].menu_with_client, false, `shift ${id}: no draft reads false, never null`);
  }
});

// ─── menu_answer_waiting: an answer on a held file is the owner's move ─────

test('menu_answer_waiting is true for a change request beside an older released file', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = menuRow(r.body, 'changesBesideOlder');
  assert.equal(row.menu_answer_waiting, true, 'the client asked for changes on the held file');
  assert.equal(row.menu_with_client, false);
  assert.equal(row.menu_done, true, 'staff still have the older file, so menu_done is unchanged');
});

test('menu_answer_waiting is true for a change request with no older file', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = menuRow(r.body, 'heldChanges');
  assert.equal(row.menu_answer_waiting, true);
  assert.equal(row.menu_done, false);
});

test('menu_answer_waiting is true for a held file the client approved (Client approved)', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = menuRow(r.body, 'heldApproved');
  assert.equal(row.menu_answer_waiting, true, 'the file still needs the owner\'s Release');
  assert.equal(row.menu_with_client, false);
});

test('menu_answer_waiting is true for a change request sent after a release', async () => {
  const r = await get('/api/shifts', adminToken);
  const row = menuRow(r.body, 'releasedChanges');
  assert.equal(row.menu_answer_waiting, true, 'the Inbox holds the change request open, so the Plan column must too');
  assert.equal(row.menu_with_client, false, 'a released file with a change request has no unanswered proof');
  assert.equal(row.menu_done, true, 'the released file is with staff, so menu_done is unchanged');
});

test('menu_answer_waiting is false once a release at or after the change request settles it', async () => {
  const r = await get('/api/shifts', adminToken);
  for (const label of ['changesThenRelease', 'changesReleasedAtAnswer']) {
    assert.equal(menuRow(r.body, label).menu_answer_waiting, false, `${label}: the release settled it`);
  }
});

test('menu_answer_waiting is false for a change request closed or withdrawn', async () => {
  const r = await get('/api/shifts', adminToken);
  for (const label of ['closedRequest', 'withdrawnChanges']) {
    assert.equal(menuRow(r.body, label).menu_answer_waiting, false, `${label}: withdrawn`);
  }
});

test('menu_answer_waiting is false once a re-approve supersedes the change request', async () => {
  const r = await get('/api/shifts', adminToken);
  for (const label of ['supersededChanges', 'reapprovedAfterRelease']) {
    const row = menuRow(r.body, label);
    assert.equal(row.menu_answer_waiting, false, `${label}: superseded`);
    assert.equal(row.menu_with_client, true, `${label}: the new proof is out with the client`);
  }
});

test('menu_answer_waiting is false after a release with no change request', async () => {
  const r = await get('/api/shifts', adminToken);
  for (const label of ['released', 'edited']) {
    assert.equal(menuRow(r.body, label).menu_answer_waiting, false, label);
  }
});

test('menu_answer_waiting is false while the proof is open, with no proof, and with no draft', async () => {
  const r = await get('/api/shifts', adminToken);
  for (const label of ['heldOpen', 'besideOlder', 'neverApproved', 'v1Approved']) {
    assert.equal(menuRow(r.body, label).menu_answer_waiting, false, label);
  }
  for (const id of [twoPlanShift, menuShift, hostedShift]) {
    assert.equal(rowsFor(r.body, id)[0].menu_answer_waiting, false, `shift ${id}: no draft reads false, never null`);
  }
});

test('both flags are readPrintState\'s held rule and the Inbox\'s open change request on the same rows', async () => {
  const r = await get('/api/shifts', adminToken);
  const openChanges = await openChangeRequestPids();
  const seen = new Set();
  let openSeen = 0;
  for (const label of Object.keys(M)) {
    const ps = await printStateOf(M[label].pid);
    const row = menuRow(r.body, label);
    const held = ps.state === PRINT_STATES.HELD;
    const changesOpen = openChanges.has(M[label].pid);
    seen.add(held ? `held:${ps.live}` : ps.state);
    if (changesOpen) openSeen += 1;
    assert.equal(row.menu_with_client, held && ps.unanswered,
      `${label}: menu_with_client, print state ${ps.state}, unanswered ${ps.unanswered}`);
    assert.equal(row.menu_answer_waiting, (held && ps.answered) || changesOpen,
      `${label}: menu_answer_waiting, print state ${ps.state}, answered ${ps.answered}, Inbox change request ${changesOpen}`);
    assert.ok(!(row.menu_with_client && row.menu_answer_waiting), `${label}: never both`);
  }
  // The reader opens a change request on held and on released files alike, so
  // the comparison is never vacuous on that side either.
  assert.ok(openSeen >= 3, `the Inbox reader opens change requests on the fixtures (saw ${openSeen})`);
  assert.ok(openChanges.has(M.releasedChanges.pid) && openChanges.has(M.heldChanges.pid),
    'the reader opens one on a released file and one on a held file');
  // The fixtures reach every print state, so the pin can never pass on a subset.
  for (const s of ['held:none', 'held:previous', 'approved', 'edited_since_approval', 'replaced', 'removed', 'not_required', 'none']) {
    assert.ok(seen.has(s), `a fixture reaches ${s}`);
  }
});
