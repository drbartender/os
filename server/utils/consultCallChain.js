/**
 * Consult call bridge: chain driver (spec 2026-08-25 section 4.2). A Cal.com
 * consult booking lands in `consults`; at the slot this module rings Dallas and
 * press-1 bridges him to the booker. It holds both halves of the driver.
 *
 * The OPEN side, which decides whether a chain should EXIST at all:
 *
 *   - consultCallTail(...): the Cal.com webhook's post-commit tail. NEVER
 *     throws (the webhook's 200/503 semantics must not change) and never takes
 *     the caller's pooled client (bare pool.query only; pool-deadlock law).
 *   - openChain({ consultId }): the sweep's atomic cap-plus-open.
 *   - fileUndialable / fileMissedWindow: the terminal skip rows that keep an
 *     un-callable consult visible instead of silently dropping it.
 *   - sendChainEmail({ attemptId, reason }): the one admin email per chain.
 *
 * and the FIRE side, the half that places the billed calls:
 *
 *   - advanceChain({ attemptId }): the sweep's fire step, claim then dial.
 *   - onLegTerminal({ attemptId, leg, ring, callStatus }): one leg reached a
 *     terminal Twilio status; ring-guarded (R5) and the owner of every
 *     non-initial transition.
 *   - placeLeg / sendMissedText / guardStillScheduled / claim.
 *
 * SCHEDULED_AT NEVER ROUND-TRIPS THROUGH JAVASCRIPT (ruling R12). node-pg hands
 * a TIMESTAMPTZ back as a millisecond-precision JS Date, so a microsecond slot
 * read into JS and written back is a DIFFERENT value: it matches neither the
 * sweep's `a.scheduled_at = c.scheduled_at` anti-join nor the
 * (consult_id, scheduled_at) UNIQUE. The sweep would then re-open the consult
 * on every 60 second tick until the daily cap tripped, which is 30 rings to
 * Dallas, 10 international legs and 10 texts. Every writer below therefore
 * takes `consultId` only and derives the slot from the consults row INSIDE the
 * SQL. Two slots are only ever compared in SQL, never as JS Date objects.
 *
 * Claim-then-call law: every billed or notifying side effect fires only when
 * its guarded write won (rowCount 1), so duplicate webhooks and Twilio's
 * at-least-once callbacks can never double-dial or double-email.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { placeBridgedCall, cancelBridgedCall, sendSMS } = require('./sms');
const { notifyAdminCategory } = require('./adminNotifications');
const { consultCallAdmin } = require('./emailTemplates');
const { formatUsPhoneForText, clockTimeWithMinutes } = require('./consultCallBriefing');
const { toUsE164 } = require('./usPhone');
const { ADMIN_URL, API_URL } = require('./urls');

// Ring plan (spec section 4.2, code constants by design: these are call
// choreography, not operator settings). Offsets are seconds relative to
// scheduled_at, so ring 1 lands 90 seconds BEFORE the slot.
const RING_OFFSETS_SEC = { 1: -90, 2: 60, 3: 180 };
const MAX_ADMIN_RINGS = 3;
const ADMIN_RING_SECONDS = 20;
const VA_RING_SECONDS = 25;

// Sweep windows, in minutes: how far ahead of a slot a chain may open, how far
// behind it may still open, and how far behind is "the slot got missed".
const OPEN_AHEAD_MINUTES = 5;
const OPEN_BEHIND_MINUTES = 3;
const MISSED_WINDOW_MINUTES = 30;

// Past these many seconds after the slot, ringing is worse than not ringing.
const TOO_LATE_ADMIN_SEC = 600;
const TOO_LATE_VA_SEC = 720;

// A chain stuck mid-ring this long is abandoned rather than resumed.
const STALE_MINUTES = 30;

// The || 10 fallback is load-bearing: an unset env var must not become
// `count < NaN` (always false), which would cap-trip every consult.
function dailyCap() { return parseInt(process.env.CONSULT_CALL_DAILY_CAP, 10) || 10; }

// Default ON, like LEAD_CALL_ENABLED. Only the literal 'false' kills it.
function isEnabled() { return process.env.CONSULT_CALL_ENABLED !== 'false'; }

// Same 1800s default as voice.js timeLimitSec (duplicated there too, not exported).
function timeLimitSec() { return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800; }

// Strict E.164: what a text destination must match before anything is sent.
// Mirrors voicemailLine.js's E164_RE and the boot check in server/index.js.
const STRICT_E164 = /^\+[1-9]\d{6,14}$/;

// The only statuses that mean a leg is DONE: the five terminal Twilio call
// statuses, plus the internal 'create_failed' placeLeg reports when the call
// was never placed at all. Ruling R25: onLegTerminal is a billed-effect
// boundary and must not trust its caller to have filtered. A non-terminal
// status such as 'answered' reaching the admin branch for a LIVE ring 1 would
// re-arm the row to pending with ring-2 timing, and the sweep would dial Dallas
// a second time while he is mid-briefing on the first call. The route carries
// the same allowlist; this one is defense in depth, and it is what makes the
// JSDoc's word "terminal" an enforced precondition rather than a hope.
const TERMINAL_CALL_STATUSES = new Set([
  'completed', 'no-answer', 'busy', 'failed', 'canceled', 'create_failed',
]);

// Dependency-injection seam for tests (mirrors leadCallTrigger.js __setDeps).
let _deps = { pool, placeBridgedCall, cancelBridgedCall, notifyAdminCategory, sendSMS };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

function last4(p) { return String(p || '').slice(-4); }

function captureError(err, step) {
  // A rejection value is not guaranteed to be an Error. An unguarded
  // err.message throws OUT of the catch that called this, and out of
  // consultCallTail, which is the one thing the tail law forbids.
  console.error(`[consultCall] ${step} failed:`, (err && err.message) || err);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureException(err, { tags: { component: 'consult-call', step } });
  }
}

/**
 * The one admin email per chain. Loads the consult facts through the attempt
 * row so the caller only has to hold an attempt id. Caller must be a guarded
 * write winner (email-exactly-once law). Swallows: an alert that fails must
 * never take down the call chain that raised it.
 *
 * booker_phone is attacker-typed (the Cal.com booking page is public). It is
 * HTML-escaped by the template and never reaches Sentry. The slot reported is
 * the ATTEMPT's, so the alert stays historically accurate after a reschedule.
 *
 * @param {Object} opts
 * @param {number|string} opts.attemptId consult_call_attempts.id
 * @param {string} opts.reason one of the C3 banner reasons
 */
