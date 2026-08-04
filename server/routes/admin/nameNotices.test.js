require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `nn-${NONCE}@example.com`;
const STAFF_EMAIL = `nn-staff-${NONCE}@example.com`;
let server, baseUrl, token, userId, staffToken, staffUserId;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  // token_version is RETURNed and signed into the JWT: middleware/auth.js:46
  // compares decoded.tokenVersion against users.token_version, and :41 looks the
  // user up by decoded.userId. A token signed { id, ... } 401s USER_NOT_FOUND.
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, token_version`,
    [EMAIL]
  );
  userId = u.rows[0].id;
  token = jwt.sign(
    { userId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Second, non-admin user purely for the permission test.
  const su = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id, token_version`,
    [STAFF_EMAIL]
  );
  staffUserId = su.rows[0].id;
  staffToken = jwt.sign(
    { userId: staffUserId, tokenVersion: su.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'TwistidTreets']);
  await pool.query('INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)', [userId, 'Nevver Sayles', EMAIL]);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('./nameNotices'));
  app.use((err, _rq, res, _nx) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, fieldErrors: err.fieldErrors });
  });
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await require('../../utils/refreshDisplayName').refreshDisplayName(userId, pool);
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NULL WHERE user_id = $1', [userId]);
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  if (staffUserId) await pool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
  await pool.end();
});

test('lists unreviewed names with both the display and legal name', async () => {
  const res = await req('GET', '/api/admin/name-notices');
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r) => r.user_id === userId);
  assert.ok(row, 'unreviewed row missing from the notice list');
  assert.equal(row.preferred_name, 'TwistidTreets');
  assert.equal(row.legal_name, 'Nevver Sayles');
  assert.equal(row.display_name, 'TwistidTreets S.');
});

test('ack stamps the row and drops it from the list', async () => {
  assert.equal((await req('POST', `/api/admin/name-notices/${userId}/ack`)).status, 200);
  const res = await req('GET', '/api/admin/name-notices');
  assert.ok(!res.body.rows.some((r) => r.user_id === userId));
});

// GUARD (spec §2, §7): the notice is not a gate.
test('acking does not change the rendered name', async () => {
  // Re-arm the notice: the ack is scoped to rows that are actually pending, so
  // without this the POST below would be a 404 no-op and prove nothing.
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NULL WHERE user_id = $1', [userId]);
  const before2 = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal((await req('POST', `/api/admin/name-notices/${userId}/ack`)).status, 200);
  const after2 = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(after2.rows[0].display_name, before2.rows[0].display_name);
  assert.equal(after2.rows[0].display_name, 'TwistidTreets S.');
});

// The ack is a write on an INTEGER column reached by a URL segment. Left
// unguarded, a non-numeric segment is a PG 22P02 that surfaces as a 500 plus
// Sentry noise, and a miss silently reports success.
test('a non-numeric user id is a clean 400, never a 500', async () => {
  const res = await req('POST', '/api/admin/name-notices/not-a-number/ack');
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors?.userId);
});

test('acking an unknown user is a 404, not a silent ok', async () => {
  const res = await req('POST', '/api/admin/name-notices/2147483000/ack');
  assert.equal(res.status, 404);
});

test('acking an already-reviewed name is a 404, and does not re-date the review', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NULL WHERE user_id = $1', [userId]);
  assert.equal((await req('POST', `/api/admin/name-notices/${userId}/ack`)).status, 200);
  const first = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);

  const res = await req('POST', `/api/admin/name-notices/${userId}/ack`);
  assert.equal(res.status, 404);
  const second = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.deepEqual(second.rows[0].preferred_name_reviewed_at, first.rows[0].preferred_name_reviewed_at);
});

test('a deactivated staffer never appears in the queue', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NULL WHERE user_id = $1', [userId]);
  await pool.query("UPDATE users SET onboarding_status = 'deactivated' WHERE id = $1", [userId]);
  const res = await req('GET', '/api/admin/name-notices');
  assert.ok(!res.body.rows.some((r) => r.user_id === userId));
  await pool.query("UPDATE users SET onboarding_status = 'approved' WHERE id = $1", [userId]);
});

test('rejects a non-admin caller', async () => {
  const saved = token;
  token = staffToken;
  try {
    const res = await req('GET', '/api/admin/name-notices');
    assert.ok(res.status === 401 || res.status === 403, `expected a permission failure, got ${res.status}`);
  } finally {
    token = saved;
  }
});
