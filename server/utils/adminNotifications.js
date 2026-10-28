// notifyAdminCategory(...) - multi-admin notification fan-out by category (joins
// users.notification_preferences + contractor_profiles for SMS). An optional push leg starts first,
// fire-and-forget, behind the category, the kind switch and a stored subscription; pushAdminKind is
// push-only

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { normalizePhone } = require('./sms');
const { QuotaExceededError } = require('./errors');
const adminPush = require('./adminPush');

// Injected for tests; the push leg is the only network the module reaches
// besides email and SMS, and the suite must never contact a push service.
let _deps = { sendPushToUser: adminPush.sendPushToUser };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

// Every push leg started and not yet settled, plus every pushAdminKind call
// still resolving its recipients. Callers never await the leg (spec section
// 7: fire-and-forget after commit); tests do, through __flushPush. Every
// tracked promise must catch its own errors: track marks it handled (the
// then(untrack, untrack) below), so a rejection would otherwise be silent.
const pendingPush = new Set();
function track(p) {
  pendingPush.add(p);
  const untrack = () => { pendingPush.delete(p); };
  p.then(untrack, untrack);
  return p;
}
// Drains, not snapshots: a settling pushAdminKind queues its send legs after
// a snapshot would have been taken, so loop until nothing is pending.
async function __flushPush() {
  while (pendingPush.size) await Promise.allSettled([...pendingPush]);
}

// The notification categories (spec 8.3). A notification declares its
// category; the helper fans it out to every admin/manager subscribed to it.
const VALID_CATEGORIES = new Set([
  'urgent_booking',
  'urgent_consult',
  'urgent_staffing',
  'urgent_client_reply',
  'payment_failure',
  'feedback',
  'system_error',
  'routine_admin',
  'routine_thumbtack',
  'routine_hiring',
  'routine_finance',
  'stripe_payout_failed',
  'lead_call',
]);

/**
 * Resolve the admin/manager users subscribed to a notification category.
 *
 * `users` has NO phone column, staff/admin phone lives on contractor_profiles.
 * This LEFT JOINs contractor_profiles so an admin with no profile row still
 * resolves (phone = null, email-only recipient).
 *
 * @param {string} category one of VALID_CATEGORIES.
 * @returns {Promise<Array<{id:number, email:string, phone:string|null, communication_preferences:object, admin_push_preferences:object, push_subscription_count:number}>>}
 */
