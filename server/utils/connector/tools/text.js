'use strict';

// The text rules every connector tool applies (spec 2026-11-19 laws 3 and 7, section 7.6): free text is client-written unless the business provably wrote it, screened then stripped; no contact details in list tools.
//
// Every piece of text a tool returns is screened, whoever wrote it (fix
// rounds 1 and 2): a Thumbtack draft writes the lead's own words into a
// proposal's notes, the public quote wizard stores the email, phone and start
// time as typed, the Inbox AI's close reason and promise line are written
// with the client's words in view, and the business's own templates fill a
// custom event type, a first name or a location into the subjects and texts
// it sends. So client-written text goes through guard.client, and what the
// business sent and the system lines go through guard.screened, which runs
// the same screen and strip and says whether the text came out clean: the
// tool keeps a business_* name only then, and otherwise sends it under a
// client_written_* name with its tier handled. guard.business (the link strip
// alone) is left for fixed wording the code itself writes.
//
// createTextGuard() is one per tool call. guard.client(text, { record, ref,
// open }) screens the raw text (screenClientText), and its word reads
// (wordReads: each run of punctuation read as a space, with and without the
// $, ! and | the screen reads as letters), first: a withhold-tier
// match returns "withheld, read it in the OS (<record>)" in its place and is
// kept for the withheld log row and the owner's digest; a flag-tier match
// returns FLAG_NOTICE in front of the stripped text and is kept for the
// call's own row (unless opts.noFlag: the history check shows none of what
// it reads); anything else comes back with its destinations stripped
// (stripDestinations). guard.time returns a time as typed and anything else
// as client text. guard.email returns an email field as typed only when it
// is one or more ordinary addresses (ordinary characters in the local part
// and the host), after screening it as typed, as words, the local parts read
// together, each local part alone, each leading run of host labels alone and
// the addresses read in order as one sentence (the name first);
// a name before one pair of angle brackets is screened with the whole field
// first, then read together with the local parts and with each local part
// and run of host labels, and a flagged name marks the address; any other
// email field is client text, the strip marking its addresses. guard.phone returns the
// number a phone field leads with and screens the remainder: ordinary
// contact data is never withheld for its shape alone. The guards are read
// from the tools' deps, so a suite can stub the screen.
//
// One piece, one ref: the withheld ref is what the text is about (refs
// below, the same in every tool) plus a short hash of the raw text, so the
// same words are logged and emailed once whichever tool met them, and new
// words under the same subject are a new piece. `open` names what the owner
// can open to read it ({ label, path } under the admin app), for the digest.
//
// noContact(text), listName and guardedName are the list tools' rule (guard
// 3): no phone number and no email address in a list result. A phone is 10
// digits (optionally led by +1) or 7, in 3-3-4 or 3-4 groups, or a + and 8
// to 15 digits, with phone separators (dashes and bullets among them); a
// round two-number range near a currency sign or a budget, price or cost
// word, a compact time range, a date and side-by-side years are not. personRef(key)
// hides the phone number a p- person key carries: n- and 16 letters of an
// HMAC under a key made fresh in each process, which Thread resolves against
// the current Waiting on you list; refs last until the server restarts.
// logKey(key) is the form a person key takes in the call log: a p- key as a
// plain hash, never its digits.

const crypto = require('node:crypto');
const { FLAG_NOTICE } = require('../textGuards');
const { getToolDeps } = require('./deps');

const WITHHELD_TEXT = 'withheld, read it in the OS';
const MAX_TEXT = 4000;
const REF_KEY = crypto.randomBytes(32);

