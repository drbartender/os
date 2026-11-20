'use strict';

// The Claude connector's sign-in records (spec 2026-11-19 section 7.2): its fixed client and URLs, the
// pending authorize request, approval (grant plus single-use code, one transaction), cancel, grant
// liveness, revoke, the settings status and disconnect.
//
// The OS is the sign-in authority for its own connector. One pre-registered
// public client (CLIENT_ID) with one fixed return address (REDIRECT_URI, the
// address Claude's hosted apps use); there is no registration endpoint. The
// repo is public, so the client id proves nothing by itself: the protections
// are the fixed return address, PKCE, and the consent step, which needs the
// owner's passkey and reads the pending row itself, trusting nothing the page
// sends but the row id.
//
// A grant belongs to the admin who approved it and holds the token_version it
// was approved under, so a token_version bump (a password reset, a passkey revoke) kills it
// at the next call. It lapses after GRANT_IDLE_MS unused and ends GRANT_MAX_MS
// after approval. Approving makes a PENDING grant; the code exchange makes it
// live and, in the same transaction, revokes the earlier connection, so at
// most one grant is live (uq_connector_grants_one_live) and an abandoned
// approval never breaks the connection that works. A grant is revoked by a
// timestamp and never deleted, so its call log survives (spec 7.4).
//
// The owner email (sent when the connection becomes real, at the exchange) and
// the audit entries follow the COMMIT, best-effort: neither can undo or fail
// an approval, an exchange, a disconnect or a replay revocation. Both are
// injected (__setDeps) so the suites assert them through stubs.

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { ADMIN_URL } = require('../urls');
const { logAdminAction } = require('../adminAuditLog');
const mail = require('./mail');

const CLIENT_ID = 'drbartender-os-claude';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const CLIENT_NAME = 'Claude';

const REQUEST_TTL_MS = 10 * 60 * 1000;
const GRANT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const GRANT_MAX_MS = 180 * 24 * 60 * 60 * 1000;

let deps = {
  audit: logAdminAction,
  sendGrantCreatedEmail: mail.sendGrantCreatedEmail,
  sendReplayRevokedEmail: mail.sendReplayRevokedEmail,
  captureMessage: (msg, ctx) => {
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureMessage(msg, ctx);
  },
};
function __setDeps(overrides) { deps = { ...deps, ...overrides }; }
function getDeps() { return deps; }

// The connector exists only with this flag on (spec 7.1): every connector
// path answers 404 otherwise.
function connectorEnabled() {
  return process.env.CLAUDE_CONNECTOR_ENABLED === 'true';
}

// The API's public origin, the issuer. API_URL is read at call time first (the
// precedence server/utils/urls.js gives it), so a test can point it at an
// in-process server; then urls.js's own fallback (Render's URL, localhost).
function issuer() {
  const base = process.env.API_URL || require('../urls').API_URL;
  return String(base).replace(/\/+$/, '');
}

// The MCP endpoint's public URL: the resource the metadata names, which must
// equal the URL the owner enters in Claude.
function publicMcpUrl() {
  return `${issuer()}/mcp`;
}

function resourceMetadataUrl() {
  return `${issuer()}/.well-known/oauth-protected-resource/mcp`;
}

// The consent page in the admin app (client lane connector-signin-ui).
function consentUrl(requestId) {
  return `${ADMIN_URL}/connect-claude?request=${encodeURIComponent(requestId)}`;
}

