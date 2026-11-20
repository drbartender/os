require('dotenv').config();
process.env.NODE_ENV = 'test';

// The connector's authorize and token routes (spec 2026-11-19 section 7.2, law
// 9). Authorize: a wrong client id or return address is an error page with no
// redirect; a missing challenge goes back with an error; the state is
// optional, stored and echoed when present, absent when not. Token: a
// wrong verifier, a wrong return address and an expired code are refused; a
// code used twice is refused and its tokens die; two parallel refreshes leave
// one winner and a live grant; a rotated-out refresh token inside 30 seconds
// is refused with the grant alive, after 30 seconds it revokes the grant and
// both alerts fire (stubs). The clock is injected where time matters.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../db');
const grants = require('../utils/connector/grants');
const tokens = require('../utils/connector/tokens');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server; let base; let admin;
let clockOffsetMs = 0;
const requestIds = [];
let alerts = []; let mails = []; let audits = [];

function call(method, path, { headers = {}, form } = {}) {
  return new Promise((resolve, reject) => {
    const payload = form ? new URLSearchParams(form).toString() : null;
    const u = new URL(base + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeQuery(over = {}) {
  const q = {
    response_type: 'code',
    client_id: grants.CLIENT_ID,
    redirect_uri: grants.REDIRECT_URI,
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
    state: 'state-abc',
    resource: `${base}/mcp`,
    ...over,
  };
  for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];
  return `/oauth/authorize?${new URLSearchParams(q).toString()}`;
}

// A pending request approved through the real approve path, with a fresh code.
async function approvedCode() {
  const { verifier, challenge } = pkcePair();
  const id = await grants.createRequest({
    clientId: grants.CLIENT_ID, redirectUri: grants.REDIRECT_URI, codeChallenge: challenge,
    state: 'st', resource: `${base}/mcp`, callerAddress: '127.0.0.1',
  });
  requestIds.push(id);
  const out = await grants.approveRequest({ requestId: id, user: admin });
  const code = new URL(out.redirectUrl).searchParams.get('code');
  return { code, verifier, grantId: out.grantId };
}

function exchange(code, verifier, over = {}) {
  return call('POST', '/oauth/token', {
    form: {
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: grants.REDIRECT_URI, client_id: grants.CLIENT_ID, resource: `${base}/mcp`, ...over,
    },
  });
}

function refresh(refreshToken) {
  return call('POST', '/oauth/token', {
    form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: grants.CLIENT_ID },
  });
}

async function grantRow(id) {
  return (await pool.query('SELECT revoked_at, revoked_reason FROM connector_grants WHERE id = $1', [id])).rows[0];
}

before(async () => {
  process.env.CLAUDE_CONNECTOR_ENABLED = 'true';
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, email, role`,
    [`connector-oauth-${NONCE}@example.com`]
  );
  admin = r.rows[0];
  grants.__setDeps({
    sendGrantCreatedEmail: async () => {},
    sendReplayRevokedEmail: async (m) => { mails.push(m); },
    audit: async (a) => { audits.push(a); },
    captureMessage: (msg, ctx) => { alerts.push({ msg, ctx }); },
  });
  server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.API_URL = base;
  const { createConnectorOauthRouter } = require('./connectorOauth');
  const app = express();
  app.use('/', createConnectorOauthRouter({ now: () => new Date(Date.now() + clockOffsetMs) }));
  server.on('request', app);
});

beforeEach(() => { clockOffsetMs = 0; alerts = []; mails = []; audits = []; });

after(async () => {
  const g = await pool.query('SELECT id FROM connector_grants WHERE user_id = $1', [admin.id]);
  const ids = g.rows.map((x) => x.id);
  if (ids.length) {
    await pool.query('DELETE FROM connector_tokens WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_codes WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_calls WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_grants WHERE id = ANY($1::int[])', [ids]);
  }
  if (requestIds.length) await pool.query('DELETE FROM connector_auth_requests WHERE id = ANY($1::uuid[])', [requestIds]);
  await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('authorize: a wrong client id or return address gets an error page and no redirect', async () => {
  for (const over of [
    { client_id: 'someone-else' },
    { client_id: undefined },
    { redirect_uri: 'https://evil.example.org/callback' },
    { redirect_uri: `${grants.REDIRECT_URI}/extra` },
  ]) {
    const res = await call('GET', authorizeQuery(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal(res.headers.location, undefined, 'no redirect');
    assert.match(res.headers['content-type'], /text\/html/);
    assert.doesNotMatch(String(res.body), /evil/, 'echoes nothing it was sent');
  }
});

test('authorize: a missing challenge, a plain method or an oversized state redirects back with an error', async () => {
  const cases = [
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ state: 'x'.repeat(1025) }, 'invalid_request'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ resource: 'https://evil.example.org/mcp' }, 'invalid_target'],
  ];
  for (const [over, error] of cases) {
    const res = await call('GET', authorizeQuery(over));
    assert.equal(res.status, 302, JSON.stringify(over));
    const loc = new URL(res.headers.location);
    assert.equal(`${loc.origin}${loc.pathname}`, grants.REDIRECT_URI);
    assert.equal(loc.searchParams.get('error'), error);
    assert.equal(loc.searchParams.get('state'), over.state || 'state-abc', 'the state is echoed on an error');
  }
});

test('authorize: a valid request stores a pending row good for ten minutes and sends only its id', async () => {
  const res = await call('GET', authorizeQuery(), { headers: { 'User-Agent': 'test-agent/1' } });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.location);
  const id = loc.searchParams.get('request');
  requestIds.push(id);
  const row = (await pool.query('SELECT * FROM connector_auth_requests WHERE id = $1', [id])).rows[0];
  assert.equal(row.client_id, grants.CLIENT_ID);
  assert.equal(row.state, 'state-abc');
  assert.equal(row.user_agent, 'test-agent/1');
  assert.match(row.caller_address, /127\.0\.0\.1$/);
  const ttl = new Date(row.expires_at) - new Date(row.requested_at);
  assert.ok(Math.abs(ttl - 10 * 60 * 1000) < 5000, `ttl ${ttl}`);
});

test('authorize: with no state the request still goes to the consent page, and no redirect carries one', async () => {
  const res = await call('GET', authorizeQuery({ state: undefined }));
  assert.equal(res.status, 302);
  const id = new URL(res.headers.location).searchParams.get('request');
  assert.ok(grants.isRequestId(id));
  requestIds.push(id);
  const row = (await pool.query('SELECT state FROM connector_auth_requests WHERE id = $1', [id])).rows[0];
  assert.equal(row.state, null);
  const approved = await grants.approveRequest({ requestId: id, user: admin });
  const back = new URL(approved.redirectUrl);
  assert.ok(back.searchParams.get('code'));
  assert.equal(back.searchParams.has('state'), false, 'no state on the code redirect');
  const errored = await call('GET', authorizeQuery({ state: undefined, code_challenge: undefined }));
  assert.equal(new URL(errored.headers.location).searchParams.has('state'), false, 'none on an error redirect');
  const cancelId = new URL((await call('GET', authorizeQuery({ state: undefined }))).headers.location).searchParams.get('request');
  requestIds.push(cancelId);
  const cancelled = new URL((await grants.cancelRequest({ requestId: cancelId })).redirectUrl);
  assert.equal(cancelled.searchParams.get('error'), 'access_denied');
  assert.equal(cancelled.searchParams.has('state'), false, 'none on access_denied');
});

test('authorize: a present state is stored and echoed on the code redirect', async () => {
  const res = await call('GET', authorizeQuery({ state: 'echo-me-123' }));
  const id = new URL(res.headers.location).searchParams.get('request');
  requestIds.push(id);
  const approved = await grants.approveRequest({ requestId: id, user: admin });
  assert.equal(new URL(approved.redirectUrl).searchParams.get('state'), 'echo-me-123');
});

test('token: a wrong verifier, a wrong return address and an expired code are refused', async () => {
  const a = await approvedCode();
  const wrongVerifier = await exchange(a.code, pkcePair().verifier);
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.body.error, 'invalid_grant');

  const b = await approvedCode();
  const wrongReturn = await exchange(b.code, b.verifier, { redirect_uri: 'https://evil.example.org/cb' });
  assert.equal(wrongReturn.body.error, 'invalid_grant');

  const c = await approvedCode();
  clockOffsetMs = 61 * 1000;
  const expired = await exchange(c.code, c.verifier);
  assert.equal(expired.body.error, 'invalid_grant');
  assert.match(expired.body.error_description, /expired/);

  const d = await approvedCode();
  assert.equal((await exchange(d.code, d.verifier, { client_id: 'other' })).status, 401, 'invalid_client');
  assert.equal((await exchange(d.code, d.verifier, { resource: 'https://evil.example.org/mcp' })).body.error, 'invalid_target');
  assert.equal((await call('POST', '/oauth/token', { form: { grant_type: 'password', client_id: grants.CLIENT_ID } })).body.error,
    'unsupported_grant_type');
});

test('token: a good exchange answers the token response with no-store', async () => {
  const a = await approvedCode();
  const res = await exchange(a.code, a.verifier);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.token_type, 'Bearer');
  assert.equal(res.body.expires_in, 3600);
  assert.ok(tokens.hasShape(res.body.access_token, tokens.ACCESS_PREFIX));
  assert.ok(tokens.hasShape(res.body.refresh_token, tokens.REFRESH_PREFIX));
  const stored = await pool.query('SELECT token_hash FROM connector_tokens WHERE grant_id = $1', [a.grantId]);
  assert.equal(stored.rows.length, 2);
  for (const row of stored.rows) {
    assert.notEqual(row.token_hash, res.body.access_token, 'only the hash is stored');
  }
  assert.ok(stored.rows.some((row) => row.token_hash === tokens.hashToken(res.body.access_token)));
});

test('token: a code used twice is refused and the tokens issued from it die', async () => {
  const a = await approvedCode();
  const first = await exchange(a.code, a.verifier);
  assert.equal(first.status, 200);
  const second = await exchange(a.code, a.verifier);
  assert.equal(second.status, 400);
  assert.equal(second.body.error, 'invalid_grant');
  const g = await grantRow(a.grantId);
  assert.equal(g.revoked_reason, 'code_replay');
  const live = await pool.query('SELECT COUNT(*)::int AS n FROM connector_tokens WHERE grant_id = $1 AND revoked_at IS NULL', [a.grantId]);
  assert.equal(live.rows[0].n, 0);
  assert.equal((await refresh(first.body.refresh_token)).body.error, 'invalid_grant', 'the refresh token died too');
  assert.equal(alerts.length, 1, 'Sentry alerted');
  assert.equal(mails.length, 1, 'the owner emailed');
  assert.equal(mails[0].kind, 'code_replay');
  assert.equal(audits.filter((a) => a.action === 'connector_grant_revoked_replay').length, 1, 'the audit entry');
});

test('token: two parallel refreshes leave one winner and a live grant', async () => {
  const a = await approvedCode();
  const pair = (await exchange(a.code, a.verifier)).body;
  const [r1, r2] = await Promise.all([refresh(pair.refresh_token), refresh(pair.refresh_token)]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 400]);
  const loser = r1.status === 400 ? r1 : r2;
  assert.equal(loser.body.error, 'invalid_grant');
  const g = await grantRow(a.grantId);
  assert.equal(g.revoked_at, null, 'the grant lives');
  assert.equal(alerts.length, 0);
  assert.equal(mails.length, 0);
});

test('token: a rotated-out refresh token inside 30 seconds is refused with the grant alive; after 30 it revokes and both alerts fire', async () => {
  const a = await approvedCode();
  const pair = (await exchange(a.code, a.verifier)).body;
  const next = await refresh(pair.refresh_token);
  assert.equal(next.status, 200);

  clockOffsetMs = 20 * 1000;
  const inGrace = await refresh(pair.refresh_token);
  assert.equal(inGrace.body.error, 'invalid_grant');
  assert.equal((await grantRow(a.grantId)).revoked_at, null);
  assert.equal(alerts.length + mails.length, 0, 'no alert inside the grace');

  clockOffsetMs = 31 * 1000;
  const late = await refresh(pair.refresh_token);
  assert.equal(late.body.error, 'invalid_grant');
  const g = await grantRow(a.grantId);
  assert.equal(g.revoked_reason, 'refresh_replay');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].msg, 'connector_replay_revoked');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, admin.email);
  assert.equal(mails[0].kind, 'refresh_replay');
  clockOffsetMs = 0;
  assert.equal((await refresh(next.body.refresh_token)).body.error, 'invalid_grant', 'the rotated-in token died with the grant');
});

test('token: a refresh for a demoted owner or a bumped token_version is refused', async () => {
  const a = await approvedCode();
  const pair = (await exchange(a.code, a.verifier)).body;
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [admin.id]);
  try {
    assert.equal((await refresh(pair.refresh_token)).body.error, 'invalid_grant');
  } finally {
    await pool.query('UPDATE users SET token_version = 0 WHERE id = $1', [admin.id]);
  }
});

test('token: a refresh after a lapse is refused unstamped, and a retry after 30 seconds raises no alarm', async () => {
  const a = await approvedCode();
  const pair = (await exchange(a.code, a.verifier)).body;
  const hash = tokens.hashToken(pair.refresh_token);
  clockOffsetMs = 31 * 24 * 60 * 60 * 1000; // 31 days unused
  const first = await refresh(pair.refresh_token);
  assert.equal(first.body.error, 'invalid_grant');
  const row = (await pool.query('SELECT rotated_at FROM connector_tokens WHERE token_hash = $1', [hash])).rows[0];
  assert.equal(row.rotated_at, null, 'not stamped rotated');
  clockOffsetMs += 60 * 1000;
  assert.equal((await refresh(pair.refresh_token)).body.error, 'invalid_grant');
  assert.equal(alerts.length + mails.length, 0, 'no alarm');
  assert.equal(audits.some((x) => x.action === 'connector_grant_revoked_replay'), false);
  assert.equal((await grantRow(a.grantId)).revoked_reason, null, 'not marked refresh_replay');
  // The same after a token_version bump, five minutes apart.
  clockOffsetMs = 0;
  const b = await approvedCode();
  const pairB = (await exchange(b.code, b.verifier)).body;
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [admin.id]);
  try {
    assert.equal((await refresh(pairB.refresh_token)).body.error, 'invalid_grant');
    clockOffsetMs = 5 * 60 * 1000;
    assert.equal((await refresh(pairB.refresh_token)).body.error, 'invalid_grant');
    assert.equal(alerts.length + mails.length, 0);
    assert.equal((await grantRow(b.grantId)).revoked_reason, null);
  } finally {
    await pool.query('UPDATE users SET token_version = 0 WHERE id = $1', [admin.id]);
  }
});

test('token: a spent code presented a third time raises the alarm once, not again', async () => {
  const a = await approvedCode();
  assert.equal((await exchange(a.code, a.verifier)).status, 200);
  await exchange(a.code, a.verifier);
  await exchange(a.code, a.verifier);
  assert.equal(alerts.length, 1, 'one alert: only the presentation that revoked');
  assert.equal(mails.length, 1);
});

test('token: the exchange makes the approval live and replaces the old connection in one step', async () => {
  const a = await approvedCode();
  assert.equal((await exchange(a.code, a.verifier)).status, 200);
  const b = await approvedCode();
  assert.equal((await grantRow(a.grantId)).revoked_at, null, 'approving alone revokes nothing');
  assert.equal((await exchange(b.code, b.verifier)).status, 200);
  assert.equal((await grantRow(a.grantId)).revoked_reason, 'replaced');
  const live = await pool.query('SELECT activated_at FROM connector_grants WHERE id = $1', [b.grantId]);
  assert.ok(live.rows[0].activated_at);
});

test('token: an owner email that never resolves does not delay the token response', async () => {
  const prev = grants.getDeps();
  let called = 0;
  grants.__setDeps({ sendGrantCreatedEmail: () => { called += 1; return new Promise(() => {}); } });
  try {
    const a = await approvedCode();
    const started = Date.now();
    const res = await exchange(a.code, a.verifier);
    const took = Date.now() - started;
    assert.equal(res.status, 200);
    assert.ok(took < 3000, `answered in ${took} ms`);
    for (let i = 0; i < 50 && !called; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, 1, 'the email was still sent, after the response');
  } finally {
    grants.__setDeps({ sendGrantCreatedEmail: prev.sendGrantCreatedEmail });
  }
});

test('token: a replayed code on an approval never exchanged revokes it quietly; the live connection stays', async () => {
  const live = await approvedCode();
  assert.equal((await exchange(live.code, live.verifier)).status, 200);
  const pending = await approvedCode();
  assert.equal((await exchange(pending.code, 'x'.repeat(43))).body.error, 'invalid_grant', 'a failed first exchange spends the code');
  alerts = []; mails = []; audits = [];
  assert.equal((await exchange(pending.code, pending.verifier)).body.error, 'invalid_grant');
  assert.equal((await grantRow(pending.grantId)).revoked_reason, 'code_replay');
  assert.equal((await grantRow(live.grantId)).revoked_at, null, 'the live connection is untouched');
  assert.equal(mails.length, 0, 'no "cut off" email');
  assert.equal(alerts.filter((x) => x.msg === 'connector_replay_revoked').length, 0, 'no alarm claiming a cut connection');
  assert.equal(audits.filter((x) => x.action === 'connector_pending_grant_revoked_replay').length, 1, 'its own audit reason');
});
