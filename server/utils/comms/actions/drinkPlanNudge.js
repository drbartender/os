'use strict';

// Comms action: drink_plan_nudge (spec 4.4). Ports the manual "Resend planner
// link" send (POST /api/drink-plans/:id/resend-nudge) into the compose-first
// contract. This is the ADMIN manual resend, not the scheduled T-21 nudge, so
// it deliberately does NOT suppress on an already-filled plan.
//
// Recipient is the LIVE client email via the proposal join (the original route
// already resolved c.email, not the drink_plans snapshot — preserved here, with
// the snapshot kept only as a fallback + mismatch warning, mirroring
// shoppingListApprove.js). dispatch OWNS its ledger writes (sendEmail/sendSMS
// called with skipLog) so a provider throw still lands a 'failed' row.
//
// Suppression that the legacy route applied is preserved honestly:
//   - archived event   -> hard block in ensureSideEffects (no client comms).
//   - SMS opt-out / bad phone_status -> the SMS channel is marked unavailable
//     (the legacy route gated the SMS half on shouldSendImmediate). Email was
//     never comm-pref-gated by the legacy route, so email stays available and a
//     bad email_status is an overridable warning, exactly as shoppingListApprove.
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { sendSMS, normalizePhone } = require('../../sms');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { drinkPlanNudgeParts } = require('../../lifecycleEmailTemplates');
const { drinkPlanNudgeSms } = require('../../smsTemplates');
const { checkEmailDomain } = require('../../emailValidation');
const { getEventTypeLabel } = require('../../../utils/eventTypes');
const { formatEventDateForSms } = require('../../smsEventDate');
const { PUBLIC_SITE_URL } = require('../../urls');
const { NotFoundError, ConflictError } = require('../../errors');

const key = 'drink_plan_nudge';
const messageType = 'drink_plan_nudge';
const defaultChannels = { email: true, sms: true };

// One row fetch shared by resolve/build/dispatch. Live client email via the
// proposal join is the source of truth; the drink_plans snapshot email is only
// a fallback (and drives a mismatch warning) so a stale plan snapshot can never
// silently redirect the send.
async function load(planId) {
  const { rows } = await pool.query(
    `SELECT dp.id, dp.token AS plan_token, dp.proposal_id,
            dp.client_email AS snapshot_email,
            p.status AS proposal_status,
            p.event_type, p.event_type_custom, p.event_date,
            c.id AS client_id, COALESCE(c.name, dp.client_name) AS client_name,
            c.email AS live_email, c.phone AS live_phone,
            c.email_status, c.phone_status, c.communication_preferences
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE dp.id = $1`,
    [planId]
  );
  if (!rows[0]) throw new NotFoundError('Drink plan not found.');
  return rows[0];
}

function resolveFromRow(row) {
  const email = row.live_email || row.snapshot_email || null;
  const source = row.live_email ? 'client' : 'snapshot';
  const phone = row.live_phone ? normalizePhone(row.live_phone) : null;
  const prefs = row.communication_preferences || {};
  const smsOptedOut = prefs.sms_enabled === false;
  const phoneBad = row.phone_status === 'bad';
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

  // Email needs a real, non-placeholder address (mirrors 937ba35). The SMS body
  // carries the planner link (row.plan_token), so an available SMS channel
  // additionally requires the token, layered under the opt-out/bad-phone reasons.
  const emailReason = !email
    ? 'No email on file.'
    : (isPlaceholder ? 'Placeholder address (.invalid) from the CC import; no real email exists.' : null);
  const emailAvailable = Boolean(email) && !isPlaceholder;

  const smsReason = !phone
    ? 'No usable phone on file.'
    : (smsOptedOut
      ? 'Client has opted out of text messages.'
      : (phoneBad
        ? 'A previous text to this number failed. Confirm the number before sending.'
        : (!row.plan_token ? 'Drink plan has no share token.' : null)));
  const smsAvailable = Boolean(phone) && !smsOptedOut && !phoneBad && Boolean(row.plan_token);

  return {
    name: row.client_name || null,
    email,
    phone,
    source,
    warnings,
    channels: {
      email: {
        available: emailAvailable,
        default: defaultChannels.email && emailAvailable,
        unavailable_reason: emailReason,
      },
      sms: {
        available: smsAvailable,
        default: defaultChannels.sms && smsAvailable,
        unavailable_reason: smsReason,
      },
    },
  };
}

async function resolveRecipient(planId) {
  return resolveFromRow(await load(planId));
}

function firstNameOf(fullName) {
  if (!fullName) return 'there';
  return String(fullName).trim().split(/\s+/)[0] || 'there';
}

function defaultParts(row) {
  const eventTypeLabel = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  const plannerUrl = row.plan_token
    ? `${PUBLIC_SITE_URL}/plan/${row.plan_token}`
    : `${PUBLIC_SITE_URL}/plan`;
  const consultUrl = process.env.CAL_BOOKING_URL || null;
  return {
    email: drinkPlanNudgeParts({
      clientFirstName: firstNameOf(row.client_name),
      eventTypeLabel,
      eventDateDisplay: formatEventDateForSms(row.event_date) || 'your event',
      plannerUrl,
      phone: process.env.ADMIN_PHONE || null,
    }),
    sms: {
      body: drinkPlanNudgeSms({
        eventDate: formatEventDateForSms(row.event_date),
        plannerUrl,
        consultUrl,
      }),
    },
  };
}

async function buildMessages(planId) {
  return defaultParts(await load(planId));
}

/**
 * Idempotent side effects. The manual resend carries NO state bookkeeping (it
 * never suppresses on already-filled, unlike the scheduled nudge), so the only
 * thing enforced here is the archived precondition: an archived event never
 * gets client comms. This is a pure read + conditional throw — no mutation — so
 * a failed-dispatch retry is safe and { applied: false } is always returned for
 * a live event.
 */
async function ensureSideEffects(planId) {
  const { rows } = await pool.query(
    `SELECT p.status AS proposal_status
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
      WHERE dp.id = $1`,
    [planId]
  );
  if (!rows[0]) throw new NotFoundError('Drink plan not found.');
  if (rows[0].proposal_status === 'archived') {
    throw new ConflictError('This event is archived; the planner link was not resent.');
  }
  return { applied: false };
}

/**
 * Sends on the selected channels and writes one ledger row per attempt, success
 * or failure. sendEmail/sendSMS get skipLog: this action's ledger writes are
 * authoritative (sent_by, body_edited, exact error), and a thrown provider
 * error still lands a 'failed' row.
 */
async function dispatch(planId, message, channels, ctx = {}) {
  const row = await load(planId);
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
      proposalId: row.proposal_id, clientId: row.client_id || null,
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
      proposalId: row.proposal_id, clientId: row.client_id || null,
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

// dispatchWithoutSideEffects: validate-only resend — ensureSideEffects returns
// applied:false for a live event (its only job is the archived precondition
// check, no mutation) because SENDING IS the operation. The flag exempts it from
// the /send route's concurrent-confirm dispatch guard (05d3ebd) so a plain
// confirm still dispatches. Inert in-lane (this branch's comms.js predates the
// guard), active on merge.
// resolveFromRow is exported for the action-level unit tests (token/placeholder
// guards) — drink_plans.token is NOT NULL so the token guard can only be
// exercised on a synthetic row.
module.exports = {
  key, messageType, defaultChannels,
  resolveRecipient, resolveFromRow, buildMessages, ensureSideEffects, dispatch,
  dispatchWithoutSideEffects: true,
};
