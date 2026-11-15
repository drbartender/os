const NODE_ENV_AT_LOAD = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
// server/utils/menuAutoStart.test.js
'use strict';
// The drink plan submit's bar menu step (spec 2026-10-19 sections 8 and 15;
// plan 2026-11-03 lanes menu-no-menu-mark and menu-auto-start).
// The no-menu mark: triggerMenuAutoStart(planId) marks a Skip the Menu submit
// as needing no printed menu with by planner and its activity row, and
// withdraws the open proof as the admin's mark does; a later Custom or
// Standard submit clears only a planner mark; a print key, an archived
// proposal and the legal-hold proposal are never marked, and a print key logs
// the overridden Skip the Menu; an admin's Undo stands; only an explicit
// menuStyle counts (the legacy customMenuDesign is no choice).
// The auto-start: a Custom or Standard submit on a booked, current, unheld
// event with no draft, no print file and no mark starts ONE draft through
// startGeneration, guarded by the menu_auto_starts primary key, and stores
// the run, or the refusal's code and sentence, on the guard row; every 8.2
// skip starts and records nothing; the trigger swallows and reports its own
// failure; and the real submit route fires it after its response, holding no
// submit client.
//
// Nothing paid and nothing remote is reached: NODE_ENV is test from the first
// line (the provider wrappers refuse a real call), the job's runGeneration is
// replaced in require.cache by a recorder before anything loads it (so no run
// ever draws or writes), the provider keys are fake when a test sets them,
// and global fetch is a tripwire. startGeneration passes through to the real
// one unless a case names an override (the two refusals no real path here can
// raise: Gemini not set up beside the Gemini default, and an unexpected error).
// Real dev DB rows, nonce-suffixed, every one deleted in after(), the ledger
// rows a start reserves first (they outlive a proposal). Held ids are
// synthetic, added through __setLegalHoldIdsForTest; no test reads or writes
// the real held proposal or any real client. Sentry is a fake module placed in
// require.cache before anything loads it. The module under test is required
// lazily inside each case, so on a tree without it every case fails on its
// own rather than the whole file failing to load. Run it through
// scripts/run-suites.js, never a bare node --test.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const Module = require('node:module');
const express = require('express');

if (NODE_ENV_AT_LOAD === 'production') {
  throw new Error('menuAutoStart.test.js refuses to run against production');
}

// ── Sentry: a fake module, so a reported failure is observable ──────────────
const sentryCalls = [];
const sentryPath = require.resolve('@sentry/node');
const savedSentry = require.cache[sentryPath];
{
  const m = new Module(sentryPath);
  m.filename = sentryPath;
  m.loaded = true;
  m.exports = { captureException: (err, ctx) => { sentryCalls.push({ err, ctx }); }, captureMessage: () => {} };
  require.cache[sentryPath] = m;
}

// ── The job: recorded, never run ────────────────────────────────────────────
const jobPath = require.resolve('./menuArtJob');
const realJob = require('./menuArtJob');
const queuedRuns = [];
require.cache[jobPath].exports = {
  ...realJob,
  runGeneration: async (args) => { queuedRuns.push(args); },
  runPieceReroll: async () => { throw new Error('menuAutoStart.test: nothing re-rolls'); },
};

// ── startGeneration: the real one, unless a case names an override ──────────
const genPath = require.resolve('../routes/proposals/menuDraftGenerate');
const realGen = require('../routes/proposals/menuDraftGenerate');
const startCalls = [];
let startOverride = null;
require.cache[genPath].exports = {
  ...realGen,
  startGeneration: (args) => { startCalls.push(args); return (startOverride || realGen.startGeneration)(args); },
};

// ── The Inbox cache: every invalidate is counted ────────────────────────────
const inboxCache = require('./inbox/cache');
const realInvalidate = inboxCache.invalidate;
let invalidations = 0;
inboxCache.invalidate = () => { invalidations += 1; return realInvalidate(); };

const { pool } = require('../db');
const { AppError } = require('./errors');
const { __setLegalHoldIdsForTest } = require('./legalHold');
const { chicagoTodayYmd } = require('./businessTime');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const auto = () => require('./menuAutoStart');
// The provider and cap settings a case may change, restored after each.
const ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'MENU_ART_DAILY_IMAGE_CAP', 'MENU_ART_DAILY_TEXT_CAP',
  'MENU_ART_TEXT_MODEL', 'SENTRY_DSN_SERVER', 'TZ'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let realFetch;
let tripwire = 0;

let clientId;
const proposalIds = [];
let server;
let baseUrl;

// One proposal and its one plan. `proposal` overrides columns; `plan` sets the
// plan's status and selections.
async function seed({ status = 'confirmed', printKey = null, notRequired = false, by = null,
  selections = { menuStyle: 'none' }, planStatus = 'submitted' } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
                            status, event_type, menu_print_key, menu_not_required, menu_not_required_by)
     VALUES ($1, CURRENT_DATE + 20, '18:00', 4, 'America/Chicago', $2, 'birthday-party', $3, $4, $5)
     RETURNING id`,
    [clientId, status, printKey, notRequired, by]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email, planner_version)
     VALUES ($1, $2, $3::jsonb, $4, $5, 1) RETURNING id, token`,
    [proposalId, planStatus, JSON.stringify(selections), `NoMenu Test ${NONCE}`, `nomenu-${NONCE}@example.com`]
  );
  return { proposalId, planId: dp.rows[0].id, token: dp.rows[0].token };
}

async function mark(proposalId) {
  return (await pool.query(
    'SELECT menu_not_required, menu_not_required_by FROM proposals WHERE id = $1', [proposalId])).rows[0];
}

