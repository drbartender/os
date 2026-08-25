// server/utils/consultCallSweep.js
//
// Consult call bridge: the 60 second clock (spec 2026-08-25 section 4.3).
// consultCallChain.js knows HOW to open, skip and ring a chain; this module is
// the only thing that decides WHEN. One tick, three steps, in this order:
//
//   1. Open. Consults still 'scheduled' whose slot is inside
//      (NOW - OPEN_BEHIND_MINUTES, NOW + OPEN_AHEAD_MINUTES] with no chain at
//      that slot. The number is validated FIRST: an unusable one files the
//      undialable skip instead of opening a chain nothing could dial. The
//      trailing behind bound is the catch-up: a webhook that landed seconds
//      before the slot, a deploy that spanned it, or one wedged tick must still
//      ring, late, rather than have the consult vanish.
//   2. Missed window. Same shape, slot inside
//      (NOW - MISSED_WINDOW_MINUTES, NOW - OPEN_BEHIND_MINUTES]. These are the
//      slots that passed with nobody ringing. Each one is a person who waited
//      for a call that never came, so each gets its own row and its own email
//      (ruling R7), never a collapsed digest.
//   3. Fire. Pending chains whose next_ring_at is due, oldest ring first,
//      handed to advanceChain, which owns every guard and every claim.
//
// THE TWO WINDOWS ARE CONTIGUOUS AND DISJOINT: step 1's open bound is step 2's
// closed bound, so a slot belongs to exactly one of them and nothing can fall
// between them. Both bounds come from consultCallChain's exported constants
// rather than repeated literals, because two sources for one number is how they
// drift, and a drift here would either double-file a slot or drop it.
//
// SCHEDULED_AT NEVER ROUND-TRIPS THROUGH JAVASCRIPT (ruling R12). The step 1
// and step 2 queries deliberately do NOT select c.scheduled_at at all: the
// chain writers take consultId only and derive the slot from the consults row
// inside their own SQL, and a slot that never enters this file cannot be handed
// back into a write. node-pg truncates a TIMESTAMPTZ to milliseconds, so a
// round-tripped microsecond slot matches neither the anti-join below nor the
// (consult_id, scheduled_at) UNIQUE, and the sweep would then open a fresh
// chain every 60 seconds until the daily cap tripped.
//
// EVERY QUERY HERE IS GLOBAL over the table, which is what makes the per-row
// try/catch load-bearing: one malformed consult must not stop the tick and
// strand every consult behind it in the ordering. The last error is rethrown
// after all three steps have run, so wrapScheduler records a failed run rather
// than a silent green (schedulerHealth contract: schedulers rethrow).

const { pool } = require('../db');
const chain = require('./consultCallChain');
const { toUsE164 } = require('./usPhone');

// Per-tick bounds. Step 1 and 2 are cheap index scans over a narrow window;
// step 3 places billed calls, so it is the tightest. A tick that hits a limit
// simply picks the rest up 60 seconds later, in the same slot order.
const OPEN_LIMIT = 50;
const MISSED_LIMIT = 50;
const FIRE_LIMIT = 20;

/**
 * Are the window constants this module binds sound? Returns null when they are,
 * or a message naming the first one that is not.
 *
 * WHY THIS EXISTS. Both window predicates bind these three. If a future edit
 * drops one of the exports the bind sends NULL, every comparison evaluates to
 * NULL, both queries return zero rows, and wrapScheduler writes a healthy
 * heartbeat every sixty seconds forever while the bridge is completely dead.
 * This feature's failure mode is SILENCE, so a dead clock reporting green is
 * the worst outcome available to it.
 *
 * WHY IT RETURNS INSTEAD OF THROWING (ruling, fix round 2). A throw at module
 * load reaches index.js inside the app.listen callback, past start()'s try, so
 * it would stop the process. That is a catastrophic response to a contained
 * fault: this server also runs proposals, invoices, Stripe webhooks and both
 * portals, and none of them should go down because a constant belonging to the
 * consult call bridge went missing. index.js reports this to Sentry and leaves
 * the sweep UNWIRED instead, which is the outcome that actually mattered: an
 * unwired sweep cannot spin with NULL predicates writing green heartbeats.
 *
 * The cheaper line of defense is the one that counts. The test suite requires
 * this module unconditionally and asserts this returns null, so a bad edit
 * fails there before anything is deployed, when nobody is waiting on a call.
 *
 * @param {Object} [source] the constants holder; defaults to consultCallChain.
 *   Present so the negative path is testable without mutating the real module.
 * @returns {string|null}
 */
