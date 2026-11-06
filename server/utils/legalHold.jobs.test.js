// server/utils/legalHold.jobs.test.js
'use strict';
// The automatic jobs and the bulk scripts leave the legal-hold proposal out (money law 15, plan 2026-11-05 lane legal-hold-auto): run against a synthetic held proposal and its unheld twin, each job touches the twin and never the held one, each script prints the held count it leaves out and refuses a write run without it, and with the list missing each job throws before any write.
//
// Held ids are synthetic, ADDED through __setLegalHoldIdsForTest; no test reads,
// writes or selects the real held proposal or any real client. The jobs are
// DB-wide by design, so each one runs inside rolledBack(): one connection, one
// transaction rolled back at the end, with pool.query and pool.connect pointed
// at it (a job's own BEGIN, COMMIT and ROLLBACK become savepoints). Nothing a
// job writes, to these fixtures or to any other row on the shared database,
// ever lands. The fixtures are committed first so the jobs see them, and
// after() deletes every one. Stripe, the admin, staff and SMS senders,
// geocoding and the auto-assign engine are stubbed before any job module
// loads, so nothing here reaches a provider. Run it through
// scripts/run-suites.js, never a bare node --test.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('legalHold.jobs.test.js refuses to run against production');
}

const { pool } = require('../db');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

// ── Stubs, installed before any job module loads (several destructure at load) ──
const calls = { stripe: [], admin: [], sms: [], staff: [], extAdmin: [], autoAssign: [], geocode: [], sent: [] };
const fakePis = new Map();
const fakeStripe = {
  paymentIntents: {
    async create(params) {
      calls.stripe.push({ op: 'create', proposalId: Number(params.metadata && params.metadata.proposal_id) });
      return { id: `pi_lhj_${crypto.randomBytes(6).toString('hex')}`, status: 'succeeded' };
    },
    async retrieve(id) {
      calls.stripe.push({ op: 'retrieve', id });
      const pi = fakePis.get(id);
      if (!pi) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
      return pi;
    },
    async cancel(id) {
      calls.stripe.push({ op: 'cancel', id });
      if (id.includes('_cfail')) throw new Error('fake cancel failure');
      return { id, status: 'canceled' };
    },
  },
};
require('./stripeClient').getStripe = () => fakeStripe;
require('./invoiceVoid')._setStripeForTests(fakeStripe);
require('./adminNotifications').notifyAdminCategory = async (args) => { calls.admin.push(args); return { emailed: 1 }; };
require('./sms').sendAndLogSms = async (args) => { calls.sms.push(args); return { id: 1 }; };
require('./payrollAccrual').accruePayoutsForProposal = async () => {};
require('./marketingHandlers').scheduleReviewRequest = async () => {};
require('./marketingHandlers').scheduleRetentionNudge = async () => {};
require('./changeRequests').cancelPendingChangeRequestsForProposal = async () => {};
require('./autoAssign').autoAssignShift = async (id) => {
  calls.autoAssign.push(Number(id));
  return { approved: [], slots_remaining: 0 };
};
const extNotify = require('./serviceExtensionNotify');
extNotify.notifyStaffOfOutcome = async (args) => { calls.staff.push(args); return { notified: [], unreachable: [] }; };
extNotify.alertAdminsProblem = async (args) => { calls.extAdmin.push(args); };
const geocode = require('./geocode');
geocode.geocodeAddress = async (addr) => {
  calls.geocode.push(String(addr));
  return String(addr).includes(NONCE) ? { lat: 41.88, lng: -87.63 } : null;
};
geocode.delay = async () => {};

const dispatcher = require('./scheduledMessageDispatcher');
const { resolveCriticalDeadLetters } = require('./dispatcherDeadLetters');
const { monitorMissingBalanceInvoices, OVER_ACTION, UNDER_ACTION } = require('./balanceInvoiceMonitor');
const balanceScheduler = require('./balanceScheduler');
const { sweepFinishedShiftClosures } = require('./shiftClosureSweep');
const { processScheduledAutoAssigns } = require('./autoAssignScheduler');
const { sweepExpiredExtensions, healUnfinalizedExtensions } = require('./serviceExtensionSweep');
const { scheduleBalanceReminders, REMINDER_OFFSET_DAYS, reminderAnchorInstant } = require('./balanceReminderScheduling');
const sweep = require('./staleProposalSweep');
const { suspendClientAutomation } = require('./clientAutomationSuspension');
const { findStaleProcessingPayments, IN_FLIGHT_MAX_AGE_DAYS } = require('./paymentInFlight');
const { schedulePreEventReminders } = require('./preEventScheduling');
const preEventHandlers = require('./preEventHandlers');
const { __setLegalHoldIdsForTest } = require('./legalHold');
const { chicagoTodayYmd } = require('./businessTime');
const { AppError } = require('./errors');
const fullPay = require('../scripts/backfillFullPaymentInvoices');
const settingsRouter = require('../routes/admin/settings');
const thumbtackAgentRouter = require('../routes/thumbtackAgent');

const TODAY = chicagoTodayYmd();
balanceScheduler.__setDeps({ today: () => TODAY });

// ── Harness ──────────────────────────────────────────────────────────────────

