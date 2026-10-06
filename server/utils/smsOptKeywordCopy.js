/**
 * The admin-facing copy for an inbound carrier opt keyword.
 *
 * Pure: no DB, no I/O. Extracted from smsInbound.js, which is at its size cap,
 * and worth its own file anyway because the WORDING here is the whole fix. The
 * opt branch used to run the compliance action and return before any alert, so
 * a client texting "Cancel" about their event was silently unsubscribed and
 * nobody was told. Prod holds four inbound "yes" messages that went the same way.
 *
 * The STOP set is Twilio's eight default opt-out words: STOP, STOPALL,
 * UNSUBSCRIBE, END, CANCEL, QUIT, OPTOUT and REVOKE. The START set is START,
 * UNSTOP and YES, but YES is not mandated as an opt-in on the toll-free 888:
 * Twilio keeps the opt-out there, and so does sms_optouts (spec 2026-10-06,
 * amendment 32). So the copy says only what happened: a YES never reads as
 * "opted in" and never claims a number came off the opt-out list.
 */

// Opt keywords that carry an everyday meaning as well as a compliance one. A
// client texting "Cancel" almost certainly means "cancel my event", and the
// proposal drip asks "Want to lock it in before someone else grabs the date?",
// a question that invites the word "yes". We do NOT narrow the sets to fix
// that: the STOP words are Twilio's, so dropping one is a compliance change,
// and YES still runs the preference opt-in (amendment 32). This set only
// decides whether the alert says out loud that the word may not have meant
// what the system did.
const AMBIGUOUS_OPT_WORDS = new Set(['cancel', 'end', 'quit', 'yes']);

/**
 * @param {Object} a
 * @param {'client'|'staff'|'unknown'} a.senderType
 * @param {string} a.who display name already resolved by the caller
 * @param {string} a.word the keyword exactly as it was texted
 * @param {'stop'|'start'} a.optKeyword
 * @param {string} a.from E.164 sender
 * @param {boolean} [a.isClearingWord=false] true for START or UNSTOP, the two
 *   START-set words that take a number off sms_optouts. A YES is not one (spec
 *   amendment 32), so it leaves this false. Ignored for a STOP-set word.
 * @returns {{subject: string, line: string}}
 */
function buildOptKeywordAlert({ senderType, who, word, optKeyword, from, isClearingWord = false }) {
  const isStop = optKeyword === 'stop';
  const unknown = senderType === 'unknown';

  // An UNKNOWN sender has no clients row and no contractor_profiles row, and
  // setSmsEnabled has no branch for that case, so no PREFERENCE is stored.
  // Saying "they are now unsubscribed" there would be false, and there is no
  // thread to reply on. What does change is the per-phone opt-out record
  // (sms_optouts, spec 2026-10-06 decision 10): a STOP-set word writes it and
  // START or UNSTOP clears it, for any sender. A YES runs the preference
  // opt-in but never clears the record (spec amendment 32: on the toll-free
  // 888 Twilio does not treat YES as an opt-in), so its copy never says the
  // number came off the list. The record blocks the Messages reply and Inbox
  // on every line. The admin group send (POST /api/messages/send) does not
  // consult it (it checks agreement consent only), and automated sends do not
  // consult it yet (fix list), so a clients row created later still starts
  // sms_enabled = true.
  let did;
  if (isStop) {
    did = unknown
      ? 'This number is not a client or staff member, so no preference changed. It is now on our opt-out list, and Twilio has registered the keyword at the carrier.'
      // The operationally important half: the admin's habit is to answer an
      // inbound from the Messages page, and that channel is what just closed.
      : 'They are now unsubscribed from our texts, so you cannot reply by SMS. Use email or call instead.';
  } else if (isClearingWord) {
    // "Not on it now", never "off it again": the number may never have been on it.
    did = unknown
      ? 'This number is not a client or staff member, so no preference changed. It is not on our opt-out list now, and Twilio has registered the keyword at the carrier.'
      : 'They are now re-subscribed to our texts.';
  } else {
    did = unknown
      ? 'This number is not a client or staff member, so no preference changed. A YES does not take a number off our opt-out list; only START or UNSTOP does.'
      : 'They are now re-subscribed to our texts. A YES does not take them off our opt-out list, though: if they are on it, only START or UNSTOP does.';
  }

  // A STOP-side word really is a carrier opt-out keyword; a YES is not a
  // carrier opt-in on the 888, so its heads-up makes no carrier claim.
  let ambiguous = '';
  if (AMBIGUOUS_OPT_WORDS.has(String(word || '').toLowerCase())) {
    ambiguous = isStop
      ? ` Heads up: "${word}" is a carrier opt-out keyword, but it often means something else. Check what they actually wanted.`
      : ` Heads up: "${word}" often means something else. Check what they actually wanted.`;
  }

  let subject;
  if (isStop) subject = `${who} texted "${word}" and is now opted out`;
  else if (isClearingWord) subject = `${who} texted "${word}" and is now opted in`;
  else subject = `${who} texted "${word}"; the opt-out list is unchanged`;

  return {
    subject,
    line: `${who} (${from}) texted Dr. Bartender: "${word}". ${did}${ambiguous}`,
  };
}

module.exports = { AMBIGUOUS_OPT_WORDS, buildOptKeywordAlert };
