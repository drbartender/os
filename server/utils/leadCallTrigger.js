/**
 * Lead call bridge: webhook-tail trigger + call-chain driver (spec 2026-07-18
 * section 4.2). On a new in-window Thumbtack lead, ring Dallas (ADMIN_PHONE)
 * with a spoken briefing; on his terminal status the /status webhook advances
 * to Zul (VA_CELL); press-1 bridges to the lead. This module owns:
 *
 *   - triggerLeadCall({ lead, leadId }): the post-commit tail entry. NEVER
 *     throws (the webhook's 200/503 semantics must not change), takes no
 *     caller's pooled client (bare pool.query only; pool-deadlock law).
 *   - advanceChain({ attemptId, fromLeg }): claim-then-call chain step,
 *     shared with the /api/voice/lead/status webhook (voiceLeadCall.js).
 *   - sendChainEmail({ attemptId, reason }): the one admin email per chain.
 *
 * Claim-then-call law (telegram.js Guard 5 precedent): every billed side
 * effect (calls.create, admin email) fires only when its guarded UPDATE won
 * (rowCount 1), so duplicate webhooks and Twilio's at-least-once status
 * callbacks can never double-dial or double-email.
 *
 * Toll-fraud posture: agent legs dial ONLY env-configured numbers; the lead
 * leg (dialed in voiceLeadCall.js) uses ONLY a toUsE164-validated target,
 * checked here at trigger time so a bad payload never even opens a chain.
 * The atomic rolling-24h cap bounds spend if the TT webhook secret leaks.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { placeBridgedCall, cancelBridgedCall } = require('./sms');
const { notifyAdminCategory } = require('./adminNotifications');
const { missedLeadCallAdmin } = require('./emailTemplates');
const { chicagoHourNow } = require('./businessTime');
const { toUsE164 } = require('./usPhone');
const { ADMIN_URL, API_URL } = require('./urls');

// Business-hours window (spec section 2, code constants by design): call only
// when 8 <= Chicago hour < 21. Judged at lead arrival; no morning re-fire.
const CALL_WINDOW_START_HOUR = 8;
const CALL_WINDOW_END_HOUR = 21;

// Agent-leg ring seconds: unanswered legs fail over in under 30s.
const AGENT_RING_SECONDS = 25;

// The || 25 fallback is load-bearing: an unset env var must not become
// `count < NaN` (always false), which would cap-trip every lead.
function dailyCap() { return parseInt(process.env.LEAD_CALL_DAILY_CAP, 10) || 25; }

// Same 1800s default as voice.js timeLimitSec (duplicated, not exported there).
function timeLimitSec() { return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800; }

// Dependency-injection seam for tests (mirrors sms.js __setSmsDeps).
let _deps = { pool, placeBridgedCall, cancelBridgedCall, notifyAdminCategory, chicagoHourNow };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

function last4(p) { return String(p || '').slice(-4); }

function captureError(err, step) {
  console.error(`[leadCall] ${step} failed:`, err.message);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureException(err, { tags: { component: 'lead-call', step } });
  }
}

/** Insert a terminal skip/failed row; at-most-once via the lead_id UNIQUE. */
async function insertRow(leadId, status, detail) {
  await _deps.pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, detail)
     VALUES ($1, $2, $3)
     ON CONFLICT (lead_id) DO NOTHING`,
    [leadId, status, detail]
  );
}

/** Guarded state transition. True only for the claim winner. */
async function claim(attemptId, fromStatus, toStatus) {
  const r = await _deps.pool.query(
    `UPDATE lead_call_attempts SET status = $3, updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [attemptId, fromStatus, toStatus]
  );
  return r.rowCount === 1;
}

/**
 * Place one agent leg. Returns true when the call was placed and its SID
 * persisted; false on a calls.create throw (recorded, caller falls through
 * to the next leg). A placed-but-unpersistable SID gets the best-effort
 * cancelBridgedCall so nobody answers into an untracked bridge.
 */
