'use strict';

// The person's own words out of one Gmail message (spec
// docs/superpowers/specs/2026-10-14-inbox-email-zola-design.md, section 5.7).
// Pure: no I/O. The sync stores what this returns and nothing more: never the
// raw mail, never an attachment, never the quoted history (decision 16).
//
// `payload` is Gmail's message.payload: a tree of parts, each with mimeType,
// filename ('' when none), headers [{ name, value }] and body.data (base64url).
//
// Every pass here is linear in its input. Mail is hostile input read inside
// the Express process, and a pattern that rescans from each '<' (the old
// /<[^>]*>/) turned a megabyte of '<' into minutes of blocked event loop
// (security and performance review, 2026-10-15). A pattern that has to find a
// closing token is an indexOf or a forward-only scan, never a lazy [\s\S]*?.

// Stored text is capped here (spec 5.7).
const MAIL_TEXT_MAX = 20000;
// A bound on the decoded source before any pattern runs. Far past any human
// mail body (the result keeps at most MAIL_TEXT_MAX of its start); it bounds
// what the linear passes below can cost.
const MAIL_SOURCE_MAX = 1000000;
// HTML is converted from its first 256 KB only: Gmail itself clips a message
// at about 100 KB of HTML, and the words we keep sit at the start.
const HTML_SOURCE_MAX = 262144;
// The base64url characters that can hold MAIL_SOURCE_MAX characters (four
// UTF-8 bytes at most each), so a huge part is never decoded whole.
const BODY_DATA_MAX = Math.ceil((MAIL_SOURCE_MAX * 4) / 3) * 4;
const MAX_PART_DEPTH = 20;

// A trailing contact block (spec 5.7): at most this many lines, each shorter
// than SIG_LINE_MAX characters.
const SIG_BLOCK_MAX_LINES = 6;
const SIG_LINE_MAX = 60;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
// The redactor's phone shape (aiRedact.js DIGIT_RUN): digits with spaces,
// dots, dashes or parentheses between them; a run of 7 or more digits is a
// phone, card or account number.
const DIGIT_RUN_RE = /\+?\(?\d(?:[\d\s()\-‐-―−]|\.(?=\d))*\d/g;
// ...unless the run is a date: 2026-12-12, 12-12-2026, 12.12.2026. A slashed
// date never forms one run.
const DATE_RUN_RE = /^(\d{1,4})[-.‐-―−](\d{1,2})[-.‐-―−](\d{1,4})$/;

// Reply headers that open quoted history (spec 5.7): Gmail and Apple ("On
// <date>, <someone> wrote:", which a client may wrap onto a second line),
// then Outlook's "From: / Sent:" block (with the plain-text rule Outlook draws
// above it) and the older "Original Message" rule.
const ON_WROTE_RES = [
  /^On .{3,120} wrote:[ \t]*$/m,
  /^On .{3,120}\n.{0,80}\bwrote:[ \t]*$/m,
];
const FORWARD_HEADER_RES = [
  /^-----Original Message-----/m,
  /^From: .+\n(?:Sent|Date): .+/m,
  /^_{10,}[ \t]*\nFrom: .+\n(?:Sent|Date): .+/m,
];
// The signature delimiter is "-- " (RFC 3676). htmlToText trims every line,
// which turns an HTML mail's "-- " into "--", so only HTML-derived text takes
// the space as optional. In plain text a bare "--" cuts only over a signature
// (bareDelimiterCut); anywhere else it is someone's separator.
const SIG_DELIMITER_RE = /^-- $/m;
const HTML_SIG_DELIMITER_RE = /^-- ?$/m;
const DEVICE_LINE_RE = /^Sent from my .+$/m;
// A sign-off line: one of these phrases, alone or followed by punctuation and
// a name ("Thanks, Pat", "Best -Pat", "Cheers - The Example Team"). "Sent from
// my ..." is one too, but DEVICE_LINE_RE has cut from it already.
const SIGN_OFFS = new Set([
  'thanks', 'thank you', 'thanks again', 'thank you again', 'thanks so much', 'thank you so much', 'thanks very much',
  'thank you very much', 'thanks a lot', 'many thanks', 'thx', 'best', 'best wishes', 'best regards', 'all the best',
  'regards', 'kind regards', 'warm regards', 'warmest regards', 'warmly', 'warm wishes', 'cheers', 'sincerely',
  'respectfully', 'yours', 'yours truly', 'love', 'all best', 'with thanks', 'take care', 'talk soon',
]);

const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
]);

