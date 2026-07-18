'use strict';

// Comms action: portal_invite (plan P1). Ports POST
// /api/proposals/:id/portal-invite (server/routes/proposals/lifecycle.js). The
// portal sits behind OTP login (email a one-time code), so NO token rides in
// the link and nothing is minted — the invite has no state side effect
// (ensureSideEffects is a no-op). Email is the default channel per the
// prefer-email default; SMS is available when a phone exists but off by default.
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { sendSMS, normalizePhone } = require('../../sms');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { portalInviteParts } = require('../../lifecycleEmailTemplates');
const { checkEmailDomain } = require('../../emailValidation');
const { NotFoundError } = require('../../errors');
const { PUBLIC_SITE_URL } = require('../../urls');

const key = 'portal_invite';
const messageType = 'portal_invite';
const defaultChannels = { email: true, sms: false };

async function load(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id,
            c.id AS client_id, c.name AS client_name, c.email AS live_email,
            c.phone AS live_phone, c.email_status, c.phone_status,
            c.communication_preferences AS comm_prefs
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
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
  const email = row.live_email || null;
  const phone = row.live_phone ? normalizePhone(row.live_phone) : null;
  const smsOk = smsAllowed(row, phone);
  // RFC-2606 import placeholders (CC import): sendEmail silently drops them, so
  // offering the channel would report a send that never happens (mirrors 937ba35).
  const isPlaceholder = Boolean(email && String(email).toLowerCase().endsWith('.invalid'));
  const warnings = [];

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

  // A placeholder can never be reported available (937ba35). NO SMS token guard
  // is mirrored here: this invite is OTP-based, so its SMS body links to
  // /my-proposals with NO token (nothing is minted). The 937ba35 SMS-token guard
  // only applies where the SMS carries a share token, which this action does not.
  const emailAvailable = Boolean(email && !isPlaceholder);

  return {
    name: row.client_name || null,
    email,
    phone: smsOk ? phone : null,
    source: 'client',
    warnings,
    channels: {
      email: {
        available: emailAvailable,
        default: defaultChannels.email && emailAvailable,
        unavailable_reason: !email ? 'No email on file.'
          : (isPlaceholder ? 'Placeholder address (.invalid) from the CC import; no real email exists.' : null),
      },
      sms: {
        available: smsOk,
        default: false, // email-first invite; SMS is opt-in per send
        unavailable_reason: smsOk
          ? null
          : (!phone ? 'No usable phone on file.'
            : (row.phone_status === 'bad' ? 'Phone previously failed delivery.' : 'Client has opted out of SMS.')),
      },
    },
  };
}

async function resolveRecipient(proposalId) {
  return resolveFromRow(await load(proposalId));
}

function defaultParts(row) {
  const portalUrl = `${PUBLIC_SITE_URL}/my-proposals`;
  return {
    email: portalInviteParts({
      clientName: row.client_name,
      portalUrl,
    }),
    sms: {
      body: `Hi, Dallas here. Your Dr. Bartender client portal has your proposals, payments, and event details in one place: ${portalUrl}. Log in with your email and a one-time code, no password needed.`,
    },
  };
}

async function buildMessages(proposalId) {
  return defaultParts(await load(proposalId));
}

/**
 * No-op: the plain OTP invite mints no token and changes no state, so there is
 * nothing to apply and nothing to make idempotent. Second call is identical.
 * load() still runs so a missing proposal fails the same 404 as the legacy route.
 */
async function ensureSideEffects(proposalId) {
  await load(proposalId);
  return { applied: false };
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

// dispatchWithoutSideEffects: resend-type action — ensureSideEffects is
// validate-only (no-op; the OTP invite mints nothing) because SENDING IS the
// operation; the flag exempts it from the /send route's concurrent-confirm
// dispatch guard (05d3ebd). The in-lane comms.js predates that guard, so the
// flag is inert here and becomes active on merge.
module.exports = {
  key, messageType, defaultChannels,
  resolveRecipient, buildMessages, ensureSideEffects, dispatch,
  dispatchWithoutSideEffects: true,
};
