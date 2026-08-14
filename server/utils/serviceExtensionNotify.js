'use strict';

/**
 * Every outbound message for an on-site service extension.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 10.
 *
 * Sends are IMMEDIATE and direct, not queued through
 * enqueueCategorizedMessage, because that path's dispatcher runs every 5
 * minutes and a bartender waiting to know whether to keep pouring cannot wait
 * that long. The trade is that this module owns its own channel gate, which
 * must honor exactly what the queued path honors:
 *   - staff: agreements.sms_consent (the messages.js rule) + users.communication_preferences
 *   - client: shouldSendImmediate (comm prefs + bad-contact + archived)
 *
 * NEVER call this inside a transaction. Every send helper takes its own pooled
 * connection, so holding one here would deadlock the pool under load
 * (CLAUDE.md one-pooled-connection rule). Callers release first, then notify.
 *
 * Copy rule: no em dashes anywhere in this file's message strings.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { sendAndLogSms } = require('./sms');
const { shouldSendImmediate } = require('./messageSuppression');
const { notifyAdminCategory } = require('./adminNotifications');
const { sendPush } = require('./pushSender');
const { renderExtensionTerms } = require('../data/extensionTermsCopy');
const { PUBLIC_SITE_URL, ADMIN_URL, STAFF_URL } = require('./urls');

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2).replace(/\.00$/, '')}`;
}

/** Never let a notification failure escape into a money path. */
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'service-extension', notify: label } });
    }
    console.error(`[serviceExtensionNotify] ${label} failed (non-blocking):`, err.message);
    return null;
  }
}

// ─── Client ────────────────────────────────────────────────────────────────

