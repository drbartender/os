/**
 * Tag suggestions.
 *
 * A suggestion is NEVER applied. It renders next to the contact with its
 * reasoning and a one-click accept, and accepting goes through the ordinary
 * tag endpoint as a human write. Nothing here may set a tag.
 *
 * WHY THE DOMAIN IS ONLY AN INPUT, NEVER THE DECISION
 * ---------------------------------------------------
 * Measured against production across every client with a proposal, using the
 * same definitions this module consumes (corporate = an event actually PAID
 * for, personal = booked or merely quoted), 2026-08-13:
 *
 *                        booked corporate   personal history only
 *   company domain               6                   19
 *   free mail                    3                  161
 *
 * Read it in both directions and the domain fails twice:
 *
 *   - 3 of the 9 clients who actually booked corporate work did it from a
 *     personal address (one is a community college booking from gmail). A
 *     free-mail address is not evidence against corporate.
 *   - 19 of the 25 company-domain clients with any history at all booked
 *     nothing but their own weddings, birthdays and showers. A company address
 *     is barely evidence FOR corporate: guessing from it alone is wrong about
 *     three times in four whenever there is history to check it against.
 *
 * So event history outranks the domain in both directions, and the domain-only
 * path (which fires only when there is no history to outrank it) has to say out
 * loud that it is guessing.
 *
 * An earlier revision of this comment published 16/10/14/119 here. Those counts
 * came from treating any corporate PROPOSAL as a booking, which is the same
 * defect that made suggestTag claim "Booked a corporate event before" for
 * people who only ever got a quote.
 */

const FREE_MAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'aol.com', 'icloud.com', 'outlook.com',
  'comcast.net', 'me.com', 'msn.com', 'sbcglobal.net', 'att.net', 'live.com',
  'ymail.com', 'hmail.com', 'protonmail.com', 'proton.me', 'mac.com', 'verizon.net',
]);

function domainOf(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const dom = email.slice(at + 1).trim().toLowerCase();
  return dom.includes('.') ? dom : null;
}

/**
 * @param {object} facts { email, corporateEventCount, personalEventCount,
 *                         largestGuestCount, venueName }
 * @returns {{tag: string, reason: string} | null}
 */
function suggestTag(facts) {
  const f = facts || {};
  const {
    email,
    corporateEventCount = 0,
    personalEventCount = 0,
    largestGuestCount = null,
    venueName = null,
  } = f;

  const dom = domainOf(email);
  if (!dom) return null;
  const isCompanyDomain = !FREE_MAIL.has(dom);

  if (corporateEventCount > 0) {
    // "Booked" is literal: the caller counts only events actually paid for.
    // Counting quotes here asserted a booking that never happened for two
    // thirds of the contacts this screen suggests on.
    const bits = [corporateEventCount === 1
      ? 'Booked a corporate event before'
      : `Booked ${corporateEventCount} corporate events before`];
    if (largestGuestCount) bits.push(`largest was ${largestGuestCount} guests`);
    if (venueName) bits.push(`at ${venueName}`);
    if (!isCompanyDomain) bits.push('on a personal address, which is common');
    return { tag: 'corporate', reason: `${bits.join(', ')}.` };
  }

  // A company domain with only personal events is the false positive the
  // numbers warn about (19 of 25). Say nothing rather than guess wrong.
  if (personalEventCount > 0) return null;

  if (isCompanyDomain) {
    return {
      tag: 'corporate',
      reason: `Uses a company address (${dom}), but nothing booked yet, so this is a guess.`,
    };
  }

  return null;
}

module.exports = { suggestTag, domainOf, FREE_MAIL };
