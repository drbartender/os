'use strict';

// The Claude connector's sign-in authority (spec 2026-11-19 section 7.2): the protected-resource and
// authorization-server metadata, GET /oauth/authorize (stores a pending request and sends the browser
// to the consent page) and POST /oauth/token (code exchange and refresh), behind the connector flag.
//
// Claude is a public client with one pre-registered id and one return address
// (grants.CLIENT_ID, grants.REDIRECT_URI); there is no registration endpoint,
// so the metadata advertises neither registration nor client id metadata
// documents, PKCE S256 only, and `none` as the token endpoint auth method.
// The protected-resource metadata's `resource` is the public /mcp URL built
// from API_URL, which must equal the URL entered in Claude. Claude sends the
// RFC 8707 `resource` parameter on authorize and token; when present it must
// name this server's /mcp URL (invalid_target otherwise).
//
// Authorize: a wrong client id or return address gets a plain error page and
// no redirect (an attacker must never be able to bounce a browser through
// us); any other fault, a missing PKCE challenge among them, goes back to
// Claude's return address with error=invalid_request. The state is optional
// and echoed on every redirect when present. The request
// itself never authenticates anyone: it only stores a pending row good for
// ten minutes, whose id alone travels to the consent page, where the owner
// must be signed in as the admin and approve with a passkey.
//
// Token: form-encoded (RFC 6749 4.1.3), behind the per-address ceiling,
// address-checked in production (a refusal logged once per address per
// window), limited per address, answering RFC 6749 errors (invalid_grant for a dead code or
// refresh token, which is what makes Claude ask to reconnect), no-store.
// Mounted in server/index.js ahead of the global parsers with its own.

const express = require('express');
const Sentry = require('@sentry/node');
const grants = require('../utils/connector/grants');
const tokens = require('../utils/connector/tokens');
const { addressAllowed } = require('../utils/connector/addressCheck');
const callLog = require('../utils/connector/callLog');
const {
  connectorAddressCeilingLimiter, connectorAuthorizeLimiter, connectorTokenLimiter,
} = require('../middleware/rateLimiters');

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_STATE = 1024;

function protectedResourceMetadata() {
  return {
    resource: grants.publicMcpUrl(),
    authorization_servers: [grants.issuer()],
    bearer_methods_supported: ['header'],
    resource_name: 'Dr. Bartender OS',
  };
}

function authorizationServerMetadata() {
  const iss = grants.issuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

// A plain page for a request we will not redirect. Echoes nothing it was sent.
function errorPage(res, status, message) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(
    '<!doctype html><html><head><meta charset="utf-8"><title>Sign-in request refused</title></head>'
    + `<body><h1>Sign-in request refused</h1><p>${message}</p></body></html>`
  );
}

function oneString(v) {
  return typeof v === 'string' ? v : undefined;
}

