// Box-side validation of a leased job before anything is typed (spec law 9).
// The server already validated the body at enqueue; this is the last check
// before Dallas's own Google account posts it, so it is deliberately narrow:
// a US E.164 number, one line of at most 320 characters, and exactly one
// proposal link, the canonical public one. The link host is fixed to prod on
// purpose: a dev server (PUBLIC_SITE_URL=localhost) can never make the box
// post a link from this account.
//
// It also reads the job's prior_bodies (the bodies of this proposal's earlier
// posts the box worked on this conversation) into the bounded, normalized list
// the already-in-the-thread check compares against.

const BODY_MAX = 320;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// The canonical link; the token may not run on into more token characters.
const LINK_RE = new RegExp(`https://drbartender\\.com/proposal/(${UUID})(?![0-9A-Za-z_-])`, 'g');
// Any proposal path at all, on any host or none: every one counts toward "exactly one".
const PATH_RE = /\/proposal\//gi;
// Line feed, carriage return, vertical tab, form feed, next line, line and paragraph separators.
const LINE_BREAK_RE = /[\n\r\v\f\u{0085}\u{2028}\u{2029}]/u;
const PHONE_RE = /^\+1\d{10}$/;
// Thumbtack negotiation ids are digits today; the column is VARCHAR(100).
const NEGOTIATION_RE = /^[A-Za-z0-9_-]{1,100}$/;

function validPhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone);
}

// The proposal token the body links to, or null unless the body carries
// exactly one proposal path and it is the canonical link.
function proposalToken(body) {
  if (typeof body !== 'string') return null;
  const paths = (body.match(PATH_RE) || []).length;
  const tokens = [...body.matchAll(LINK_RE)].map((m) => m[1]);
  return paths === 1 && tokens.length === 1 ? tokens[0] : null;
}

// One whitespace rule for every body comparison: each whitespace run is one
// space, and the ends are trimmed (GV re-renders a message, it does not keep
// its exact spacing).
function normalizeText(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

// The server sends at most 10, newest first.
const PRIOR_BODIES_MAX = 10;

// The job's prior_bodies as a normalized list. Missing, not an array, or
// holding anything but strings is an empty list: an older server sends none,
// and an empty list means any token in the thread skips, today's safe side.
// More than the bound keeps the newest ones: a shorter list only skips more.
function priorBodies(raw) {
  if (!Array.isArray(raw) || raw.some((b) => typeof b !== 'string')) return [];
  return raw.slice(0, PRIOR_BODIES_MAX).map(normalizeText);
}

function validateJob({ phone, body, negotiation_id } = {}) {
  if (!validPhone(phone)) return { ok: false, reason: 'invalid_number' };
  if (typeof body !== 'string' || !body.trim() || body.length > BODY_MAX
    || LINE_BREAK_RE.test(body) || !proposalToken(body)) {
    return { ok: false, reason: 'invalid_body' };
  }
  // The wrong_thread check looks for this id among the thread's notices; a job
  // without one would skip that check silently, so it never runs.
  if (!NEGOTIATION_RE.test(String(negotiation_id == null ? '' : negotiation_id))) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  return { ok: true };
}

module.exports = {
  validateJob, proposalToken, validPhone, normalizeText, priorBodies, BODY_MAX, PRIOR_BODIES_MAX,
};
