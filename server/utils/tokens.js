// Canonical public-token shape validation. proposals/invoices/drink_plans tokens,
// users.calendar_token, payment_profiles.tip_page_token, and sms_messages.group_id are all
// Postgres UUID columns, so a non-UUID :param casts-and-throws (22P02) and surfaces as a 500
// + Sentry noise instead of a clean 404. Validate the shape up front, before any DB query.
//
// One definition shared across every public/token route — replaces the regex that was
// previously copy-pasted into invoices.js, proposals/public.js, proposals/publicToken.js,
// publicFeedback.js, publicTip.js, and stripeWebhook.js.
const { NotFoundError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/**
 * Express middleware factory: rejects with NotFoundError (404) when `req.params[param]` is
 * not a UUID, BEFORE the handler runs any query. Synchronous, so it routes the error via
 * next() (Express catches sync throws too, but next() keeps the contract explicit).
 * @param {string} param   route param to validate (default 'token')
 * @param {string} message 404 copy (default 'Not found')
 */
function requireUuidToken(param = 'token', message = 'Not found') {
  return (req, res, next) => {
    if (!isUuid(req.params[param])) return next(new NotFoundError(message));
    next();
  };
}

module.exports = { UUID_RE, isUuid, requireUuidToken };
