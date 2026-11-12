// server/scripts/backfillMenuNotRequired.test.js
'use strict';
// The one-time no-menu backfill (spec 2026-10-19 section 15, plan 2026-11-03
// lane menu-no-menu-mark): dry run by default and writes nothing; marks only
// upcoming, booked, unarchived, unheld proposals with no print file and no
// mark whose lowest-id plan is submitted and says none; prints the legal-hold
// count it left out and refuses a write run without a matching
// --held-excluded; writes in one transaction with an activity row per mark.
//
// Fixtures are committed first and deleted in after(). Every script run sits
// inside rolledBack() (the legalHold.scripts.test.js harness): one connection,
// one transaction rolled back at the end, with pool.query and pool.connect
// pointed at it, so nothing the script writes, to these fixtures or any other
// row on the shared database, ever lands. The script's lines are captured and
// never printed. Held ids are synthetic (__setLegalHoldIdsForTest); no test
// reads or writes the real held proposal or any real client. Run it through
// scripts/run-suites.js, never a bare node --test.
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

if (process.env.NODE_ENV === 'production') {
  throw new Error('backfillMenuNotRequired.test.js refuses to run against production');
}

const { pool } = require('../db');
const { chicagoTodayYmd } = require('../utils/businessTime');
const { __setLegalHoldIdsForTest } = require('../utils/legalHold');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const SCRIPT = path.join(__dirname, 'backfillMenuNotRequired.js');
const TODAY = chicagoTodayYmd();
const ymd = (offsetDays) => {
  const [y, m, d] = TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
};

let clientId;
const proposalIds = [];
const fx = {};

// ── Harness ─────────────────────────────────────────────────────────────────