function windowConstantsFault(source) {
  const src = source || chain;
  for (const [name, value] of [
    ['OPEN_AHEAD_MINUTES', src.OPEN_AHEAD_MINUTES],
    ['OPEN_BEHIND_MINUTES', src.OPEN_BEHIND_MINUTES],
    ['MISSED_WINDOW_MINUTES', src.MISSED_WINDOW_MINUTES],
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      return `consultCallChain.${name} must be a positive integer, got ${String(value)}`;
    }
  }
  // Same silent-dark class, one edit away: the missed window has to reach
  // further back than the open window or step 2's range is empty and every
  // passed slot goes unfiled, with nothing anywhere saying so.
  if (src.OPEN_BEHIND_MINUTES >= src.MISSED_WINDOW_MINUTES) {
    return `OPEN_BEHIND_MINUTES (${src.OPEN_BEHIND_MINUTES}) must be less than `
      + `MISSED_WINDOW_MINUTES (${src.MISSED_WINDOW_MINUTES}), or the missed-window step is empty`;
  }
  return null;
}

// Dependency-injection seam for tests (firstReplySweepScheduler.js precedent).
// The chain functions are called through this so a test can make one row throw;
// the WINDOW CONSTANTS are read from the static import instead, because they are
// feature choreography, not an injection point, and a partially stubbed chain
// would otherwise silently bind NULL bounds and empty every query.
let deps = { pool, chain };

function __setDeps(overrides) {
  deps = { ...deps, ...overrides };
}

const OPEN_SQL = `
  SELECT c.id, c.booker_phone
    FROM consults c
   WHERE c.status = 'scheduled'
     AND c.scheduled_at >  NOW() - make_interval(mins => $1::int)
     AND c.scheduled_at <= NOW() + make_interval(mins => $2::int)
     AND NOT EXISTS (SELECT 1 FROM consult_call_attempts a
                      WHERE a.consult_id = c.id AND a.scheduled_at = c.scheduled_at)
   ORDER BY c.scheduled_at, c.id
   LIMIT $3`;

const MISSED_SQL = `
  SELECT c.id, c.booker_phone
    FROM consults c
   WHERE c.status = 'scheduled'
     AND c.scheduled_at >  NOW() - make_interval(mins => $1::int)
     AND c.scheduled_at <= NOW() - make_interval(mins => $2::int)
     AND NOT EXISTS (SELECT 1 FROM consult_call_attempts a
                      WHERE a.consult_id = c.id AND a.scheduled_at = c.scheduled_at)
   ORDER BY c.scheduled_at, c.id
   LIMIT $3`;

const FIRE_SQL = `
  SELECT id
    FROM consult_call_attempts
   WHERE status = 'pending'
     AND next_ring_at IS NOT NULL
     AND next_ring_at <= NOW()
   ORDER BY next_ring_at, id
   LIMIT $1`;

// A rejection value is not guaranteed to be an Error, so err.message is guarded
// the same way consultCallChain's captureError guards it: an unguarded read
// would throw OUT of the catch that exists to contain it.
//
// THAT A FAILURE HAPPENED IS TRACKED SEPARATELY FROM ITS VALUE. A rejection is
// not guaranteed to be truthy either, and a tick that decided whether to fail
// by testing the error value would report a green run for a rejection carrying
// undefined. In a feature whose failure mode is silence, that is the one hole
// worth closing even though nothing rejects that way today.
function recordFault(fault, step, id, err) {
  fault.failed = true;
  fault.error = err;
  console.error(`[consultCallSweep] ${step} failed for ${id}:`, (err && err.message) || err);
}

// Normalized on the way out because wrapScheduler reads err.message off
// whatever it catches, and reading that off undefined would throw inside the
// one catch that exists to contain it, straight out to the timer callback.
function toError(value) {
  return value instanceof Error
    ? value
    : new Error(`consult call sweep tick failed: ${String(value)}`);
}

/**
 * Step 1. Validate the number, then open or file. toUsE164 is the dial-target
 * law's open-time half: the client leg only ever dials its output, and it is
 * re-checked again at press-1 time.
 */
async function openDueChains(counts, fault) {
  const r = await deps.pool.query(OPEN_SQL, [
    chain.OPEN_BEHIND_MINUTES, chain.OPEN_AHEAD_MINUTES, OPEN_LIMIT,
  ]);
  for (const row of r.rows) {
    try {
      if (!toUsE164(row.booker_phone)) {
        // bookerPhone is the RAW typed value, passed only so the skip row can
        // say invalid_phone rather than no_phone. It is never dialed.
        const filed = await deps.chain.fileUndialable({
          consultId: row.id, bookerPhone: row.booker_phone,
        });
        if (filed === 'filed') counts.skippedInvalid += 1;
        continue;
      }
      const outcome = await deps.chain.openChain({ consultId: row.id });
      if (outcome === 'opened') counts.opened += 1;
      // 'cap_tripped' counts the OUTCOME, not a marker row: openChain also
      // returns it for a consult that vanished between its probe and its marker
      // insert, having written nothing and emailed nothing (C4a carry-forward).
      else if (outcome === 'cap_tripped') counts.capTripped += 1;
    } catch (err) {
      recordFault(fault, 'open', `consult ${row.id}`, err);
    }
  }
}