const hasWords = (s) => /[\p{L}\p{N}]/u.test(s);
const normalizeNewlines = (s) => String(s).replace(/\r\n?/g, '\n');
// ASCII letters only: String#toLowerCase can change a string's length
// (U+0130 becomes two code units), and the scans below index a lowercased copy
// and the source alike.
const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

function headerOf(part, name) {
  const headers = Array.isArray(part && part.headers) ? part.headers : [];
  const want = name.toLowerCase();
  const hit = headers.find((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === want);
  return hit && typeof hit.value === 'string' ? hit.value : '';
}

const mimeOf = (part) => String((part && part.mimeType) || '').toLowerCase();

// A part with a filename or an attachment disposition, inline images included
// (spec 5.7).
function isAttachment(part) {
  if (typeof part.filename === 'string' && part.filename.trim() !== '') return true;
  return /^\s*attachment\b/i.test(headerOf(part, 'Content-Disposition'));
}

// Depth first, in order. An attachment is one leaf even when Gmail shows its
// insides (an attached message), so its parts are never read or counted.
function collectLeaves(part, out, depth) {
  if (!part || typeof part !== 'object' || depth > MAX_PART_DEPTH) return;
  const kids = Array.isArray(part.parts) ? part.parts : [];
  if (kids.length > 0 && !isAttachment(part)) {
    for (const kid of kids) collectLeaves(kid, out, depth + 1);
    return;
  }
  if (mimeOf(part).startsWith('multipart/')) return;
  out.push(part);
}

function decodeBody(part) {
  const data = part.body && part.body.data;
  if (typeof data !== 'string' || data === '') return '';
  const bytes = Buffer.from(data.slice(0, BODY_DATA_MAX), 'base64url');
  const charset = (/charset\s*=\s*"?([^";\s]+)/i.exec(headerOf(part, 'Content-Type')) || [])[1];
  let text;
  try {
    text = new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    text = bytes.toString('utf8');
  }
  return normalizeNewlines(text.slice(0, MAIL_SOURCE_MAX));
}

function decodeEntities(s) {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{1,32});/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES.get(name.toLowerCase());
    return named === undefined ? match : named;
  });
}

// `source` minus the [start, end) ranges, which are in order and disjoint.
function withoutRanges(source, ranges) {
  if (ranges.length === 0) return source;
  let out = '';
  let kept = 0;
  for (const [start, end] of ranges) {
    out += source.slice(kept, start);
    kept = end;
  }
  return out + source.slice(kept);
}

// Comments and the elements whose content is never shown, in one forward scan
// of a lowercased copy. A comment or element that never closes runs to the
// end of the source, as it does in a browser, so it cuts the rest once; a
// closing token searched for and missing is never searched for again. A head
// with no end tag (the tag is optional) ends at the body; with no body either,
// only the head tag goes and the scan reads on, so the words after it stay
// (a browser shows them too) and what the head holds that hides still hides.
const HIDDEN_OPEN_RE = /<!--|<(style|script|head|title)\b[^<>]*>/g;
const HIDDEN_CLOSE_RES = new Map([
  ['style', /<\/style\s*>/g], ['script', /<\/script\s*>/g], ['head', /<\/head\s*>/g], ['title', /<\/title\s*>/g],
]);
const BODY_OPEN_RE = /<body\b/g;

// Where the hidden run opened by `m` ends, or -1 for the end of the source.
function hiddenEnd(low, m, missing) {
  const from = m.index + m[0].length;
  if (m[0] === '<!--') {
    const close = low.indexOf('-->', from);
    return close === -1 ? -1 : close + 3;
  }
  const name = m[1];
  if (!missing.has(name)) {
    const re = HIDDEN_CLOSE_RES.get(name);
    re.lastIndex = from;
    const close = re.exec(low);
    if (close) return close.index + close[0].length;
    missing.add(name);
  }
  if (name === 'head') {
    if (!missing.has('body')) {
      BODY_OPEN_RE.lastIndex = from;
      const body = BODY_OPEN_RE.exec(low);
      if (body) return body.index;
      missing.add('body');
    }
    return from;
  }
  return -1;
}

