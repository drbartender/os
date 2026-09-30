/**
 * Consult call bridge: the reaper (spec 2026-08-25 section 4.2; moved here by
 * spec 2026-09-30 section 4.4).
 *
 * It rides the consult sweep's 60-second tick, under
 * RUN_CONSULT_CALL_SWEEP_SCHEDULER. It used to ride the hourly VA prune under
 * RUN_VA_CALLING_SCHEDULER, so the sweep could run with its only rescue
 * switched off: calling_* rows then held a cap slot for 24 hours and nobody
 * was told.
 *
 *   reapStaleConsultCallAttempts()  a chain stranded mid-ring (pending or
 *                                   calling_*) half an hour past its slot.
 *   reapUnconfirmedBridges()        a press-1 that never produced any report
 *                                   of the client leg (spec 2026-09-30 4.3).
 *
 * Each UPDATE is the claim: every id it returns is a row THIS pass
 * transitioned, so each email goes out exactly once.
 */

const { pool } = require('../db');
const consultCallChain = require('./consultCallChain');

// Past the call's own time limit, how long a bridge may stay silent before it
// is reported. Ten minutes absorbs a late status callback.
const BRIDGE_GRACE_SEC = 600;

// Same 1800s default as consultCallChain.js and voiceConsultCall.js, each of
// which keeps its own copy (house pattern, never exported).
function timeLimitSec() { return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800; }

let deps = {
  pool,
  sendChainEmail: (...a) => consultCallChain.sendChainEmail(...a),
};
function __setDeps(d) { deps = { ...deps, ...d }; }

// A consult chain can be stranded in a non-terminal state by a crash, by a
// Twilio status callback that never arrives, or by a deploy landing mid-chain.
// Nothing else rescues it: the sweep only opens chains inside a five-minute
// window around the slot, so a row left in pending/calling_* just sits there
// and Dallas never learns the consult went unanswered.
//
// Anchored on scheduled_at, NOT created_at like the lead sibling: the whole ring
// plan finishes within twelve minutes of the slot (TOO_LATE_VA_SEC), so a slot
// half an hour gone is unambiguously stranded, while a chain opened early for a
// slot still in the future is not yet late at all. 'connected' is excluded.
//
// Kill switch off, the SAME rows are filed 'skipped_disabled' and nothing is
// emailed. That branch is the point of the function, not a detail: if Dallas
// flips the switch off during an incident, every chain parked mid-flight would
// otherwise be reported to him as a system failure, one email per consult,
// when the system did exactly what he told it to. The sweep runs this arm even
// while the switch is off, for exactly that reason.
async function reapStaleConsultCallAttempts() {
  const enabled = consultCallChain.isEnabled();
  const reaped = await deps.pool.query(
    `UPDATE consult_call_attempts
        SET status = $1, detail = $2, next_ring_at = NULL, updated_at = NOW()
      WHERE status IN ('pending', 'calling_admin', 'calling_va')
        AND scheduled_at < NOW() - make_interval(mins => $3::int)
      RETURNING id`,
    [enabled ? 'failed' : 'skipped_disabled', 'stale_reaped', consultCallChain.STALE_MINUTES]
  );
  // The switch silences the alert, not just the dialing.
  if (!enabled) return reaped.rowCount;
  for (const row of reaped.rows) {
    // 'call failed' rather than a skip banner: a stranded row IS a system
    // fault, and that banner is the one that says go look at the system.
    await deps.sendChainEmail({ attemptId: Number(row.id), reason: 'call failed' });
  }
  return reaped.rowCount;
}

// A press-1 claims 'connected', which was terminal and never reaped, so a
// <Dial> that failed at Twilio without producing either callback left a
// settled-looking row and no alert. The client leg reports back two ways: its
// <Number statusCallback> writes bridge_duration_sec, and the <Dial action>
// (/dialend) latches client_no_answer_at for no-answer, busy, failed or
// canceled. A row with neither, past the call's own time limit plus grace, has
// no evidence the client was ever called. It becomes 'failed' so it shows in
// Needs attention. If Twilio merely lost the report of a real call, the cost
// is one false alarm, which is the right way for this feature to be wrong. A
// report arriving even later is not handled (spec 2026-09-30 4.3). detail is
// overwritten on purpose: both labels key on 'bridge_unconfirmed'.
//
// Switch off: no write and no email, matching the stale arm's silence. A row
// left 'connected' then is picked up on the first tick after it comes back on.
async function reapUnconfirmedBridges() {
  if (!consultCallChain.isEnabled()) return 0;
  const reaped = await deps.pool.query(
    `UPDATE consult_call_attempts
        SET status = 'failed', detail = 'bridge_unconfirmed', updated_at = NOW()
      WHERE status = 'connected'
        AND bridge_duration_sec IS NULL
        AND client_no_answer_at IS NULL
        AND bridge_started_at < NOW() - make_interval(secs => $1::int)
      RETURNING id`,
    [timeLimitSec() + BRIDGE_GRACE_SEC]
  );
  for (const row of reaped.rows) {
    await deps.sendChainEmail({ attemptId: Number(row.id), reason: 'bridge unconfirmed' });
  }
  return reaped.rowCount;
}

module.exports = {
  reapStaleConsultCallAttempts, reapUnconfirmedBridges, BRIDGE_GRACE_SEC, __setDeps,
};
