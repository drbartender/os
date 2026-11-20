'use strict';

// The Claude connector's credentials (spec 2026-11-19 sections 7.2 and law 9): minting prefixed random
// tokens and codes, their SHA-256 storage hashes, the PKCE S256 check, and the token endpoint's
// two grants (code exchange, refresh rotation with the 30-second grace and replay revocation).
//
// Every token and code is 32 random bytes in base64url behind a fixed prefix,
// drbc_at_ (access), drbc_rt_ (refresh) and drbc_ac_ (authorization code), so
// server/utils/sentryScrub.js redacts any of them by value (law 8), and so a
// value that is not one of ours (an admin session JWT, say) is refused before
// any lookup. Only the hash is stored; the token itself exists in the response
// that carries it and nowhere else.
//
// The two grants are atomic (law 9). A code is spent by a conditional UPDATE
// that stamps used_at, so two parallel exchanges cannot both win; the exchange
// makes the approved grant live and replaces the earlier connection in the
// same transaction; a code presented again revokes its grant, which kills
// every token issued from it. A refresh locks the grant first and is refused,
// unstamped, when the grant no longer works; on a live grant the token is spent
// by stamping rotated_at: two parallel refreshes leave one winner, and the
// loser (or a retry after a lost response) presented inside REFRESH_GRACE_MS is
// refused with the grant left alive. Presented later, it is a copied token: the
// grant is revoked, and the owner is told by email and Sentry (onReplay,
// injected by the caller, fired only when a grant was actually revoked).

const crypto = require('node:crypto');
const { pool } = require('../../db');
const grants = require('./grants');

const TOKEN_PREFIX = 'drbc_';
const ACCESS_PREFIX = 'drbc_at_';
const REFRESH_PREFIX = 'drbc_rt_';
const CODE_PREFIX = 'drbc_ac_';

const ACCESS_TTL_SECONDS = 60 * 60;
const CODE_TTL_SECONDS = 60;
const REFRESH_GRACE_MS = 30 * 1000;

// A credential's body: 43 base64url characters (32 random bytes).
const BODY = /^[A-Za-z0-9_-]{43}$/;

function mint(prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Whether `value` is shaped like one of our credentials of this prefix.
function hasShape(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && BODY.test(value.slice(prefix.length));
}

// RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) equals the challenge.
// The verifier is 43 to 128 unreserved characters. Constant-time compare.
function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  if (typeof challenge !== 'string') return false;
  const computed = Buffer.from(crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

// An OAuth error the token route answers with (RFC 6749 section 5.2).
class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.oauthError = error;
    this.status = status;
  }
}

const INVALID_GRANT = 'invalid_grant';

// Insert a fresh access and refresh token pair for a grant through the held
// client. The refresh token lives to the grant's own end.
// Expiry stamps come from the app clock (`now`), the same clock every check
// compares them with.
async function issuePair(client, grantId, grantExpiresAt, now) {
  const access = mint(ACCESS_PREFIX);
  const refresh = mint(REFRESH_PREFIX);
  await client.query(
    `INSERT INTO connector_tokens (token_hash, kind, grant_id, expires_at)
     VALUES ($1, 'access', $3, $4), ($2, 'refresh', $3, $5)`,
    [hashToken(access), hashToken(refresh), grantId, new Date(now.getTime() + ACCESS_TTL_SECONDS * 1000), grantExpiresAt]
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
  };
}

// The grant and its user, locked for the rest of the transaction. Every path
// that touches a grant and its tokens locks the grant row first (disconnect,
// replacement, replay revocation and these two grants), so two of them never
// deadlock.
const LOCK_GRANT = `
  SELECT g.id, g.user_id, g.client_id, g.token_version, g.created_at, g.activated_at, g.expires_at,
         g.last_used_at, g.revoked_at, u.role, u.token_version AS user_token_version
    FROM connector_grants g
    JOIN users u ON u.id = g.user_id
   WHERE g.id = $1
     FOR UPDATE OF g`;

async function lockGrant(client, grantId) {
  const r = await client.query(LOCK_GRANT, [grantId]);
  return r.rows[0] || null;
}

// Roll back, then refuse: nothing this transaction did is kept.
async function rollbackAndRefuse(client, description) {
  await client.query('ROLLBACK');
  throw new OAuthError(INVALID_GRANT, description);
}