function dropHidden(s) {
  const low = asciiLower(s);
  const ranges = [];
  const missing = new Set();
  HIDDEN_OPEN_RE.lastIndex = 0;
  for (let m = HIDDEN_OPEN_RE.exec(low); m; m = HIDDEN_OPEN_RE.exec(low)) {
    const end = hiddenEnd(low, m, missing);
    ranges.push([m.index, end === -1 ? s.length : end]);
    if (end === -1) break;
    HIDDEN_OPEN_RE.lastIndex = end;
  }
  return withoutRanges(s, ranges);
}

// Every <blockquote> with its content, nested ones inside it included, in one
// forward scan that pairs openers and closers on a stack. An opener that never
// closes is left to the tag stripper with its words kept; a stray closer is
// only a tag.
const BLOCKQUOTE_TAG_RE = /<blockquote\b[^<>]*>|<\/blockquote\s*>/g;

function dropBlockquotes(s) {
  const low = asciiLower(s);
  const open = [];
  const ranges = [];
  BLOCKQUOTE_TAG_RE.lastIndex = 0;
  for (let m = BLOCKQUOTE_TAG_RE.exec(low); m; m = BLOCKQUOTE_TAG_RE.exec(low)) {
    if (m[0].charAt(1) !== '/') {
      open.push(m.index);
    } else if (open.length > 0) {
      const start = open.pop();
      // A quote closed inside this one is part of it.
      while (ranges.length > 0 && ranges[ranges.length - 1][0] > start) ranges.pop();
      ranges.push([start, m.index + m[0].length]);
    }
  }
  return withoutRanges(s, ranges);
}

function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return '';
  let s = html.slice(0, HTML_SOURCE_MAX);
  if (s.length < html.length) {
    // A tag the bound cut in half is not text.
    const lt = s.lastIndexOf('<');
    if (lt > s.lastIndexOf('>')) s = s.slice(0, lt);
  }
  s = dropBlockquotes(dropHidden(s))
    // Source whitespace is one space in HTML; the line breaks come from tags.
    .replace(/[ \t\r\n\f]+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^<>]*>/gi, '\n')
    // A paragraph ends with a blank line, so the signature rule can see the
    // block a paragraph forms.
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/(?:div|li|tr|h[1-6])\s*>/gi, '\n')
    // [^<>], not [^>]: a stray '<' fails at the next '<' instead of scanning
    // to the end of the source from every one of them.
    .replace(/<[^<>]*>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The earliest match of any pattern, as { index, end }, or null.
function firstMatch(res, s) {
  let best = null;
  for (const re of res) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.index)) best = { index: m.index, end: m.index + m[0].length };
  }
  return best;
}

// A trailing run of "> " lines and the blank lines around them.
function dropTrailingQuote(s) {
  const lines = s.split('\n');
  let end = lines.length;
  while (end > 0 && (/^>/.test(lines[end - 1]) || lines[end - 1].trim() === '')) end -= 1;
  return lines.slice(0, end).join('\n').trim();
}

// Everything from the first reply header on, then a trailing run of quoted
// lines. When that leaves no words, the header was "On ... wrote:" and a ">"
// line follows it, the reply is bottom-posted or inline: their words are the
// lines between and after the quoted ones, so those are kept, without the
// header, without a quoted line, and still cut at the next header below.
function stripQuotes(text) {
  const s = normalizeNewlines(text || '');
  const onWrote = firstMatch(ON_WROTE_RES, s);
  const forward = firstMatch(FORWARD_HEADER_RES, s);
  const cut = onWrote && (!forward || onWrote.index < forward.index) ? onWrote : forward;
  const kept = dropTrailingQuote(cut ? s.slice(0, cut.index) : s);
  if (hasWords(kept) || cut !== onWrote || !onWrote) return kept;
  // Only a quote marked with ">": a client that does not mark its quotes
  // leaves our own history under the header, never their reply.
  const after = s.slice(onWrote.end).split('\n').find((line) => line.trim() !== '');
  if (!after || !after.startsWith('>')) return kept;
  let rest = s.slice(0, onWrote.index) + s.slice(onWrote.end);
  const below = firstMatch([...ON_WROTE_RES, ...FORWARD_HEADER_RES], rest);
  if (below) rest = rest.slice(0, below.index);
  const words = rest.split('\n').filter((line) => !/^>/.test(line)).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return hasWords(words) ? words : kept;
}

