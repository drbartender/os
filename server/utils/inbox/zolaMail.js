'use strict';

// Zola's notices (spec 2026-10-14 section 5.6), PURE. This module is the ONE
// home of the authentication gate and the subject match; lane zola-leads adds
// the body parser (parseZola) here and never redefines either.
//
// The gate: a mail from Zola's vendor address is believed only when the
// Authentication-Results header mx.google.com wrote says DKIM passed for a
// zola.com signature and DMARC passed for the zola.com From domain. Only the
// TOPMOST Authentication-Results header is read: Google prepends its own above
// everything the sender wrote, so a forged "pass" line carried inside the
// message sits below it. A caller building the header map must therefore keep
// the FIRST value of a repeated header, or pass every value, top first, as an
// array.
//
// Google's own line still carries text the sender shapes: the envelope sender
// inside the spf comment, and the DKIM identity. Google does not escape it,
// so a ")" inside a quoted local part can close the comment early and smuggle
// in a result ("dkim=pass header.i=@zola.com" ahead of Google's real dmarc),
// and an unclosed "(" can swallow Google's own dmarc result into a comment.
// The gate therefore refuses a line that holds a quote at all (a real Zola
// line has none: the envelope sender is Mandrill's bounce address), refuses a
// line that does not end balanced (outside every comment), requires exactly
// ONE dmarc result (Google writes one, last, and nothing the sender controls
// follows it), reads the FIRST value of a repeated property, and reads an
// unquoted value up to the next space or ";", so an identity with a quote,
// whitespace or a second @ in it is refused rather than cut short. The DKIM
// check is the weaker half; the dmarc result is the anchor.
//
// Linear on hostile input (security re-review 2026-10-15): a line past
// AUTH_LINE_MAX characters is refused before any pattern runs (a real line
// from Google is well under a thousand), and a property name can start only
// where a run of name characters starts, so a long run is never rescanned
// from every position in it (50,000 characters took 4 s, 200,000 took 68 s).

const { ZOLA_LEAD_UUID_RE } = require('./constants');

const AUTHSERV_ID = 'mx.google.com';
const ZOLA_DOMAIN = 'zola.com';
const LABEL_MAX = 120;
const AUTH_LINE_MAX = 4096;

const RESULT_RE = /^([a-z0-9_-]+)\s*=\s*([a-z0-9_-]+)/;
const PROP_RE = /(?<![a-z0-9_-])([a-z0-9_-]+\.[a-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s;]+)/g;

// The value split on ';' outside quoted strings and comments, comments dropped,
// and whether it ended outside every comment and quoted string.
function segmentsOf(value) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (quoted) {
      cur += ch;
      if (ch === '\\' && i + 1 < value.length) { i += 1; cur += value.charAt(i); } else if (ch === '"') quoted = false;
    } else if (depth > 0) {
      if (ch === '\\') i += 1;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    } else if (ch === '(') {
      depth = 1;
      cur += ' ';
    } else if (ch === ';') {
      out.push(cur.trim());
      cur = '';
    } else {
      if (ch === '"') quoted = true;
      cur += ch;
    }
  }
  out.push(cur.trim());
  return { parts: out, balanced: depth === 0 && !quoted };
}

// [{ method, result, props }] from one Authentication-Results value, or null
// when mx.google.com did not write it, it holds a quote, it runs past
// AUTH_LINE_MAX, or it does not end balanced.
function authResultsOf(value) {
  const line = String(value || '');
  if (line.includes('"')) return null;
  if (line.length > AUTH_LINE_MAX) return null;
  const { parts, balanced } = segmentsOf(line.toLowerCase());
  if (!balanced) return null;
  const [head, ...rest] = parts;
  if (head.split(/\s+/)[0] !== AUTHSERV_ID) return null;
  const results = [];
  for (const seg of rest) {
    const m = RESULT_RE.exec(seg);
    if (!m) continue;
    const props = new Map();
    // The first value of a property is the one Google wrote; quotes are kept,
    // so a quoted identity is refused below rather than read.
    for (const p of seg.slice(m[0].length).matchAll(PROP_RE)) if (!props.has(p[1])) props.set(p[1], p[2]);
    results.push({ method: m[1], result: m[2], props });
  }
  return results;
}

// The domain of an identity, or null for one that holds a quote, whitespace,
// a backslash or a second @.
const domainOf = (identity) => {
  const s = String(identity || '');
  if (s === '' || /[\s"\\]/.test(s) || s.indexOf('@') !== s.lastIndexOf('@')) return null;
  return s.includes('@') ? s.slice(s.lastIndexOf('@') + 1) : s;
};

function zolaAuthPasses(headers) {
  if (!headers || typeof headers.get !== 'function') return false;
  const raw = headers.get('authentication-results');
  const results = authResultsOf(Array.isArray(raw) ? raw[0] : raw);
  if (!results) return false;
  const dkim = results.some((r) => r.method === 'dkim' && r.result === 'pass'
    && domainOf(r.props.get('header.i') || r.props.get('header.d')) === ZOLA_DOMAIN);
  const dmarcs = results.filter((r) => r.method === 'dmarc');
  const dmarc = dmarcs.length === 1 && dmarcs[0].result === 'pass' && dmarcs[0].props.get('header.from') === ZOLA_DOMAIN;
  return dkim && dmarc;
}

// The couple's label, bounded before it can reach a row: trimmed, cut at 120
// characters (code points, so a cut never splits one), null when empty.
function boundLabel(raw) {
  const label = Array.from(String(raw || '').trim()).slice(0, LABEL_MAX).join('').trim();
  return label || null;
}

const INQUIRY_RE = /^New Zola inquiry for /;
const MESSAGE_RE = /^New message from (.+) for /;
const CLOSED_RE = /^(.+) closed their inquiry$/;
const BOOKED_RE = /^Booked!/;

// Which notice a gated mail is, by subject. A booked notice carries no couple
// label and no lead id, so the caller drops it; null is Zola marketing.
function zolaTemplateOf(subject) {
  const s = String(subject || '').trim();
  if (INQUIRY_RE.test(s)) return { template: 'inquiry', label: null };
  const message = MESSAGE_RE.exec(s);
  if (message) return { template: 'message', label: boundLabel(message[1]) };
  const closed = CLOSED_RE.exec(s);
  if (closed) return { template: 'closed', label: boundLabel(closed[1]) };
  if (BOOKED_RE.test(s)) return { template: 'booked', label: null };
  return { template: null, label: null };
}

// zola_leads.couple_label_key: the one rule that decides two labels are one
// couple (trimmed, inner whitespace collapsed, case-folded).
function labelKey(label) {
  return String(label || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// A notice whose subject names no couple still gets a lead row (5.6).
function fallbackLabel(atChicagoYmd) {
  return `Zola notice ${atChicagoYmd}`;
}

module.exports = { zolaAuthPasses, zolaTemplateOf, labelKey, fallbackLabel, boundLabel, LABEL_MAX, UUID_RE: ZOLA_LEAD_UUID_RE };