function ymd(offsetDays) {
  const [y, m, d] = TODAY.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

// Every job runs here: its writes, and every write it makes to anything else on
// the shared database, are rolled back with the transaction.
async function rolledBack(fn, { isolation = null } = {}) {
  const client = await pool.connect();
  const real = { query: pool.query, connect: pool.connect };
  let n = 0;
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    pool.query = (text, params) => client.query(text, params);
    pool.connect = async () => {
      const sp = `lhj_sp_${++n}`;
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

// True once anything in the transaction wrote a row.
const wrote = async (tx) => (await tx.query('SELECT pg_current_xact_id_if_assigned() AS xid')).rows[0].xid !== null;

// Runs fn with the console held (a job's log lines can name other rows on the
// shared database, so none is printed); never throws, returns what happened.
async function captured(fn) {
  const lines = [];
  const errors = [];
  const keep = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const text = (args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  console.log = (...a) => { lines.push(text(a)); };
  console.info = console.warn = console.log;
  console.error = (...a) => { errors.push(text(a)); lines.push(text(a)); };
  let value; let error = null;
  try { value = await fn(); } catch (err) { error = err; } finally { Object.assign(console, keep); }
  return { value, error, lines, errors };
}

const quiet = async (fn) => { const r = await captured(fn); if (r.error) throw r.error; return r; };

async function withListMissing(fn) {
  const real = sweep.LEGAL_HOLD_PROPOSAL_IDS;
  sweep.LEGAL_HOLD_PROPOSAL_IDS = undefined;
  try { return await fn(); } finally { sweep.LEGAL_HOLD_PROPOSAL_IDS = real; }
}

async function runScript(mod, args) {
  const prior = process.exitCode;
  process.exitCode = undefined;
  try { return { ...(await captured(() => mod.main(args))), exitCode: process.exitCode ?? 0 }; } finally { process.exitCode = prior; }
}

// The scripts export main and run only when invoked directly. Before this lane
// they ran main() at require time and ended the pool when done, so the first
// load holds pool.end and process.argv and waits for that run (inside the
// caller's rolledBack) before the test goes on. A name starting scripts/ is a
// repo-root script; any other is under server/scripts.
const loadedScripts = new Map();
async function loadScript(name, argsAtLoad) {
  if (loadedScripts.has(name)) return loadedScripts.get(name);
  const file = name.startsWith('scripts/')
    ? path.join(__dirname, '..', '..', `${name}.js`)
    : path.join(__dirname, '..', 'scripts', `${name}.js`);
  const realEnd = pool.end;
  const realArgv = process.argv;
  const priorExit = process.exitCode;
  let ended;
  const endedP = new Promise((resolve) => { ended = resolve; });
  pool.end = async () => { ended(); };
  process.argv = [process.execPath, file, ...argsAtLoad];
  try {
    const r = await captured(async () => {
      const mod = require(file);
      if (typeof mod.main !== 'function') {
        await Promise.race([endedP, new Promise((resolve) => setTimeout(resolve, 60_000).unref())]);
      }
      return mod;
    });
    if (r.error) throw r.error;
    const entry = { mod: r.value, loadLines: r.lines };
    loadedScripts.set(name, entry);
    return entry;
  } finally {
    pool.end = realEnd;
    process.argv = realArgv;
    process.exitCode = priorExit;
  }
}

const num = (lines, re) => {
  for (const l of lines) { const m = re.exec(l); if (m) return Number(m[1]); }
  return null;
};
const HEAL_HELD = /legal hold: (\d+) pending row/;
const HEAL_EXAMINED = /^Examined (\d+) pending balance-reminder row/;
const EXTRAS_HELD = /legal hold: (\d+) held proposal/; // the extras and Check Cherry scripts
const CLOSE_HELD = /legal hold: (\d+) shift/; // the shift-closure and positions backfills
const FP_HELD = /legal hold: (\d+) proposal/;

// A dry run with every held id, then without one: the count and plan of each.
async function heldDelta(dry, heldId) {
  const withHeld = await dry();
  __setLegalHoldIdsForTest(HELD.filter((id) => id !== heldId));
  try { return { withHeld, without: await dry() }; } finally { __setLegalHoldIdsForTest(HELD); }
}

// The dry-run reader for a script loaded by loadScript (its load-time run on
// the code before this lane, which exported no main).
const dryOf = ({ mod, loadLines }, args = []) => async () => (
  typeof mod.main === 'function' ? (await runScript(mod, args)).lines : loadLines);

// Each refused write run exits non-zero and leaves read() exactly as it was.
async function assertRefused(mod, runs, read) {
  const start = await read();
  for (const args of runs) {
    const r = await runScript(mod, args);
    assert.equal(r.error, null, args.join(' '));
    assert.notEqual(r.exitCode, 0, `refused: ${args.join(' ')}`);
    assert.deepEqual(await read(), start, `nothing written: ${args.join(' ')}`);
  }
}
const refusals = (n, base = ['--apply']) => [base, [...base, '--held-excluded', String(n + 1)], [...base, '--held-excluded', 'x']];

// No script prints a fixture's client name, shift client name or email.
function assertNoPii(lines, what) {
  for (const p of [`LHJ Client ${NONCE}`, `LHJ ${NONCE}`, `lhj-${NONCE}@example.com`]) {
    assert.equal(lines.some((l) => l.includes(p)), false, `${what} printed a name or email`);
  }
}

async function msgState(db, ids) {
  const { rows } = await db.query(
    'SELECT id, status, scheduled_for, claimed_at FROM scheduled_messages WHERE id = ANY($1::int[])', [ids]);
  const iso = (d) => (d ? d.toISOString() : null);
  return Object.fromEntries(rows.map((r) => [r.id, { status: r.status, scheduled_for: iso(r.scheduled_for), claimed_at: iso(r.claimed_at) }]));
}

async function col(db, table, column, ids) {
  const { rows } = await db.query(`SELECT id, ${column} AS v FROM ${table} WHERE id = ANY($1::int[])`, [ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.v]));
}

const callCounts = () => Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, v.length]));

// Scheduled rows naming a proposal, of the given types (any type when none).
const rowCount = async (db, id, types = null) => (await db.query(
  `SELECT count(*)::int AS n FROM scheduled_messages
    WHERE entity_type = 'proposal' AND entity_id = $1 AND ($2::text[] IS NULL OR message_type = ANY($2::text[]))`,
  [id, types])).rows[0].n;