async function notifyClientOfRequest({ proposalId, invoiceToken, amountCents, newEndDisplay, termsVersion }) {
  const { rows } = await pool.query(
    `SELECT p.status,
            c.id AS client_id, c.name, c.email, c.phone,
            c.communication_preferences, c.email_status, c.phone_status
       FROM proposals p JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  if (!rows[0]) return { sms: 'skipped', email: 'skipped', reachable: false };
  const row = rows[0];
  const proposal = { status: row.status };
  const client = {
    communication_preferences: row.communication_preferences,
    email_status: row.email_status,
    phone_status: row.phone_status,
  };

  const link = `${PUBLIC_SITE_URL}/invoice/${encodeURIComponent(invoiceToken)}`;
  // renderExtensionTerms THROWS on an unknown version by design. This runs in
  // an unwrapped post-commit tail, so an uncaught throw here would 500 a request
  // whose invoice and extension row are already committed. Degrade to the SMS
  // leg (which does not need the terms text) and let the invoice page render the
  // terms; the page has its own fallback for the same case.
  let terms = null;
  try {
    terms = renderExtensionTerms({ version: termsVersion, newEndDisplay });
  } catch (copyErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(copyErr, { tags: { feature: 'service-extension', step: 'terms_render_notify' } });
    }
    console.error('[serviceExtensionNotify] unknown terms version:', termsVersion, copyErr.message);
  }
  const priced = Number(amountCents) > 0 ? ` (${money(amountCents)})` : ' (included in your package)';

  // The two client legs are independent (different gates, different
  // providers); running them in parallel takes ~1s of provider latency off the
  // staffer's submit, which awaits this tail before its 201.
  const [smsResult, emailResult] = await Promise.all([
    (async () => {
      const smsGate = await shouldSendImmediate({ proposal, client, channel: 'sms' });
      if (!smsGate.ok || !row.phone) return 'skipped';
      const sent = await safe('client_sms', () => sendAndLogSms({
        to: row.phone,
        body: `Dr. Bartender: your bartender asked to extend bar service to ${newEndDisplay}${priced}. Review and confirm here: ${link}`,
        clientId: row.client_id,
        proposalId,
        messageType: 'service_extension_request',
        recipientName: row.name || null,
      }));
      return sent && sent.status !== 'skipped' ? 'sent' : 'skipped';
    })(),
    (async () => {
      const emailGate = await shouldSendImmediate({ proposal, client, channel: 'email' });
      if (!emailGate.ok || !row.email || !terms) return 'skipped';
      const paragraphs = terms.paragraphs.map((t) => `<p>${t}</p>`).join('');
      const sent = await safe('client_email', () => sendEmail({
        to: row.email,
        subject: `Extend bar service to ${newEndDisplay}?`,
        html: `<h2>${terms.headline}</h2>${paragraphs}
             <p><strong>${Number(amountCents) > 0 ? money(amountCents) : 'No additional charge'}</strong></p>
             <p><a href="${link}">Review and confirm</a></p>`,
        text: [terms.headline, ...terms.paragraphs,
          Number(amountCents) > 0 ? money(amountCents) : 'No additional charge',
          `Review and confirm: ${link}`].join('\n\n'),
        meta: { proposalId, messageType: 'service_extension_request' },
      }));
      return sent ? 'sent' : 'skipped';
    })(),
  ]);

  return {
    sms: smsResult,
    email: emailResult,
    reachable: smsResult === 'sent' || emailResult === 'sent',
  };
}

// ─── Staff ─────────────────────────────────────────────────────────────────

const STAFF_COPY = Object.freeze({
  approved: ({ newEndDisplay }) =>
    `Dr. Bartender: approved. Bar service now runs to ${newEndDisplay}. Your hours are updated, nothing else to do.`,
  declined: ({ contractedEndDisplay }) =>
    `Dr. Bartender: additional time was not approved. Bar service ends at ${contractedEndDisplay} as contracted. Serving past that is not DRB work and is not covered by DRB insurance. Do not accept payment from the client directly.`,
});

async function notifyStaffOfOutcome({ staffUserIds, outcome, newEndDisplay, contractedEndDisplay, proposalId }) {
  const ids = (staffUserIds || []).filter(Number.isInteger);
  if (ids.length === 0) return { notified: [], unreachable: [] };
  if (!STAFF_COPY[outcome]) throw new Error(`notifyStaffOfOutcome: invalid outcome '${outcome}'`);

  const body = STAFF_COPY[outcome]({ newEndDisplay, contractedEndDisplay });
  const subject = outcome === 'approved'
    ? `Bar service extended to ${newEndDisplay}`
    : 'Additional time was not approved';

  // sms_consent is the staff SMS gate (messages.js). LEFT JOIN so a staffer
  // with no agreements row is push/email-only rather than silently dropped.
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.communication_preferences AS prefs,
            u.staff_notification_preferences AS staff_prefs,
            cp.phone, COALESCE(ag.sms_consent, false) AS sms_consent
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
       LEFT JOIN agreements ag ON ag.user_id = u.id
      WHERE u.id = ANY($1)`,
    [ids]
  );

  const notified = [];
  const unreachable = [];

  for (const r of rows) {
    const prefs = r.prefs || {};
    let delivered = false;

    if (r.sms_consent && prefs.sms_enabled !== false && r.phone) {
      const sent = await safe(`staff_sms_${r.id}`, () => sendAndLogSms({
        to: r.phone,
        body,
        clientId: null,
        proposalId,
        messageType: `service_extension_${outcome}`,
      }));
      if (sent && sent.status !== 'skipped') delivered = true;
    }

    // Web push, the middle rung of the spec's SMS -> push -> email fallback.
    // sendPush takes a subscription directly, so no scheduled_messages row is
    // needed and there is no dispatcher latency. Attempted whenever SMS did not
    // land, which is exactly when a staffer without consent needs another rung.
    if (!delivered) {
      const subs = Array.isArray(r.staff_prefs?.push_subscriptions) ? r.staff_prefs.push_subscriptions : [];
      for (const sub of subs) {
        const pushed = await safe(`staff_push_${r.id}`, () => sendPush({
          subscription: { endpoint: sub.endpoint, keys: sub.keys },
          title: subject,
          body,
          url: `${STAFF_URL}/shifts`,
        }));
        // sendPush NEVER throws: it RESOLVES with { ok: false, gone } or
        // { ok: false, error: 'vapid_unset' } on failure (pushSender.js:46-66).
        // So a truthiness check would count every failure as a delivery, which
        // would suppress the staff_unreachable alert on exactly the decline
        // message that carries the insurance warning. Test ok === true.
        if (pushed?.ok === true) { delivered = true; break; }
      }
    }

    if (prefs.email_enabled !== false && r.email) {
      const sent = await safe(`staff_email_${r.id}`, () => sendEmail({
        to: r.email,
        subject,
        html: `<p>${body}</p>`,
        text: body,
        meta: { proposalId, messageType: `service_extension_${outcome}` },
      }));
      if (sent) delivered = true;
    }

    if (delivered) notified.push(r.id);
    else unreachable.push(r.id);
  }

  // A staffer who got neither message is a real problem for the DECLINE case:
  // that message carries the insurance warning and must not vanish silently.
  if (unreachable.length > 0) {
    await alertAdminsProblem({
      proposalId,
      kind: 'staff_unreachable',
      detail: `No channel reached staff user id(s) ${unreachable.join(', ')} for the "${outcome}" message. Contact them directly.`,
    });
  }

  return { notified, unreachable };
}

