'use strict';

// Comms action: drink_plan_nudge_reenroll (plan P1). Ports POST
// /admin/proposals/:id/reenroll-drink-plan-nudge
// (server/routes/admin/ccImport/proposalActions.js). ensureSideEffects performs
// the re-enroll: clear the durable nudge suppression (cc-transfer sets it so
// Dallas can intro-note the client first) and (re)schedule the T-21 email+SMS
// nudges — idempotent, since scheduleDrinkPlanNudge no-ops on a pending
// duplicate and setting nudge_suppressed=false twice changes nothing. dispatch
// is the NEW compose-modal capability: an immediate drink-plan nudge on the
// selected channels (the legacy route only scheduled — see the deprecated route
// note, which preserves schedule-only behavior and does not auto-dispatch).
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { sendSMS, normalizePhone } = require('../../sms');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { drinkPlanNudgeParts } = require('../../lifecycleEmailTemplates');
const smsTemplates = require('../../smsTemplates');
const { checkEmailDomain } = require('../../emailValidation');
const { getEventTypeLabel } = require('../../../utils/eventTypes');
const { formatEventDateForSms } = require('../../smsEventDate');
const { scheduleDrinkPlanNudge } = require('../../drinkPlanNudge');
const { NotFoundError, ConflictError } = require('../../errors');
const { PUBLIC_SITE_URL } = require('../../urls');

const key = 'drink_plan_nudge_reenroll';
const messageType = 'drink_plan_nudge';
const defaultChannels = { email: true, sms: true };

function firstNameOf(fullName) {
  if (!fullName) return 'there';
  return String(fullName).trim().split(/\s+/)[0] || 'there';
}

