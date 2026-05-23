const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { normalizePhone } = require('./sms');

// The 11 notification categories (spec 8.3). A notification declares its
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
]);

/**
 * Resolve the admin/manager users subscribed to a notification category.
 *
 * `users` has NO phone column, staff/admin phone lives on contractor_profiles.
 * This LEFT JOINs contractor_profiles so an admin with no profile row still
 * resolves (phone = null, email-only recipient).
 *
 * @param {string} category one of VALID_CATEGORIES.
 * @returns {Promise<Array<{id:number, email:string, phone:string|null, communication_preferences:object}>>}
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
    `SELECT u.id, u.email, u.communication_preferences, cp.phone
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
  }));
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
 * @returns {Promise<{emailed:number, texted:number}>}
 */
async function notifyAdminCategory({ category, subject, emailHtml, emailText, smsBody }) {
  let recipients = [];
  try {
    recipients = await resolveCategoryRecipients(category);
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'admin-notification', category } });
    console.error(`[adminNotifications] resolve failed for '${category}':`, err.message);
    return { emailed: 0, texted: 0 };
  }

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
        Sentry.captureException(err, {
          tags: { feature: 'admin-notification', category, channel: 'email' },
          extra: { recipient_id: r.id },
        });
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

  return { emailed, texted };
}

module.exports = { notifyAdminCategory, resolveCategoryRecipients, VALID_CATEGORIES };
