'use strict';

// Which client notice a proposal edit triggers + structural validation of the
// caller's opt-in list. ONE module so the read-only notify-preflight and the
// PATCH can never drift on "would this send?".
//
// Exactly one notice type exists. The gratuity disclosure was deliberately
// REMOVED from this contract (2026-07-22): it is a billing disclosure, stays
// automatic in crud.js, and gained only the suppression gate. Do not re-add it
// here without re-reading the spec's reversal note
// (docs/superpowers/specs/2026-07-21-notify-client-confirmation-design.md).
const { hasReschedulableChange, reschedulableStatusOk } = require('./rescheduleProposal');
const { ValidationError } = require('./errors');

const NOTICE_EVENT_DETAILS = 'event_details_changed';

// Mirrors comms.js's inline (non-exported) rules; a divergence is a review finding.
const SUBJECT_MAX = 300;
const SMS_MAX_CHARS = 640;
const CHANNELS = ['email', 'sms'];

/**
 * Does this edit trigger the event-details notice? Field list and status gate
 * are the exact functions the send path uses (rescheduleProposal.js), so a new
 * reschedulable field lands in both places or neither.
 */
function eventDetailsNoticeApplies({ old, updated, status }) {
  return reschedulableStatusOk(status) && hasReschedulableChange(old, updated);
}

function cleanSubject(raw) {
  const subject = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!subject) throw new ValidationError({ subject: 'Subject cannot be empty.' });
  if (subject.length > SUBJECT_MAX) {
    throw new ValidationError({ subject: `Subject is over the ${SUBJECT_MAX} character cap.` });
  }
  return subject;
}

/**
 * Structural validation of the caller's notify list. Runs BEFORE
 * pool.connect(), so a malformed request never checks out a connection.
 * Trigger validation (does this save actually fire the notice?) lives where
 * shouldSendEmail is computed, inside the transaction.
 *
 * Returns normalized entries; throws ValidationError on anything malformed.
 */
function validateNotifyList(notify) {
  if (notify === undefined || notify === null) return [];
  if (!Array.isArray(notify)) throw new ValidationError({ notify: 'notify must be an array.' });
  const seen = new Set();
  return notify.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new ValidationError({ notify: 'Each notice must be an object.' });
    }
    if (entry.type !== NOTICE_EVENT_DETAILS) {
      throw new ValidationError({ notify: `Unknown notice type: ${entry && entry.type}` });
    }
    if (seen.has(entry.type)) {
      throw new ValidationError({ notify: `Duplicate notice type: ${entry.type}` });
    }
    seen.add(entry.type);
    const rawChannels = Array.isArray(entry.channels) ? entry.channels : [];
    const unknown = rawChannels.find((c) => !CHANNELS.includes(c));
    if (unknown !== undefined) {
      // Reject rather than silently dropping: a typo'd channel from a future
      // caller must error, not vanish into an email-only send.
      throw new ValidationError({ channels: `Unknown channel: ${unknown}` });
    }
    const channels = rawChannels;
    if (channels.length === 0) {
      throw new ValidationError({ channels: `${entry.type} needs at least one channel.` });
    }
    const out = { type: entry.type, channels };
    if (channels.includes('email')) {
      out.email = {
        subject: cleanSubject(entry.email?.subject),
        bodyText: String(entry.email?.body_text ?? '').trim(),
      };
      if (!out.email.bodyText) throw new ValidationError({ body_text: 'Message cannot be empty.' });
    }
    if (channels.includes('sms')) {
      const body = String(entry.sms?.body ?? '').trim();
      if (!body) throw new ValidationError({ sms_body: 'SMS message cannot be empty.' });
      if (body.length > SMS_MAX_CHARS) {
        throw new ValidationError({ sms_body: `SMS message is over the ${SMS_MAX_CHARS} character cap.` });
      }
      out.sms = { body };
    }
    return out;
  });
}

module.exports = { NOTICE_EVENT_DETAILS, eventDetailsNoticeApplies, validateNotifyList };