async function activity(proposalId) {
  return (await pool.query(
    `SELECT action, actor_type, details FROM proposal_activity_log
      WHERE proposal_id = $1 AND action IN ('menu_not_required', 'menu_not_required_skipped') ORDER BY id`, [proposalId])).rows;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (url) => { tripwire += 1; return Promise.reject(new Error(`network tripwire: ${String(url)}`)); };
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550142') RETURNING id",
    [`NoMenu Test ${NONCE}`, `nomenu-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const drinkPlansRouter = require('../routes/drinkPlans');
  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

// Every case starts with no provider key (the dev box's state), the default
// words model, today's caps, no Sentry DSN and nothing recorded.
beforeEach(() => {
  sentryCalls.length = 0;
  queuedRuns.length = 0;
  startCalls.length = 0;
  startOverride = null;
  invalidations = 0;
  tripwire = 0;
  __setLegalHoldIdsForTest([]);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined || k.endsWith('_API_KEY') || k.startsWith('MENU_ART_') || k === 'SENTRY_DSN_SERVER') delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

after(async () => {
  __setLegalHoldIdsForTest([]);
  // Let the submit tail's fire-and-forget work (shopping list, the mark, the auto-start) settle.
  await new Promise((r) => setTimeout(r, 400));
  // A start's reservations outlive their proposal (ON DELETE SET NULL): first.
  if (proposalIds.length) await pool.query('DELETE FROM menu_art_calls WHERE proposal_id = ANY($1::int[])', [proposalIds]);
  for (const pid of proposalIds) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [pid]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [pid]);
    // Its draft, pieces, proofs and guard row go with it (ON DELETE CASCADE).
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = realFetch;
  inboxCache.invalidate = realInvalidate;
  require.cache[jobPath].exports = realJob;
  require.cache[genPath].exports = realGen;
  if (savedSentry) require.cache[sentryPath] = savedSentry; else delete require.cache[sentryPath];
  await pool.end();
  assert.equal(tripwire, 0, 'a request reached global fetch');
});

test('Skip the Menu marks the event, by planner, with one menu_not_required activity row', async () => {
  const fx = await seed({ selections: { menuStyle: 'none' } });
  await auto().triggerMenuAutoStart(fx.planId);
  assert.deepEqual(await mark(fx.proposalId), { menu_not_required: true, menu_not_required_by: 'planner' });
  assert.deepEqual(await activity(fx.proposalId), [
    { action: 'menu_not_required', actor_type: 'client', details: { by: 'planner' } },
  ]);
  // A second submit finds it marked: no second row.
  await auto().triggerMenuAutoStart(fx.planId);
  assert.equal((await activity(fx.proposalId)).length, 1);
});

test('Skip the Menu leaves an admin mark as the admin set it, and writes no row', async () => {
  const fx = await seed({ notRequired: true, by: 'admin', selections: { menuStyle: 'none' } });
  await auto().triggerMenuAutoStart(fx.planId);
  assert.deepEqual(await mark(fx.proposalId), { menu_not_required: true, menu_not_required_by: 'admin' });
  assert.deepEqual(await activity(fx.proposalId), []);
});

test('a later Custom or Standard submit clears a planner mark and leaves an admin mark', async () => {
  for (const style of ['custom', 'house']) {
    const planner = await seed({ notRequired: true, by: 'planner', selections: { menuStyle: style } });
    await auto().triggerMenuAutoStart(planner.planId);
    assert.deepEqual(await mark(planner.proposalId), { menu_not_required: false, menu_not_required_by: null }, `${style} clears a planner mark`);

    const admin = await seed({ notRequired: true, by: 'admin', selections: { menuStyle: style } });
    await auto().triggerMenuAutoStart(admin.planId);
    assert.deepEqual(await mark(admin.proposalId), { menu_not_required: true, menu_not_required_by: 'admin' }, `${style} leaves an admin mark`);

    // A mark from before provenance was stored (by null) reads as the admin's.
    const legacy = await seed({ notRequired: true, by: null, selections: { menuStyle: style } });
    await auto().triggerMenuAutoStart(legacy.planId);
    assert.deepEqual(await mark(legacy.proposalId), { menu_not_required: true, menu_not_required_by: null }, `${style} leaves an unattributed mark`);
  }
});

test('a print key: no mark, but one activity row records the Skip the Menu the print file overrides', async () => {
  const fx = await seed({ printKey: `menu-print/nomenu-${NONCE}/x.pdf`, selections: { menuStyle: 'none' } });
  await auto().triggerMenuAutoStart(fx.planId);
  assert.deepEqual(await mark(fx.proposalId), { menu_not_required: false, menu_not_required_by: null });
  assert.deepEqual(await activity(fx.proposalId), [
    // Its own action name, so the timeline never reads it as a mark.
    { action: 'menu_not_required_skipped', actor_type: 'client', details: { by: 'planner', mark: 'skipped', reason: 'print_file' } },
  ]);
  // An archived proposal with a key gets neither.
  const archived = await seed({ status: 'archived', printKey: `menu-print/nomenu-${NONCE}/y.pdf`, selections: { menuStyle: 'none' } });
  await auto().triggerMenuAutoStart(archived.planId);
  assert.deepEqual(await activity(archived.proposalId), []);
  // A Custom submit over a key records nothing.
  const custom = await seed({ printKey: `menu-print/nomenu-${NONCE}/z.pdf`, selections: { menuStyle: 'custom' } });
  await auto().triggerMenuAutoStart(custom.planId);
  assert.deepEqual(await activity(custom.proposalId), []);
});

test("an admin's Undo stands: Skip the Menu never re-marks a row the admin cleared", async () => {
  const fx = await seed({ notRequired: false, by: 'admin', selections: { menuStyle: 'none' } });
  await auto().triggerMenuAutoStart(fx.planId);
  assert.deepEqual(await mark(fx.proposalId), { menu_not_required: false, menu_not_required_by: 'admin' });
  // The client's choice is still recorded, with why it did not land.
  assert.deepEqual(await activity(fx.proposalId), [
    { action: 'menu_not_required_skipped', actor_type: 'client', details: { by: 'planner', mark: 'skipped', reason: 'admin' } },
  ]);
});

test('an archived proposal is skipped, marked or cleared', async () => {
  const none = await seed({ status: 'archived', selections: { menuStyle: 'none' } });
  await auto().triggerMenuAutoStart(none.planId);
  assert.deepEqual(await mark(none.proposalId), { menu_not_required: false, menu_not_required_by: null });
  assert.deepEqual(await activity(none.proposalId), []);
  const custom = await seed({ status: 'archived', notRequired: true, by: 'planner', selections: { menuStyle: 'custom' } });
  await auto().triggerMenuAutoStart(custom.planId);
  assert.deepEqual(await mark(custom.proposalId), { menu_not_required: true, menu_not_required_by: 'planner' });
});

test('the legal-hold proposal is skipped before its row is read or written (money law 15)', async () => {
  const none = await seed({ selections: { menuStyle: 'none' } });
  const custom = await seed({ notRequired: true, by: 'planner', selections: { menuStyle: 'custom' } });
  __setLegalHoldIdsForTest([none.proposalId, custom.proposalId]);
  const seen = [];
  const realQuery = pool.query;
  const realConnect = pool.connect;
  pool.query = function watched(text, ...rest) { seen.push(String(text)); return realQuery.call(this, text, ...rest); };
  // pg's own pool.query checks a client out through connect(callback); that
  // path is already watched above, so it passes straight through.
  pool.connect = async function watchedConnect(cb) {
    if (typeof cb === 'function') return realConnect.call(pool, cb);
    const c = await realConnect.call(pool);
    const q = c.query;
    return Object.assign(Object.create(c), {
      query: (text, ...rest) => { seen.push(String(text)); return q.call(c, text, ...rest); },
      release: (...a) => c.release(...a),
    });
  };
  try {
    await auto().triggerMenuAutoStart(none.planId);
    await auto().triggerMenuAutoStart(custom.planId);
  } finally {
    pool.query = realQuery;
    pool.connect = realConnect;
    __setLegalHoldIdsForTest([]);
  }
  assert.ok(seen.every((sql) => !/\bproposals\b/.test(sql) && !/proposal_activity_log/.test(sql)),
    'no statement names proposals or the activity log');
  assert.deepEqual(await mark(none.proposalId), { menu_not_required: false, menu_not_required_by: null });
  assert.deepEqual(await mark(custom.proposalId), { menu_not_required: true, menu_not_required_by: 'planner' });
  assert.deepEqual(await activity(none.proposalId), []);
});

test('only an explicit menuStyle counts: the legacy customMenuDesign with no menuStyle is no choice', async () => {
  const off = await seed({ selections: { customMenuDesign: false } });
  await auto().triggerMenuAutoStart(off.planId);
  assert.deepEqual(await mark(off.proposalId), { menu_not_required: false, menu_not_required_by: null });
  assert.deepEqual(await activity(off.proposalId), []);

  const on = await seed({ notRequired: true, by: 'planner', selections: { customMenuDesign: true } });
  await auto().triggerMenuAutoStart(on.planId);
  assert.deepEqual(await mark(on.proposalId), { menu_not_required: true, menu_not_required_by: 'planner' });

  // An explicit menuStyle decides, whatever the legacy flag says.
  const both = await seed({ notRequired: true, by: 'planner', selections: { menuStyle: 'custom', customMenuDesign: false } });
  await auto().triggerMenuAutoStart(both.planId);
  assert.deepEqual(await mark(both.proposalId), { menu_not_required: false, menu_not_required_by: null });

  // No choice at all changes nothing.
  const blank = await seed({ notRequired: true, by: 'planner', selections: {} });
  await auto().triggerMenuAutoStart(blank.planId);
  assert.deepEqual(await mark(blank.proposalId), { menu_not_required: true, menu_not_required_by: 'planner' });
});

test('the trigger swallows its own failure and reports it to the console and Sentry', async () => {
  const fx = await seed({ selections: { menuStyle: 'none' } });
  process.env.SENTRY_DSN_SERVER = 'https://public@sentry.invalid/1';
  const boom = new Error('menuAutoStart.test: the database is down');
  const realQuery = pool.query;
  const realConnect = pool.connect;
  pool.query = async () => { throw boom; };
  pool.connect = async () => { throw boom; };
  const errors = [];
  const realError = console.error;
  console.error = (...a) => { errors.push(a); };
  let returned;
  try {
    returned = auto().triggerMenuAutoStart(fx.planId);
    await returned;
  } finally {
    pool.query = realQuery;
    pool.connect = realConnect;
    console.error = realError;
  }
  // Each step reports its own failure: the mark, then the auto-start that still ran.
  assert.equal(sentryCalls.length, 2, 'one Sentry capture per step');
  assert.ok(sentryCalls.every((c) => c.err === boom && c.ctx.extra.planId === fx.planId));
  assert.deepEqual(sentryCalls.map((c) => c.ctx.extra.step), ['mark', 'auto_start']);
  assert.ok(errors.length >= 1, 'a console line');
  assert.deepEqual(await mark(fx.proposalId), { menu_not_required: false, menu_not_required_by: null });
  // No plan id is a no-op that never touches the database.
  assert.equal(await auto().triggerMenuAutoStart(null), undefined);
});

test('the submit route: a Skip the Menu submit marks the event after it answers', async () => {
  const fx = await seed({ planStatus: 'draft', selections: {} });
  const res = await request('PUT', `/api/drink-plans/t/${fx.token}`, { status: 'submitted', selections: { menuStyle: 'none' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  let m;
  for (let i = 0; i < 40; i += 1) {
    m = await mark(fx.proposalId);
    if (m.menu_not_required) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(m, { menu_not_required: true, menu_not_required_by: 'planner' });
  assert.equal((await activity(fx.proposalId)).length, 1);
});

// Carried from the menu-approve-send review (plan lane menu-auto-start): the
// planner's own Skip the Menu mark withdraws the draft's open proof exactly as
// the admin's mark does (menuProofs.withdrawLatestProof, unanswered only), in
// the mark's own transaction, so a Looks great can no longer be recorded under
// the mark and released by nothing. A proof the client already answered
// stays as it is; a Skip the Menu that does not land withdraws nothing.
test('Skip the Menu withdraws the open proof beside a held file, as the admin mark does; an answered proof stays', async () => {
  const proofOf = async (fx, answer = null) => {
    const d = (await pool.query(
      `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint, version, art_version,
                                approved_version, approved_art_version, approved_print_key, approved_at)
       VALUES ($1, gen_random_uuid(), '{}', '{"words_status":"done"}', '{}', 3, 1, 3, 1, $2, NOW()) RETURNING id`,
      [fx.proposalId, `menu-print/${fx.proposalId}/${crypto.randomUUID()}.jpg`])).rows[0].id;
    const p = (await pool.query(
      `INSERT INTO menu_proofs (draft_id, proposal_id, version, art_version, r2_key, email_status, answer, answered_at)
       VALUES ($1, $2, 3, 1, $3, 'sent', $4::text, CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
      [d, fx.proposalId, `menu-proof/${fx.proposalId}/${crypto.randomUUID()}.jpg`, answer])).rows[0].id;
    return p;
  };
  const withdrawn = async (proofId) => (await pool.query('SELECT withdrawn_at FROM menu_proofs WHERE id = $1', [proofId])).rows[0].withdrawn_at;

  const open = await seed({ selections: { menuStyle: 'none' } });
  const openProof = await proofOf(open);
  await auto().triggerMenuAutoStart(open.planId);
  assert.deepEqual(await mark(open.proposalId), { menu_not_required: true, menu_not_required_by: 'planner' });
  assert.ok((await withdrawn(openProof)) instanceof Date, 'the open proof is withdrawn with the mark');

  const changes = await seed({ selections: { menuStyle: 'none' } });
  const changesProof = await proofOf(changes, 'changes');
  await auto().triggerMenuAutoStart(changes.planId);
  assert.equal((await mark(changes.proposalId)).menu_not_required, true);
  assert.equal(await withdrawn(changesProof), null, 'a change request stays, as under the admin mark');

  // An admin's Undo stands: the Skip the Menu does not land and withdraws nothing.
  const undone = await seed({ notRequired: false, by: 'admin', selections: { menuStyle: 'none' } });
  const undoneProof = await proofOf(undone);
  await auto().triggerMenuAutoStart(undone.planId);
  assert.equal((await mark(undone.proposalId)).menu_not_required, false);
  assert.equal(await withdrawn(undoneProof), null, 'no mark, no withdraw');
});