// Year first (2026-12-12), or month and day either way round with a two- or
// four-digit year (12-12-2026, 31.12.26).
function isDate(run) {
  const m = DATE_RUN_RE.exec(run);
  if (!m) return false;
  const [a, b, c] = [m[1], m[2], m[3]].map(Number);
  const inRange = (n, max) => n >= 1 && n <= max;
  if (m[1].length === 4) return m[3].length <= 2 && inRange(b, 12) && inRange(c, 31);
  if (m[1].length > 2 || (m[3].length !== 2 && m[3].length !== 4)) return false;
  return inRange(a, 31) && inRange(b, 31) && Math.min(a, b) <= 12;
}

function hasContact(line) {
  if (line.match(EMAIL_RE) || line.match(URL_RE)) return true;
  return (line.match(DIGIT_RUN_RE) || []).some((run) => !isDate(run) && run.replace(/\D/g, '').length >= 7);
}

// A line that reads like the person talking, not a signature: once its
// contact tokens are gone, two or more lowercase words ("call me at", "we'd
// love a quote"), or a question or exclamation. Signature lines are names,
// titles and labels ("Pat Example", "Events Lead", "Cell:").
function readsLikeASentence(line) {
  const rest = line.replace(EMAIL_RE, ' ').replace(URL_RE, ' ').replace(DIGIT_RUN_RE, ' ').trim();
  if (/[?!]$/.test(rest)) return true;
  return rest.split(/\s+/).filter((word) => /^[a-z]/.test(word)).length >= 2;
}

// A tail after the phrase is a name: one word, or up to three capitalized
// ones. "Thanks, we will see you then" is a sentence, not a sign-off.
function isSignOff(line) {
  const s = line.trim();
  if (s.length >= SIG_LINE_MAX) return false;
  // The words before the first punctuation, and what follows it.
  const cut = s.search(/[,.!-]/);
  const phrase = cut === -1 ? s : s.slice(0, cut);
  if (!SIGN_OFFS.has(phrase.trim().toLowerCase().replace(/\s+/g, ' '))) return false;
  const tail = cut === -1 ? '' : s.slice(cut).replace(/^[,.!-]+/, '').replace(/[,.!]/g, ' ').trim();
  if (tail === '') return true;
  const words = tail.split(/\s+/);
  return words.length === 1 || (words.length <= 3 && words.every((w) => /^\p{Lu}/u.test(w)));
}

