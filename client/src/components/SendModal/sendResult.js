// Formats a POST /api/comms/send result payload (the object SendModal hands to
// onComplete) into one per-channel-truth toast line. Channels the admin never
// selected are omitted; every attempted channel reports its real outcome, so a
// partial failure ("Emailed x@y.com. Text failed: ...") never hides behind a
// blanket success. Returns { hadFailure, level, message }:
//   hadFailure  true when any attempted channel failed (pick toast.error)
//   level       'error' | 'success' | 'info' (same signal, enum form)
// Shared by every SendModal-consuming surface; single source of truth (a
// cross-lane duplicate of this helper was unified here on 2026-07-18).
//
// A text to a Thumbtack relay client can come back sms 'queued': it became a
// GV post into the client's Thumbtack thread, which the box sends within
// minutes (spec docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md;
// plan Task 11). That reads "Queued for Thumbtack", at success level.
export function describeSendResult(results) {
  const r = results || {};
  const clauses = [];
  let sentCount = 0;
  let failedCount = 0;

  if (r.email === 'sent') { clauses.push(`Emailed ${r.recipient_email || 'the client'}`); sentCount += 1; }
  else if (r.email === 'failed') { clauses.push(`Email failed: ${r.email_error || 'unknown error'}`); failedCount += 1; }
  else if (r.email === 'skipped' && r.skip_reasons && r.skip_reasons.email && r.skip_reasons.email !== 'not selected') {
    clauses.push(`Email skipped: ${r.skip_reasons.email}`);
  }

  if (r.sms === 'sent') { clauses.push(`Texted ${r.recipient_phone || 'the client'}`); sentCount += 1; }
  else if (r.sms === 'queued') { clauses.push('Queued for Thumbtack'); sentCount += 1; }
  else if (r.sms === 'failed') { clauses.push(`Text failed: ${r.sms_error || 'unknown error'}`); failedCount += 1; }
  else if (r.sms === 'skipped' && r.skip_reasons && r.skip_reasons.sms && r.skip_reasons.sms !== 'not selected') {
    clauses.push(`Text skipped: ${r.skip_reasons.sms}`);
  }

  const message = clauses.length ? `${clauses.join('. ')}.` : 'Done. No message was sent.';
  const level = failedCount ? 'error' : sentCount ? 'success' : 'info';
  return { hadFailure: failedCount > 0, level, message };
}

/**
 * One channel's line in the SendModal's result step (and the phone's
 * ResendSheet for a queued post). key is 'email' or 'sms'; channels is the
 * preview's channels object, whose sms.phone_last4 names a relay number.
 * Returns { kind: 'sent' | 'failed' | 'queued' | 'skipped', text }; any
 * status this code does not know reads skipped.
 */
export function channelResultLine(key, results, channels) {
  const r = results || {};
  const status = r[key];
  const isEmail = key === 'email';
  if (status === 'sent') {
    const contact = isEmail ? r.recipient_email : r.recipient_phone;
    return { kind: 'sent', text: `${isEmail ? 'Emailed' : 'Texted'} ${contact || 'the client'}` };
  }
  if (status === 'failed') {
    return { kind: 'failed', text: `${isEmail ? 'Email' : 'Text'} failed: ${r[`${key}_error`] || 'Please try again.'}` };
  }
  if (status === 'queued' && !isEmail) {
    const last4 = channels && channels.sms && channels.sms.phone_last4;
    return { kind: 'queued', text: last4 ? `Queued for Thumbtack (ending ${last4})` : 'Queued for Thumbtack' };
  }
  const skip = r.skip_reasons && r.skip_reasons[key];
  return { kind: 'skipped', text: `${isEmail ? 'Email' : 'Text'} skipped${skip ? `: ${skip}` : ''}` };
}

// The server's four relay-body messages (server/routes/comms.js,
// GV_BODY_MESSAGES), word for word.
const RELAY_NO_LINK = 'The text must include the proposal link.';
const RELAY_TWO_LINKS = 'The text can carry only one proposal link.';
const RELAY_WRONG_LINK = "The text links a different proposal. Use this proposal's link.";
const relayTooLong = (max) => `Thumbtack texts are capped at ${max} characters.`;
const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// The length a relay text is held to: the trimmed text, as POST
// /api/comms/send counts it (server/routes/comms.js trims before its cap).
export const relayBodyLength = (body) => String(body ?? '').trim().length;

/**
 * The relay text's body check, mirroring server/routes/comms.js and
 * server/utils/gvPost/rules.js validateGvBody so Send is blocked before the
 * server refuses. The trimmed text must be at most max characters
 * (relayBodyLength); then, with whitespace runs collapsed for the link checks
 * only, it must hold exactly one /proposal/<uuid> link, the one in the
 * server's drafted text (its host and its token). Returns the message, or
 * null when the body passes. A drafted text with no link (never expected)
 * leaves the link rule to the server.
 */
export function relayBodyProblem(body, defaultBody, max) {
  const raw = String(body ?? '').trim();
  if (relayBodyLength(raw) > max) return relayTooLong(max);
  const normalized = raw.replace(/\s+/g, ' ');
  const expected = String(defaultBody ?? '').match(new RegExp(`(https?://[^\\s/]+)/proposal/(${UUID_SRC})`, 'i'));
  if (!expected) return null;
  const links = [...normalized.matchAll(new RegExp(`/proposal/(${UUID_SRC})`, 'gi'))];
  if (links.length === 0) return RELAY_NO_LINK;
  if (links.length > 1) return RELAY_TWO_LINKS;
  const [match] = links;
  const onHost = normalized.slice(0, match.index).endsWith(expected[1]);
  if (!onHost || match[1].toLowerCase() !== expected[2].toLowerCase()) return RELAY_WRONG_LINK;
  return null;
}
