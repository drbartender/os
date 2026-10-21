#!/usr/bin/env node
'use strict';

// piiShapes: the one PII shape module (instruction rewrite spec 2026-10-19, 3.3
// and 3.10; D9). Three consumers read it so the shapes cannot drift: the board
// writer (scripts/board-write.sh --check), the static pre-step
// (scripts/static-checks.js, the `pii` rule over added lines) and the
// second-opinion mask that runs before a diff leaves the box for codex or gemini.
//
// The pre-step (--find) reads the added lines of EVERY path in the diff: code,
// docs, specs, plans, .claude files. D9 keeps a real person's number out of all
// of them, so only the per-path allowlist below narrows it; scoping to code
// paths belongs to the content rule in sensitive-match.js, not to PII.
//
// Modes, on purpose:
//   strict  (the board writer's --check, and any diff file whose header does
//           not parse): every shape blocks or masks, business lines and the
//           business domain included. The board carries titles and paths only,
//           so a number or an address is noise there whoever owns it.
//   allowlisted (findPii, mask, maskDiff, --find): the one allowlist of spec
//           3.3, by path class:
//             registry  smsLines.js, companyPhone.js: every phone and email
//                       exempt; every other shape judged as on a fixture
//                       path, so a live key masks there too.
//             fixture   **/*.test.js, seedTestData.js: fixtures only (M5). An
//                       email on a reserved or the business domain; a phone
//                       that is the 555 exchange, a business line or
//                       unassignable; any other shape unless it is a live key
//                       (sk_live_, rk_live_, whsec_, every sk- key, AIza,
//                       gh*_, github_pat_, napi_, a Stripe client secret, a
//                       Telegram pair), which is never exempt anywhere.
//             code      every other path, and no path: the business lines, the
//                       555 fixture exchange and the business email domain.
//           In a diff, a removed line of a rename or a copy, and the funcname
//           copy in its hunk headers, lived in the old file: it is judged under
//           the stricter of the old and new paths' classes (code beats test,
//           test beats registry), so a rename never turns real ids into
//           fixtures.
//
// Shapes (each a list of forms, below): EMAIL (an at sign or %40), PHONE (the
// board writer's, wider separators), TOKEN (bearer-style, the dotted pair, the
// provider key formats, a Stripe client secret, a three-part JWT, 32 or more
// hex, a base64 run of 40 or more with a digit and either a plus or padding or
// no slash at all, so a deep repo path never masks), UUID (the public-link
// tokens), STRIPE_ID (the id family, anchored, so an all-lowercase snake_case
// word such as files_in_diff never matches), SSN (dashed anywhere; plain or
// spaced beside ssn, tin, tax, social security or ss#), and ROUTING_EIN
// (beside routing, account, tax, ssn, ein, tin, aba, rtn or acct). The
// allowlist runs over every raw hit first; overlaps then resolve to the
// longest span, so a 32-hex token is a TOKEN, not a phone number hiding
// inside it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- Shapes -----------------------------------------------------------------
// Each shape is one or more forms. Every form is matched on its own, so each
// yields its own raw hits (an allowed span can never swallow a value inside
// it, L3). Every quantifier is bounded or anchored to a run boundary, so no
// form goes quadratic on a long line (L5).

// EMAIL: a 1-64 character local part, an at sign (or %40, its URL encoding),
// a 1-255 character domain and a 2-63 letter top-level label.
const EMAIL_LOCAL = '[A-Za-z0-9._%+-]';
const EMAIL_AT = '(?:@|%40)';
const EMAIL_DOMAIN = '[A-Za-z0-9.-]{1,255}\\.[A-Za-z]{2,63}';

// PHONE: the board writer's shape; a separator is a space or two, a dot, a
// hyphen, a slash, a no-break space, an en dash or a figure dash.
const PHONE_SEP = '(?: {1,2}|[.\\-/\\u00A0\\u2012\\u2013])?';
const PHONE_SRC = `(?<![0-9])(?:\\+?[0-9]{1,3}${PHONE_SEP})?\\(?[0-9]{3}\\)?${PHONE_SEP}[0-9]{3}${PHONE_SEP}[0-9]{4}(?![0-9])`;
// A bare run of digits (no separator, plus or parenthesis) is a phone number only
// when it reads as one: ten digits with a North American area code and exchange
// that can be assigned (first digit 2 to 9), or a leading 1 before them. The int4
// and uint32 maxima are constants in guards, never a subscriber. Anything else
// bare (an epoch timestamp, a 13-digit id) is a number, so the external reviewer
// still sees it. A separated or plus-led form masks whatever its digits.
const PLAUSIBLE_NANP = /^[2-9][0-9]{2}[2-9][0-9]{2}[0-9]{4}$/;
const INTEGER_MAXIMA = new Set(['2147483647', '4294967295']);
function phoneKeep(text, start, end, m) {
  if (/[^0-9]/.test(m)) return true;
  if (m.length === 10) return PLAUSIBLE_NANP.test(m) && !INTEGER_MAXIMA.has(m);
  if (m.length === 11) return m[0] === '1' && PLAUSIBLE_NANP.test(m.slice(1));
  return false;
}