async function sendChainEmail(opts) {
  try {
    // Destructured INSIDE the try: `{ a } = {}` still throws on an explicit
    // null, and neither of this file's swallowing entry points may throw.
    const { attemptId, reason } = opts || {};
    const r = await _deps.pool.query(
      // a.scheduled_at, NOT c.scheduled_at: this alert is about ONE chain, and
      // the attempt row carries the slot that chain actually ran against. If
      // the consult has since moved, an email about the old chain that named
      // the NEW slot would send Dallas to the wrong time.
      `SELECT c.booker_name, c.booker_phone, a.scheduled_at, c.client_id, c.proposal_id
         FROM consult_call_attempts a
         JOIN consults c ON c.id = a.consult_id
        WHERE a.id = $1`,
      [attemptId]
    );
    if (r.rowCount === 0) return;
    const row = r.rows[0];
    const dialable = toUsE164(row.booker_phone);
    const tpl = consultCallAdmin({
      bookerName: row.booker_name,
      scheduledAt: row.scheduled_at,
      reason,
      // The literal 'none' matches the template's own empty-number word, so the
      // two can never drift into saying different things about the same case.
      phoneDisplay: dialable ? formatUsPhoneForText(dialable) : String(row.booker_phone || 'none'),
      adminUrl: row.client_id ? `${ADMIN_URL}/clients/${row.client_id}` : null,
      proposalUrl: row.proposal_id ? `${ADMIN_URL}/proposals/${row.proposal_id}` : null,
    });
    await _deps.notifyAdminCategory({
      category: 'lead_call',
      subject: tpl.subject,
      emailHtml: tpl.html,
      emailText: tpl.text,
    });
  } catch (err) {
    captureError(err, 'chain-email');
  }
}

/**
 * File the terminal "we will never dial this one" row. Idempotent through the
 * (consult_id, scheduled_at) UNIQUE, so a duplicate webhook files nothing and
 * emails nothing.
 *
 * The email is bounded to one per rolling 24h by the min-id pattern: the row
 * holding the MINIMUM id in the window sends. A count == 1 check would send
 * ZERO emails under a concurrent double-file (both commit, both count 2).
 *
 * @param {Object} args
 * @param {number} args.consultId
 * @param {string} [args.bookerPhone] the raw typed number, only to tell an
 *   unusable number apart from no number at all
 * @returns {Promise<'filed'|'exists'>} 'exists' also covers a consult row that
 *   vanished between the caller's SELECT and this call: nothing is filed.
 */
async function fileUndialable({ consultId, bookerPhone }) {
  const detail = bookerPhone ? 'invalid_phone' : 'no_phone';
  const ins = await _deps.pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail)
     SELECT c.id, c.scheduled_at, 'skipped_invalid_phone', $2
       FROM consults c
      WHERE c.id = $1
     ON CONFLICT (consult_id, scheduled_at) DO NOTHING
     RETURNING id`,
    [consultId, detail]
  );
  if (ins.rowCount === 0) return 'exists';

  console.log(`[consultCall] consult ${consultId} is undialable (${detail}, ...${last4(bookerPhone)})`);
  const min = await _deps.pool.query(
    `SELECT MIN(id)::bigint AS min_id FROM consult_call_attempts
      WHERE status = 'skipped_invalid_phone' AND created_at > NOW() - INTERVAL '24 hours'`
  );
  if (Number(min.rows[0].min_id) === Number(ins.rows[0].id)) {
    await sendChainEmail({ attemptId: Number(ins.rows[0].id), reason: 'undialable number' });
  }
  return 'filed';
}

/**
 * File the terminal "the slot passed before we could ring" row. Emails once
 * PER ROW, with no rolling bound (ruling R7): each row is a distinct consult a
 * human now has to call by hand, so collapsing them would lose calls.
 *
 * @param {Object} args
 * @param {number} args.consultId
 * @returns {Promise<'filed'|'exists'>} 'exists' also covers a vanished consult.
 */
async function fileMissedWindow({ consultId }) {
  const ins = await _deps.pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status)
     SELECT c.id, c.scheduled_at, 'skipped_missed_window'
       FROM consults c
      WHERE c.id = $1
     ON CONFLICT (consult_id, scheduled_at) DO NOTHING
     RETURNING id`,
    [consultId]
  );
  if (ins.rowCount === 0) return 'exists';
  console.log(`[consultCall] consult ${consultId} missed its call window`);
  await sendChainEmail({ attemptId: Number(ins.rows[0].id), reason: 'missed window' });
  return 'filed';
}

