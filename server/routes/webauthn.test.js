require('dotenv').config();
process.env.NODE_ENV = 'test';

// Webauthn route matrix (spec section 8 + section 11). The simplewebauthn
// verify calls are injected as stubs via createWebauthnRouter: the library's
// crypto is its own tested code; THIS suite pins OUR logic (challenge
// single-use + TTL + kind, counter regression, account gates, uniform
// failures, IDOR on revoke, the token_version bump, the 12h mint). Mirrors
// the hand-rolled node:http harness in auth.preferredName.test.js.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { createWebauthnRouter } = require('./webauthn');

let server;
let baseUrl;
let userA; let tokenA; // enrolling user
let userB; let tokenB; // second user, for IDOR checks

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Injected verify stubs, reset per test.
let verifyRegistrationImpl;
let verifyAuthenticationImpl;

function b64url(objOrBuf) {
  const buf = Buffer.isBuffer(objOrBuf) ? objOrBuf : Buffer.from(JSON.stringify(objOrBuf));
  return buf.toString('base64url');
}
// A response body whose clientDataJSON carries the given challenge; the verify
// stub never inspects the rest.
function assertionBody(challenge, credentialId, userHandle) {
  return {
    response: {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: b64url({ type: 'webauthn.get', challenge, origin: 'http://localhost:3000' }),
        authenticatorData: b64url(Buffer.from('authdata')),
        signature: b64url(Buffer.from('sig')),
        ...(userHandle ? { userHandle: b64url(Buffer.from(userHandle)) } : {}),
      },
      clientExtensionResults: {},
    },
  };
}
function attestationBody(challenge) {
  return {
    response: {
      id: 'ignored-by-stub',
      rawId: 'ignored-by-stub',
      type: 'public-key',
      response: {
        clientDataJSON: b64url({ type: 'webauthn.create', challenge, origin: 'http://localhost:3000' }),
        attestationObject: b64url(Buffer.from('att')),
      },
      clientExtensionResults: {},
    },
    label: 'Test phone',
  };
}

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_e) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function makeUser(tag, extra = {}) {
  const email = `webauthn-test-${tag}-${NONCE}@example.com`;
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, $3, 0) RETURNING id, token_version`,
    [email, extra.role || 'admin', extra.onboarding_status || 'approved']
  );
  const token = jwt.sign(
    { userId: r.rows[0].id, tokenVersion: r.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  return { id: r.rows[0].id, email, token };
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'webauthn-test-%'");
  const a = await makeUser('a');
  const b = await makeUser('b');
  userA = a; tokenA = a.token;
  userB = b; tokenB = b.token;

  const routerUnderTest = createWebauthnRouter({
    verifyRegistrationResponse: (...args) => verifyRegistrationImpl(...args),
    verifyAuthenticationResponse: (...args) => verifyAuthenticationImpl(...args),
  });
  const authRouter = require('./auth');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth/webauthn', routerUnderTest);
  app.use('/api/auth', authRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

beforeEach(async () => {
  // Happy-path stubs by default; individual tests override.
  verifyRegistrationImpl = async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: `cred-${NONCE}`,
        publicKey: Buffer.from('public-key-bytes'),
        counter: 0,
        transports: ['internal'],
      },
    },
  });
  verifyAuthenticationImpl = async () => ({
    verified: true,
    authenticationInfo: { newCounter: 0 },
  });
  // Scoped like every fixture in this repo: this suite's users' register
  // challenges, plus assert challenges (user_id NULL): only this suite mints
  // unbound challenges on the dev DB.
  await pool.query(
    'DELETE FROM webauthn_challenges WHERE user_id IN ($1, $2) OR user_id IS NULL',
    [userA.id, userB.id]
  );
  await pool.query('DELETE FROM webauthn_credentials WHERE user_id IN ($1, $2)', [userA.id, userB.id]);
  await pool.query('UPDATE users SET token_version = 0 WHERE id IN ($1, $2)', [userA.id, userB.id]);
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'webauthn-test-%'");
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// Enroll userA via the stubbed happy path; returns the credential_id.
async function enroll() {
  const opts = await request('POST', '/api/auth/webauthn/register-options', { token: tokenA });
  assert.equal(opts.status, 200);
  const verify = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody(opts.body.challenge),
  });
  assert.equal(verify.status, 201);
  return `cred-${NONCE}`;
}

test('register-options requires auth', async () => {
  const res = await request('POST', '/api/auth/webauthn/register-options');
  assert.equal(res.status, 401);
});

test('register-options stores a register challenge bound to the user', async () => {
  const res = await request('POST', '/api/auth/webauthn/register-options', { token: tokenA });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.challenge, 'string');
  const row = await pool.query(
    'SELECT kind, user_id FROM webauthn_challenges WHERE challenge = $1', [res.body.challenge]
  );
  assert.equal(row.rows[0].kind, 'register');
  assert.equal(row.rows[0].user_id, userA.id);
});

test('register-verify rejects an unknown challenge', async () => {
  const res = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody('never-issued'),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('register-verify rejects an expired challenge', async () => {
  await pool.query(
    `INSERT INTO webauthn_challenges (challenge, user_id, kind, expires_at)
     VALUES ('expired-ch', $1, 'register', NOW() - INTERVAL '1 minute')`,
    [userA.id]
  );
  const res = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody('expired-ch'),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('a register challenge cannot be spent by a different user', async () => {
  const opts = await request('POST', '/api/auth/webauthn/register-options', { token: tokenA });
  const res = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenB,
    body: attestationBody(opts.body.challenge),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('register happy path inserts the credential and burns the challenge', async () => {
  const opts = await request('POST', '/api/auth/webauthn/register-options', { token: tokenA });
  const first = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody(opts.body.challenge),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.credential.label, 'Test phone');
  const row = await pool.query(
    'SELECT user_id, counter FROM webauthn_credentials WHERE credential_id = $1', [`cred-${NONCE}`]
  );
  assert.equal(row.rows[0].user_id, userA.id);
  // Single use: replaying the same body fails on the consumed challenge.
  const replay = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody(opts.body.challenge),
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('credentials list is scoped to the caller', async () => {
  await enroll();
  const mine = await request('GET', '/api/auth/webauthn/credentials', { token: tokenA });
  assert.equal(mine.body.credentials.length, 1);
  const theirs = await request('GET', '/api/auth/webauthn/credentials', { token: tokenB });
  assert.equal(theirs.body.credentials.length, 0);
});

test('revoke: another user cannot delete my credential (404), owner can, and the bump kills live tokens', async () => {
  await enroll();
  const row = await pool.query('SELECT id FROM webauthn_credentials WHERE user_id = $1', [userA.id]);
  const credRowId = row.rows[0].id;

  const idor = await request('DELETE', `/api/auth/webauthn/credentials/${credRowId}`, { token: tokenB });
  assert.equal(idor.status, 404);

  const ok = await request('DELETE', `/api/auth/webauthn/credentials/${credRowId}`, { token: tokenA });
  assert.equal(ok.status, 200);

  // token_version bumped: the pre-revoke JWT is dead at the middleware.
  const me = await request('GET', '/api/auth/me', { token: tokenA });
  assert.equal(me.status, 401);
  assert.equal(me.body.code, 'TOKEN_VERSION_MISMATCH');
});

async function assertOptions() {
  const res = await request('POST', '/api/auth/webauthn/assert-options');
  assert.equal(res.status, 200);
  return res.body.challenge;
}

test('assert-options stores an unbound assert challenge', async () => {
  const challenge = await assertOptions();
  const row = await pool.query(
    'SELECT kind, user_id FROM webauthn_challenges WHERE challenge = $1', [challenge]
  );
  assert.equal(row.rows[0].kind, 'assert');
  assert.equal(row.rows[0].user_id, null);
});

test('an assert challenge cannot be spent on register-verify (kind mismatch)', async () => {
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/register-verify', {
    token: tokenA,
    body: attestationBody(challenge),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('assert-verify happy path: 12h mint, counter + last_used_at written, token passes middleware', async () => {
  const credId = await enroll();
  verifyAuthenticationImpl = async () => ({ verified: true, authenticationInfo: { newCounter: 7 } });
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, userA.id);
  assert.equal(typeof res.body.user.has_application, 'boolean');

  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.userId, userA.id);
  assert.equal(decoded.credentialId, credId);
  const lifetime = decoded.exp - decoded.iat;
  assert.ok(lifetime > 11.9 * 3600 && lifetime <= 12 * 3600, `12h mint, got ${lifetime}s`);

  const row = await pool.query('SELECT counter, last_used_at FROM webauthn_credentials WHERE credential_id = $1', [credId]);
  assert.equal(Number(row.rows[0].counter), 7);
  assert.ok(row.rows[0].last_used_at);

  const me = await request('GET', '/api/auth/me', { token: res.body.token });
  assert.equal(me.status, 200);
});

test('assert challenge is single-use', async () => {
  const credId = await enroll();
  const challenge = await assertOptions();
  const first = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(first.status, 200);
  const replay = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'WEBAUTHN_CHALLENGE_INVALID');
});

test('unknown credential fails with the uniform envelope', async () => {
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, 'no-such-credential'),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Unlock failed. Use your password.');
});

test('userHandle mismatch fails with the uniform envelope', async () => {
  const credId = await enroll();
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userB.id)),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Unlock failed. Use your password.');
});

test('failed signature verification fails uniformly and mints nothing', async () => {
  const credId = await enroll();
  verifyAuthenticationImpl = async () => { throw new Error('bad signature'); };
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.token, undefined);
});

test('counter regression is rejected and the stored counter is untouched', async () => {
  const credId = await enroll();
  await pool.query('UPDATE webauthn_credentials SET counter = 10 WHERE credential_id = $1', [credId]);
  verifyAuthenticationImpl = async () => ({ verified: true, authenticationInfo: { newCounter: 10 } });
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 409);
  const row = await pool.query('SELECT counter FROM webauthn_credentials WHERE credential_id = $1', [credId]);
  assert.equal(Number(row.rows[0].counter), 10);
});

test('always-zero counters never trip the regression check', async () => {
  const credId = await enroll();
  verifyAuthenticationImpl = async () => ({ verified: true, authenticationInfo: { newCounter: 0 } });
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 200);
});

test('deactivated account cannot unlock', async () => {
  const credId = await enroll();
  await pool.query("UPDATE users SET onboarding_status = 'deactivated' WHERE id = $1", [userA.id]);
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ACCOUNT_DEACTIVATED');
  await pool.query("UPDATE users SET onboarding_status = 'approved' WHERE id = $1", [userA.id]);
});

test('a version-bumped session artifact does not block a fresh unlock (new mint carries the new version)', async () => {
  const credId = await enroll();
  await pool.query('UPDATE users SET token_version = 3 WHERE id = $1', [userA.id]);
  const challenge = await assertOptions();
  const res = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(challenge, credId, String(userA.id)),
  });
  assert.equal(res.status, 200);
  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.tokenVersion, 3);
  const me = await request('GET', '/api/auth/me', { token: res.body.token });
  assert.equal(me.status, 200);
});

// Mid-lane security-review fixes (2026-08-14), pinned:

test('all four pre-signature assert failures share ONE public code (no branch enumeration)', async () => {
  const credId = await enroll();

  const ch1 = await assertOptions();
  const unknown = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(ch1, 'no-such-credential'),
  });
  const ch2 = await assertOptions();
  const mismatch = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(ch2, credId, String(userB.id)),
  });
  verifyAuthenticationImpl = async () => { throw new Error('bad signature'); };
  const ch3 = await assertOptions();
  const badSig = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(ch3, credId, String(userA.id)),
  });
  await pool.query('UPDATE webauthn_credentials SET counter = 10 WHERE credential_id = $1', [credId]);
  verifyAuthenticationImpl = async () => ({ verified: true, authenticationInfo: { newCounter: 10 } });
  const ch4 = await assertOptions();
  const regression = await request('POST', '/api/auth/webauthn/assert-verify', {
    body: assertionBody(ch4, credId, String(userA.id)),
  });

  for (const r of [unknown, mismatch, badSig, regression]) {
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'WEBAUTHN_UNLOCK_FAILED');
    assert.equal(r.body.error, 'Unlock failed. Use your password.');
  }
});

test('a non-string userHandle fails uniformly, never 500s', async () => {
  const credId = await enroll();
  const challenge = await assertOptions();
  const body = assertionBody(challenge, credId);
  body.response.response.userHandle = 12345;
  const res = await request('POST', '/api/auth/webauthn/assert-verify', { body });
  // Non-string handle is treated as absent; the stubbed verify then passes.
  assert.equal(res.status, 200);
});

test('an out-of-int4-range credential id is a 400, not a 500', async () => {
  const res = await request('DELETE', '/api/auth/webauthn/credentials/100000000000000000000', { token: tokenA });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.id);
});
