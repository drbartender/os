// server/utils/vaCallingScheduler.js
//
// Maintenance for the Zul VA calling feature (spec §Components-7 + §Security-9).
//
//   pruneVaCallingRows()        Delegates to pendingCall's purge (expired
//                               pending_call rows + aged-out call_audit /
//                               telegram_update rows). Re-exposed here so the
//                               index.js scheduler block registers ONE
//                               VA-calling maintenance module.
//
//   checkTelegramWebhookHealth()  The webhook heartbeat. Telegram silently
//                               disables a webhook after repeated errors / a
//                               stray getUpdates / a second setWebhook / a TLS
//                               lapse, which leaves OUTBOUND CALLING dead until
//                               someone notices. This calls getWebhookInfo; if
//                               the URL is unset OR last_error_date is within the
//                               last hour, it re-runs setWebhook and emails the
//                               admin.
//
// Deps are injected through one mutable `deps` object (mirrors the __setSmsDeps
// seam in server/utils/sms.js and __setDeps in server/utils/smsInbound.js:677)
// so checkTelegramWebhookHealth is unit-testable without the network or the DB.

const telegram = require('./telegram');
const pendingCall = require('./pendingCall');
const adminNotifications = require('./adminNotifications');
const leadCallTrigger = require('./leadCallTrigger');
const voicemail = require('./voicemail');
const { pool } = require('../db');

let deps = {
  getTelegramWebhookInfo: (...a) => telegram.getTelegramWebhookInfo(...a),
  setTelegramWebhook: (...a) => telegram.setTelegramWebhook(...a),
  pruneVaCallingRows: (...a) => pendingCall.pruneVaCallingRows(...a),
  notifyAdminCategory: (...a) => adminNotifications.notifyAdminCategory(...a),
  sendLeadCallChainEmail: (...a) => leadCallTrigger.sendChainEmail(...a),
  deliverVoicemail: (...a) => voicemail.deliverVoicemail(...a),
  sendTelegramMessage: (...a) => telegram.sendTelegramMessage(...a),
  notificationsEnabled: (...a) => require('./notificationsEnabled').notificationsEnabled(...a),
  pool,
};

function __setDeps(overrides) {
  deps = { ...deps, ...overrides };
}

// "recent" webhook error = within the last hour (spec §Security-9).
const WEBHOOK_ERROR_WINDOW_SEC = 3600;

// Local quote-escaping helper (external last_error_message flows into the admin
// email body). Mirrors the escapeHtml at server/utils/smsInbound.js:429; kept
// local so this task does not add an export to another task's file.
function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// getWebhookInfo returns the raw Bot API envelope { ok, result: {...} }; tolerate
// a helper that already unwrapped `.result`.
function extractResult(info) {
  if (info && typeof info === 'object' && info.result && typeof info.result === 'object') {
    return info.result;
  }
  return info && typeof info === 'object' ? info : {};
}

// A lead-call chain stranded mid-flight (crash between insert and placement,
// an undelivered Twilio status callback, a Twilio-side hang) would otherwise
// sit in pending/calling_* forever and the lead would be silently lost.
// 30 minutes is comfortably past both the 25s agent rings and the failover
// hop; a legitimately connected bridge is NEVER reaped ('connected' excluded,
// it runs to its own timeLimit). Guarded UPDATE: each reaped row surfaces
// through the standard failed-chain email + needs-attention path.
const LEAD_CALL_STALE_MINUTES = 30;

async function reapStaleLeadCallAttempts() {
  const reaped = await deps.pool.query(
    `UPDATE lead_call_attempts
     SET status = 'failed', detail = 'stale_reaped', updated_at = NOW()
     WHERE status IN ('pending', 'calling_admin', 'calling_va')
       AND created_at < NOW() - INTERVAL '${LEAD_CALL_STALE_MINUTES} minutes'
     RETURNING id`
  );
  for (const row of reaped.rows) {
    // Claim winner by construction (the UPDATE above is the claim).
    await deps.sendLeadCallChainEmail({ attemptId: Number(row.id), reason: 'call failed' });
  }
  return reaped.rowCount;
}

