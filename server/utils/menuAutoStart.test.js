// server/utils/menuAutoStart.test.js
'use strict';
// The no-menu mark on submit (spec 2026-10-19 section 15, plan 2026-11-03 lane
// menu-no-menu-mark): triggerMenuAutoStart(planId) marks a Skip the Menu
// submit as needing no printed menu with by planner and its activity row; a
// later Custom or Standard submit clears only a planner mark; a print key, an
// archived proposal and the legal-hold proposal are never marked, and a print
// key logs the overridden Skip the Menu; an admin's Undo stands; only an
// explicit menuStyle counts (the legacy customMenuDesign is no choice); the
// trigger swallows and reports its own failure; and the real submit route
// fires it after its response.
//
// Real dev DB rows, nonce-suffixed, every one deleted in after(). Held ids are
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

if (process.env.NODE_ENV === 'production') {
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

const { pool } = require('../db');
const { AppError } = require('./errors');
const { __setLegalHoldIdsForTest } = require('./legalHold');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const auto = () => require('./menuAutoStart');

let clientId;
const proposalIds = [];
let server;
let baseUrl;
const savedDsn = process.env.SENTRY_DSN_SERVER;

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

beforeEach(() => {
  sentryCalls.length = 0;
  __setLegalHoldIdsForTest([]);
});

after(async () => {
  __setLegalHoldIdsForTest([]);
  // Let the submit tail's fire-and-forget work (shopping list, the mark) settle.
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of proposalIds) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [pid]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (savedDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
  else process.env.SENTRY_DSN_SERVER = savedDsn;
  if (savedSentry) require.cache[sentryPath] = savedSentry; else delete require.cache[sentryPath];
  await pool.end();
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
  assert.equal(sentryCalls.length, 1, 'one Sentry capture');
  assert.equal(sentryCalls[0].err, boom);
  assert.equal(sentryCalls[0].ctx.extra.planId, fx.planId);
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