// ── The auto-start (spec 2026-10-19 section 8; plan lane menu-auto-start) ───

// YYYY-MM-DD plus n calendar days, on the text alone (spec 8.2: never a JS Date of an event date).
function ymdPlus(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const DRINKS = ['Basil Smash', 'Paloma', 'Spiced Pear Fizz'].map((n) => `${n} ${NONCE}`);

// One proposal and its submitted plan, set for an auto-start: booked, twenty
// days out in Chicago, a plain house card (a celebration of life, so no key
// and no image is needed), with drinks. Every column can be moved.
async function seedAuto({ status = 'confirmed', date = ymdPlus(chicagoTodayYmd(), 20), eventType = 'celebration-of-life',
  style = 'house', drinks = DRINKS.slice(0, 2), extra = {}, printKey = null, notRequired = false, by = null, planStatus = 'submitted' } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
                            status, event_type, menu_print_key, menu_not_required, menu_not_required_by)
     VALUES ($1, $2::date, '18:00', 4, 'America/Chicago', $3, $4, $5, $6, $7) RETURNING id`,
    [clientId, date, status, eventType, printKey, notRequired, by]);
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const plan = await addPlan(proposalId, { style, drinks, extra, planStatus });
  return { proposalId, planId: plan.id, token: plan.token };
}

async function addPlan(proposalId, { style = 'house', drinks = DRINKS.slice(0, 2), extra = {}, planStatus = 'submitted' } = {}) {
  const selections = { ...(style ? { menuStyle: style } : {}), customCocktails: drinks, ...extra };
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email, planner_version)
     VALUES ($1, $2, $3::jsonb, $4, $5, 1) RETURNING id, token`,
    [proposalId, planStatus, JSON.stringify(selections), `NoMenu Test ${NONCE}`, `nomenu-${NONCE}@example.com`]);
  return dp.rows[0];
}

