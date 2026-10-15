'use strict';

// The Gmail sync tick (spec 2026-10-14 section 5.5), registered in
// server/index.js as the 60-second gmail_sync scheduler. Each tick:
//   1. with GMAIL_SERVICE_ACCOUNT_KEY unset, does nothing (createGmailClient
//      returns null);
//   2. inserts the single gmail_sync_state row if it is missing, then claims
//      its lease with one statement; no row back means another instance (a
//      deploy runs two side by side) holds it, and the tick ends;
//   3. first sync: reads the mailbox's history id BEFORE the first page, then
//      lists mail since the history floor in two passes, Sent first and then
//      everything else, page by page, each page oldest first. Sent goes first
//      because the listing runs newest first: a reply or a bounce must find
//      its Sent row already stored, or rule 9 and the bounce rule miss it for
//      good. Steady state: history.list from the stored id. Lost history
//      (Google keeps about a week): the same listing from last_ok_at minus a
//      day, its date fixed in the cursor so it holds while last_ok_at moves;
//   4. reads each message, applies the counting rules (gmailRules.js) and
//      stores what counts, one transaction per message, every side effect
//      gated on the insert returning a row. The personal judgment
//      (personalMail.js) runs in that transaction, before the insert, and is
//      stored on the row: it is made once, here, and never again;
//   5. stops at GMAIL_SYNC_MAX_PER_TICK messages or GMAIL_SYNC_TICK_MS.
//
// Progress survives the tick. Ids already stored, and ids skipped for good,
// are passed over before any fetch and never count toward the cap. A listing
// page keeps the ids it already handled in its cursor (backfill_page holds
// { after, phase, page, done } as JSON), and a history window advances record
// by record, so a window larger than one tick finishes across ticks without
// fetching anything twice (carry-forward 2). A history listing stops at half
// the wall time or four times the cap of ids, leaving the rest of the tick for
// reading mail, and a tick that saw mail waiting but moved nothing is recorded
// as a failure named NoProgress rather than an ok.
//
// A message that fails (anything after the fetch, or a Gmail request error on
// that one message) is recorded in gmail_sync_skips and the tick goes on; it
// holds the window until its third failure, when it is skipped for good with
// one Sentry warning. Of the database's errors only a data error (SQLSTATE
// class 22 or 23) is the message's fault; any other is the tick failing
// (isDbOutage). A message Gmail leaves unavailable at the API while it answers
// another fetch that tick (or the probe, its profile) is held, counted apart,
// and skipped for good after GMAIL_UNAVAILABLE_SKIP_TICKS such ticks, the
// window moving past it on the strike that skips it; no answer at all is an
// outage, which counts against no message. A token that will not mint is the
// tick failing, never the message being fetched. A message that vanished
// before the fetch is dropped (carry-forward 1). Any other Gmail error ends
// the tick: its class goes in last_error, and from the third failure in a row
// Sentry hears at most once an hour. A cursor write that finds another owner
// on the lease (a deploy) stops the tick.
//
// Nothing here logs or reports mail: logs, last_error, the skip row and Sentry
// carry an error class (with its stage) and counts, never a body, a subject or
// an address. The Gmail message id, an opaque token, is the one identifier.

const crypto = require('node:crypto');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { createGmailClient, GmailError } = require('../gmailClient');
const { chicagoYmdOf } = require('../businessTime');
const cache = require('./cache');
const { loadEmailIndex } = require('./people');
const { findOrCreateLead, createLead } = require('./zolaLeads');
const { fallbackLabel } = require('./zolaMail');
const rules = require('./gmailRules');
const personalMail = require('./personalMail');
const {
  INBOX_HISTORY_START, GMAIL_SYNC_MAX_PER_TICK, GMAIL_SYNC_TICK_MS, GMAIL_LEASE_SECONDS, GMAIL_SKIP_ATTEMPTS, GMAIL_FAILING_TICKS,
} = require('./constants');

const HISTORY_TYPES = Object.freeze(['messageAdded', 'labelAdded']);
// A sanity bound on list calls per tick; the wall time bounds them first.
const MAX_PAGES_PER_TICK = 20;
// A history listing leaves the second half of the tick, and anything past
// four ticks' worth of ids, for later ticks (the cursor moves record by record).
const HISTORY_LIST_MS = GMAIL_SYNC_TICK_MS / 2;
const HISTORY_LIST_IDS = 4 * GMAIL_SYNC_MAX_PER_TICK;
const FAIL_WARN_MS = 60 * 60 * 1000;
const GATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const GATE_WARN_AT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_ID_RE = /^\d{1,20}$/;
// Gmail's after: in epoch seconds; a YYYY/MM/DD date is read at Pacific midnight.
const AFTER_RE = /^\d{9,11}$/;
// The listing's two passes and their queries.
const PHASES = new Set(['sent', 'all']);
const queryFor = (cur) => (cur.phase === 'sent' ? `in:sent after:${cur.after}` : `-in:sent after:${cur.after}`);
const PAGE_TOKEN_MAX = 1024;
const DONE_MAX = 1000;
const HANDLED = 'handled';
const HELD = 'held';
// The ticks one message may be the only call Gmail leaves unanswered before
// it is skipped for good (spec decision 20: one message never stops the feed).
const GMAIL_UNAVAILABLE_SKIP_TICKS = 20;
const ANSWERED = new Set(['GmailNotFoundError', 'GmailRequestError']);