const statements = [];
async function rolledBack(fn) {
  const client = await pool.connect();
  const real = { query: pool.query, connect: pool.connect, end: pool.end };
  let n = 0;
  statements.length = 0;
  try {
    await client.query('BEGIN');
    pool.query = (text, params) => { statements.push({ via: 'pool', text: String(text) }); return client.query(text, params); };
    pool.end = async () => {};
    pool.connect = async () => {
      const sp = `bmn_sp_${++n}`;
      const query = (text, params) => {
        const verb = typeof text === 'string' ? text.trim().split(/\s+/)[0].toUpperCase() : '';
        statements.push({ via: 'client', text: String(text) });
        if (verb === 'BEGIN') return client.query(`SAVEPOINT ${sp}`);
        if (verb === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${sp}`);
        if (verb === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        return client.query(text, params);
      };
      return { query, release() {} };
    };
    return await fn(client);
  } finally {
    Object.assign(pool, real);
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

const wrote = async (tx) => (await tx.query('SELECT pg_current_xact_id_if_assigned() AS xid')).rows[0].xid !== null;

// One script run with the console held and the exit code kept from the suite.
async function run(args) {
  const lines = [];
  const keep = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  console.info = console.warn = console.error = console.log;
  const prior = process.exitCode;
  process.exitCode = undefined;
  let error = null;
  try {
    await require(SCRIPT).main(args);
  } catch (err) { error = err; } finally {
    Object.assign(console, keep);
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = prior;
  return { lines, error, exitCode };
}

const listIn = (lines, prefix) => {
  const line = lines.find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).split(',').map((s) => Number(s.trim())).filter(Boolean) : [];
};
const idsIn = (lines) => listIn(lines, 'ids: ');
const legacyIn = (lines) => listIn(lines, 'legacy ids: ');
const heldIn = (lines) => {
  const line = lines.find((l) => /^legal hold: \d+/.test(l));
  return line ? Number(line.match(/^legal hold: (\d+)/)[1]) : null;
};

async function seed(key, { status = 'confirmed', date = ymd(20), printKey = null, notRequired = false, by = null,
  plans = [{ status: 'submitted', selections: { menuStyle: 'none' } }] } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
                            status, event_type, menu_print_key, menu_not_required, menu_not_required_by)
     VALUES ($1, $2::date, '18:00', 4, 'America/Chicago', $3, 'birthday-party', $4, $5, $6) RETURNING id`,
    [clientId, date, status, printKey, notRequired, by]
  );
  const id = p.rows[0].id;
  proposalIds.push(id);
  for (const plan of plans) {
    await pool.query(
      `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email, planner_version)
       VALUES ($1, $2, $3::jsonb, $4, $5, 1)`,
      [id, plan.status, JSON.stringify(plan.selections), `Backfill Test ${NONCE}`, `backfill-${NONCE}@example.com`]
    );
  }
  fx[key] = id;
  return id;
}

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550143') RETURNING id",
    [`Backfill Test ${NONCE}`, `backfill-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  await seed('eligible');
  await seed('reviewed', { plans: [{ status: 'reviewed', selections: { menuStyle: 'none' } }] });
  await seed('legacy', { plans: [{ status: 'submitted', selections: { customMenuDesign: false } }] });
  await seed('today', { date: TODAY });
  await seed('unsubmitted', { plans: [{ status: 'draft', selections: { menuStyle: 'none' } }] });
  await seed('notLowest', { plans: [
    { status: 'submitted', selections: { menuStyle: 'custom' } },
    { status: 'submitted', selections: { menuStyle: 'none' } },
  ] });
  await seed('notBooked', { status: 'sent' });
  await seed('past', { date: ymd(-2) });
  await seed('archived', { status: 'archived' });
  await seed('held');
  await seed('printKey', { printKey: `menu-print/backfill-${NONCE}/x.pdf` });
  await seed('marked', { notRequired: true });
  await seed('custom', { plans: [{ status: 'submitted', selections: { menuStyle: 'custom' } }] });
  await seed('adminCleared', { by: 'admin' });
  await seed('legacyMarked', { notRequired: true, plans: [{ status: 'submitted', selections: { customMenuDesign: false } }] });
});

after(async () => {
  __setLegalHoldIdsForTest([]);
  for (const id of proposalIds) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

const SELECTED = ['eligible', 'reviewed', 'today'];
// legacy: customMenuDesign false with no menuStyle answered the old planner's
// custom-graphic question, never a no-menu request (spec 15, amended 2026-11-12).
const LEFT_OUT = ['legacy', 'unsubmitted', 'notLowest', 'notBooked', 'past', 'archived', 'held', 'printKey', 'marked', 'custom', 'adminCleared'];

test('the dry run writes nothing, lists the eligible ids and leaves every excluded one out', async () => {
  __setLegalHoldIdsForTest([fx.held]);
  try {
    await rolledBack(async (tx) => {
      const r = await run([]);
      assert.equal(r.error, null, r.error && r.error.message);
      assert.equal(r.exitCode, 0);
      assert.equal(await wrote(tx), false, 'the dry run wrote nothing');
      const ids = idsIn(r.lines);
      for (const k of SELECTED) assert.ok(ids.includes(fx[k]), `${k} is selected`);
      for (const k of LEFT_OUT) assert.ok(!ids.includes(fx[k]), `${k} is left out`);
      // The legacy rows are listed apart for a hand look, never marked; a
      // legacy row already marked is not listed.
      const legacy = legacyIn(r.lines);
      assert.ok(legacy.includes(fx.legacy), 'the legacy row is listed for a hand look');
      for (const k of [...SELECTED, ...LEFT_OUT.filter((x) => x !== 'legacy'), 'legacyMarked']) {
        assert.ok(!legacy.includes(fx[k]), `${k} is not in the legacy list`);
      }
      assert.ok(r.lines.some((l) => /^legacy, not marked, check by hand: \d+ proposal\(s\)$/.test(l)), 'the legacy count line');
      const held = heldIn(r.lines);
      assert.ok(held >= 1, 'the held count counts the synthetic held proposal');
      // Ids and counts only: every line is free of anything but digits, ids and fixed words.
      for (const line of r.lines) assert.doesNotMatch(line, /@|Backfill Test|birthday/, line);
    });
  } finally { __setLegalHoldIdsForTest([]); }
});

test('a held proposal that matches every other rule raises the held count by one', async () => {
  const counts = [];
  for (const held of [[], [fx.held]]) {
    __setLegalHoldIdsForTest(held);
    try {
      await rolledBack(async () => { counts.push(heldIn((await run([])).lines)); });
    } finally { __setLegalHoldIdsForTest([]); }
  }
  assert.equal(counts[1], counts[0] + 1);
});

test('a write run refuses without --held-excluded, and with a count that does not match', async () => {
  __setLegalHoldIdsForTest([fx.held]);
  try {
    await rolledBack(async (tx) => {
      const none = await run(['--apply']);
      assert.equal(none.exitCode, 1);
      assert.equal(await wrote(tx), false);
      const dry = await run([]);
      const held = heldIn(dry.lines);
      const wrong = await run(['--apply', '--held-excluded', String(held + 1)]);
      assert.equal(wrong.exitCode, 2);
      assert.equal(await wrote(tx), false, 'a refused write run wrote nothing');
      const bad = await run(['--apply', '--held-excluded', 'x']);
      assert.equal(bad.exitCode, 1);
    });
  } finally { __setLegalHoldIdsForTest([]); }
});

test('the write run marks in one transaction, by planner, with one activity row per mark', async () => {
  __setLegalHoldIdsForTest([fx.held]);
  try {
    await rolledBack(async (tx) => {
      const held = heldIn((await run([])).lines);
      const r = await run(['--apply', '--held-excluded', String(held)]);
      assert.equal(r.error, null, r.error && r.error.message);
      assert.equal(r.exitCode, 0);
      const begins = statements.filter((s) => /^\s*BEGIN\b/i.test(s.text)).length;
      const commits = statements.filter((s) => /^\s*COMMIT\b/i.test(s.text)).length;
      assert.deepEqual([begins, commits], [1, 1], 'one transaction');
      const all = [...SELECTED, ...LEFT_OUT].map((k) => fx[k]);
      const { rows } = await tx.query(
        'SELECT id, menu_not_required, menu_not_required_by FROM proposals WHERE id = ANY($1::int[])', [all]);
      const byId = new Map(rows.map((x) => [x.id, x]));
      for (const k of SELECTED) {
        assert.deepEqual([byId.get(fx[k]).menu_not_required, byId.get(fx[k]).menu_not_required_by], [true, 'planner'], k);
      }
      for (const k of LEFT_OUT.filter((x) => x !== 'marked' && x !== 'adminCleared')) {
        assert.deepEqual([byId.get(fx[k]).menu_not_required, byId.get(fx[k]).menu_not_required_by], [false, null], k);
      }
      assert.deepEqual([byId.get(fx.adminCleared).menu_not_required, byId.get(fx.adminCleared).menu_not_required_by], [false, 'admin'], 'an admin Undo stands');
      assert.deepEqual([byId.get(fx.marked).menu_not_required, byId.get(fx.marked).menu_not_required_by], [true, null], 'an existing mark is untouched');
      const { rows: log } = await tx.query(
        `SELECT proposal_id, actor_type, details FROM proposal_activity_log
          WHERE proposal_id = ANY($1::int[]) AND action = 'menu_not_required' ORDER BY proposal_id`, [all]);
      assert.deepEqual(log.map((x) => x.proposal_id), SELECTED.map((k) => fx[k]).sort((a, b) => a - b));
      for (const x of log) {
        assert.equal(x.actor_type, 'client');
        assert.equal(x.details.by, 'planner');
      }
    });
  } finally { __setLegalHoldIdsForTest([]); }
});