// Live client via the proposal join is the recipient; the drink_plans row
// supplies the planner token (dp.token, NOT p.token — the Potion Planner route
// resolves WHERE dp.token) and the stale snapshot email for the mismatch warning.
async function load(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.event_type, p.event_type_custom, p.event_date,
            c.id AS client_id, c.name AS client_name, c.email AS live_email,
            c.phone AS live_phone, c.email_status, c.phone_status,
            c.communication_preferences AS comm_prefs,
            dp.plan_id, dp.plan_token, dp.snapshot_email
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN LATERAL (
         SELECT id AS plan_id, token AS plan_token, client_email AS snapshot_email
           FROM drink_plans WHERE proposal_id = p.id ORDER BY id ASC LIMIT 1
       ) dp ON true
      WHERE p.id = $1`,
    [proposalId]
  );
  if (!rows[0]) throw new NotFoundError('Proposal not found');
  return rows[0];
}

function smsAllowed(row, phone) {
  const prefs = row.comm_prefs || {};
  return Boolean(phone) && row.phone_status !== 'bad' && prefs.sms_enabled !== false;
}

function resolveFromRow(row) {
  const email = row.live_email || row.snapshot_email || null;
  const source = row.live_email ? 'client' : 'snapshot';
  const phone = row.live_phone ? normalizePhone(row.live_phone) : null;
  const smsOk = smsAllowed(row, phone);
  // RFC-2606 import placeholders (CC import): sendEmail silently drops them, so
  // offering the channel would report a send that never happens (mirrors 937ba35).
  const isPlaceholder = Boolean(email && String(email).toLowerCase().endsWith('.invalid'));
  const warnings = [];

  if (row.live_email && row.snapshot_email && row.live_email !== row.snapshot_email) {
    warnings.push(`Plan record still holds an older email (${row.snapshot_email}); sending to the current client record instead.`);
  }
  if (row.email_status === 'bad') {
    warnings.push('A previous email to this address hard-bounced. Confirm the address before sending.');
  }
  if (email) {
    const typo = checkEmailDomain(email);
    if (typo.suspicious) warnings.push(typo.reason + (typo.suggestion ? ` Did you mean ${typo.suggestion}?` : ''));
  }
  if (!email) warnings.push('No email on file for this client.');
  if (isPlaceholder) warnings.push('Address is a CC-import placeholder (.invalid); no real email exists for this client.');
  if (row.live_phone && !phone) warnings.push('Phone on file could not be parsed for SMS.');

  // A placeholder can never be reported available (937ba35). The SMS body links
  // to the Potion Planner via the DRINK-PLAN token (row.plan_token, NOT the
  // proposal token — planner-link token gotcha), so SMS requires that token,
  // layered under the existing opt-out/bad-phone reasons.
  const emailAvailable = Boolean(email && !isPlaceholder);
  const smsAvailable = smsOk && Boolean(row.plan_token);

  return {
    name: row.client_name || null,
    email,
    phone: smsOk ? phone : null,
    source,
    warnings,
    channels: {
      email: {
        available: emailAvailable,
        default: defaultChannels.email && emailAvailable,
        unavailable_reason: !email ? 'No email on file.'
          : (isPlaceholder ? 'Placeholder address (.invalid) from the CC import; no real email exists.' : null),
      },
      sms: {
        available: smsAvailable,
        default: defaultChannels.sms && smsAvailable,
        unavailable_reason: smsAvailable
          ? null
          : (!smsOk
            ? (!phone ? 'No usable phone on file.'
              : (row.phone_status === 'bad' ? 'Phone previously failed delivery.' : 'Client has opted out of SMS.'))
            : 'Drink plan has no share token.'),
      },
    },
  };
}

async function resolveRecipient(proposalId) {
  return resolveFromRow(await load(proposalId));
}

function plannerUrlOf(row) {
  return row.plan_token ? `${PUBLIC_SITE_URL}/plan/${row.plan_token}` : `${PUBLIC_SITE_URL}/plan`;
}

function defaultParts(row) {
  const eventTypeLabel = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  const plannerUrl = plannerUrlOf(row);
  return {
    email: drinkPlanNudgeParts({
      clientFirstName: firstNameOf(row.client_name),
      eventTypeLabel,
      eventDateDisplay: formatEventDateForSms(row.event_date) || 'your event',
      plannerUrl,
      phone: process.env.ADMIN_PHONE || null,
    }),
    sms: {
      body: smsTemplates.drinkPlanNudgeSms({
        eventDate: formatEventDateForSms(row.event_date),
        plannerUrl,
        consultUrl: process.env.CAL_BOOKING_URL || null,
      }),
    },
  };
}

async function buildMessages(proposalId) {
  return defaultParts(await load(proposalId));
}

/**
 * The re-enroll (this action's real side effect). Idempotent:
 *  - nudge_suppressed is flipped to false only when it was not already false
 *    (guarded UPDATE), so a second call flips nothing and reports applied:false;
 *  - scheduleDrinkPlanNudge is itself idempotent (scheduleMessage no-ops on a
 *    pending duplicate), so re-running never fans out duplicate scheduled sends.
 * Requires an existing drink plan, exactly like the legacy route.
 */
async function ensureSideEffects(proposalId) {
  const row = await load(proposalId);
  if (!row.plan_id) {
    throw new ConflictError('no drink plan exists for this proposal', 'NO_DRINK_PLAN');
  }
  const flip = await pool.query(
    `UPDATE drink_plans SET nudge_suppressed = false
       WHERE proposal_id = $1 AND nudge_suppressed IS DISTINCT FROM false
       RETURNING id`,
    [proposalId]
  );
  await scheduleDrinkPlanNudge(proposalId, pool);
  return { applied: flip.rows.length > 0 };
}

async function dispatch(proposalId, message, channels, ctx = {}) {
  const row = await load(proposalId);
  const recipient = resolveFromRow(row);
  const defaults = defaultParts(row);
  const results = { email: 'skipped', sms: 'skipped', skip_reasons: {} };

  const wantEmail = channels.includes('email');
  const wantSms = channels.includes('sms');

  if (wantEmail && !recipient.channels.email.available) {
    results.skip_reasons.email = recipient.channels.email.unavailable_reason;
  } else if (!wantEmail) {
    results.skip_reasons.email = 'not selected';
  }
  if (wantSms && !recipient.channels.sms.available) {
    results.skip_reasons.sms = recipient.channels.sms.unavailable_reason;
  } else if (!wantSms) {
    results.skip_reasons.sms = 'not selected';
  }

  if (wantEmail && recipient.channels.email.available) {
    const subject = (message?.email?.subject ?? defaults.email.subject).trim();
    const bodyText = (message?.email?.bodyText ?? defaults.email.bodyText).trim();
    const bodyEdited = subject !== defaults.email.subject || bodyText !== defaults.email.bodyText;
    const rendered = renderPartsEmail({ ...defaults.email, subject, bodyText });
    const entry = {
      channel: 'email', recipient: recipient.email, subject,
      proposalId: row.id, clientId: row.client_id || null,
      messageType, sentBy: ctx.sentBy || null, bodyEdited,
    };
    try {
      const r = await sendEmail({
        to: recipient.email, subject: rendered.subject, html: rendered.html, text: rendered.text,
        meta: { skipLog: true },
      });
      results.email = 'sent';
      if (r && r.id !== 'dev-skipped') {
        await logClientMessage({ ...entry, status: 'sent', providerId: r.id });
      }
    } catch (err) {
      results.email = 'failed';
      results.email_error = err.message || 'Email send failed.';
      await logClientMessage({ ...entry, status: 'failed', error: String(err.message || err).slice(0, 500) });
    }
  }

  if (wantSms && recipient.channels.sms.available) {
    const body = (message?.sms?.body ?? defaults.sms.body).trim();
    const bodyEdited = body !== defaults.sms.body;
    const entry = {
      channel: 'sms', recipient: recipient.phone, subject: body.slice(0, 140),
      proposalId: row.id, clientId: row.client_id || null,
      messageType: `${messageType}_sms`, sentBy: ctx.sentBy || null, bodyEdited,
    };
    try {
      const r = await sendSMS({ to: recipient.phone, body, meta: { skipLog: true } });
      results.sms = 'sent';
      if (r && !String(r.sid || '').startsWith('dev-skipped')) {
        await logClientMessage({ ...entry, status: 'sent', providerId: r.sid });
      }
    } catch (err) {
      results.sms = 'failed';
      results.sms_error = err.message || 'SMS send failed.';
      await logClientMessage({ ...entry, status: 'failed', error: String(err.message || err).slice(0, 500) });
    }
  }

  results.recipient_email = recipient.email;
  results.recipient_phone = recipient.phone;
  return results;
}

// dispatchWithoutSideEffects: resend-type dispatch. This action's
// ensureSideEffects DOES have a real side effect (the re-enroll: clear
// suppression + reschedule nudges), but that is DECOUPLED from the immediate
// nudge send — dispatch. Its applied flag reflects the re-enroll, not whether a
// message was sent, so gating dispatch on it would wrongly suppress the immediate
// nudge on a repeat confirm (2nd re-enroll = applied:false). The flag exempts it
// from the /send route's concurrent-confirm dispatch guard (05d3ebd) so the send
// fires on every confirm. The in-lane comms.js predates that guard, so the flag
// is inert here and becomes active on merge.
module.exports = {
  // Legacy route is adminOnly; the comms layer enforces the same floor via
  // minRole so managers cannot clear CC-import nudge suppression (M1).
  minRole: 'admin',
  key, messageType, defaultChannels,
  resolveRecipient, buildMessages, ensureSideEffects, dispatch,
  dispatchWithoutSideEffects: true,
};
