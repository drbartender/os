'use strict';

// Comms action: payment_reminder (plan P1). Ports POST
// /api/proposals/:id/send-reminder (server/routes/proposals/actions.js:90). It
// is a BALANCE reminder — named honestly so the modal copy never implies a
// receipt. MONEY RULE: the outstanding balance is derived exactly as the legacy
// route (total_price - amount_paid) and rendered by the SAME formula the parts
// template uses; no amount is invented or recomputed differently, and no money
// column is written. The legacy route has no state side effect, so
// ensureSideEffects only enforces the "balance must be positive" guard.
const { pool } = require('../../../db');
const { sendEmail } = require('../../email');
const { sendSMS, normalizePhone } = require('../../sms');
const { logClientMessage } = require('../../messageLog');
const { renderPartsEmail } = require('../render');
const { paymentReminderParts } = require('../../emailTemplates');
const { checkEmailDomain } = require('../../emailValidation');
const { getEventTypeLabel } = require('../../../utils/eventTypes');
const { NotFoundError, ConflictError } = require('../../errors');
const { proposalUrl: buildProposalUrl } = require('../../urls');

const key = 'payment_reminder';
const messageType = 'payment_reminder';
const defaultChannels = { email: true, sms: true };

async function load(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.total_price, p.amount_paid, p.balance_due_date,
            p.event_type, p.event_type_custom,
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

// Exact legacy math: balanceDue = total_price - amount_paid (integer dollars as
// stored on proposals). Never recomputed differently anywhere in this file.
function balanceDueOf(row) {
  return Number(row.total_price || 0) - Number(row.amount_paid || 0);
}

function resolveFromRow(row) {
  const email = row.live_email || null;
  const phone = row.live_phone ? normalizePhone(row.live_phone) : null;
  const smsOk = smsAllowed(row, phone);
  // RFC-2606 import placeholders (CC import): sendEmail silently drops them, so
  // offering the channel would report a send that never happens (mirrors 937ba35).
  const isPlaceholder = Boolean(email && String(email).toLowerCase().endsWith('.invalid'));
  const warnings = [];

  if (balanceDueOf(row) <= 0) {
    warnings.push('This proposal has no outstanding balance to remind about.');
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

  // A placeholder can never be reported available (937ba35). The SMS body carries
  // the proposal share link (row.token), so SMS requires the token too, layered
  // under the existing opt-out/bad-phone reasons.
  const emailAvailable = Boolean(email && !isPlaceholder);
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
            : 'Proposal has no share token.'),
      },
    },
  };
}

async function resolveRecipient(proposalId) {
  return resolveFromRow(await load(proposalId));
}

// Display strings shared by the email parts and the SMS body so the two channels
// can never drift. The date formatter matches paymentReminderParts exactly.
function displayValues(row) {
  const balanceDue = balanceDueOf(row);
  const amount = `$${Number(balanceDue).toFixed(2)}`;
  const dueDate = row.balance_due_date
    ? new Date(row.balance_due_date).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    : 'before your event';
  return { balanceDue, amount, dueDate };
}

function defaultParts(row) {
  const eventTypeLabel = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  const proposalUrl = buildProposalUrl(row.token);
  const { balanceDue, amount, dueDate } = displayValues(row);
  return {
    email: paymentReminderParts({
      clientName: row.client_name,
      eventTypeLabel,
      balanceDue, // parts renders `$${Number(balanceDue).toFixed(2)}` — same formula
      balanceDueDate: row.balance_due_date,
      proposalUrl,
      paymentMode: 'manual', // legacy manual reminder had no autopay/last4 args
    }),
    sms: {
      body: `Hi, Dallas here. A reminder that your balance of ${amount} for your ${eventTypeLabel} is due on ${dueDate}. Pay here: ${proposalUrl}. Reply with any questions.`,
    },
  };
}

async function buildMessages(proposalId) {
  return defaultParts(await load(proposalId));
}

/**
 * Validate-only, no state change. Enforces the legacy NO_BALANCE_DUE guard so a
 * reminder is never sent on a settled proposal. No money column is written, so
 * a retry is safe and a second call is an identical no-op.
 */
async function ensureSideEffects(proposalId) {
  const row = await load(proposalId);
  if (balanceDueOf(row) <= 0) {
    throw new ConflictError('Proposal has no outstanding balance.', 'NO_BALANCE_DUE');
  }
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
// validate-only (always applied:false, only enforces the NO_BALANCE_DUE guard)
// because SENDING IS the operation; the flag exempts it from the /send route's
// concurrent-confirm dispatch guard (05d3ebd). The in-lane comms.js predates
// that guard, so the flag is inert here and becomes active on merge.
module.exports = {
  key, messageType, defaultChannels,
  resolveRecipient, buildMessages, ensureSideEffects, dispatch,
  dispatchWithoutSideEffects: true,
};
