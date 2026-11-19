'use strict';

// The GV post sweep (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md,
// section 6 "Sweep", laws 2, 4 and 5; plan Task 9). One 60-second tick,
// registered in server/index.js under RUN_GV_POST_SWEEP_SCHEDULER. Arms, in
// order, each guarded on its own:
//
//   1. Stale: a queued row never leased within staleMin goes stale, and its
//      toll-free fallback sends (sendGvFallback, once per row).
//   2. Unknown: a leased row unreported past leaseMin goes unknown, with NO
//      fallback (the box may have clicked Send), and counts once toward the
//      unknown streak (a box that leases and then dies never reports).
//   3. Retry: a stale or failed_preclick row a restart left unclaimed (its
//      status written, its fallback call never made) gets sendGvFallback once
//      its last write is half a minute old, and only while it is younger than
//      claimStaleMin: a window a tick and a half wide, so a row always meets
//      a tick inside it. The claim makes the retry safe.
//   4. Interrupted claim: a fallback claimed more than claimStaleMin ago that
//      never finished reads failed (reason interrupted unless the row already
//      carries one). NEVER re-sent: the Twilio call may have gone out, and a
//      second text is worse than a hand paste (plan decision 11). The same
//      arm closes a row left unclaimed past claimStaleMin (the sweep was down
//      or its claims kept failing): from that age the proposal page tells the
//      team the fallback failed and to paste by hand (status.js), so a text
//      sent later could land beside a hand paste. It is marked failed and
//      never sent.
//   5. Liveness, ONLY while GV_PROPOSAL_POST_ENABLED is on: rows went stale
//      this tick and no lease in livenessMin opens an outage (one email per
//      episode, outage.js).
//
// The sweep itself is NOT gated by the kill switch (law 2): after a rollback
// flip it still drains queued rows to the toll-free text, and only the
// liveness arm, which would read an idle box as an outage, waits on the flag.
// Every status write stamps updated_at, which the retry arm and the proposal
// page (status.js) read. Rows are never pruned (plan decision 6).
//
// Plain pooled statements, no held client: sendGvFallback and noteOutage take
// their own connections. Overlapping ticks are safe: each status write is one
// conditional UPDATE (a row flips, and counts, once) and every fallback goes
// through sendGvFallback's one claim. A failed arm or row is logged and
// rethrown after every arm ran, so wrapScheduler records the tick as failed
// (the schedulerHealth contract). Logs carry post ids and counts, never a
// number.

const realSentry = require('@sentry/node');
const { pool } = require('../db');
const { GV_WINDOWS, gvPostEnabled } = require('./gvPost/rules');
const { sendGvFallback: realSendGvFallback } = require('./gvPost/fallback');
const outage = require('./gvPost/outage');

let deps = {
  sendGvFallback: realSendGvFallback,
  noteOutage: outage.noteOutage,
  noteUnknown: outage.noteUnknown,
  Sentry: realSentry,
};

// The retry arm waits this long after a row's last write before claiming its
// fallback, so a status write whose own fallback call is still under way is
// never raced (the claim would make it safe; this keeps the sweep out of the
// way). Half a minute, not a whole one: with claimStaleMin (2 minutes) as the
// upper bound the window is 90 seconds, wider than the 60-second tick, so a
// row whose first claim threw cannot fall between two ticks and be closed
// without a text (verify, 2026-11-19).
const RETRY_AFTER_SEC = 30;

const cause = (err) => (err && (err.code || err.name)) || 'unknown';

// One fallback, its claim failure kept for the tick's rethrow. Nothing was
// claimed or sent when sendGvFallback throws, so the retry arm takes the row
// on a later tick.
async function fallBack(postId, errors) {
  try {
    await deps.sendGvFallback(postId);
  } catch (err) {
    console.error(`[gvPostSweep] post ${postId} fallback claim failed (${cause(err)}); the retry arm takes it next`);
    errors.push(err);
  }
}

// One warning per run that touched rows, with the count, plus a console line.
function warnTouched(event, ids, line) {
  console.warn(`[gvPostSweep] ${line}: ${ids.length} (posts ${ids.join(', ')})`);
  deps.Sentry.captureMessage(`GV post sweep: ${line}`, {
    level: 'warning',
    tags: { feature: 'gv_post', event },
    extra: { count: ids.length, postIds: ids.slice(0, 20) },
  });
}