async function placeLeg({ attemptId, leg, to }) {
  const sidCol = leg === 'admin' ? 'admin_call_sid' : 'va_call_sid';
  const statusCol = leg === 'admin' ? 'admin_call_status' : 'va_call_status';
  try {
    const call = await _deps.placeBridgedCall({
      to,
      callerId: process.env.TWILIO_PHONE_NUMBER,
      url: `${API_URL}/api/voice/lead/answer?attempt=${attemptId}&leg=${leg}&play=1`,
      statusCallback: `${API_URL}/api/voice/lead/status?attempt=${attemptId}&leg=${leg}`,
      timeLimit: timeLimitSec(),
      timeout: AGENT_RING_SECONDS,
    });
    try {
      await _deps.pool.query(
        `UPDATE lead_call_attempts SET ${sidCol} = $2, updated_at = NOW() WHERE id = $1`,
        [attemptId, call.sid]
      );
    } catch (sidErr) {
      await _deps.cancelBridgedCall({ callSid: call.sid }).catch(() => {});
      throw sidErr;
    }
    console.log(`[leadCall] ${leg} leg placed for attempt ${attemptId} → ...${last4(to)}`);
    return true;
  } catch (err) {
    await _deps.pool.query(
      `UPDATE lead_call_attempts SET ${statusCol} = 'create_failed', detail = $2, updated_at = NOW() WHERE id = $1`,
      [attemptId, String(err.code || err.message || 'create_failed').slice(0, 200)]
    ).catch(() => {});
    captureError(err, `${leg}-leg-create`);
    return false;
  }
}

/**
 * Load the lead facts for the admin email and send it through the lead_call
 * category. Caller must be a claim winner (email-exactly-once law).
 */