// Delegates to Task 5's pendingCall.pruneVaCallingRows(); re-exposed as the
// single VA-calling prune entry point for index.js. The lead-call stale reap
// rides the same hourly pass (spec 2026-07-18 section 4.5); its failure must
// not mask the prune (and vice versa), so it is guarded separately.
async function pruneVaCallingRows() {
  const n = await deps.pruneVaCallingRows();
  try {
    const reaped = await reapStaleLeadCallAttempts();
    if (reaped > 0) console.log(`[vaCallingScheduler] reaped ${reaped} stale lead-call attempt(s)`);
  } catch (err) {
    console.error('[vaCallingScheduler] lead-call stale reap failed:', err.message);
  }
  return n;
}

async function checkTelegramWebhookHealth() {
  // Let a getWebhookInfo network failure propagate: wrapScheduler records it as
  // 'failed' + Sentry (server/utils/schedulerHealth.js:54-77), which is the
  // correct signal — we cannot safely re-arm without knowing the current state.
  const info = await deps.getTelegramWebhookInfo();
  const result = extractResult(info);

  const url = result.url || '';
  const lastErrorDate = Number(result.last_error_date) || 0; // unix seconds
  const nowSec = Math.floor(Date.now() / 1000);
  const errorRecent =
    lastErrorDate > 0 && nowSec - lastErrorDate < WEBHOOK_ERROR_WINDOW_SEC;

  if (url && !errorRecent) {
    return { healthy: true, reset: false };
  }

  // Webhook missing or erroring — re-arm it and alert the admin. Outbound
  // calling would have been dead until this ran.
  const setResult = await deps.setTelegramWebhook();

  const reason = !url
    ? 'the Telegram webhook URL is not set'
    : `Telegram reported a webhook error at ${new Date(lastErrorDate * 1000).toISOString()}` +
      (result.last_error_message ? ` ("${result.last_error_message}")` : '');

  await deps.notifyAdminCategory({
    category: 'system_error',
    subject: 'Zul VA calling: Telegram webhook re-armed',
    emailHtml:
      '<p>The Zul VA calling Telegram webhook looked unhealthy, so it was ' +
      'automatically re-registered.</p>' +
      `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` +
      '<p>Outbound calling would have been dead until this ran. Verify Zul can ' +
      'trigger a call.</p>',
    emailText:
      'The Zul VA calling Telegram webhook looked unhealthy and was ' +
      'automatically re-registered.\n' +
      `Reason: ${reason}\n` +
      'Outbound calling would have been dead until this ran. Verify Zul can ' +
      'trigger a call.',
  });

  return { healthy: false, reset: true, setResult };
}

// A voicemail whose delivery was claimed but never finished (a crash or a Render
// redeploy between the claim and the upload) has nothing else to rescue it:
// Twilio does not redeliver a recording status callback it already answered with
// a 2xx. This sweep IS that retry. Bounded by attempts so a permanently broken
// row alerts once and then rests, and the recording is NEVER deleted undelivered.
// MIN_AGE must exceed the longest possible recording plus its processing, or the
// sweep picks up a row the recording webhook is still uploading and delivers it
// twice. vmMaxLengthSec() clamps to 300s, plus greeting and up to ~43s of fetch
// retries and upload, so 5 minutes was too short. The job only runs hourly, so
// a generous floor costs nothing.
const VM_SWEEP_MIN_AGE = '15 minutes';
// Generous on purpose. A row that ages out of this window stops being swept
// SILENTLY: the only give-up alert fires off the attempts ceiling, which an
// aged-out row never reaches. Two days did not cover a bootstrap window or a
// weekend outage, both of which the rollout procedure walks through. The
// attempts ceiling still bounds total work, so a longer window costs nothing.
const VM_SWEEP_MAX_AGE = '14 days';
const VM_MAX_ATTEMPTS = 3;
const VM_SWEEP_BATCH = 10;

