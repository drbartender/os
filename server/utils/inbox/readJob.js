// The AI read job (spec 2026-10-06 section 6.4), registered in server/index.js
// as the 60-second inbox_ai_read scheduler. Each tick:
//   1. with ANTHROPIC_API_KEY unset, does nothing;
//   2. turns any read left pending over 5 minutes into an error (a crash after
//      reserving), so it is retried like any other error;
//   3. pauses when the rolling 24-hour attempt count reaches INBOX_AI_DAILY_CAP;
//   4. takes the engine's subjects from the badge's cached snapshot, up to
//      BADGE_MAX_AGE_MS (2 minutes) old, keeps the readable ones with no ok or
//      refused read and fewer than 3 attempts (checked against inbox_reads
//      itself, since the snapshot can predate the last tick's writes), oldest
//      first, at most 20;
//   5. reserves each as pending BEFORE the call, so a store that fails after a
//      good call can never repeat that call every tick, then reads and stores.
//
// Nothing here ever stores or reports message text: an error row and a Sentry
// warning carry the error class, HTTP status and request id only. The
// legal-hold person is never read (decision 31), three ways: the engine never
// returns their subjects (and folds the phone and lead keys they own into
// their client key), this job skips any subject whose legalHold flag is set,
// and it refuses every key the hold covers itself (the client's c- key, every
// number on record for them as a p- key, their Thumbtack leads as t- keys),
// so one missed flag is not enough to send their messages out.

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { isConfigured, createAnthropicClient } = require('../anthropicClient');
const { LEGAL_HOLD_PROPOSAL_IDS } = require('../staleProposalSweep');
const { isReadable, classifyInbound, classifyOutbound, readModel } = require('./aiRead');
const { dailyCap, readStats } = require('./aiStatus');
const { BADGE_MAX_AGE_MS } = require('./constants');

const TICK_LIMIT = 20;
const MAX_ATTEMPTS = 3;
const STALE_PENDING_MINUTES = 5;
const WARN_THROTTLE_MS = 60 * 60 * 1000;

let deps = { sentry: Sentry };
let lastErrorWarnAt = 0;
let lastCapWarnAt = 0;

const SWEEP_STALE_PENDING = `
  UPDATE inbox_reads
     SET status = 'error', error = 'StalePending', updated_at = NOW()
   WHERE status = 'pending' AND updated_at < NOW() - make_interval(mins => $1)`;

// One statement, safe under two overlapping instances (a deploy): a new
// subject is inserted pending; an error row under the attempt cap is
// re-claimed; an ok, refused, fresh-pending or exhausted row returns nothing.
const RESERVE = `
  INSERT INTO inbox_reads (kind, subject_ref, person_key, status, model, attempts)
  VALUES ($1, $2, $3, 'pending', $4, 1)
  ON CONFLICT (kind, subject_ref) DO UPDATE
     SET status = 'pending', attempts = inbox_reads.attempts + 1,
         model = EXCLUDED.model, updated_at = NOW()
   WHERE inbox_reads.status = 'error' AND inbox_reads.attempts < $5
  RETURNING id, attempts`;

const STORE_OK_INBOUND = `
  UPDATE inbox_reads
     SET status = 'ok', needs_reply = $2, summary = $3, reason = $4, model = $5,
         holding = NULL, promised_by = NULL, error = NULL, updated_at = NOW()
   WHERE id = $1 AND status = 'pending'`;
const STORE_OK_OUTBOUND = `
  UPDATE inbox_reads
     SET status = 'ok', holding = $2, promised_by = $3, reason = $4, model = $5,
         needs_reply = NULL, summary = NULL, error = NULL, updated_at = NOW()
   WHERE id = $1 AND status = 'pending'`;
const STORE_REFUSED = `
  UPDATE inbox_reads
     SET status = 'refused', model = $2, error = NULL, updated_at = NOW()
   WHERE id = $1 AND status = 'pending'`;
const STORE_ERROR = `
  UPDATE inbox_reads
     SET status = 'error', model = $2, error = $3, updated_at = NOW()
   WHERE id = $1 AND status = 'pending'`;

const keyOf = (s) => `${s.kind}|${s.subjectRef}`;

