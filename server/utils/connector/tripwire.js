'use strict';

// The bulk-read tripwire (spec 2026-11-19 section 7.6, guard 3): the detail tools together serve a capped number of different clients per grant per rolling hour.
//
// The detail tools are Client, Proposal or event and Thread; the list tools
// are not counted (they carry no phone number and no email address). A
// subject is the client a detail call read ('c' and the client id), or, for
// a record with no client (an unknown number's thread, a booking with no
// client), the tool and the record ('thread:e-...'). A repeat of a subject
// already counted in the window is served; a new one past the cap is refused
// until the hour rolls.
//
// The count is the union of two records, so it never waits on a row written
// after a response: the served detail calls of the last hour in the call log
// (each detail tool writes its own row BEFORE it answers, so another
// instance and a restart see it) and this process's own record, which takes
// the new subject synchronously, after the log read and with no await in
// between, so two calls racing in one process cannot both take the last
// place under the cap.
//
// A trip (the first refusal after the count reached the cap) lasts until the
// hour rolls (spec 7.6: past the cap the detail tools refuse until then): for
// WINDOW_MS from the trip no new subject is admitted, even as counted ones age
// out, so one trip sends one owner email and one Sentry alert. A repeat of a
// subject still counted is served throughout. The trip is held in this
// process and named on each refused row (trip:<start>), which a restart reads
// back, so a deploy inside a trip neither ends it early nor emails again. A
// trip email that does not go out (no owner address, a send that throws,
// notifications gated off) is reported to Sentry. The cap is CONNECTOR_TRIPWIRE_CAP (default 40, 1 to 1000);
// the clock is the caller's `now`. The owner email and the Sentry hook are
// injectable (__setTripwireDeps).

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { sendEmail } = require('../email');
const { ADMIN_URL } = require('../urls');

const WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_CAP = 40;
const DETAIL_TOOLS = Object.freeze(['client', 'proposal_or_event', 'thread']);

// The subjects this grant's served detail calls read in the window, derived
// exactly as subjectOf() derives them below.
const SUBJECTS_SQL = `
  SELECT DISTINCT CASE WHEN client_id IS NOT NULL THEN 'c' || client_id::text
                       ELSE tool_name || ':' || COALESCE(record_ids[1], '') END AS subject
    FROM connector_calls
   WHERE grant_id = $1 AND called_at > $2 AND outcome = 'ok' AND tool_name = ANY($3::text[])`;
const OWNER_EMAIL_SQL = 'SELECT email FROM users WHERE id = $1';
// The trips this grant's refusals of the last hour recorded: each refused
// row names its trip's start (record_ids "trip:<ISO instant>", tools/run.js),
// so a restart inside a trip keeps it, neither ending it early nor emailing again.
const TRIPS_SQL = `
  SELECT record_ids FROM connector_calls
   WHERE grant_id = $1 AND called_at > $2 AND outcome = 'refused_tripwire'`;

function readCap(env = process.env) {
  const raw = env.CONNECTOR_TRIPWIRE_CAP;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_CAP;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_CAP;
}

/** The subject a detail call counts as. */
function subjectOf({ toolName, clientId, recordId }) {
  if (Number.isInteger(clientId) && clientId > 0) return `c${clientId}`;
  return `${toolName}:${recordId === null || recordId === undefined ? '' : String(recordId)}`;
}

const defaults = () => ({
  send: sendEmail,
  captureMessage: (msg, ctx) => { if (process.env.SENTRY_DSN_SERVER) Sentry.captureMessage(msg, ctx); },
  ownerEmail: async (userId) => {
    const { rows } = await pool.query(OWNER_EMAIL_SQL, [userId]);
    return rows[0] ? rows[0].email : null;
  },
  logSubjects: async (grantId, since) => {
    const { rows } = await pool.query(SUBJECTS_SQL, [grantId, since, DETAIL_TOOLS]);
    return rows.map((r) => r.subject);
  },
  // The latest trip start (ms) a refused row of the window names, or null.
  logTripStart: async (grantId, since) => {
    const { rows } = await pool.query(TRIPS_SQL, [grantId, since]);
    let latest = null;
    for (const r of rows) {
      for (const id of r.record_ids || []) {
        const m = /^trip:(.+)$/.exec(String(id));
        const t = m ? Date.parse(m[1]) : NaN;
        if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
      }
    }
    return latest;
  },
});
let deps = defaults();
function __setTripwireDeps(overrides) { deps = overrides ? { ...deps, ...overrides } : defaults(); }