async function reapUndeliveredVoicemails() {
  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  // Nothing to do if we cannot send: sweeping while gated off would burn each
  // row's retry budget on sends that never leave the box, and the give-up alert
  // would be swallowed by the same gate. Returning early keeps every row
  // retryable for when notifications come back on.
  if (!allowed || !deps.notificationsEnabled()) return 0;

  const { rows } = await deps.pool.query(
    `SELECT call_sid, from_e164, recording_sid, duration_sec, attempts
       FROM voicemail_delivery
      WHERE status IN ('recorded', 'failed')
        AND recording_sid IS NOT NULL
        AND (duration_sec IS NULL OR duration_sec >= 2)
        AND created_at < NOW() - $1::interval
        AND created_at > NOW() - $2::interval
        AND attempts <= $3
      ORDER BY created_at
      LIMIT $4`,
    [VM_SWEEP_MIN_AGE, VM_SWEEP_MAX_AGE, VM_MAX_ATTEMPTS, VM_SWEEP_BATCH]
  );
  if (rows.length === 0) return 0;

  let recovered = 0;
  for (const row of rows) {
    const tail = `sid=...${String(row.call_sid).slice(-4)}`;
    const who = row.from_e164 || 'a withheld number';

    // Optimistic compare-and-swap on the attempts value this pass just READ.
    // `attempts <= CEILING` would be a bound, not a claim: under READ COMMITTED
    // a blocked second updater re-evaluates the predicate against the
    // post-update row, and 2 is still <= 3, so BOTH passes would win and both
    // would deliver the same recording. Pinning the exact value means the
    // loser's predicate no longer matches and it returns zero rows. That
    // matters because a double delivery is not just duplicate audio: if pass A
    // delivers and deletes the recording, pass B's fetch 404s and writes
    // 'failed' over a delivered row, and Zul is eventually told to pull a
    // voicemail by hand that she already has.
    const claim = await deps.pool.query(
      `UPDATE voicemail_delivery
          SET attempts = attempts + 1
        WHERE call_sid = $1
          AND status IN ('recorded', 'failed')
          AND attempts = $2
          AND delivered_at IS NULL
        RETURNING attempts`,
      [row.call_sid, row.attempts]
    );
    if (claim.rows.length === 0) continue; // another pass owns this row
    const attempts = claim.rows[0].attempts;

    let outcome = 'failed';
    try {
      outcome = await deps.deliverVoicemail({
        callSid: row.call_sid,
        recordingSid: row.recording_sid,
        durationSec: row.duration_sec,
        fromE164: row.from_e164,
        chatId: allowed,
        redelivered: true,
      });
    } catch (err) {
      console.error(`[vm-sweep] retry threw ${tail}: ${err.message}`);
    }

    if (outcome === 'delivered') {
      recovered += 1;
      console.log(`[vm-sweep] recovered ${tail}`);
      continue;
    }
    // 'skipped' cannot happen here (we returned early when gated off), but if it
    // ever does it must NOT count as a failure: leave the row alone so it stays
    // retryable rather than marching it toward the give-up ceiling.
    if (outcome === 'skipped') continue;

    if (attempts > VM_MAX_ATTEMPTS) {
      await deps.sendTelegramMessage(
        allowed,
        `A voicemail from ${who} could not be delivered after several tries. It is still in the Twilio console and needs to be pulled by hand.`
      );
      console.warn(`[vm-sweep] giving up ${tail}`);
    }
  }
  return recovered;
}

module.exports = {
  pruneVaCallingRows,
  reapStaleLeadCallAttempts,
  reapUndeliveredVoicemails,
  checkTelegramWebhookHealth,
  __setDeps,
};
