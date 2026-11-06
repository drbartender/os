// server/utils/legalHold.scripts.test.js
'use strict';
// The bulk operator scripts beyond legalHold.jobs.test.js leave the legal-hold proposal out (money law 15, plan 2026-11-05 lane legal-hold-auto): the positions backfill reads the Chicago business day, the Check Cherry transfer's --resume never resumes the held proposal, and the duty-line backfill never re-derives it; each prints the held count it left out.
//
// The jobs suite's rules: held ids are synthetic, ADDED through
// __setLegalHoldIdsForTest, and no test reads, writes or selects the real held
// proposal or any real client. Every script run sits inside rolledBack(): one
// connection, one transaction rolled back at the end, with pool.query and
// pool.connect pointed at it, so nothing a script writes, to these fixtures or
// to any other row, ever lands. Fixtures are committed first and deleted in
// after(). Accrual is stubbed and Stripe refuses every call, so nothing here
// reaches a provider. The business day is a stub the clock case sets. Run it
// through scripts/run-suites.js, never a bare node --test.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.NODE_ENV === 'production') {
  throw new Error('legalHold.scripts.test.js refuses to run against production');
}

const { pool } = require('../db');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

// ── Stubs, before any script loads (each destructures at load) ──────────────
require('./stripeClient').getStripe = () => { throw new Error('legalHold.scripts.test.js: no Stripe call is allowed'); };
const accrued = [];
require('./payrollAccrual').accruePayoutsForProposal = async (id) => { accrued.push(Number(id)); return { skipped: false }; };
const businessTime = require('./businessTime');
const realToday = businessTime.chicagoTodayYmd;
let fakeToday = null; // the clock case sets the business day; null is the real one
businessTime.chicagoTodayYmd = (...a) => fakeToday || realToday(...a);

const sweep = require('./staleProposalSweep');
const { __setLegalHoldIdsForTest } = require('./legalHold');

const TODAY = realToday();
const ymd = (offsetDays) => {
  const [y, m, d] = TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
};

// ── Harness (the jobs suite's, the parts these cases use) ───────────────────