const SQL = Object.freeze({
  ensureState: 'INSERT INTO gmail_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING',
  // One statement claims the lease (spec 5.5). Its own owner may re-claim: a
  // release that failed must not lock this instance out for the lease's span.
  claim: `UPDATE gmail_sync_state
             SET lease_owner = $1, lease_until = NOW() + make_interval(secs => $2), updated_at = NOW()
           WHERE id = 1 AND (lease_until IS NULL OR lease_until < NOW() OR lease_owner = $1)
       RETURNING history_id, backfill_page, backfill_done, last_ok_at`,
  release: `UPDATE gmail_sync_state SET lease_owner = NULL, lease_until = NULL, updated_at = NOW()
             WHERE id = 1 AND lease_owner = $1`,
  // Every cursor write names the lease owner: an instance that lost its lease
  // never moves the cursor.
  startList: `UPDATE gmail_sync_state SET history_id = $2, backfill_page = $3, backfill_done = false, updated_at = NOW()
               WHERE id = 1 AND lease_owner = $1`,
  savePage: 'UPDATE gmail_sync_state SET backfill_page = $2, updated_at = NOW() WHERE id = 1 AND lease_owner = $1',
  finishList: `UPDATE gmail_sync_state SET backfill_page = NULL, backfill_done = true, updated_at = NOW()
                WHERE id = 1 AND lease_owner = $1`,
  saveHistory: 'UPDATE gmail_sync_state SET history_id = $2, updated_at = NOW() WHERE id = 1 AND lease_owner = $1',
  tickOk: `UPDATE gmail_sync_state SET last_ok_at = NOW(), consecutive_errors = 0, updated_at = NOW()
            WHERE id = 1 AND lease_owner = $1`,
  tickError: `UPDATE gmail_sync_state SET last_error = $1, consecutive_errors = consecutive_errors + 1, updated_at = NOW()
               WHERE id = 1 AND lease_owner = $2 RETURNING consecutive_errors`,
  storedIds: 'SELECT gmail_id FROM gmail_messages WHERE gmail_id = ANY($1::text[])',
  skipRows: 'SELECT gmail_id, attempts, unavailable FROM gmail_sync_skips WHERE gmail_id = ANY($1::text[])',
  // Our stored Sent mail (never our auto-replies) this inbound names
  // (In-Reply-To or References) or shares a thread with: the bounce rule and
  // the reply rule read them. The named rows sort first, so a long thread
  // cannot crowd them out of the limit.
  sentRefs: `SELECT message_id_header, thread_id FROM gmail_messages
              WHERE direction = 'out' AND kind = 'message' AND (message_id_header = ANY($1::text[]) OR thread_id = $2)
              ORDER BY COALESCE(message_id_header = ANY($1::text[]), false) DESC, id DESC
              LIMIT 100`,
  insert: `INSERT INTO gmail_messages
             (gmail_id, thread_id, direction, kind, from_address, from_name, to_addresses, subject, text,
              attachments, message_id_header, in_reply_to, at, bounced_to, personal, personal_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13, $14::text[], $15, $16::text[])
           ON CONFLICT (gmail_id) DO NOTHING
           RETURNING id`,
  // The report's failed recipients join the Sent row's; a report that names
  // none, or a row already failed whole, leaves it failed whole (NULL).
  markBounced: `UPDATE gmail_messages
                   SET failed = true,
                       bounced_to = CASE
                         WHEN COALESCE(cardinality($2::text[]), 0) = 0 OR (failed AND COALESCE(cardinality(bounced_to), 0) = 0) THEN NULL
                         ELSE ARRAY(SELECT DISTINCT a FROM unnest(COALESCE(bounced_to, '{}') || $2::text[]) AS a ORDER BY a)
                       END
                 WHERE direction = 'out' AND message_id_header = ANY($1::text[])`,
  linkLead: 'UPDATE gmail_messages SET zola_lead_id = $1 WHERE id = $2',
  recordSkip: `INSERT INTO gmail_sync_skips (gmail_id, attempts, last_error) VALUES ($1, 1, $2)
               ON CONFLICT (gmail_id) DO UPDATE
                  SET attempts = gmail_sync_skips.attempts + 1, last_error = EXCLUDED.last_error, updated_at = NOW()
               RETURNING attempts`,
  clearSkip: 'DELETE FROM gmail_sync_skips WHERE gmail_id = $1',
  recordUnavailable: `INSERT INTO gmail_sync_skips (gmail_id, attempts, unavailable, last_error) VALUES ($1, 0, 1, $2)
                      ON CONFLICT (gmail_id) DO UPDATE
                         SET unavailable = gmail_sync_skips.unavailable + 1, last_error = EXCLUDED.last_error, updated_at = NOW()
                      RETURNING unavailable`,
  // The personal judgment's two lookups (personalMail.js), sent on the
  // message's transaction connection.
  ...personalMail.SQL,
});