/**
 * Step 2. A slot that passed with no chain behind it. Only a dialable number is
 * filed, because the alert says "call this person by hand" and there is no
 * number to call. In the normal case the number was already judged: the consult
 * crossed the open window first and carries its own skipped_invalid_phone row,
 * which the anti-join then excludes here. The residual, eyes open: a consult
 * whose row first appears with its slot ALREADY past the open window (a webhook
 * delayed more than three minutes, or a sweep outage that spanned the window)
 * and an unusable number gets no row and no email from either step.
 */
async function fileMissedWindows(counts, fault) {
  const r = await deps.pool.query(MISSED_SQL, [
    chain.MISSED_WINDOW_MINUTES, chain.OPEN_BEHIND_MINUTES, MISSED_LIMIT,
  ]);
  for (const row of r.rows) {
    try {
      if (!toUsE164(row.booker_phone)) continue;
      const filed = await deps.chain.fileMissedWindow({ consultId: row.id });
      if (filed === 'filed') counts.missedWindow += 1;
    } catch (err) {
      recordFault(fault, 'missed-window', `consult ${row.id}`, err);
    }
  }
}

/**
 * Step 3. advanceChain owns the kill switch re-check, the still-scheduled
 * guard, the too-late cut-off and the claim, so this step's only job is to hand
 * it the ids that are due, oldest ring first.
 *
 * The counter is named ringsProcessed, NOT fired, and the difference matters to
 * whoever reads the log line: it counts due rings this tick handed over, not
 * calls placed. advanceChain may legitimately place nothing, and a rescheduled
 * or too-late chain is processed and terminated without anyone's phone ringing.
 * An operator reading "fired=5" would reasonably conclude five calls went out.
 */
async function processDueRings(counts, fault) {
  const r = await deps.pool.query(FIRE_SQL, [FIRE_LIMIT]);
  for (const row of r.rows) {
    try {
      await deps.chain.advanceChain({ attemptId: Number(row.id) });
      counts.ringsProcessed += 1;
    } catch (err) {
      recordFault(fault, 'fire', `attempt ${row.id}`, err);
    }
  }
}

/**
 * One tick.
 *
 * @returns {Promise<{skipped: true}|{opened: number, capTripped: number,
 *   skippedInvalid: number, missedWindow: number, ringsProcessed: number}>}
 *   opened counts chains actually opened; capTripped counts cap-trip OUTCOMES,
 *   which is not the same as marker rows written; skippedInvalid and
 *   missedWindow count skip rows this tick filed, not rows that already stood;
 *   ringsProcessed counts due rings handed to advanceChain, NOT calls placed.
 */
async function runConsultCallSweep() {
  // The switch silences the whole clock: no chain opens, no skip row is filed,
  // and nothing already pending is advanced. Checked once, at the top, so a
  // flip mid-tick cannot leave a half-run tick.
  if (!deps.chain.isEnabled()) return { skipped: true };

  const counts = {
    opened: 0, capTripped: 0, skippedInvalid: 0, missedWindow: 0, ringsProcessed: 0,
  };
  const fault = { failed: false, error: null };

  // Each step is guarded separately so one step's OWN QUERY failing cannot cost
  // the others their work. The fire step especially: it is the one that places
  // the call a booker is waiting for, and a broken open query must not take it
  // down too. The per-row handlers inside each step never reach this catch.
  for (const [name, step] of [
    ['open', openDueChains], ['missed-window', fileMissedWindows], ['fire', processDueRings],
  ]) {
    try {
      await step(counts, fault);
    } catch (err) {
      fault.failed = true;
      fault.error = err;
      console.error(`[consultCallSweep] ${name} step failed:`, (err && err.message) || err);
    }
  }

  if (counts.opened || counts.capTripped || counts.skippedInvalid
      || counts.missedWindow || counts.ringsProcessed) {
    console.log(
      `[consultCallSweep] opened=${counts.opened} capTripped=${counts.capTripped} `
      + `skippedInvalid=${counts.skippedInvalid} missedWindow=${counts.missedWindow} `
      + `ringsProcessed=${counts.ringsProcessed}`
    );
  }

  // Raised AFTER all three steps ran: the tick does as much work as it can,
  // then reports the failure so wrapScheduler records it. A swallowed error
  // here would be a green heartbeat over a consult nobody called.
  if (fault.failed) throw toError(fault.error);
  return counts;
}

module.exports = { runConsultCallSweep, windowConstantsFault, __setDeps };