/**
 * Open the ring chain for one consult, or record why it could not open.
 *
 * The cap and the open are ONE statement. Under READ COMMITTED a truly
 * concurrent burst can still overshoot by the number of in-flight callers
 * (each statement snapshots before the others commit); this is a toll-fraud
 * BACKSTOP that bounds sustained spend, not a hard cap. Every dialed target is
 * independently validated and timeLimit-capped.
 *
 * The cap counts only `status NOT LIKE 'skipped%'` rows, and the cap-trip
 * marker is itself `skipped_cap` (ruling R15), so a burst of junk bookings on
 * the PUBLIC Cal.com page cannot slide the rolling window forward and hold the
 * whole feature down for 24 hours past the last one.
 *
 * @param {Object} args
 * @param {number} args.consultId
 * @returns {Promise<'opened'|'exists'|'cap_tripped'>} 'exists' also covers the
 *   degenerate case of a consult row that vanished between the caller's SELECT
 *   and this call: nothing is inserted and nothing is emailed.
 */
async function openChain({ consultId }) {
  // next_ring_at is built from RING_OFFSETS_SEC[1] rather than a literal
  // INTERVAL '90 seconds', so the ring plan cannot drift away from the SQL.
  const ins = await _deps.pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, next_ring_at)
     SELECT c.id, c.scheduled_at, 'pending', c.scheduled_at + make_interval(secs => $3)
       FROM consults c
      WHERE c.id = $1
        AND (SELECT COUNT(*) FROM consult_call_attempts
              WHERE created_at > NOW() - INTERVAL '24 hours'
                AND status NOT LIKE 'skipped%') < $2
     ON CONFLICT (consult_id, scheduled_at) DO NOTHING
     RETURNING id`,
    [consultId, dailyCap(), RING_OFFSETS_SEC[1]]
  );
  if (ins.rowCount === 1) {
    console.log(`[consultCall] chain ${ins.rows[0].id} opened for consult ${consultId}`);
    return 'opened';
  }

  // Nothing inserted: either a chain already stands at this consult's CURRENT
  // slot, or the consult itself is gone, or the cap tripped. The chain probe
  // joins on the slot in SQL, exactly like the sweep's anti-join, so the two
  // can never disagree about whether this consult still needs opening.
  const probe = await _deps.pool.query(
    `SELECT EXISTS (SELECT 1 FROM consults WHERE id = $1) AS consult_present,
            EXISTS (SELECT 1 FROM consult_call_attempts a
                      JOIN consults c ON c.id = a.consult_id AND c.scheduled_at = a.scheduled_at
                     WHERE a.consult_id = $1) AS chain_present`,
    [consultId]
  );
  if (probe.rows[0].chain_present || !probe.rows[0].consult_present) return 'exists';

  // Cap trip: file the marker so the consult still surfaces in the attention
  // feed, and email only on the FIRST trip per rolling 24h (Resend quota).
  const capIns = await _deps.pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail)
     SELECT c.id, c.scheduled_at, 'skipped_cap', 'cap_tripped'
       FROM consults c
      WHERE c.id = $1
     ON CONFLICT (consult_id, scheduled_at) DO NOTHING
     RETURNING id`,
    [consultId]
  );
  if (capIns.rowCount === 1) {
    console.warn(`[consultCall] daily cap tripped, consult ${consultId} will not be called`);
    const min = await _deps.pool.query(
      `SELECT MIN(id)::bigint AS min_id FROM consult_call_attempts
        WHERE detail = 'cap_tripped' AND created_at > NOW() - INTERVAL '24 hours'`
    );
    if (Number(min.rows[0].min_id) === Number(capIns.rows[0].id)) {
      await sendChainEmail({ attemptId: Number(capIns.rows[0].id), reason: 'daily cap tripped' });
    }
  }
  return 'cap_tripped';
}

/**
 * Cal.com webhook post-commit tail. Runs AFTER the handler released its pooled
 * client, on bare pool.query, and NEVER throws.
 *
 * It deliberately does NOT open a chain: a consult booked three weeks out would
 * otherwise leave a pending row sitting for three weeks. The sweep opens the
 * chain five minutes before the slot. The tail's whole job is the three things
 * only the webhook knows: this number cannot be dialed, this slot was just
 * re-booked, and this booking moved off a slot Cal.com would not name.
 *
 * @param {Object} opts
 * @param {number} opts.consultId
 * @param {Date|string} opts.scheduledAt the new slot, READ ONLY (compared
 *   against now; never written back, see the R12 note at the top of this file)
 * @param {string} [opts.bookerPhone] raw typed number
 * @param {string} [opts.triggerEvent] Cal.com trigger, e.g. BOOKING_RESCHEDULED
 * @param {string} [opts.unresolvedOldUid] set when a reschedule named an old
 *   booking uid the webhook could not resolve to a consults row
 * @param {string} [opts.bookerEmail] the RAW consults.booker_email value
 *   (ruling R2), never a validated or normalized one
 */