// Module level, like readJob.js's warnings: one process, one clock.
let lastFailWarnAt = 0;
let lastGateWarnAt = 0;
let lastResetWarnAt = 0;
let gateFailures = [];

// ─── small helpers ───

const SAFE_CLASS_RE = /^[A-Za-z0-9_:. -]{1,80}$/;

// The class of an error and, for a Gmail error, the stage that refused. A pg
// error adds its SQLSTATE. Never the message: a pg message can quote a value,
// and a Gmail body is someone's mail.
function errorClassOf(err) {
  let cls;
  if (err && typeof err.class === 'string') {
    cls = err.stage ? `${err.class}:${err.stage}` : err.class;
  } else {
    const name = err && err.constructor && err.constructor.name;
    const code = err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? ` ${err.code}` : '';
    cls = `${name || 'Error'}${code}`;
  }
  return SAFE_CLASS_RE.test(cls) ? cls : 'Error';
}

const statusOf = (err) => (err && Number.isInteger(err.status) ? err.status : null);
const shapeError = () => new GmailError('GmailShapeError', 0, 'api');
// NoProgress: a window with mail in it that moved nothing (no fetch, no
// cursor write). LeaseLost: a cursor write found another owner on the lease.
const tickError = (cls) => Object.assign(new Error(cls), { name: `${cls}Error`, class: cls });

// The errors the database threw on one message's path, so the message's
// catch can tell the database's trouble from the message's own fault.
const dbErrors = new WeakSet();
const marked = (fn) => async (...args) => {
  try { return await fn(...args); } catch (err) { if (err && typeof err === 'object') dbErrors.add(err); throw err; }
};
const markedDb = (db) => ({
  query: marked((...a) => db.query(...a)),
  connect: marked(async () => {
    const conn = await db.connect();
    return { query: marked((...a) => conn.query(...a)), release: (...a) => conn.release(...a) };
  }),
});
// Only a value the database refuses is the message's fault: SQLSTATE class 22
// (data exception: too long, a bad value) or 23 (integrity constraint), which
// would fail it the same way on every attempt. Anything else is the database
// in trouble and fails the tick, never the message (re-review 2026-10-15):
// no SQLSTATE (a dropped connection, a pool timeout, a Node errno such as
// EPIPE), a missing column after a failed migration (42), Neon's proxy (XX000),
// a deadlock or a serialization failure (40), a lock or statement timeout.
function isDbOutage(err) {
  if (!dbErrors.has(err)) return false;
  const code = typeof err.code === 'string' ? err.code : '';
  return !/^2[23][0-9A-Z]{3}$/.test(code);
}
const validHistoryId = (v) => (typeof v === 'string' || typeof v === 'number') && HISTORY_ID_RE.test(String(v));
const unique = (ids) => [...new Set(ids)];
const epochSeconds = (ms) => String(Math.floor(ms / 1000));
const floorAfter = () => epochSeconds(Date.parse(INBOX_HISTORY_START));

// The dated resync (spec 5.5 step 3): last_ok_at minus one day, never earlier
// than the history floor.
function resyncAfter(lastOkAt) {
  const t = lastOkAt ? new Date(lastOkAt).getTime() : Number.NaN;
  if (!Number.isFinite(t)) return floorAfter();
  return epochSeconds(Math.max(t - DAY_MS, Date.parse(INBOX_HISTORY_START)));
}

// backfill_page is the listing's cursor: the query's start (epoch seconds),
// the pass (sent, then all), the page token, and the ids of that page already
// handled. Anything unreadable starts the listing over from the floor, which
// is idempotent.
function readCursor(raw) {
  const fresh = { after: floorAfter(), phase: 'sent', page: null, done: [] };
  if (typeof raw !== 'string' || raw === '') return fresh;
  let c;
  try { c = JSON.parse(raw); } catch { return fresh; }
  if (!c || typeof c !== 'object' || !AFTER_RE.test(c.after) || !PHASES.has(c.phase)) return fresh;
  return {
    after: c.after,
    phase: c.phase,
    page: typeof c.page === 'string' && c.page && c.page.length <= PAGE_TOKEN_MAX ? c.page : null,
    done: Array.isArray(c.done) ? c.done.filter((id) => typeof id === 'string' && rules.GMAIL_ID_RE.test(id)).slice(0, DONE_MAX) : [],
  };
}
const writeCursor = (c) => JSON.stringify({ after: c.after, phase: c.phase, page: c.page || null, done: (c.done || []).slice(0, DONE_MAX) });

