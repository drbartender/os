require('dotenv').config();

// Route-level tests for server/routes/emailChange.js — the UNAUTHENTICATED
// /api/me/confirm-email-change endpoint (spec section 6.10).
//
// Harness mirrors staffPortal.test.js: stand up a minimal express() app that
// mounts emailChange.js BEFORE staffPortal.js so the auth-less confirm route
// wins on /api/me path lookup, identical to the production mount order in
// server/index.js. Tests use node's built-in http module + node:test.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const emailChangeRouter = require('./emailChange');

// Shared harness state.
let server;
let baseUrl;
let staffUserA_Id;
let staffUserA_Token;
let staffUserA_Email;
let staffUserB_Id;
let staffUserB_Token;
let staffUserB_Email;
let sendEmailCalls = [];

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = (body === null || body === undefined)
      ? null
      : (Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Generate a fresh raw token + insert a pending row for `userId`. Returns the
// raw token (for posting back to the endpoint) and the row's id.
async function seedPending(userId, newEmail, opts = {}) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = opts.expiresAt || 'NOW() + INTERVAL \'24 hours\'';
  const consumedAt = opts.consumedAt || null;
  const insertRes = await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at, consumed_at)
     VALUES ($1, $2, $3, ${typeof expiresAt === 'string' && expiresAt.startsWith('NOW') ? expiresAt : '$4'}, $${typeof expiresAt === 'string' && expiresAt.startsWith('NOW') ? 4 : 5})
     RETURNING id`,
    typeof expiresAt === 'string' && expiresAt.startsWith('NOW')
      ? [userId, newEmail, hash, consumedAt]
      : [userId, newEmail, hash, expiresAt, consumedAt]
  );
  return { raw, hash, id: insertRes.rows[0].id };
}

before(async () => {
  // Defensive cleanup — strip any rows from a prior crashed run.
  await pool.query("DELETE FROM pending_email_changes WHERE new_email LIKE 'email-change-test-%'");
  await pool.query("DELETE FROM users WHERE email LIKE 'email-change-test-%'");

  const passwordHash = await bcrypt.hash('x', 4);

  // User A — the email-change subject for most tests.
  staffUserA_Email = `email-change-test-a-${NONCE}@example.com`;
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [staffUserA_Email, passwordHash]
  );
  staffUserA_Id = a.rows[0].id;
  staffUserA_Token = jwt.sign(
    { userId: staffUserA_Id, tokenVersion: a.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // User B — the IDOR probe identity.
  staffUserB_Email = `email-change-test-b-${NONCE}@example.com`;
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [staffUserB_Email, passwordHash]
  );
  staffUserB_Id = b.rows[0].id;
  staffUserB_Token = jwt.sign(
    { userId: staffUserB_Id, tokenVersion: b.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Stub the email send so tests never hit Resend, and capture the args so
  // the audit-trail assertions can verify the recipient.
  emailChangeRouter.__setDeps({
    sendEmail: async (args) => {
      sendEmailCalls.push(args);
      return { id: 'stub-id' };
    },
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/me', emailChangeRouter);
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

after(async () => {
  await pool.query(
    "DELETE FROM staff_audit_log WHERE user_id IN ($1, $2)",
    [staffUserA_Id, staffUserB_Id]
  );
  await pool.query(
    "DELETE FROM pending_email_changes WHERE user_id IN ($1, $2)",
    [staffUserA_Id, staffUserB_Id]
  );
  await pool.query(
    "DELETE FROM users WHERE id IN ($1, $2)",
    [staffUserA_Id, staffUserB_Id]
  );
  await pool.query(
    "DELETE FROM users WHERE email LIKE 'email-change-test-%'"
  );
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// Re-fetch user-A's email so each test sees the current value (some tests
// mutate it through a successful confirm).
async function getCurrentEmail(userId) {
  const { rows } = await pool.query('SELECT email, token_version FROM users WHERE id = $1', [userId]);
  return rows[0];
}

async function resetUserAEmail() {
  await pool.query(
    'UPDATE users SET email = $2, token_version = 0 WHERE id = $1',
    [staffUserA_Id, staffUserA_Email]
  );
  await pool.query('DELETE FROM pending_email_changes WHERE user_id = $1', [staffUserA_Id]);
  await pool.query(
    "DELETE FROM staff_audit_log WHERE user_id = $1 AND action = 'email_change_confirmed'",
    [staffUserA_Id]
  );
  sendEmailCalls = [];
}

test('POST /api/me/confirm-email-change > unknown token returns 410 invalid_or_expired', async () => {
  await resetUserAEmail();
  const res = await request('POST', '/api/me/confirm-email-change', {
    body: { token: 'this-token-was-never-issued' },
  });
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.reason, 'invalid_or_expired');
});

test('POST /api/me/confirm-email-change > missing token returns 410', async () => {
  await resetUserAEmail();
  const res = await request('POST', '/api/me/confirm-email-change', { body: {} });
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.reason, 'invalid_or_expired');
});

test('POST /api/me/confirm-email-change > expired token returns 410', async () => {
  await resetUserAEmail();
  const newEmail = `email-change-test-expired-${NONCE}@example.com`;
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  // Insert with expires_at one hour in the past — the SELECT's `expires_at > NOW()`
  // guard should filter it out.
  await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')`,
    [staffUserA_Id, newEmail, hash]
  );
  const res = await request('POST', '/api/me/confirm-email-change', { body: { token: raw } });
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.reason, 'invalid_or_expired');
  // Email NOT changed — the pending row was filtered out before the UPDATE.
  const user = await getCurrentEmail(staffUserA_Id);
  assert.strictEqual(user.email, staffUserA_Email);
});

