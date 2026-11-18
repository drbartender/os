// server/utils/sentryScrub.js
//
// 'use strict' is load-bearing, not habit: in sloppy mode a failed assignment
// or delete on a frozen attributes object is SILENT, which would turn this
// module's whole job into a no-op without a single symptom. Strict mode makes
// that throw, and scrubSpanData converts the throw into a fail-CLOSED result.
'use strict';
//
// Telemetry redaction for Sentry events. Extracted from server/index.js so it
// can be TESTED: index.js starts the app on require, so the hooks that live
// there can only ever be eyeballed, and eyeballing is exactly how a bearer
// token reached a third-party vendor unnoticed (security-review 2026-08-11).
//
// Two pipelines, and they do NOT share a hook. `beforeSend` is typed for ERROR
// events only; performance/transaction events go through `beforeSendTransaction`
// and were unscrubbed entirely. Worse, a transaction carries the URL in places
// an error never does: OpenTelemetry span attributes land verbatim in
// `event.contexts.trace.data`, which the Sentry performance UI renders by
// default.
//
// READ THIS BEFORE EDITING. A live token escaped through here THREE times in
// one review, and all three were the same mistake in different clothes: the
// defense named the fields it expected to be dangerous, and something else was.
// First the hook itself (errors only). Then the span attributes. Then, after
// `http.url`/`http.target` were added, a BARE `url` key that Sentry's own OTel
// bridge derives from `url.full`. So nothing here enumerates fields anymore:
// scrubSpanData walks EVERY string attribute, and both hooks run the same
// request scrub. Keep it that way. If you find yourself adding a key name to a
// list to fix a leak, you are writing the fourth one.
//
// The token PATHS were the same mistake a fourth time: scrubUrl named the
// routes it knew, and nine token routes added since went past it (the calendar
// feed, the three payment-intent routes, the compare group, the client portal,
// the invoice list, feedback, the quote draft), so sampled spans carried live
// tokens (2026-11-16). So a token is now redacted by VALUE: every UUID and
// every JWT, wherever scrubUrl runs. Every token this system mints for a URL
// is one or the other; a path rule below is only for a token that is neither
// (hex or base64url), and the markers they write keep their shape.
// sentryScrub.tokenRoutes.test.js lists every route with a token parameter and
// fails on a new one until it says which shape its token has.

