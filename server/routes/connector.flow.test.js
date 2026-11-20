require('dotenv').config();
process.env.NODE_ENV = 'test';

// The Claude connector end to end, in process (spec 2026-11-19 sections 7.1,
// 7.2, 10 step 2): with the flag off every connector path is 404; with it on,
// an unauthenticated /mcp call gets 401 with the resource_metadata pointer,
// the metadata names the configured public URL, and the SDK's own client runs
// the whole sign-in (authorize, approve with a stubbed passkey, the PKCE code
// exchange, a tool listing, a refresh). Also: GET /mcp is 405, an oversized
// body is refused, an admin session JWT is refused at /mcp, a connector token
// is refused by auth() at /api/admin/inbox, and the call log holds the
// caller's address as req.ip reads it. Nothing here reaches Claude.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError, refreshAuthorization, discoverAuthorizationServerMetadata } = require('@modelcontextprotocol/sdk/client/auth.js');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const grants = require('../utils/connector/grants');
const tokens = require('../utils/connector/tokens');
const callLog = require('../utils/connector/callLog');
const { connectorAddressCeilingLimiter, connectorMcpAddressLimiter } = require('../middleware/rateLimiters');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server; let base; let admin; let adminJwt;
const requestIds = [];
let firstRefusalId = 0;
const sentMail = [];
const audits = [];

function call(method, path, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : (body === undefined ? null : JSON.stringify(body));
    const u = new URL(base + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) { /* html or text */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload !== null) r.write(payload);
    r.end();
  });
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