// RFC 8707 resource comparison: scheme and host case-insensitively (URL
// lowercases them), a trailing slash on the path ignored, no fragment.
function canonicalResource(value) {
  try {
    const u = new URL(String(value));
    if (u.hash) return null;
    const pathname = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
    return `${u.protocol}//${u.host}${pathname}${u.search}`;
  } catch (_) {
    return null;
  }
}
function sameResource(a, b) {
  const ca = canonicalResource(a);
  return ca !== null && ca === canonicalResource(b);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isRequestId(value) { return typeof value === 'string' && UUID.test(value); }

// ─── Grant liveness ─────────────────────────────────────────────────────────

// Whether a grant row may still be used at `now`: unrevoked, before its end,
// and used within the idle window. Pure, so the lifetimes test injects a clock.
function grantIsLive(g, now = new Date()) {
  if (!g || g.revoked_at) return false;
  const t = now.getTime();
  if (t >= new Date(g.expires_at).getTime()) return false;
  if (t - new Date(g.created_at).getTime() >= GRANT_MAX_MS) return false;
  if (t - new Date(g.last_used_at).getTime() >= GRANT_IDLE_MS) return false;
  return true;
}

// The one rule for whether a grant works, used by every real use (the
// per-call check, the code exchange, the refresh) and by what the settings
// block and the consent page show. `g` carries the grant's columns and its
// user's role and token_version (user_token_version). In order: 'revoked',
// 'expired' (180 days), 'lapsed' (30 days unused), 'pending' (approved, its
// code not yet exchanged), 'no_longer_admin', 'signed_out' (the admin's
// token_version moved: a password reset or a passkey revoke), else 'live'.
// allowPending lets the code exchange judge the grant it is about to make live.
function grantState(g, now = new Date(), { allowPending = false } = {}) {
  if (!g) return 'revoked';
  if (g.revoked_at) return 'revoked';
  if (!grantIsLive(g, now)) {
    const t = now.getTime();
    if (t >= new Date(g.expires_at).getTime() || t - new Date(g.created_at).getTime() >= GRANT_MAX_MS) return 'expired';
    return 'lapsed';
  }
  if (!g.activated_at && !allowPending) return 'pending';
  if (g.role !== 'admin') return 'no_longer_admin';
  if (Number(g.user_token_version) !== Number(g.token_version)) return 'signed_out';
  return 'live';
}

// Revoke one grant and its tokens through the held client (inside the
// caller's transaction). Returns whether this call revoked it.
async function revokeGrantWith(client, grantId, reason) {
  const r = await client.query(
    `UPDATE connector_grants SET revoked_at = NOW(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [grantId, reason]
  );
  await client.query(
    'UPDATE connector_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL',
    [grantId]
  );
  return r.rows.length > 0;
}

// Every unrevoked grant but `exceptId`, revoked with `reason`, with its
// tokens. Returns their ids and whether any of them was live a moment before
// (the "replaced the connection" fact the email states).
const REVOKE_OTHERS = `
  UPDATE connector_grants g SET revoked_at = NOW(), revoked_reason = $1
    FROM users u
   WHERE u.id = g.user_id AND g.revoked_at IS NULL AND g.id IS DISTINCT FROM $2
   RETURNING g.id, g.created_at, g.expires_at, g.last_used_at, g.activated_at, g.token_version,
             u.role, u.token_version AS user_token_version`;
async function revokeAllWith(client, reason, { exceptId = null, now = new Date() } = {}) {
  const r = await client.query(REVOKE_OTHERS, [reason, exceptId]);
  const ids = r.rows.map((row) => row.id);
  const anyLive = r.rows.some((row) => grantState({ ...row, revoked_at: null }, now) === 'live');
  if (ids.length) {
    await client.query(
      'UPDATE connector_tokens SET revoked_at = NOW() WHERE grant_id = ANY($1::int[]) AND revoked_at IS NULL',
      [ids]
    );
  }
  return { ids, anyLive };
}

// ─── The pending request ────────────────────────────────────────────────────

async function createRequest({ clientId, redirectUri, codeChallenge, state, resource, callerAddress, userAgent }, now = new Date()) {
  const r = await pool.query(
    `INSERT INTO connector_auth_requests
       (client_id, redirect_uri, code_challenge, state, resource, caller_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      clientId, redirectUri, codeChallenge, state, resource || null,
      callerAddress ? String(callerAddress).slice(0, 64) : null,
      userAgent ? String(userAgent).slice(0, 300) : null,
      new Date(now.getTime() + REQUEST_TTL_MS),
    ]
  );
  return r.rows[0].id;
}

// What the consent page shows (spec 7.2): when and from where the request
// started, and whether approving replaces a connection. Never the challenge,
// the state or the return address in full. Null for an unknown id.
async function readRequest(requestId, now = new Date()) {
  if (!isRequestId(requestId)) return null;
  const r = await pool.query(
    `SELECT id, redirect_uri, caller_address, user_agent, requested_at, expires_at, used_at, outcome
       FROM connector_auth_requests WHERE id = $1`,
    [requestId]
  );
  const row = r.rows[0];
  if (!row) return null;
  let status = 'pending';
  if (row.used_at) status = row.outcome === 'cancelled' ? 'cancelled' : 'used';
  else if (new Date(row.expires_at) <= now) status = 'expired';
  return {
    id: row.id,
    status,
    client_name: CLIENT_NAME,
    redirect_host: new URL(row.redirect_uri).host,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    caller_address: row.caller_address,
    user_agent: row.user_agent,
  };
}

// The connection: the newest unrevoked grant whose code was exchanged, with
// its state by the one rule (grantState), so settings never shows live what
// every real use refuses. A pending approval is not a connection. Null when
// there is none.
const CURRENT_GRANT = `
  SELECT g.id, g.user_id, g.created_at, g.activated_at, g.expires_at, g.last_used_at, g.revoked_at,
         g.token_version, u.role, u.token_version AS user_token_version
    FROM connector_grants g JOIN users u ON u.id = g.user_id
   WHERE g.revoked_at IS NULL AND g.activated_at IS NOT NULL
   ORDER BY g.activated_at DESC LIMIT 1`;
async function currentGrant(now = new Date(), db = pool) {
  const r = await db.query(CURRENT_GRANT);
  const g = r.rows[0];
  if (!g) return null;
  return {
    id: g.id,
    state: grantState(g, now),
    connected_at: g.activated_at,
    approved_at: g.created_at,
    last_used_at: g.last_used_at,
    expires_at: g.expires_at,
    lapses_at: new Date(Math.min(
      new Date(g.last_used_at).getTime() + GRANT_IDLE_MS,
      new Date(g.expires_at).getTime()
    )),
  };
}

function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  }
  return u.toString();
}

