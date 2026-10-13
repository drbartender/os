// What a message may still say once it leaves the OS for the AI read (spec
// 2026-10-06 section 6.2). Pure: no I/O.
//
// Order matters. Links and email addresses go first, so the digits inside a
// token URL or an address never become a half-redacted "[number]" fragment;
// digit runs next; the person's surname last, so the surname pass never sees
// the inside of a link or an address.
//
// The privacy page promises Anthropic gets messages "without your phone
// number, email address, or card and account numbers". This file is that
// promise. Short numbers (a guest count, a price, a time) stay on purpose:
// they are often what the person is asking about.

const { OPT_WORDS } = require('./constants');

// Spec 5.3's seven unambiguous opt words, from lane inbox-engine's constants
// (never restated here): a body that is exactly one of these is an opt-out or
// opt-in keyword and never a message, so it is left out of the slice. Matched
// the way detectOptKeyword matches (smsInbound.js): the whole body, trimmed,
// lowercased. The AMBIGUOUS words (cancel, end, quit, yes, help, info) are real
// inbound messages under 5.3 ("Cancel" about an event, "yes" to "want to lock
// it in?") and stay in the slice (spec amendment 5).
const SLICE_SKIP_WORDS = new Set(OPT_WORDS);

function isKeywordRow(text) {
  if (typeof text !== 'string') return false;
  return SLICE_SKIP_WORDS.has(text.trim().toLowerCase());
}