// The suite's own dispatcher handlers (after() of any test that registers more).
function registerTestHandlers() {
  dispatcher._clearHandlersForTest();
  for (const type of ['lhj_msg', 'lhj_def', 'lhj_str', 'lhj_sib']) {
    dispatcher.registerHandler(type, async ({ scheduledMessage }) => { calls.sent.push(scheduledMessage.id); }, { cooldownExempt: true });
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const made = { proposals: [], shifts: [], consults: [], users: [], clients: [] };
const HELD = [];
const F = {};
let DBNOW;
let clientId;
let staffId;
let adminToken;
let server;
let baseUrl;
let seq = 0;

const ago = (mins) => new Date(DBNOW.getTime() - mins * 60_000);

async function insert(table, row) {
  const cols = Object.keys(row);
  const { rows } = await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((c) => row[c]));
  return rows[0].id;
}

async function mkProposal(fields) {
  const id = await insert('proposals', {
    client_id: clientId, event_type: 'birthday-party', event_timezone: 'America/Chicago',
    status: 'draft', total_price: 1000, amount_paid: 0, ...fields,
  });
  made.proposals.push(id);
  return id;
}

// A held proposal and its unheld twin, built the same way.
async function pair(fields) {
  const held = await mkProposal(fields);
  const twin = await mkProposal(fields);
  HELD.push(held);
  return { held, twin };
}

async function mkShift(fields) {
  const id = await insert('shifts', {
    event_date: ymd(30), status: 'open', positions_needed: '["Bartender"]', client_name: `LHJ ${NONCE}`, ...fields,
  });
  made.shifts.push(id);
  return id;
}

async function mkConsult(proposalId) {
  const id = await insert('consults', { client_id: clientId, proposal_id: proposalId, scheduled_at: ago(-7 * 24 * 60), status: 'scheduled' });
  made.consults.push(id);
  return id;
}

const mkMsg = (fields) => insert('scheduled_messages', {
  recipient_type: 'client', recipient_id: clientId, channel: 'email', scheduled_for: ago(1), status: 'pending', ...fields,
});

// The full-payment backfill's stranded shape (backfillFullPaymentInvoices.test.js).
async function stranded() {
  const proposalId = await mkProposal({
    status: 'completed', total_price: 550, amount_paid: 550, deposit_amount: 100, external_paid: 0, payment_type: 'full',
    pricing_snapshot: JSON.stringify({ package: { name: 'The Core Reaction', base_cost: 550 }, total: 550 }),
    event_date: ymd(-10), event_start_time: '6:00 PM', event_duration_hours: 4,
  });
  const invoiceId = await insert('invoices', {
    proposal_id: proposalId, invoice_number: `L${NONCE}${++seq}`, label: 'Deposit', amount_due: 10000, amount_paid: 10000,
    status: 'paid', locked: true, locked_at: DBNOW,
  });
  const paymentId = await insert('proposal_payments', {
    proposal_id: proposalId, stripe_payment_intent_id: `pi_lhjfp_${NONCE}_${seq}`, payment_type: 'full', amount: 55000, status: 'succeeded',
  });
  await insert('invoice_payments', { invoice_id: invoiceId, payment_id: paymentId, amount: 10000 });
  return { proposalId, invoiceId };
}

before(async () => {
  DBNOW = (await pool.query('SELECT NOW() AS now')).rows[0].now;
  clientId = await insert('clients', { name: `LHJ Client ${NONCE}`, email: `lhj-${NONCE}@example.com` });
  made.clients.push(clientId);
  staffId = await insert('users', { email: `lhj-staff-${NONCE}@example.com`, password_hash: 'x', role: 'staff', onboarding_status: 'approved', token_version: 0 });
  const adminId = await insert('users', { email: `lhj-admin-${NONCE}@example.com`, password_hash: 'x', role: 'admin', onboarding_status: 'approved', token_version: 0 });
  made.users.push(staffId, adminId);
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // Dispatcher: rows tied to the held proposal directly, through its shift and
  // through its consult; the twin's rows, plus rows with no proposal at all.
  F.d = await pair({ status: 'deposit_paid', event_date: ymd(30) });
  const dS = { held: await mkShift({ proposal_id: F.d.held }), twin: await mkShift({ proposal_id: F.d.twin }), none: await mkShift({ proposal_id: null }) };
  const dC = { held: await mkConsult(F.d.held), none: await mkConsult(null) };
  const msg = (type, entityType, entityId, extra = {}) => mkMsg({
    message_type: type, entity_type: entityType, entity_id: entityId,
    ...(entityType === 'shift' ? { recipient_type: 'staff', recipient_id: staffId } : {}), ...extra,
  });
  const DEF = { status: 'deferred' };
  const STR = { status: 'processing', claimed_at: ago(20) };
  F.msg = {
    held: [
      await msg('lhj_msg', 'proposal', F.d.held), await msg('lhj_msg', 'shift', dS.held), await msg('lhj_msg', 'consult', dC.held),
      await msg('lhj_def', 'proposal', F.d.held, DEF), await msg('lhj_def', 'shift', dS.held, DEF),
      await msg('lhj_str', 'proposal', F.d.held, STR), await msg('lhj_str', 'shift', dS.held, STR),
    ],
    twin: [
      await msg('lhj_msg', 'proposal', F.d.twin), await msg('lhj_msg', 'shift', dS.twin),
      await msg('lhj_msg', 'shift', dS.none), await msg('lhj_msg', 'consult', dC.none),
      await msg('lhj_def', 'proposal', F.d.twin, DEF), await msg('lhj_def', 'shift', dS.none, DEF),
      await msg('lhj_str', 'proposal', F.d.twin, STR), await msg('lhj_str', 'shift', dS.none, STR),
    ],
  };
  const dl = (entityType, entityId, count, tag) => msg('lhj_dl', entityType, entityId, {
    recipient_type: 'staff', recipient_id: staffId, status: 'failed', suppression_key: `lhj:${NONCE}:${tag}`,
    payload: JSON.stringify({ category: 'beo_finalized', re_resolve_count: count }),
  });
  F.dl = {
    held: { zero: await dl('shift', dS.held, 0, 'h0'), two: await dl('proposal', F.d.held, 2, 'h2'), consult: await dl('consult', dC.held, 0, 'hc') },
    twin: { zero: await dl('shift', dS.twin, 0, 't0'), two: await dl('proposal', F.d.twin, 2, 't2') },
  };

  // Balance-invoice monitor: over-billed and under-covered pairs.
  F.mo = await pair({ status: 'deposit_paid', total_price: 1000, amount_paid: 100 });
  for (const id of [F.mo.held, F.mo.twin]) {
    await insert('invoices', { proposal_id: id, invoice_number: `L${NONCE}${++seq}`, label: 'Balance', amount_due: 120000, amount_paid: 0, status: 'sent', locked: false });
  }
  F.mu = await pair({ status: 'deposit_paid', total_price: 1000, amount_paid: 100 });

  F.ap = await pair({
    status: 'deposit_paid', autopay_enrolled: true, balance_due_date: ymd(-1),
    stripe_customer_id: 'cus_lhj_test', stripe_payment_method_id: 'pm_lhj_test', total_price: 1000, amount_paid: 100,
  });
  F.c = await pair({ status: 'confirmed', event_date: ymd(-3), event_start_time: '18:00', event_duration_hours: 4, total_price: 1000, amount_paid: 1000 });
  F.sc = await pair({ status: 'completed', event_date: ymd(-3), total_price: 1000, amount_paid: 1000 });
  F.scS = { held: await mkShift({ proposal_id: F.sc.held, event_date: ymd(-3) }), twin: await mkShift({ proposal_id: F.sc.twin, event_date: ymd(-3) }) };
  F.aa = await pair({ status: 'confirmed', event_date: ymd(1) });
  const aa = (proposalId) => mkShift({ proposal_id: proposalId, event_date: ymd(1), auto_assign_days_before: 3 });
  F.aaS = { held: await aa(F.aa.held), twin: await aa(F.aa.twin), none: await aa(null) };

  F.x = await pair({ status: 'balance_paid', event_date: ymd(0), total_price: 1000, amount_paid: 1000 });
  const ext = (proposalId, extra) => insert('service_extensions', {
    proposal_id: proposalId, contracted_duration_hours: 4, requested_duration_hours: 5, contracted_end_time: '10:00 PM',
    requested_end_time: '11:00 PM', amount_cents: 5000, expires_at: ago(5), ...extra,
  });
  F.xE = { held: await ext(F.x.held, { status: 'pending' }), twin: await ext(F.x.twin, { status: 'pending' }) };
  F.xH = { held: await ext(F.x.held, { status: 'paid', updated_at: ago(5) }), twin: await ext(F.x.twin, { status: 'paid', updated_at: ago(5) }) };

  F.br = await pair({ status: 'deposit_paid', total_price: 1000, amount_paid: 100, balance_due_date: ymd(20), autopay_enrolled: false });

  F.g = await pair({ status: 'confirmed', event_date: ymd(30) });
  F.gLoc = { held: `${NONCE} held venue`, twin: `${NONCE} twin venue`, none: `${NONCE} open venue` };
  F.gS = {
    held: await mkShift({ proposal_id: F.g.held, location: F.gLoc.held }),
    twin: await mkShift({ proposal_id: F.g.twin, location: F.gLoc.twin }),
    none: await mkShift({ proposal_id: null, location: F.gLoc.none }),
  };

  F.h = await pair({ status: 'deposit_paid', total_price: 1000, amount_paid: 100, balance_due_date: ymd(20) });
  const offAnchor = new Date(`${ymd(40)}T03:17:00Z`);
  F.hMsg = {
    held: await mkMsg({ entity_type: 'proposal', entity_id: F.h.held, message_type: 'balance_due_today', scheduled_for: offAnchor }),
    twin: await mkMsg({ entity_type: 'proposal', entity_id: F.h.twin, message_type: 'balance_due_today', scheduled_for: offAnchor }),
  };

  F.e = await pair({ status: 'deposit_paid' });
  F.ePi = { held: `pi_lhj_${NONCE}_eh`, twin: `pi_lhj_${NONCE}_et` };
  for (const k of ['held', 'twin']) {
    await insert('stripe_sessions', { proposal_id: F.e[k], stripe_payment_intent_id: F.ePi[k], amount: 5000, status: 'pending' });
    fakePis.set(F.ePi[k], { id: F.ePi[k], status: 'requires_payment_method', amount: 5000, metadata: { payment_type: 'drink_plan_extras', extras_amount_cents: '5000' } });
  }

  F.fp = { held: await stranded(), twin: await stranded() };
  HELD.push(F.fp.held.proposalId);

  F.ss = await pair({ status: 'draft', event_date: ymd(-10) });
  F.sk = await pair({ status: 'accepted', event_date: ymd(-10) });

  // The suspension and sibling cascades: client rows on the held proposal
  // directly, through its consult and through its shift, and their unheld
  // twins; plus a suppression_key group whose sent row has a held sibling.
  const later = ago(-24 * 60); // a day ahead, so never due during the suite
  const toClient = { recipient_type: 'client', recipient_id: clientId };
  F.cl = {
    held: [F.msg.held[0], F.msg.held[2], F.msg.held[3], F.hMsg.held,
      await msg('lhj_susp', 'shift', dS.held, { ...toClient, scheduled_for: later })],
    twin: [F.msg.twin[0], F.msg.twin[3], F.msg.twin[4], F.hMsg.twin,
      await msg('lhj_susp', 'shift', dS.none, { ...toClient, scheduled_for: later })],
  };
  const key = { suppression_key: `lhj:${NONCE}:sib` };
  F.sib = {
    lead: await msg('lhj_sib', 'proposal', F.d.twin, key),
    held: await msg('lhj_later', 'proposal', F.d.held, { ...key, scheduled_for: later }),
    twin: await msg('lhj_later', 'proposal', F.d.twin, { ...key, scheduled_for: later }),
  };

  // Stale bank-debit rows, the oldest the window allows, so the monitor's
  // oldest-first LIMIT keeps them.
  F.sp = await pair({ status: 'deposit_paid' });
  for (const k of ['held', 'twin']) {
    await insert('stripe_sessions', {
      proposal_id: F.sp[k], stripe_payment_intent_id: `pi_lhj_${NONCE}_sp${k}`, amount: 5000,
      status: 'processing', processing_at: ago(IN_FLIGHT_MAX_AGE_DAYS * 24 * 60 - 120),
    });
  }
  F.pe = await pair({ status: 'deposit_paid', event_date: ymd(30), event_start_time: '18:00' });

  // Thumbtack: a client awaiting an email whose rows were suppressed for want of one.
  const ttClient = await insert('clients', { name: `LHJ Client ${NONCE} tt`, email_harvest_status: 'pending' });
  made.clients.push(ttClient);
  F.tt = { ...(await pair({ client_id: ttClient })), negotiation: `lhj-${NONCE}` };
  await insert('thumbtack_leads', { negotiation_id: F.tt.negotiation, client_id: ttClient, raw_payload: '{}' });
  const rearm = (id) => msg('lhj_rearm', 'proposal', id, {
    recipient_id: ttClient, status: 'suppressed', error_message: 'client_no_email', scheduled_for: later,
  });
  F.ra = { held: await rearm(F.tt.held), twin: await rearm(F.tt.twin) };

  // Check Cherry transfers awaiting a balance invoice (the cc id is unique).
  const cc = (tag) => mkProposal({
    status: 'confirmed', transferred_from_cc_id: `lhj-${NONCE}-${tag}`, total_price: 1000,
    total_price_override: 1000, amount_paid: 100, balance_due_date: ymd(20),
  });
  F.cc = { held: await cc('h'), twin: await cc('t') };
  HELD.push(F.cc.held);

  // The positions backfill: one upcoming shift each, positions empty so a re-derive changes them.
  F.pn = await pair({ status: 'confirmed', event_date: ymd(10) });
  const pnShift = (id) => mkShift({ proposal_id: id, event_date: ymd(10), positions_needed: '[]' });
  F.pnS = { held: await pnShift(F.pn.held), twin: await pnShift(F.pn.twin) };

  // The extras script's Stripe failures: an intent Stripe cannot find, and an
  // abandoned one whose cancel fails.
  F.ef = await mkProposal({ status: 'deposit_paid' });
  F.efPi = { miss: `pi_lhj_${NONCE}_miss`, cfail: `pi_lhj_${NONCE}_cfail` };
  for (const pi of Object.values(F.efPi)) {
    await insert('stripe_sessions', { proposal_id: F.ef, stripe_payment_intent_id: pi, amount: 5000, status: 'pending' });
  }
  fakePis.set(F.efPi.cfail, { id: F.efPi.cfail, status: 'requires_payment_method', amount: 5000, metadata: { payment_type: 'drink_plan_extras', extras_amount_cents: '5000' } });

  __setLegalHoldIdsForTest(HELD);
  registerTestHandlers();

  const app = express();
  app.use(express.json());
  app.use('/api/admin/thumbtack', thumbtackAgentRouter);
  app.use('/api/admin', settingsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const P = made.proposals;
  const inv = 'SELECT id FROM invoices WHERE proposal_id = ANY($1::int[])';
  await pool.query(
    `DELETE FROM scheduled_messages
      WHERE (entity_type = 'proposal' AND entity_id = ANY($1::int[]))
         OR (entity_type = 'shift' AND entity_id = ANY($2::int[]))
         OR (entity_type = 'consult' AND entity_id = ANY($3::int[]))`,
    [P, made.shifts, made.consults]);
  // In foreign-key order. Every statement is a fixed string; only the ids are bound.
  for (const [sql, arg] of [
    ['DELETE FROM service_extensions WHERE proposal_id = ANY($1::int[])', P],
    ['DELETE FROM consults WHERE id = ANY($1::int[])', made.consults],
    [`DELETE FROM invoice_line_items WHERE invoice_id IN (${inv})`, P],
    [`DELETE FROM invoice_payments WHERE invoice_id IN (${inv})`, P],
    ...['invoices', 'proposal_payments', 'stripe_sessions', 'proposal_activity_log'].map((t) => [`DELETE FROM ${t} WHERE proposal_id = ANY($1::int[])`, P]),
    ['DELETE FROM shifts WHERE id = ANY($1::int[])', made.shifts],
    ['DELETE FROM proposals WHERE id = ANY($1::int[])', P],
    ['DELETE FROM thumbtack_leads WHERE negotiation_id = $1', `lhj-${NONCE}`],
    ['DELETE FROM clients WHERE id = ANY($1::int[])', made.clients],
    ['DELETE FROM users WHERE id = ANY($1::int[])', made.users],
  ]) await pool.query(sql, [arg]);
  await pool.end();
});

const post = async (urlPath, token, body = {}) => {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ── The jobs ─────────────────────────────────────────────────────────────────

test('dispatcher: the held proposal\'s pending, deferred and stranded rows stay as they are and unsent; the twin\'s go out', async () => {
  await rolledBack(async (tx) => {
    const start = await msgState(tx, F.msg.held);
    const s0 = calls.sent.length;
    await quiet(() => dispatcher.dispatchPending());
    assert.deepEqual(await msgState(tx, F.msg.held), start, 'every held row is exactly as it was');
    const sent = calls.sent.slice(s0);
    assert.deepEqual(sent.filter((id) => F.msg.held.includes(id)), [], 'no held row reached a handler');
    const twin = await msgState(tx, F.msg.twin);
    for (const id of F.msg.twin) assert.equal(twin[id].status, 'sent', `twin row ${id} was sent`);
  });
});

test('dead-letter resolver: a failed staff row tied to the held proposal is never re-queued or dead-lettered; the twin\'s is', async () => {
  await rolledBack(async (tx) => {
    const heldIds = Object.values(F.dl.held);
    const start = await msgState(tx, heldIds);
    await quiet(() => resolveCriticalDeadLetters());
    assert.deepEqual(await msgState(tx, heldIds), start, 'the held groups are untouched');
    const { rows } = await tx.query(
      'SELECT suppression_key FROM scheduled_messages WHERE suppression_key LIKE $1 ORDER BY suppression_key', [`lhj:${NONCE}:%:retry%`]);
    assert.deepEqual(rows.map((r) => r.suppression_key), [`lhj:${NONCE}:t0:retry1`], 'only the twin is re-queued');
    assert.equal((await msgState(tx, [F.dl.twin.two]))[F.dl.twin.two].status, 'dead_letter');
  });
});

test('balance-invoice monitor: no activity row and no email for a held proposal; the twins alert', async () => {
  await rolledBack(async (tx) => {
    const a0 = calls.admin.length;
    await quiet(() => monitorMissingBalanceInvoices());
    const { rows } = await tx.query(
      'SELECT proposal_id, action FROM proposal_activity_log WHERE proposal_id = ANY($1::int[]) AND action = ANY($2::text[])',
      [made.proposals, [OVER_ACTION, UNDER_ACTION]]);
    const flagged = new Set(rows.map((r) => `${r.proposal_id}:${r.action}`));
    for (const id of HELD) {
      for (const action of [OVER_ACTION, UNDER_ACTION]) assert.equal(flagged.has(`${id}:${action}`), false, `held #${id} got ${action}`);
    }
    assert.ok(flagged.has(`${F.mo.twin}:${OVER_ACTION}`), 'the over-billed twin alerts');
    assert.ok(flagged.has(`${F.mu.twin}:${UNDER_ACTION}`), 'the under-covered twin alerts');
    const mail = calls.admin.slice(a0).map((c) => `${c.emailHtml}\n${c.emailText}`).join('\n');
    for (const id of HELD) {
      assert.equal(mail.includes(`proposal #${id},`) || mail.includes(` #${id} `), false, `held #${id} is in the alert email`);
    }
    assert.ok(mail.includes(`proposal #${F.mo.twin},`), 'the twin is in the alert email');
  });
});

test('autopay claim: the held proposal is never claimed or charged; the twin is', async () => {
  await rolledBack(async (tx) => {
    const s0 = calls.stripe.length;
    await quiet(() => balanceScheduler.processAutopayCharges());
    const charged = calls.stripe.slice(s0).filter((c) => c.op === 'create').map((c) => c.proposalId);
    assert.equal(charged.includes(F.ap.held), false, 'the held proposal was charged');
    assert.ok(charged.includes(F.ap.twin), 'the twin is charged');
    assert.deepEqual(await col(tx, 'proposals', 'autopay_status', [F.ap.held, F.ap.twin]), { [F.ap.held]: null, [F.ap.twin]: 'in_progress' });
  });
});

test('event completion: the held proposal stays confirmed; the twin completes', async () => {
  await rolledBack(async (tx) => {
    await quiet(() => balanceScheduler.processEventCompletions());
    assert.deepEqual(await col(tx, 'proposals', 'status', [F.c.held, F.c.twin]), { [F.c.held]: 'confirmed', [F.c.twin]: 'completed' });
  });
});

test('shift-closure sweep: the held proposal\'s finished shift stays open; the twin\'s closes', async () => {
  await rolledBack(async (tx) => {
    await quiet(() => sweepFinishedShiftClosures());
    assert.deepEqual(await col(tx, 'shifts', 'status', [F.scS.held, F.scS.twin]), { [F.scS.held]: 'open', [F.scS.twin]: 'completed' });
  });
});

test('auto-assign scheduler: never picks the held proposal\'s shift; picks the twin\'s and a shift with no proposal', async () => {
  await rolledBack(async () => {
    const a0 = calls.autoAssign.length;
    await quiet(() => processScheduledAutoAssigns());
    const picked = calls.autoAssign.slice(a0);
    assert.equal(picked.includes(F.aaS.held), false, 'the held shift was auto-assigned');
    assert.ok(picked.includes(F.aaS.twin), 'the twin shift is auto-assigned');
    assert.ok(picked.includes(F.aaS.none), 'a shift with no proposal is still auto-assigned');
  });
});

test('extension expiry sweep: the held proposal\'s pending request stays pending and nobody is told; the twin\'s expires', async () => {
  await rolledBack(async (tx) => {
    const s0 = calls.staff.length;
    const a0 = calls.extAdmin.length;
    await quiet(() => sweepExpiredExtensions());
    assert.deepEqual(await col(tx, 'service_extensions', 'status', [F.xE.held, F.xE.twin]), { [F.xE.held]: 'pending', [F.xE.twin]: 'expired' });
    const told = [...calls.staff.slice(s0), ...calls.extAdmin.slice(a0)].map((c) => c.proposalId);
    assert.equal(told.includes(F.x.held), false, 'a sender was called for the held proposal');
    assert.ok(told.includes(F.x.twin));
  });
});

test('extension heal: the held proposal\'s unfinalized request is left alone; the twin\'s is finalized', async () => {
  await rolledBack(async (tx) => {
    const s0 = calls.staff.length;
    const a0 = calls.extAdmin.length;
    await quiet(() => healUnfinalizedExtensions());
    const fin = await col(tx, 'service_extensions', 'finalized_at', [F.xH.held, F.xH.twin]);
    assert.equal(fin[F.xH.held], null);
    assert.ok(fin[F.xH.twin], 'the twin is finalized');
    const told = [...calls.staff.slice(s0), ...calls.extAdmin.slice(a0)].map((c) => c.proposalId);
    assert.equal(told.includes(F.x.held), false, 'a sender was called for the held proposal');
    assert.ok(told.includes(F.x.twin));
  });
});

const BALANCE_TYPES = Object.keys(REMINDER_OFFSET_DAYS);

// The pre-event ladder reads its offsets from the dispatcher's handler
// metadata, which this suite clears: register the real metadata for the case,
// then put the suite's own handlers back.
async function withPreEventMeta(fn) {
  preEventHandlers.registerAll();
  try { return await fn(); } finally { registerTestHandlers(); }
}

// The payment webhooks reach both through depositPaidSchedulers.js, so neither may throw.
const WEBHOOK_SCHEDULERS = [
  ['balance reminders', (id) => scheduleBalanceReminders(id), () => F.br, BALANCE_TYPES, BALANCE_TYPES, 7],
  ['pre-event reminders', (id) => withPreEventMeta(() => schedulePreEventReminders(id)), () => F.pe, null, ['event_week_reminder'], 1],
];
for (const [name, run, pairOf, anyTypes, twinTypes, twinRows] of WEBHOOK_SCHEDULERS) {
  test(`${name}: a held id schedules nothing and does not throw; the twin is scheduled`, async () => {
    await rolledBack(async (tx) => {
      assert.equal((await captured(() => run(pairOf().held))).error, null);
      assert.equal(await rowCount(tx, pairOf().held, anyTypes), 0, 'rows were scheduled for the held proposal');
      await quiet(() => run(pairOf().twin));
      assert.equal(await rowCount(tx, pairOf().twin, twinTypes), twinRows, 'the twin was not scheduled');
    });
  });
}

test('monitor stale-processing pass: the held proposal\'s bank-debit row is never read or logged; the twin\'s is', async () => {
  const stale = (await findStaleProcessingPayments()).map((r) => r.proposal_id);
  assert.equal(stale.includes(F.sp.held), false, 'the held proposal\'s stale row was read');
  assert.ok(stale.includes(F.sp.twin));
  await rolledBack(async () => {
    const { lines } = await quiet(() => monitorMissingBalanceInvoices());
    const logged = (id) => lines.some((l) => l.includes(`stale_processing_payment: proposal ${id},`));
    assert.equal(logged(F.sp.held), false, 'the monitor logged the held proposal');
    assert.ok(logged(F.sp.twin));
  });
});

test('thumbtack email harvest: the re-arm never flips a held proposal\'s suppressed rows; the twin\'s re-arm', async () => {
  await rolledBack(async (tx) => {
    const res = await post('/api/admin/thumbtack/email-harvested', adminToken, { negotiation_id: F.tt.negotiation, email: `lhj-tt-${NONCE}@example.com` });
    assert.equal(res.status, 200);
    // The re-arm is fire-and-forget, but its UPDATE was queued on this
    // connection before the response went out, so this read runs after it.
    const st = await msgState(tx, [F.ra.held, F.ra.twin]);
    assert.equal(st[F.ra.held].status, 'suppressed', 'the held row was re-armed');
    assert.equal(st[F.ra.twin].status, 'pending', 'the twin was not re-armed');
  });
});

test('geocode backfill: the held proposal\'s shift is never geocoded or written; the twin\'s and an unlinked shift are', async () => {
  await rolledBack(async (tx) => {
    const g0 = calls.geocode.length;
    const res = await post('/api/admin/backfill-geocodes', adminToken);
    assert.equal(res.status, 200);
    const seen = calls.geocode.slice(g0);
    assert.equal(seen.includes(F.gLoc.held), false, 'the held shift was geocoded');
    assert.ok(seen.includes(F.gLoc.twin) && seen.includes(F.gLoc.none));
    const lat = await col(tx, 'shifts', 'lat', [F.gS.held, F.gS.twin, F.gS.none]);
    assert.deepEqual([lat[F.gS.held], lat[F.gS.twin] !== null, lat[F.gS.none] !== null], [null, true, true]);
  });
});

test('heal script: the dry run prints the held rows it leaves out and examines none of them', async () => {
  await rolledBack(async () => {
    const { withHeld, without } = await heldDelta(dryOf(await loadScript('healBalanceReminderTimes', [])), F.h.held);
    assert.notEqual(num(withHeld, HEAL_HELD), null, 'the dry run prints the held count');
    assertNoPii(withHeld, 'the heal script');
    assert.equal(num(withHeld, HEAL_HELD) - num(without, HEAL_HELD), 1, 'the held proposal\'s pending row is counted as left out');
    assert.equal(num(without, HEAL_EXAMINED) - num(withHeld, HEAL_EXAMINED), 1, 'and is not examined');
  }, { isolation: 'REPEATABLE READ' });
});

test('heal script: a write run refuses without the dry run\'s held count; with it, the twin moves and the held row never does', async () => {
  await rolledBack(async (tx) => {
    const { mod } = await loadScript('healBalanceReminderTimes', []);
    assert.equal(typeof mod.main, 'function', 'the script exports main and runs only when invoked');
    const n = num((await runScript(mod, [])).lines, HEAL_HELD);
    assert.notEqual(n, null, 'the dry run prints the held count');
    const read = () => msgState(tx, [F.hMsg.held, F.hMsg.twin]);
    const start = await read();
    await assertRefused(mod, refusals(n), read);
    assert.equal((await runScript(mod, ['--apply', '--held-excluded', String(n)])).exitCode, 0);
    const end = await read();
    assert.deepEqual(end[F.hMsg.held], start[F.hMsg.held], 'the held row never moves');
    const anchor = reminderAnchorInstant(ymd(20), REMINDER_OFFSET_DAYS.balance_due_today, 'America/Chicago');
    assert.equal(end[F.hMsg.twin].scheduled_for, anchor.toISOString(), 'the twin moves to its anchor');
  });
});

test('extras script: the held proposal is left out before any read or Stripe call and its count printed; the twin is still read', async () => {
  await rolledBack(async () => {
    const s0 = calls.stripe.length;
    const held = await dryOf(await loadScript('backfillExtrasInvoices', [String(F.e.held), '--dry-run']), [String(F.e.held), '--dry-run'])();
    assert.deepEqual(calls.stripe.slice(s0).filter((c) => c.id === F.ePi.held), [], 'no Stripe call for the held proposal');
    assert.equal(num(held, EXTRAS_HELD), 1, 'the dry run prints the held count');
    const twin = await runScript(loadedScripts.get('backfillExtrasInvoices').mod, [String(F.e.twin), '--dry-run']);
    assert.equal(num(twin.lines, EXTRAS_HELD), 0);
    assertNoPii([...held, ...twin.lines], 'the extras script');
    assert.deepEqual(calls.stripe.slice(s0).filter((c) => c.id === F.ePi.twin).map((c) => c.op), ['retrieve']);
  });
});

test('extras script: a write run refuses without the held count; with it, the twin proceeds and the held proposal is never read', async () => {
  await rolledBack(async () => {
    const { mod } = await loadScript('backfillExtrasInvoices', [String(F.e.held), '--dry-run']);
    assert.equal(typeof mod.main, 'function', 'the script exports main and runs only when invoked');
    const s0 = calls.stripe.length;
    const twin = String(F.e.twin);
    await assertRefused(mod, [[twin], [twin, '--held-excluded', '1'], [twin, '--held-excluded']], async () => calls.stripe.length);
    assert.equal((await runScript(mod, ['--held-excluded', '0', twin])).exitCode, 0);
    assert.deepEqual(calls.stripe.slice(s0).map((c) => `${c.op} ${c.id}`), [`retrieve ${F.ePi.twin}`, `cancel ${F.ePi.twin}`]);
    const s1 = calls.stripe.length;
    assert.equal((await runScript(mod, [String(F.e.held), '--held-excluded', '1'])).exitCode, 0);
    assert.deepEqual(calls.stripe.slice(s1), [], 'nothing is read or cancelled for the held proposal');
  });
});

test('extras script: a failed Stripe retrieve or cancel exits 1, and the run still finishes its loop', async () => {
  await rolledBack(async () => {
    const { mod } = await loadScript('backfillExtrasInvoices', [String(F.e.held), '--dry-run']);
    assert.equal(typeof mod.main, 'function', 'the script exports main and runs only when invoked');
    const s0 = calls.stripe.length;
    const r = await runScript(mod, [String(F.ef), '--held-excluded', '0']);
    assert.deepEqual([r.error, r.exitCode], [null, 1], 'a Stripe failure must exit 1');
    const ops = calls.stripe.slice(s0).map((c) => `${c.op} ${c.id}`).sort();
    assert.deepEqual(ops, [`cancel ${F.efPi.cfail}`, `retrieve ${F.efPi.cfail}`, `retrieve ${F.efPi.miss}`]);
  });
});

const fpLine = (lines, id) => lines.find((l) => new RegExp(`^(SKIP|WOULD) +#${id} `).test(l)) || '(no line)';

test('full-payment backfill: the held proposal is never selected and its count is printed; the twin is a WOULD line; no line names a client', async () => {
  const selected = (await fullPay.selectCandidates(pool)).map((r) => r.proposal_id);
  assert.equal(selected.includes(F.fp.held.proposalId), false, 'the held proposal was selected');
  assert.ok(selected.includes(F.fp.twin.proposalId));
  await rolledBack(async () => {
    const { withHeld, without } = await heldDelta(async () => (await runScript(fullPay, ['node', 'x'])).lines, F.fp.held.proposalId);
    assert.equal(fpLine(withHeld, F.fp.held.proposalId), '(no line)', 'the held proposal has a line');
    assert.match(fpLine(withHeld, F.fp.twin.proposalId), /^WOULD /);
    assert.equal(num(withHeld, FP_HELD) - num(without, FP_HELD), 1, 'the held proposal is counted as left out');
    assertNoPii([...withHeld, ...without], 'the full-payment backfill');
  }, { isolation: 'REPEATABLE READ' });
});

test('full-payment backfill: an apply whose --expect names the held proposal refuses and writes nothing', async () => {
  await rolledBack(async (tx) => {
    const dry = await runScript(fullPay, ['node', 'x']);
    assert.equal(fpLine(dry.lines, F.fp.held.proposalId), '(no line)', 'the dry run leaves the held proposal out');
    const r = await runScript(fullPay, ['node', 'x', '--apply', '--expect', `${F.fp.held.proposalId},${F.fp.twin.proposalId}`]);
    assert.equal(r.exitCode, 2);
    const refusal = r.errors.find((l) => l.startsWith('REFUSING')) || '';
    const missing = JSON.parse((/missing=(\[[^\]]*\])/.exec(refusal) || [null, '[]'])[1]);
    assert.ok(missing.includes(F.fp.held.proposalId), 'the held proposal is not in the selection');
    const labels = await col(tx, 'invoices', 'label', [F.fp.held.invoiceId, F.fp.twin.invoiceId]);
    assert.deepEqual(Object.values(labels), ['Deposit', 'Deposit']);
  });
});

test('Check Cherry balance script: the held proposal is left out and counted and no line names a client; the twin would mint', async () => {
  await rolledBack(async () => {
    const { withHeld, without } = await heldDelta(dryOf(await loadScript('scripts/cc-balance-invoice', [])), F.cc.held);
    const says = (lines, id) => lines.some((l) => new RegExp(`#${id}\\b`).test(l));
    assert.equal(says(withHeld, F.cc.held), false, 'the held proposal is in the run');
    assert.ok(withHeld.some((l) => l.startsWith(`WOULD MINT #${F.cc.twin}`)) && says(without, F.cc.held));
    assert.equal(num(withHeld, EXTRAS_HELD) - num(without, EXTRAS_HELD), 1, 'the held proposal is counted as left out');
    assertNoPii(withHeld, 'the Check Cherry balance script');
  }, { isolation: 'REPEATABLE READ' });
});

test('stale-proposal sweep: archiveOne refuses a held id through isLegalHold; the twin archives', async () => {
  await rolledBack(async (tx) => {
    assert.equal((await quiet(() => sweep.archiveOne(F.ss.held))).value, null);
    assert.equal((await quiet(() => sweep.archiveOne(F.ss.twin))).value?.proposalId, F.ss.twin);
    assert.deepEqual(await col(tx, 'proposals', 'status', [F.ss.held, F.ss.twin]), { [F.ss.held]: 'draft', [F.ss.twin]: 'archived' });
  });
});

test('stale-proposal sweep: its two queries never pick the held proposal; the twins are picked', async () => {
  const cand = (await sweep.selectCandidates()).map((r) => r.id);
  assert.equal(cand.includes(F.ss.held), false, 'the held draft is a sweep candidate');
  assert.ok(cand.includes(F.ss.twin));
  const skip = (await sweep.selectSkipCandidates()).map((r) => r.id);
  assert.equal(skip.includes(F.sk.held), false, 'the held accepted proposal is a skip candidate');
  assert.ok(skip.includes(F.sk.twin));
});

test('suspension cascade: never suppresses a client row tied to the held proposal; the twin\'s rows are suppressed', async () => {
  await rolledBack(async (tx) => {
    const start = await msgState(tx, F.cl.held);
    await quiet(() => suspendClientAutomation(clientId));
    assert.deepEqual(await msgState(tx, F.cl.held), start, 'a held row was suppressed');
    const twin = await msgState(tx, F.cl.twin);
    for (const id of F.cl.twin) assert.equal(twin[id].status, 'suppressed', `twin row ${id} is suppressed`);
  });
});

test('sibling cascade: a sent row never suppresses a sibling tied to the held proposal; the twin sibling is', async () => {
  await rolledBack(async (tx) => {
    await quiet(() => dispatcher.dispatchPending());
    const st = await msgState(tx, [F.sib.lead, F.sib.held, F.sib.twin]);
    assert.equal(st[F.sib.lead].status, 'sent');
    assert.equal(st[F.sib.twin].status, 'suppressed_by_sibling');
    assert.equal(st[F.sib.held].status, 'pending', 'the held sibling was suppressed');
  });
});

// The shift-closure and positions backfills: a dry run counts and never plans
// the held shift, and a write run refuses without the count.
for (const [name, heldOf, shiftOf, planLine, readCol, changed] of [
  ['backfillShiftClosures', () => F.sc.held, () => F.scS, (id) => `shift #${id} `, 'status', (v) => v === 'completed'],
  ['scripts/backfill-positions-needed', () => F.pn.held, () => F.pnS, (id) => `shift ${id} (`, 'positions_needed', (v) => v !== '[]'],
]) {
  test(`${name}: the dry run counts the held shift it leaves out, plans none of it, and prints no name`, async () => {
    await rolledBack(async () => {
      const { withHeld, without } = await heldDelta(dryOf(await loadScript(name, [])), heldOf());
      assert.notEqual(num(withHeld, CLOSE_HELD), null, 'the dry run prints the held count');
      assertNoPii(withHeld, name);
      assert.equal(num(withHeld, CLOSE_HELD) - num(without, CLOSE_HELD), 1, 'the held shift is counted as left out');
      const plans = (lines, id) => lines.some((l) => l.includes(planLine(id)));
      assert.equal(plans(withHeld, shiftOf().held), false, 'the held shift is in the plan');
      assert.ok(plans(withHeld, shiftOf().twin) && plans(without, shiftOf().held));
    }, { isolation: 'REPEATABLE READ' });
  });

  test(`${name}: a write run refuses without the held count; with it the twin's shift is written and the held one never is`, async () => {
    await rolledBack(async (tx) => {
      const { mod } = await loadScript(name, []);
      assert.equal(typeof mod.main, 'function', 'the script exports main and runs only when invoked');
      const n = num((await runScript(mod, [])).lines, CLOSE_HELD);
      assert.notEqual(n, null, 'the dry run prints the held count');
      const { held, twin } = shiftOf();
      const read = () => col(tx, 'shifts', readCol, [held, twin]);
      const start = await read();
      await assertRefused(mod, refusals(n), read);
      const ok = await runScript(mod, ['--apply', '--held-excluded', String(n)]);
      assert.equal(ok.exitCode, 0);
      assertNoPii(ok.lines, name);
      const end = await read();
      assert.equal(end[held], start[held], 'the held shift was written');
      assert.ok(changed(end[twin]), 'the twin shift was not written');
    });
  });
}

// ── The list missing: every job throws before any write ──────────────────────

const MISSING = [
  ['the dispatcher tick', () => dispatcher.dispatchPending()],
  ['the dead-letter resolver', () => resolveCriticalDeadLetters()],
  ['the balance-invoice monitor', () => monitorMissingBalanceInvoices()],
  ['the stale-processing read', () => findStaleProcessingPayments()],
  ['the autopay claim', () => balanceScheduler.processAutopayCharges()],
  ['the event-completion update', () => balanceScheduler.processEventCompletions()],
  ['the shift-closure sweep', () => sweepFinishedShiftClosures()],
  ['the auto-assign scheduler', () => processScheduledAutoAssigns()],
  ['the extension expiry sweep', () => sweepExpiredExtensions()],
  ['the extension heal', () => healUnfinalizedExtensions()],
  ['the stale sweep archive', () => sweep.archiveOne(F.ss.twin)],
  ['the stale sweep run', () => sweep.processStaleProposals()],
  ['the client-automation suspension', () => suspendClientAutomation(clientId)],
  ['the full-payment backfill', () => fullPay.main(['node', 'x'])],
];

for (const [name, run] of MISSING) {
  test(`list missing: ${name} throws before any write`, async () => {
    await rolledBack(async (tx) => {
      const before0 = callCounts();
      const r = await captured(() => withListMissing(run));
      assert.ok(r.error, `${name} ran with the list missing`);
      assert.match(String(r.error.message), /LEGAL_HOLD_PROPOSAL_IDS/);
      assert.equal(await wrote(tx), false, 'a row was written');
      assert.deepEqual(callCounts(), before0, 'a provider or sender was called');
    });
  });
}

for (const [name, loadArgs, args] of [
  ['healBalanceReminderTimes', () => [], () => ['--apply', '--held-excluded', '0']],
  ['backfillExtrasInvoices', () => [String(F.e.held), '--dry-run'], () => [String(F.e.twin), '--held-excluded', '0']],
  ['backfillShiftClosures', () => [], () => ['--apply', '--held-excluded', '0']],
  ['scripts/cc-balance-invoice', () => [], () => []],
  ['scripts/backfill-positions-needed', () => [], () => ['--apply', '--held-excluded', '0']],
]) {
  test(`list missing: the ${name} script throws before any read of its rows or any write`, async () => {
    await rolledBack(async (tx) => {
      const { mod } = await loadScript(name, loadArgs());
      assert.equal(typeof mod.main, 'function', 'the script exports main and runs only when invoked');
      const before0 = callCounts();
      const r = await withListMissing(() => runScript(mod, args()));
      assert.match(String(r.error && r.error.message), /LEGAL_HOLD_PROPOSAL_IDS/);
      assert.equal(await wrote(tx), false, 'a row was written');
      assert.deepEqual(callCounts(), before0, 'Stripe was called');
    });
  });
}

test('list missing: the geocode backfill answers 500 before it geocodes or writes anything', async () => {
  await rolledBack(async (tx) => {
    const before0 = callCounts();
    const r = await captured(() => withListMissing(() => post('/api/admin/backfill-geocodes', adminToken)));
    assert.equal(r.error, null);
    assert.equal(r.value.status, 500);
    assert.equal(await wrote(tx), false, 'a row was written');
    assert.deepEqual(callCounts(), before0, 'an address was geocoded');
  });
});

for (const [name, run, pairOf, anyTypes] of WEBHOOK_SCHEDULERS) {
  test(`list missing: ${name} schedule nothing, log once and never throw`, async () => {
    await rolledBack(async (tx) => {
      const r = await captured(() => withListMissing(() => run(pairOf().twin)));
      assert.equal(r.error, null, 'it threw (a payment webhook reaches it)');
      assert.equal(await rowCount(tx, pairOf().twin, anyTypes), 0, 'rows were scheduled with the list missing');
      assert.equal(r.errors.length, 1, 'one console.error');
      assert.equal(await wrote(tx), false, 'a row was written');
    });
  });
}