// The sender's name words, lowercased ("Example, Pat" gives example, pat).
const nameWordsOf = (name) => String(name || '').toLowerCase().split(/[^\p{L}'-]+/u).filter((w) => w.length >= 2);

// The mail's own name line: the first word is one of the sender's name words
// ("Pat", "- pat", "Pat Example | Events"). With no display name to compare,
// a short line of capitalized words reads as a name.
function isNameLine(line, senderName) {
  const s = line.replace(/^[\s\-‐-―~]+/, '').replace(/[\s,.]+$/, '');
  if (s === '' || /[@\d]/.test(s)) return false;
  const words = s.split(/\s+/);
  const own = nameWordsOf(senderName);
  if (own.length > 0) return own.includes(words[0].toLowerCase().replace(/[^\p{L}'-]+/gu, ''));
  return words.length <= 4 && words.every((w) => /^\p{Lu}[\p{L}'.-]*$/u.test(w));
}

// The last paragraph, when it is a short contact block: at most six lines,
// each under 60 characters, one of them an address, a link or a phone, none
// of them a sentence (bar a sign-off opening it), and opened by a sign-off or
// the sender's own name, on its first line or the line above it. Without that
// opening, or under a line that ends in ":", an address or a number at the
// end is the person's words ("send the invoice here instead", followed by the
// address).
function cutContactBlock(s, senderName) {
  const lines = s.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1;
  const block = lines.slice(start, end).map((line) => line.trim());
  if (block.length === 0 || block.length > SIG_BLOCK_MAX_LINES) return s;
  if (!block.every((line) => line.length < SIG_LINE_MAX)) return s;
  const opensWithSignOff = isSignOff(block[0]);
  const body = opensWithSignOff ? block.slice(1) : block;
  if (!block.some(hasContact) || body.some(readsLikeASentence)) return s;
  let above = start - 1;
  while (above >= 0 && lines.at(above).trim() === '') above -= 1;
  // "Here are our details:" introduces the block; it is what they sent.
  if (above >= 0 && lines.at(above).trim().endsWith(':')) return s;
  const opened = opensWithSignOff || isNameLine(block[0], senderName) || (above >= 0 && isSignOff(lines.at(above)));
  return opened ? lines.slice(0, start).join('\n') : s;
}

// What follows a bare "--" to the end, as its trimmed lines with words, is a
// signature: at most six lines, each under 60 characters, none of them a
// sentence (bar a sign-off opening them), and opened by a sign-off or the
// sender's own name line, as cutContactBlock requires. A contact line alone
// is never a signature (code review 2026-10-15): an address, a phone, a link
// or a code under a "--" is what they sent ("send the invoice to our accounts
// team instead", then the address). Nothing at all (a dangling "--") holds no
// words to lose.
function isSignatureTail(tail, senderName) {
  if (tail.length === 0) return true;
  if (tail.length > SIG_BLOCK_MAX_LINES || !tail.every((line) => line.length < SIG_LINE_MAX)) return false;
  const opensWithSignOff = isSignOff(tail[0]);
  if ((opensWithSignOff ? tail.slice(1) : tail).some(readsLikeASentence)) return false;
  return opensWithSignOff || isNameLine(tail[0], senderName);
}

// Whether the nearest line with words above line i ends in ":" ("Menu
// ideas:" introduces what the "--" sets off; it is what they sent).
function introducedAbove(lines, i) {
  for (let j = i - 1; j >= 0; j -= 1) {
    const line = lines.at(j).trim();
    if (line !== '') return line.endsWith(':');
  }
  return false;
}

// Plain text cut at the first bare "--" line over a signature, or unchanged.
// A signature's tail holds at most six lines with words, so the scan walks
// back from the end through the last seven and no further: linear.
function bareDelimiterCut(s, senderName) {
  const lines = s.split('\n');
  const tail = [];
  let cut = -1;
  for (let i = lines.length - 1; i >= 0 && tail.length <= SIG_BLOCK_MAX_LINES; i -= 1) {
    const line = lines.at(i).trim();
    if (line === '') continue;
    if (line === '--' && isSignatureTail(tail, senderName) && !introducedAbove(lines, i)) cut = i;
    tail.unshift(line);
  }
  return cut === -1 ? s : lines.slice(0, cut).join('\n');
}

function stripSignature(text, { fromHtml = false, senderName = null } = {}) {
  let s = normalizeNewlines(text || '');
  for (const re of [fromHtml ? HTML_SIG_DELIMITER_RE : SIG_DELIMITER_RE, DEVICE_LINE_RE]) {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index);
  }
  if (!fromHtml) s = bareDelimiterCut(s, senderName);
  return cutContactBlock(s, senderName).trim();
}

// Cut on a code point, never inside a surrogate pair.
function capText(s) {
  if (s.length <= MAIL_TEXT_MAX) return s;
  const cut = s.slice(0, MAIL_TEXT_MAX);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The text, attachment count and calendar-only flag of one payload. senderName
 * is the From display name, which lets a signature that opens with it be cut.
 */
function extractText(payload, { senderName = null } = {}) {
  const leaves = [];
  collectLeaves(payload, leaves, 0);
  const attachments = leaves.filter(isAttachment).length;
  const hasCalendarOnly = leaves.length > 0 && leaves.every((p) => mimeOf(p) === 'text/calendar');

  const plainPart = leaves.find((p) => mimeOf(p) === 'text/plain' && !isAttachment(p));
  const htmlPart = leaves.find((p) => mimeOf(p) === 'text/html' && !isAttachment(p));
  // The plain part wins (spec 5.7); an empty plain alternative does not.
  let source = plainPart ? decodeBody(plainPart) : '';
  let fromHtml = false;
  if (source.trim() === '' && htmlPart) {
    source = htmlToText(decodeBody(htmlPart));
    fromHtml = true;
  }

  const quoted = stripQuotes(source);
  let text = stripSignature(quoted, { fromHtml, senderName });
  // A one-line reply that lives inside its signature is not lost: the quoted
  // history is still cut, the signature stays.
  if (text === '' && hasWords(quoted)) text = quoted;
  text = capText(text);
  return { text: text === '' ? null : text, attachments, hasCalendarOnly };
}

module.exports = { extractText, stripQuotes, stripSignature, htmlToText, MAIL_TEXT_MAX };