const guardOf = async (proposalId) => (await pool.query('SELECT * FROM menu_auto_starts WHERE proposal_id = $1', [proposalId])).rows[0] || null;
const draftOf = async (proposalId) => (await pool.query('SELECT * FROM menu_drafts WHERE proposal_id = $1', [proposalId])).rows[0] || null;
const ledgerOf = async (proposalId) => (await pool.query(
  'SELECT kind, piece_key, status, provider FROM menu_art_calls WHERE proposal_id = $1 ORDER BY id', [proposalId])).rows;
async function openCount(kind) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM menu_art_calls
      WHERE kind = $1 AND status <> 'released' AND created_at > NOW() - interval '24 hours'`, [kind]);
  return rows[0].n;
}
const START_FAILED = "The menu couldn't be started. Generate it from the event page.";
const CAPPED = "Today's menu art limit is reached. Generate it from the event page tomorrow.";

test('auto-start: a Standard Menu submit starts one plain house draft, stores its run on the guard row and queues the job once', async () => {
  const fx = await seedAuto();
  await auto().triggerMenuAutoStart(fx.planId);
  const draft = await draftOf(fx.proposalId);
  assert.ok(draft, 'a draft started');
  const guard = await guardOf(fx.proposalId);
  assert.deepEqual([guard.plan_id, guard.draft_id, guard.run_id, guard.error_code, guard.error_sentence],
    [fx.planId, draft.id, draft.run_id, null, null]);
  assert.ok(guard.attempted_at instanceof Date);
  assert.deepEqual(queuedRuns, [{ draftId: draft.id, runId: draft.run_id, proposalId: fx.proposalId }], 'the job, exactly as the route queues it');
  assert.equal(startCalls.length, 1, 'through startGeneration, the one Generate');
  // The defaults validateGenerateInputs gives, the decided look, the default image model (no Gemini key: OpenAI).
  assert.deepEqual([draft.inputs.image_model, draft.inputs.look, draft.inputs.planner_image_role, draft.inputs.reference_source,
    draft.inputs.art_direction, draft.inputs.drb_mark], ['openai', 'house', 'logo', 'none', '', true]);
  assert.deepEqual(await ledgerOf(fx.proposalId), [], 'a plain house card reserves nothing');
  assert.ok(invalidations >= 1, 'the Inbox cache is cleared');
  assert.deepEqual(sentryCalls, []);
});

test('auto-start: the default image model is Gemini when its key is set; a custom look reserves the words and the drawings', async () => {
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  const birthday = await seedAuto({ eventType: 'birthday-party' });
  await auto().triggerMenuAutoStart(birthday.planId);
  const house = await draftOf(birthday.proposalId);
  assert.deepEqual([house.inputs.image_model, house.inputs.look], ['gemini', 'house']);
  assert.deepEqual(await ledgerOf(birthday.proposalId), [{ kind: 'image', piece_key: 'background', status: 'reserved', provider: 'gemini' }]);

  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  const custom = await seedAuto({ style: 'custom', eventType: 'birthday-party', extra: { menuTheme: 'Garden party in sage and gold' } });
  await auto().triggerMenuAutoStart(custom.planId);
  const draft = await draftOf(custom.proposalId);
  assert.deepEqual([draft.inputs.image_model, draft.inputs.look], ['gemini', 'custom']);
  const ledger = await ledgerOf(custom.proposalId);
  assert.deepEqual(ledger.map((r) => [r.kind, r.provider]), [['text', 'anthropic'], ['image', 'gemini'], ['image', 'gemini'], ['image', 'gemini']],
    'the words on Claude, then the background and both drinks on Gemini');
  assert.equal((await guardOf(custom.proposalId)).run_id, draft.run_id);
  assert.equal(queuedRuns.length, 2);
});

test('auto-start: each 8.2 skip starts nothing and records nothing', async () => {
  const today = chicagoTodayYmd();
  const cases = {
    'Skip the Menu': await seedAuto({ style: 'none' }),
    'no menu choice': await seedAuto({ style: null }),
    'a proposal sent, not booked': await seedAuto({ status: 'sent' }),
    'a refunded booking demoted to accepted': await seedAuto({ status: 'accepted' }),
    'a draft proposal': await seedAuto({ status: 'draft' }),
    archived: await seedAuto({ status: 'archived' }),
    'an event yesterday in Chicago': await seedAuto({ date: ymdPlus(today, -1) }),
    'a print file': await seedAuto({ printKey: `menu-print/auto-${NONCE}/x.pdf` }),
    'the admin mark': await seedAuto({ notRequired: true, by: 'admin' }),
  };
  const drafted = await seedAuto();
  await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint)
     VALUES ($1, gen_random_uuid(), '{}', '{"words_status":"done"}', '{}')`, [drafted.proposalId]);
  cases['a draft already'] = drafted;
  const orphan = (await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email, planner_version)
     VALUES (NULL, 'submitted', $1::jsonb, $2, $3, 1) RETURNING id`,
    [JSON.stringify({ menuStyle: 'house', customCocktails: DRINKS }), `NoMenu Test ${NONCE}`, `nomenu-${NONCE}@example.com`])).rows[0].id;
  try {
    for (const [label, fx] of Object.entries(cases)) {
      const before = (await draftOf(fx.proposalId)) || null;
      await auto().triggerMenuAutoStart(fx.planId);
      assert.equal(await guardOf(fx.proposalId), null, `${label}: no guard row`);
      assert.deepEqual(await draftOf(fx.proposalId), before, `${label}: no draft started or changed`);
    }
    await auto().triggerMenuAutoStart(orphan);
    assert.deepEqual([startCalls.length, queuedRuns.length], [0, 0], 'startGeneration never ran');
    assert.deepEqual(sentryCalls, []);
  } finally {
    await pool.query('DELETE FROM drink_plans WHERE id = $1', [orphan]);
  }
});

test('auto-start: dates compare as text, so an event today in Chicago starts on any host zone, and one with no date starts', async () => {
  // A host far east of Chicago: a JS Date of today's event_date would read as
  // yesterday in Chicago, and a Date-based compare would skip the event.
  process.env.TZ = 'Pacific/Kiritimati';
  try {
    const today = await seedAuto({ date: chicagoTodayYmd() });
    await auto().triggerMenuAutoStart(today.planId);
    assert.ok((await guardOf(today.proposalId)).run_id, 'the event day itself starts');
  } finally {
    if (savedEnv.TZ === undefined) delete process.env.TZ; else process.env.TZ = savedEnv.TZ;
  }
  const undated = await seedAuto({ date: null });
  await auto().triggerMenuAutoStart(undated.planId);
  assert.ok((await guardOf(undated.proposalId)).run_id, 'no event date starts');
});

test('auto-start: two concurrent calls start one run (Review Focus 4)', async () => {
  const fx = await seedAuto();
  await Promise.all([auto().triggerMenuAutoStart(fx.planId), auto().triggerMenuAutoStart(fx.planId)]);
  const draft = await draftOf(fx.proposalId);
  assert.deepEqual([draft.version, (await guardOf(fx.proposalId)).run_id], [1, draft.run_id], 'one draft, never replaced');
  assert.deepEqual([startCalls.length, queuedRuns.length], [1, 1], 'one start, one run');
});

test('auto-start: the guard row stops a resubmit after a reopen, even once the draft is gone: at most once per proposal', async () => {
  const fx = await seedAuto();
  await auto().triggerMenuAutoStart(fx.planId);
  const first = await guardOf(fx.proposalId);
  assert.ok(first.run_id);
  await pool.query('DELETE FROM menu_drafts WHERE proposal_id = $1', [fx.proposalId]);
  await pool.query("UPDATE drink_plans SET status = 'draft' WHERE id = $1", [fx.planId]);
  await pool.query("UPDATE drink_plans SET status = 'submitted' WHERE id = $1", [fx.planId]);
  await auto().triggerMenuAutoStart(fx.planId);
  assert.equal(await draftOf(fx.proposalId), null, 'no second draft');
  assert.deepEqual([startCalls.length, queuedRuns.length], [1, 1]);
  const guard = await guardOf(fx.proposalId);
  assert.deepEqual([guard.attempted_at.toISOString(), guard.run_id, guard.draft_id], [first.attempted_at.toISOString(), first.run_id, null],
    'the row stays as the first start left it, its draft nulled');
});

test('auto-start: a proposal with two plans drafts from the lowest-id plan, as every Generate does (spec 8.5)', async () => {
  const fx = await seedAuto({ drinks: [DRINKS[0]] });
  const later = await addPlan(fx.proposalId, { drinks: [DRINKS[1], DRINKS[2]] });
  await auto().triggerMenuAutoStart(later.id);
  const draft = await draftOf(fx.proposalId);
  assert.equal(draft.drink_plan_id, fx.planId, 'the designer\'s plan, the lowest id');
  assert.equal(draft.plan_fingerprint.drink_keys.length, 1, 'its one drink');
  assert.equal((await guardOf(fx.proposalId)).plan_id, later.id, 'the guard names the submitted plan');
});

test('auto-start: each refusal lands on the guard row with its code and sentence, starts no run and clears the Inbox cache', async () => {
  const cases = [];
  // Not set up: a custom look with no words key.
  cases.push(['MENU_ART_NOT_CONFIGURED', 'Menu art is not set up.',
    await seedAuto({ style: 'custom', extra: { menuTheme: 'Navy and brass' } })]);
  // No drinks on the plan.
  cases.push(['MENU_NO_DRINKS', 'The drink plan has no drinks to put on the menu.', await seedAuto({ drinks: [] })]);
  for (const [code, sentence, fx] of cases) {
    invalidations = 0;
    await auto().triggerMenuAutoStart(fx.planId);
    const g = await guardOf(fx.proposalId);
    assert.deepEqual([g.error_code, g.error_sentence, g.draft_id, g.run_id], [code, sentence, null, null], code);
    assert.equal(await draftOf(fx.proposalId), null, `${code}: no draft`);
    assert.ok(invalidations >= 1, `${code}: the Inbox cache is cleared`);
  }
  assert.deepEqual([queuedRuns.length, sentryCalls.length], [0, 0], 'no run, and an expected refusal pages no one');

  // The two no real path here can raise, through the override.
  process.env.SENTRY_DSN_SERVER = 'https://public@sentry.invalid/1';
  startOverride = async () => { throw new AppError('Gemini is not set up.', 503, 'MENU_ART_GEMINI_NOT_CONFIGURED'); };
  const gemini = await seedAuto();
  await auto().triggerMenuAutoStart(gemini.planId);
  const g = await guardOf(gemini.proposalId);
  assert.deepEqual([g.error_code, g.error_sentence], ['MENU_ART_GEMINI_NOT_CONFIGURED', 'Gemini is not set up.']);
  assert.equal(sentryCalls.length, 0);
  const boom = new Error('menuAutoStart.test: something unexpected');
  startOverride = async () => { throw boom; };
  const other = await seedAuto();
  await auto().triggerMenuAutoStart(other.planId);
  const o = await guardOf(other.proposalId);
  assert.deepEqual([o.error_sentence, o.draft_id, o.run_id], [START_FAILED, null, null]);
  assert.ok(o.error_code, 'a code is stored');
  assert.equal(sentryCalls.length, 1, 'anything else pages Sentry once');
  assert.equal(sentryCalls[0].err, boom);
  assert.equal(queuedRuns.length, 0);
});

test('auto-start: a capped start records the sentence, writes no draft and reserves and calls nothing (image cap and text cap)', async () => {
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  process.env.MENU_ART_DAILY_IMAGE_CAP = String(await openCount('image'));
  const image = await seedAuto({ eventType: 'birthday-party' });
  await auto().triggerMenuAutoStart(image.planId);
  const gi = await guardOf(image.proposalId);
  assert.deepEqual([gi.error_code, gi.error_sentence], ['MENU_ART_CAP_REACHED', CAPPED]);
  assert.deepEqual([await draftOf(image.proposalId), await ledgerOf(image.proposalId)], [null, []]);

  process.env.MENU_ART_DAILY_IMAGE_CAP = String((await openCount('image')) + 1000);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.MENU_ART_DAILY_TEXT_CAP = String(await openCount('text'));
  const text = await seedAuto({ style: 'custom', extra: { menuTheme: 'Navy and brass' } });
  await auto().triggerMenuAutoStart(text.planId);
  const gt = await guardOf(text.proposalId);
  assert.deepEqual([gt.error_code, gt.error_sentence], ['MENU_ART_TEXT_CAP_REACHED', CAPPED]);
  assert.deepEqual([await draftOf(text.proposalId), await ledgerOf(text.proposalId)], [null, []]);
  assert.deepEqual([queuedRuns.length, tripwire], [0, 0], 'nothing queued, nothing called');
});

// The acceptance line: on a tree without the auto-start no draft starts on submit.
test('the submit route: a Standard Menu submit starts the draft after it answers, holding no submit client', async () => {
  const fx = await seedAuto({ planStatus: 'draft', style: null, drinks: [] });
  // Every client checked out with pool.connect() and not yet released, at the
  // moment the guard insert runs.
  let out = 0;
  const atGuard = [];
  const realQuery = pool.query;
  const realConnect = pool.connect;
  pool.query = function watched(text, ...rest) {
    if (/INSERT INTO menu_auto_starts/.test(String(text))) atGuard.push(out);
    return realQuery.call(this, text, ...rest);
  };
  pool.connect = async function watchedConnect(cb) {
    if (typeof cb === 'function') return realConnect.call(pool, cb);
    const c = await realConnect.call(pool);
    out += 1;
    const release = c.release.bind(c);
    let released = false;
    c.release = (...a) => { if (!released) { released = true; out -= 1; } c.release = release; return release(...a); };
    return c;
  };
  let res;
  try {
    res = await request('PUT', `/api/drink-plans/t/${fx.token}`,
      { status: 'submitted', selections: { menuStyle: 'house', customCocktails: DRINKS.slice(0, 2) } });
    for (let i = 0; i < 50 && !(await guardOf(fx.proposalId)); i += 1) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 50 && !((await guardOf(fx.proposalId)) || {}).run_id; i += 1) await new Promise((r) => setTimeout(r, 100));
  } finally {
    pool.query = realQuery;
    pool.connect = realConnect;
  }
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const draft = await draftOf(fx.proposalId);
  assert.ok(draft, 'the submit started a draft');
  assert.equal((await guardOf(fx.proposalId)).run_id, draft.run_id);
  assert.deepEqual(atGuard, [0], 'one guard insert, with no client held: the submit\'s and the mark\'s are released');
  assert.deepEqual(queuedRuns.map((r) => r.draftId), [draft.id]);
});

// The card's sub line (spec 2026-10-19 section 14) reads the read model's
// draft.auto_started: true while the draft's current run is the auto-start's,
// false once a manual Generate has replaced it, and false on a draft no
// auto-start made.
test('the read model: draft.auto_started while the auto run is the draft\'s current run, and not after a manual Generate', async () => {
  const { readDraftPayload } = require('./menuDraftRead');
  const fx = await seedAuto();
  await auto().triggerMenuAutoStart(fx.planId);
  assert.equal((await readDraftPayload(fx.proposalId)).draft.auto_started, true);
  await pool.query('UPDATE menu_drafts SET run_id = gen_random_uuid() WHERE proposal_id = $1', [fx.proposalId]);
  assert.equal((await readDraftPayload(fx.proposalId)).draft.auto_started, false, 'a later run is not the auto one');
  const manual = await seedAuto();
  await pool.query(
    `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint)
     VALUES ($1, gen_random_uuid(), '{}', '{"words_status":"done"}', '{}')`, [manual.proposalId]);
  assert.equal((await readDraftPayload(manual.proposalId)).draft.auto_started, false, 'no guard row');
});

// The test-process gate: a suite that submits a booked Custom or Standard plan
// through the real route reaches the auto-start, so a test process that did
// not opt in with NODE_ENV=test starts nothing and reads nothing. This suite
// opted in on its first line; the case steps out of it for one call.
test('a test process without NODE_ENV=test starts no auto-started draft and reads nothing; the same plan starts once it opts in', async () => {
  const fx = await seedAuto();
  const was = process.env.NODE_ENV;
  const seen = [];
  const realQuery = pool.query;
  const realConnect = pool.connect;
  let reason;
  process.env.NODE_ENV = 'development';
  pool.query = function watched(text, ...rest) { seen.push(String(text)); return realQuery.call(this, text, ...rest); };
  pool.connect = async function watchedConnect(...a) { seen.push('connect'); return realConnect.apply(pool, a); };
  try {
    reason = await auto().autoStart(fx.planId);
  } finally {
    process.env.NODE_ENV = was;
    pool.query = realQuery;
    pool.connect = realConnect;
  }
  assert.equal(reason, 'test_process');
  assert.deepEqual(seen, [], 'not one query: nothing read, no guard row written');
  assert.equal(await guardOf(fx.proposalId), null, 'no guard row');
  assert.equal(await draftOf(fx.proposalId), null, 'no draft');
  assert.deepEqual([startCalls.length, queuedRuns.length], [0, 0], 'startGeneration never ran');
  // Opted in again, the same plan starts: the gate, not the fixture, held it.
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(await auto().autoStart(fx.planId), 'started');
  const draft = await draftOf(fx.proposalId);
  assert.equal((await guardOf(fx.proposalId)).run_id, draft.run_id);
});

// Review fix 2: the run is stored on the guard row inside startGeneration's
// one locked transaction (its onStarted hook, on that transaction's client),
// so a database failure or a restart between the commit and a later store can
// never leave a live draft beside a guard row with no run.
test('the guard row holds the draft and run the moment startGeneration returns, written on the transaction\'s own client', async () => {
  const fx = await seedAuto();
  const STORE = /UPDATE menu_auto_starts SET draft_id/;
  const onPool = [];
  const onClient = [];
  let atReturn = null;
  startOverride = async (args) => {
    const hook = args.onStarted;
    const out = await realGen.startGeneration({
      ...args,
      onStarted: hook && (async (client, ids) => {
        const q = client.query.bind(client);
        const watched = Object.assign(Object.create(client), {
          query: (text, ...rest) => { onClient.push(String(text)); return q(text, ...rest); },
        });
        return hook(watched, ids);
      }),
    });
    atReturn = await guardOf(fx.proposalId);
    return out;
  };
  const realQuery = pool.query;
  pool.query = function watched(text, ...rest) { onPool.push(String(text)); return realQuery.call(this, text, ...rest); };
  try {
    assert.equal(await auto().autoStart(fx.planId), 'started');
  } finally {
    pool.query = realQuery;
  }
  const draft = await draftOf(fx.proposalId);
  assert.ok(atReturn, 'a guard row');
  assert.deepEqual([atReturn.draft_id, atReturn.run_id], [draft.id, draft.run_id], 'stored before startGeneration returned');
  assert.equal(onClient.filter((t) => STORE.test(t)).length, 1, 'the store ran on the transaction\'s client');
  assert.equal(onPool.filter((t) => STORE.test(t)).length, 0, 'and never on the pool');
  assert.deepEqual(queuedRuns, [{ draftId: draft.id, runId: draft.run_id, proposalId: fx.proposalId }]);
});

test('a store that fails inside the transaction rolls the draft and its reservation back; the guard row holds the error', async () => {
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  process.env.SENTRY_DSN_SERVER = 'https://public@sentry.invalid/1';
  const fx = await seedAuto({ eventType: 'birthday-party' });
  const boom = new Error('menuAutoStart.test: the store failed');
  let hookRan = false;
  startOverride = (args) => realGen.startGeneration({
    ...args,
    // The auto-start's own store runs, then the hook fails: both roll back.
    onStarted: async (client, ids) => { await args.onStarted(client, ids); hookRan = true; throw boom; },
  });
  assert.equal(await auto().autoStart(fx.planId), 'refused');
  assert.equal(hookRan, true, 'the hook ran inside startGeneration');
  assert.equal(await draftOf(fx.proposalId), null, 'no draft');
  assert.deepEqual(await ledgerOf(fx.proposalId), [], 'no reservation');
  const g = await guardOf(fx.proposalId);
  assert.deepEqual([g.draft_id, g.run_id, g.error_sentence], [null, null, START_FAILED]);
  assert.ok(g.error_code);
  assert.deepEqual([sentryCalls.length, sentryCalls[0] && sentryCalls[0].err], [1, boom], 'reported once, as unexpected');
  assert.equal(queuedRuns.length, 0, 'nothing queued');
});

// Review fix 3a: a manual Generate landing between the checks and the start
// is the designed outcome of firstDraft (409 MENU_DRAFT_CHANGED): recorded on
// the guard row, never paged, and the manual draft stands.
test('a manual Generate between the checks and the start: the refusal is recorded, not reported, and the manual draft stands', async () => {
  process.env.SENTRY_DSN_SERVER = 'https://public@sentry.invalid/1';
  const fx = await seedAuto();
  let manual = null;
  startOverride = async (args) => {
    manual = (await pool.query(
      `INSERT INTO menu_drafts (proposal_id, run_id, inputs, content, plan_fingerprint)
       VALUES ($1, gen_random_uuid(), '{}', '{"words_status":"pending"}', '{}') RETURNING id, run_id, version`, [fx.proposalId])).rows[0];
    return realGen.startGeneration(args);
  };
  assert.equal(await auto().autoStart(fx.planId), 'refused');
  const g = await guardOf(fx.proposalId);
  assert.deepEqual([g.error_code, g.error_sentence, g.draft_id, g.run_id], ['MENU_DRAFT_CHANGED', START_FAILED, null, null]);
  const draft = await draftOf(fx.proposalId);
  assert.deepEqual([draft.id, draft.run_id, draft.version], [manual.id, manual.run_id, manual.version], 'the manual draft is untouched');
  assert.deepEqual([sentryCalls.length, queuedRuns.length], [0, 0], 'not paged, nothing queued');
});

// Review fix 3b: the planner clearing its own mark reopens the tasks the mark
// closed, so it clears the Inbox cache after its commit, as the mark does.
test('the planner clearing its own mark clears the Inbox cache; a clear that changes nothing does not', async () => {
  const cleared = await seed({ notRequired: true, by: 'planner', selections: { menuStyle: 'custom' } });
  invalidations = 0;
  assert.equal(await auto().applyNoMenuMark(cleared.planId), 'cleared');
  assert.equal(invalidations, 1);
  const admin = await seed({ notRequired: true, by: 'admin', selections: { menuStyle: 'custom' } });
  invalidations = 0;
  assert.equal(await auto().applyNoMenuMark(admin.planId), 'unchanged');
  assert.equal(invalidations, 0);
});

// Review fix 3c: a failed mark step is reported and the auto-start still runs
// (its own checks read the stored mark and the selections); the trigger
// never throws or rejects.
test('a failed mark step is reported and the auto-start still runs', async () => {
  process.env.SENTRY_DSN_SERVER = 'https://public@sentry.invalid/1';
  const fx = await seedAuto();
  const boom = new Error('menuAutoStart.test: the mark step failed');
  const realQuery = pool.query;
  pool.query = function watched(text, ...rest) {
    if (/UPDATE proposals SET menu_not_required = false/.test(String(text))) return Promise.reject(boom);
    return realQuery.call(this, text, ...rest);
  };
  const realError = console.error;
  console.error = () => {};
  let settled;
  try {
    settled = await auto().triggerMenuAutoStart(fx.planId);
  } finally {
    pool.query = realQuery;
    console.error = realError;
  }
  assert.equal(settled, undefined, 'never rejects');
  assert.deepEqual(sentryCalls.map((c) => c.err), [boom], 'the mark step\'s failure, reported once');
  const draft = await draftOf(fx.proposalId);
  assert.ok(draft, 'the auto-start ran');
  assert.equal((await guardOf(fx.proposalId)).run_id, draft.run_id);
});