function hash16(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

/** The key the call log keeps: a p- key as a plain hash, never its digits. */
function logKey(key) {
  return typeof key === 'string' && key.startsWith('p-') ? `p#${hash16(key)}` : key;
}

// The subject half of a withheld ref, one spelling per subject in every tool.
const refs = Object.freeze({
  clientName: (clientId) => `name:c-${clientId}`,
  personName: (key) => `name:${logKey(key)}`,
  staffName: (userId) => `name:s-${userId}`,
  bookingName: (proposalId) => `name:proposal:${proposalId}`,
  shiftName: (shiftId) => `name:shift:${shiftId}`,
  onProposal: (field, proposalId) => `${field}:proposal:${proposalId}`,
  onShift: (field, shiftId) => `${field}:shift:${shiftId}`,
  onClient: (field, clientId) => `${field}:c-${clientId}`,
  message: (ref) => `msg:${ref}`,
  need: (key) => `need:${logKey(key)}`,
});

// A time of day as people type one: 6pm, 6:30 PM, 18:00, 6 p.m.
const TIME_RE = /^(?:[01]?\d|2[0-3])(?::[0-5]\d){0,2}\s?(?:[ap]\.?m\.?)?$/i;
// One ordinary address: the local part's and the host's ordinary characters only.
const LOCAL_OK_RE = /^[A-Za-z0-9._+'-]{1,64}$/;
const HOST_OK_RE = /^[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
function ordinaryAddress(a) {
  const at = a.lastIndexOf('@');
  return at > 0 && a.indexOf('@') === at && LOCAL_OK_RE.test(a.slice(0, at)) && HOST_OK_RE.test(a.slice(at + 1));
}
// The number a phone field leads with (an extension or a word may follow).
const LEADING_NUMBER_RE = /^\s*(\+?[\d\s().\-/]{7,30})/;

function createTextGuard() {
  const withheld = [];
  const flagged = [];
  const seen = new Set();
  const withhold = (raw, { record, ref, open } = {}, pattern = null) => {
    const label = String(record || 'record');
    const withheldRef = `${String(ref || label).slice(0, 100)}#${hash16(raw)}`;
    if (!seen.has(withheldRef)) {
      seen.add(withheldRef);
      withheld.push({ ref: withheldRef, record: label, pattern, open: open || null });
    }
    return `${WITHHELD_TEXT} (${label})`;
  };
  // The screen's verdict on one piece: { clean, text }. clean means neither
  // tier matched, and text is then the stripped text; otherwise text is the
  // withheld line or the flagged text. opts.noFlag screens without recording
  // a flag (the history check, which shows none of the text it reads).
  const screen = (text, opts = {}, also = []) => {
    const raw = typeof text === 'string' ? text : String(text);
    const d = getToolDeps();
    const verdicts = readsOf(raw, also).map((t) => d.screenClientText(t) || {});
    const hit = verdicts.find((v) => v.withheld);
    if (hit) return { clean: false, text: withhold(raw, opts, hit.pattern) };
    let shown = d.stripDestinations(raw);
    if (typeof shown !== 'string') shown = '';
    if (shown.length > MAX_TEXT) shown = `${shown.slice(0, MAX_TEXT)} [cut, read the rest in the OS]`;
    if (verdicts.some((v) => v.flagged)) {
      const label = String(opts.record || 'record');
      if (!opts.noFlag && !flagged.includes(label)) flagged.push(label);
      return { clean: false, text: `${FLAG_NOTICE} ${shown}` };
    }
    return { clean: true, text: shown };
  };
  const guard = {
    withheld,
    flagged,
    /** One piece of client-written text, screened then stripped. */
    client(text, opts = {}) {
      if (text === null || text === undefined) return null;
      if (text === '') return '';
      return screen(text, opts).text;
    },
    /**
     * Any other text a tool returns, whoever wrote it (a message the business
     * sent fills its template with client-typed fields): screened then
     * stripped all the same. { clean, text }: the caller keeps a business_*
     * name only when clean.
     */
    screened(text, opts = {}) {
      if (text === null || text === undefined) return { clean: true, text: null };
      if (text === '') return { clean: true, text: '' };
      return screen(text, opts);
    },
    /** A time of day as typed: returned when it reads as one, else client-written text. */
    time(value, opts = {}) {
      if (value === null || value === undefined || String(value).trim() === '') return null;
      const v = String(value).trim();
      return TIME_RE.test(v) ? v : guard.client(v, opts);
    },
    /**
     * A stored email field, judged by shape first. It is returned as typed
     * only when it is one ordinary address, or a list of them (commas,
     * semicolons, ampersands, slashes, pipes, spaces or the words and, or
     * between; one pair of angle brackets after a name and a closing period
     * dropped first): a local part of letters, digits, dots, underscores,
     * plus signs, hyphens and apostrophes, and a host of letters, digits,
     * hyphens and dots. Such a field is screened, as typed and through every
     * read (readsOf), under these forms: the whole field as words, the local
     * parts read together, each local part alone, each leading run of a
     * host's labels alone, and the addresses read in order as one sentence
     * (sentenceReads); any hit withholds it. With a name before the
     * bracket the whole field is screened first, also with the name read
     * together with the local parts and with each local part and each run of
     * its host's labels; a withheld or flagged name withholds or flags the
     * field, a flagged one with the address marked. Any other field (other
     * characters, a $ inside, a Unicode separator, an address mixed with
     * words) is client text: screened as typed and as words, with the strip
     * marking every address in it. The withheld ref is the field's ref and a
     * hash: no address is kept in a ref, a log row or a mark.
     */
    email(value, opts = {}) {
      if (value === null || value === undefined || String(value).trim() === '') return null;
      const v = String(value).trim();
      // One pair of angle brackets (a name before them, screened as client
      // text) and a closing period are dropped before the shape is judged.
      let field = v.replace(/\.$/, '');
      let name = '';
      const angled = /^([^<>]*)<([^<>]+)>$/.exec(field);
      if (angled) { name = angled[1].trim(); field = angled[2].trim(); }
      // The words and, or join addresses only as words of their own (a host may hold "-and-").
      const parts = field.split(/\s*[,;&/|]\s*|\s+(?:and|or)\s+|\s+/i).filter(Boolean);
      // Not ordinary: client text, screened as typed and as words, the strip marking every address.
      if (!parts.length || !parts.every(ordinaryAddress)) return screen(v, opts, [asWords(v)]).text;
      if (name) {
        // The whole field first (as typed, as words and through the word
        // reads), so a wording split across the bracket is read whole; a
        // flag there marks every address in it.
        // The name is read together with the list's local parts, and with each
        // local part followed by each leading run of that address's host
        // labels, so a sentence begun before the bracket and finished inside
        // it (the first word as the name, the rest in the host) is read whole.
        const locals = parts.map((a) => a.slice(0, a.lastIndexOf('@')));
        const joined = [asWords(`${name} ${locals.join(' ')}`)];
        for (const a of parts) {
          const at = a.lastIndexOf('@');
          const labels = a.slice(at + 1).split('.');
          for (let k = 1; k <= labels.length; k += 1) {
            joined.push(asWords(`${name} ${a.slice(0, at)} ${labels.slice(0, k).join(' ')}`));
            joined.push(asWords(`${name} ${labels.slice(0, k).join(' ')}`));
          }
        }
        const whole = screen(v, opts, [asWords(v), ...joined, ...sentenceReads(parts, name)]);
        if (!whole.clean) return whole.text;
        const shownName = guard.screened(name, opts);
        if (isWithheld(shownName.text)) return shownName.text;
        // Words before the bracket that are flagged: the address is marked too.
        if (!shownName.clean) return `${shownName.text} <[email]>`;
        const inner = guard.email(parts.join(', '), opts);
        return isWithheld(inner) ? inner : `${shownName.text} <${inner}>`;
      }
      // The local parts read together too: a sentence written one word per address.
      const forms = [asWords(v), asWords(parts.map((a) => a.slice(0, a.lastIndexOf('@'))).join(' '))];
      for (const a of parts) {
        const at = a.lastIndexOf('@');
        forms.push(asWords(a.slice(0, at)));
        const labels = a.slice(at + 1).split('.');
        for (let k = 1; k <= labels.length; k += 1) forms.push(asWords(labels.slice(0, k).join(' ')));
      }
      const r = screen(v, opts, [...forms, ...sentenceReads(parts)]);
      // A clean field is returned as typed (the strip would mark each address).
      return r.clean ? parts.join(', ') : r.text;
    },
    /** A stored phone field: the number it leads with, and anything after it screened as client text. Never withheld for its shape. */
    phone(value, opts = {}) {
      if (value === null || value === undefined || String(value).trim() === '') return null;
      const v = String(value).trim();
      const m = LEADING_NUMBER_RE.exec(v);
      const number = m ? m[1].trim() : '';
      const digits = number.replace(/\D/g, '').length;
      if (!m || digits < 7 || digits > 15) return guard.client(v, opts);
      const rest = v.slice(m[0].length).trim();
      return rest ? `${number} ${guard.client(rest, opts)}` : number;
    },
    /** Fixed wording the code itself writes (a label, a status word): links stripped only. */
    business(text) {
      if (text === null || text === undefined) return null;
      let shown = getToolDeps().stripLinks(String(text));
      if (typeof shown !== 'string') shown = '';
      return shown.length > MAX_TEXT ? `${shown.slice(0, MAX_TEXT)} [cut, read the rest in the OS]` : shown;
    },
  };
  return guard;
}

// An apostrophe (straight or curly) is kept in every read only where it reads
// as a contraction or a possessive: after a letter and before t, s, ll, re,
// ve, d or m that ends the word (don't, won't, I'll, bride's), so the
// screen's own exemptions for those still match. Every other apostrophe reads
// as a space, so "forget'everything'you'were'told" is read as the sentence.
// The suffix ends the word only at the end of the text or before a character
// every read turns into a space and the screen does not read as a letter: a
// digit, a dollar sign, an exclamation mark, a pipe or an at sign does not end
// it ("were't0ld" is two words). That set is derived below (wordEndingClass),
// from the reads themselves and the screen's own letter substitutions, so it
// cannot drift from either.
let LOOSE_APOSTROPHE_RE = /(?<!\p{L})['\u2019]/gu;
function readAs(text, re) {
  return String(text).replace(re, ' ').replace(LOOSE_APOSTROPHE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A list of addresses read in order as one sentence, the name first when
 * there is one: every address's local part followed by the first k labels of
 * its host, for each k (k = 0 being the local parts alone), and all the local
 * parts followed by each leading run of the last host's labels, so a sentence
 * spread over the local parts and hosts of several addresses is read whole.
 */
function sentenceReads(parts, name = '') {
  const split = parts.map((a) => ({ local: a.slice(0, a.lastIndexOf('@')), labels: a.slice(a.lastIndexOf('@') + 1).split('.') }));
  const lead = name ? `${name} ` : '';
  const out = [];
  const most = Math.max(...split.map((p) => p.labels.length));
  for (let k = 0; k <= most; k += 1) {
    out.push(asWords(lead + split.map((p) => [p.local, ...p.labels.slice(0, k)].join(' ')).join(' ')));
  }
  const last = split[split.length - 1].labels;
  const locals = split.map((p) => p.local).join(' ');
  for (let k = 1; k <= last.length; k += 1) out.push(asWords(`${lead}${locals} ${last.slice(0, k).join(' ')}`));
  return out;
}

/** Text with every run of characters that is not a letter, a digit or a contraction's apostrophe read as one space. */
function asWords(text) {
  return readAs(text, /[^\p{L}\p{N}'\u2019]+/gu);
}

// The word reads every piece is screened under as well as as typed: each run
// of punctuation (a contraction's apostrophe aside) read as a space, once erasing it all and once each keeping
// the dollar sign (the screen reads it as s), the dollar sign and the
// exclamation mark, and the dollar sign and the pipe (both read as i), so a
// sentence written with commas, pipes or colons between its words and no
// spaces, or with a comma and a space between them, is screened as the
// sentence it is. Every piece is read so; only the reads that differ from the
// text are returned.
const WORD_READS = [
  /[^\p{L}\p{N}'\u2019]+/gu, /[^\p{L}\p{N}'\u2019$]+/gu, /[^\p{L}\p{N}'\u2019$!]+/gu, /[^\p{L}\p{N}'\u2019$|]+/gu,
];
// The ASCII punctuation that does NOT end a word after a contraction's
// suffix: any character some read keeps (the $, ! and | the screen reads as
// letters) and any the screen's leet view turns into a letter ("@" as a,
// digits are letters or numbers already). Probed once at load through the
// screen's own normalizer; if it cannot be probed, every punctuation mark is
// taken as not ending the word (fails closed: more apostrophes read as spaces).
function notWordEnding() {
  const all = [];
  for (let c = 0x21; c <= 0x7e; c += 1) {
    const ch = String.fromCharCode(c);
    if (!/[\p{L}\p{N}'\s]/u.test(ch)) all.push(ch);
  }
  let forms = null;
  try {
    const t = require('../textGuards').__test;
    if (t && typeof t.normalizedView === 'function' && typeof t.screeningForms === 'function') {
      forms = (s) => t.screeningForms(t.normalizedView(s, { tags: 'decode' }), s);
    }
  } catch (_) { forms = null; /* static-checks: allow swallowed-catch */ }
  if (!forms) return all;
  return all.filter((ch) => {
    const kept = WORD_READS.some((re) => `a${ch}b`.replace(re, ' ').includes(ch));
    const leet = forms(`ab${ch}cd`).leet;
    return kept || /^ab\p{L}cd$/u.test(leet);
  });
}
const escapeClass = (chars) => chars.map((ch) => `\\u{${ch.codePointAt(0).toString(16)}}`).join('');
LOOSE_APOSTROPHE_RE = new RegExp(
  `(?<!\\p{L})['\\u2019]|['\\u2019](?!(?:t|s|ll|re|ve|d|m)(?![\\p{L}\\p{N}${escapeClass(notWordEnding())}]))`, 'giu'
);

function wordReads(raw) {
  const out = [];
  for (const re of WORD_READS) {
    const t = readAs(raw, re);
    if (t && t !== raw && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Every read a piece is screened under, one list for the guard and the
 * digest label alike: the text as typed, any extra forms the caller adds,
 * and its word reads, each once.
 */
function readsOf(raw, also = []) {
  return [...new Set([raw, ...also, ...wordReads(raw)])];
}

/** True when the guard's answer is the withheld text. */
const isWithheld = (shown) => typeof shown === 'string' && shown.startsWith(WITHHELD_TEXT);

// A phone number in a list tool's text, read after NFKC so fullwidth digits
// count: 10 digits (3, 3, 4) optionally led by +1, or 7 (3, 4), or a + and 8
// to 15 digits (a number outside the plus one plan), with any of the
// separators people write between the groups (spaces, dots, hyphens, en and
// em dashes, non-breaking hyphens, bullets, slashes, underscores, commas,
// parentheses). Not a phone: a run inside a longer one; a true two-number
// range ("500-2000") after a currency sign or a budget, price or cost word
// with at most 30 characters of words between; a compact time range after
// from, until or between or before am or pm ("from 830-1130"); and a date or
// time after an international number, where the + shape stops. Dates and
// years side by side have no 3-digit group and never match.
const SEP_CHARS = '\\s._\\-/,\\u2010-\\u2015\\u2022\\u00b7\\u2027\\u2219';
const SEP = `[${SEP_CHARS}]*`;
// The +1 shape is tried before the general + shape, so an 11-digit number
// stops at its end and a count, date or time after it stays.
const PHONE_RE = new RegExp(
  `(?<![\\d+])(?:\\+?1${SEP})?\\(?\\d{3}\\)?${SEP}\\d{3}${SEP}\\d{4}(?![\\d])`
  + `|\\+\\d(?:[${SEP_CHARS}()]*\\d){7,14}(?![\\d])`
  + `|(?<![\\d+])\\d{3}${SEP}\\d{4}(?![\\d])`, 'g'
);
// A true two-number range: one to five digits, a hyphen, a dash or "to", one
// to five digits, the second larger. A 3-then-4 run is a phone's shape, so it
// is a range only when it reads as round figures (the first ending in 0, the
// second in 00: "800-1200"); "Price 312-5550100" or "price 248-7391" is a phone.
const RANGE_RE = /^(\d{1,5})\s*(?:[-\u2010-\u2015]|to)\s*(\d{1,5})$/i;
// A currency sign, or a budget, price or cost word, before the range with up
// to 30 characters of words between and no digit or line break ("Budget will
// be 500-1000"). The round-figures test above still applies, so a 3-then-4
// range whose figures are not round ("Budget: 750-1250") is masked, the safe
// direction, and a 7-digit phone after a price question stays masked
// ("price? Call 555-0123").
const MONEY_BEFORE_RE = /(?:[$€£]|\b(?:budget|price|cost)s?\b)[^\d\n]{0,30}$/iu;
const EMAIL_RE = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[A-Za-z]{2,}/g;

function moneyRange(run, before) {
  const m = RANGE_RE.exec(run.trim());
  if (!m || !(Number(m[2]) > Number(m[1]))) return false;
  const phoneShape = m[1].length === 3 && m[2].length === 4;
  if (phoneShape && !(m[1].endsWith('0') && m[2].endsWith('00'))) return false;
  return MONEY_BEFORE_RE.test(before);
}

// A token that reads as a date or a time ("6/14", "6.14.27", "5-10" before
// am or pm): the general + shape stops before it, as the +1 shape does at its
// last group, so a date or time after an international number stays.
const DATE_TOKEN_RE = /^\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?$/;
const TIME_TOKEN_RE = /^\d{1,2}(?::\d{2})?\s*[-\u2010-\u2015]\s*\d{1,2}(?::\d{2})?$/;
const AMPM_AFTER_RE = /^\s?[ap]\.?m\b/i;

function plusPhone(run, after) {
  const tokens = run.split(/(\s+)/);
  let kept = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (i > 0 && /\S/.test(tok)) {
      const last = i === tokens.length - 1;
      if (DATE_TOKEN_RE.test(tok) || (TIME_TOKEN_RE.test(tok) && last && AMPM_AFTER_RE.test(after))) {
        const number = kept.trimEnd();
        // Under 8 digits before the date token: the token is part of the
        // number ("+44 20/79 46 09 58"), so the whole run is the marker.
        if (number.replace(/\D/g, '').length < 8) return '[phone]';
        return `[phone]${run.slice(number.length)}`;
      }
    }
    kept += tok;
  }
  return '[phone]';
}

// A 3-then-4 run that reads as a time range ("from 830-1130", "730-1130pm"):
// right after from, until, till or between, or right before am or pm, with
// both halves a clock time on a quarter hour and the end later than the start.
const TIME_WORD_BEFORE_RE = /\b(?:from|until|till|between)\s*$/i;
function timeRange(run, before, after) {
  const m = /^(\d)(\d{2})\s*[-\u2010-\u2015]\s*(\d{2})(\d{2})$/.exec(run.trim());
  if (!m) return false;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  // Both halves end on a quarter hour, as service hours are written: a
  // 7-digit phone rarely does ("from 555-1234" stays a phone).
  const quarter = (n) => n === 0 || n === 15 || n === 30 || n === 45;
  if (!quarter(m1) || !quarter(m2) || h2 > 23 || !(h2 * 60 + m2 > h1 * 60 + m1)) return false;
  return TIME_WORD_BEFORE_RE.test(before) || AMPM_AFTER_RE.test(after);
}

/** Text (NFKC) with any phone number or email address left in it replaced by a marker. */
function noContact(text) {
  if (text === null || text === undefined) return text;
  return String(text).normalize('NFKC').replace(EMAIL_RE, '[email]').replace(PHONE_RE, (run, offset, whole) => {
    const before = whole.slice(Math.max(0, offset - 50), offset);
    const after = whole.slice(offset + run.length, offset + run.length + 6);
    if (moneyRange(run, before)) return run;
    if (timeRange(run, before, after)) return run;
    if (run.startsWith('+') && !/^\+1\b|^\+1[\s.\-(]/.test(run)) return plusPhone(run, after);
    return '[phone]';
  });
}

function looksLikeContact(s) {
  const t = String(s || '').normalize('NFKC');
  return t.includes('@') || noContact(t) !== t;
}

/** A display name with no contact detail in it, else the fallback (judged on the name as stored). */
function listName(name, fallback) {
  if (name === null || name === undefined || String(name).trim() === '') return fallback;
  return looksLikeContact(name) ? fallback : String(name);
}

/**
 * A client-written name for a list: the fallback when the stored name is an
 * address or a number, else the name screened and stripped (guard.client)
 * with any contact detail left in it marked.
 */
function guardedName(guard, name, fallback, opts) {
  if (name === null || name === undefined || String(name).trim() === '' || looksLikeContact(name)) return fallback;
  const shown = noContact(guard.client(String(name), opts));
  return shown === '' ? fallback : shown;
}

/**
 * A name fit to put in the owner's email: the name when it screens clean
 * under every read the guard uses (as typed, as words, the punctuation-as-
 * spaces reads) and carries no destination or contact detail, else the
 * fallback. The owner's
 * mailbox is itself read by Claude, so a withheld or flagged name never goes
 * into it.
 */
function safeLabel(name, fallback) {
  if (name === null || name === undefined || String(name).trim() === '') return fallback;
  const d = getToolDeps();
  const raw = String(name);
  // The guard's own reads (readsOf, the one helper screen uses): as typed, as words, the punctuation-as-spaces reads.
  const verdicts = readsOf(raw, [asWords(raw)]).map((t) => d.screenClientText(t) || {});
  if (verdicts.some((v) => v.withheld || v.flagged)) return fallback;
  if (d.stripDestinations(raw) !== raw || looksLikeContact(raw)) return fallback;
  return raw.length > 80 ? fallback : raw;
}

// 16 letters a to p (the HMAC's hex, each digit moved to a letter), so a ref
// never holds a run of digits that reads as a number.
function hmac16(s) {
  return crypto.createHmac('sha256', REF_KEY).update(String(s)).digest('hex').slice(0, 16)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

const KIND_LABEL = Object.freeze({
  client: 'Client', lead: 'Lead', staff: 'Staff member', tt_lead: 'Thumbtack lead', zola_lead: 'Zola lead',
});
/** The label an Inbox person is shown by when their name cannot be. */
function personFallback(kind, key) {
  if (KIND_LABEL[kind]) return KIND_LABEL[kind];
  if (String(key).startsWith('e-')) return 'Unknown sender';
  if (String(key).startsWith('p-')) return 'Unknown number';
  return 'Unknown';
}

/** The key a result shows: a p- key as its n- ref, any other key as it is. */
function personRef(key) {
  return typeof key === 'string' && key.startsWith('p-') ? `n-${hmac16(key)}` : key;
}

/** The admin Inbox path for a person (an unknown number opens the Inbox itself: no digits in a link). */
function inboxPath(key) {
  return typeof key === 'string' && !key.startsWith('p-') ? `/inbox/${key}` : '/inbox';
}

module.exports = {
  WITHHELD_TEXT, MAX_TEXT, refs, createTextGuard, isWithheld, noContact, listName, guardedName, safeLabel,
  looksLikeContact, personRef, logKey, personFallback, inboxPath,
};