// ─── the state row ───

async function ensureStateRow(db) {
  await db.query(SQL.ensureState);
}

async function claimLease(db, owner) {
  const { rows } = await db.query(SQL.claim, [owner, GMAIL_LEASE_SECONDS]);
  return rows[0] || null;
}

async function releaseLease(db, owner) {
  await db.query(SQL.release, [owner]);
}

// A cursor write; one that changes no row found another owner on the lease
// (a deploy runs two instances side by side), and the tick stops there.
async function writeState(ctx, sql, ...params) {
  const res = await ctx.db.query(sql, [ctx.owner, ...params]);
  if (res && res.rowCount === 0) throw tickError('LeaseLost');
}

// ─── warnings ───

function warnFailing(ctx, err, consecutive) {
  const t = ctx.deps.now();
  if (lastFailWarnAt && t - lastFailWarnAt < FAIL_WARN_MS) return;
  lastFailWarnAt = t;
  ctx.deps.sentry.captureMessage('gmail_sync is failing', {
    level: 'warning',
    tags: { scheduler: 'gmail_sync', issue: 'failing' },
    extra: { error: errorClassOf(err), status: statusOf(err), consecutive_errors: consecutive },
  });
}

// Spec 5.6: a notice from Zola's address that fails the gate (its From, its
// authentication, or not addressed to us) is dropped and counted; three in a
// day send one Sentry warning, which names no address and no content.
function noteGateFailure(ctx) {
  const t = ctx.deps.now();
  gateFailures = gateFailures.filter((at) => t - at < GATE_WINDOW_MS);
  gateFailures.push(t);
  if (gateFailures.length < GATE_WARN_AT || (lastGateWarnAt && t - lastGateWarnAt < GATE_WINDOW_MS)) return;
  lastGateWarnAt = t;
  ctx.deps.sentry.captureMessage('gmail_sync dropped Zola notices that failed the gate (authentication, or not addressed to us)', {
    level: 'warning',
    tags: { scheduler: 'gmail_sync', issue: 'zola_gate' },
    extra: { failures_24h: gateFailures.length },
  });
}

// A page token Gmail refuses (it expired, or the query changed under it)
// would otherwise fail every tick on the same page. The pass starts over from
// its first page; stored ids are passed over without a fetch.
async function restartPass(ctx, cur, err) {
  const cls = errorClassOf(err);
  await writeState(ctx, SQL.savePage, writeCursor({ after: cur.after, phase: cur.phase, page: null, done: [] }));
  console.warn(`[gmail_sync] Gmail refused the listing's page token (${cls}); the ${cur.phase} pass starts over`);
  const t = ctx.deps.now();
  if (lastResetWarnAt && t - lastResetWarnAt < FAIL_WARN_MS) return;
  lastResetWarnAt = t;
  ctx.deps.sentry.captureMessage('gmail_sync restarted a listing pass: Gmail refused its page token', {
    level: 'warning',
    tags: { scheduler: 'gmail_sync', issue: 'page_token' },
    extra: { error: cls, phase: cur.phase },
  });
}

// ─── one message ───

// A message failed: record it, and hold the window until it is skipped for
// good, at its third failure after the fetch, or at its twentieth tick of
// Gmail answering everything but it (unavailable: true).
async function failMessage(ctx, id, err, unavailable = false) {
  const cls = errorClassOf(err);
  const limit = unavailable ? GMAIL_UNAVAILABLE_SKIP_TICKS : GMAIL_SKIP_ATTEMPTS;
  ctx.sum.failed += 1;
  let n;
  try {
    const { rows } = await ctx.db.query(unavailable ? SQL.recordUnavailable : SQL.recordSkip, [id, cls]);
    n = Number(rows[0] && (unavailable ? rows[0].unavailable : rows[0].attempts)) || 1;
  } catch (dbErr) {
    console.warn(`[gmail_sync] message ${id} failed (${cls}) and its skip row could not be written (${errorClassOf(dbErr)})`);
    return HELD;
  }
  const what = unavailable ? 'ticks unavailable' : 'failures';
  if (n < limit) {
    console.warn(`[gmail_sync] message ${id} failed, ${n} ${what}: ${cls}`);
    return HELD;
  }
  ctx.sum.skipped += 1;
  console.warn(`[gmail_sync] message ${id} skipped for good after ${n} ${what}: ${cls}`);
  ctx.deps.sentry.captureMessage('gmail_sync skipped a message for good', {
    level: 'warning',
    tags: { scheduler: 'gmail_sync', issue: 'skip' },
    extra: { gmail_id: id, error: cls, attempts: n },
  });
  return HANDLED;
}

