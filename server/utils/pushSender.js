/**
 * Web Push sender for the staff portal (spec §6.17).
 *
 * Phase A stub: returns ok:false without sending. Phase 11 Task 55 replaces the
 * body with real `web-push` calls. Returning a structured result here lets the
 * dispatcher (Phase 2 Task 7) treat push rows uniformly across the stub and the
 * Phase B activation, so call sites stay stable.
 *
 * Fail-closed on missing VAPID keys: returns { ok: false, error: 'vapid_unset' }
 * with a Sentry breadcrumb so callers (the dispatcher) don't crash the loop.
 * Matches the `stripeClient.js` fail-closed pattern from CLAUDE.md.
 *
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
  if (!process.env.VAPID_PRIVATE_KEY) {
    return { ok: false, error: 'vapid_unset' };
  }
  // Phase B (Task 55) replaces this with:
  //   const webpush = require('web-push');
  //   webpush.setVapidDetails(...);
  //   await webpush.sendNotification(subscription, JSON.stringify({ title, body, url, tag, icon }));
  //   return { ok: true };
  // with try/catch mapping 410/404 -> { ok: false, gone: true }.
  return { ok: false, error: 'push_phase_b' };
}

module.exports = { sendPush };
