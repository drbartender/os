const VALID_CHANNELS = new Set(['email', 'sms']);

/**
 * Decide whether an immediate-send code path should proceed.
 *
 * Single source of truth for archive cascade + comm-prefs + bad-contact
 * checks. Plans 2b and 2c immediate sends MUST call this before invoking
 * sendEmail / sendSMS. The dispatcher's own suppression check (in
 * scheduledMessageDispatcher.checkSuppression) enforces the same rules
 * on scheduled rows — keep the two in sync if a rule changes.
 *
 * @param {Object} args
 * @param {Object} args.proposal - must include `.status` (one of the
 *   proposal_status enum values). Pass the row you already loaded; this
 *   function does no I/O.
 * @param {Object|null} args.client - clients row, must include
 *   `.communication_preferences`, `.email_status`, `.phone_status`.
 *   Missing client → bad_contact (no one to send to).
 * @param {'email'|'sms'} args.channel
 * @returns {Promise<{ok: true} | {ok: false, reason: 'archived' | 'channel_disabled' | 'bad_contact'}>}
 */
async function shouldSendImmediate({ proposal, client, channel }) {
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`shouldSendImmediate: invalid channel '${channel}'`);
  }
  if (proposal && proposal.status === 'archived') {
    return { ok: false, reason: 'archived' };
  }
  if (!client) {
    return { ok: false, reason: 'bad_contact' };
  }
  const prefs = client.communication_preferences || {};
  if (channel === 'email') {
    if (prefs.email_enabled === false) return { ok: false, reason: 'channel_disabled' };
    if (client.email_status === 'bad') return { ok: false, reason: 'bad_contact' };
  } else if (channel === 'sms') {
    if (prefs.sms_enabled === false) return { ok: false, reason: 'channel_disabled' };
    if (client.phone_status === 'bad') return { ok: false, reason: 'bad_contact' };
  }
  return { ok: true };
}

/**
 * Admin-facing copy for a suppression reason.
 *
 * Lives here, at the source of the reason tokens, so every call site renders
 * the same sentence and no future site can regress to interpolating the raw
 * enum into a toast. Admins were literally reading "Suppressed: channel_disabled."
 *
 * The strings are reason clauses, NOT full announcements: every consumer
 * already supplies its own lead-in ("Removed. Notice not sent: ...",
 * "Email skipped: ..."), so a "Not sent:" prefix here would double up. This
 * matches the sibling copy at the same call sites ("No email on file for this
 * client.").
 *
 * Semantics each string describes, read off shouldSendImmediate above and the
 * writers that set the underlying columns:
 *   archived          proposal.status === 'archived'. A restore (archived ->
 *                     draft) exists in routes/proposals/lifecycle.js.
 *   channel_disabled  communication_preferences.sms_enabled === false, set when
 *                     the client replies STOP (utils/smsInbound.js) or via the
 *                     /sms opt-in page (utils/smsConsent.js); START opts back
 *                     in. Or email_enabled === false, which no product path
 *                     writes today (the unsubscribe route only clears
 *                     marketing_enabled), so it is purely a stored preference.
 *   bad_contact       email_status === 'bad', set by the Resend webhook on a
 *                     permanent bounce; phone_status === 'bad', set by
 *                     utils/smsDeliveryStatus.js on a failed delivery; or no
 *                     client row at all. The copy deliberately does NOT say
 *                     "try again": NO admin-reachable surface clears these
 *                     flags today. PUT /clients/:id updates name/email/phone/
 *                     source/notes and never touches email_status or
 *                     phone_status; PUT /marketing/contacts/:id/email-status
 *                     can clear the email flag but has no UI wired to it; and
 *                     the phone_status reset only fires when an UNSIGNED
 *                     proposal's client re-confirms their number, which is
 *                     closed on exactly the booked proposals these notices fire
 *                     from. Telling an admin to retry would loop them forever,
 *                     so the copy points at another channel instead. Revisit
 *                     the day a clear-the-flag control exists.
 */
const SUPPRESSION_COPY = {
  archived: () =>
    'This proposal is archived, and archived proposals hold all client messages. '
    + 'Restore it first if the client should still hear from us.',
  channel_disabled: (channel) => {
    if (channel === 'sms') {
      return 'This client opted out of text messages, usually by replying STOP. '
        + 'They have to text START before we can text them again.';
    }
    if (channel === 'email') {
      return 'Email is switched off in this client\'s communication preferences, '
        + 'so nothing can go out by email. Reach them by phone or text instead.';
    }
    return 'This client has that channel switched off in their communication preferences.';
  },
  bad_contact: (channel) => {
    if (channel === 'sms') {
      return 'This client\'s phone number is marked bad after a text failed to deliver. '
        + 'Reach them another way: nothing will send to that number until the flag is '
        + 'cleared on the client record.';
    }
    if (channel === 'email') {
      return 'This client\'s email address is marked bad after a message permanently bounced. '
        + 'Reach them another way: nothing will send to that address until the flag is '
        + 'cleared on the client record.';
    }
    return 'The contact we have for this client is marked bad after a delivery failure, '
      + 'so nothing would reach them.';
  },
};

/**
 * Turn a suppression reason token into one plain-English admin-facing sentence.
 *
 * Never returns a bare enum token and never returns 'undefined': an unknown or
 * missing reason falls back to generic copy. Debuggability is not lost, because
 * most call sites console.log the raw reason alongside this string.
 *
 * @param {string} reason - a `reason` from shouldSendImmediate's ok:false result
 * @param {'email'|'sms'} [channel] - sharpens the wording; omit for channel-neutral copy
 * @returns {string}
 */
function suppressionMessage(reason, channel) {
  // hasOwnProperty, not a bare lookup: a reason of 'toString' or 'constructor'
  // would otherwise resolve to an Object.prototype member and render
  // "[object Object]" into an admin toast.
  const build = Object.prototype.hasOwnProperty.call(SUPPRESSION_COPY, reason)
    ? SUPPRESSION_COPY[reason]
    : null;
  if (!build) {
    return 'This message was held by the client contact rules. Check the client record before trying again.';
  }
  return build(channel);
}

module.exports = { shouldSendImmediate, suppressionMessage };