async function sendChainEmail({ attemptId, reason }) {
  try {
    const r = await _deps.pool.query(
      `SELECT l.customer_name, l.category, l.event_date, l.guest_count,
              l.location_city, l.proposal_id, l.client_id
       FROM lead_call_attempts a
       JOIN thumbtack_leads l ON l.id = a.lead_id
       WHERE a.id = $1`,
      [attemptId]
    );
    const row = r.rows[0] || {};
    const tpl = missedLeadCallAdmin({
      customerName: row.customer_name,
      category: row.category,
      eventDate: row.event_date,
      guestCount: row.guest_count,
      locationCity: row.location_city,
      reason,
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
 * Advance the ring chain: claim the next configured leg and dial it; a
 * calls.create failure falls through to the leg after; an exhausted chain
 * terminates missed (somebody was rung but nobody connected) or failed
 * (the last configured leg could not even be placed), and the claim winner
 * sends the one email.
 *
 * @param {Object} opts
 * @param {number|string} opts.attemptId lead_call_attempts.id
 * @param {'admin'|'va'|null} opts.fromLeg leg whose terminal state we are
 *   advancing from; null = fresh chain start (row still 'pending')
 * @param {boolean} [opts.viaCreateFailure] internal: the previous leg never
 *   rang (create threw), so exhaustion is 'failed', not 'missed'
 */
async function advanceChain({ attemptId, fromLeg, viaCreateFailure = false }) {
  const adminPhone = process.env.ADMIN_PHONE || '';
  const vaCell = process.env.VA_CELL || '';
  const fromStatus = fromLeg === null ? 'pending' : fromLeg === 'admin' ? 'calling_admin' : 'calling_va';

  if (fromLeg === null && adminPhone) {
    if (!(await claim(attemptId, 'pending', 'calling_admin'))) return;
    if (!(await placeLeg({ attemptId, leg: 'admin', to: adminPhone }))) {
      await advanceChain({ attemptId, fromLeg: 'admin', viaCreateFailure: true });
    }
    return;
  }

  const vaEligible = fromLeg === 'admin' || (fromLeg === null && !adminPhone);
  if (vaEligible && vaCell) {
    if (!(await claim(attemptId, fromStatus, 'calling_va'))) return;
    if (!(await placeLeg({ attemptId, leg: 'va', to: vaCell }))) {
      await advanceChain({ attemptId, fromLeg: 'va', viaCreateFailure: true });
    }
    return;
  }

  // Chain exhausted (no next leg configured, or the VA leg itself failed to
  // place). Missed = a leg rang out; failed = the chain died placing calls.
  const finalStatus = viaCreateFailure ? 'failed' : 'missed';
  if (await claim(attemptId, fromStatus, finalStatus)) {
    await sendChainEmail({ attemptId, reason: viaCreateFailure ? 'call failed' : 'missed' });
  }
}

/**
 * Post-commit tail entry: open (or skip) the call chain for a just-captured
 * lead. At-most-once per lead across TT webhook retries and the heal path
 * (lead_id UNIQUE + ON CONFLICT DO NOTHING). Never throws.
 */
async function triggerLeadCall({ lead, leadId }) {
  try {
    if (process.env.LEAD_CALL_ENABLED === 'false') return;
    if (!leadId) return;

    const hour = _deps.chicagoHourNow();
    if (hour < CALL_WINDOW_START_HOUR || hour >= CALL_WINDOW_END_HOUR) {
      await insertRow(leadId, 'skipped_after_hours', null);
      return;
    }

    if (!process.env.ADMIN_PHONE && !process.env.VA_CELL) {
      await insertRow(leadId, 'skipped_unconfigured', null);
      return;
    }

    // Dial-target validation (IRSF guard): the lead leg only ever dials a
    // validated US number. toUsE164 blocks 900/976 and non-US NANP codes.
    const rawPhone = lead && lead.customerPhone;
    if (!rawPhone || !toUsE164(rawPhone)) {
      await insertRow(leadId, 'skipped_invalid_phone', rawPhone ? 'invalid_phone' : 'no_phone');
      return;
    }

    // Cap + idempotent open in one statement. Under READ COMMITTED a truly
    // concurrent burst can still overshoot by the number of in-flight
    // handlers (each statement snapshots before the others commit); this is
    // a fraud BACKSTOP that bounds sustained spend, not a hard cap. Every
    // dialed target is independently validated and timeLimit-capped.
    const ins = await _deps.pool.query(
      `INSERT INTO lead_call_attempts (lead_id, status)
       SELECT $1, 'pending'
       WHERE (SELECT COUNT(*) FROM lead_call_attempts
              WHERE created_at > NOW() - INTERVAL '24 hours'
                AND status NOT LIKE 'skipped%') < $2
       ON CONFLICT (lead_id) DO NOTHING
       RETURNING id`,
      [leadId, dailyCap()]
    );

    if (ins.rowCount === 0) {
      const existing = await _deps.pool.query(
        'SELECT id FROM lead_call_attempts WHERE lead_id = $1', [leadId]
      );
      if (existing.rowCount > 0) return; // duplicate webhook: chain already open

      // Cap trip: log the lead as failed so it still surfaces; email only on
      // the FIRST trip per rolling 24h (Resend quota protection).
      const capIns = await _deps.pool.query(
        `INSERT INTO lead_call_attempts (lead_id, status, detail)
         VALUES ($1, 'failed', 'cap_tripped')
         ON CONFLICT (lead_id) DO NOTHING
         RETURNING id`,
        [leadId]
      );
      if (capIns.rowCount === 1) {
        // One alert per rolling 24h, deterministically: the trip holding the
        // MINIMUM id in the window sends. (A count==1 check could send ZERO
        // emails under a concurrent double-trip: both commit, both count 2.)
        const min = await _deps.pool.query(
          `SELECT MIN(id)::bigint AS min_id FROM lead_call_attempts
           WHERE detail = 'cap_tripped' AND created_at > NOW() - INTERVAL '24 hours'`
        );
        if (Number(min.rows[0].min_id) === Number(capIns.rows[0].id)) {
          await sendChainEmail({ attemptId: Number(capIns.rows[0].id), reason: 'daily cap tripped' });
        }
      }
      return;
    }

    await advanceChain({ attemptId: ins.rows[0].id, fromLeg: null });
  } catch (err) {
    captureError(err, 'trigger');
  }
}

module.exports = {
  triggerLeadCall,
  advanceChain,
  sendChainEmail,
  __setDeps,
  CALL_WINDOW_START_HOUR,
  CALL_WINDOW_END_HOUR,
};
