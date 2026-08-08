// server/utils/voicemailEscalation.js
//
// The DB half of the press-1 escalation (spec 2026-07-26 section 3): the claim
// that stops a duplicate billed leg, the rolling spend window, and the outcome
// write.
//
// Kept out of server/utils/voicemail.js on purpose. That module owns the
// delivery pipeline (fetch, upload, the destructive Twilio delete); escalation is
// a different concern on the same table, and separating them keeps each file
// small enough to reason about and lets them be reviewed independently.

const { pool } = require('../db');

const OUTCOMES = new Set([
  'answered', 'no_answer', 'declined', 'skipped_cap', 'skipped_quiet', 'skipped_no_target',
]);

let _deps = { pool };
function __setEscalationDeps(d) { _deps = { ..._deps, ...d }; }

// App-level advisory-lock class for the cap-checked claim (same idiom as
// cancel.js's CANCEL_REFUND_LOCK_CLASS 74206). One constant key: every
// escalation claim serializes on it, which is what makes the rolling cap a
// real bound instead of advisory. At a handful of escalations a day the
// serialization costs nothing.
const VM_ESCALATION_LOCK_CLASS = 74209;

/** Max escalation legs per rolling 24h. Toll-fraud bound on a new billed leg. */
function escalationDailyCap() {
  const n = parseInt(process.env.VM_ESCALATION_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * Claim the right to place ONE escalation leg for this call, and read back the
 * line in the same round trip (the <Gather action> body does not carry it in a
 * form we trust more than the row).
 *
 * The guard is `escalated_at IS NULL`, which makes this the same
 * claim-before-you-spend shape as the missed-call ping's PK insert and the
 * lead-call bridge's status transition (server/routes/voiceLeadCall.js:173-180).
 * Twilio delivers a <Gather action> at least once, so without it a redelivered
 * callback places a second billed leg, and on the primary line that leg is
 * international.
 *
 * @returns {Promise<{line: 'primary'|'zul'}|null>} null iff already claimed or
 *   the call was never registered as a miss.
 */
async function claimEscalation(callSid, client = null) {
  if (!isCallSid(callSid)) return null;
  const q = client || _deps.pool;
  const { rows } = await q.query(
    `UPDATE voicemail_delivery
        SET escalated_at = NOW()
      WHERE call_sid = $1
        AND escalated_at IS NULL
      RETURNING line`,
    [callSid]
  );
  return rows.length > 0 ? { line: rows[0].line } : null;
}

/**
 * Cap check and claim as ONE serialized unit. Check-then-claim as two
 * autocommit statements makes the cap advisory: N simultaneous press-1s all
 * read a count below the cap, all claim their own rows, and the window admits
 * cap + peak-concurrency billed legs (demonstrated in review, 2026-08-07).
 * The advisory xact lock serializes every claim on one constant key, so the
 * count each claimant reads already includes every earlier winner.
 *
 * Holds ONE pooled connection for the whole transaction (CLAUDE.md pool rule)
 * and releases it before returning. Throws on any DB failure: the route treats
 * a throw as "do not dial", which is the fail-closed direction for spend.
 *
 * @returns {Promise<{capped: boolean, claim: {line: 'primary'|'zul'}|null}>}
 *   capped=true means the window is full (no claim consumed); claim=null with
 *   capped=false means already claimed or unknown call.
 */
async function claimEscalationUnderCap(callSid) {
  if (!isCallSid(callSid)) return { capped: false, claim: null };
  const client = await _deps.pool.connect();
  try {
    // READ COMMITTED is load-bearing, so pin it: under REPEATABLE READ the
    // snapshot is taken BEFORE the lock wait and the count cannot see the
    // previous winner's commit, silently reverting the cap to advisory.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    // A queued claimant holds a pooled connection while it waits; without a
    // bound, one stalled transaction parks every later press-1 on a live-caller
    // path (Twilio gives up at ~15s) and bleeds the shared pool. 55P03 lands in
    // the catch below, which is the fail-closed no-dial direction.
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [VM_ESCALATION_LOCK_CLASS, 0]);
    const n = await countEscalationsSince(24, client);
    if (n >= escalationDailyCap()) {
      await client.query('ROLLBACK');
      return { capped: true, claim: null };
    }
    const claim = await claimEscalation(callSid, client);
    await client.query('COMMIT');
    return { capped: false, claim };
  } catch (err) {
    // A failed ROLLBACK means the connection itself is broken, which is
    // exactly the diagnostic worth having when this path misbehaves.
    await client.query('ROLLBACK').catch((rbErr) => console.error(`[vm-escalate] ROLLBACK failed: ${rbErr.message}`));
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Rolling-window count of escalation legs, backing VM_ESCALATION_DAILY_CAP.
 * Counts the CLAIM, not the outcome: the spend is committed at dial time.
 * Throws on a non-positive window: a negative interval silently counts zero,
 * which fails OPEN, and every other failure mode in this module points the
 * other way.
 */
async function countEscalationsSince(hours, client = null) {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new TypeError(`countEscalationsSince: hours must be a positive number, got ${hours}`);
  }
  const q = client || _deps.pool;
  const { rows } = await q.query(
    `SELECT COUNT(*)::int AS n FROM voicemail_delivery
      WHERE escalated_at > NOW() - ($1 || ' hours')::interval`,
    [String(hours)]
  );
  return rows[0].n;
}

/**
 * Twilio CallSid shape. Gates the parent sid we echo through the whisper and
 * accept URLs, so nothing arbitrary is ever carried in a query string or handed
 * to a query, even though the query is also parameterized and HMAC-covered.
 */
function isCallSid(value) {
  return typeof value === 'string' && /^CA[0-9a-f]{32}$/.test(value);
}

/**
 * Record that a HUMAN accepted the escalation by pressing a key on the whisper.
 *
 * This is the only signal escalate/done can trust. See the header note: an
 * auto-answering carrier voicemail produces DialCallStatus=completed just like a
 * real conversation does, so without this the fallback hangs up on a caller who
 * never reached a person. The COALESCE keeps the first acceptance if Twilio
 * redelivers the accept callback.
 */
async function markEscalationAccepted(callSid) {
  if (!isCallSid(callSid)) return;
  const { rowCount } = await _deps.pool.query(
    `UPDATE voicemail_delivery
        SET escalation_accepted_at = COALESCE(escalation_accepted_at, NOW())
      WHERE call_sid = $1
        AND escalated_at IS NOT NULL`,
    [callSid]
  );
  // accepted-without-claimed is an impossible ledger shape (the guard above
  // refuses to create it), and a zero-row write means the row was pruned or
  // never claimed; surface it instead of reporting silent success.
  if (rowCount === 0) {
    console.warn(`[vm-escalate] accept write matched no claimed row sid=...${String(callSid).slice(-4)}`);
  }
}

/**
 * Did a human accept this escalation? Fails CLOSED (false) on a bad sid, a missing
 * row, or a read error: "not accepted" sends the caller to voicemail, which is
 * always recoverable, while a false "accepted" hangs up on them, which is not.
 */
async function wasEscalationAccepted(callSid) {
  if (!isCallSid(callSid)) return false;
  try {
    const { rows } = await _deps.pool.query(
      'SELECT escalation_accepted_at FROM voicemail_delivery WHERE call_sid = $1',
      [callSid]
    );
    return Boolean(rows[0] && rows[0].escalation_accepted_at);
  } catch (err) {
    // The docstring's promise, kept HERE and not left to the route: a caller
    // is live on the line when this runs, and a throw would become "an
    // application error has occurred" instead of the voicemail fallback.
    console.error(`[vm-escalate] acceptance read failed sid=...${String(callSid).slice(-4)}: ${err.message}`);
    return false;
  }
}

/**
 * Record why the escalation ended. Observability only; nothing branches on it.
 * An off-list outcome is DROPPED rather than written, so a future caller passing
 * a typo logs a warning instead of violating the CHECK and failing the write on a
 * row that matters. First writer wins (COALESCE), the same redelivery convention
 * as escalation_accepted_at: outcomes do not legitimately sequence, so a
 * redelivered late callback must not overwrite what actually happened.
 */
async function recordEscalationOutcome({ callSid, outcome }) {
  if (!callSid) return;
  if (!OUTCOMES.has(outcome)) {
    console.warn(`[vm-escalate] refusing off-list outcome "${outcome}" sid=...${String(callSid).slice(-4)}`);
    return;
  }
  const { rowCount } = await _deps.pool.query(
    'UPDATE voicemail_delivery SET escalation_outcome = COALESCE(escalation_outcome, $1) WHERE call_sid = $2',
    [outcome, callSid]
  );
  if (rowCount === 0) {
    console.warn(`[vm-escalate] outcome write matched no row sid=...${String(callSid).slice(-4)}`);
  }
}

module.exports = {
  OUTCOMES, isCallSid, escalationDailyCap, claimEscalation, claimEscalationUnderCap,
  countEscalationsSince, markEscalationAccepted, wasEscalationAccepted,
  recordEscalationOutcome, __setEscalationDeps,
};
