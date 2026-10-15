// server/utils/gmailClient.test.js
// globalThis.Response, not a bare Response: the repo eslint config does not
// declare the fetch globals for server code (email.replyTo.test.js precedent).
require('dotenv').config();
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const gc = require('./gmailClient');

function fakeKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const b64 = Buffer.from(JSON.stringify({ client_email: 'feed@example.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' })).toString('base64');
  return { b64, publicKey };
}
const fakeKey = () => fakeKeyPair().b64;
const tokenOk = () => new globalThis.Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
const isToken = (url) => String(url).startsWith('https://oauth2.googleapis.com/token');

// A test that forgets its { fetch } never reaches Google: the stand-in throws
// (which the client swallows into an error result) and records that it was
// reached, and afterEach fails the test on that record.
const saved = {};
beforeEach(() => {
  saved.key = process.env.GMAIL_SERVICE_ACCOUNT_KEY; saved.env = process.env.NODE_ENV; saved.fetch = globalThis.fetch;
  saved.reached = false;
  globalThis.fetch = () => { saved.reached = true; throw new Error('gmailClient.test: real fetch reached'); };
  gc.__resetGmailClient();
});
const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterEach(() => {
  restore('GMAIL_SERVICE_ACCOUNT_KEY', saved.key); restore('NODE_ENV', saved.env); globalThis.fetch = saved.fetch;
  gc.__resetGmailClient();
  assert.equal(saved.reached, false, 'a test reached the global fetch; pass { fetch } to createGmailClient');
});

test('unconfigured: isConfigured false and createGmailClient null', () => {
  delete process.env.GMAIL_SERVICE_ACCOUNT_KEY;
  assert.equal(gc.isConfigured(), false);
  assert.equal(gc.createGmailClient(), null);
});

test('a key that does not parse is reported with a fixed message, never a fragment', () => {
  process.env.GMAIL_SERVICE_ACCOUNT_KEY = Buffer.from('{"client_email": "x@example.com", "private_key": ').toString('base64');
  assert.equal(gc.isConfigured(), false);
  assert.equal(gc.configurationError(), 'GMAIL_SERVICE_ACCOUNT_KEY does not parse');
  assert.equal(gc.createGmailClient(), null);
});

test('a key whose private key will not load is reported the same way', () => {
  process.env.GMAIL_SERVICE_ACCOUNT_KEY = Buffer.from(JSON.stringify({ client_email: 'x@example.com', private_key: '-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n' })).toString('base64');
  assert.equal(gc.isConfigured(), false);
  assert.equal(gc.configurationError(), 'GMAIL_SERVICE_ACCOUNT_KEY does not parse');
});

test('a key that parses but lacks the private key is reported the same way', () => {
  process.env.GMAIL_SERVICE_ACCOUNT_KEY = Buffer.from(JSON.stringify({ client_email: 'x@example.com' })).toString('base64');
  assert.equal(gc.isConfigured(), false);
  assert.equal(gc.configurationError(), 'GMAIL_SERVICE_ACCOUNT_KEY does not parse');
});

test('under NODE_ENV=test it refuses to build a real client', () => {
  process.env.NODE_ENV = 'test'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  assert.throws(() => gc.createGmailClient(), /refuses to build a real Gmail client under NODE_ENV=test/);
});

test('an injected stub is returned even under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  const stub = { getProfile: async () => ({ data: {} }) };
  gc.__setGmailClientForTests(stub);
  assert.equal(gc.createGmailClient(), stub);
});

test('token request carries sub, scope and aud, is signed by the key, and calls only the pinned hosts', async () => {
  const pair = fakeKeyPair();
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = pair.b64;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (isToken(url)) return tokenOk();
    return new globalThis.Response(JSON.stringify({ emailAddress: 'mailbox@example.com', historyId: '42' }), { status: 200 });
  };
  const client = gc.createGmailClient({ fetch });
  const { data } = await client.getProfile();
  assert.equal(data.historyId, '42');
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [head, payload, sig] = body.get('assertion').split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url').toString()).alg, 'RS256');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${head}.${payload}`), pair.publicKey, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, 'feed@example.com');
  assert.equal(claims.sub, gc.GMAIL_MAILBOX);
  assert.equal(claims.scope, gc.GMAIL_SCOPE);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.ok(claims.exp - claims.iat <= 3600);
  assert.ok(calls[1].url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile'));
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
  for (const c of calls) {
    assert.match(c.url, /^https:\/\/(oauth2|gmail)\.googleapis\.com\//);
    assert.ok(c.init.signal instanceof AbortSignal, 'every call carries a timeout signal');
  }
});

test('the access token is reused until near expiry, and the client is cached', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let tokens = 0;
  const fetch = async (url) => {
    if (isToken(url)) { tokens += 1; return tokenOk(); }
    return new globalThis.Response('{}', { status: 200 });
  };
  const a = gc.createGmailClient({ fetch });
  await a.getProfile(); await a.listLabels();
  const b = gc.createGmailClient({ fetch });
  assert.equal(b, a);
  await b.getProfile();
  assert.equal(tokens, 1);
});