// Context words for the nine-digit shapes, any case. routing, account, tax,
// ssn, social security and ss# count anywhere (routing_number, accountNumber,
// social_security_number); the short words ein, tin, aba, rtn and acct only
// when no letter touches them (being, protein, abandon, getting never count).
const ROUTING_WORDS = Object.freeze([/routing|account|tax|ssn/gi, /(?<![A-Za-z])(?:ein|tin|aba|rtn|acct)(?![A-Za-z])/gi]);
const SSN_WORDS = Object.freeze([/ssn|tax|social[ _-]?security|ss#/gi, /(?<![A-Za-z])tin(?![A-Za-z])/gi]);
const CONTEXT = 40;
// The slice around the window is padded by the longest context word (social
// security, 15 characters), so a word that overlaps the window only by its tail
// is still read whole.
const CONTEXT_PAD = 16;

// True when a context word overlaps the 40 characters either side of the hit.
// The words are searched in a slice padded past the window, so a word cut by
// the window edge is judged whole (its neighbours are inside the slice), and
// the work per hit stays bounded.
function nearWords(words) {
  return (text, start, end) => {
    const lo = start - CONTEXT;
    const hi = end + CONTEXT;
    const from = Math.max(0, lo - CONTEXT_PAD);
    const sub = text.slice(from, Math.min(text.length, hi + CONTEXT_PAD));
    for (const re of words) {
      for (const m of sub.matchAll(re)) {
        const ws = from + m.index;
        if (ws < hi && ws + m[0].length > lo) return true;
      }
    }
    return false;
  };
}

const FORMS = Object.freeze([
  { shape: 'EMAIL', name: 'email', re: new RegExp(`${EMAIL_LOCAL}{1,64}${EMAIL_AT}${EMAIL_DOMAIN}`, 'g'), scan: emailHits },
  { shape: 'PHONE', name: 'phone', re: new RegExp(PHONE_SRC, 'g'), keep: phoneKeep },
  // TOKEN: bearer-style, the JWT-ish dotted pair, the provider key formats
  // this codebase holds (Stripe, Anthropic, OpenAI, Google, GitHub, Neon,
  // Telegram), 32 or more hex, and a base64 run of 40 or more that holds a digit.
  { shape: 'TOKEN', name: 'bearer', re: /Bearer[ ]+[A-Za-z0-9._-]+/g },
  // A three-part JWT masks whole (the longest span wins over the dotted pair),
  // so the signature never reaches an external reviewer on its own. It starts
  // only where a run of its characters starts (not at every \b, which a dash
  // makes), so a long run of eyJ- tries one start, not one per dash (L1).
  { shape: 'TOKEN', name: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // Each side of a JWT-ish pair carries a digit; a long module.function reference carries none.
  { shape: 'TOKEN', name: 'dotted-pair', re: /(?<![A-Za-z0-9_-])(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}\.(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}/g },
  { shape: 'TOKEN', name: 'stripe-secret', re: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { shape: 'TOKEN', name: 'stripe-restricted', re: /\brk_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { shape: 'TOKEN', name: 'stripe-webhook', re: /\bwhsec_[A-Za-z0-9]{20,}/g },
  // A PaymentIntent or SetupIntent client secret authorizes the intent from a
  // browser: it masks whole, the intent id included (the longest span wins).
  { shape: 'TOKEN', name: 'stripe-client-secret', re: /\b(?:pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g },
  { shape: 'TOKEN', name: 'sk-dash', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { shape: 'TOKEN', name: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { shape: 'TOKEN', name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { shape: 'TOKEN', name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { shape: 'TOKEN', name: 'neon', re: /\bnapi_[A-Za-z0-9]{40,}/g },
  // The secret may end in a dash, where no \b sits, so the end is "no secret
  // character follows" instead.
  { shape: 'TOKEN', name: 'telegram', re: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { shape: 'TOKEN', name: 'hex', re: /[A-Fa-f0-9]{32,}/g },
  // A base64 run of 40 or more holding a digit is a secret when it shows a plus
  // or padding, or when it holds no slash (an alnum-only run: a Neon key body,
  // a GitHub fine-grained token, unpadded base64). A slash-bearing run with
  // neither a plus nor padding is a deep repo path (plans and specs hold many),
  // which the board carries and a brief must keep readable.
  { shape: 'TOKEN', name: 'base64', re: /[A-Za-z0-9+/]{40,}={0,2}/g, keep: (text, start, end, m) => /[0-9]/.test(m) && (/[+=]/.test(m) || !m.includes('/')) },
  // UUID: the public-link tokens (proposals, invoices, drink plans, voicemail)
  // are the auth for those pages. The v1-v8 form, either case. Its edges are
  // "no hex digit beside it", not \b, so proposal_<uuid>.pdf masks.
  // The nil UUID is matched so the digits inside it never read as a phone, and
  // allowed everywhere as a fixture (literalAllowed).
  { shape: 'UUID', name: 'uuid', re: /(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}|00000000-0000-0000-0000-000000000000)(?![0-9A-Fa-f])/g },
  // STRIPE_ID: the id family, anchored at a word boundary, an optional live or
  // test segment, then 8 or more id characters holding a digit, or 14 or more
  // letters holding an uppercase one. An all-lowercase snake_case word
  // (re_authentication, in_progress, files_in_diff) never matches.
  {
    shape: 'STRIPE_ID',
    name: 'stripe-id',
    re: /\b(?:pi|cus|ch|re|evt|in|sub|cs|seti|pm|po|tr|txn|acct|ba|src|tok|card|prod|price|plan|plink|inv|il|ii|si|cn|dp|py|or|sku|txi)_(?:(?:live|test)_)?(?:(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{8,}|(?=[a-z]*[A-Z])[A-Za-z]{14,})/g,
  },
  // SSN: the dashed form anywhere; nine plain digits, or the spaced 3-2-4
  // form, beside ssn, tin, tax, social security or ss#. Listed before
  // ROUTING_EIN, so a nine-digit run beside tax reads as SSN.
  { shape: 'SSN', name: 'ssn-dashed', re: /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g },
  { shape: 'SSN', name: 'ssn-plain', re: /\b[0-9]{9}\b/g, keep: nearWords(SSN_WORDS) },
  { shape: 'SSN', name: 'ssn-spaced', re: /\b[0-9]{3} [0-9]{2} [0-9]{4}\b/g, keep: nearWords(SSN_WORDS) },
  // ROUTING_EIN: nine digits or the 2-7 EIN form beside a context word.
  { shape: 'ROUTING_EIN', name: 'routing-ein', re: /\b(?:[0-9]{9}|[0-9]{2}-[0-9]{7})\b/g, keep: nearWords(ROUTING_WORDS) },
]);

// One regex per shape (its forms joined), for consumers that want the shapes
// themselves. Context rules (a form's `keep`) apply only through findPii.
const SHAPES = Object.freeze(Object.fromEntries(
  [...new Set(FORMS.map((f) => f.shape))].map((shape) => [
    shape,
    new RegExp(FORMS.filter((f) => f.shape === shape).map((f) => `(?:${f.re.source})`).join('|'), 'g'),
  ]),
));

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TEST_PATHS = Object.freeze(['**/*.test.js', 'server/db/seedTestData.js']);
const REGISTRY_PATHS = Object.freeze(['server/utils/smsLines.js', 'server/utils/companyPhone.js']);

// Every registry that failed to load, as one line each (file and error code), so
// the CLI can print why a business line masked instead of swallowing the cause. Declared
// before the allowlist below, which fills it at load.
const REGISTRY_NOTES = [];
function registryLoadNotes() {
  return REGISTRY_NOTES.slice();
}

const ALLOWLIST = Object.freeze({
  // by path (repo-relative, forward slashes); globs: ** crosses slashes, * does not
  paths: Object.freeze([...TEST_PATHS, ...REGISTRY_PATHS]),
  // the line registries: every phone and email exempt; every other shape as
  // on a fixture path (a live key is never exempt)
  registryPaths: REGISTRY_PATHS,
  // fixture paths: exempt for fixtures only (M5). An email on a reserved or
  // business domain; a phone that is the 555 exchange, a business line or
  // unassignable (area code or exchange starting 0 or 1); any other shape
  // unless it is a live key, which is never exempt anywhere.
  testPaths: TEST_PATHS,
  testEmailDomains: Object.freeze(['example.com', 'example.org', 'example.net', 'example.edu', 'test.com', 'drbartender.com']),
  testEmailSuffixes: Object.freeze(['.test', '.invalid', '.example', '.localhost']),
  // by literal, on every allowlisted path: the business lines (read from the
  // two registries at load), the 555 fixture exchange, the business domain
  businessLines: Object.freeze(readBusinessLines()),
  fixtureExchange: '555',
  emailDomains: Object.freeze(['drbartender.com']),
});

// The live-key forms: never exempt, test paths and the registries included.
// Every sk- key (OpenAI and Anthropic, any kind), the Stripe live, restricted
// and webhook keys, a Stripe client secret, Google, GitHub (gh*_ and
// github_pat_), Neon and a Telegram bot token.
const LIVE_KEY = /^(?:sk_live_|rk_live_|whsec_|sk-|AIza|gh[pousr]_|github_pat_|napi_|(?:pi|seti)_[A-Za-z0-9]+_secret_|[0-9]{8,10}:)/;

const BLOCK_WORDS = Object.freeze({
  EMAIL: 'an email address',
  PHONE: 'a phone number',
  TOKEN: 'a token or secret',
  UUID: 'a link token (UUID)',
  STRIPE_ID: 'a Stripe id',
  ROUTING_EIN: 'a routing or tax id',
  SSN: 'a social security number',
});

// The business lines are the registries' EXPORTED values: COMPANY_PHONE and
// COMPANY_TEXT_PHONE from companyPhone.js, and lineE164(key) for every key in
// smsLines.js's LINE_KEYS. Never scraped from the source text, so a number
// named in a comment is never allowlisted. A registry that fails to load
// allowlists nothing (more is masked, never less).
function readBusinessLines(root = REPO_ROOT) {
  const lines = new Set();
  const add = (v) => {
    const d = typeof v === 'string' ? last10(v) : null;
    if (d) lines.add(d);
  };
  const load = (rel) => {
    try {
      return require(path.join(root, rel));
    } catch (err) {
      REGISTRY_NOTES.push(`${rel} did not load (${(err && err.code) || (err && err.message) || err}); nothing from it is allowlisted`);
      return {};
    }
  };
  const company = load('server/utils/companyPhone.js');
  add(company.COMPANY_PHONE);
  add(company.COMPANY_TEXT_PHONE);
  const sms = load('server/utils/smsLines.js');
  if (Array.isArray(sms.LINE_KEYS) && typeof sms.lineE164 === 'function') {
    for (const key of sms.LINE_KEYS) {
      try {
        add(sms.lineE164(key));
      } catch (err) {
        REGISTRY_NOTES.push(`smsLines.js line ${key} did not resolve (${(err && err.message) || err}); it is not allowlisted`);
      }
    }
  }
  return [...lines];
}

function last10(s) {
  const digits = String(s).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// One pass, so the `*` inside an emitted `(?:.*/)?` is never rewritten again.
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const TEST_GLOBS = TEST_PATHS.map(globToRegex);
const REGISTRY_GLOBS = REGISTRY_PATHS.map(globToRegex);

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

// 'registry' (phones and emails exempt, the rest as a fixture path), 'test'
// (fixtures exempt) or 'code' (any other path, and no path at all). A path is
// classified exactly as git names it: a spelling normalization would change
// (literal backslashes, a trailing space, a leading ./) is another file and
// takes the code class, so no spelling of a registry or fixture path exempts
// a value (review-tooling security H2).
function pathClass(p) {
  if (!p) return 'code';
  const s = String(p);
  if (normalizePath(s) !== s) return 'code';
  if (REGISTRY_GLOBS.some((re) => re.test(s))) return 'registry';
  if (TEST_GLOBS.some((re) => re.test(s))) return 'test';
  return 'code';
}

/** True for a path on the allowlist: a line registry or a fixture path. */
function pathAllowed(p) {
  return pathClass(p) !== 'code';
}

function nanpLocal(match) {
  const digits = match.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function isFixturePhone(match) {
  const local = nanpLocal(match);
  return local.length === 10 && (local.startsWith(ALLOWLIST.fixtureExchange) || local.slice(3, 6) === ALLOWLIST.fixtureExchange);
}

function isBusinessLine(match) {
  const l10 = last10(match);
  return Boolean(l10 && ALLOWLIST.businessLines.includes(l10));
}

// No subscriber can hold it: the area code or the exchange starts with 0 or 1.
function isUnassignable(match) {
  const local = nanpLocal(match);
  return local.length === 10 && (/^[01]/.test(local) || /^[01]/.test(local.slice(3)));
}

function onDomain(domain, list) {
  return list.some((d) => domain === d || domain.endsWith('.' + d));
}

// True when a hit is exempt under a fixture path (M5).
function testAllowed({ shape, match, domain }) {
  if (shape === 'EMAIL') {
    return onDomain(domain, ALLOWLIST.testEmailDomains) || ALLOWLIST.testEmailSuffixes.some((sfx) => domain.endsWith(sfx));
  }
  if (shape === 'PHONE') return isFixturePhone(match) || isBusinessLine(match) || isUnassignable(match);
  if (shape === 'TOKEN') return !LIVE_KEY.test(match);
  return true; // STRIPE_ID, UUID, ROUTING_EIN, SSN
}

// True when a hit is exempt under a line registry: every phone and email (the
// registries hold the business lines and addresses), and every other shape as
// on a fixture path, so a live key is never exempt there either.
function registryAllowed(hit) {
  return hit.shape === 'PHONE' || hit.shape === 'EMAIL' || testAllowed(hit);
}

// True when a hit is allowed by literal on any other path.
function literalAllowed({ shape, match, domain }) {
  if (shape === 'PHONE') return isFixturePhone(match) || isBusinessLine(match);
  if (shape === 'EMAIL') return onDomain(domain, ALLOWLIST.emailDomains);
  if (shape === 'UUID') return match === NIL_UUID;
  return false;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Email hits are found per at sign, so two addresses glued together (a
// URL-encoded one in front of a business one) each yield their own hit: the
// local part runs back up to 64 characters from the at sign, the domain
// forward from it.
const EMAIL_LOCAL_CHAR = new RegExp(EMAIL_LOCAL);
const EMAIL_DOMAIN_AT = new RegExp(EMAIL_DOMAIN, 'y');

function emailHits(text) {
  const out = [];
  for (const at of text.matchAll(new RegExp(EMAIL_AT, 'g'))) {
    let start = at.index;
    while (start > 0 && at.index - start < 64 && EMAIL_LOCAL_CHAR.test(text[start - 1])) start--;
    if (start === at.index) continue;
    EMAIL_DOMAIN_AT.lastIndex = at.index + at[0].length;
    const d = EMAIL_DOMAIN_AT.exec(text);
    if (!d) continue;
    const end = d.index + d[0].length;
    out.push({ start, end, domain: d[0].toLowerCase() });
  }
  return out;
}

// A digit run inside a token, a UUID or a Stripe id is part of that id, not a
// phone number: an exempt id in a test path must pass whole, and anywhere else
// the id masks it anyway. Every other overlap is left to the allowlist and
// prune, so a value inside an allowed email still masks (L3).
const ID_SHAPES = new Set(['TOKEN', 'UUID', 'STRIPE_ID']);

function dropDigitRunsInIds(hits) {
  const ids = hits.filter((h) => ID_SHAPES.has(h.shape)).sort((a, b) => a.start - b.start);
  const phones = hits.filter((h) => h.shape === 'PHONE').sort((a, b) => a.start - b.start);
  const inside = new Set();
  let i = 0;
  let furthest = -1;
  for (const ph of phones) {
    while (i < ids.length && ids[i].start <= ph.start) furthest = Math.max(furthest, ids[i++].end);
    if (furthest >= ph.end) inside.add(ph);
  }
  return hits.filter((h) => !inside.has(h));
}

// Every raw hit of every form, unpruned.
function rawHits(text) {
  const out = [];
  for (const form of FORMS) {
    if (form.scan) {
      for (const h of form.scan(text)) out.push({ shape: form.shape, form: form.name, match: text.slice(h.start, h.end), ...h });
      continue;
    }
    for (const m of text.matchAll(form.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (form.keep && !form.keep(text, start, end, m[0])) continue;
      out.push({ shape: form.shape, form: form.name, match: m[0], start, end });
    }
  }
  return out;
}

// Longest span wins among the hits that survive the allowlist: a hit inside
// another kept hit is dropped. Equal spans keep the earlier form. Sorted by
// start, every kept hit starts at or before the next one, so containment is
// one comparison against the furthest end kept so far (linear in the hits).
const FORM_ORDER = new Map(FORMS.map((f, i) => [f.name, i]));

function prune(hits) {
  const sorted = [...hits].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || FORM_ORDER.get(a.form) - FORM_ORDER.get(b.form));
  const kept = [];
  let furthest = -1;
  for (const h of sorted) {
    if (h.end <= furthest) continue;
    kept.push(h);
    furthest = h.end;
  }
  return kept;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const ALLOWED_BY_CLASS = Object.freeze({ registry: registryAllowed, test: testAllowed, code: literalAllowed, strict: () => false });

/**
 * Find PII shapes in `text`. `path` (repo-relative) applies the path allowlist;
 * `strict: true` disables every allowlist (the board writer's mode). The
 * allowlist runs over every raw hit first, then overlaps are pruned among the
 * survivors (L3). Returns [{shape, line, match, start, end}] in document order.
 */
function findPii(text, { path: filePath, strict = false } = {}) {
  const src = String(text || '');
  const cls = strict ? 'strict' : pathClass(filePath);
  const allowed = ALLOWED_BY_CLASS[cls];
  const survivors = dropDigitRunsInIds(rawHits(src)).filter((h) => !allowed(h));
  const starts = lineStarts(src);
  return prune(survivors).map((h) => ({ shape: h.shape, line: lineAt(starts, h.start), match: h.match, start: h.start, end: h.end }));
}

/**
 * Replace every hit with <SHAPE>; partly overlapping hits merge into one span.
 * The output is built in one forward pass over an array of parts, so the cost
 * is linear in the text, never the text times the hit count.
 */
function mask(text, opts = {}) {
  const src = String(text || '');
  const spans = [];
  for (const h of findPii(src, opts)) {
    const last = spans[spans.length - 1];
    if (last && h.start < last.end) last.end = Math.max(last.end, h.end);
    else spans.push({ shape: h.shape, start: h.start, end: h.end });
  }
  if (spans.length === 0) return src;
  const parts = [];
  let pos = 0;
  for (const sp of spans) {
    parts.push(src.slice(pos, sp.start), '<', sp.shape, '>');
    pos = sp.end;
  }
  parts.push(src.slice(pos));
  return parts.join('');
}

// A hunk header's structure is only its line-number prefix. Git appends a copy
// of a source line after the second @@ (the funcname context), so the rest of
// the line is content and is masked like any other line.
const HUNK_PREFIX = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function maskHunkHeader(line, opts) {
  const m = HUNK_PREFIX.exec(line);
  if (!m) return mask(line, opts);
  return m[0] + mask(line.slice(m[0].length), opts);
}

// Git C-quotes a path that holds a quote, a backslash, a control character or
// (with the default core.quotePath) a non-ASCII byte: "a/caf\303\251.js". Decode
// one quoted token to a string, or return null when it is not well formed.
const C_ESCAPES = Object.freeze({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });

function unquoteC(token) {
  if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') return null;
  const bytes = [];
  for (let i = 1; i < token.length - 1; i++) {
    const c = token[i];
    if (c === '"') return null;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = token[i + 1];
    if (/^[0-7]{3}$/.test(token.slice(i + 1, i + 4))) {
      bytes.push(parseInt(token.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (n !== undefined && i + 1 < token.length - 1 && Object.prototype.hasOwnProperty.call(C_ESCAPES, n)) {
      bytes.push(C_ESCAPES[n]);
      i += 1;
    } else {
      return null;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

// Index of the closing quote of the quoted token starting at `from`, or -1.
function closingQuote(s, from) {
  for (let i = from + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

/**
 * The new-side path of a `diff --git` line, or null when the line does not
 * parse. Each side is either C-quoted or bare; a bare path never holds a quote
 * (git would have quoted it). Two bare sides are split where they are the same
 * path (every non-rename), else at the first " b/".
 */
function parseGitHeader(line) {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  let a;
  let b;
  if (rest.startsWith('"')) {
    const end = closingQuote(rest, 0);
    if (end < 0 || rest[end + 1] !== ' ') return null;
    a = unquoteC(rest.slice(0, end + 1));
    const tail = rest.slice(end + 2);
    b = tail.startsWith('"') ? (closingQuote(tail, 0) === tail.length - 1 ? unquoteC(tail) : null) : tail;
  } else if (rest.includes('"')) {
    const at = rest.indexOf(' "');
    if (at < 0 || rest.slice(0, at).includes('"')) return null;
    a = rest.slice(0, at);
    const tail = rest.slice(at + 1);
    b = closingQuote(tail, 0) === tail.length - 1 ? unquoteC(tail) : null;
  } else {
    const n = (rest.length - 5) / 2;
    const same = Number.isInteger(n) && n > 0 ? rest.slice(2, 2 + n) : null;
    if (same !== null && rest === `a/${same} b/${same}`) {
      a = `a/${same}`;
      b = `b/${same}`;
    } else {
      const m = /^(a\/.+?) (b\/.+)$/.exec(rest);
      if (!m) return null;
      a = m[1];
      b = m[2];
    }
  }
  if (a === null || b === null || !a.startsWith('a/') || !b.startsWith('b/') || b.length < 3) return null;
  return b.slice(2);
}

// The mask options for one file. A null path (the preamble, or a header that
// did not parse) masks everything: no allowlist of any kind.
function fileOpts(p) {
  return p ? { path: p } : { strict: true };
}

// The path of a `rename from` or `copy from` line (no a/ prefix there; C-quoted
// like a header side when it must be), or null when it does not parse.
function parseFromPath(rest) {
  if (!rest) return null;
  if (!rest.startsWith('"')) return rest || null;
  const p = closingQuote(rest, 0) === rest.length - 1 ? unquoteC(rest) : null;
  return p || null;
}

// Path classes from the most exempt to the strictest: each one's exempt set
// holds the next one's (a registry exempts every phone and email, a fixture
// path only fixtures, a code path only the business literals).
const STRICTNESS = Object.freeze({ registry: 0, test: 1, code: 2 });

// The mask options for a line that lived in the old file of a rename or a copy
// (a removed line, a hunk header's funcname copy): the stricter of the two
// paths' classes, so strict beats fixture-exempt. `oldPath` is undefined when
// the section is neither a rename nor a copy, and null when its from-line did
// not parse, which masks everything.
function oldSideOpts(newPath, oldPath) {
  if (oldPath === undefined) return fileOpts(newPath);
  if (oldPath === null || newPath === null) return { strict: true };
  return STRICTNESS[pathClass(oldPath)] > STRICTNESS[pathClass(newPath)] ? { path: oldPath } : { path: newPath };
}

// Walk a unified diff line by line. Each line gets its file's path, a kind and
// the mask options it is judged by (`opts`):
//   preamble     before the first `diff --git` (a commit list, a stat)
//   header       from `diff --git` up to that file's first @@ line
//   hunk-header  an @@ line
//   content      every other line after the first @@ of a file
// A line is a header only inside the header zone, so a removed `-- a/` line
// or an added `++ b/` line inside a hunk is content, never a header. A content
// line that exists in the new file carries its new-file line number (`lineNo`).
// A `rename from` or `copy from` header line names the old path: a removed or
// context line and a hunk header (its funcname tail is a line of the old file) are
// judged under the stricter of the old and new paths' classes (L2).
function walkDiff(diffText) {
  const out = [];
  let path = null;
  let oldPath;
  let zone = 'preamble';
  let next = null;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git')) {
      path = parseGitHeader(line); // null when it does not parse: never the previous file's path
      oldPath = undefined;
      zone = 'header';
      out.push({ line, path, kind: 'header', opts: fileOpts(path) });
      continue;
    }
    if (zone === 'header') {
      const from = /^(?:rename|copy) from (.*)$/.exec(line);
      if (from) oldPath = parseFromPath(from[1]);
    }
    if (zone !== 'preamble' && line.startsWith('@@')) {
      zone = 'hunk';
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      next = m ? Number(m[1]) : null;
      out.push({ line, path, kind: 'hunk-header', opts: oldSideOpts(path, oldPath) });
      continue;
    }
    if (zone !== 'hunk') {
      out.push({ line, path, kind: zone, opts: fileOpts(path) });
      continue;
    }
    const removed = line.startsWith('-');
    const added = line.startsWith('+');
    const inNew = !removed && !line.startsWith('\\');
    // Only an added line is new to the file; a removed or context line also lived
    // in the old file, so under a rename or copy it takes the stricter class.
    out.push({ line, path, kind: 'content', lineNo: inNew ? next : null, opts: added ? fileOpts(path) : oldSideOpts(path, oldPath) });
    if (inNew && next !== null) next++;
  }
  return out;
}

/**
 * Mask a unified diff file by file, applying the path allowlist from its
 * headers. Every line is masked, header lines included (a path can carry a
 * number); only a hunk header's line-number prefix is kept verbatim.
 */
function maskDiff(diffText) {
  return walkDiff(diffText)
    .map(({ line, kind, opts }) => (kind === 'hunk-header' ? maskHunkHeader(line, opts) : mask(line, opts)))
    .join('\n');
}

/**
 * Hits on ADDED lines, and on a changed path itself: [{shape, path, line,
 * text}], `line` the new-file line number (null for a path hit) and `text`
 * the added line MASKED (for a path hit, the path masked strict). No raw value
 * leaves here: the consumer prints these into a transcript. A file named with
 * an email or a number is a leak however innocent its content, since every
 * brief and receipt prints the path (review-tooling security H1).
 */
function findInDiff(diffText) {
  const hits = [];
  for (const { line, path: p, kind, lineNo, opts } of walkDiff(diffText)) {
    if (kind === 'header') {
      if (!p || !line.startsWith('diff --git')) continue;
      const inPath = findPii(p, { strict: true });
      if (inPath.length) {
        const text = `the path itself: ${mask(p, { strict: true })}`;
        for (const h of inPath) hits.push({ shape: h.shape, path: p, line: null, text });
      }
      continue;
    }
    if (kind !== 'content' || !line.startsWith('+')) continue;
    const added = line.slice(1);
    const found = findPii(added, opts);
    if (found.length === 0) continue;
    const text = mask(added, opts);
    for (const h of found) hits.push({ shape: h.shape, path: p, line: lineNo, text });
  }
  return hits;
}

module.exports = { SHAPES, ALLOWLIST, findPii, mask, maskDiff, findInDiff, pathAllowed, pathClass, readBusinessLines, registryLoadNotes };

// ---- CLI --------------------------------------------------------------------
// Plain output only: no color codes, no external diff driver, no textconv
// filter, binary files as text, no context lines. The user's diff config never
// narrows the diff or changes its headers (L7): --no-relative undoes
// diff.relative (which, from a subdirectory, drops every file outside it), and
// the explicit a/ and b/ prefixes undo diff.noprefix and diff.mnemonicPrefix,
// whose headers the parser could not attribute.
const DIFF_FLAGS = Object.freeze(['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--unified=0',
  '--no-relative', '--src-prefix=a/', '--dst-prefix=b/']);

// The full sha of `ref` when it names a commit, else null.
function resolveCommit(ref) {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' });
  const sha = res.status === 0 ? String(res.stdout).trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

//   --check "<line>"             strict; exit 0 clean, 1 blocked (the board writer)
//   --mask-diff  < diff          masked diff on stdout
//   --find --added <base> <tip>  JSON hits on the added lines of every path in the diff
//   --find --staged              same over the staged diff
// The CLI's results go out synchronously, in full, before it exits: an async
// pipe write followed by process.exit drops everything past the pipe buffer
// (about 64 KB) when the reader lags. A non-blocking descriptor answers EAGAIN,
// which waits a few milliseconds and retries.
function writeOut(text) {
  const buf = Buffer.from(text, 'utf8');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off, buf.length - off);
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  for (const note of registryLoadNotes()) process.stderr.write(`piiShapes: ${note}\n`);
  const readStdin = () => fs.readFileSync(0, 'utf8');
  if (args[0] === '--check') {
    const hits = findPii(args.slice(1).join(' '), { strict: true });
    if (hits.length === 0) process.exit(0);
    const what = BLOCK_WORDS[hits[0].shape] || 'personal data';
    process.stderr.write(`BLOCKED: line looks like it contains ${what}. The board carries titles and paths only.\n`);
    process.exit(1);
  }
  if (args[0] === '--mask-diff') {
    writeOut(maskDiff(readStdin()));
    process.exit(0);
  }
  if (args[0] === '--find') {
    const usage = () => {
      process.stderr.write('usage: piiShapes.js --find --added <base> <tip> | --find --staged\n');
      process.exit(2);
    };
    // The raw diff never reaches the terminal: git's output stays in this
    // process, and a failure prints a fixed line, never git's stdout.
    const gitDiff = (extra) => {
      const res = spawnSync('git', ['diff', ...DIFF_FLAGS, ...extra], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
      if (res.status !== 0 || res.error) {
        process.stderr.write('piiShapes.js: git diff failed\n');
        process.exit(2);
      }
      return res.stdout;
    };
    let diff;
    // A trailing -- ends the revisions: no argument is ever read as a path.
    if (args[1] === '--staged' && args.length === 2) {
      diff = gitDiff(['--cached', '--']);
    } else if (args[1] === '--added' && args.length === 4) {
      // Each ref must name a commit, so an option (--output=<path>) or two
      // paths outside the repo (git's implicit --no-index) never reach git diff.
      const base = resolveCommit(args[2]);
      const tip = resolveCommit(args[3]);
      if (!base || !tip) usage();
      diff = gitDiff(['--end-of-options', base, tip, '--']);
    } else {
      usage();
    }
    writeOut(JSON.stringify(findInDiff(diff), null, 2) + '\n');
    process.exit(0);
  }
  process.stderr.write('usage: piiShapes.js --check "<line>" | --mask-diff | --find --added <base> <tip> | --find --staged\n');
  process.exit(2);
}