async function rolledBack(fn, { isolation = null } = {}) {
  const client = await pool.connect();
  const real = { query: pool.query, connect: pool.connect };
  let n = 0;
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    pool.query = (text, params) => client.query(text, params);
    pool.connect = async () => {
      const sp = `lhs_sp_${++n}`;
      const query = (text, params) => {
        const verb = typeof text === 'string' ? text.trim().split(/\s+/)[0].toUpperCase() : '';
        if (verb === 'BEGIN') return client.query(`SAVEPOINT ${sp}`);
        if (verb === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${sp}`);
        if (verb === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        return client.query(text, params);
      };
      return { query, release() {} };
    };
    return await fn(client);
  } finally {
    pool.query = real.query;
    pool.connect = real.connect;
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

const wrote = async (tx) => (await tx.query('SELECT pg_current_xact_id_if_assigned() AS xid')).rows[0].xid !== null;

// Runs fn with the console held (a script's lines can name other rows on the
// shared database, so none is printed); never throws, returns what happened.
async function captured(fn) {
  const lines = [];
  const keep = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const text = (args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  console.log = (...a) => { lines.push(text(a)); };
  console.info = console.warn = console.error = console.log;
  let value; let error = null;
  try { value = await fn(); } catch (err) { error = err; } finally { Object.assign(console, keep); }
  return { value, error, lines };
}

// One script run: the pool's end and the exit code are held, so a script that
// ends the pool or sets an exit code changes nothing for the suite.
async function runScript(fn) {
  const prior = process.exitCode;
  const realEnd = pool.end;
  process.exitCode = undefined;
  pool.end = async () => {};
  try { return { ...(await captured(fn)), exitCode: process.exitCode ?? 0 }; } finally { process.exitCode = prior; pool.end = realEnd; }
}

// Before this lane the duty-line script ran main() at require time and ended
// the pool, so its first load holds pool.end and waits for that run.
const loaded = new Map();
async function loadScript(name) {
  if (loaded.has(name)) return loaded.get(name);
  const file = path.join(__dirname, '..', '..', `${name}.js`);
  const realEnd = pool.end;
  const realArgv = process.argv;
  const priorExit = process.exitCode;
  let ended;
  const endedP = new Promise((resolve) => { ended = resolve; });
  pool.end = async () => { ended(); };
  process.argv = [process.execPath, file];
  try {
    const r = await captured(async () => {
      const mod = require(file);
      if (typeof mod.main !== 'function' && typeof mod.run !== 'function') {
        await Promise.race([endedP, new Promise((resolve) => setTimeout(resolve, 60_000).unref())]);
      }
      return mod;
    });
    if (r.error) throw r.error;
    const entry = { mod: r.value, loadLines: r.lines };
    loaded.set(name, entry);
    return entry;
  } finally {
    pool.end = realEnd;
    process.argv = realArgv;
    process.exitCode = priorExit;
  }
}

async function withListMissing(fn) {
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  sweep.LEGAL_HOLD_PROPOSAL_IDS = undefined;
  try { return await fn(); } finally { sweep.LEGAL_HOLD_PROPOSAL_IDS = real; }
}

const num = (lines, re) => {
  for (const l of lines) { const m = re.exec(l); if (m) return Number(m[1]); }
  return null;
};
const HELD_SHIFTS = /legal hold: (\d+) shift/;
const HELD_PROPOSALS = /legal hold: (\d+) (?:held )?proposal/;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const made = { proposals: [], shifts: [], clients: [] };
const HELD = [];
const F = {};
let manifestDir;

async function insert(table, row) {
  const cols = Object.keys(row);
  const { rows } = await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((c) => row[c]));
  return rows[0].id;
}

async function pair(fields, perRow = () => ({})) {
  const ids = [];
  for (const k of ['held', 'twin']) {
    const id = await insert('proposals', {
      client_id: made.clients[0], event_type: 'birthday-party', event_timezone: 'America/Chicago',
      status: 'draft', total_price: 1000, amount_paid: 0, ...fields, ...perRow(k),
    });
    made.proposals.push(id);
    ids.push(id);
  }
  HELD.push(ids[0]);
  return { held: ids[0], twin: ids[1] };
}

const mkShift = async (fields) => {
  const id = await insert('shifts', { status: 'open', positions_needed: '[]', client_name: `LHS ${NONCE}`, ...fields });
  made.shifts.push(id);
  return id;
};

before(async () => {
  made.clients.push(await insert('clients', { name: `LHS Client ${NONCE}`, email: `lhs-${NONCE}@example.com` }));

  // Positions: one shift each, dated the day before today, positions empty.
  F.pn = await pair({ status: 'confirmed', event_date: ymd(-1) });
  F.pnS = {
    held: await mkShift({ proposal_id: F.pn.held, event_date: ymd(-1) }),
    twin: await mkShift({ proposal_id: F.pn.twin, event_date: ymd(-1) }),
  };

  // Check Cherry transfers already on file, and a manifest naming them.
  F.ccId = { held: `lhs-${NONCE}-h`, twin: `lhs-${NONCE}-t` };
  F.cc = await pair({ status: 'confirmed' }, (k) => ({ transferred_from_cc_id: F.ccId[k] }));
  F.ccName = { held: `LHS Held ${NONCE}`, twin: `LHS Twin ${NONCE}` };
  manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhs-'));
  F.manifest = path.join(manifestDir, 'manifest.json');
  const event = (k) => ({
    cc_id: F.ccId[k], client_name: F.ccName[k], client_email: `lhs-${NONCE}-${k}@example.com`,
    event_date: ymd(30), start_time: '18:00', duration_hours: 4, package: 'LHS Package', guest_count: 50,
    total: 1000, external_paid: 100, balance_due_date: ymd(20),
  });
  fs.writeFileSync(F.manifest, JSON.stringify({ events: [event('held'), event('twin')] }));

  // Duty lines: completed proposals dated today, inside the open pay period.
  F.du = await pair({ status: 'completed', event_date: TODAY, total_price: 1000, amount_paid: 1000 });

  __setLegalHoldIdsForTest(HELD);
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (manifestDir) fs.rmSync(manifestDir, { recursive: true, force: true });
  await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [made.shifts]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  await pool.end();
});

// ── Item 1: the positions backfill reads the Chicago business day ────────────

test('positions backfill: it reads the Chicago business day, so a shift dated that day is counted and planned; the held one never is', async () => {
  await rolledBack(async () => {
    const pos = require('../../scripts/backfill-positions-needed');
    const dry = async (day) => {
      fakeToday = day;
      try { return (await runScript(() => pos.main([]))).lines; } finally { fakeToday = null; }
    };
    const plans = (lines, id) => lines.some((l) => l.includes(`shift ${id} (`));
    // The business day is the shifts' own day: on 2eb49e30 the run compared
    // against the GMT CURRENT_DATE, a day or two later, and left them out.
    const onTheDay = await dry(ymd(-1));
    assert.ok(plans(onTheDay, F.pnS.twin), 'a shift dated the business day was left out');
    assert.equal(plans(onTheDay, F.pnS.held), false, 'the held shift is in the plan');
    const dayAfter = await dry(TODAY);
    assert.equal(plans(dayAfter, F.pnS.twin), false, 'a shift dated before the business day is in the plan');
    assert.equal(num(onTheDay, HELD_SHIFTS) - num(dayAfter, HELD_SHIFTS), 1, 'the held count reads the same business day');
  }, { isolation: 'REPEATABLE READ' });
});

// ── Item 3: the Check Cherry transfer's --resume never resumes the held proposal ──

test('cc transfer --resume: the held proposal is never a resume row, is counted, and is not named; the twin resumes', async () => {
  await rolledBack(async () => {
    const cct = require('../../scripts/cc-transfer-events');
    assert.equal(typeof cct.run, 'function', 'the script exports run (on 2eb49e30 it had no in-process entry and no held exclusion)');
    const r = await runScript(() => cct.run(['--manifest', F.manifest, '--resume']));
    assert.equal(r.error, null);
    assert.equal(r.lines.some((l) => l.includes(`RESUME ${F.ccId.held}`)), false, 'the held proposal is a resume row');
    assert.ok(r.lines.some((l) => l.includes(`RESUME ${F.ccId.twin}`)), 'the twin is not a resume row');
    assert.equal(num(r.lines, HELD_PROPOSALS), 1, 'the run prints the held count');
    assert.equal(r.lines.some((l) => l.includes(F.ccName.held)), false, 'a line names the held client');
  });
});

test('list missing: the cc transfer throws before it reads a transfer row', async () => {
  await rolledBack(async (tx) => {
    const cct = require('../../scripts/cc-transfer-events');
    assert.equal(typeof cct.run, 'function', 'the script exports run');
    const r = await withListMissing(() => runScript(() => cct.run(['--manifest', F.manifest, '--resume'])));
    assert.match(String(r.error && r.error.message), /LEGAL_HOLD_PROPOSAL_IDS/);
    assert.equal(await wrote(tx), false, 'a row was written');
  });
});

// ── Item 4: the duty-line backfill never re-derives the held proposal ────────

// An open pay period containing today, inside the caller's transaction.
const openPeriod = (tx) => tx.query(
  `INSERT INTO pay_periods (start_date, end_date, payday, status)
   SELECT $1::date, $1::date + 6, $1::date + 10, 'open'
    WHERE NOT EXISTS (SELECT 1 FROM pay_periods WHERE status = 'open' AND $1::date BETWEEN start_date AND end_date)
   ON CONFLICT (start_date) DO NOTHING`,
  [TODAY]);

test('duty-line backfill: the held proposal is never re-derived and is counted; the twin is derived', async () => {
  await rolledBack(async (tx) => {
    await openPeriod(tx);
    const a0 = accrued.length;
    const { mod, loadLines } = await loadScript('scripts/backfill-duty-lines');
    const run = async () => (typeof mod.main === 'function' ? (await runScript(() => mod.main([]))).lines : loadLines);
    const withHeld = await run();
    const derived = accrued.slice(a0);
    assert.equal(derived.includes(F.du.held), false, 'the held proposal was re-derived');
    assert.ok(derived.includes(F.du.twin), 'the twin was not derived');
    __setLegalHoldIdsForTest(HELD.filter((id) => id !== F.du.held));
    let without;
    try { without = await run(); } finally { __setLegalHoldIdsForTest(HELD); }
    assert.equal(num(withHeld, HELD_PROPOSALS) - num(without, HELD_PROPOSALS), 1, 'the held proposal is counted as left out');
  }, { isolation: 'REPEATABLE READ' });
});

test('duty-line backfill: a --yes run refuses without the held count; with it the twin is derived and the held proposal never is', async () => {
  await rolledBack(async (tx) => {
    await openPeriod(tx);
    const { mod } = await loadScript('scripts/backfill-duty-lines');
    assert.equal(typeof mod.main, 'function', 'the script exports main and runs only when invoked');
    const n = num((await runScript(() => mod.main([]))).lines, HELD_PROPOSALS);
    assert.notEqual(n, null, 'the run prints the held count');
    const a0 = accrued.length;
    for (const args of [['--yes'], ['--yes', '--held-excluded', String(n + 1)], ['--yes', '--held-excluded', 'x']]) {
      const r = await runScript(() => mod.main(args));
      assert.equal(r.error, null, args.join(' '));
      assert.notEqual(r.exitCode, 0, `refused: ${args.join(' ')}`);
    }
    assert.deepEqual(accrued.slice(a0), [], 'a refused run derived something');
    const ok = await runScript(() => mod.main(['--yes', '--held-excluded', String(n)]));
    assert.equal(ok.exitCode, 0);
    const derived = accrued.slice(a0);
    assert.ok(derived.includes(F.du.twin) && !derived.includes(F.du.held));
  });
});

test('list missing: the duty-line backfill throws before it reads a proposal or writes anything', async () => {
  await rolledBack(async (tx) => {
    await openPeriod(tx);
    const { mod } = await loadScript('scripts/backfill-duty-lines');
    assert.equal(typeof mod.main, 'function', 'the script exports main and runs only when invoked');
    const a0 = accrued.length;
    const xid0 = await wrote(tx); // the period insert above may have written
    const r = await withListMissing(() => runScript(() => mod.main([])));
    assert.match(String(r.error && r.error.message), /LEGAL_HOLD_PROPOSAL_IDS/);
    assert.deepEqual(accrued.slice(a0), [], 'a proposal was re-derived');
    assert.equal(await wrote(tx), xid0, 'a row was written');
  });
});
