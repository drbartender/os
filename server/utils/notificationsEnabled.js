/**
 * Gate for real outbound notifications (Resend email, Twilio SMS, Web Push).
 *
 * Mirrors the RUN_SCHEDULERS philosophy (see server/index.js): real sends fire
 * only in production by default, so a local dev server pointed at the shared
 * Neon DB never burns Resend/Twilio allotments by exercising send paths.
 *
 *   SEND_NOTIFICATIONS=true   force real sends (e.g. testing a real send to a
 *                             scratch row locally)
 *   SEND_NOTIFICATIONS=false  force off everywhere (e.g. a secondary prod
 *                             instance that must not double-send)
 *   unset                     live only when NODE_ENV === 'production'
 *
 * When this returns false, sendEmail / sendSMS take their existing
 * log-and-skip path — the same path used when credentials are absent.
 * sendPush (pushSender.js) takes its own skip path: it logs the push
 * service's host and returns { ok: false, error: 'notifications_off' }.
 *
 * @returns {boolean} true → really send; false → log only
 */
function notificationsEnabled() {
  if (process.env.SEND_NOTIFICATIONS === 'true') return true;
  if (process.env.SEND_NOTIFICATIONS === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

module.exports = { notificationsEnabled };
