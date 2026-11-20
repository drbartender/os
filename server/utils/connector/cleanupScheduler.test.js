require('dotenv').config();
process.env.NODE_ENV = 'test';

// The connector's daily cleanup (spec 2026-11-19 section 7.4): log rows older
// than 90 days, expired requests, spent codes and dead tokens go; live ones
// stay, the grants stay, and a rotated refresh token stays until its own
// expiry so a late replay is still recognised. Also its registration: its own
// RUN_ flag and health row.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../../db');
const grants = require('./grants');
const tokens = require('./tokens');
const { runConnectorCleanup, register, SCHEDULER_NAME } = require('./cleanupScheduler');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let admin; let grantId;
const ids = { calls: [], requests: [], codes: [], tokens: [] };

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const ago = (ms) => new Date(Date.now() - ms);
const ahead = (ms) => new Date(Date.now() + ms);

async function addCall(calledAt, outcome = 'ok') {
  const r = await pool.query(
    'INSERT INTO connector_calls (grant_id, outcome, called_at, withheld_ref) VALUES ($1, $2, $3, $4) RETURNING id',
    [grantId, outcome, calledAt, outcome === 'withheld' ? `cleanup-${NONCE}` : null]
  );
  ids.calls.push(r.rows[0].id);
  return r.rows[0].id;
}
async function addRequest(expiresAt) {
  const r = await pool.query(
    `INSERT INTO connector_auth_requests (client_id, redirect_uri, code_challenge, state, expires_at)
     VALUES ($1, $2, 'c', 's', $3) RETURNING id`,
    [grants.CLIENT_ID, grants.REDIRECT_URI, expiresAt]
  );
  ids.requests.push(r.rows[0].id);
  return r.rows[0].id;
}
async function addCode(usedAt, expiresAt) {
  const r = await pool.query(
    `INSERT INTO connector_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, expires_at, used_at)
     VALUES ($1, $2, $3, $4, 'c', $5, $6) RETURNING id`,
    [tokens.hashToken(tokens.mint(tokens.CODE_PREFIX)), grantId, grants.CLIENT_ID, grants.REDIRECT_URI, expiresAt, usedAt]
  );
  ids.codes.push(r.rows[0].id);
  return r.rows[0].id;
}
async function addToken(kind, expiresAt, { revokedAt = null, rotatedAt = null } = {}) {
  const r = await pool.query(
    `INSERT INTO connector_tokens (token_hash, kind, grant_id, expires_at, revoked_at, rotated_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tokens.hashToken(tokens.mint(tokens.ACCESS_PREFIX)), kind, grantId, expiresAt, revokedAt, rotatedAt]
  );
  ids.tokens.push(r.rows[0].id);
  return r.rows[0].id;
}
const EXISTS = {
  connector_calls: 'SELECT 1 FROM connector_calls WHERE id = $1',
  connector_auth_requests: 'SELECT 1 FROM connector_auth_requests WHERE id = $1',
  connector_codes: 'SELECT 1 FROM connector_codes WHERE id = $1',
  connector_tokens: 'SELECT 1 FROM connector_tokens WHERE id = $1',
  connector_grants: 'SELECT 1 FROM connector_grants WHERE id = $1',
};
async function exists(table, id) {
  const r = await pool.query(EXISTS[table], [id]);
  return r.rows.length === 1;
}

before(async () => {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`connector-cleanup-${NONCE}@example.com`]
  );
  admin = r.rows[0];
  const g = await pool.query(
    `INSERT INTO connector_grants (user_id, token_version, client_id, expires_at, revoked_at, revoked_reason)
     VALUES ($1, 0, $2, NOW() + INTERVAL '180 days', NOW() - INTERVAL '200 days', 'disconnected') RETURNING id`,
    [admin.id, grants.CLIENT_ID]
  );
  grantId = g.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM connector_calls WHERE id = ANY($1::bigint[])', [ids.calls]);
  await pool.query('DELETE FROM connector_tokens WHERE id = ANY($1::int[])', [ids.tokens]);
  await pool.query('DELETE FROM connector_codes WHERE id = ANY($1::int[])', [ids.codes]);
  await pool.query('DELETE FROM connector_auth_requests WHERE id = ANY($1::uuid[])', [ids.requests]);
  await pool.query('DELETE FROM connector_grants WHERE id = $1', [grantId]);
  await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
  await pool.end();
});

test('old rows, expired requests, spent codes and dead tokens go; live ones stay', async () => {
  const oldCall = await addCall(ago(91 * DAY));
  const recentCall = await addCall(ago(89 * DAY));
  const oldWithheld = await addCall(ago(200 * DAY), 'withheld');
  const expiredRequest = await addRequest(ago(MIN));
  const pendingRequest = await addRequest(ahead(9 * MIN));
  const spentCode = await addCode(ago(2 * DAY), ago(2 * DAY));
  const justSpentCode = await addCode(ago(MIN), ahead(MIN / 2));
  const expiredAccess = await addToken('access', ago(MIN));
  const liveAccess = await addToken('access', ahead(50 * MIN));
  const revokedLongAgo = await addToken('refresh', ahead(100 * DAY), { revokedAt: ago(2 * DAY) });
  const rotatedLive = await addToken('refresh', ahead(100 * DAY), { rotatedAt: ago(20 * DAY) });

  const counts = await runConnectorCleanup();
  for (const k of ['calls', 'requests', 'codes', 'tokens']) assert.ok(counts[k] >= 1, `${k} deleted`);

  assert.equal(await exists('connector_calls', oldCall), false, 'a 91-day-old log row');
  assert.equal(await exists('connector_calls', recentCall), true);
  assert.equal(await exists('connector_calls', oldWithheld), true, 'a withheld row survives the prune, so once stays once');
  assert.equal(await exists('connector_auth_requests', expiredRequest), false);
  assert.equal(await exists('connector_auth_requests', pendingRequest), true);
  assert.equal(await exists('connector_codes', spentCode), false);
  assert.equal(await exists('connector_codes', justSpentCode), true, 'kept a day for the replay check');
  assert.equal(await exists('connector_tokens', expiredAccess), false);
  assert.equal(await exists('connector_tokens', liveAccess), true);
  assert.equal(await exists('connector_tokens', revokedLongAgo), false);
  assert.equal(await exists('connector_tokens', rotatedLive), true, 'a rotated refresh token is kept to its own expiry');
  assert.equal(await exists('connector_grants', grantId), true, 'a grant is never deleted');
});

test('registration: its own RUN_ flag, its own health row cleared when switched off', () => {
  const calls = [];
  const fakeWrap = (name, secs, fn) => { calls.push(['wrap', name, secs]); return fn; };
  const clear = (name) => calls.push(['clear', name]);
  assert.equal(register({ enabled: (v) => { calls.push(['flag', v]); return false; }, globalScheduleDisabled: false, wrapScheduler: fakeWrap, clearHealthRow: clear }), false);
  assert.deepEqual(calls, [['flag', 'RUN_CONNECTOR_CLEANUP_SCHEDULER'], ['clear', SCHEDULER_NAME]]);
  calls.length = 0;
  assert.equal(register({ enabled: () => false, globalScheduleDisabled: true, wrapScheduler: fakeWrap, clearHealthRow: clear }), false);
  assert.deepEqual(calls, [], 'nothing when every scheduler is off');
});
