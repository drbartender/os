require('dotenv').config();
process.env.NODE_ENV = 'test';

// The connector's admin routes (spec 2026-11-19 sections 7.2 and 7.4): the
// consent page's read, approve and cancel, and the settings block's status,
// call list and disconnect. Approve: a manager is refused; a missing or failed
// passkey assertion is refused; a used or expired pending row is refused; two
// approvals of one row yield one grant; approving with a grant present
// replaces it and revokes its tokens. Disconnect leaves the log rows. The
// owner email and the audit entries are asserted through injected stubs. The
// last two tests run the real passkey check (webauthn.js
// verifyAssertionForUser) with only the signature verify stubbed: the
// connector's bound challenge, and no session minted.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const grants = require('../../utils/connector/grants');
const tokens = require('../../utils/connector/tokens');
const callLog = require('../../utils/connector/callLog');
const { createConnectorAdminRouter } = require('./connector');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server; let base;
let admin; let adminJwt; let manager; let managerJwt;
let passkey = async () => true;
let clockOffsetMs = 0;
const requestIds = [];
const refusalIds = [];
let mails = []; let audits = [];

function call(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const u = new URL(base + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function makeUser(role) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, 'approved', 0) RETURNING id, email, role`,
    [`connector-admin-${role}-${NONCE}@example.com`, role]
  );
  const u = r.rows[0];
  return { user: u, token: jwt.sign({ userId: u.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

async function pendingRequest(over = {}) {
  const id = await grants.createRequest({
    clientId: grants.CLIENT_ID,
    redirectUri: grants.REDIRECT_URI,
    codeChallenge: crypto.randomBytes(32).toString('base64url'),
    state: 'state-xyz',
    callerAddress: '203.0.113.9',
    userAgent: 'test-browser',
    ...over,
  }, over.now || new Date());
  requestIds.push(id);
  return id;
}

const ASSERTION = { assertion: { id: 'cred', response: {} } };

before(async () => {
  process.env.CLAUDE_CONNECTOR_ENABLED = 'true';
  process.env.API_URL = 'https://api.example.com';
  ({ user: admin, token: adminJwt } = await makeUser('admin'));
  ({ user: manager, token: managerJwt } = await makeUser('manager'));
  grants.__setDeps({
    sendGrantCreatedEmail: async (m) => { mails.push(m); },
    sendReplayRevokedEmail: async (m) => { mails.push(m); },
    audit: async (a) => { audits.push(a); },
    captureMessage: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createConnectorAdminRouter({
    verifyPasskey: (...args) => passkey(...args),
    now: () => new Date(Date.now() + clockOffsetMs),
  }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { passkey = async () => true; clockOffsetMs = 0; mails = []; audits = []; });

after(async () => {
  const g = await pool.query('SELECT id FROM connector_grants WHERE user_id = ANY($1::int[])', [[admin.id, manager.id]]);
  const ids = g.rows.map((x) => x.id);
  if (ids.length) {
    await pool.query('DELETE FROM connector_calls WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_tokens WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_codes WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_grants WHERE id = ANY($1::int[])', [ids]);
  }
  if (requestIds.length) await pool.query('DELETE FROM connector_auth_requests WHERE id = ANY($1::uuid[])', [requestIds]);
  if (refusalIds.length) await pool.query('DELETE FROM connector_calls WHERE id = ANY($1::bigint[])', [refusalIds]);
  await pool.query('DELETE FROM webauthn_challenges WHERE user_id = ANY($1::int[])', [[admin.id, manager.id]]);
  await pool.query('DELETE FROM webauthn_credentials WHERE user_id = ANY($1::int[])', [[admin.id, manager.id]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[admin.id, manager.id]]);
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('a manager is refused on every route, and a signed-out caller gets 401', async () => {
  const id = await pendingRequest();
  for (const [method, path] of [
    ['GET', `/api/admin/connector/requests/${id}`],
    ['POST', '/api/admin/connector/assert-options'],
    ['POST', `/api/admin/connector/requests/${id}/approve`],
    ['POST', `/api/admin/connector/requests/${id}/cancel`],
    ['GET', '/api/admin/connector/status'],
    ['GET', '/api/admin/connector/calls'],
    ['POST', '/api/admin/connector/disconnect'],
  ]) {
    const res = await call(method, path, { token: managerJwt, body: method === 'POST' ? ASSERTION : undefined });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await call(method, path)).status, 401, `${method} ${path} signed out`);
  }
  const row = (await pool.query('SELECT used_at FROM connector_auth_requests WHERE id = $1', [id])).rows[0];
  assert.equal(row.used_at, null, 'the manager touched nothing');
});

test('the consent read: when and where the request started, and the codes for a bad one', async () => {
  const id = await pendingRequest();
  const res = await call('GET', `/api/admin/connector/requests/${id}`, { token: adminJwt });
  assert.equal(res.status, 200);
  assert.equal(res.body.request.status, 'pending');
  assert.equal(res.body.request.caller_address, '203.0.113.9');
  assert.equal(res.body.request.user_agent, 'test-browser');
  assert.equal(res.body.request.redirect_host, 'claude.ai');
  assert.ok(Array.isArray(res.body.request.reads) && res.body.request.reads.length >= 1);
  assert.equal(res.body.request.state, undefined, 'never the state or the challenge');
  assert.equal(res.body.request.code_challenge, undefined);
  assert.equal((await call('GET', '/api/admin/connector/requests/abcdef12-3456-4789-8abc-def012345678', { token: adminJwt })).body.code,
    'CONNECTOR_REQUEST_NOT_FOUND');
  assert.equal((await call('GET', '/api/admin/connector/requests/not-a-uuid', { token: adminJwt })).status, 404);
  clockOffsetMs = 11 * 60 * 1000;
  const expired = await call('GET', `/api/admin/connector/requests/${id}`, { token: adminJwt });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, 'CONNECTOR_REQUEST_EXPIRED');
});

test('approve: a missing or failed passkey assertion is refused and the row stays pending', async () => {
  const id = await pendingRequest();
  const missing = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'CONNECTOR_PASSKEY_REQUIRED');
  const refusedWith = (reason, code) => Object.assign(new Error('refused'), { reason, code: code || 'WEBAUTHN_UNLOCK_FAILED' });
  for (const [reason, status, code] of [
    ['WEBAUTHN_VERIFY_FAILED', 403, 'CONNECTOR_PASSKEY_FAILED'],
    ['WEBAUTHN_WRONG_ACCOUNT', 403, 'CONNECTOR_PASSKEY_WRONG_ACCOUNT'],
    ['WEBAUTHN_NO_CREDENTIAL', 409, 'CONNECTOR_PASSKEY_NONE'],
  ]) {
    passkey = async () => { throw refusedWith(reason); };
    const r = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION });
    assert.equal(r.status, status, reason);
    assert.equal(r.body.code, code, reason);
  }
  passkey = async () => { throw refusedWith(undefined, 'WEBAUTHN_CHALLENGE_INVALID'); };
  assert.equal((await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION })).body.code,
    'CONNECTOR_PASSKEY_EXPIRED');
  passkey = async () => { throw new Error('connection terminated'); };
  const unexpected = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION });
  assert.equal(unexpected.status, 500, 'an unexpected error goes to the error handler, not the try-again answer');
  let seen = null;
  passkey = async (assertion, userId) => { seen = { assertion, userId }; return true; };
  const ok = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, { assertion: ASSERTION.assertion, userId: admin.id }, 'the assertion is checked for this admin');
});

test('approve: a used or expired row is refused', async () => {
  const id = await pendingRequest();
  assert.equal((await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION })).status, 200);
  const again = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION });
  assert.equal(again.status, 410);
  assert.equal(again.body.code, 'CONNECTOR_REQUEST_USED');
  const stale = await pendingRequest();
  clockOffsetMs = 11 * 60 * 1000;
  const expired = await call('POST', `/api/admin/connector/requests/${stale}/approve`, { token: adminJwt, body: ASSERTION });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, 'CONNECTOR_REQUEST_EXPIRED');
});

// The connection email and audit run detached after the token response.
async function waitForMail(n) {
  for (let i = 0; i < 100 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 20));
}

// Approve through the route, then exchange the code the way Claude does, so
// the grant becomes the live connection. Returns the grant id and the pair.
async function connect() {
  const mailsAtStart = mails.length;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const id = await pendingRequest({ codeChallenge: challenge });
  const r = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = new URL(r.body.redirect_url).searchParams.get('code');
  const pair = await tokens.exchangeCode(
    { code, codeVerifier: verifier, redirectUri: grants.REDIRECT_URI, clientId: grants.CLIENT_ID },
    { onActivated: grants.onGrantActivated }
  );
  await waitForMail(mailsAtStart + 1);
  const g = (await pool.query('SELECT id FROM connector_grants WHERE request_id = $1', [id])).rows[0];
  return { grantId: g.id, pair, approve: r.body };
}

test('approve: two approvals of one row yield one grant, pending, and no email yet', async () => {
  const id = await pendingRequest();
  const [a, b] = await Promise.all([
    call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION }),
    call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 410]);
  const made = await pool.query('SELECT activated_at FROM connector_grants WHERE request_id = $1', [id]);
  assert.equal(made.rows.length, 1);
  assert.equal(made.rows[0].activated_at, null, 'pending until the code is exchanged');
  const codes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM connector_codes c JOIN connector_grants g ON g.id = c.grant_id WHERE g.request_id = $1', [id]
  );
  assert.equal(codes.rows[0].n, 1);
  assert.equal(mails.length, 0, 'the email waits for the connection to become real');
  assert.equal(audits.filter((x) => x.action === 'connector_grant_approved').length, 1);
});

test('an approval with a failed exchange leaves the old connection live, and cleanup revokes the pending one', async () => {
  const old = await connect();
  assert.equal((await call('GET', '/api/admin/connector/status', { token: adminJwt })).body.connection.id, old.grantId);

  const id = await pendingRequest();
  const r = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION });
  const code = new URL(r.body.redirect_url).searchParams.get('code');
  await assert.rejects(tokens.exchangeCode({ code, codeVerifier: 'x'.repeat(43), redirectUri: grants.REDIRECT_URI, clientId: grants.CLIENT_ID }),
    (e) => e.oauthError === 'invalid_grant', 'a failed exchange');

  const status = await call('GET', '/api/admin/connector/status', { token: adminJwt });
  assert.equal(status.body.connection.id, old.grantId, 'the old connection is still the connection');
  assert.equal(status.body.connection.state, 'live');
  const oldRow = (await pool.query('SELECT revoked_at FROM connector_grants WHERE id = $1', [old.grantId])).rows[0];
  assert.equal(oldRow.revoked_at, null);

  await require('../../utils/connector/cleanupScheduler').runConnectorCleanup();
  const pending = (await pool.query('SELECT revoked_reason FROM connector_grants WHERE request_id = $1', [id])).rows[0];
  assert.equal(pending.revoked_reason, 'unredeemed');
  assert.equal((await pool.query('SELECT revoked_at FROM connector_grants WHERE id = $1', [old.grantId])).rows[0].revoked_at, null,
    'cleanup leaves the live one');
});

test('the replace warning, approve\'s replaced and the email agree; the exchange revokes the old grant and its tokens', async () => {
  await call('POST', '/api/admin/connector/disconnect', { token: adminJwt }); // start with no connection
  const first = await connect();
  assert.equal(first.approve.replaced, false);
  assert.equal(mails[mails.length - 1].replaced, false);

  const second = await pendingRequest();
  const read = await call('GET', `/api/admin/connector/requests/${second}`, { token: adminJwt });
  assert.equal(read.body.existing_connection.id, first.grantId, 'the consent page warns it replaces a connection');
  const verifier = crypto.randomBytes(32).toString('base64url');
  await pool.query('UPDATE connector_auth_requests SET code_challenge = $2 WHERE id = $1',
    [second, crypto.createHash('sha256').update(verifier).digest('base64url')]);
  const r2 = await call('POST', `/api/admin/connector/requests/${second}/approve`, { token: adminJwt, body: ASSERTION });
  assert.equal(r2.body.replaced, true, 'approve says the same');
  const stillLive = (await pool.query('SELECT revoked_at FROM connector_grants WHERE id = $1', [first.grantId])).rows[0];
  assert.equal(stillLive.revoked_at, null, 'nothing is revoked until the exchange');
  const code = new URL(r2.body.redirect_url).searchParams.get('code');
  const before = mails.length;
  await tokens.exchangeCode({ code, codeVerifier: verifier, redirectUri: grants.REDIRECT_URI, clientId: grants.CLIENT_ID },
    { onActivated: grants.onGrantActivated });
  await waitForMail(before + 1);
  assert.equal(mails[mails.length - 1].replaced, true, 'and so does the email');

  const old = (await pool.query('SELECT revoked_reason FROM connector_grants WHERE id = $1', [first.grantId])).rows[0];
  assert.equal(old.revoked_reason, 'replaced');
  const live = await pool.query('SELECT COUNT(*)::int AS n FROM connector_tokens WHERE grant_id = $1 AND revoked_at IS NULL', [first.grantId]);
  assert.equal(live.rows[0].n, 0);
  const liveGrants = await pool.query('SELECT COUNT(*)::int AS n FROM connector_grants WHERE revoked_at IS NULL AND activated_at IS NOT NULL');
  assert.equal(liveGrants.rows[0].n, 1, 'one connection at a time');

  // A lapsed connection is no warning, no replaced, and no "replaced" in the email.
  const g2 = (await pool.query('SELECT id FROM connector_grants WHERE request_id = $1', [second])).rows[0];
  await pool.query("UPDATE connector_grants SET last_used_at = NOW() - INTERVAL '31 days' WHERE id = $1", [g2.id]);
  const third = await pendingRequest();
  assert.equal((await call('GET', `/api/admin/connector/requests/${third}`, { token: adminJwt })).body.existing_connection, null);
  assert.equal((await call('POST', `/api/admin/connector/requests/${third}/approve`, { token: adminJwt, body: ASSERTION })).body.replaced, false);
});

test('the code is bound to its request and lives 60 seconds', async () => {
  const id = await pendingRequest();
  const r1 = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION });
  const code = new URL(r1.body.redirect_url).searchParams.get('code');
  const row = (await pool.query('SELECT * FROM connector_codes WHERE code_hash = $1', [tokens.hashToken(code)])).rows[0];
  assert.equal(row.client_id, grants.CLIENT_ID);
  assert.equal(row.redirect_uri, grants.REDIRECT_URI);
  const ttl = new Date(row.expires_at) - new Date(row.created_at);
  assert.equal(ttl, 60 * 1000);
});

test('approving a cancelled request answers CONNECTOR_REQUEST_CANCELLED', async () => {
  const id = await pendingRequest();
  await call('POST', `/api/admin/connector/requests/${id}/cancel`, { token: adminJwt });
  const r = await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'CONNECTOR_REQUEST_CANCELLED');
});

test('cancel sends the browser back with access_denied and the state, and spends the row', async () => {
  const id = await pendingRequest();
  const res = await call('POST', `/api/admin/connector/requests/${id}/cancel`, { token: adminJwt });
  assert.equal(res.status, 200);
  const back = new URL(res.body.redirect_url);
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('state'), 'state-xyz');
  assert.equal(back.searchParams.get('code'), null);
  assert.equal((await call('POST', `/api/admin/connector/requests/${id}/approve`, { token: adminJwt, body: ASSERTION })).body.code, 'CONNECTOR_REQUEST_CANCELLED');
  assert.equal((await call('GET', `/api/admin/connector/requests/${id}`, { token: adminJwt })).body.code, 'CONNECTOR_REQUEST_CANCELLED');
});

test('status after a token_version bump is signed_out, not live, and the consent page warns of no live connection', async () => {
  const { grantId } = await connect();
  assert.equal((await call('GET', '/api/admin/connector/status', { token: adminJwt })).body.connection.state, 'live');
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [admin.id]);
  try {
    const fresh = jwt.sign({ userId: admin.id, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const s = await call('GET', '/api/admin/connector/status', { token: fresh });
    assert.equal(s.body.connection.id, grantId);
    assert.equal(s.body.connection.state, 'signed_out', 'the same rule every real use applies');
    const id = await pendingRequest();
    assert.equal((await call('GET', `/api/admin/connector/requests/${id}`, { token: fresh })).body.existing_connection, null);
  } finally {
    await pool.query('UPDATE users SET token_version = 0 WHERE id = $1', [admin.id]);
  }
});

test('status, the call list with withheld rows, and a disconnect that leaves the log', async () => {
  await connect();
  const status = await call('GET', '/api/admin/connector/status', { token: adminJwt });
  assert.equal(status.status, 200);
  assert.equal(status.body.connection.state, 'live');
  assert.equal(status.body.client_id, grants.CLIENT_ID);
  assert.equal(status.body.mcp_url, 'https://api.example.com/mcp');
  assert.equal(status.body.address_check, 'off', 'not production here');
  process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS = '160.79.104.0/21;garbage';
  try {
    const bad = await call('GET', '/api/admin/connector/status', { token: adminJwt });
    assert.equal(bad.body.address_check, 'unreadable', 'an unreadable range shows in status');
  } finally {
    delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  }
  const grantId = status.body.connection.id;

  await callLog.recordCall({ grantId, method: 'tools/list', outcome: 'ok', callerAddress: '160.79.104.9' });
  await callLog.recordCall({ grantId, method: 'tools/call', toolName: 'client', recordIds: ['c-123'], clientId: 123, resultCount: 1, outcome: 'ok' });
  const ref = `test-withheld-${NONCE}`;
  assert.equal(await callLog.recordWithheldOnce({ grantId, toolName: 'thread', withheldRef: ref, recordIds: ['m-9'] }), true);

  const refusalId = await callLog.recordCall({ callerAddress: '198.51.100.77', outcome: 'refused_token' });
  refusalIds.push(refusalId);
  const list = await call('GET', '/api/admin/connector/calls', { token: adminJwt });
  const mine = list.body.calls.filter((c) => c.grant_id === grantId);
  assert.deepEqual(mine.map((c) => c.outcome), ['withheld', 'ok'], 'newest first, protocol traffic left out');
  assert.equal(list.body.calls.some((c) => c.id === refusalId), true, 'refusals are in the default list, with their address');
  const toolsOnly = await call('GET', '/api/admin/connector/calls?refusals=0', { token: adminJwt });
  assert.equal(toolsOnly.body.calls.some((c) => c.id === refusalId), false, 'refusals=0 is the tool-calls-only view');
  const one = await call('GET', '/api/admin/connector/calls?limit=1', { token: adminJwt });
  assert.equal(one.body.calls.length, 1);
  assert.equal(one.body.has_more, true, 'more rows exist past the limit, and the response says so');
  assert.equal(mine[1].tool_name, 'client');
  const all = await call('GET', '/api/admin/connector/calls?all=1', { token: adminJwt });
  assert.equal(all.body.calls.filter((c) => c.grant_id === grantId).length, 3);
  const withheld = await call('GET', '/api/admin/connector/calls?outcome=withheld', { token: adminJwt });
  assert.ok(withheld.body.calls.every((c) => c.outcome === 'withheld'));
  assert.ok(withheld.body.calls.some((c) => c.withheld_ref === ref));
  assert.equal((await call('GET', '/api/admin/connector/calls?outcome=bogus', { token: adminJwt })).status, 400);
  assert.equal((await call('GET', '/api/admin/connector/calls?limit=0', { token: adminJwt })).status, 400);

  const d = await call('POST', '/api/admin/connector/disconnect', { token: adminJwt });
  assert.equal(d.body.ok, true);
  assert.ok(d.body.revoked >= 1, 'the connection, and any approval still pending');
  assert.equal(audits[audits.length - 1].action, 'connector_disconnected');
  const after = await call('GET', '/api/admin/connector/status', { token: adminJwt });
  assert.equal(after.body.connection, null);
  const kept = await pool.query('SELECT COUNT(*)::int AS n FROM connector_calls WHERE grant_id = $1', [grantId]);
  assert.equal(kept.rows[0].n, 3, 'the log rows stay');
  assert.deepEqual((await call('POST', '/api/admin/connector/disconnect', { token: adminJwt })).body, { ok: true, revoked: 0 });
});

// ─── The real passkey check, with only the signature verify stubbed ──────────

function assertionFor(challenge, credentialId, userId) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: b64({ type: 'webauthn.get', challenge, origin: 'http://localhost:3000' }),
      authenticatorData: b64('authdata'),
      signature: b64('sig'),
      userHandle: b64(String(userId)),
    },
    clientExtensionResults: {},
  };
}

async function enrol(userId) {
  const credentialId = `conn-cred-${userId}-${NONCE}`;
  await pool.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, label)
     VALUES ($1, $2, $3, 0, '[]', 'test')`,
    [userId, credentialId, Buffer.from('pk').toString('base64url')]
  );
  return credentialId;
}

