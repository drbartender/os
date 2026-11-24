'use strict';

// The Claude connector's per-call check (spec 2026-11-19 section 7.2 and law 5): an access token is
// looked up by hash and admitted only with a live grant, an admin user and an unchanged
// token_version; anything else gets 401 with the resource_metadata pointer.
//
// This is the only code that accepts a connector token, and it accepts nothing
// else: an admin session JWT is not one of our prefixed tokens and is refused
// before any lookup. middleware/auth.js is untouched and refuses a connector
// token in turn (jwt.verify fails), so the two credentials never cross.
//
// The 401 carries a WWW-Authenticate challenge naming the resource_metadata URL, which is
// what starts sign-in in Claude (a 200 carrying a tool error never does), plus
// error="invalid_token" when a token was presented. The refusal is written to
// the call log with the caller's address and no grant, once per address per window.

const { pool } = require('../../db');
const grants = require('./grants');
const tokens = require('./tokens');
const callLog = require('./callLog');
const { callerAddress } = require('./addressCheck');

const STATE_REASON = {
  revoked: 'grant_revoked',
  expired: 'grant_lapsed',
  lapsed: 'grant_lapsed',
  pending: 'grant_pending',
  no_longer_admin: 'not_admin',
  signed_out: 'token_version',
};

// Touch the grant's last use at most once a minute, so the idle lapse moves
// without a write on every call.
const TOUCH_EVERY_MS = 60 * 1000;

const LOOKUP_ACCESS = `
  SELECT t.id AS token_id, t.expires_at AS token_expires_at, t.revoked_at AS token_revoked_at,
         g.id, g.user_id, g.token_version, g.created_at, g.activated_at, g.expires_at, g.last_used_at, g.revoked_at,
         u.role, u.token_version AS user_token_version
    FROM connector_tokens t
    JOIN connector_grants g ON g.id = t.grant_id
    JOIN users u ON u.id = g.user_id
   WHERE t.token_hash = $1 AND t.kind = 'access'`;

// The bearer credential of a request, or null.
function bearerFrom(req) {
  const h = req.headers && req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * Check one access token. Resolves { ok: true, grantId, userId } or
 * { ok: false, reason } (reason is for the log and the suites, never the
 * response). `now` is injectable for the lifetime suites.
 */
async function checkAccessToken(raw, { now = new Date(), db = pool } = {}) {
  if (!raw) return { ok: false, reason: 'no_token' };
  if (!tokens.hasShape(raw, tokens.ACCESS_PREFIX)) return { ok: false, reason: 'not_connector_token' };
  const r = await db.query(LOOKUP_ACCESS, [tokens.hashToken(raw)]);
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'unknown_token' };
  if (row.token_revoked_at) return { ok: false, reason: 'token_revoked' };
  if (new Date(row.token_expires_at) <= now) return { ok: false, reason: 'token_expired' };
  // The one rule (grants.grantState): lifetimes, revocation, the user still an
  // admin and token_version unchanged; the settings block shows the same.
  const state = grants.grantState(row, now);
  if (state !== 'live') return { ok: false, reason: STATE_REASON[state] || state };
  if (now - new Date(row.last_used_at) >= TOUCH_EVERY_MS) {
    await db.query('UPDATE connector_grants SET last_used_at = $2 WHERE id = $1 AND last_used_at < $2', [row.id, now]);
  }
  return { ok: true, grantId: row.id, userId: row.user_id };
}

function challengeHeader(withError) {
  const parts = [];
  if (withError) parts.push('error="invalid_token"');
  parts.push(`resource_metadata="${grants.resourceMetadataUrl()}"`);
  return `Bearer ${parts.join(', ')}`;
}

// Answer 401 the way Claude's sign-in expects (status, header, advisory body).
function sendUnauthorized(res, withError) {
  res.set('WWW-Authenticate', challengeHeader(withError));
  res.set('Cache-Control', 'no-store');
  res.status(401).json(withError
    ? { error: 'invalid_token', error_description: 'The access token is not valid. Sign in again.' }
    : { error: 'invalid_token', error_description: 'Sign in to use this connector.' });
}

/**
 * Express middleware for POST /mcp. A valid token sets req.connector
 * ({ grantId, userId }) and continues; otherwise `unauthLimiter` (the
 * per-address limiter on unauthenticated calls) answers 429 once the address
 * is over its limit, with nothing written, and below it the refusal is logged
 * and answered 401. The token lookup itself is bounded by the per-address
 * ceiling the route puts ahead of this.
 */
function requireConnectorToken({ unauthLimiter, now } = {}) {
  return async (req, res, next) => {
    let result;
    const raw = bearerFrom(req);
    try {
      result = await checkAccessToken(raw, { now: now ? now() : new Date() });
    } catch (err) {
      return next(err);
    }
    if (result.ok) {
      req.connector = { grantId: result.grantId, userId: result.userId };
      return next();
    }
    // The per-address limiter decides first: a caller over it gets 429 and
    // writes nothing. Under it, the refusal is logged (once per address per
    // window, callLog.recordRefusal) and answered 401.
    const refuse = async () => {
      await callLog.recordRefusal({ callerAddress: callerAddress(req), outcome: 'refused_token' });
      sendUnauthorized(res, Boolean(raw));
    };
    if (unauthLimiter) return unauthLimiter(req, res, () => { refuse().catch(next); });
    return refuse();
  };
}

module.exports = {
  bearerFrom,
  checkAccessToken,
  challengeHeader,
  sendUnauthorized,
  requireConnectorToken,
};