// Gmail answered a fetch: every message it left unanswered before is that
// message's own trouble (the evidence comes after it, so an outage that
// starts mid-tick strikes nobody). The strike that skips one for good hands
// it to its window's handled set, so the window moves past it that tick.
async function strikePending(ctx) {
  const list = ctx.pending;
  ctx.pending = [];
  for (const { id, err, handled } of list) {
    if (await failMessage(ctx, id, err, true) === HANDLED) handled.add(id);
  }
}

// With no later fetch to tell: ask Gmail for the mailbox's profile, which
// needs nothing stored and no message of ours to answer. An answer is Gmail
// up, so the held messages are struck; none is an outage: the tick fails with
// the held message's error (or the probe's own, when it was refused for auth)
// and no message is struck.
async function settlePending(ctx) {
  if (!ctx.pending.length) return;
  const probe = await ctx.client.getProfile();
  if (!probe || probe.error) {
    const err = probe && probe.error && probe.error.class === 'GmailAuthError' ? probe.error : ctx.pending[0].err;
    ctx.pending = [];
    throw err;
  }
  await strikePending(ctx);
}

async function sentRefsOf(db, m) {
  if (m.direction !== 'in') return { storedSentIds: new Set(), sentInThread: false };
  const named = unique([m.inReplyTo, ...m.references].filter(Boolean));
  const { rows } = await db.query(SQL.sentRefs, [named, m.threadId]);
  return {
    storedSentIds: new Set(rows.map((r) => r.message_id_header).filter((h) => named.includes(h))),
    sentInThread: rows.some((r) => r.thread_id === m.threadId),
  };
}

// The recipients a delivery report says failed (gmailRules' bouncedTo), as
// stored: lowercased, once each, bounded like to_addresses.
function bouncedToOf(verdict) {
  const list = Array.isArray(verdict.bouncedTo) ? verdict.bouncedTo : [];
  return unique(list.filter((a) => typeof a === 'string').map((a) => a.trim().toLowerCase())
    .filter((a) => a && a.length <= rules.ADDRESS_MAX)).slice(0, rules.RECIPIENTS_MAX);
}

function insertParams(id, m, verdict, bouncedTo, mine) {
  // Lane email-feed stores a Zola notice without its words (there is no body
  // parser yet), and a bounce without its report, which quotes our own mail.
  // A body with no words is null, never blank: readGmail reads empty_body as
  // (text IS NULL).
  const words = typeof m.text === 'string' && m.text.trim() ? m.text : null;
  const bounce = verdict.kind === 'bounce';
  const text = verdict.kind === 'zola_unparsed' || bounce ? null : words;
  // A bounce's in_reply_to is the Sent row it marked (In-Reply-To's, else the
  // last stored References entry), the one readGmail places it with.
  const inReplyTo = bounce && Array.isArray(verdict.bounced) && verdict.bounced[0] ? verdict.bounced[0] : m.inReplyTo;
  return [
    id, m.threadId || id, m.direction, verdict.kind, m.fromAddress, m.fromName, m.recipients, m.subject, text,
    m.attachments, m.messageIdHeader, inReplyTo, m.at, bouncedTo.length ? bouncedTo : null, mine.personal, mine.personalTo,
  ];
}

// The personal judgment, the insert and its side effects, one transaction on
// one connection. Returns true when the row is new. A judgment that cannot
// run throws like any other statement here, so the mail is never stored
// without it.
async function storeMessage(ctx, id, m, verdict, hasSkipRow, index) {
  const conn = await ctx.mdb.connect();
  let broken = false;
  const bouncedTo = verdict.kind === 'bounce' ? bouncedToOf(verdict) : [];
  try {
    await conn.query('BEGIN');
    const mine = await personalMail.judgePersonal(conn, m, verdict, index);
    const ins = await conn.query(SQL.insert, insertParams(id, m, verdict, bouncedTo, mine));
    const rowId = ins.rows.length ? ins.rows[0].id : null;
    // The insert gate (spec 5.5 step 4): a re-processed id does nothing else.
    if (rowId !== null && verdict.kind === 'bounce') await conn.query(SQL.markBounced, [verdict.bounced, bouncedTo]);
    if (rowId !== null && verdict.zola) {
      // A subject that names the couple joins their lead; one that names
      // nobody gets a FRESH lead (spec 5.6), so two couples who write on the
      // same day never share one.
      const lead = verdict.zola.label
        ? await findOrCreateLead(conn, { label: verdict.zola.label })
        : await createLead(conn, { label: fallbackLabel(chicagoYmdOf(m.at)) });
      await conn.query(SQL.linkLead, [lead.id, rowId]);
    }
    // In the transaction: a failure after COMMIT would record a stored
    // message as failing.
    if (hasSkipRow) await conn.query(SQL.clearSkip, [id]);
    await conn.query('COMMIT');
    return rowId !== null;
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => { broken = true; });
    throw err;
  } finally {
    conn.release(broken);
  }
}

