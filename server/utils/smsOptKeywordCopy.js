/**
 * The admin-facing copy for an inbound carrier opt keyword.
 *
 * Pure: no DB, no I/O. Extracted from smsInbound.js, which is at its size cap,
 * and worth its own file anyway because the WORDING here is the whole fix. The
 * opt branch used to run the compliance action and return before any alert, so
 * a client texting "Cancel" about their event was silently unsubscribed and
 * nobody was told. Prod holds four inbound "yes" messages that went the same way.
 */

// Opt keywords that carry an everyday meaning as well as a compliance one. A
// client texting "Cancel" almost certainly means "cancel my event", and the
// proposal drip asks "Want to lock it in before someone else grabs the date?",
// a question that invites the word "yes". We do NOT narrow the carrier sets to
// fix that: STOP/UNSUBSCRIBE/CANCEL/END/QUIT and START/YES/UNSTOP are mandated,
// so dropping a word is a compliance change. This set only decides whether the
// alert says out loud that the word may not have meant what the system did.
const AMBIGUOUS_OPT_WORDS = new Set(['cancel', 'end', 'quit', 'yes']);

/**
 * @param {Object} a
 * @param {'client'|'staff'|'unknown'} a.senderType
 * @param {string} a.who display name already resolved by the caller
 * @param {string} a.word the keyword exactly as it was texted
 * @param {'stop'|'start'} a.optKeyword
 * @param {string} a.from E.164 sender
 * @returns {{subject: string, line: string}}
 */
function buildOptKeywordAlert({ senderType, who, word, optKeyword, from }) {
  const isStop = optKeyword === 'stop';

  // An UNKNOWN sender has no clients row and no contractor_profiles row, and
  // setSmsEnabled has no branch for that case -- it writes nothing, anywhere.
  // Saying "they are now unsubscribed" there is false twice over: no preference
  // was stored, and there is no thread to reply on. It matters beyond wording,
  // because this codebase has NO per-number suppression list (smsOptIn.js says
  // so outright): the opt-out lives only on a clients row, so if one is created
  // later it starts sms_enabled = true and the drip can text a number that
  // already said STOP. Only Twilio's carrier list stops it.
  const did = senderType === 'unknown'
    ? 'We hold no record for this number, so nothing changed on our side. Twilio has registered the keyword at the carrier.'
    : (isStop
      // The operationally important half: the admin's habit is to answer an
      // inbound from the Messages page, and that channel is what just closed.
      ? 'They are now unsubscribed from our texts, so you cannot reply by SMS. Use email or call instead.'
      : 'They are now re-subscribed to our texts.');

  const ambiguous = AMBIGUOUS_OPT_WORDS.has(String(word || '').toLowerCase())
    ? ` Heads up: "${word}" is a carrier opt-${isStop ? 'out' : 'in'} keyword, but it often means something else. Check what they actually wanted.`
    : '';

  return {
    subject: `${who} texted "${word}" and is now opted ${isStop ? 'out' : 'in'}`,
    line: `${who} (${from}) texted Dr. Bartender: "${word}". ${did}${ambiguous}`,
  };
}

module.exports = { AMBIGUOUS_OPT_WORDS, buildOptKeywordAlert };