// ─── Admin ─────────────────────────────────────────────────────────────────

async function alertAdminsRequestSent({ proposalId, newEndDisplay, amountCents, requesterUserId, clientReachable }) {
  await safe('admin_request_sent', async () => {
    const reach = clientReachable ? '' : ' The client could not be reached on any channel, so you may need to relay the link.';
    const line = `A bartender asked to extend event #${proposalId} to ${newEndDisplay} for ${money(amountCents)}. The client has been sent the confirmation link.${reach}`;
    await notifyAdminCategory({
      category: 'routine_admin',
      subject: `Extension requested: event #${proposalId} to ${newEndDisplay}`,
      emailHtml: `<p>${line}</p><p>Requested by staff user id ${requesterUserId}.</p>
                  <p><a href="${ADMIN_URL}/events/${proposalId}">Open the event</a></p>`,
      emailText: `${line} Requested by staff user id ${requesterUserId}. ${ADMIN_URL}/events/${proposalId}`,
    });
  });
}

const PROBLEM_SUBJECTS = Object.freeze({
  client_unreachable: 'Extension link could not be delivered',
  paid_extension_stranded: 'A PAID extension was never applied: settle or refund it',
  multi_shift: 'Extension on a multi-shift event needs a manual shift edit',
  paid_after_expiry: 'An extension was paid after it expired: refund needed',
  settle_failed: 'An extension payment settled but its follow-up work failed',
  settle_healed: 'A crashed extension settle was healed automatically',
  staff_unreachable: 'Could not reach a staffer with an extension outcome',
  payroll_hours_locked: 'Extension hours could not be added to payroll automatically',
});

async function alertAdminsProblem({ proposalId, kind, detail }) {
  await safe(`admin_problem_${kind}`, async () => {
    const subject = PROBLEM_SUBJECTS[kind] || 'Service extension needs attention';
    const line = `Event #${proposalId}: ${detail}`;
    await notifyAdminCategory({
      // These two mean DRB is holding money for time that was not authorized or
      // not delivered, so they are urgent rather than routine.
      category: (kind === 'paid_after_expiry' || kind === 'paid_extension_stranded')
        ? 'urgent_client_reply' : 'routine_admin',
      subject: `${subject} (event #${proposalId})`,
      emailHtml: `<p>${line}</p><p><a href="${ADMIN_URL}/events/${proposalId}">Open the event</a></p>`,
      emailText: `${line} ${ADMIN_URL}/events/${proposalId}`,
      ...((kind === 'paid_after_expiry' || kind === 'paid_extension_stranded') ? { smsBody: line } : {}),
    });
  });
}

module.exports = {
  notifyClientOfRequest,
  notifyStaffOfOutcome,
  alertAdminsRequestSent,
  alertAdminsProblem,
  STAFF_COPY,
};