/** The subject message's time, for oldest-first; unknown sorts last. */
function subjectTime(subject) {
  const entry = Array.isArray(subject.slice) ? subject.slice.find((e) => e && e.ref === subject.subjectRef) : null;
  const at = subject.at !== undefined && subject.at !== null ? subject.at : (entry ? entry.at : null);
  const t = at === null ? Number.NaN : new Date(at).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function oldestFirst(a, b) {
  const d = subjectTime(a) - subjectTime(b);
  if (d < 0 || d > 0) return d;
  if (a.subjectRef === b.subjectRef) return 0;
  return a.subjectRef < b.subjectRef ? -1 : 1;
}

// Every person key the legal hold covers (decision 31): the held proposals'
// clients as c- keys, every phone on record for those clients or proposals as
// a p- key (the last ten digits, as the engine keys an unknown number), and
// their Thumbtack leads as t- keys. The engine folds a client's own phone and
// leads into their c- key, but a number they used that is on none of the
// people index's rows would otherwise form an unheld p- person. A failed
// lookup throws, so the tick reads nothing (fail closed).
const HELD_KEYS_SQL = `
  WITH held AS (
    SELECT DISTINCT client_id AS id FROM proposals
     WHERE id = ANY($1::int[]) AND client_id IS NOT NULL
  ),
  phones AS (
    SELECT c.phone AS phone FROM clients c JOIN held ON held.id = c.id
    UNION ALL SELECT m.recipient_phone FROM sms_messages m JOIN held ON held.id = m.client_id
    UNION ALL SELECT t.customer_phone FROM thumbtack_leads t
               WHERE t.client_id IN (SELECT id FROM held) OR t.proposal_id = ANY($1::int[])
    UNION ALL SELECT k.booker_phone FROM consults k JOIN held ON held.id = k.client_id
    UNION ALL SELECT s.client_phone FROM shifts s JOIN proposals p ON p.id = s.proposal_id
               WHERE p.id = ANY($1::int[]) OR p.client_id IN (SELECT id FROM held)
    UNION ALL SELECT l.recipient FROM message_log l JOIN held ON held.id = l.client_id
               WHERE l.channel = 'sms'
  ),
  digits AS (
    SELECT regexp_replace(phone, '[^0-9]', '', 'g') AS d FROM phones WHERE phone IS NOT NULL
  )
  SELECT 'c-' || id AS key FROM held
  UNION SELECT 'p-' || RIGHT(d, 10) FROM digits WHERE LENGTH(d) >= 10
  UNION SELECT 't-' || t.negotiation_id FROM thumbtack_leads t
         WHERE (t.client_id IN (SELECT id FROM held) OR t.proposal_id = ANY($1::int[]))
           AND t.negotiation_id IS NOT NULL`;

async function legalHoldPersonKeys(db, proposalIds) {
  const ids = (Array.isArray(proposalIds) ? proposalIds : []).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return new Set();
  const { rows } = await db.query(HELD_KEYS_SQL, [ids]);
  return new Set(rows.map((r) => r.key));
}

async function existingReads(db, subjects) {
  if (subjects.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT r.kind, r.subject_ref, r.status, r.attempts
       FROM inbox_reads r
       JOIN unnest($1::text[], $2::text[]) AS s(kind, subject_ref)
         ON r.kind = s.kind AND r.subject_ref = s.subject_ref`,
    [subjects.map((s) => s.kind), subjects.map((s) => s.subjectRef)]
  );
  return new Map(rows.map((r) => [`${r.kind}|${r.subject_ref}`, r]));
}

function needsRead(row) {
  return !row || (row.status === 'error' && row.attempts < MAX_ATTEMPTS);
}

async function store(db, id, kind, result) {
  if (result.status === 'ok' && kind === 'inbound') {
    await db.query(STORE_OK_INBOUND, [id, result.needsReply, result.summary, result.reason, result.model]);
  } else if (result.status === 'ok') {
    await db.query(STORE_OK_OUTBOUND, [id, result.holding, result.promisedBy, result.reason, result.model]);
  } else if (result.status === 'refused') {
    await db.query(STORE_REFUSED, [id, result.model]);
  } else {
    await db.query(STORE_ERROR, [id, result.model, result.error]);
  }
}

// errorText is formatAiError output: class, status and request id only.
function warnReadError(errorText) {
  const t = Date.now();
  if (t - lastErrorWarnAt < WARN_THROTTLE_MS) return false;
  lastErrorWarnAt = t;
  deps.sentry.captureMessage('inbox AI read failed', {
    level: 'warning',
    tags: { scheduler: 'inbox_ai_read', issue: 'read_error' },
    extra: { error: errorText },
  });
  console.warn(`[inbox_ai_read] a read failed: ${errorText}`);
  return true;
}

// At most one an hour, like the read-error warning: under sustained load the
// count dips below the cap and climbs back every couple of minutes, and a
// warning per crossing would be noise.
function warnCapped(used, cap) {
  const t = Date.now();
  if (t - lastCapWarnAt < WARN_THROTTLE_MS) return false;
  lastCapWarnAt = t;
  deps.sentry.captureMessage('inbox AI read paused at its daily cap', {
    level: 'warning',
    tags: { scheduler: 'inbox_ai_read', issue: 'daily_cap' },
    extra: { used, cap },
  });
  console.warn(`[inbox_ai_read] paused: ${used} of ${cap} reads used in the last 24 hours`);
  return true;
}

/**
 * One tick. Options exist for tests and are never passed by the scheduler:
 * client (a stub; the real one comes from anthropicClient.js), engine (an
 * object with getReadSubjects and invalidate; default ./engine), db, and
 * legalHoldProposalIds (default LEGAL_HOLD_PROPOSAL_IDS).
 */
async function runInboxReads({
  client,
  engine,
  db = pool,
  legalHoldProposalIds = LEGAL_HOLD_PROPOSAL_IDS,
} = {}) {
  if (!isConfigured()) return { skipped: 'off' };
  await db.query(SWEEP_STALE_PENDING, [STALE_PENDING_MINUTES]);
  const cap = dailyCap();
  const { attempts24h } = await readStats(db);
  if (attempts24h >= cap) {
    warnCapped(attempts24h, cap);
    return { skipped: 'paused', used: attempts24h, cap };
  }
  const ai = createAnthropicClient({ stub: client });
  if (!ai) return { skipped: 'off' };

  const inbox = engine || require('./engine');
  // The badge's snapshot, up to BADGE_MAX_AGE_MS (2 minutes) old (spec 17
  // item 41): the tick shares whatever an open admin page refreshed and
  // recomputes the inbox itself only when nothing did, about every third
  // minute when idle (the merge review put that at 0.25 to 0.5 GB a day of
  // Neon transfer; the lever is Dallas's call, on the fix list).
  // existingReads re-checks inbox_reads, and a read clears the cache.
  const subjects = await inbox.getReadSubjects({ maxAgeMs: BADGE_MAX_AGE_MS });
  const held = await legalHoldPersonKeys(db, legalHoldProposalIds);
  // isReadable refuses a subject flagged legalHold; held is the job's own check.
  const readable = (Array.isArray(subjects) ? subjects : [])
    .filter((s) => isReadable(s) && !held.has(s.personKey));
  const existing = await existingReads(db, readable);
  const due = readable.filter((s) => needsRead(existing.get(keyOf(s)))).sort(oldestFirst);
  const budget = Math.min(TICK_LIMIT, cap - attempts24h);

  const counts = { read: 0, ok: 0, refused: 0, error: 0, raced: 0 };
  for (const subject of due) {
    if (counts.read >= budget) break;
    const { rows } = await db.query(RESERVE, [subject.kind, subject.subjectRef, subject.personKey, readModel(), MAX_ATTEMPTS]);
    if (rows.length === 0) { counts.raced += 1; continue; }
    counts.read += 1;
    const result = subject.kind === 'inbound'
      ? await classifyInbound(subject, ai)
      : await classifyOutbound(subject, ai);
    await store(db, rows[0].id, subject.kind, result);
    if (result.status === 'ok') counts.ok += 1;
    else if (result.status === 'refused') counts.refused += 1;
    else { counts.error += 1; warnReadError(result.error); }
  }
  if (counts.read > 0) {
    inbox.invalidate();
    console.log(`[inbox_ai_read] read=${counts.read} ok=${counts.ok} refused=${counts.refused} error=${counts.error}`);
  }
  return counts;
}

/**
 * The scheduler's tick, with the in-flight guard the service_extension_sweep
 * and consult_call_sweep schedulers keep in server/index.js, held here so it
 * can be tested: wrapScheduler has no overlap protection, and 20 paid reads
 * with retries can outrun 60 seconds. finally, so a tick that throws can
 * never latch the guard on.
 */
function makeInboxReadTick(run = runInboxReads) {
  // Built once, at boot: a bad INBOX_AI_MODEL warns here, not first on a read.
  readModel();
  let inFlight = false;
  return async function inboxReadTick() {
    if (inFlight) {
      console.warn('[inbox_ai_read] previous tick still in flight, skipping this one');
      return { skipped: 'in_flight' };
    }
    inFlight = true;
    try {
      return await run();
    } finally {
      inFlight = false;
    }
  };
}

function __setReadJobDeps(overrides) {
  deps = { ...deps, ...overrides };
}

function _resetReadJobWarningsForTest() {
  lastErrorWarnAt = 0;
  lastCapWarnAt = 0;
  deps = { sentry: Sentry };
}

module.exports = {
  TICK_LIMIT,
  MAX_ATTEMPTS,
  STALE_PENDING_MINUTES,
  WARN_THROTTLE_MS,
  subjectTime,
  runInboxReads,
  makeInboxReadTick,
  __setReadJobDeps,
  _resetReadJobWarningsForTest,
};