async function processOne(ctx, id, hasSkipRow, handled) {
  const res = await ctx.client.getMessage(id);
  const cls = res.error ? res.error.class : null;
  // Only the API leaving this message unanswered is held. The token failing
  // to mint says nothing about the message: it fails the tick, below.
  if (cls === 'GmailUnavailableError' && res.error.stage === 'api') {
    // Held; two unanswered in a row ask the probe now (an outage throws).
    ctx.pending.push({ id, err: res.error, handled });
    if (ctx.lastUnanswered) await settlePending(ctx);
    ctx.lastUnanswered = true;
    return HELD;
  }
  if (cls && !ANSWERED.has(cls)) throw res.error; // auth or the token: the tick ends and retries next minute
  ctx.lastUnanswered = false;
  await strikePending(ctx);
  if (cls === 'GmailNotFoundError') { ctx.sum.dropped += 1; return HANDLED; }
  // A request Gmail refuses for this one id fails that message, not the tick.
  if (cls === 'GmailRequestError') return failMessage(ctx, id, res.error);
  // Outside the message's try: the people index failing to load is the tick
  // failing, never this message (or every message would spend its attempts).
  const index = await ctx.index();
  try {
    const m = rules.parseMessage(res.data, { nowMs: ctx.deps.now() });
    const refs = await sentRefsOf(ctx.mdb, m);
    const verdict = rules.classifyMessage({ ...m, index, ...refs });
    if (verdict.action === 'drop') {
      ctx.sum.dropped += 1;
      if (verdict.reason === 'zola_gate') { ctx.sum.gateFailed += 1; noteGateFailure(ctx); }
      if (hasSkipRow) await ctx.mdb.query(SQL.clearSkip, [id]);
      return HANDLED;
    }
    if (await storeMessage(ctx, id, m, verdict, hasSkipRow, index)) {
      ctx.sum.stored += 1;
      if (verdict.kind === 'zola_unparsed') ctx.sum.unparsed += 1;
    }
    return HANDLED;
  } catch (err) {
    if (isDbOutage(err)) throw err; // the tick fails; the message keeps its attempts
    return failMessage(ctx, id, err);
  }
}

const hasBudget = (ctx) => ctx.fetched < GMAIL_SYNC_MAX_PER_TICK && ctx.deps.now() - ctx.startedAt <= GMAIL_SYNC_TICK_MS;

// The window's held messages, settled before its cursor is written, so one
// the probe's strike skips for good is handled now. An outage comes back as
// the error that ends the tick.
async function settleWindow(ctx) {
  try {
    await settlePending(ctx);
    return null;
  } catch (err) {
    return err;
  }
}

// Process ids in order, adding each handled one to `handled`. Stored ids and
// ids skipped for good are handled without a fetch and never count toward
// the cap. Returns { stopped } (the bound was reached) and, when a Gmail
// error ended the window, fatal.
async function processIds(ctx, ids, handled) {
  const pending = ids.filter((id) => !handled.has(id));
  if (pending.length === 0) return { stopped: false, fatal: null };
  const [stored, skips] = await Promise.all([
    ctx.db.query(SQL.storedIds, [pending]),
    ctx.db.query(SQL.skipRows, [pending]),
  ]);
  for (const r of stored.rows) handled.add(r.gmail_id);
  const skipRows = new Set();
  for (const r of skips.rows) {
    if (Number(r.attempts) >= GMAIL_SKIP_ATTEMPTS || Number(r.unavailable) >= GMAIL_UNAVAILABLE_SKIP_TICKS) handled.add(r.gmail_id);
    else skipRows.add(r.gmail_id);
  }
  for (const id of pending) {
    if (handled.has(id)) continue;
    if (!hasBudget(ctx)) return { stopped: true, fatal: await settleWindow(ctx) };
    ctx.fetched += 1;
    let outcome;
    try {
      outcome = await processOne(ctx, id, skipRows.has(id), handled);
    } catch (err) {
      return { stopped: true, fatal: err };
    }
    if (outcome === HANDLED) handled.add(id);
  }
  const fatal = await settleWindow(ctx);
  return { stopped: fatal !== null, fatal };
}

// ─── the windows ───

async function currentHistoryId(client) {
  const res = await client.getProfile();
  if (res.error) throw res.error;
  const id = res.data && res.data.historyId;
  if (!validHistoryId(id)) throw shapeError();
  return String(id);
}