// A UUID by value, either case, with no guard on its neighbours: a token glued
// to a letter is still a token, and a percent-encoded redirect puts the F of
// %2F right against it (next=%2Fcompare%2F<uuid>). Nothing UUID-shaped is
// worth keeping. Sentry's own ids are 32 hex with no dashes and a git sha has
// none either, so both stay readable. The same rule as the browser scrub
// (client/src/utils/sentryScrub.js).
const UUID_VALUE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// A JWT by value: three base64url segments, the header opening eyJ (`{"`).
// The cover-swap link and the unsubscribe link carry one. Two things keep it
// linear, and both are load-bearing (review 2026-11-16). A JWT starts only at
// the start, after a character outside base64url, or after a percent-encoded
// byte (the F of %2F sits right against it in an encoded redirect), so an eyJ
// INSIDE a run never starts a match: unanchored, a request path of eyJ repeated
// started a scan every three characters, quadratic, and one crafted 16 KB URL
// held the event loop for most of a second across a sampled transaction's
// fields (a sentry-trace header can force the sampling); bounded but
// unanchored, it still cost about a hundred times main. And every segment is
// bounded. A JWT glued to a letter is not caught; no URL or header puts one
// there. The leading character is captured, not looked behind, as in the
// browser scrub.
const JWT_VALUE = /(^|[^A-Za-z0-9_-]|%[0-9A-Fa-f]{2})eyJ[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,1024}/g;
// A Stripe client secret by value (pi_..._secret_..., seti_..._secret_...).
// Stripe appends payment_intent_client_secret to a payment's return URL, so
// the token page carries it after a card payment; the server sees it only in a
// Referer, but a value rule costs nothing and matches the browser's.
const CLIENT_SECRET_VALUE = /(?:pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g;

/** Public token segments and query-string tokens, redacted out of any URL. */
const scrubUrl = (u) => {
  if (!u) return u;
  return String(u)
    // Each segment rule stops at whitespace and quotes too: scrubUrl also runs
    // over an error's message and extra, where the path is followed by words.
    .replace(/\/t\/[^/?#\s"'<>]+/g, '/t/[redacted]')
    .replace(/\/api\/public\/tip\/[^/?#\s"'<>]+/g, '/api/public/tip/[redacted]')
    .replace(/\/tip\/[^/?#\s"'<>]+/g, '/tip/[redacted]')
    .replace(/\/unsubscribe\/[^/?#\s"'<>]+/g, '/unsubscribe/[redacted]')
    // The three tokens below are neither UUIDs nor JWTs, so their path rule is
    // the only one that sees them: either case, and with percent-encoded
    // separators too (a next= or redirect parameter carries the path encoded).
    .replace(/(?:\/|%2F)reset-password(?:\/|%2F)[^/?#&%\s"'<>]+/gi, '/reset-password/[redacted]')
    // The staff email-change link: a base64url token on the page path (it
    // reaches the server only as a Referer, and headers are dropped below, but
    // the page path is the one place it rides).
    .replace(/(?:\/|%2F)verify-email(?:\/|%2F)[^/?#&%\s"'<>]+/gi, '/verify-email/[redacted]')
    // The cover-swap link: a signed JWT is the whole authorization for the
    // swap; the JWT rule below catches it too.
    .replace(/\/cover-swaps\/[^/?#\s"'<>]+/gi, '/cover-swaps/[redacted]')
    // The Telegram webhook: the path segment IS the webhook secret (48 hex,
    // server/routes/telegram.js), the same value as the secret-token header,
    // on a route that places billed calls.
    .replace(/(?:\/|%2F)api(?:\/|%2F)telegram(?:\/|%2F)[^/?#&%\s"'<>]+/gi, '/api/telegram/[redacted]')
    // The Telegram BOT token, in the path of every outgoing Bot API call
    // (https://api.telegram.org/bot<id>:<secret>/<method>, server/utils/
    // telegram.js): the fetch breadcrumb and the outgoing span keep that path.
    // Whoever holds it runs the bot, and getWebhookInfo hands back the webhook
    // secret above. The same reason as the Account SID rule below.
    .replace(/\/bot\d+(?::|%3A)[A-Za-z0-9_-]+/gi, '/bot[redacted]')
    // The client menu proof (spec 2026-10-19 section 18): the UUID after
    // /menu-proof/ is the page's only credential, on the page URL (a Referer)
    // and on /api/menu-proof/<token>, its /image and its /answer. Whoever holds
    // it can see the client's menu and note and give the one answer.
    // Case-insensitive, because Express matches paths that way.
    .replace(/\/menu-proof\/[^/?#\s"'<>]+/gi, '/menu-proof/[redacted]')
    // The listen token IS the auth on a route that streams a client's recorded
    // voice, so it must never come to rest in telemetry (spec 2026-08-10).
    .replace(/\/api\/voice\/vm\/[^/?#\s"'<>]+/g, '/api/voice/vm/[redacted]')
    // An Inbox person key for an unknown number is p- plus the last ten digits
    // of the phone (spec 2026-10-06), so every /api/admin/inbox/p-... URL
    // carries a phone number. Not a token, but it must never come to rest in
    // telemetry either. Case-insensitive because Express matches paths that
    // way, so /INBOX/p-... still reaches the route. c- and s- keys are row ids,
    // not phones, and stay readable.
    .replace(/\/inbox\/p-\d+/gi, '/inbox/p-[redacted]')
    .replace(/[?&]token=[^&#\s"'<>]+/g, (m) => m[0] + 'token=[redacted]')
    // Twilio Account SID. Not a public token: it is the basic-auth USERNAME on
    // the media fetch, so it is half a credential pair, and it rides in the
    // outgoing-request URL that instrumentation records on spans and
    // breadcrumbs (fix-list 16). The Recording SID is deliberately left: it is
    // useless without the credential pair and it is what makes a trace
    // debuggable.
    // The lookbehind is load-bearing, not defensive habit. Unanchored, any
    // internal `ac` inside a longer hex run with 32 hex chars after it starts a
    // match and eats 34 characters: measured against 20k random SHA-256
    // digests, that partially destroyed 11.5% of them (and ~2.7% of 40-char git
    // SHAs). Twilio SIDs are structurally immune either way (a Recording or
    // Call SID is only 34 chars, so an internal `ac` never has 32 hex left),
    // but a hash in a span attribute is not. Dropping /i is right on its own:
    // Account SIDs are always uppercase AC + lowercase hex, so /i bought
    // nothing but false positives.
    .replace(/(?<![0-9a-zA-Z])AC[0-9a-f]{32}(?![0-9a-zA-Z])/g, '[redacted-account-sid]')
    // By value, last, so the path rules above keep their markers.
    .replace(UUID_VALUE, '[redacted-uuid]')
    .replace(JWT_VALUE, '$1[redacted-jwt]')
    .replace(CLIENT_SECRET_VALUE, '[redacted-client-secret]');
};

/**
 * Span-attribute keys known to carry a URL or path. This list is DOCUMENTATION,
 * not the defense: scrubSpanData below scrubs by VALUE, over every string
 * attribute. Enumerating keys is what failed here three times running --
 * `beforeSend` missed transactions entirely, then `http.url`/`http.target` were
 * added and Sentry's OTel bridge turned out to derive a BARE `url` key plus
 * `http.query`/`http.fragment` in getRequestSpanData
 * (@sentry/opentelemetry), and each miss shipped a live listen token to a
 * third-party vendor. A key allowlist can only ever be as current as the last
 * SDK upgrade; the value check cannot silently fall behind one.
 */
const SPAN_URL_KEYS = ['url', 'http.url', 'http.target', 'url.full', 'url.path',
                       'url.query', 'http.query', 'http.fragment'];

/** Query-string token redaction that does NOT require a leading `?` or `&`.
 *  `http.query` is `url.search`, which carries the `?` in some SDK versions and
 *  not others, so the prefix must not be load-bearing. */
const scrubBareQuery = (v) => String(v).replace(/token=[^&]+/g, 'token=[redacted]');

/**
 * scrubUrl applied to a value of any shape, not just a top-level string.
 *
 * The console integration builds `data.arguments` as an ARRAY of the logged
 * values, so a `console.log` of a link puts the URL one container deep, where a
 * `typeof === 'string'` test cannot see it. Missing that would have been the
 * module's own signature failure a fourth time: handle the field you thought
 * of, miss the sibling holding the same data in a different shape.
 *
 * Depth-capped because this walks structures we did not author. Sentry has
 * already normalized them (depth-limited, no cycles), so the cap is a belt on
 * top of that, not the only thing preventing a runaway.
 */
function scrubValue(v, depth = 0) {
  if (typeof v === 'string') return scrubUrl(v);
  if (depth >= 3 || v === null || typeof v !== 'object') return v;
  // Binary is skipped for COST, not safety: Object.keys on a Buffer enumerates
  // one key per BYTE, so a logged 200KB buffer turned this into a 60ms pass on
  // a hook that runs per event. It can hold no URL worth scrubbing anyway,
  // since every value inside is a number.
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  for (const k of Object.keys(v)) {
    // Write ONLY on a real change. Under strict mode any assignment to a
    // non-writable property throws, including one writing back an identical
    // value -- so without this guard a frozen sub-object holding nothing but
    // numbers would blow up the whole attribute bag into the fail-closed
    // marker. Fail-closed is right when there was something to redact and
    // pure loss when there was not.
    const next = scrubValue(v[k], depth + 1);
    if (next !== v[k]) v[k] = next;
  }
  return v;
}

/**
 * Redact URL-bearing span attributes in place, BY VALUE.
 *
 * Every string attribute goes through scrubUrl, which is a no-op on anything
 * that does not contain one of the public-token path shapes, so scrubbing
 * indiscriminately costs a regex pass and cannot damage an unrelated attribute
 * (`http.method`, `db.system`, a span status). Attributes whose key names a
 * query string additionally get the prefix-free rule, and captured request
 * headers are dropped wholesale the way scrubRequest drops event.request.headers.
 *
 * RETURNS the container, and callers must assign it back. Reading every key
 * means touching attributes we did not author, so a throwing getter or a frozen
 * object is now reachable. Either one must fail CLOSED: an exception escaping a
 * Sentry hook makes the SDK DISCARD the event (verified against a real
 * envelope, security-review 2026-08-11), and a silently-unscrubbed object would
 * ship the token. So an unscrubbable container is replaced wholesale with a
 * marker: we lose the span's attributes, which is the cheap half of the trade.
 */
function scrubSpanData(data) {
  if (!data) return data;
  try {
    for (const key of Object.keys(data)) {
      // The OTel http instrumentation can capture request headers as individual
      // attributes, which re-carries exactly what scrubRequest deletes.
      if (key.startsWith('http.request.header.') || key.startsWith('http.response.header.')) {
        delete data[key];
        continue;
      }
      // Same no-op-write guard as scrubValue, for the same strict-mode reason.
      const scrubbed = scrubValue(data[key]);
      if (scrubbed !== data[key]) data[key] = scrubbed;
      if (key === 'http.query' || key.endsWith('query_string')) {
        const q = scrubBareQuery(data[key]);
        if (q !== data[key]) data[key] = q;
      }
    }
    return data;
  } catch {
    return { 'sentry.scrub_failed': true };
  }
}

/** Tag an event whose scrub had to fail closed, so it is filterable in Sentry
 *  rather than something you notice by opening the right span by chance. */
function markScrubFailed(event, container) {
  if (container && container['sentry.scrub_failed']) {
    event.tags = { ...(event.tags || {}), scrub_failed: 'true' };
  }
  return container;
}

/**
 * Breadcrumbs, on BOTH pipelines (they ride on error events too).
 *
 * No listen token can reach a breadcrumb today: Node breadcrumbs come only from
 * OUTGOING http/fetch, child_process, and console, incoming requests make none,
 * nothing server-side fetches its own listen URL, and no console statement
 * prints the link. This is here anyway because "that surface is unreachable" is
 * the exact reasoning that produced all three leaks -- one console.log of a
 * link would ship it with nothing to catch it. It also covers a real live leak
 * of a different kind: outgoing-request breadcrumbs carry the Twilio media URL,
 * which embeds the Account SID (the basic-auth username).
 */
function scrubBreadcrumbs(event) {
  if (!Array.isArray(event.breadcrumbs)) return;
  event.breadcrumbs.forEach((b) => {
    if (b && typeof b.message === 'string') b.message = scrubUrl(b.message);
    if (b && b.data) b.data = markScrubFailed(event, scrubSpanData(b.data));
  });
}

/**
 * Shared request-shaped redaction for BOTH pipelines. The body belongs here,
 * not on the error hook alone: the Node SDK captures a request body on every
 * instrumented request, so with transactions sampled a POST /api/auth/login
 * was shipping the plaintext password roughly one time in ten while an error
 * on the same route redacted it.
 */
function scrubRequest(event) {
  if (event.request?.data) event.request.data = '[redacted]';
  // Cookies are a SEPARATE field from the headers block deleted below.
  if (event.request?.cookies) delete event.request.cookies;
  if (event.request?.url) event.request.url = scrubUrl(event.request.url);
  if (event.request?.query_string) {
    // The name rule, then the value rules: a UUID under any other parameter
    // name is redacted here as it is in request.url.
    event.request.query_string = scrubUrl(scrubBareQuery(event.request.query_string));
  }
  // Drop request headers entirely: the default scrub list misses
  // x-thumbtack-secret and friends.
  if (event.request) delete event.request.headers;
}

/**
 * The text an error event carries outside the request (review 2026-11-16): its
 * message, each exception's value, every tag and the extra block. A call site
 * that puts a raw URL there ships a token page's token: server/index.js's
 * upload_limit_exceeded puts req.originalUrl in extra.path, and an error's own
 * text can quote a URL or a value. By value, through scrubUrl, so an id or a
 * count is untouched; the extra block goes through scrubSpanData, the same
 * walk with the same fail-closed marker.
 */
function scrubErrorText(event) {
  if (typeof event.message === 'string') event.message = scrubUrl(event.message);
  else if (event.message && typeof event.message.formatted === 'string') {
    event.message.formatted = scrubUrl(event.message.formatted);
  }
  for (const ex of event.exception?.values || []) {
    if (ex && typeof ex.value === 'string') ex.value = scrubUrl(ex.value);
  }
  if (event.tags && typeof event.tags === 'object') {
    for (const k of Object.keys(event.tags)) {
      if (typeof event.tags[k] === 'string') event.tags[k] = scrubUrl(event.tags[k]);
    }
  }
  if (event.extra) event.extra = markScrubFailed(event, scrubSpanData(event.extra));
}

/** `beforeSend` (ERROR events). */
function scrubErrorEvent(event) {
  scrubRequest(event);
  scrubBreadcrumbs(event);
  scrubErrorText(event);
  // Error events are believed to carry no span DATA (spanToTraceContext returns
  // ids only), but "believed to carry no" is exactly the assumption that cost
  // three leaks, and scrubbing an absent field is free.
  if (event.contexts?.trace) {
    event.contexts.trace.data = markScrubFailed(event, scrubSpanData(event.contexts.trace.data));
  }
  // Express resolves the name to the `:token` pattern before an error event is
  // built, so this is symmetry hardening rather than a live leak -- but the
  // asymmetry itself is the bug pattern this module keeps getting bitten by.
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  return event;
}

/**
 * `beforeSendTransaction` (PERFORMANCE events). Beyond the request block, the
 * transaction NAME can be a raw path (the Express instrumentation only rewrites
 * it to the `:token` pattern once it resolves a route, so a 404 or a
 * rate-limited request keeps the raw URL), and the span attributes carry it
 * regardless.
 */
function scrubTransactionEvent(event) {
  scrubRequest(event);
  scrubBreadcrumbs(event);
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.tags?.route) event.tags.route = scrubUrl(event.tags.route);
  if (event.contexts?.trace) {
    event.contexts.trace.data = markScrubFailed(event, scrubSpanData(event.contexts.trace.data));
  }
  if (Array.isArray(event.spans)) {
    event.spans.forEach((s) => {
      s.data = markScrubFailed(event, scrubSpanData(s.data));
      // Nothing on this route puts a request URL in a span description today
      // (the pg span carries PARAMETERIZED sql, so `$1` not the token), but it
      // costs nothing to cover an instrumentation change.
      if (typeof s.description === 'string') s.description = scrubUrl(s.description);
    });
  }
  return event;
}

module.exports = { scrubUrl, scrubErrorEvent, scrubTransactionEvent, SPAN_URL_KEYS };