async function consultCallTail(opts) {
  try {
    const {
      consultId, scheduledAt, bookerPhone, triggerEvent, unresolvedOldUid, bookerEmail,
    } = opts || {};
    if (!isEnabled()) return;
    if (!consultId || !scheduledAt) return;
    // Read-only comparison. An unparseable value fails BOTH comparisons, so it
    // is rejected explicitly rather than falling through as "in the future".
    const slot = new Date(scheduledAt);
    if (Number.isNaN(slot.getTime()) || slot <= new Date()) return;

    // Ruling R3: sibling marking runs BEFORE the phone check, so a moved slot
    // is stopped even when the NEW booking's number turns out to be undialable.
    // One statement, so no slot is ever read into JS on the way.
    if (unresolvedOldUid && typeof bookerEmail === 'string' && bookerEmail.trim()) {
      const marked = await _deps.pool.query(
        `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail)
         SELECT c.id, c.scheduled_at, 'skipped_cancelled', 'rescheduled_unresolved'
           FROM consults c
          WHERE c.booker_email = $1
            AND c.status = 'scheduled'
            AND c.scheduled_at > NOW()
            AND c.id <> $2
         ON CONFLICT (consult_id, scheduled_at) DO NOTHING
         RETURNING id`,
        [bookerEmail, consultId]
      );
      if (marked.rowCount > 0) {
        console.log(`[consultCall] unresolved reschedule stopped ${marked.rowCount} sibling chain(s)`);
      }
      // This is the ONLY path in the feature that turns a consult that would
      // have rung into one that silently will not, so more than one row gets a
      // human. One row is the ordinary case, the booker moving their single
      // upcoming slot, and stays a log line. Two or more means at least one
      // separate, legitimate booking was stopped too, and nothing else watches
      // that. Behavior is unchanged (spec 4.2 marks them all either way): only
      // the visibility is raised.
      //
      // ONE email, not one per row, and the bound matters: the Cal.com booking
      // page is PUBLIC and these rows are inserted outside the daily cap, so a
      // per-row loop would be a Resend-quota amplifier reachable from the open
      // internet. The banner names the booker's whole set rather than a count,
      // and the log line above carries the count.
      if (marked.rowCount > 1) {
        await sendChainEmail({
          attemptId: Number(marked.rows[0].id),
          reason: 'unresolved reschedule',
        });
      }
    }

    // Dial-target validation (toll-fraud guard): the client leg only ever dials
    // toUsE164 output, checked here so a bad payload never opens a chain.
    const target = toUsE164(bookerPhone);
    if (!target) {
      await fileUndialable({ consultId, bookerPhone });
      return;
    }

    // Ruling R16: slot-scoped and status-wide. The booker re-took this exact
    // slot, so any skip row standing against it is stale and must not block the
    // sweep. Rows at the OLD slot carry a different scheduled_at and survive.
    // Runs AFTER the phone check on purpose: clearing first would delete the
    // standing skipped_invalid_phone row and let the re-filed one win the
    // min-id bound, re-emailing on every reschedule of a still-bad number.
    if (triggerEvent === 'BOOKING_RESCHEDULED') {
      const cleared = await _deps.pool.query(
        `DELETE FROM consult_call_attempts a
          USING consults c
          WHERE a.consult_id = $1
            AND c.id = $1
            AND a.scheduled_at = c.scheduled_at
            AND a.status LIKE 'skipped%'`,
        [consultId]
      );
      if (cleared.rowCount > 0) {
        console.log(`[consultCall] reschedule cleared ${cleared.rowCount} stale skip row(s) for consult ${consultId}`);
      }
    }
  } catch (err) {
    captureError(err, 'tail');
  }
}


// ─── the FIRE side ───────────────────────────────────────────────

/**
 * The facts every fire-side step needs, with BOTH too-late bounds evaluated
 * against the DATABASE clock, next to NOW(). The slot itself never enters
 * JavaScript arithmetic: every comparison against it happens in SQL, which is
 * what the rest of the feature does and what ruling R12 is about.
 */