/**
 * The authorization_code grant. Resolves the token response, or throws an
 * OAuthError. The exchange is what makes an approved (pending) grant live: in
 * the same transaction it revokes the earlier connection as replaced, so an
 * approval whose code never arrives leaves the working connection alone. A
 * code presented a second time revokes its grant; the alarm (onReplay) fires
 * only when that actually revoked one.
 *
 * @param {{code, codeVerifier, redirectUri, clientId, resource}} params
 * @param {{now?: Date, onReplay?: Function, onActivated?: Function}} [opts] onActivated runs detached
 *   after the response's COMMIT; the caller does not wait for it.
 */
async function exchangeCode(params, opts = {}) {
  const now = opts.now || new Date();
  const { code, codeVerifier, redirectUri, clientId, resource } = params;
  if (!hasShape(code, CODE_PREFIX)) throw new OAuthError(INVALID_GRANT, 'The code is not valid.');
  const codeHash = hashToken(code);

  const client = await pool.connect();
  let replayGrantId = null;
  let replayPending = false;
  let activated = null;
  try {
    await client.query('BEGIN');
    const spent = await client.query(
      `UPDATE connector_codes SET used_at = $2
        WHERE code_hash = $1 AND used_at IS NULL
        RETURNING id, grant_id, client_id, redirect_uri, code_challenge, resource, expires_at`,
      [codeHash, now]
    );
    const row = spent.rows[0];
    if (!row) {
      // Spent before: a second presentation. Its grant (and so every token
      // issued from the code) dies. An unknown code is simply refused.
      const prior = await client.query('SELECT grant_id FROM connector_codes WHERE code_hash = $1', [codeHash]);
      if (prior.rows[0]) {
        const pg = await lockGrant(client, prior.rows[0].grant_id);
        if (await grants.revokeGrantWith(client, prior.rows[0].grant_id, 'code_replay')) {
          replayGrantId = prior.rows[0].grant_id;
          // A grant never exchanged was never a connection: its revocation
          // cuts nothing off, and the hook says so (no "cut off" email).
          replayPending = Boolean(pg && !pg.activated_at);
        }
      }
      await client.query('COMMIT');
      throw new OAuthError(INVALID_GRANT, 'The code is not valid.');
    }
    // From here the code is spent whatever happens; a refusal commits that
    // (the pending grant is then revoked as unredeemed by the daily cleanup).
    const refuse = async (description) => {
      await client.query('COMMIT');
      throw new OAuthError(INVALID_GRANT, description);
    };
    if (new Date(row.expires_at) <= now) return await refuse('The code has expired.');
    if (clientId !== row.client_id) return await refuse('The code was issued to another client.');
    if (redirectUri !== row.redirect_uri) return await refuse('The return address does not match.');
    if (!pkceMatches(codeVerifier, row.code_challenge)) return await refuse('The code verifier does not match.');
    if (resource && !grants.sameResource(resource, row.resource || grants.publicMcpUrl())) {
      return await refuse('The code was issued for another resource.');
    }
    const g = await lockGrant(client, row.grant_id);
    if (grants.grantState(g, now, { allowPending: true }) !== 'live') return await refuse('The connection is no longer approved.');
    if (!g.activated_at) {
      const replaced = await grants.revokeAllWith(client, 'replaced', { exceptId: g.id, now });
      await client.query('UPDATE connector_grants SET activated_at = $2, last_used_at = $2 WHERE id = $1', [g.id, now]);
      activated = { grantId: g.id, replacedGrantIds: replaced.ids, replaced: replaced.anyLive, now };
    }
    const body = await issuePair(client, g.id, g.expires_at, now);
    await client.query('COMMIT');
    return body;
  } catch (err) {
    if (!(err instanceof OAuthError)) {
      activated = null;
      try { await client.query('ROLLBACK'); } catch (_) { /* already closed; static-checks: allow swallowed-catch */ }
      // Two exchanges making two approvals live at the same instant: the
      // one-live index lets one win, and the other is a clean refusal.
      if (err && err.code === '23505') throw new OAuthError(INVALID_GRANT, 'Another connection was made at the same moment.');
    }
    throw err;
  } finally {
    client.release();
    if (replayGrantId && opts.onReplay) await opts.onReplay({ grantId: replayGrantId, kind: 'code_replay', pending: replayPending });
    // The audit entry and the owner email run detached: the token response
    // goes out as soon as the exchange commits, never held behind Resend
    // (Claude gives the token endpoint 10 seconds). A failure there goes to
    // Sentry as a fixed descriptor.
    if (activated && opts.onActivated) {
      Promise.resolve()
        .then(() => opts.onActivated(activated))
        .catch(() => {
          try {
            grants.getDeps().captureMessage('connector_activation_tail_failed', { level: 'error', tags: { component: 'connector' } });
          } catch (_) { /* telemetry must never break the token route; static-checks: allow swallowed-catch */ }
        });
    }
  }
}