// Arm 1.
async function staleQueued(errors) {
  const { rows } = await pool.query(
    `UPDATE gv_posts SET status = 'stale', updated_at = now()
      WHERE status = 'queued' AND created_at < now() - make_interval(mins => $1)
      RETURNING id`,
    [GV_WINDOWS.staleMin]
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  warnTouched('stale', ids, 'queued posts went stale, the toll-free text goes instead');
  for (const id of ids) await fallBack(id, errors);
  return ids.length;
}

// Arm 2. Returns whether a streak count sent the episode's email.
async function unknownLeased(errors) {
  const { rows } = await pool.query(
    `UPDATE gv_posts SET status = 'unknown', updated_at = now()
      WHERE status = 'leased' AND leased_at < now() - make_interval(mins => $1)
      RETURNING id`,
    [GV_WINDOWS.leaseMin]
  );
  if (rows.length === 0) return { count: 0, alerted: false };
  const ids = rows.map((r) => r.id);
  warnTouched('unknown', ids, 'leased posts went unreported past the lease window (no fallback)');
  let alerted = false;
  for (let i = 0; i < ids.length; i += 1) {
    try {
      if (await deps.noteUnknown()) alerted = true;
    } catch (err) {
      console.error(`[gvPostSweep] unknown streak count failed (${cause(err)})`);
      errors.push(err);
    }
  }
  return { count: ids.length, alerted };
}

// Arm 3.
async function retryUnclaimed(errors) {
  const { rows } = await pool.query(
    `SELECT id FROM gv_posts
      WHERE status IN ('stale','failed_preclick') AND fallback_status IS NULL
        AND updated_at < now() - make_interval(secs => $1)
        AND updated_at >= now() - make_interval(mins => $2)
      ORDER BY updated_at`,
    [RETRY_AFTER_SEC, GV_WINDOWS.claimStaleMin]
  );
  if (rows.length === 0) return 0;
  console.warn(`[gvPostSweep] retrying the fallback of ${rows.length} unclaimed post(s): ${rows.map((r) => r.id).join(', ')}`);
  for (const row of rows) await fallBack(row.id, errors);
  return rows.length;
}

// Arm 4.
async function failInterruptedClaims() {
  const { rows } = await pool.query(
    `UPDATE gv_posts
        SET fallback_status = 'failed', reason = COALESCE(reason, 'interrupted'), updated_at = now()
      WHERE fallback_status = 'claimed' AND fallback_at < now() - make_interval(mins => $1)
      RETURNING id, proposal_id`,
    [GV_WINDOWS.claimStaleMin]
  );
  for (const row of rows) {
    console.warn(`[gvPostSweep] post ${row.id} fallback claim never finished: marked failed, never re-sent (proposal ${row.proposal_id})`);
    deps.Sentry.captureMessage('GV post fallback interrupted: marked failed, never re-sent', {
      level: 'warning',
      tags: { feature: 'gv_post', event: 'fallback_interrupted' },
      extra: { postId: row.id, proposalId: row.proposal_id },
    });
  }
  // Never claimed, and past the age at which the page already reads failed:
  // closed in the data too, so no later tick can text beside a hand paste.
  const abandoned = await pool.query(
    `UPDATE gv_posts
        SET fallback_status = 'failed', fallback_at = now(), reason = COALESCE(reason, 'interrupted'), updated_at = now()
      WHERE status IN ('stale','failed_preclick') AND fallback_status IS NULL
        AND updated_at < now() - make_interval(mins => $1)
      RETURNING id, proposal_id`,
    [GV_WINDOWS.claimStaleMin]
  );
  for (const row of abandoned.rows) {
    console.warn(`[gvPostSweep] post ${row.id} fallback was never claimed in time: marked failed, never sent late (proposal ${row.proposal_id})`);
    deps.Sentry.captureMessage('GV post fallback never claimed in time: marked failed, never sent late', {
      level: 'warning',
      tags: { feature: 'gv_post', event: 'fallback_abandoned' },
      extra: { postId: row.id, proposalId: row.proposal_id },
    });
  }
  return rows.length;
}

// Arm 5. Only while the switch is on: with it off the box idles by design.
// A missing state row reads as a live sender (outage.js: never an email storm).
async function checkLiveness(staled) {
  if (!gvPostEnabled() || staled === 0) return false;
  const { rows } = await pool.query(
    `SELECT (last_lease_at IS NULL OR last_lease_at < now() - make_interval(mins => $1)) AS idle
       FROM gv_sender_state
      WHERE id = 1`,
    [GV_WINDOWS.livenessMin]
  );
  if (!rows[0] || !rows[0].idle) return false;
  return deps.noteOutage('no_lease');
}

/**
 * One sweep tick. Every arm runs whatever the others did; the first error is
 * rethrown after the last arm.
 *
 * @returns {Promise<{staled:number, unknowned:number, alerted:boolean}>}
 *   alerted: this tick sent the outage episode's email (the no-lease check or
 *   the unknown streak)
 */
async function runGvPostSweep() {
  const counts = { staled: 0, unknowned: 0, alerted: false };
  const errors = [];

  try {
    counts.staled = await staleQueued(errors);
  } catch (err) {
    console.error(`[gvPostSweep] stale arm failed (${cause(err)})`);
    errors.push(err);
  }

  try {
    const unknown = await unknownLeased(errors);
    counts.unknowned = unknown.count;
    if (unknown.alerted) counts.alerted = true;
  } catch (err) {
    console.error(`[gvPostSweep] unknown arm failed (${cause(err)})`);
    errors.push(err);
  }

  try {
    await retryUnclaimed(errors);
  } catch (err) {
    console.error(`[gvPostSweep] retry arm failed (${cause(err)})`);
    errors.push(err);
  }

  try {
    await failInterruptedClaims();
  } catch (err) {
    console.error(`[gvPostSweep] interrupted-claim arm failed (${cause(err)})`);
    errors.push(err);
  }

  try {
    if (await checkLiveness(counts.staled)) counts.alerted = true;
  } catch (err) {
    console.error(`[gvPostSweep] liveness arm failed (${cause(err)})`);
    errors.push(err);
  }

  if (errors.length > 0) throw errors[0];
  return counts;
}

// Test seam (the firstReplySweepScheduler.js convention): the fallback, the
// two outage notes, and Sentry.
function __setDeps(d) { deps = { ...deps, ...d }; }

module.exports = { runGvPostSweep, __setDeps };