test('a token inside the expiry skew is minted again', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let tokens = 0;
  const fetch = async (url) => {
    if (isToken(url)) { tokens += 1; return new globalThis.Response(JSON.stringify({ access_token: 'tok', expires_in: 30 }), { status: 200 }); }
    return new globalThis.Response('{}', { status: 200 });
  };
  const client = gc.createGmailClient({ fetch });
  await client.getProfile(); await client.getProfile(); await client.listLabels();
  assert.equal(tokens, 3);
});

test('concurrent first calls share one token request', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let tokens = 0;
  const fetch = async (url) => {
    if (isToken(url)) { tokens += 1; await new Promise((r) => setTimeout(r, 20)); return tokenOk(); }
    return new globalThis.Response('{}', { status: 200 });
  };
  const client = gc.createGmailClient({ fetch });
  const rs = await Promise.all([client.getProfile(), client.listLabels(), client.getMessage('m1')]);
  assert.equal(tokens, 1);
  assert.ok(rs.every((r) => r.data));
});

test('an API 401 drops the token and the next call mints again; a 403 keeps it', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let tokens = 0; const statuses = [401, 200, 403, 200];
  const fetch = async (url) => {
    if (isToken(url)) { tokens += 1; return tokenOk(); }
    return new globalThis.Response('{}', { status: statuses.shift() });
  };
  const client = gc.createGmailClient({ fetch });
  assert.equal((await client.getProfile()).error.class, 'GmailAuthError');
  assert.equal(tokens, 1);
  assert.ok((await client.getProfile()).data);
  assert.equal(tokens, 2);
  assert.equal((await client.getProfile()).error.class, 'GmailAuthError');
  assert.ok((await client.getProfile()).data);
  assert.equal(tokens, 2);
});

test('a different fetch builds a different client', () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  const one = async () => new globalThis.Response('{}', { status: 200 });
  const two = async () => new globalThis.Response('{}', { status: 200 });
  assert.notEqual(gc.createGmailClient({ fetch: one }), gc.createGmailClient({ fetch: two }));
});

test('a new key builds a new client', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  const fetch = async () => new globalThis.Response('{}', { status: 200 });
  const a = gc.createGmailClient({ fetch });
  process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  assert.notEqual(gc.createGmailClient({ fetch }), a);
});

test('historyTypes goes out as a repeated query parameter', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  const urls = [];
  const fetch = async (url) => {
    if (isToken(url)) return tokenOk();
    urls.push(new URL(String(url)));
    return new globalThis.Response('{}', { status: 200 });
  };
  const client = gc.createGmailClient({ fetch });
  await client.listHistory({ startHistoryId: '7' });
  assert.equal(urls[0].pathname, '/gmail/v1/users/me/history');
  assert.deepEqual(urls[0].searchParams.getAll('historyTypes'), ['messageAdded', 'labelAdded']);
  assert.equal(urls[0].searchParams.get('startHistoryId'), '7');
  assert.equal(urls[0].searchParams.has('pageToken'), false);
});

test('listMessages and getMessage build the expected requests', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  const urls = [];
  const fetch = async (url) => {
    if (isToken(url)) return tokenOk();
    urls.push(new URL(String(url)));
    return new globalThis.Response('{}', { status: 200 });
  };
  const client = gc.createGmailClient({ fetch });
  await client.listMessages({ q: 'after:2026/10/01', pageToken: 'p2' });
  await client.getMessage('18f0a1B2c3_d-4');
  assert.equal(urls[0].searchParams.get('q'), 'after:2026/10/01');
  assert.equal(urls[0].searchParams.get('pageToken'), 'p2');
  assert.equal(urls[0].searchParams.get('includeSpamTrash'), 'false');
  assert.equal(urls[1].pathname, '/gmail/v1/users/me/messages/18f0a1B2c3_d-4');
  assert.equal(urls[1].searchParams.get('format'), 'full');
});

