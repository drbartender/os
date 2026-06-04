/**
 * Web Push sender for the staff portal (spec §6.17).
 *
 * Phase B (Task 55): real web-push delivery. The dispatcher
 * (scheduledMessageDispatcher.dispatchPushRow) calls sendPush() once per stored
 * subscription and branches on the structured result:
 *   { ok: true }              -> sent
 *   { ok: false, gone: true } -> 410/404, the dispatcher prunes the subscription
 *   { ok: false, error }      -> transient/other failure, the subscription is kept
 *
 * Boot-safe + fail-closed: VAPID is configured at module load ONLY when both
 * keys are present, inside a try/catch, so a missing OR malformed key can never
 * crash the server boot (the dispatcher requires this module at startup). When
 * VAPID isn't usable, sendPush returns { ok: false, error: 'vapid_unset' } and
 * nothing is sent — SMS + email still cover every notification. This mirrors the
 * stripeClient.js fail-closed pattern from CLAUDE.md.
 */
const webpush = require('web-push');

// Configure VAPID once, at load, only when both keys exist. Wrapped so a missing
// or malformed key degrades to "push disabled" instead of crashing the boot.
// Logged once here rather than per-send.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      `mailto:${process.env.VAPID_CONTACT_EMAIL || 'contact@drbartender.com'}`,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
  } catch (err) {
    // Malformed keys: stay fail-closed, do not throw out of module load.
    console.error('[pushSender] VAPID setup failed; push disabled:', err.message);
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
  // Fail closed when VAPID isn't set (local dev; prod before the keys land).
  // Checked at call time so the dispatcher loop can never crash on a push row.
  if (!process.env.VAPID_PRIVATE_KEY) {
    return { ok: false, error: 'vapid_unset' };
  }
  try {
    const payload = JSON.stringify({ title, body, url, tag, icon });
    await webpush.sendNotification(subscription, payload);
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