test('POST /api/me/confirm-email-change > already-consumed token returns 410', async () => {
  await resetUserAEmail();
  const newEmail = `email-change-test-consumed-${NONCE}@example.com`;
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at, consumed_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', NOW() - INTERVAL '5 minutes')`,
    [staffUserA_Id, newEmail, hash]
  );
  const res = await request('POST', '/api/me/confirm-email-change', { body: { token: raw } });
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.reason, 'invalid_or_expired');
  // Email unchanged.
  const user = await getCurrentEmail(staffUserA_Id);
  assert.strictEqual(user.email, staffUserA_Email);
});

test('POST /api/me/confirm-email-change > valid token: confirms, bumps token_version, audits, emails OLD', async () => {
  await resetUserAEmail();
  const newEmail = `email-change-test-valid-${NONCE}@example.com`;
  const before = await getCurrentEmail(staffUserA_Id);
  const beforeTV = before.token_version;

  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
    [staffUserA_Id, newEmail, hash]
  );

  const res = await request('POST', '/api/me/confirm-email-change', { body: { token: raw } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  // Email rewritten.
  const after = await getCurrentEmail(staffUserA_Id);
  assert.strictEqual(after.email, newEmail);
  // token_version bumped.
  assert.strictEqual(after.token_version, beforeTV + 1);

  // Pending row consumed.
  const { rows: pending } = await pool.query(
    "SELECT consumed_at FROM pending_email_changes WHERE user_id = $1 AND new_email = $2",
    [staffUserA_Id, newEmail]
  );
  assert.ok(pending[0]?.consumed_at, 'consumed_at populated');

  // Audit-log row exists with the right action + details payload.
  const { rows: audit } = await pool.query(
    "SELECT details FROM staff_audit_log WHERE user_id = $1 AND action = 'email_change_confirmed' ORDER BY id DESC LIMIT 1",
    [staffUserA_Id]
  );
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].details.old_email, staffUserA_Email);
  assert.strictEqual(audit[0].details.new_email, newEmail);

  // Confirmation email sent to the OLD address.
  const recipients = sendEmailCalls.map((c) => c.to);
  assert.ok(recipients.includes(staffUserA_Email), 'sent confirmation to old address');
  // The confirmation message is NOT addressed to the new address.
  assert.ok(!recipients.includes(newEmail), 'no email to new address from confirm');
});

test('POST /api/me/confirm-email-change > replay of consumed token returns 410', async () => {
  await resetUserAEmail();
  const newEmail = `email-change-test-replay-${NONCE}@example.com`;
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
    [staffUserA_Id, newEmail, hash]
  );

  const first = await request('POST', '/api/me/confirm-email-change', { body: { token: raw } });
  assert.strictEqual(first.status, 200);

  // Replay — pending row is now consumed_at IS NOT NULL, so filtered out.
  const second = await request('POST', '/api/me/confirm-email-change', { body: { token: raw } });
  assert.strictEqual(second.status, 410);
  assert.strictEqual(second.body.reason, 'invalid_or_expired');
});

test('POST /api/me/confirm-email-change > IDOR: B JWT does NOT redirect change away from A', async () => {
  // Spec: confirmation looks up the pending row by token_hash; the row's
  // user_id wins. An Authorization header MUST be ignored. Drive a confirm
  // for user A's pending row WHILE presenting user B's JWT, then assert the
  // change happened for user A (and B's email is unchanged).
  await resetUserAEmail();
  const newEmail = `email-change-test-idor-${NONCE}@example.com`;
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
    [staffUserA_Id, newEmail, hash]
  );
  const beforeB = await getCurrentEmail(staffUserB_Id);

  // Present user B's JWT (legitimate, valid) — the route is unauthenticated
  // and must ignore the bearer entirely.
  const res = await request('POST', '/api/me/confirm-email-change', {
    token: staffUserB_Token,
    body: { token: raw },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  // User A's email changed, user B's email did NOT.
  const afterA = await getCurrentEmail(staffUserA_Id);
  const afterB = await getCurrentEmail(staffUserB_Id);
  assert.strictEqual(afterA.email, newEmail, 'A email changed to pending target');
  assert.strictEqual(afterB.email, beforeB.email, 'B email unchanged');
});

test('POST /api/me/confirm-email-change > reaches handler with NO JWT (route is unauthenticated)', async () => {
  // Auth-pass for the unauthenticated route: no Authorization header at all,
  // the handler MUST still run. With a fresh unknown token the response is
  // 410, but the bare 401 from an auth middleware would be the bug.
  const res = await request('POST', '/api/me/confirm-email-change', {
    body: { token: 'never-issued-token-for-auth-pass' },
  });
  assert.strictEqual(res.status, 410, `expected handler to run and return 410, got ${res.status}`);
  assert.strictEqual(res.body.reason, 'invalid_or_expired');
});