test('errors map by status and carry no body', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let n = 0;
  const fetch = async (url) => {
    if (isToken(url)) return tokenOk();
    n += 1;
    return new globalThis.Response('{"error":{"message":"SECRET BODY"}}', { status: [401, 404, 503, 404, 400, 403, 429, 404][n - 1] });
  };
  const client = gc.createGmailClient({ fetch });
  const rs = [
    await client.getProfile(),
    await client.listHistory({ startHistoryId: '1' }),
    await client.getProfile(),
    await client.getMessage('m1'),
    await client.listLabels(),
    await client.listLabels(),
    await client.listMessages({ q: 'x' }),
    await client.listMessages({ q: 'x' }),
  ];
  assert.deepEqual(rs.map((r) => r.error.class), [
    'GmailAuthError', 'GmailHistoryGoneError', 'GmailUnavailableError', 'GmailNotFoundError',
    'GmailRequestError', 'GmailAuthError', 'GmailUnavailableError', 'GmailRequestError',
  ]);
  for (const r of rs) assert.equal(r.error.stage, 'api');
  assert.deepEqual(rs.map((r) => r.error.status), [401, 404, 503, 404, 400, 403, 429, 404]);
  assert.ok(!JSON.stringify(rs).includes('SECRET BODY'));
  assert.ok(!rs.some((r) => String(r.error.message).includes('SECRET BODY')));
});

test('a token endpoint refusal is an auth error at the token stage', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let status = 400;
  const fetch = async (url) => {
    if (isToken(url)) return new globalThis.Response('{"error":"invalid_grant","error_description":"SECRET BODY"}', { status });
    return new globalThis.Response('{}', { status: 200 });
  };
  const client = gc.createGmailClient({ fetch });
  const a = await client.getProfile();
  assert.equal(a.error.class, 'GmailAuthError'); assert.equal(a.error.status, 400); assert.equal(a.error.stage, 'token');
  status = 401;
  const b = await client.getProfile();
  assert.equal(b.error.class, 'GmailAuthError'); assert.equal(b.error.status, 401); assert.equal(b.error.stage, 'token');
  status = 503;
  const c = await client.getProfile();
  assert.equal(c.error.class, 'GmailUnavailableError'); assert.equal(c.error.stage, 'token');
  assert.ok(!JSON.stringify([a, b, c]).includes('SECRET BODY'));
});

test('a token response without an access token is an auth error, never a bearer of undefined', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  const api = [];
  const fetch = async (url) => {
    if (isToken(url)) return new globalThis.Response('{"token_type":"Bearer"}', { status: 200 });
    api.push(url); return new globalThis.Response('{}', { status: 200 });
  };
  const r = await gc.createGmailClient({ fetch }).getProfile();
  assert.equal(r.error.class, 'GmailAuthError'); assert.equal(r.error.stage, 'token');
  assert.equal(api.length, 0);
});

test('a network failure or a body that is not JSON at the token host is unavailable at the token stage', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let mode = 'throw';
  const fetch = async (url) => {
    if (isToken(url)) {
      if (mode === 'throw') throw new Error('getaddrinfo ENOTFOUND SECRET HOST');
      return new globalThis.Response('<html>SECRET</html>', { status: 200 });
    }
    return new globalThis.Response('{}', { status: 200 });
  };
  const client = gc.createGmailClient({ fetch });
  const a = await client.getProfile();
  mode = 'html';
  const b = await client.getProfile();
  for (const r of [a, b]) {
    assert.equal(r.error.class, 'GmailUnavailableError'); assert.equal(r.error.status, 0); assert.equal(r.error.stage, 'token');
  }
  assert.ok(!JSON.stringify([a, b]).includes('SECRET'));
});

test('getMessage refuses an id that is not a Gmail id, without a request', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let calls = 0;
  const fetch = async () => { calls += 1; return new globalThis.Response('{}', { status: 200 }); };
  const client = gc.createGmailClient({ fetch });
  for (const id of ['', undefined, null, 42, '.', '..', 'a/b', 'a b']) assert.equal((await client.getMessage(id)).error.class, 'GmailRequestError');
  assert.equal(calls, 0);
});

test('a network failure or timeout is unavailable with status 0 and no message text', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  const fetch = async (url) => {
    if (isToken(url)) return tokenOk();
    throw new Error('connect ECONNREFUSED SECRET HOST');
  };
  const r = await gc.createGmailClient({ fetch }).getProfile();
  assert.equal(r.error.class, 'GmailUnavailableError'); assert.equal(r.error.status, 0);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.ok(!String(r.error.message).includes('SECRET'));
});

test('the private key never appears on an error or a client', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  const fetch = async () => new globalThis.Response('{}', { status: 401 });
  const client = gc.createGmailClient({ fetch });
  const r = await client.getProfile();
  const seen = JSON.stringify(r) + JSON.stringify(Object.keys(client)) + String(r.error.stack);
  assert.ok(!seen.includes('PRIVATE KEY'));
});
