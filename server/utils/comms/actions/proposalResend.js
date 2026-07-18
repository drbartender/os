'use strict';

// Comms action: proposal_resend (plan P1). Ports POST /api/proposals/:id/resend
// (server/routes/proposals/lifecycle.js) into the compose-first contract. The
// legacy resend re-sends the proposalSent email + initial-proposal SMS, leaving
// status and sent timestamps untouched — so this action has NO state side
// effect (ensureSideEffects is a validate-only no-op). dispatch OWNS its ledger
// writes with skipLog so a provider throw can never leave a sent-but-unlogged
// message (the 7/16 Brandon Martin failure class).
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { sendSMS, normalizePhone } = require('../../sms');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { proposalSentParts } = require('../../emailTemplates');
const smsTemplates = require('../../smsTemplates');
const { checkEmailDomain } = require('../../emailValidation');
const { getEventTypeLabel } = require('../../../utils/eventTypes');
const { formatEventDateForSms } = require('../../smsEventDate');
const { NotFoundError, ValidationError } = require('../../errors');
const { proposalUrl: buildProposalUrl } = require('../../urls');

const key = 'proposal_resend';
const messageType = 'proposal_sent';
const defaultChannels = { email: true, sms: true };

// The active, already-sent-and-not-yet-paid window the legacy route enforced.
// Draft is not sent yet; archived is shelved; paid/confirmed/completed are past
// the "review and sign" stage where the proposalSent copy would be stale.
const RESENDABLE = ['sent', 'viewed', 'modified', 'accepted'];

// One row fetch shared by resolve/build/dispatch. Live client via the proposal
// join is the source of truth for the recipient.
async function load(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_type, p.event_type_custom, p.event_date,
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
  // Preserve the legacy SMS-suppression semantics (shouldSendImmediate): a
  // bad-phone or SMS-opted-out client is never texted, even on default channels.
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
  if (!email && !phone) warnings.push('No email or phone on file for this client.');
  if (isPlaceholder) warnings.push('Address is a CC-import placeholder (.invalid); no real email exists for this client.');
  if (row.live_phone && !phone) warnings.push('Phone on file could not be parsed for SMS.');

  // Email needs a real address + the share token; a placeholder can never be
  // reported available (937ba35). The SMS body carries the same proposal share
  // link (row.token), so SMS requires the token too, layered under the existing
  // opt-out/bad-phone reasons.
  const emailAvailable = Boolean(email && row.token && !isPlaceholder);
  const smsAvailable = smsOk && Boolean(row.token);

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
          : (isPlaceholder ? 'Placeholder address (.invalid) from the CC import; no real email exists.'
            : (!row.token ? 'Proposal has no share token.' : null)),
      },
      sms: {
        available: smsAvailable,
        default: defaultChannels.sms && smsAvailable,
        unavailable_reason: smsAvailable
          ? null
          : (!smsOk
            ? (!phone ? 'No usable phone on file.'
              : (row.phone_status === 'bad' ? 'Phone previously failed delivery.' : 'Client has opted out of SMS.'))
            : 'Proposal has no share token.'),
      },
    },
  };
}

async function resolveRecipient(proposalId) {
  return resolveFromRow(await load(proposalId));
}

function defaultParts(row) {
  const eventTypeLabel = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  const proposalUrl = buildProposalUrl(row.token);
  return {
    email: proposalSentParts({
      clientName: row.client_name,
      eventTypeLabel,
      proposalUrl,
      planUrl: null,
    }),
    sms: {
      body: smsTemplates.initialProposalSms({
        eventTypeLabel,
        eventDate: formatEventDateForSms(row.event_date),
        link: proposalUrl,
      }),
    },
  };
}

async function buildMessages(proposalId) {
  return defaultParts(await load(proposalId));
}

/**
 * Validate-only, no state change: the legacy resend never bumped status or
 * sent timestamps. This just enforces the resendable-status guard (throws), so
 * a retry-after-failed-send is safe (nothing to un-apply). Second call is an
 * identical no-op.
 */
async function ensureSideEffects(proposalId) {
  const row = await load(proposalId);
  if (!RESENDABLE.includes(row.status)) {
    // ValidationError (HTTP 400) preserves the legacy resend route's status code.
    throw new ValidationError({}, `This proposal can't be resent from its current status (${row.status}).`);
  }
  return { applied: false };
}

/**
 * Sends on the selected channels; one ledger row per attempt (success or
 * failure). sendEmail/sendSMS get skipLog so this action's writes are
 * authoritative (sent_by, body_edited, exact error) and a thrown provider error
 * still lands a 'failed' row. dev-skipped provider results are not ledgered
 * (mirrors shoppingListApprove.js).
 */
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
// validate-only (always applied:false) because SENDING IS the operation; the
// flag exempts it from the /send route's concurrent-confirm dispatch guard
// (05d3ebd). The in-lane comms.js predates that guard, so the flag is inert
// here and becomes active on merge.
// resolveFromRow is exported for the action-level unit tests (token/placeholder
// guards) — proposals.token is NOT NULL so the guard can only be exercised on a
// synthetic row.
module.exports = {
  key, messageType, defaultChannels,
  resolveRecipient, resolveFromRow, buildMessages, ensureSideEffects, dispatch,
  dispatchWithoutSideEffects: true,
};