function createConnectorOauthRouter({ now } = {}) {
  const router = express.Router();
  const clock = () => (now ? now() : new Date());

  // Every path here is 404 unless the flag is on (spec 7.1).
  router.use('/oauth', (req, res, next) => (grants.connectorEnabled() ? next() : next('router')));
  router.use('/.well-known', (req, res, next) => (grants.connectorEnabled() ? next() : next('router')));

  // RFC 9728 protected-resource metadata, at the path-inserted location Claude
  // reads from the 401's resource_metadata pointer
  router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(protectedResourceMetadata());
  });

  // The same document at the root location, the fallback probe for a client
  // that never saw the 401
  router.get('/.well-known/oauth-protected-resource', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(protectedResourceMetadata());
  });

  // RFC 8414 authorization-server metadata: the endpoints, S256 only, public client
  router.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(authorizationServerMetadata());
  });

  // Validate the request, store it as a pending row (10 minutes), send the browser to the consent
  // page with only the row's id
  router.get('/oauth/authorize', connectorAuthorizeLimiter, async (req, res, next) => {
    try {
      const q = req.query || {};
      const clientId = oneString(q.client_id);
      const redirectUri = oneString(q.redirect_uri);
      if (clientId !== grants.CLIENT_ID || redirectUri !== grants.REDIRECT_URI) {
        return errorPage(res, 400, 'This sign-in request is not from the client this server knows.');
      }
      const state = oneString(q.state);
      const back = (error, description) => {
        const u = new URL(redirectUri);
        u.searchParams.set('error', error);
        if (description) u.searchParams.set('error_description', description);
        if (state) u.searchParams.set('state', state);
        return res.set('Cache-Control', 'no-store').redirect(302, u.toString());
      };
      if (oneString(q.response_type) !== 'code') return back('unsupported_response_type', 'Only the code flow is supported.');
      const challenge = oneString(q.code_challenge);
      if (!challenge || !CHALLENGE.test(challenge)) return back('invalid_request', 'A PKCE code challenge is required.');
      if (oneString(q.code_challenge_method) !== 'S256') return back('invalid_request', 'The code challenge method must be S256.');
      // State is optional (OAuth 2.1: PKCE S256 carries the CSRF protection), and
      // a sign-in must not die because a client sends none. When present it is
      // stored and echoed on every redirect; when absent, redirects carry none.
      if (state !== undefined && state.length > MAX_STATE) return back('invalid_request', 'The state value is too long.');
      const resource = oneString(q.resource);
      if (q.resource !== undefined && (!resource || !grants.sameResource(resource, grants.publicMcpUrl()))) {
        return back('invalid_target', 'The resource is not this server.');
      }
      const id = await grants.createRequest({
        clientId,
        redirectUri,
        codeChallenge: challenge,
        state: state || null,
        resource,
        callerAddress: req.ip,
        userAgent: req.get('user-agent'),
      }, clock());
      return res.set('Cache-Control', 'no-store').redirect(302, grants.consentUrl(id));
    } catch (err) {
      return next(err);
    }
  });

  // Exchange a code (PKCE-checked, bound to the client id and return address) or rotate a refresh
  // token, form-encoded, answering RFC 6749 errors
  router.post(
    '/oauth/token',
    connectorAddressCeilingLimiter,
    async (req, res, next) => {
      if (addressAllowed(req)) return next();
      await callLog.recordRefusal({ callerAddress: req.ip, method: 'oauth/token', outcome: 'refused_address' });
      return res.status(403).json({ error: 'access_denied', error_description: 'This address may not call the token endpoint.' });
    },
    connectorTokenLimiter,
    express.urlencoded({ extended: false, limit: '16kb' }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');
      const b = req.body || {};
      const fail = (status, error, description) => res.status(status).json({ error, error_description: description });
      try {
        if (oneString(b.client_id) !== grants.CLIENT_ID) return fail(401, 'invalid_client', 'Unknown client.');
        const resource = oneString(b.resource);
        if (b.resource !== undefined && (!resource || !grants.sameResource(resource, grants.publicMcpUrl()))) {
          return fail(400, 'invalid_target', 'The resource is not this server.');
        }
        const opts = { now: clock(), onReplay: grants.onReplayRevoked, onActivated: grants.onGrantActivated };
        let body;
        if (b.grant_type === 'authorization_code') {
          body = await tokens.exchangeCode({
            code: oneString(b.code),
            codeVerifier: oneString(b.code_verifier),
            redirectUri: oneString(b.redirect_uri),
            clientId: grants.CLIENT_ID,
            resource,
          }, opts);
        } else if (b.grant_type === 'refresh_token') {
          body = await tokens.refreshTokens({
            refreshToken: oneString(b.refresh_token),
            clientId: grants.CLIENT_ID,
            resource,
          }, opts);
        } else {
          return fail(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
        }
        return res.status(200).json(body);
      } catch (err) {
        if (err instanceof tokens.OAuthError) return fail(err.status, err.oauthError, err.message);
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, { tags: { component: 'connector', route: 'oauth_token' } });
        }
        console.error('[connector] token route failed:', err && err.message);
        return fail(500, 'server_error', 'The token request could not be completed.');
      }
    }
  );

  // The body parser's refusals on the token route, as OAuth errors.
  router.use('/oauth', (err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.type === 'entity.parse.failed')) {
      return res.status(400).set('Cache-Control', 'no-store').json({ error: 'invalid_request', error_description: 'The request body could not be read.' });
    }
    return next(err);
  });

  return router;
}

module.exports = createConnectorOauthRouter();
module.exports.createConnectorOauthRouter = createConnectorOauthRouter;
module.exports.protectedResourceMetadata = protectedResourceMetadata;
module.exports.authorizationServerMetadata = authorizationServerMetadata;
