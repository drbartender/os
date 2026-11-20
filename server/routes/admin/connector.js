'use strict';

// The Claude connector's admin routes under /api/admin/connector (spec 2026-11-19 section 7.2): the
// consent page's read, passkey options, approve and cancel, and the settings block's status, call
// list and disconnect. Every route is auth + adminOnly (a manager is refused), behind the flag.
//
// Approve trusts nothing the page sends but the request id and the passkey
// assertion: it reads the pending row itself (grants.approveRequest). The
// assertion goes through the same check as the phone unlock
// (webauthn.js verifyAssertionForUser), on a challenge bound to this admin
// that this router's assert-options issued, and mints no session or device
// token: webauthn.js's assert-verify stays the only site that mints the 12h
// token. The verifier is injectable (createConnectorAdminRouter) so the suites
// stub the assertion.
//
// Response shapes (the consent page and settings block, lane
// connector-signin-ui, build against these):
//   GET  /connector/requests/:id          -> { request, existing_connection }
//        404 CONNECTOR_REQUEST_NOT_FOUND; 410 CONNECTOR_REQUEST_USED,
//        CONNECTOR_REQUEST_CANCELLED or CONNECTOR_REQUEST_EXPIRED
//   POST /connector/assert-options        -> WebAuthn request options JSON, whose
//        allowCredentials names only this admin's passkeys;
//        409 CONNECTOR_PASSKEY_NONE when there is none
//   POST /connector/requests/:id/approve  { assertion } -> { redirect_url, replaced }
//        400 CONNECTOR_PASSKEY_REQUIRED or CONNECTOR_PASSKEY_EXPIRED;
//        409 CONNECTOR_PASSKEY_NONE; 403 CONNECTOR_PASSKEY_WRONG_ACCOUNT or
//        CONNECTOR_PASSKEY_FAILED; the 404/410 codes above
//   POST /connector/requests/:id/cancel   -> { redirect_url }; the 404/410 codes
//   GET  /connector/status                -> { connection, client_id, mcp_url,
//        address_check: 'on' | 'off' | 'unreadable' }
//   GET  /connector/calls?outcome=&refusals=0&all=&limit= -> { calls, has_more } (refusals listed by default)
//   POST /connector/disconnect            -> { ok: true, revoked }

const express = require('express');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { AppError, ValidationError } = require('../../utils/errors');
const grants = require('../../utils/connector/grants');
const callLog = require('../../utils/connector/callLog');
const { addressCheckState } = require('../../utils/connector/addressCheck');

// What the consent page lists as readable (spec 7.3), from the server so the
// page and the tools cannot disagree.
const READS = Object.freeze([
  'Who is waiting on you in the Inbox, and their recent messages',
  'Upcoming events and their staffing',
  'Bookings with an open balance',
  'Clients, proposals and events, by search or by id',
]);

const INVALID = {
  missing: () => new AppError('This sign-in request was not found.', 404, 'CONNECTOR_REQUEST_NOT_FOUND'),
  used: () => new AppError('This sign-in request was already used.', 410, 'CONNECTOR_REQUEST_USED'),
  cancelled: () => new AppError('This sign-in request was cancelled.', 410, 'CONNECTOR_REQUEST_CANCELLED'),
  expired: () => new AppError('This sign-in request has expired. Start again from Claude.', 410, 'CONNECTOR_REQUEST_EXPIRED'),
};
function invalid(reason) { return (INVALID[reason] || INVALID.missing)(); }

// The passkey refusals the consent page names, by the reason webauthn.js puts
// on the error (verifyAssertionForUser). Anything else is unexpected and goes
// to the error handler (a 500 and Sentry), never the try-again answer.
const PASSKEY_REFUSALS = {
  WEBAUTHN_NO_CREDENTIAL: [409, 'CONNECTOR_PASSKEY_NONE',
    'Your admin account has no passkey. Add one in Security settings, then try again.'],
  WEBAUTHN_WRONG_ACCOUNT: [403, 'CONNECTOR_PASSKEY_WRONG_ACCOUNT',
    'That passkey belongs to another account. Choose the passkey for your admin account.'],
  WEBAUTHN_USERHANDLE_MISMATCH: [403, 'CONNECTOR_PASSKEY_WRONG_ACCOUNT',
    'That passkey belongs to another account. Choose the passkey for your admin account.'],
  WEBAUTHN_UNKNOWN_CREDENTIAL: [403, 'CONNECTOR_PASSKEY_FAILED', 'The passkey check did not pass. Try again.'],
  WEBAUTHN_VERIFY_FAILED: [403, 'CONNECTOR_PASSKEY_FAILED', 'The passkey check did not pass. Try again.'],
  WEBAUTHN_COUNTER_REGRESSION: [403, 'CONNECTOR_PASSKEY_FAILED', 'The passkey check did not pass. Try again.'],
};
function passkeyRefusal(err) {
  if (err && err.code === 'WEBAUTHN_CHALLENGE_INVALID') {
    return new AppError('The passkey prompt expired. Try again.', 400, 'CONNECTOR_PASSKEY_EXPIRED');
  }
  if (err && err.code === 'VALIDATION_ERROR') {
    return new AppError('A passkey check is required.', 400, 'CONNECTOR_PASSKEY_REQUIRED');
  }
  const hit = err && err.reason && PASSKEY_REFUSALS[err.reason];
  return hit ? new AppError(hit[2], hit[0], hit[1]) : null;
}

