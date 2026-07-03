// Quota-exhaustion handling for the scheduled-message dispatcher.
//
// When an email send hits the provider's daily quota / rate limit, the send
// throws QuotaExceededError (see utils/email.js). The dispatcher catches it and
// calls deferRowForQuota() so the row is RETRIED after the quota resets instead
// of being marked terminally 'failed' (which would silently drop the
// notification — the drain loop only re-selects 'pending'/'deferred' rows).
//
// This mirrors the existing per-channel-cooldown 'deferred' mechanism in
// scheduledMessageDispatcher.js: set status='deferred' and push scheduled_for
// into the future; the dispatcher's deferred-reactivation pass flips the row
// back to 'pending' once it is due again.
//
// Kept in its own module so the dispatcher core stays under the file-size cap.

const { pool } = require('../db');
const Sentry = require('@sentry/node');

// Daily quotas reset on a 24h cycle, so a full day (see the static INTERVAL in
// deferRowForQuota) is the safe, conservative retry horizon: it clears any daily
// cap regardless of the provider's exact reset boundary. If the cap is still
// exhausted when the row comes due again, the same path simply defers it once more.

// Throttle the Sentry alert: a capped window can touch many rows in one tick,
// and one alert per window is enough. (Module-level — resets on process
// restart, which is fine: a fresh capped window deserves a fresh alert.)
const QUOTA_ALERT_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes
let _lastQuotaAlertAt = 0;

/**
 * Defer a scheduled_messages row for retry after the email quota resets, rather
 * than failing it. The deferred-reactivation pass re-queues it when due.
 */
async function deferRowForQuota(rowId) {
  await pool.query(
    `UPDATE scheduled_messages
        SET status = 'deferred',
            scheduled_for = NOW() + INTERVAL '24 hours',
            error_message = 'deferred: email sending quota reached, retry after reset'
      WHERE id = $1`,
    [rowId]
  );
}

/**
 * Emit at most one Sentry warning per throttle window when the email quota is
 * exhausted, so a capped tick does not fire dozens of duplicate events. Returns
 * true if an alert was emitted this call.
 */
function maybeAlertQuotaOnce(context = {}) {
  const now = Date.now();
  if (now - _lastQuotaAlertAt < QUOTA_ALERT_THROTTLE_MS) return false;
  _lastQuotaAlertAt = now;
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('email sending quota exhausted, scheduled messages deferred for retry', {
      level: 'warning',
      tags: { dispatcher: 'scheduled_messages', issue: 'email_quota' },
      extra: context,
    });
  }
  console.warn('[emailQuotaDefer] email quota exhausted, deferring scheduled messages for retry after reset');
  return true;
}

// Test seam: reset the throttle so suites do not interfere with each other.
function _resetQuotaAlertThrottleForTest() {
  _lastQuotaAlertAt = 0;
}

module.exports = { deferRowForQuota, maybeAlertQuotaOnce, _resetQuotaAlertThrottleForTest };