// The SDK client's OAuth provider: Claude's fixed return address and the
// pre-registered client id; the "browser" is this suite.
class TestProvider {
  constructor() { this.saved = null; this.verifier = null; this.authUrl = null; }
  get redirectUrl() { return grants.REDIRECT_URI; }
  get clientMetadata() {
    return {
      redirect_uris: [grants.REDIRECT_URI], client_name: 'test client',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() { return { client_id: grants.CLIENT_ID }; }
  // No state(): the SDK then sends none, and the sign-in must still work (state
  // is optional; PKCE carries the CSRF protection).
  tokens() { return this.saved || undefined; }
  saveTokens(t) { this.saved = t; }
  redirectToAuthorization(url) { this.authUrl = url; }
  saveCodeVerifier(v) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

before(async () => {
  process.env.CLAUDE_CONNECTOR_ENABLED = 'true';
  delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, email, token_version`,
    [`connector-flow-${NONCE}@example.com`]
  );
  admin = r.rows[0];
  adminJwt = jwt.sign({ userId: admin.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  firstRefusalId = Number((await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM connector_calls')).rows[0].m);

  grants.__setDeps({
    sendGrantCreatedEmail: async (m) => { sentMail.push(m); },
    sendReplayRevokedEmail: async (m) => { sentMail.push(m); },
    audit: async (a) => { audits.push(a); },
    captureMessage: () => {},
  });

  server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.API_URL = base;

  const { createConnectorAdminRouter } = require('./admin/connector');
  const app = express();
  app.set('trust proxy', 1);
  // The mount order of server/index.js: the connector ahead of the parsers.
  app.use('/', require('./connectorOauth'));
  app.use('/mcp', require('./connectorMcp'));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', createConnectorAdminRouter({ verifyPasskey: async () => true }));
  app.use('/api/admin', require('./admin/inbox'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server.on('request', app);
});

after(async () => {
  const g = await pool.query('SELECT id FROM connector_grants WHERE user_id = $1', [admin.id]);
  const ids = g.rows.map((x) => x.id);
  if (ids.length) {
    await pool.query('DELETE FROM connector_calls WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_tokens WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_codes WHERE grant_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM connector_grants WHERE id = ANY($1::int[])', [ids]);
  }
  // The refusals this suite caused carry no grant: the rows written after its start.
  await pool.query('DELETE FROM connector_calls WHERE grant_id IS NULL AND id > $1', [firstRefusalId]);
  if (requestIds.length) await pool.query('DELETE FROM connector_auth_requests WHERE id = ANY($1::uuid[])', [requestIds]);
  await pool.query('DELETE FROM users WHERE id = $1', [admin.id]);
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('with the flag unset, every connector path answers 404', async () => {
  delete process.env.CLAUDE_CONNECTOR_ENABLED;
  try {
    const auth = { Authorization: `Bearer ${adminJwt}` };
    const id = 'abcdef12-3456-4789-8abc-def012345678';
    const paths = [
      ['POST', '/mcp', {}], ['GET', '/mcp', {}],
      ['GET', '/.well-known/oauth-protected-resource/mcp', {}],
      ['GET', '/.well-known/oauth-protected-resource', {}],
      ['GET', '/.well-known/oauth-authorization-server', {}],
      ['GET', '/oauth/authorize?client_id=x', {}],
      ['POST', '/oauth/token', {}],
      ['GET', `/api/admin/connector/requests/${id}`, auth],
      ['POST', '/api/admin/connector/assert-options', auth],
      ['POST', `/api/admin/connector/requests/${id}/approve`, auth],
      ['POST', `/api/admin/connector/requests/${id}/cancel`, auth],
      ['GET', '/api/admin/connector/status', auth],
      ['GET', '/api/admin/connector/calls', auth],
      ['POST', '/api/admin/connector/disconnect', auth],
    ];
    for (const [method, path, headers] of paths) {
      const res = await call(method, path, { headers: { ...MCP_HEADERS, ...headers }, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 404, `${method} ${path} answered ${res.status}`);
    }
  } finally {
    process.env.CLAUDE_CONNECTOR_ENABLED = 'true';
  }
});

test('an unauthenticated /mcp call gets 401 with the resource_metadata pointer, logged with its address', async () => {
  callLog.__resetRefusalWindow();
  const res = await call('POST', '/mcp', { headers: MCP_HEADERS, body: LIST_TOOLS });
  assert.equal(res.status, 401);
  assert.equal(res.headers['www-authenticate'], `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  const bad = await call('POST', '/mcp', { headers: { ...MCP_HEADERS, Authorization: `Bearer ${tokens.mint(tokens.ACCESS_PREFIX)}` }, body: LIST_TOOLS });
  assert.equal(bad.status, 401);
  assert.match(bad.headers['www-authenticate'], /^Bearer error="invalid_token", resource_metadata="/);
  const logged = await pool.query(
    "SELECT caller_address, grant_id FROM connector_calls WHERE id > $1 AND outcome = 'refused_token' ORDER BY id DESC LIMIT 1",
    [firstRefusalId]
  );
  assert.equal(logged.rows[0].grant_id, null);
  assert.match(logged.rows[0].caller_address, /127\.0\.0\.1$/, 'req.ip as Express reads it');
});

test('the metadata names the configured public URL and an S256-only public client', async () => {
  const prm = await call('GET', '/.well-known/oauth-protected-resource/mcp');
  assert.equal(prm.status, 200);
  assert.equal(prm.body.resource, `${base}/mcp`);
  assert.deepEqual(prm.body.authorization_servers, [base]);
  const root = await call('GET', '/.well-known/oauth-protected-resource');
  assert.deepEqual(root.body, prm.body);
  const as = await call('GET', '/.well-known/oauth-authorization-server');
  assert.equal(as.body.issuer, base);
  assert.equal(as.body.authorization_endpoint, `${base}/oauth/authorize`);
  assert.equal(as.body.token_endpoint, `${base}/oauth/token`);
  assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.body.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(as.body.registration_endpoint, undefined, 'no self-registration');
});

test('GET /mcp is 405 and a body over the limit is refused', async () => {
  const get = await call('GET', '/mcp', { headers: MCP_HEADERS });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  assert.equal((await call('DELETE', '/mcp')).status, 405);
  // A valid token is needed to reach the parser: an unauthenticated body is never read.
  const { access } = await directGrant();
  const big = JSON.stringify({ ...LIST_TOOLS, params: { pad: 'x'.repeat(70 * 1024) } });
  const res = await call('POST', '/mcp', { headers: { ...MCP_HEADERS, Authorization: `Bearer ${access}` }, raw: big });
  assert.equal(res.status, 413);
});

// A grant made straight in the database, with one live access token.
async function directGrant() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE connector_grants SET revoked_at = NOW(), revoked_reason = 'replaced' WHERE revoked_at IS NULL");
    const g = await client.query(
      `INSERT INTO connector_grants (user_id, token_version, client_id, expires_at, activated_at)
       VALUES ($1, 0, $2, NOW() + INTERVAL '180 days', NOW()) RETURNING id, expires_at`,
      [admin.id, grants.CLIENT_ID]
    );
    const pair = await tokens.issuePair(client, g.rows[0].id, g.rows[0].expires_at, new Date());
    await client.query('COMMIT');
    return { grantId: g.rows[0].id, access: pair.access_token, refresh: pair.refresh_token };
  } finally {
    client.release();
  }
}

test('an admin session JWT is refused at /mcp, and a connector token is refused by auth() on /api/admin/inbox', async () => {
  const jwtCall = await call('POST', '/mcp', { headers: { ...MCP_HEADERS, Authorization: `Bearer ${adminJwt}` }, body: LIST_TOOLS });
  assert.equal(jwtCall.status, 401);
  assert.equal((await call('GET', '/api/admin/inbox', { headers: { Authorization: `Bearer ${adminJwt}` } })).status, 200,
    'the same JWT is a working admin session');
  const { access } = await directGrant();
  assert.equal((await call('POST', '/mcp', { headers: { ...MCP_HEADERS, Authorization: `Bearer ${access}` }, body: LIST_TOOLS })).status, 200,
    'the same connector token works at /mcp');
  const inbox = await call('GET', '/api/admin/inbox', { headers: { Authorization: `Bearer ${access}` } });
  assert.equal(inbox.status, 401);
  assert.equal(inbox.body.code, 'INVALID_TOKEN');
});

test('the full sign-in through the SDK client: authorize, approve, PKCE exchange, tool list, refresh', async () => {
  const mcpUrl = new URL(`${base}/mcp`);
  const provider = new TestProvider();

  // 1. The first connect meets the 401, discovers, and asks for the browser.
  const first = new Client({ name: 'flow-test', version: '1.0.0' });
  const t1 = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  await assert.rejects(first.connect(t1), (err) => err instanceof UnauthorizedError);
  assert.ok(provider.authUrl, 'the SDK asked to open the authorize URL');
  const authUrl = new URL(provider.authUrl);
  assert.equal(authUrl.origin + authUrl.pathname, `${base}/oauth/authorize`);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('resource'), `${base}/mcp`, 'the SDK sends the RFC 8707 resource');
  assert.equal(authUrl.searchParams.has('state'), false, 'this client sends no state');

  // 2. The browser follows it: a pending row, and the consent page with only its id.
  const authorize = await call('GET', authUrl.pathname + authUrl.search);
  assert.equal(authorize.status, 302);
  const consent = new URL(authorize.headers.location);
  assert.equal(consent.pathname, '/connect-claude');
  const requestId = consent.searchParams.get('request');
  requestIds.push(requestId);
  assert.equal([...consent.searchParams.keys()].join(','), 'request', 'nothing but the id travels');

  // 3. The owner reads it and approves with the (stubbed) passkey.
  const adminAuth = { Authorization: `Bearer ${adminJwt}` };
  const read = await call('GET', `/api/admin/connector/requests/${requestId}`, { headers: adminAuth });
  assert.equal(read.status, 200);
  assert.equal(read.body.request.status, 'pending');
  const approve = await call('POST', `/api/admin/connector/requests/${requestId}/approve`, {
    headers: adminAuth, body: { assertion: { id: 'stub' } },
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const back = new URL(approve.body.redirect_url);
  assert.equal(`${back.origin}${back.pathname}`, grants.REDIRECT_URI);
  assert.equal(back.searchParams.has('state'), false, 'no state sent, none echoed');
  const code = back.searchParams.get('code');
  assert.ok(tokens.hasShape(code, tokens.CODE_PREFIX));
  const mailsBefore = sentMail.length;
  assert.equal(audits[audits.length - 1].action, 'connector_grant_approved');

  // 4. The SDK exchanges the code with its PKCE verifier; the connection is real now.
  await t1.finishAuth(code);
  // The email runs after the token response, detached.
  for (let i = 0; i < 100 && sentMail.length === mailsBefore; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sentMail.length, mailsBefore + 1, 'the owner is emailed when the connection becomes real');
  assert.equal(sentMail[sentMail.length - 1].to, admin.email);
  assert.equal(audits[audits.length - 1].action, 'connector_grant_created');
  assert.ok(tokens.hasShape(provider.saved.access_token, tokens.ACCESS_PREFIX));
  assert.ok(tokens.hasShape(provider.saved.refresh_token, tokens.REFRESH_PREFIX));

  // 5. Connected: the tool list is empty in this release's first lane.
  const second = new Client({ name: 'flow-test', version: '1.0.0' });
  await second.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  const listed = await second.listTools();
  assert.deepEqual(listed.tools, []);
  await second.close();

  // 6. A refresh rotates the pair, and the new access token works.
  const metadata = await discoverAuthorizationServerMetadata(base);
  const refreshed = await refreshAuthorization(base, {
    metadata,
    clientInformation: { client_id: grants.CLIENT_ID },
    refreshToken: provider.saved.refresh_token,
    resource: mcpUrl,
  });
  assert.notEqual(refreshed.refresh_token, provider.saved.refresh_token);
  provider.saveTokens(refreshed);
  const third = new Client({ name: 'flow-test', version: '1.0.0' });
  await third.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  assert.deepEqual((await third.listTools()).tools, []);
  await third.close();

  // The call log holds the calls, each with the caller's address.
  const grantRow = await pool.query('SELECT id FROM connector_grants WHERE request_id = $1', [requestId]);
  const logged = await pool.query(
    "SELECT method, caller_address, outcome FROM connector_calls WHERE grant_id = $1 AND method = 'tools/list'",
    [grantRow.rows[0].id]
  );
  assert.equal(logged.rows.length, 2);
  for (const row of logged.rows) {
    assert.equal(row.outcome, 'ok');
    assert.match(row.caller_address, /127\.0\.0\.1$/);
  }
});

test('outside the range in production, /mcp and the token route refuse and log with no grant', async () => {
  const prev = process.env.NODE_ENV;
  callLog.__resetRefusalWindow();
  process.env.NODE_ENV = 'production';
  try {
    const { access } = await directGrant();
    const mcp = await call('POST', '/mcp', { headers: { ...MCP_HEADERS, Authorization: `Bearer ${access}` }, body: LIST_TOOLS });
    assert.equal(mcp.status, 403, 'even with a valid token');
    const tok = await call('POST', '/oauth/token', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: 'grant_type=refresh_token',
    });
    assert.equal(tok.status, 403);
    const rows = await pool.query(
      "SELECT grant_id, method, caller_address FROM connector_calls WHERE id > $1 AND outcome = 'refused_address' ORDER BY id",
      [firstRefusalId]
    );
    assert.equal(rows.rows.length, 2);
    for (const row of rows.rows) {
      assert.equal(row.grant_id, null);
      assert.match(row.caller_address, /127\.0\.0\.1$/);
    }
    assert.deepEqual(rows.rows.map((r) => r.method), [null, 'oauth/token']);
    // The owner's off switch: an explicitly empty range lets the same call through.
    process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS = '';
    const open = await call('POST', '/mcp', { headers: { ...MCP_HEADERS, Authorization: `Bearer ${access}` }, body: LIST_TOOLS });
    assert.equal(open.status, 200);
  } finally {
    process.env.NODE_ENV = prev;
    delete process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
    connectorAddressCeilingLimiter.resetKey('127.0.0.1');
  }
});

async function refusalRowsSince(markId, outcome) {
  const r = await pool.query('SELECT method FROM connector_calls WHERE id > $1 AND outcome = $2 AND grant_id IS NULL', [markId, outcome]);
  return r.rows;
}
async function maxCallId() {
  return Number((await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM connector_calls')).rows[0].m);
}

test('a flood from outside the range writes a bounded number of rows and gets 429, on /mcp and the token route', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  callLog.__resetRefusalWindow();
  connectorAddressCeilingLimiter.resetKey('127.0.0.1');
  try {
    for (const [path, send] of [
      ['/mcp', () => call('POST', '/mcp', { headers: MCP_HEADERS, body: LIST_TOOLS })],
      ['/oauth/token', () => call('POST', '/oauth/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: 'grant_type=refresh_token' })],
    ]) {
      const mark = await maxCallId();
      const statuses = {};
      for (let i = 0; i < 310; i++) {
        const s = (await send()).status;
        statuses[s] = (statuses[s] || 0) + 1;
      }
      assert.equal(statuses[403], 300, `${path}: refused up to the ceiling`);
      assert.equal(statuses[429], 10, `${path}: 429 past it`);
      assert.equal((await refusalRowsSince(mark, 'refused_address')).length, 1, `${path}: one row for the whole flood`);
      connectorAddressCeilingLimiter.resetKey('127.0.0.1');
    }
  } finally {
    process.env.NODE_ENV = prev;
    connectorAddressCeilingLimiter.resetKey('127.0.0.1');
  }
});

test('the per-grant limiter and the per-address limiter are wired on /mcp', async () => {
  const prev = process.env.NODE_ENV;
  delete process.env.NODE_ENV; // the limiters skip under test
  callLog.__resetRefusalWindow();
  connectorAddressCeilingLimiter.resetKey('127.0.0.1');
  connectorMcpAddressLimiter.resetKey('127.0.0.1');
  const mark = await maxCallId();
  try {
    for (let i = 0; i < 60; i++) {
      const r = await call('POST', '/mcp', { headers: MCP_HEADERS, body: LIST_TOOLS });
      assert.equal(r.status, 401, `unauthenticated call ${i + 1}`);
    }
    for (let i = 0; i < 20; i++) {
      assert.equal((await call('POST', '/mcp', { headers: MCP_HEADERS, body: LIST_TOOLS })).status, 429);
    }
    assert.equal((await refusalRowsSince(mark, 'refused_token')).length, 1, 'eighty refusals, one row; the limited ones write nothing');
    const { access } = await directGrant();
    const authed = { ...MCP_HEADERS, Authorization: `Bearer ${access}` };
    let status = 200;
    let n = 0;
    while (status === 200 && n < 130) {
      status = (await call('POST', '/mcp', { headers: authed, body: LIST_TOOLS })).status;
      n += 1;
    }
    assert.equal(status, 429);
    assert.equal(n, 121, 'the 121st call in the minute is limited');
  } finally {
    process.env.NODE_ENV = prev;
    connectorAddressCeilingLimiter.resetKey('127.0.0.1');
  }
});

test('per call at /mcp: an expired token, a revoked grant, a demoted user and a bumped token_version each get 401', async () => {
  const send = (access) => call('POST', '/mcp', { headers: { ...MCP_HEADERS, Authorization: `Bearer ${access}` }, body: LIST_TOOLS });

  const expired = await directGrant();
  await pool.query("UPDATE connector_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = $1", [tokens.hashToken(expired.access)]);
  assert.equal((await send(expired.access)).status, 401, 'expired token');

  const revoked = await directGrant();
  assert.equal((await send(revoked.access)).status, 200, 'live before');
  await pool.query("UPDATE connector_grants SET revoked_at = NOW(), revoked_reason = 'disconnected' WHERE id = $1", [revoked.grantId]);
  assert.equal((await send(revoked.access)).status, 401, 'revoked grant');

  const live = await directGrant();
  await pool.query("UPDATE users SET role = 'manager' WHERE id = $1", [admin.id]);
  try {
    assert.equal((await send(live.access)).status, 401, 'demoted user');
  } finally {
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);
  }
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [admin.id]);
  try {
    const r = await send(live.access);
    assert.equal(r.status, 401, 'bumped token_version');
    assert.match(r.headers['www-authenticate'], /error="invalid_token"/);
  } finally {
    await pool.query('UPDATE users SET token_version = 0 WHERE id = $1', [admin.id]);
  }
});

test('a batch body gets 400 before the SDK, and a JSON-RPC error is logged as an error', async () => {
  const { grantId, access } = await directGrant();
  const headers = { ...MCP_HEADERS, Authorization: `Bearer ${access}` };
  const batch = await call('POST', '/mcp', { headers, body: [LIST_TOOLS, { ...LIST_TOOLS, id: 2 }] });
  assert.equal(batch.status, 400);
  assert.equal(batch.body.error.code, -32600);
  const unknown = await call('POST', '/mcp', { headers, body: { jsonrpc: '2.0', id: 7, method: 'no/such-method', params: {} } });
  assert.equal(unknown.status, 200, 'the SDK answers a JSON-RPC error at HTTP 200');
  assert.ok(unknown.body.error, 'with an error body');
  // The row is written after the response is sent, so wait for it briefly.
  let rows;
  for (let i = 0; i < 50; i++) {
    rows = await pool.query('SELECT method, outcome FROM connector_calls WHERE grant_id = $1 ORDER BY id', [grantId]);
    if (rows.rows.length >= 2) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(rows.rows, [{ method: 'batch', outcome: 'error' }, { method: 'no/such-method', outcome: 'error' }]);
});