class RequestInvalidError extends Error {
  constructor(reason) { super(`connector request ${reason}`); this.reason = reason; }
}

const CLAIM_REQUEST = `
  UPDATE connector_auth_requests SET used_at = $2, outcome = $3
   WHERE id = $1 AND used_at IS NULL AND expires_at > $2
   RETURNING id, client_id, redirect_uri, code_challenge, state, resource, caller_address, user_agent, requested_at`;

// Why a request id cannot be claimed: unknown, used or expired.
async function whyUnclaimable(db, requestId, now) {
  const r = await db.query('SELECT used_at, outcome, expires_at FROM connector_auth_requests WHERE id = $1', [requestId]);
  const row = r.rows[0];
  if (!row) return 'missing';
  if (row.used_at) return row.outcome === 'cancelled' ? 'cancelled' : 'used';
  if (new Date(row.expires_at) <= now) return 'expired';
  return 'missing';
}

/**
 * Approve a pending request for `user` (an admin whose passkey assertion the
 * route has already verified). In one transaction: mark the row used, create
 * the grant PENDING under the admin's current token_version (no tokens, not
 * the connection, not counted as live), and mint the single-use code. Nothing
 * is revoked here: the code exchange (tokens.exchangeCode) replaces the
 * earlier connection when it makes this one live, so an approval whose code
 * is never redeemed leaves the working connection working, and the daily
 * cleanup revokes it as unredeemed. Two approvals of one row yield one grant:
 * the conditional claim lets one win. Returns the URL that sends the browser
 * back to Claude with the code (and the state, when the request had one),
 * and `replaced`: whether a live connection exists that the exchange will
 * replace, the same fact the consent page warns about.
 *
 * @throws {RequestInvalidError} reason missing | used | cancelled | expired
 */