function defaultVerifier() {
  return require('../webauthn').verifyAssertionForUser;
}

function createConnectorAdminRouter({ verifyPasskey, assertionOptions, now } = {}) {
  const router = express.Router();
  const clock = () => (now ? now() : new Date());
  const verify = verifyPasskey || ((response, userId) => defaultVerifier()(response, userId));
  const options = assertionOptions || ((userId) => require('../webauthn').assertionOptionsForUser(userId));

  // Every path here is 404 unless the flag is on (spec 7.1). Scoped to
  // /connector so the other admin routers sharing /api/admin never see it.
  router.use('/connector', (req, res, next) => (grants.connectorEnabled() ? next() : next('router')));

  // The pending request for the consent page: when and where it started, and the connection it would
  // replace
  router.get('/connector/requests/:id', auth, adminOnly, asyncHandler(async (req, res) => {
    const now = clock();
    const request = await grants.readRequest(req.params.id, now);
    if (!request) throw invalid('missing');
    if (request.status !== 'pending') throw invalid(request.status);
    const current = await grants.currentGrant(now);
    res.json({
      request: { ...request, reads: READS },
      existing_connection: current && current.state === 'live' ? current : null,
    });
  }));

  // WebAuthn options for the Allow step, the challenge bound to this admin
  router.post('/connector/assert-options', auth, adminOnly, asyncHandler(async (req, res) => {
    const opts = await options(req.user.id);
    if (!opts) {
      const [status, code, message] = PASSKEY_REFUSALS.WEBAUTHN_NO_CREDENTIAL;
      throw new AppError(message, status, code);
    }
    res.json(opts);
  }));

  // Allow: a fresh passkey assertion, then the grant and the single-use code in one transaction;
  // returns the URL that sends the browser back to Claude
  router.post('/connector/requests/:id/approve', auth, adminOnly, asyncHandler(async (req, res) => {
    if (!grants.isRequestId(req.params.id)) throw invalid('missing');
    const assertion = req.body && req.body.assertion;
    if (!assertion || typeof assertion !== 'object') {
      throw new AppError('A passkey check is required.', 400, 'CONNECTOR_PASSKEY_REQUIRED');
    }
    let ok;
    try {
      ok = await verify(assertion, req.user.id);
    } catch (err) {
      const refusal = passkeyRefusal(err);
      if (refusal) throw refusal;
      throw err; // unexpected (a database failure): the error handler and Sentry
    }
    if (ok !== true) throw new Error('connector passkey verifier resolved without a verdict');
    try {
      const result = await grants.approveRequest({ requestId: req.params.id, user: req.user, now: clock() });
      res.json({ redirect_url: result.redirectUrl, replaced: result.replaced });
    } catch (err) {
      if (err instanceof grants.RequestInvalidError) throw invalid(err.reason);
      throw err;
    }
  }));

  // Cancel: the request is spent and the browser goes back to Claude with access_denied
  router.post('/connector/requests/:id/cancel', auth, adminOnly, asyncHandler(async (req, res) => {
    try {
      const result = await grants.cancelRequest({ requestId: req.params.id, now: clock() });
      res.json({ redirect_url: result.redirectUrl });
    } catch (err) {
      if (err instanceof grants.RequestInvalidError) throw invalid(err.reason);
      throw err;
    }
  }));

  // The settings block: the connection (approved, last used, when it lapses) and the URL and client
  // id to enter in Claude
  router.get('/connector/status', auth, adminOnly, asyncHandler(async (req, res) => {
    res.json({
      connection: await grants.currentGrant(clock()),
      client_id: grants.CLIENT_ID,
      mcp_url: grants.publicMcpUrl(),
      address_check: addressCheckState(),
    });
  }));

  // The call log, newest first: tool calls, withheld pieces and refusals (refusals=0 leaves the
  // refusals out, all=1 adds everything, outcome= narrows), and has_more when rows exist past the limit
  router.get('/connector/calls', auth, adminOnly, asyncHandler(async (req, res) => {
    const q = req.query || {};
    const outcome = q.outcome === undefined || q.outcome === '' ? null : q.outcome;
    if (outcome !== null && !callLog.OUTCOMES.includes(outcome)) {
      throw new ValidationError({ outcome: 'Unknown outcome.' }, 'Unknown outcome.');
    }
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError({ limit: 'Limit must be 1 to 200.' }, 'Limit must be 1 to 200.');
    }
    const flag = (v) => v === '1' || v === 'true';
    const off = (v) => v === '0' || v === 'false';
    res.json(await callLog.listCalls({ limit, outcome, all: flag(q.all), refusals: !off(q.refusals) }));
  }));

  // Disconnect: revoke the grant and its tokens, write the audit entry; the call log stays
  router.post('/connector/disconnect', auth, adminOnly, asyncHandler(async (req, res) => {
    res.json({ ok: true, revoked: await grants.disconnect({ user: req.user }) });
  }));

  return router;
}

module.exports = createConnectorAdminRouter();
module.exports.createConnectorAdminRouter = createConnectorAdminRouter;
module.exports.READS = READS;