async function resolveCategoryRecipients(category) {
  if (!VALID_CATEGORIES.has(category)) {
    throw new Error(`resolveCategoryRecipients: unknown category '${category}'`);
  }
  // notification_preferences->>'<category>' returns the JSON value as text;
  // the column default sets every category to boolean true, so '= true' as
  // text matches. The category name is validated above against an allowlist,
  // so interpolating it into the ->> path is safe (it is never user input).
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.communication_preferences, cp.phone,
            COALESCE(u.admin_push_preferences, '{}'::jsonb) AS admin_push_preferences,
            COALESCE(jsonb_array_length(
              CASE WHEN jsonb_typeof(u.staff_notification_preferences->'push_subscriptions') = 'array'
                   THEN u.staff_notification_preferences->'push_subscriptions' ELSE '[]'::jsonb END), 0) AS push_subscription_count
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.role IN ('admin', 'manager')
        AND COALESCE(u.notification_preferences->>$1, 'true') = 'true'`,
    [category]
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    phone: r.phone || null,
    communication_preferences: r.communication_preferences || {},
    admin_push_preferences: r.admin_push_preferences || {},
    push_subscription_count: Number(r.push_subscription_count) || 0,
  }));
}

// The push leg. Gates, in order: the recipient list (the category gate,
// already applied by resolveCategoryRecipients), the per-kind switch (an
// absent key is ON), and at least one stored subscription. Returns how many
// recipients it will try; the sends run in the background and never throw.
// notifyAdminCategory starts this leg FIRST, before its email and SMS loop,
// so a banner is never held behind the Resend and Twilio round trips.
function pushRecipients(recipients, category, push) {
  if (!push || !adminPush.isPushKind(push.kind)) {
    if (push) console.error(`[adminNotifications] push dropped: unknown kind '${push && push.kind}' (category ${category})`);
    return 0;
  }
  const eligible = recipients.filter((r) =>
    (r.admin_push_preferences || {})[push.kind] !== false && (r.push_subscription_count || 0) > 0
  );
  if (!eligible.length) return 0;
  const tag = adminPush.pushTag(push.kind, push.recordId);
  for (const r of eligible) {
    track((async () => {
      try {
        await _deps.sendPushToUser({ userId: r.id, title: push.title, body: push.body, url: push.url, tag, surface: 'admin' });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { feature: 'admin-notification', category, channel: 'push', kind: push.kind },
          extra: { recipient_id: r.id },
        });
        console.error('[adminNotifications] push to user ' + r.id + ' failed:', err && err.message);
      }
    })());
  }
  // pushQueued is a RECIPIENT count: users whose stored array is non-empty, any
  // surface. The per-user send then skips malformed and staff entries, so a
  // counted recipient can land on zero devices; do not read it as a device count.
  return eligible.length;
}

// Push only (no email, no SMS): the drink-plan submit uses this, whose email
// keeps its own balance-changed throttle. The whole call is tracked, so a
// fire-and-forget caller's recipient read and its send legs are both awaited
// by __flushPush; a caller that awaits it still gets { pushQueued }.
function pushAdminKind({ category, push }) {
  return track((async () => {
    let recipients = [];
    try {
      recipients = await resolveCategoryRecipients(category);
    } catch (err) {
      Sentry.captureException(err, { tags: { feature: 'admin-notification', category, channel: 'push' } });
      return { pushQueued: 0 };
    }
    return { pushQueued: pushRecipients(recipients, category, push) };
  })());
}

/**
 * Fan a notification out to every admin/manager subscribed to `category`.
 *
 * Email is sent to each recipient. SMS is sent only when `smsBody` is provided
 * AND the recipient has a usable contractor_profiles phone AND has not opted
 * out of SMS. Best-effort: a per-recipient failure is captured to Sentry and
 * does not abort the rest. The helper never throws into its caller.
 *
 * @param {Object} args
 * @param {string} args.category
 * @param {string} args.subject email subject (no em dashes).
 * @param {string} args.emailHtml email HTML body.
 * @param {string} [args.emailText] email plain-text body.
 * @param {string} [args.smsBody] when set, also SMS subscribed admins.
 * @param {{kind:string,title:string,body:string,url:string,recordId?:number|string}} [args.push] when set, also push subscribed admins whose switch for this kind is on (spec section 7, 2026-10-14). Fire-and-forget.
 * @returns {Promise<{emailed:number, texted:number, pushQueued:number}>}
 */
async function notifyAdminCategory({ category, subject, emailHtml, emailText, smsBody, push }) {
  let recipients = [];
  try {
    recipients = await resolveCategoryRecipients(category);
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'admin-notification', category } });
    console.error(`[adminNotifications] resolve failed for '${category}':`, err.message);
    return { emailed: 0, texted: 0, pushQueued: 0 };
  }

  // The push leg starts first (fire-and-forget), so its banners never wait on
  // the sequential email and SMS sends below.
  const pushQueued = pushRecipients(recipients, category, push);

  let emailed = 0;
  let texted = 0;

  // SMS sender resolved lazily so a Phase-3-not-yet-landed environment still
  // works (sendAndLogSms is added to sms.js by Phase 3). Falls back to the
  // bare sendSMS when sendAndLogSms is absent.
  let smsSend = null;
  if (smsBody) {
    const smsModule = require('./sms');
    if (typeof smsModule.sendAndLogSms === 'function') {
      smsSend = (to) => smsModule.sendAndLogSms({
        to, body: smsBody, clientId: null, messageType: `admin_${category}`,
      });
    } else if (typeof smsModule.sendSMS === 'function') {
      smsSend = (to) => smsModule.sendSMS({ to, body: smsBody });
    }
  }

  for (const r of recipients) {
    if (r.email) {
      try {
        await sendEmail({ to: r.email, subject, html: emailHtml, text: emailText });
        emailed += 1;
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          // Resend daily-cap / rate-limit on a best-effort admin notice is not
          // worth paging on: breadcrumb at warning level and move on.
          Sentry.captureMessage('admin notification skipped: email quota/rate limit', {
            level: 'warning',
            tags: { feature: 'admin-notification', category, channel: 'email', reason: 'resend_quota' },
            extra: { recipient_id: r.id },
          });
        } else {
          Sentry.captureException(err, {
            tags: { feature: 'admin-notification', category, channel: 'email' },
            extra: { recipient_id: r.id },
          });
        }
        console.error(`[adminNotifications] email to user ${r.id} failed:`, err.message);
      }
    }
    if (smsSend) {
      const prefs = r.communication_preferences || {};
      const phone = normalizePhone(r.phone || '');
      if (phone && prefs.sms_enabled !== false) {
        try {
          await smsSend(phone);
          texted += 1;
        } catch (err) {
          Sentry.captureException(err, {
            tags: { feature: 'admin-notification', category, channel: 'sms' },
            extra: { recipient_id: r.id },
          });
          console.error(`[adminNotifications] SMS to user ${r.id} failed:`, err.message);
        }
      }
    }
  }

  return { emailed, texted, pushQueued };
}

module.exports = { notifyAdminCategory, pushAdminKind, resolveCategoryRecipients, VALID_CATEGORIES, __setDeps, __flushPush };