/**
 * The refresh_token grant: rotate the refresh token and mint a new pair. The
 * grant is locked and judged first: a refresh on a grant that no longer works
 * (lapsed, expired, revoked, its admin demoted or signed out) is refused and
 * rolled back, so the token is never stamped and no later presentation of it
 * can read as a copy. Inside REFRESH_GRACE_MS of its rotation a spent token is
 * refused with the grant alive; after it, on a live grant, the grant is
 * revoked and onReplay fires (only when that revoked it).
 *
 * @param {{refreshToken, clientId, resource}} params
 * @param {{now?: Date, onReplay?: Function}} [opts]
 */
async function refreshTokens(params, opts = {}) {
  const now = opts.now || new Date();
  const { refreshToken, clientId, resource } = params;
  if (!hasShape(refreshToken, REFRESH_PREFIX)) throw new OAuthError(INVALID_GRANT, 'The refresh token is not valid.');
  if (resource && !grants.sameResource(resource, grants.publicMcpUrl())) {
    throw new OAuthError('invalid_target', 'The resource is not this server.');
  }
  const tokenHash = hashToken(refreshToken);

  const client = await pool.connect();
  let replayGrantId = null;
  try {
    await client.query('BEGIN');
    const found = await client.query(
      "SELECT id, grant_id FROM connector_tokens WHERE token_hash = $1 AND kind = 'refresh'",
      [tokenHash]
    );
    const tok = found.rows[0];
    if (!tok) return await rollbackAndRefuse(client, 'The refresh token is not valid.');
    const g = await lockGrant(client, tok.grant_id);
    if (grants.grantState(g, now) !== 'live') return await rollbackAndRefuse(client, 'The connection is no longer approved.');
    if (clientId !== g.client_id) return await rollbackAndRefuse(client, 'The refresh token was issued to another client.');
    const spent = await client.query(
      `UPDATE connector_tokens SET rotated_at = $2
        WHERE id = $1 AND rotated_at IS NULL AND revoked_at IS NULL AND expires_at > $2
        RETURNING id`,
      [tok.id, now]
    );
    if (!spent.rows[0]) {
      const prior = await client.query('SELECT rotated_at, revoked_at FROM connector_tokens WHERE id = $1', [tok.id]);
      const p = prior.rows[0];
      if (p && p.rotated_at && !p.revoked_at && now - new Date(p.rotated_at) > REFRESH_GRACE_MS) {
        // A spent token presented well after its rotation, on a live grant: a copy.
        if (await grants.revokeGrantWith(client, g.id, 'refresh_replay')) replayGrantId = g.id;
        await client.query('COMMIT');
        throw new OAuthError(INVALID_GRANT, 'The refresh token is not valid.');
      }
      return await rollbackAndRefuse(client, 'The refresh token is not valid.');
    }
    await client.query('UPDATE connector_grants SET last_used_at = $2 WHERE id = $1', [g.id, now]);
    const body = await issuePair(client, g.id, g.expires_at, now);
    await client.query('COMMIT');
    return body;
  } catch (err) {
    if (!(err instanceof OAuthError)) {
      replayGrantId = null;
      try { await client.query('ROLLBACK'); } catch (_) { /* already closed; static-checks: allow swallowed-catch */ }
    }
    throw err;
  } finally {
    client.release();
    if (replayGrantId && opts.onReplay) await opts.onReplay({ grantId: replayGrantId, kind: 'refresh_replay' });
  }
}

module.exports = {
  TOKEN_PREFIX,
  ACCESS_PREFIX,
  REFRESH_PREFIX,
  CODE_PREFIX,
  ACCESS_TTL_SECONDS,
  CODE_TTL_SECONDS,
  REFRESH_GRACE_MS,
  OAuthError,
  mint,
  hashToken,
  hasShape,
  pkceMatches,
  issuePair,
  exchangeCode,
  refreshTokens,
};
