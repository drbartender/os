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
// open }) screens the raw text (screenClientText) first: a withhold-tier
// match returns "withheld, read it in the OS (<record>)" in its place and is
// kept for the withheld log row and the owner's digest; a flag-tier match
// returns FLAG_NOTICE in front of the stripped text and is kept for the
// call's own row (unless opts.noFlag: the history check shows none of what
// it reads); anything else comes back with its destinations stripped
// (stripDestinations). guard.time returns a time as typed and anything else
// as client text. guard.email returns each address in an email field, each
// screened with its local part's separators read as spaces, and screens any
// remainder; guard.phone returns the number a phone field leads with and
// screens the remainder: ordinary contact data is never withheld for its
// shape alone. The guards are read from the tools' deps, so a suite can stub
// the screen.
//
// One piece, one ref: the withheld ref is what the text is about (refs
// below, the same in every tool) plus a short hash of the raw text, so the
// same words are logged and emailed once whichever tool met them, and new
// words under the same subject are a new piece. `open` names what the owner
// can open to read it ({ label, path } under the admin app), for the digest.
//
// noContact(text), listName and guardedName are the list tools' rule (guard
// 3): no phone number and no email address in a list result. A phone is 10
// digits (optionally led by +1) or 7, in 3-3-4 or 3-4 groups with phone
// separators; a range near a money word, a date and side-by-side years are
// not. personRef(key)
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
// An email address inside a contact field (a field may hold two, or words).
const ADDRESS_RE = /[^\s@<>()[\],;:"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}/g;
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
    const verdicts = [raw, ...also].map((t) => d.screenClientText(t) || {});
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
     * A stored email field: each address in it, screened with its local part's
     * underscores, dots, plus signs and hyphens read as spaces, and anything
     * else in the field screened as client text. Never withheld for its shape.
     */
    email(value, opts = {}) {
      if (value === null || value === undefined || String(value).trim() === '') return null;
      const v = String(value).trim();
      const addresses = v.match(ADDRESS_RE) || [];
      if (!addresses.length) return guard.client(v, opts);
      const shown = addresses.map((a) => {
        const local = a.slice(0, a.lastIndexOf('@')).replace(/[_.+-]+/g, ' ');
        const r = screen(a, { ...opts, ref: `${opts.ref || ''}:${a.toLowerCase()}` }, [local]);
        // A clean address is returned as typed (the strip would mark it).
        return r.clean ? a : r.text;
      });
      const rest = addresses.reduce((acc, a) => acc.replace(a, ' '), v).replace(/[\s,;/&]+|\band\b/gi, ' ').trim();
      return rest ? `${shown.join(', ')} ${guard.client(rest, opts)}` : shown.join(', ');
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

/** True when the guard's answer is the withheld text. */
const isWithheld = (shown) => typeof shown === 'string' && shown.startsWith(WITHHELD_TEXT);

// A phone number in a list tool's text, read after NFKC so fullwidth digits
// count: 10 digits (3, 3, 4) optionally led by +1, or 7 (3, 4), with any of
// the separators people write between the groups (spaces, dots, hyphens,
// slashes, underscores, commas, parentheses). Not a phone: a run inside a
// longer one, and a 7-digit range written near a currency or budget word
// ("$500-2000"). Dates and years side by side have no 3-digit group and never
// match.
const SEP = '[\\s._\\-/,]*';
const PHONE_RE = new RegExp(
  `(?<![\\d+])(?:\\+?1${SEP})?\\(?\\d{3}\\)?${SEP}\\d{3}${SEP}\\d{4}(?![\\d])|(?<![\\d+])\\d{3}${SEP}\\d{4}(?![\\d])`, 'g'
);
const MONEY_NEAR_RE = /(?:[$€£]|\b(?:budget|between|from|range|price|cost|usd|dollars?)\b)[^\n]{0,12}$/i;
const EMAIL_RE = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[A-Za-z]{2,}/g;

/** Text (NFKC) with any phone number or email address left in it replaced by a marker. */
function noContact(text) {
  if (text === null || text === undefined) return text;
  return String(text).normalize('NFKC').replace(EMAIL_RE, '[email]').replace(PHONE_RE, (run, offset, whole) => {
    const digits = run.replace(/\D/g, '').length;
    if (digits === 7 && MONEY_NEAR_RE.test(whole.slice(Math.max(0, offset - 16), offset))) return run;
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
 * A name fit to put in the owner's email: the name when it screens clean and
 * carries no destination or contact detail, else the fallback. The owner's
 * mailbox is itself read by Claude, so a withheld or flagged name never goes
 * into it.
 */
function safeLabel(name, fallback) {
  if (name === null || name === undefined || String(name).trim() === '') return fallback;
  const d = getToolDeps();
  const raw = String(name);
  const s = d.screenClientText(raw);
  if (s && (s.withheld || s.flagged)) return fallback;
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
