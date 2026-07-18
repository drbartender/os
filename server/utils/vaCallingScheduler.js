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
const { pool } = require('../db');

let deps = {
  getTelegramWebhookInfo: (...a) => telegram.getTelegramWebhookInfo(...a),
  setTelegramWebhook: (...a) => telegram.setTelegramWebhook(...a),
  pruneVaCallingRows: (...a) => pendingCall.pruneVaCallingRows(...a),
  notifyAdminCategory: (...a) => adminNotifications.notifyAdminCategory(...a),
  sendLeadCallChainEmail: (...a) => leadCallTrigger.sendChainEmail(...a),
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

module.exports = { pruneVaCallingRows, reapStaleLeadCallAttempts, checkTelegramWebhookHealth, __setDeps };
