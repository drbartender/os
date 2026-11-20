require('dotenv').config();
process.env.NODE_ENV = 'test';

// The connector's per-call check (spec 2026-11-19 section 7.2, law 5): a live
// token passes; an expired token, a revoked grant, a demoted user and a bumped
// token_version each fail; an admin session JWT is not a connector token; a
// grant idle 30 days and a grant 180 days old are dead (clock injected); a
// passing call moves the grant's last use.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const grants = require('./grants');
const tokens = require('./tokens');
const { checkAccessToken, bearerFrom, challengeHeader } = require('./auth');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const DAY = 24 * 60 * 60 * 1000;
let admin;
const grantIds = [];

async function grantWithToken({ createdAt = new Date(), lastUsedAt = createdAt, accessTtlMs = 3600 * 1000 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE connector_grants SET revoked_at = NOW(), revoked_reason = 'replaced' WHERE revoked_at IS NULL");
    const g = await client.query(
      `INSERT INTO connector_grants (user_id, token_version, client_id, created_at, last_used_at, expires_at, activated_at)
       VALUES ($1, 0, $2, $3, $4, $5, $3) RETURNING id, expires_at`,
      [admin.id, grants.CLIENT_ID, createdAt, lastUsedAt, new Date(createdAt.getTime() + grants.GRANT_MAX_MS)]
    );
    const access = tokens.mint(tokens.ACCESS_PREFIX);
    await client.query(
      "INSERT INTO connector_tokens (token_hash, kind, grant_id, expires_at) VALUES ($1, 'access', $2, $3)",
      [tokens.hashToken(access), g.rows[0].id, new Date(Date.now() + accessTtlMs)]
    );
    await client.query('COMMIT');
    grantIds.push(g.rows[0].id);
    return { grantId: g.rows[0].id, access };
  } finally {
    client.release();
  }
}

before(async () => {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`connector-auth-${NONCE}@example.com`]
  );
  admin = r.rows[0];
});

after(async () => {
  if (grantIds.length) {
    await pool.query('DELETE FROM connector_tokens WHERE grant_id = ANY($1::int[])', [grantIds]);
    await pool.query('DELETE FROM connector_grants WHERE id = ANY($1::int[])', [grantIds]);
  }
  await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
  await pool.end();
});

test('a live token passes and moves the grant\'s last use', async () => {
  const old = new Date(Date.now() - 2 * DAY);
  const { grantId, access } = await grantWithToken({ createdAt: old });
  const r = await checkAccessToken(access);
  assert.deepEqual(r, { ok: true, grantId, userId: admin.id });
  const row = (await pool.query('SELECT last_used_at FROM connector_grants WHERE id = $1', [grantId])).rows[0];
  assert.ok(Date.now() - new Date(row.last_used_at) < 60 * 1000, 'touched');
});

test('an expired token, a revoked grant, a demoted user and a bumped token_version each fail', async () => {
  const expired = await grantWithToken({ accessTtlMs: -1000 });
  assert.equal((await checkAccessToken(expired.access)).reason, 'token_expired');

  const revoked = await grantWithToken();
  await pool.query("UPDATE connector_grants SET revoked_at = NOW(), revoked_reason = 'disconnected' WHERE id = $1", [revoked.grantId]);
  assert.equal((await checkAccessToken(revoked.access)).reason, 'grant_revoked');

  const demoted = await grantWithToken();
  await pool.query("UPDATE users SET role = 'manager' WHERE id = $1", [admin.id]);
  try {
    assert.equal((await checkAccessToken(demoted.access)).reason, 'not_admin');
  } finally {
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);
  }
  assert.equal((await checkAccessToken(demoted.access)).ok, true, 'restored');

  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [admin.id]);
  try {
    assert.equal((await checkAccessToken(demoted.access)).reason, 'token_version', 'a token_version bump (a password reset, a passkey revoke) kills it');
  } finally {
    await pool.query('UPDATE users SET token_version = 0 WHERE id = $1', [admin.id]);
  }
});

test('lifetimes: a grant idle 30 days and a grant 180 days old are dead (clock injected)', async () => {
  const { access } = await grantWithToken({ accessTtlMs: 400 * DAY });
  const t0 = new Date();
  assert.equal((await checkAccessToken(access, { now: new Date(t0.getTime() + 29 * DAY) })).ok, true);
  assert.equal((await checkAccessToken(access, { now: new Date(t0.getTime() + 60 * DAY) })).reason, 'grant_lapsed',
    'idle 31 days after the last call');
  const old = await grantWithToken({ createdAt: new Date(t0.getTime() - 179 * DAY), lastUsedAt: t0, accessTtlMs: 400 * DAY });
  assert.equal((await checkAccessToken(old.access, { now: new Date(t0.getTime() + 2 * DAY) })).reason, 'grant_lapsed',
    '180 days after approval, though used two days ago');
});

test('an admin session JWT and anything else that is not our token are refused before any lookup', async () => {
  const sessionJwt = jwt.sign({ userId: admin.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await checkAccessToken(sessionJwt)).reason, 'not_connector_token');
  assert.equal((await checkAccessToken(tokens.mint(tokens.REFRESH_PREFIX))).reason, 'not_connector_token',
    'a refresh token is not an access token');
  assert.equal((await checkAccessToken(tokens.mint(tokens.ACCESS_PREFIX))).reason, 'unknown_token');
  assert.equal((await checkAccessToken(null)).reason, 'no_token');
});

test('the bearer parse and the challenge header', () => {
  assert.equal(bearerFrom({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(bearerFrom({ headers: { authorization: 'bearer abc ' } }), 'abc');
  assert.equal(bearerFrom({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(bearerFrom({ headers: {} }), null);
  process.env.API_URL = 'https://api.example.com';
  assert.equal(challengeHeader(false), 'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"');
  assert.match(challengeHeader(true), /^Bearer error="invalid_token", resource_metadata="/);
});
