// client/src/utils/sentryScrub.js
//
// The browser Sentry's redaction (spec 2026-10-06 Inbox, section 17 item 42).
// An Inbox person key for an unknown number is p- plus the last ten digits of
// the phone, so the page URL /inbox/p-<digits> and every
// /api/admin/inbox/p-<digits> request carry a phone number. It must never come
// to rest in Sentry: not in an error event, a transaction, or a breadcrumb.
// The page also prints an unknown number's formatted phone as their name, so
// the scrub redacts phone shapes by value as well as the key in a path.
//
// It lives in its own module, with no Sentry import, because index.js renders
// the app when it loads: a hook written there can only be eyeballed.
// sentryScrub.test.js pins this one, and index.js only wires it.
//
// Read server/utils/sentryScrub.js before editing. Its lesson, learned three
// times: never name the fields you expect to be dangerous. This scrubs EVERY
// string, at any depth, object keys and arrays included, so a URL is redacted
// wherever an integration puts it (request.url, the Referer header, a
// navigation breadcrumb's from and to, an xhr breadcrumb's url, a console
// message, a transaction name, a span's data). If you find yourself adding a
// field name to fix a leak, you are writing the next one.
//
// It copies, never mutates: a console breadcrumb holds the app's own objects,
// and editing them in place would change live state. Anything that is not a
// string, an array or a plain object (an Error, a DOM node) passes through by
// reference: Sentry turns those into plain data before an event is sent, and
// beforeSend scrubs that plain copy.
//
// Fail closed: if the walk throws, or the item is too deep or too big to walk
// (a cycle), the hook returns null and Sentry drops it. Losing one report is
// cheaper than sending a phone number.

// The server's rule: any /inbox/p-<digits>, either case (Express matches
// paths case-insensitively), here also with percent-encoded separators (a
// next= or redirect parameter carries the path encoded).
const INBOX_P_PATH = /(?:\/|%2F)inbox(?:\/|%2F)p-\d+/gi;
// The same key outside a path (a console message, an error's text): p- and
// exactly ten digits, not glued to a longer word or number. c-, s- and t- keys
// are row and lead ids, not phones, and stay readable.
const BARE_P_KEY = /(^|[^0-9A-Za-z_-])p-\d{10}(?!\d)/gi;
// A number by value: the server's display shape "(nnn) nnn-nnnn" (a label a
// click crumb copied, a name in an error's extra), and an E.164 number, a plus
// and 7 to 15 digits not glued to more digits (the server names a non-US
// texter by its raw E.164 string). A bare ten-digit run stays: an epoch
// second or a row id has that shape too.
const DISPLAY_PHONE = /\(\d{3}\) \d{3}-\d{4}/g;
const E164 = /\+\d{7,15}(?!\d)/g;

const MAX_DEPTH = 24;
const MAX_NODES = 20000;

export function scrubText(s) {
  return String(s)
    .replace(INBOX_P_PATH, '/inbox/p-[redacted]')
    .replace(BARE_P_KEY, '$1p-[redacted]')
    .replace(DISPLAY_PHONE, '[number]')
    .replace(E164, '[number]');
}

function isPlainObject(v) {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function walk(value, depth, budget) {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES) throw new Error('sentry scrub: too deep or too big');
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, budget));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    out[scrubText(key)] = walk(value[key], depth + 1, budget);
  }
  return out;
}

function scrubOrDrop(item) {
  try {
    return walk(item, 0, { nodes: 0 });
  } catch {
    return null;
  }
}

export function beforeSend(event) {
  return scrubOrDrop(event);
}

export function beforeSendTransaction(event) {
  return scrubOrDrop(event);
}

export function beforeBreadcrumb(breadcrumb) {
  return scrubOrDrop(breadcrumb);
}

/** Spread into Sentry.init's options (client/src/index.js). */
export const SENTRY_SCRUB_HOOKS = { beforeSend, beforeSendTransaction, beforeBreadcrumb };
