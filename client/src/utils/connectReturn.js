// The one place login may send a signed-out owner back to: the Claude consent page with a well-formed request id (connectReturn, connectLoginPath, connectRequestId).
//
// Spec 2026-11-19 section 7.2: a signed-out owner who opens the consent link
// is sent to log in and brought back, and the pending request's id is all
// that has to survive. The return rides in the login URL (?return=), so
// anyone can craft one; an open redirect on the login page is the failure
// this module exists to prevent. So nothing is parsed or normalized: the
// value must be exactly /connect-claude?request=<uuid>, as the server builds
// it (server/utils/connector/grants.js consentUrl), or it is refused. An
// absolute URL, a protocol-relative one, a backslash path, another path, a
// second parameter, a fragment and a malformed id are all refused by the one
// anchored pattern.

export const CONNECT_PATH = '/connect-claude';

// What login says when an account other than the admin signs in on the
// consent page's login link, or arrives there with another session.
export const CONNECT_WRONG_ACCOUNT = 'That account cannot approve Claude. Sign in with your admin account to continue.';

// The server's request-id shape (grants.js isRequestId): any UUID, either case.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETURN = /^\/connect-claude\?request=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The return path when `value` is exactly the consent page with a request id, else null. */
export function connectReturn(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  return RETURN.test(value) ? value : null;
}

/** The login path for a guard to redirect to: carries the return only for the consent page. */
export function connectLoginPath(pathAndSearch) {
  const ok = connectReturn(pathAndSearch);
  return ok ? `/login?return=${encodeURIComponent(ok)}` : '/login';
}

/** The request id from the consent page's query string, or null when missing or malformed. */
export function connectRequestId(search) {
  const id = new URLSearchParams(search || '').get('request');
  return id && UUID.test(id) ? id : null;
}
