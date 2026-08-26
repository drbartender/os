/**
 * Consult call bridge: the rolling-24h SPEND CEILINGS.
 *
 * Extracted from consultCallChain.js, which is at its size cap. Kept together
 * because they are one idea: what bounds the billed legs a PUBLIC Cal.com
 * booking page can buy.
 *
 * WHY THE COUNTS COME FROM call_audit AND NOT FROM consult_call_attempts.
 * The first version of this cap summed `admin_ring` over attempt rows. But
 * consultCallTail's R16 reschedule clear DELETEs any row `LIKE 'skipped%'`
 * standing at a re-taken slot, and a chain parked `skipped_cancelled` after
 * ringing carries its rings on exactly such a row. So ring, reschedule away,
 * reschedule back onto the same slot, and the billed rings were erased from the
 * window: measured, a sum of 3 went to 0 across one reschedule-back, and the
 * ceiling never engaged again.
 *
 * Patching the DELETE is not available: the sweep's open query anti-joins on
 * (consult_id, scheduled_at) with NO status filter, so any surviving row at that
 * slot blocks a legitimate rebooking. The clear has to delete.
 *
 * call_audit cannot be reached that way. It is append-only, indexed on
 * created_at (its own schema comment calls that "the cap-window filter"), pruned
 * on a 30-day window by pendingCall's pruner, and it is already the ledger this
 * codebase uses for exactly this job on the VA-calling spend cap.
 *
 * THE GENERAL LESSON: a spend cap must count from a ledger nothing else deletes.
 * Counting mutable state is how a ceiling reads zero while the money goes out.
 */

// call_audit statuses for the two consult legs. Deliberately NOT the bare
// 'placed' that pendingCall.js writes: call_audit is shared with the VA-calling
// feature, whose own cap counts status='placed', and two independent spend caps
// must never consume each other's budget.
const AUDIT_ADMIN_LEG = 'consult_placed_admin';
const AUDIT_VA_LEG = 'consult_placed_va';

// Math.max(1, ...) as well as the || 10: a NEGATIVE value is truthy, so it
// survives the fallback and makes every `count < cap` false, which silently
// bricks the bridge dark. For a feature whose failure mode is silence, a
// fat-fingered '-10' must not become the off switch. The || 10 half is the
// original NaN guard: unset must not become `count < NaN`, always false.
function dailyCap() { return Math.max(1, parseInt(process.env.CONSULT_CALL_DAILY_CAP, 10) || 10); }

/**
 * Rings that may be PLACED at the owner's phone per rolling 24h, as opposed to
 * dailyCap(), which bounds how many chains may OPEN.
 *
 * Derived from dailyCap() rather than given its own env var, so the worst case
 * consultCallChain's header has always asserted is true by construction rather
 * than by hope, and one knob moves both bounds together.
 */
function dialCap(maxAdminRings) { return dailyCap() * maxAdminRings; }

/**
 * The international leg's own ceiling. Counted SEPARATELY from the admin rings
 * because the two are separately documented (30 rings, 10 international legs at
 * the defaults) and because one shared ceiling would bind in NORMAL use: ten
 * full chains spend 30 admin rings AND 10 VA legs, so a combined 30 would start
 * refusing real consults.
 */
function vaLegCap() { return dailyCap(); }

/** Has the rolling-24h budget for one leg been spent? */
async function legCapTripped(pool, auditStatus, ceiling) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM call_audit
      WHERE status = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [auditStatus]
  );
  return Number(r.rows[0].n) >= ceiling;
}

/**
 * Append the billed-leg row the ceilings count. Never throws: a failed audit
 * write must not take down a call Twilio has already placed. It IS reported,
 * because a silently missing row is budget the cap will hand out twice.
 */
async function recordLegAudit(pool, { leg, to, callSid }, onError) {
  try {
    await pool.query(
      `INSERT INTO call_audit (triggered_by, target_e164, call_sid, status)
       VALUES (NULL, $1, $2, $3)`,
      [to || null, callSid || null, leg === 'admin' ? AUDIT_ADMIN_LEG : AUDIT_VA_LEG]
    );
  } catch (err) {
    if (typeof onError === 'function') onError(err);
  }
}

/**
 * File a terminal spend-cap refusal and tell a human, at most once per window.
 *
 * TERMINAL on purpose: a bare return leaves the row pending with its due time
 * and the sweep retries it every 60 seconds forever.
 *
 * THE EMAIL GATE FAILS TOWARD TELLING DALLAS. The first version asked whether
 * this row was the ONLY trip in the window (`COUNT(*) = 1`). That loses the
 * alert in the case that matters most: two trips landing close enough that both
 * COUNTs see 2, so neither mails, and a sustained attack keeps the count above 1
 * forever so no later trip mails either. Zero alerts during exactly the abuse
 * the cap exists to report. Counting OTHER trips means a race sends a second
 * email rather than none, and for a feature whose declared failure mode is
 * silence, duplicate mail is the correct way to be wrong.
 *
 * `claim` and `sendChainEmail` are passed in rather than imported: they own the
 * chain's guarded-write and email-exactly-once laws, and this module must not
 * grow a second opinion about either.
 */
async function fileCapTrip({ pool, claim, sendChainEmail, attemptId, detail }) {
  if (!(await claim(attemptId, 'pending', 'skipped_cap', { detail, clearNextRing: true }))) return;
  const others = await pool.query(
    `SELECT COUNT(*)::int AS n FROM consult_call_attempts
      WHERE detail = $2 AND id <> $1 AND updated_at > NOW() - INTERVAL '24 hours'`,
    [attemptId, detail]
  );
  if (Number(others.rows[0].n) === 0) {
    console.warn(`[consultCall] ${detail} at attempt ${attemptId}; further refusals this window are silent`);
    await sendChainEmail({
      attemptId,
      reason: detail === 'va_leg_cap_tripped' ? 'daily international-leg cap tripped' : 'daily dial cap tripped',
    });
  }
}

module.exports = {
  AUDIT_ADMIN_LEG, AUDIT_VA_LEG,
  dailyCap, dialCap, vaLegCap, legCapTripped, recordLegAudit, fileCapTrip,
};