// The first sync and the dated resync: two passes (Sent, then everything
// else), page by page, newest page first (Gmail's order), each page's ids
// oldest first.
async function listPages(ctx, start) {
  let cur = start;
  for (let pages = 0; pages < MAX_PAGES_PER_TICK && hasBudget(ctx); pages += 1) {
    const res = await ctx.client.listMessages({ q: queryFor(cur), pageToken: cur.page || undefined, maxResults: GMAIL_SYNC_MAX_PER_TICK });
    if (res.error) {
      if (res.error.class === 'GmailRequestError' && cur.page) {
        await restartPass(ctx, cur, res.error);
        return;
      }
      throw res.error;
    }
    const data = res.data || {};
    const listed = (Array.isArray(data.messages) ? data.messages : [])
      .map((x) => x && x.id)
      .filter((id) => typeof id === 'string' && rules.GMAIL_ID_RE.test(id));
    const ids = unique(listed.reverse());
    if (ids.length) ctx.nonEmpty = true;
    const handled = new Set(cur.done);
    const { stopped, fatal } = await processIds(ctx, ids, handled);
    if (stopped || !ids.every((id) => handled.has(id))) {
      await writeState(ctx, SQL.savePage, writeCursor({ ...cur, done: ids.filter((id) => handled.has(id)) }));
      if (fatal) throw fatal;
      return;
    }
    const next = typeof data.nextPageToken === 'string' && data.nextPageToken && data.nextPageToken.length <= PAGE_TOKEN_MAX
      ? data.nextPageToken : null;
    ctx.moved = true;
    if (!next && cur.phase === 'all') {
      await writeState(ctx, SQL.finishList);
      return;
    }
    cur = next
      ? { after: cur.after, phase: cur.phase, page: next, done: [] }
      : { after: cur.after, phase: 'all', page: null, done: [] };
    await writeState(ctx, SQL.savePage, writeCursor(cur));
  }
}

// Steady state: history.list from the stored id. The cursor moves to the last
// record whose ids are all handled, and to the window's newest history id once
// every record is. Returns true when Google no longer keeps that history.
async function historyPass(ctx, startId) {
  const recs = [];
  const seen = new Set();
  let latest = null;
  let pageToken;
  let complete = false;
  const listMore = () => ctx.deps.now() - ctx.startedAt <= HISTORY_LIST_MS && seen.size < HISTORY_LIST_IDS;
  for (let pages = 0; pages < MAX_PAGES_PER_TICK && (pages === 0 || listMore()); pages += 1) {
    const res = await ctx.client.listHistory({ startHistoryId: startId, historyTypes: [...HISTORY_TYPES], pageToken });
    if (res.error) {
      if (res.error.class === 'GmailHistoryGoneError') return true;
      throw res.error;
    }
    const data = res.data || {};
    if (Array.isArray(data.history)) {
      for (const r of data.history) {
        if (!r || !validHistoryId(r.id)) continue;
        recs.push(r);
        for (const id of rules.idsOfHistoryRecord(r)) seen.add(id);
      }
    }
    if (validHistoryId(data.historyId)) latest = String(data.historyId);
    pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null;
    if (!pageToken) { complete = true; break; }
  }
  if (recs.length) ctx.nonEmpty = true;
  const perRecord = recs.map(rules.idsOfHistoryRecord);
  const handled = new Set();
  const { stopped, fatal } = await processIds(ctx, unique(perRecord.flat()), handled);
  // The last record whose ids are all handled; a held id stops it there.
  let through = null;
  let all = true;
  for (const [i, ids] of perRecord.entries()) {
    if (!ids.every((id) => handled.has(id))) { all = false; break; }
    through = recs.at(i);
  }
  let to = null;
  if (complete && !stopped && all && latest) to = latest;
  else if (through) to = String(through.id);
  if (to && to !== String(startId)) {
    await writeState(ctx, SQL.saveHistory, to);
    ctx.moved = true;
  }
  if (fatal) throw fatal;
  return false;
}

async function startListing(ctx, after) {
  const historyId = await currentHistoryId(ctx.client);
  const cursor = { after, phase: 'sent', page: null, done: [] };
  await writeState(ctx, SQL.startList, historyId, writeCursor(cursor));
  ctx.moved = true;
  return cursor;
}

async function syncOnce(ctx, lease) {
  if (!lease.history_id) {
    await listPages(ctx, await startListing(ctx, floorAfter()));
    return;
  }
  if (!lease.backfill_done) {
    await listPages(ctx, readCursor(lease.backfill_page));
    return;
  }
  if (!(await historyPass(ctx, String(lease.history_id)))) return;
  const cursor = await startListing(ctx, resyncAfter(lease.last_ok_at));
  console.warn(`[gmail_sync] history expired, resyncing mail after epoch ${cursor.after}`);
  await listPages(ctx, cursor);
}