// Client links carry access tokens, so every link becomes [link]: scheme URLs,
// www. hosts, and a bare host followed by a path (drbartender.com/plan/...).
// A bare host with no path ("drbartender.com") carries no token and stays.
const SCHEME_URL = /\bhttps?:\/\/[^\s<>"]+/gi;
const WWW_URL = /\bwww\.[^\s<>"]+/gi;
// The old form backtracked super-linearly on a long run with no slash. Same matches: the
// run before the slash must end in two letters, and the lookbehind cannot reach past the dot.
const BARE_URL = /\b[A-Za-z0-9-]+\.[A-Za-z0-9.-]*(?<=[A-Za-z]{2})\/[^\s<>"]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LINK_TAIL = /[.,!?;:)\]}'"]+$/;

function linkReplacer(match) {
  const tail = match.match(LINK_TAIL);
  return tail ? `[link]${tail[0]}` : '[link]';
}

// Every run of 7 or more digits, with spaces, dots, dashes or parentheses
// between them, becomes [number]: phone numbers in any format, card, bank and
// routing numbers, SSNs. A leading "+" or "(" belongs to the number. "Dashes"
// includes the Unicode ones a pasted number can carry (U+2010 to U+2015, and
// the minus sign U+2212). A dot joins only when a digit follows it, so the
// period ending "call 312-555-0100. 2 kids" does not swallow the 2. A dashed
// or dotted full date ("10-20-2026", 8 digits) is such a run too, and reads as
// [number]; the read still sees the question around it.
const DIGIT_RUN = /\+?\(?\d(?:[\d\s()\-\u2010-\u2015\u2212]|\.(?=\d))*\d/g;

function digitReplacer(match) {
  return match.replace(/\D/g, '').length >= 7 ? '[number]' : match;
}

// Name handling: the person's first name stays, the rest of their name goes.
// Tokens that are never names (titles, suffixes, company and event words).
const NAME_NOISE = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'jr', 'sr', 'ii', 'iii', 'iv',
  'llc', 'inc', 'co', 'corp', 'corporation', 'company', 'ltd', 'the', 'and', 'of',
  'family', 'wedding', 'party', 'events', 'event', 'group', 'team', 'club',
]);
// Surnames that are also everyday words ("White wine", "I will", "Mason jar"):
// dropped only right after the first name ("Pat White" -> "Pat"), never
// standalone, so the read still sees "Do you have white wine?".
const COMMON_WORD_SURNAMES = new Set([
  'white', 'black', 'brown', 'green', 'gray', 'grey', 'young', 'king', 'hill',
  'wood', 'woods', 'hall', 'long', 'little', 'rose', 'may', 'will', 'best',
  'love', 'rich', 'price', 'bell', 'hope', 'grant', 'cook', 'baker', 'mason',
  'hunter', 'banks', 'field', 'fields', 'mills', 'park', 'lane', 'page', 'day',
  'knight', 'moon', 'rice', 'fox', 'wolf', 'bird', 'snow', 'frost', 'winter',
  'summer', 'stone', 'waters', 'burns', 'major', 'noble', 'sharp', 'strong',
  'short', 'sweet', 'wise', 'good', 'gold', 'silver', 'case', 'joy', 'hart',
  'cross', 'church', 'chase', 'grace', 'north', 'south', 'west', 'east',
  'marsh', 'brook', 'brooks', 'ward', 'rivers', 'lake', 'power', 'bush',
  'glass', 'hand', 'porter', 'pepper', 'lemon', 'berry', 'cherry', 'ginger',
  'sugar', 'honey', 'beer', 'wine', 'march', 'april', 'june', 'august',
]);

const normApos = (s) => s.replace(/\u2019/g, "'");
const lettersOf = (s) => (s.match(/\p{L}/gu) || []).length;

// A token from its first letter to the end of its last letter, in two linear
// scans. The alternation /^[^\p{L}]+|[^\p{L}]+$/gu did the same trim but
// rescanned a long inner run of non-letters from every position (quadratic).
function trimToLetters(token) {
  const first = token.search(/\p{L}/u);
  if (first < 0) return '';
  let end = first;
  for (const m of token.matchAll(/\p{L}/gu)) end = m.index + m[0].length;
  return token.slice(first, end);
}

/**
 * Split a display name into the first names to keep and the surnames to drop.
 * "Jordan & Casey Smithfield-Lee" keeps jordan and casey and drops
 * smithfield-lee, smithfield and lee. A one-word name drops nothing.
 */
function nameParts(personName) {
  const firstNames = new Set();
  const surnames = new Set();
  const commonSurnames = new Set();
  if (typeof personName !== 'string' || !personName.trim()) return { firstNames, surnames, commonSurnames };
  // NFKC, as redact() does to the text, so a name stored with a decomposed
  // accent still matches the composed text (and the other way round).
  const people = normApos(personName.normalize('NFKC')).split(/\s*(?:&|\+|\/|\band\b)\s*/i);
  const later = [];
  for (const person of people) {
    const tokens = person.split(/\s+/)
      .map((t) => trimToLetters(t).toLowerCase())
      .filter((t) => lettersOf(t) >= 2 && !NAME_NOISE.has(t));
    if (tokens.length === 0) continue;
    firstNames.add(tokens[0]);
    later.push(...tokens.slice(1));
  }
  for (const token of later) {
    for (const candidate of new Set([token, ...token.split(/[-']/)])) {
      if (lettersOf(candidate) < 2 || firstNames.has(candidate) || NAME_NOISE.has(candidate)) continue;
      if (COMMON_WORD_SURNAMES.has(candidate)) commonSurnames.add(candidate);
      else surnames.add(candidate);
    }
  }
  return { firstNames, surnames, commonSurnames };
}

// One word plus the horizontal space before it, so a dropped word takes its
// own leading space with it ("Jordan Smithfield, hi" -> "Jordan, hi"). The
// lookbehind starts a match only where a space run begins: without it, a long
// run before a non-letter was rescanned from every position inside it
// (quadratic). No match ever started inside a run, so the matches are the same.
const WORD_WITH_SPACE = /(?<![^\S\r\n])([^\S\r\n]*)(\p{L}[\p{L}\p{M}'\u2019-]*)/gu;

function dropSurnames(text, { firstNames, surnames, commonSurnames }) {
  if (surnames.size === 0 && commonSurnames.size === 0) return text;
  let prevWord = null;
  let prevEnd = -1;
  return text.replace(WORD_WITH_SPACE, (match, space, word, offset) => {
    const lower = normApos(word.toLowerCase());
    const possessive = /'s$/.test(lower);
    const base = possessive ? lower.slice(0, -2) : lower;
    const adjacent = offset === prevEnd && space.length > 0;
    const afterFirstName = adjacent && prevWord !== null && firstNames.has(prevWord);
    const capitalized = /^\p{Lu}/u.test(word);
    const drop = (surnames.has(base) && (capitalized || afterFirstName))
      || (commonSurnames.has(base) && afterFirstName);
    prevEnd = offset + match.length;
    if (!drop) {
      prevWord = base;
      return match;
    }
    // "Jordan Smithfield's order" -> "Jordan's order".
    return possessive && adjacent ? word.slice(-2) : '';
  });
}

function tidy(text) {
  return text
    .replace(/[^\S\r\n]{2,}/g, ' ')
    .replace(/^[^\S\r\n]+|[^\S\r\n]+$/gm, '');
}

/**
 * The text as it may leave the OS: links, addresses and long digit runs
 * replaced, the person's surname dropped. personName is the display name the
 * Inbox shows for the person (null for an unknown number).
 */
function redact(text, { personName } = {}) {
  if (typeof text !== 'string' || text === '') return '';
  // NFKC first: \d and the ASCII classes below would otherwise walk past a
  // fullwidth digit or letter. Addresses before www. hosts, so an address at
  // a www. host loses its local part too (the merge review, 2026-10-13).
  const placeheld = text.normalize('NFKC')
    .replace(SCHEME_URL, linkReplacer)
    .replace(EMAIL, '[email]')
    .replace(WWW_URL, linkReplacer)
    .replace(BARE_URL, linkReplacer)
    .replace(DIGIT_RUN, digitReplacer);
  return tidy(dropSurnames(placeheld, nameParts(personName)));
}

module.exports = {
  SLICE_SKIP_WORDS,
  COMMON_WORD_SURNAMES,
  isKeywordRow,
  nameParts,
  redact,
};