test('the real passkey check: a challenge bound to this admin passes once; an unbound or foreign one fails', async () => {
  const webauthn = require('../webauthn');
  const verify = async () => ({ verified: true, authenticationInfo: { newCounter: 0 } });
  assert.equal(await webauthn.assertionOptionsForUser(admin.id), null, 'no passkey yet: no options');
  await assert.rejects(webauthn.verifyAssertionForUser(assertionFor('x', 'none', admin.id), admin.id, { verify }),
    (e) => e.reason === 'WEBAUTHN_NO_CREDENTIAL');
  const noneRoute = await call('POST', '/api/admin/connector/assert-options', { token: adminJwt });
  assert.equal(noneRoute.status, 409);
  assert.equal(noneRoute.body.code, 'CONNECTOR_PASSKEY_NONE');
  const cred = await enrol(admin.id);

  const opts = await webauthn.assertionOptionsForUser(admin.id);
  assert.deepEqual(opts.allowCredentials.map((c) => c.id), [cred], 'only the admin\'s own passkeys are offered');
  const bound = await pool.query('SELECT user_id, kind FROM webauthn_challenges WHERE challenge = $1', [opts.challenge]);
  assert.deepEqual(bound.rows[0], { user_id: admin.id, kind: 'assert' }, 'bound to the admin');
  assert.equal(await webauthn.verifyAssertionForUser(assertionFor(opts.challenge, cred, admin.id), admin.id, { verify }), true);
  await assert.rejects(webauthn.verifyAssertionForUser(assertionFor(opts.challenge, cred, admin.id), admin.id, { verify }),
    (e) => e.code === 'WEBAUTHN_CHALLENGE_INVALID', 'single use');

  // A phone-unlock challenge (unbound) cannot be spent here.
  const unbound = `unbound-${NONCE}`;
  await pool.query(
    "INSERT INTO webauthn_challenges (challenge, user_id, kind, expires_at) VALUES ($1, NULL, 'assert', NOW() + INTERVAL '5 minutes')",
    [unbound]
  );
  try {
    await assert.rejects(webauthn.verifyAssertionForUser(assertionFor(unbound, cred, admin.id), admin.id, { verify }),
      (e) => e.code === 'WEBAUTHN_CHALLENGE_INVALID');
  } finally {
    await pool.query('DELETE FROM webauthn_challenges WHERE challenge = $1', [unbound]);
  }

  // Another account's passkey on this admin's challenge fails the uniform way.
  const otherCred = await enrol(manager.id);
  const opts2 = await webauthn.assertionOptionsForUser(admin.id);
  await assert.rejects(webauthn.verifyAssertionForUser(assertionFor(opts2.challenge, otherCred, manager.id), admin.id, { verify }),
    (e) => e.code === 'WEBAUTHN_UNLOCK_FAILED' && e.reason === 'WEBAUTHN_WRONG_ACCOUNT');
  // Through the route: the other account's passkey gets its own code.
  const realRouter = createConnectorAdminRouter({ verifyPasskey: (a, u) => webauthn.verifyAssertionForUser(a, u, { verify }) });
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/admin', realRouter);
  app2.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ code: err.code });
    return next(err);
  });
  const s3 = await new Promise((resolve) => { const s = app2.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const opts4 = await webauthn.assertionOptionsForUser(admin.id);
    const id = await pendingRequest();
    const body = JSON.stringify({ assertion: assertionFor(opts4.challenge, otherCred, manager.id) });
    const res = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port: s3.address().port, path: `/api/admin/connector/requests/${id}/approve`, method: 'POST',
        headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (resp) => {
        let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(d) }));
      });
      r.on('error', reject); r.write(body); r.end();
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CONNECTOR_PASSKEY_WRONG_ACCOUNT');
  } finally {
    await new Promise((r) => s3.close(r));
  }
  // A failed signature fails the uniform way.
  const opts3 = await webauthn.assertionOptionsForUser(admin.id);
  await assert.rejects(webauthn.verifyAssertionForUser(assertionFor(opts3.challenge, cred, admin.id), admin.id,
    { verify: async () => ({ verified: false }) }), (e) => e.code === 'WEBAUTHN_UNLOCK_FAILED');
});

test('the real passkey check mints nothing, and the route\'s options come bound to the caller', async () => {
  const webauthn = require('../webauthn');
  const cred = `conn-cred-${admin.id}-${NONCE}`;
  const opts = await webauthn.assertionOptionsForUser(admin.id);
  const out = await webauthn.verifyAssertionForUser(assertionFor(opts.challenge, cred, admin.id), admin.id,
    { verify: async () => ({ verified: true, authenticationInfo: { newCounter: 0 } }) });
  assert.equal(out, true, 'a bare true: no token, no session, no user payload');

  const router = createConnectorAdminRouter({ verifyPasskey: async () => true });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  const s2 = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port: s2.address().port, path: '/api/admin/connector/assert-options', method: 'POST',
        headers: { Authorization: `Bearer ${adminJwt}` } }, (resp) => {
        let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(d) }));
      });
      r.on('error', reject); r.end();
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.challenge);
    const row = await pool.query('SELECT user_id FROM webauthn_challenges WHERE challenge = $1', [res.body.challenge]);
    assert.equal(row.rows[0].user_id, admin.id);
  } finally {
    await new Promise((r) => s2.close(r));
  }
});
