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
// The client menu proof (spec 2026-10-19 section 18): the segment after
// /menu-proof/ is a UUID that is the page's only credential, in the page URL,
// the Referer and all three API calls. The server's rule, here also with
// percent-encoded separators and in either case.
const MENU_PROOF_PATH = /(?:\/|%2F)menu-proof(?:\/|%2F)[^/?#&%\s"'<>]+/gi;

// Every other public token (2026-11-16). Naming token paths here was the
// server's mistake again: this scrub named only the menu proof, so every other
// token page (proposal, invoice, drink plan, compare, shopping list, tip,
// feedback) and every token API call it makes reached Sentry raw. So a token
// is redacted by VALUE: every UUID and every JWT, in any string. Every token
// the system mints for a URL is one or the other; the path rules below are
// for the ones that are neither (reset-password is hex, verify-email is
// base64url), and mirror the server's. sentryScrub.tokenRoutes.test.js lists
// every App.js route with a token parameter and fails on a new one until it
// says which shape its token has.
//
// The UUID rule has no guard on its neighbours: a token glued to a letter is
// still a token, and a percent-encoded redirect puts the F of %2F right
// against it (next=%2Fcompare%2F<uuid>). Nothing UUID-shaped is worth keeping;
// Sentry's own ids are 32 hex with no dashes, so they stay readable.
//
// No lookbehind anywhere in this file: a browser without it (Safari before
// 16.4) throws a SyntaxError parsing the literal, the module never loads, and
// index.js imports it, so the app would not start.
const UUID_VALUE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Three base64url segments, the header opening eyJ (`{"`): the cover-swap and
// unsubscribe links. Linear for the server's two reasons: a JWT starts only at
// the start, after a character outside base64url, or after a percent-encoded
// byte (the F of %2F), so an eyJ inside a run never starts a scan; and every
// segment is bounded. Unanchored, a string of eyJ repeated was quadratic,
// seconds of main thread at 100 KB. A JWT glued to a letter is not caught.
const JWT_VALUE = /(^|[^A-Za-z0-9_-]|%[0-9A-Fa-f]{2})eyJ[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,1024}/g;
// A Stripe client secret by value: confirmPayment returns to the token page
// with payment_intent_client_secret=pi_..._secret_... in its query (the
// proposal's PaymentForm and the drink plan's ConfirmationStep), and the page
// stays on that URL.
const CLIENT_SECRET_VALUE = /(?:pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g;
// A non-UUID token's path, with percent-encoded separators as above.
const TOKEN_PATH = /(?:\/|%2F)(t|tip|unsubscribe|reset-password|verify-email|cover-swaps)(?:\/|%2F)[^/?#&%\s"'<>]+/gi;
// A token in a query string (?token=, &token=, or percent-encoded).
const TOKEN_QUERY = /([?&]|%3F|%26)token(=|%3D)[^&#%\s"'<>]+/gi;
// The Claude connector (spec 2026-11-19 law 8), the server's two rules
// (server/utils/sentryScrub.js). Its tokens and sign-in codes by their fixed
// prefix (server/utils/connector/tokens.js): the consent page holds the return
// address with a code in it, and the navigation to it lands in a crumb.
const CONNECTOR_TOKEN_VALUE = /drbc_[A-Za-z0-9_-]+/g;
// The sign-in values with no prefix (state, code, code_challenge,
// code_verifier) by parameter name, in a query, percent-encoded, or at the
// start of a bare form body. The value runs to the next separator, plain or
// encoded, so an encoded byte inside it does not end the redaction early. A
// value another rule already redacted (it opens with [) is left as it is.
const OAUTH_PARAM_VALUE = /(^|[?&]|%3F|%26)(state|code|code_challenge|code_verifier)(=|%3D)(?!\[)(?:(?!%26|%23)[^&#\s"'<>])+/gi;

const MAX_DEPTH = 24;
const MAX_NODES = 20000;

export function scrubText(s) {
  return String(s)
    .replace(INBOX_P_PATH, '/inbox/p-[redacted]')
    .replace(MENU_PROOF_PATH, '/menu-proof/[redacted]')
    .replace(TOKEN_PATH, (m, seg) => `/${seg.toLowerCase()}/[redacted]`)
    .replace(TOKEN_QUERY, '$1token$2[redacted]')
    .replace(CONNECTOR_TOKEN_VALUE, '[redacted-connector-token]')
    .replace(OAUTH_PARAM_VALUE, '$1$2$3[redacted]')
    // The token values after the path rules, so those keep their markers, and
    // BEFORE the phone rules: a plus sign (an encoded space) before a UUID that
    // opens with seven digits reads as an E.164 number, and the number marker
    // would eat the first group and leave the rest of the token for nothing.
    .replace(UUID_VALUE, '[redacted-uuid]')
    .replace(JWT_VALUE, '$1[redacted-jwt]')
    .replace(CLIENT_SECRET_VALUE, '[redacted-client-secret]')
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