async function approveRequest({ requestId, user, now = new Date() }) {
  const tokens = require('./tokens');
  if (!isRequestId(requestId)) throw new RequestInvalidError('missing');
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    const claimed = await client.query(CLAIM_REQUEST, [requestId, now, 'approved']);
    const req = claimed.rows[0];
    if (!req) {
      const reason = await whyUnclaimable(client, requestId, now);
      await client.query('ROLLBACK');
      throw new RequestInvalidError(reason);
    }
    const g = await client.query(
      `INSERT INTO connector_grants (user_id, token_version, client_id, request_id, created_at, last_used_at, expires_at)
       SELECT u.id, COALESCE(u.token_version, 0), $2, $3, $4, $4, $5
         FROM users u WHERE u.id = $1 AND u.role = 'admin'
       RETURNING id, created_at, expires_at`,
      [user.id, req.client_id, req.id, now, new Date(now.getTime() + GRANT_MAX_MS)]
    );
    if (!g.rows[0]) {
      // The route admits admins only; a row that is not one by now (a demotion
      // between the guard and here) approves nothing.
      await client.query('ROLLBACK');
      throw new RequestInvalidError('missing');
    }
    const grantId = g.rows[0].id;
    await client.query('UPDATE connector_auth_requests SET grant_id = $2 WHERE id = $1', [req.id, grantId]);
    const code = tokens.mint(tokens.CODE_PREFIX);
    await client.query(
      `INSERT INTO connector_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tokens.hashToken(code), grantId, req.client_id, req.redirect_uri, req.code_challenge, req.resource,
        now, new Date(now.getTime() + tokens.CODE_TTL_SECONDS * 1000)]
    );
    const current = await currentGrant(now, client);
    await client.query('COMMIT');
    result = {
      grantId,
      replaces: Boolean(current && current.state === 'live'),
      request: req,
      redirectUrl: redirectWith(req.redirect_uri, { code, state: req.state }),
    };
  } catch (err) {
    if (!(err instanceof RequestInvalidError)) {
      try { await client.query('ROLLBACK'); } catch (_) { /* already closed */ }
    }
    throw err;
  } finally {
    client.release();
  }

  // After the COMMIT, best-effort: the audit entry. The owner email waits for
  // the code exchange, when the connection becomes real (onGrantActivated).
  await deps.audit({
    actorUserId: user.id,
    targetUserId: user.id,
    action: 'connector_grant_approved',
    metadata: { grant_id: result.grantId, request_id: result.request.id },
  });
  return { grantId: result.grantId, redirectUrl: result.redirectUrl, replaced: result.replaces };
}

/**
 * After a code exchange made a grant live (tokens.js, after its COMMIT): the
 * audit entry and the owner email, each best-effort. `replaced` says whether
 * a live connection was revoked to make room, the same fact the consent page
 * and approve's `replaced` reported.
 */
async function onGrantActivated({ grantId, replacedGrantIds, replaced, now = new Date() }) {
  let info = null;
  try {
    const r = await pool.query(
      `SELECT u.id AS user_id, u.email, r.caller_address, r.user_agent, r.requested_at, g.created_at AS approved_at
         FROM connector_grants g JOIN users u ON u.id = g.user_id
         LEFT JOIN connector_auth_requests r ON r.id = g.request_id
        WHERE g.id = $1`,
      [grantId]
    );
    info = r.rows[0] || null;
  } catch (err) {
    console.error('[connector] activation lookup failed:', err && err.message);
  }
  await deps.audit({
    actorUserId: info ? info.user_id : null,
    targetUserId: info ? info.user_id : null,
    action: 'connector_grant_created',
    metadata: { grant_id: grantId, replaced_grant_ids: replacedGrantIds },
  });
  if (!info || !info.email) return;
  try {
    await deps.sendGrantCreatedEmail({
      to: info.email,
      connectedAt: now,
      approvedAt: info.approved_at,
      callerAddress: info.caller_address,
      userAgent: info.user_agent,
      requestedAt: info.requested_at,
      replaced,
    });
  } catch (err) {
    deps.captureMessage('connector_grant_email_failed', { level: 'error', tags: { component: 'connector' } });
    console.error('[connector] grant email failed:', err && err.message);
  }
}

// The daily cleanup's part (cleanupScheduler.js): an approval whose code
// expired or was spent without making it live is revoked as unredeemed.
const REVOKE_UNREDEEMED = `
  UPDATE connector_grants g SET revoked_at = NOW(), revoked_reason = 'unredeemed'
   WHERE g.revoked_at IS NULL AND g.activated_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM connector_codes c
                      WHERE c.grant_id = g.id AND c.used_at IS NULL AND c.expires_at > NOW())
   RETURNING g.id`;
async function revokeUnredeemed(db = pool) {
  const r = await db.query(REVOKE_UNREDEEMED);
  return r.rows.length;
}

/**
 * Cancel a pending request: it is marked used, and the browser goes back to
 * Claude with error=access_denied and the state (spec 7.2).
 *
 * @throws {RequestInvalidError}
 */
async function cancelRequest({ requestId, now = new Date() }) {
  if (!isRequestId(requestId)) throw new RequestInvalidError('missing');
  const claimed = await pool.query(CLAIM_REQUEST, [requestId, now, 'cancelled']);
  const req = claimed.rows[0];
  if (!req) throw new RequestInvalidError(await whyUnclaimable(pool, requestId, now));
  return { redirectUrl: redirectWith(req.redirect_uri, { error: 'access_denied', state: req.state }) };
}

// Disconnect (settings): revoke every unrevoked grant and its tokens, then the
// audit entry. The call log is untouched. Returns how many grants it revoked.
async function disconnect({ user }) {
  const client = await pool.connect();
  let ids;
  try {
    await client.query('BEGIN');
    ({ ids } = await revokeAllWith(client, 'disconnected'));
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already closed */ }
    throw err;
  } finally {
    client.release();
  }
  if (ids.length) {
    await deps.audit({
      actorUserId: user.id,
      targetUserId: user.id,
      action: 'connector_disconnected',
      metadata: { grant_ids: ids },
    });
  }
  return ids.length;
}

// After a replayed code or refresh token revoked a grant (tokens.js, after its
// COMMIT): Sentry, the owner email and the audit entry, each best-effort.
async function onReplayRevoked({ grantId, kind, pending = false }) {
  if (pending) {
    // A spent code replayed on an approval that was never exchanged: that
    // pending grant is revoked, the live connection is untouched, so no alarm
    // claims a connection was cut and no email goes out.
    try {
      deps.captureMessage('connector_pending_code_replay', {
        level: 'warning', tags: { component: 'connector', kind }, extra: { grant_id: grantId },
      });
    } catch (_) { /* telemetry must never break the token route; static-checks: allow swallowed-catch */ }
    await deps.audit({
      actorUserId: null, targetUserId: null,
      action: 'connector_pending_grant_revoked_replay',
      metadata: { grant_id: grantId, kind },
    });
    return;
  }
  try {
    deps.captureMessage('connector_replay_revoked', {
      level: 'error',
      tags: { component: 'connector', kind },
      extra: { grant_id: grantId },
    });
  } catch (_) { /* telemetry must never break the token route; static-checks: allow swallowed-catch */ }
  let owner = null;
  try {
    const r = await pool.query(
      'SELECT u.id, u.email FROM connector_grants g JOIN users u ON u.id = g.user_id WHERE g.id = $1',
      [grantId]
    );
    owner = r.rows[0] || null;
  } catch (err) {
    console.error('[connector] replay owner lookup failed:', err && err.message);
  }
  await deps.audit({
    actorUserId: null,
    targetUserId: owner ? owner.id : null,
    action: 'connector_grant_revoked_replay',
    metadata: { grant_id: grantId, kind },
  });
  if (owner && owner.email) {
    try {
      await deps.sendReplayRevokedEmail({ to: owner.email, kind, revokedAt: new Date() });
    } catch (err) {
      deps.captureMessage('connector_replay_email_failed', { level: 'error', tags: { component: 'connector' } });
      console.error('[connector] replay email failed:', err && err.message);
    }
  }
}

module.exports = {
  CLIENT_ID,
  REDIRECT_URI,
  CLIENT_NAME,
  REQUEST_TTL_MS,
  GRANT_IDLE_MS,
  GRANT_MAX_MS,
  RequestInvalidError,
  __setDeps,
  getDeps,
  connectorEnabled,
  issuer,
  publicMcpUrl,
  resourceMetadataUrl,
  consentUrl,
  sameResource,
  isRequestId,
  grantIsLive,
  grantState,
  revokeGrantWith,
  createRequest,
  readRequest,
  currentGrant,
  approveRequest,
  cancelRequest,
  revokeAllWith,
  disconnect,
  onGrantActivated,
  revokeUnredeemed,
  onReplayRevoked,
};