// grantId -> Map(subject -> last served ms), this process's record.
const served = new Map();
// grantId -> when its current trip began (ms).
const tripped = new Map();
let tail = Promise.resolve();
function __drain() { return tail; }
function __resetTripwire() { served.clear(); tripped.clear(); }

function prune(mine, nowMs) {
  for (const [s, t] of mine) if (nowMs - t >= WINDOW_MS) mine.delete(s);
}

function notifyTrip({ grantId, userId, cap, now }) {
  try {
    deps.captureMessage('connector_tripwire_tripped', {
      level: 'warning', tags: { component: 'connector' }, extra: { grant_id: grantId, cap },
    });
  } catch (_) { /* telemetry must never break a tool call; static-checks: allow swallowed-catch */ }
  tail = Promise.resolve()
    .then(async () => {
      const to = await deps.ownerEmail(userId);
      if (!to) throw new Error('no owner address');
      const at = new Date(now).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
      const lines = [
        `On ${at} (Chicago time) Claude's detail lookups (Client details, Proposal or event details, Message thread) reached their limit of ${cap} different records in an hour (a client, or a thread or booking with no client), so the OS paused them for the next hour.`,
        'Normal use is a handful of lookups; many in a row can mean a message has talked Claude or Duet into collecting data. The lists still answer, and the lookups resume on their own an hour after the pause began.',
        `Open the Claude connection block in Settings (${ADMIN_URL}/settings) for the recent calls. If you did not expect this, press Disconnect there.`,
      ];
      const sent = await deps.send({
        to,
        subject: 'Claude\'s connector paused its detail lookups',
        html: lines.map((l) => `<p>${l}</p>`).join('\n'),
        text: lines.join('\n\n'),
        meta: { skipLog: true },
      });
      // sendEmail answers dev-skipped when notifications are gated off: nothing went out.
      if (sent && sent.id === 'dev-skipped') throw new Error('notifications off');
    })
    .catch(() => {
      try {
        deps.captureMessage('connector_tripwire_email_failed', { level: 'error', tags: { component: 'connector' } });
      } catch (_) { /* telemetry must never break a tool call; static-checks: allow swallowed-catch */ }
    });
}

/**
 * Admit one detail call's subject, or refuse it. Resolves { allowed, cap },
 * and on a refusal `since`, the trip's start (ms), for the refused row.
 * A failed log read throws (the call fails rather than skip the count).
 * @param {{grantId: number, userId: number, subject: string, now?: Date}} args
 */
async function admit({ grantId, userId, subject, now = new Date() }) {
  const cap = readCap();
  const nowMs = now.getTime();
  const since = new Date(nowMs - WINDOW_MS);
  const [fromLog, loggedTrip] = await Promise.all([deps.logSubjects(grantId, since), deps.logTripStart(grantId, since)]);
  // No await from here to the end: the check and the reservation are one step.
  if (!served.has(grantId)) served.set(grantId, new Map());
  const mine = served.get(grantId);
  prune(mine, nowMs);
  const counted = new Set([...fromLog, ...mine.keys()]);
  if (counted.has(subject)) {
    mine.set(subject, nowMs);
    return { allowed: true, cap };
  }
  // A trip this process does not hold but the log does (a restart inside it).
  if (!tripped.has(grantId) && Number.isFinite(loggedTrip) && nowMs - loggedTrip < WINDOW_MS) tripped.set(grantId, loggedTrip);
  const began = tripped.get(grantId);
  if (began !== undefined && nowMs - began >= WINDOW_MS) tripped.delete(grantId);
  if (tripped.has(grantId)) return { allowed: false, cap, since: tripped.get(grantId) };
  if (counted.size >= cap) {
    tripped.set(grantId, nowMs);
    notifyTrip({ grantId, userId, cap, now });
    return { allowed: false, cap, since: nowMs };
  }
  mine.set(subject, nowMs);
  return { allowed: true, cap };
}

module.exports = {
  WINDOW_MS, DEFAULT_CAP, DETAIL_TOOLS, SUBJECTS_SQL, TRIPS_SQL,
  readCap, subjectOf, admit, __setTripwireDeps, __resetTripwire, __drain,
};