async function loadChainRow(attemptId) {
  const r = await _deps.pool.query(
    `SELECT admin_ring,
            NOW() > scheduled_at + make_interval(secs => $2) AS too_late_admin,
            NOW() > scheduled_at + make_interval(secs => $3) AS too_late_va
       FROM consult_call_attempts
      WHERE id = $1`,
    [attemptId, TOO_LATE_ADMIN_SEC, TOO_LATE_VA_SEC]
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}

/**
 * Is this chain still ringing for a real, unmoved slot? Both halves are decided
 * IN SQL (ruling R12): node-pg truncates a TIMESTAMPTZ to milliseconds on the
 * way into JavaScript, and two JS Date objects compared with === or !== answer
 * by object identity, which is always false and would skip every chain as
 * cancelled on its first tick.
 *
 * The detail is the consult's ACTUAL status (ruling R17), never a hardcoded
 * 'cancelled'. A consult flips to 'completed' when Dallas saves the drink plan,
 * which is the normal END of a successful call, and filing that as a cancel
 * sends a future reader chasing a cancellation that never happened.
 *
 * @param {number|string} attemptId consult_call_attempts.id
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
async function guardStillScheduled(attemptId) {
  const r = await _deps.pool.query(
    `SELECT c.status AS consult_status, (a.scheduled_at = c.scheduled_at) AS slot_unmoved
       FROM consult_call_attempts a
       JOIN consults c ON c.id = a.consult_id
      WHERE a.id = $1`,
    [attemptId]
  );
  if (r.rowCount === 0) return { ok: false, detail: 'missing' };
  const row = r.rows[0];
  if (row.consult_status !== 'scheduled') return { ok: false, detail: String(row.consult_status) };
  if (!row.slot_unmoved) return { ok: false, detail: 'rescheduled' };
  return { ok: true };
}

/**
 * The one guarded state transition. True only for the claim WINNER, which is
 * the only caller allowed to fire a billed or notifying side effect.
 *
 * Ruling R4: no caller ever hands this a raw SQL fragment. Each optional SET is
 * a typed option turned into its own bound parameter here, so nothing
 * caller-shaped reaches the statement and the numbering cannot collide.
 *
 * @param {number|string} attemptId
 * @param {string} fromStatus the status the caller believes the row holds
 * @param {string} toStatus
 * @param {Object} [opts]
 * @param {number} [opts.ring] admin ring the caller believes is current. The
 *   row re-enters calling_admin up to three times, so status alone cannot tell
 *   ring 1's callback from ring 2's; every admin-leg claim carries this.
 * @param {string|null} [opts.detail] diagnostic detail column
 * @param {number} [opts.nextRingOffsetSec] re-arm at scheduled_at + this many
 *   seconds, computed in SQL from the stored slot (R12)
 * @param {boolean} [opts.clearNextRing] set next_ring_at = NULL
 * @returns {Promise<boolean>}
 */
async function claim(attemptId, fromStatus, toStatus, opts = {}) {
  const {
    ring, detail, nextRingOffsetSec, clearNextRing,
  } = opts;
  const params = [attemptId, fromStatus, toStatus];
  const sets = ['status = $3', 'updated_at = NOW()'];
  if (detail !== undefined) {
    params.push(detail);
    sets.push(`detail = $${params.length}`);
  }
  if (nextRingOffsetSec !== undefined && nextRingOffsetSec !== null) {
    params.push(nextRingOffsetSec);
    sets.push(`next_ring_at = scheduled_at + make_interval(secs => $${params.length}::int)`);
  } else if (clearNextRing) {
    sets.push('next_ring_at = NULL');
  }
  let where = 'id = $1 AND status = $2';
  if (ring !== undefined && ring !== null) {
    params.push(ring);
    where += ` AND admin_ring = $${params.length}::smallint`;
  }
  const r = await _deps.pool.query(
    `UPDATE consult_call_attempts SET ${sets.join(', ')} WHERE ${where}`,
    params
  );
  return r.rowCount === 1;
}

/**
 * Per-leg Twilio status: the call log's telemetry column, ring-guarded on the
 * admin leg for the same reason every admin claim is (R5).
 */
async function writeLegStatus(attemptId, leg, callStatus, ring) {
  const clean = String(callStatus === null || callStatus === undefined ? '' : callStatus).trim().slice(0, 40);
  // Nothing to record. Writing NULL here would ERASE the status a real earlier
  // callback recorded, so an absent status is a no-op, not an overwrite.
  if (!clean) return;
  const col = leg === 'admin' ? 'admin_call_status' : 'va_call_status';
  const params = [attemptId, clean];
  let where = 'id = $1';
  if (leg === 'admin') {
    params.push(ring);
    where += ` AND admin_ring = $${params.length}::smallint`;
  }
  await _deps.pool.query(
    `UPDATE consult_call_attempts SET ${col} = $2, updated_at = NOW() WHERE ${where}`,
    params
  );
}

/**
 * Place one agent leg and record its SID. True when the call was placed AND its
 * SID persisted; false on a calls.create throw, which the caller answers with
 * that leg's terminal handling so the chain moves on instead of retrying.
 *
 * Both writes carry the ring guard on the admin leg, for the reason the claims
 * do: a write from a superseded ring would corrupt the "latest admin ring"
 * meaning admin_call_status carries. A SID that cannot be persisted, whether
 * the write failed or the row has already moved to another ring, gets the
 * best-effort cancel, so nobody answers into a bridge nothing can find.
 *
 * @param {Object} args
 * @param {number|string} args.attemptId
 * @param {'admin'|'va'} args.leg
 * @param {number} args.ring admin ring 1-3, or 0 on the Zul leg
 * @param {string} args.to ADMIN_PHONE or VA_CELL, dialed VERBATIM (dial-target law)
 * @returns {Promise<boolean>}
 */
async function placeLeg({ attemptId, leg, ring, to }) {
  const isAdmin = leg === 'admin';
  const sidCol = isAdmin ? 'admin_call_sid' : 'va_call_sid';
  const statusCol = isAdmin ? 'admin_call_status' : 'va_call_status';
  // The ring is the third bound parameter in BOTH statements below, so one
  // guard string serves them both.
  const ringGuard = isAdmin ? ' AND admin_ring = $3::smallint' : '';
  const ringParam = isAdmin ? [ring] : [];
  try {
    const call = await _deps.placeBridgedCall({
      to,
      callerId: process.env.TWILIO_PHONE_NUMBER,
      url: `${API_URL}/api/voice/consult/answer?attempt=${attemptId}&leg=${leg}&ring=${ring}&play=1`,
      statusCallback: `${API_URL}/api/voice/consult/status?attempt=${attemptId}&leg=${leg}&ring=${ring}`,
      timeLimit: timeLimitSec(),
      // 20 seconds on the admin leg, not 25: ADMIN_PHONE is a Google Voice
      // number whose voicemail answers at about 25 seconds, and a ring that
      // loses that race is "answered" by voicemail, which bills the leg and
      // speaks the booker's name and event details into a transcript. Zul's
      // cell has no such hop.
      timeout: isAdmin ? ADMIN_RING_SECONDS : VA_RING_SECONDS,
    });
    try {
      const persisted = await _deps.pool.query(
        `UPDATE consult_call_attempts SET ${sidCol} = $2, updated_at = NOW()
          WHERE id = $1${ringGuard}`,
        [attemptId, call.sid, ...ringParam]
      );
      if (persisted.rowCount !== 1) throw new Error('sid_unpersistable');
    } catch (sidErr) {
      await _deps.cancelBridgedCall({ callSid: call.sid }).catch(() => {});
      throw sidErr;
    }
    console.log(`[consultCall] ${leg} leg placed for attempt ${attemptId} ring ${ring} → ...${last4(to)}`);
    return true;
  } catch (err) {
    await _deps.pool.query(
      `UPDATE consult_call_attempts
          SET ${statusCol} = 'create_failed', detail = $2, updated_at = NOW()
        WHERE id = $1${ringGuard}`,
      [attemptId, String((err && (err.code || err.message)) || 'create_failed').slice(0, 200), ...ringParam]
    ).catch(() => {});
    captureError(err, `${leg}-leg-create`);
    return false;
  }
}

/**
 * The one text to Dallas: from TWILIO_PHONE_NUMBER to VM_TEXT_DESTINATION (the
 * 312) falling back to ADMIN_PHONE. An internal ops alert, so skipLog keeps it
 * out of the client message ledger exactly as the primary-line voicemail alert
 * does. Caller must be a claim winner (text-exactly-once law).
 *
 * The number is formatted from toUsE164 output, never the raw column. Never
 * throws. Anything other than 'sent' means NO text went out, and the missed
 * transition answers that with the one email, so a fully missed consult is
 * never invisible.
 *
 * The return is DISCRIMINATED, house pattern (openChain, fileUndialable), and
 * not a boolean, because the three failures are three different things to tell
 * the operator. sendSMS THROWS when Twilio is down, and reporting that as "no
 * text destination is configured" sent Dallas to his Render environment
 * variables for an outage he could do nothing about from there. Note every
 * value is a TRUTHY string: a caller must compare against 'sent', never test
 * this return for truthiness.
 *
 * @param {Object} opts
 * @param {number|string} opts.attemptId
 * @param {'missed'|'client_no_answer'} opts.kind
 * @returns {Promise<'sent'|'no_destination'|'no_attempt'|'send_failed'>}
 */
async function sendMissedText(opts) {
  try {
    // Destructured inside the try: this entry point may not throw either.
    const { attemptId, kind } = opts || {};
    const to = String(process.env.VM_TEXT_DESTINATION || process.env.ADMIN_PHONE || '').trim();
    if (!STRICT_E164.test(to)) {
      console.error('[consultCall] no valid text destination (VM_TEXT_DESTINATION / ADMIN_PHONE)');
      return 'no_destination';
    }
    const r = await _deps.pool.query(
      `SELECT c.booker_name, c.booker_phone, a.scheduled_at
         FROM consult_call_attempts a
         JOIN consults c ON c.id = a.consult_id
        WHERE a.id = $1`,
      [attemptId]
    );
    if (r.rowCount === 0) return 'no_attempt';
    const row = r.rows[0];
    const name = String(row.booker_name || '').trim() || 'the client';
    const when = clockTimeWithMinutes(row.scheduled_at);
    // A chain only ever opens for a dialable number, so a null here is the
    // degenerate case of a number edited out mid-chain: say what is known
    // rather than printing a number nobody can call.
    const dialable = toUsE164(row.booker_phone);
    const tail = dialable ? ` Their number is ${formatUsPhoneForText(dialable)}.` : '';
    const body = kind === 'client_no_answer'
      ? `Consult client did not answer: ${name} at ${when}.${tail}`
      : `Missed consult call with ${name} at ${when}.${tail}`;
    await _deps.sendSMS({ to, body, meta: { skipLog: true, messageType: 'consult_call_alert' } });
    console.log(`[consultCall] ${kind} text sent for attempt ${attemptId} → ...${last4(to)}`);
    return 'sent';
  } catch (err) {
    captureError(err, 'missed-text');
    return 'send_failed';
  }
}

// Which banner reason each un-sent text earns. A Map, not an object literal,
// matching CONSULT_CALL_BANNERS in emailTemplates.js: a lookup key can never
// reach a prototype member and come back a function. 'no_attempt' means the
// attempt row itself is gone, in which case sendChainEmail reads the same join
// and mails nothing at all; it is mapped anyway so the two can never disagree
// if one of those queries is ever changed.
const MISSED_TEXT_EMAIL_REASON = new Map([
  ['no_destination', 'missed, no text destination'],
  ['send_failed', 'missed, text failed'],
  ['no_attempt', 'missed, text failed'],
]);

/**
 * Terminate a chain that rang somebody and connected nobody. The claim winner
 * texts; a text that could not go out becomes the one email instead (spec 5.2),
 * so a fully missed consult is never invisible.
 *
 * The reason follows the ACTUAL failure. A Twilio outage and an unset
 * VM_TEXT_DESTINATION are different problems with different fixes, and this
 * feature exists to say which one happened.
 */
async function finishMissed(attemptId, fromStatus, ring) {
  if (!(await claim(attemptId, fromStatus, 'missed', { ring, clearNextRing: true }))) return;
  const outcome = await sendMissedText({ attemptId, kind: 'missed' });
  if (outcome === 'sent') return;
  await sendChainEmail({
    attemptId,
    reason: MISSED_TEXT_EMAIL_REASON.get(outcome) || 'missed, text failed',
  });
}

/**
 * The sweep's fire step: re-check, then claim and dial the next leg.
 *
 * Ruling R1: takes { attemptId } only. onLegTerminal owns every non-initial
 * transition, so there is no leg to pass in.
 *
 * @param {Object} opts
 * @param {number|string} opts.attemptId consult_call_attempts.id
 */
async function advanceChain(opts) {
  const { attemptId } = opts || {};
  const row = await loadChainRow(attemptId);
  if (!row) return;

  if (!isEnabled()) {
    await claim(attemptId, 'pending', 'skipped_disabled', { clearNextRing: true });
    return;
  }
  const guard = await guardStillScheduled(attemptId);
  if (!guard.ok) {
    await claim(attemptId, 'pending', 'skipped_cancelled', { detail: guard.detail, clearNextRing: true });
    return;
  }
  if (row.too_late_admin) {
    // Ringing this late is worse than not ringing: the booker has given up and
    // a call out of nowhere reads as chaos. Terminate and tell Dallas.
    if (await claim(attemptId, 'pending', 'failed', { detail: 'too_late', clearNextRing: true })) {
      await sendChainEmail({ attemptId, reason: 'too late' });
    }
    return;
  }
  const adminPhone = process.env.ADMIN_PHONE || '';
  const vaCell = process.env.VA_CELL || '';
  if (!adminPhone && !vaCell) {
    await claim(attemptId, 'pending', 'skipped_unconfigured', { clearNextRing: true });
    return;
  }

  if (adminPhone) {
    // Its own statement rather than claim(): this is the one transition that
    // must READ BACK the ring it just took, and admin_ring < MAX_ADMIN_RINGS is
    // what stops a re-armed row from ringing a fourth time.
    const won = await _deps.pool.query(
      `UPDATE consult_call_attempts
          SET status = 'calling_admin', admin_ring = admin_ring + 1,
              next_ring_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'pending' AND admin_ring < $2
        RETURNING admin_ring`,
      [attemptId, MAX_ADMIN_RINGS]
    );
    if (won.rowCount !== 1) return;
    const ring = Number(won.rows[0].admin_ring);
    if (!(await placeLeg({ attemptId, leg: 'admin', ring, to: adminPhone }))) {
      await onLegTerminal({ attemptId, leg: 'admin', ring, callStatus: 'create_failed' });
    }
    return;
  }

  // ADMIN_PHONE unset: Zul takes the call, with the briefing that never says
  // Dallas missed it (he was never rung).
  if (!(await claim(attemptId, 'pending', 'calling_va', { clearNextRing: true }))) return;
  if (!(await placeLeg({ attemptId, leg: 'va', ring: 0, to: vaCell }))) {
    await onLegTerminal({ attemptId, leg: 'va', ring: 0, callStatus: 'create_failed' });
  }
}

/**
 * One leg reached a terminal Twilio status, or never got placed at all. Called
 * from /api/voice/consult/status and from placeLeg's create failure.
 *
 * RULING R5, which an entire design review existed to catch. The row re-enters
 * calling_admin up to THREE times, so a status guard alone cannot tell ring 1's
 * callback from ring 2's, and Twilio delivers status callbacks at least once
 * and can deliver them late. Concretely: ring 1 goes no-answer, the row returns
 * to pending, the sweep places ring 2, and THEN a redelivered ring 1 callback
 * arrives while ring 2 is still ringing Dallas's phone. With only a status
 * guard it would match, flip the row to pending with ring 3 timing, and Dallas
 * would answer a live ring 2 and hear the apology. So a callback whose ring
 * does not match the row's CURRENT admin_ring returns before writing ANY
 * column, telemetry included: writing admin_call_status from a superseded ring
 * would corrupt the "latest admin ring" meaning the schema comment promises.
 *
 * @param {Object} opts
 * @param {number|string} opts.attemptId
 * @param {'admin'|'va'} opts.leg
 * @param {number} opts.ring the ring the callback's own URL carried
 * @param {string} opts.callStatus terminal Twilio status, or 'create_failed'
 */
async function onLegTerminal(opts) {
  const { attemptId, leg, ring, callStatus } = opts || {};
  if (leg !== 'admin' && leg !== 'va') return;
  // R25, before ANY read or write: a status that is not terminal is not this
  // function's business, and treating one as terminal re-arms a live chain.
  const status = String(callStatus === null || callStatus === undefined ? '' : callStatus).trim();
  if (!TERMINAL_CALL_STATUSES.has(status)) {
    console.log(`[consultCall] non-terminal status '${status}' for attempt ${attemptId} leg ${leg}, ignored`);
    return;
  }
  const row = await loadChainRow(attemptId);
  if (!row) return;

  if (leg === 'admin') {
    const fromRing = Number(ring);
    if (!Number.isInteger(fromRing) || fromRing < 1 || fromRing > MAX_ADMIN_RINGS) return;
    if (Number(row.admin_ring) !== fromRing) {
      console.log(`[consultCall] stale ring ${fromRing} callback for attempt ${attemptId} (row is at ring ${row.admin_ring}), ignored`);
      return;
    }
    await writeLegStatus(attemptId, leg, callStatus, fromRing);

    if (fromRing < MAX_ADMIN_RINGS) {
      // Re-arm for the next ring. A late callback simply writes a next_ring_at
      // already in the past, and the sweep fires it on its very next tick.
      await claim(attemptId, 'calling_admin', 'pending', {
        ring: fromRing, nextRingOffsetSec: RING_OFFSETS_SEC[fromRing + 1],
      });
      return;
    }

    // Ring 3, the hop to Zul. Every re-check below lives here as well as in the
    // sweep's fire step, because this hop bills an international leg.
    if (!isEnabled()) {
      await claim(attemptId, 'calling_admin', 'skipped_disabled', { ring: fromRing, clearNextRing: true });
      return;
    }
    const guard = await guardStillScheduled(attemptId);
    if (!guard.ok) {
      await claim(attemptId, 'calling_admin', 'skipped_cancelled', {
        ring: fromRing, detail: guard.detail, clearNextRing: true,
      });
      return;
    }
    if (row.too_late_va) {
      if (await claim(attemptId, 'calling_admin', 'failed', {
        ring: fromRing, detail: 'too_late', clearNextRing: true,
      })) {
        await sendChainEmail({ attemptId, reason: 'too late' });
      }
      return;
    }
    const vaCell = process.env.VA_CELL || '';
    if (vaCell) {
      if (!(await claim(attemptId, 'calling_admin', 'calling_va', { ring: fromRing, clearNextRing: true }))) return;
      if (!(await placeLeg({ attemptId, leg: 'va', ring: 0, to: vaCell }))) {
        await onLegTerminal({ attemptId, leg: 'va', ring: 0, callStatus: 'create_failed' });
      }
      return;
    }
    if (callStatus === 'create_failed') {
      // No Zul leg configured and his phone never actually rang, so there is
      // nothing to call missed: this is a system fault and it emails. No detail
      // is set, matching the Zul leg below: placeLeg's catch already wrote the
      // Twilio error code there, and admin_call_status already says
      // create_failed, so overwriting would trade the one code an operator can
      // look up for a word the row already carries.
      if (await claim(attemptId, 'calling_admin', 'failed', {
        ring: fromRing, clearNextRing: true,
      })) {
        await sendChainEmail({ attemptId, reason: 'call failed' });
      }
      return;
    }
    await finishMissed(attemptId, 'calling_admin', fromRing);
    return;
  }

  // The Zul leg, which is always the last one.
  await writeLegStatus(attemptId, leg, callStatus, null);
  if (callStatus === 'create_failed') {
    // Checked before the kill switch on purpose: a chain that could not dial is
    // a system fault whether or not somebody turned the bridge off afterwards.
    // No detail is set here, deliberately: placeLeg's catch already wrote the
    // Twilio error code there, and va_call_status already says create_failed,
    // so overwriting would trade a specific code for a word we already have.
    if (await claim(attemptId, 'calling_va', 'failed', { clearNextRing: true })) {
      await sendChainEmail({ attemptId, reason: 'call failed' });
    }
    return;
  }
  if (!isEnabled()) {
    // A deliberate stop is never reported as a missed consult.
    await claim(attemptId, 'calling_va', 'skipped_disabled', { clearNextRing: true });
    return;
  }
  await finishMissed(attemptId, 'calling_va', undefined);
}

module.exports = {
  consultCallTail,
  openChain,
  fileUndialable,
  fileMissedWindow,
  sendChainEmail,
  advanceChain,
  onLegTerminal,
  guardStillScheduled,
  sendMissedText,
  dailyCap,
  isEnabled,
  __setDeps,
  RING_OFFSETS_SEC,
  MAX_ADMIN_RINGS,
  ADMIN_RING_SECONDS,
  VA_RING_SECONDS,
  OPEN_AHEAD_MINUTES,
  OPEN_BEHIND_MINUTES,
  MISSED_WINDOW_MINUTES,
  TOO_LATE_ADMIN_SEC,
  TOO_LATE_VA_SEC,
  STALE_MINUTES,
};
