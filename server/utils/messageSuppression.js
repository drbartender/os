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

module.exports = { shouldSendImmediate };