// ─── the tick ───

async function recordTickError(ctx, err) {
  const cls = errorClassOf(err);
  console.warn(`[gmail_sync] tick failed: ${cls}${statusOf(err) !== null ? ` (${statusOf(err)})` : ''}`);
  try {
    const { rows } = await ctx.db.query(SQL.tickError, [cls, ctx.owner]);
    return Number(rows[0] && rows[0].consecutive_errors) || 0;
  } catch (dbErr) {
    console.warn(`[gmail_sync] could not record the tick failure: ${errorClassOf(dbErr)}`);
    return 0;
  }
}

async function runTick(deps, owner) {
  const client = deps.client || createGmailClient();
  if (!client) return null;
  const { db } = deps;
  await ensureStateRow(db);
  const lease = await claimLease(db, owner);
  if (!lease) return null;
  const sum = { stored: 0, dropped: 0, unparsed: 0, skipped: 0, failed: 0, gateFailed: 0 };
  let indexPromise = null;
  const ctx = {
    deps, client, db, owner, sum, fetched: 0, startedAt: deps.now(), nonEmpty: false, moved: false,
    // The message path's queries, marked so a database outage fails the tick.
    mdb: markedDb(db),
    // Messages Gmail left unanswered, waiting for an answer to tell whose fault.
    pending: [], lastUnanswered: false,
    // Loaded once, and only when a message needs it: an idle tick reads nothing.
    index: () => { if (!indexPromise) indexPromise = deps.loadIndex(db); return indexPromise; },
  };
  try {
    await syncOnce(ctx, lease);
    // Mail was waiting and the tick neither read any nor moved the cursor:
    // that is a failure, so a stuck window reaches "failing" and Sentry.
    if (ctx.nonEmpty && ctx.fetched === 0 && !ctx.moved) throw tickError('NoProgress');
    await db.query(SQL.tickOk, [owner]);
  } catch (err) {
    if (err && err.class === 'LeaseLost') {
      console.warn('[gmail_sync] another instance holds the lease now; this tick stops');
    } else {
      const consecutive = await recordTickError(ctx, err);
      if (consecutive >= GMAIL_FAILING_TICKS) warnFailing(ctx, err, consecutive);
    }
  } finally {
    try {
      await releaseLease(db, owner);
    } catch (err) {
      console.warn(`[gmail_sync] could not release the lease: ${errorClassOf(err)}`);
    }
    // Once per tick, and only when the engine has something new to see.
    if (sum.stored > 0) deps.cache.invalidate();
    // Only a tick that counted something: an idle minute says nothing.
    if (Object.values(sum).some((n) => n > 0)) {
      console.log(`[gmail_sync] stored=${sum.stored} dropped=${sum.dropped} unparsed=${sum.unparsed} skipped=${sum.skipped} failed=${sum.failed} gateFailed=${sum.gateFailed}`);
    }
  }
  return sum;
}

/**
 * The scheduler's tick. Options exist for tests and are never passed by the
 * scheduler: client (a Gmail stub), db, now (ms clock), sentry, loadIndex,
 * cache. Holds the in-flight guard the AI read keeps (wrapScheduler has
 * none): a tick still running makes the next one return null.
 */
function makeGmailSyncTick(opts = {}) {
  const deps = {
    client: opts.client || null,
    db: opts.db || pool,
    now: opts.now || Date.now,
    sentry: opts.sentry || Sentry,
    loadIndex: opts.loadIndex || loadEmailIndex,
    cache: opts.cache || cache,
  };
  const owner = `gmail_sync:${process.pid}:${crypto.randomUUID()}`;
  let inFlight = false;
  return async function gmailSyncTick() {
    if (inFlight) {
      console.warn('[gmail_sync] previous tick still in flight, skipping this one');
      return null;
    }
    inFlight = true;
    try {
      return await runTick(deps, owner);
    } finally {
      inFlight = false;
    }
  };
}

function _resetGmailSyncForTest() {
  lastFailWarnAt = 0;
  lastGateWarnAt = 0;
  lastResetWarnAt = 0;
  gateFailures = [];
}

module.exports = {
  SQL, FAIL_WARN_MS, GMAIL_UNAVAILABLE_SKIP_TICKS,
  makeGmailSyncTick, ensureStateRow, claimLease, releaseLease, errorClassOf, readCursor, resyncAfter,
  _resetGmailSyncForTest,
  // The pure rules, re-exported for the plan's interface.
  headersOf: rules.headersOf,
  recipientsOf: rules.recipientsOf,
  isBulk: rules.isBulk,
  isAutoReply: rules.isAutoReply,
  isBounce: rules.isBounce,
  classifyMessage: rules.classifyMessage,
};
