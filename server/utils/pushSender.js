/**
 * Web Push sender for the staff portal (spec §6.17).
 *
 * Phase B (Task 55): real web-push delivery. The dispatcher
 * (pushDispatch.dispatchPushRow) calls sendPush() once per stored
 * subscription and branches on the structured result:
 *   { ok: true }              -> sent
 *   { ok: false, gone: true } -> 410/404, the dispatcher prunes the subscription
 *   { ok: false, error }      -> transient/other failure (a timeout included), the
 *                                subscription is kept
 *   { ok: false, error: 'notifications_off' } -> SEND_NOTIFICATIONS gate is off,
 *                                nothing was sent (notificationsEnabled.js)
 *
 * Boot-safe + fail-closed: VAPID is configured at module load ONLY when both
 * keys are present, inside a try/catch, so a missing OR malformed key can never
 * crash the server boot (the dispatcher requires this module at startup). When
 * VAPID isn't usable, sendPush returns { ok: false, error: 'vapid_unset' } and
 * nothing is sent — SMS + email still cover every notification. This mirrors the
 * stripeClient.js fail-closed pattern from CLAUDE.md.
 */
const webpush = require('web-push');
const { notificationsEnabled } = require('./notificationsEnabled');

// A push service that accepts the connection and then stalls must not hold a
// send (and the dispatcher loop behind it) open. web-push 3.6.7 reads this as a
// socket timeout in ms; the timeout rejects with a non-410 error, so it counts
// as failed and the subscription is kept.
const SEND_TIMEOUT_MS = 10000;

// Configure VAPID once, at load, only when both keys exist. Wrapped so a missing
// or malformed key degrades to "push disabled" instead of crashing the boot.
// Logged once here rather than per-send.
let vapidConfigured = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      `mailto:${process.env.VAPID_CONTACT_EMAIL || 'contact@drbartender.com'}`,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    vapidConfigured = true;
  } catch (err) {
    // Malformed keys: stay fail-closed, do not throw out of module load.
    console.error('[pushSender] VAPID setup failed; push disabled:', err.message);
  }
}

// The boot line email.js and sms.js print, for push. A malformed key already
// logged its own line above.
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.warn('[push] VAPID keys are NOT set; pushes will be skipped, not sent');
} else if (vapidConfigured && !notificationsEnabled()) {
  console.log('[push] web-push initialized, but notifications are gated OFF (set SEND_NOTIFICATIONS=true to send); pushes will be logged only');
} else if (vapidConfigured) {
  console.log('[push] web-push initialized');
}

// The host only, for the gated-off log line: the full endpoint identifies one
// device's subscription and never goes in a log.
function endpointHost(subscription) {
  try {
    return new URL(subscription && subscription.endpoint).host || 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

/**
 * @param {object} args
 * @param {object} args.subscription { endpoint, keys: { p256dh, auth } }
 * @param {string} args.title
 * @param {string} args.body
 * @param {string} args.url        deep link opened on tap
 * @param {string} [args.tag]      grouping tag (one per category)
 * @param {string} [args.icon]
 * @returns {Promise<{ok: boolean, gone?: boolean, error?: string}>}
 */
async function sendPush({ subscription, title, body, url, tag, icon }) {
  // The SEND_NOTIFICATIONS gate email and SMS already have: a local dev server
  // pointed at the shared DB never pushes to a real phone. Checked per call,
  // like sendEmail, so a test can flip it.
  if (!notificationsEnabled()) {
    console.log(`[DEV] Push skipped (notifications gated OFF) -> ${endpointHost(subscription)}`);
    return { ok: false, error: 'notifications_off' };
  }
  // Fail closed when VAPID isn't set (local dev; prod before the keys land).
  // Checked at call time so the dispatcher loop can never crash on a push row.
  if (!process.env.VAPID_PRIVATE_KEY) {
    return { ok: false, error: 'vapid_unset' };
  }
  try {
    const payload = JSON.stringify({ title, body, url, tag, icon });
    await webpush.sendNotification(subscription, payload, { timeout: SEND_TIMEOUT_MS });
    return { ok: true };
  } catch (err) {
    // 410 Gone / 404 Not Found => the subscription is dead; signal the
    // dispatcher to prune it. Everything else is transient: keep the sub.
    const code = err && err.statusCode;
    if (code === 410 || code === 404) {
      return { ok: false, gone: true };
    }
    return { ok: false, error: (err && err.message) || 'send_failed' };
  }
}

module.exports = { sendPush };
