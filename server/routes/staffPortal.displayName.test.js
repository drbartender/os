require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `sp-dn-${NONCE}@example.com`;
let server, baseUrl, token, userId;

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
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id, token_version`,
    [EMAIL]
  );
  userId = u.rows[0].id;
  token = jwt.sign(
    { userId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'Joey']);
  await pool.query('INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)', [userId, 'Joseph Key', EMAIL]);

  const app = express();
  app.use(express.json());
  app.use('/api/staff-portal', require('./staffPortal'));
  app.use((err, _rq, res, _nx) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, fieldErrors: err.fieldErrors });
  });
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('the harness authenticates at all (guards the JWT claim shape)', async () => {
  const res = await req('PATCH', '/api/staff-portal/profile', { phone: '3125550100' });
  assert.notEqual(res.status, 401, `auth failed: ${JSON.stringify(res.body)}`);
});

test('saving a preferred name refreshes display_name', async () => {
  const res = await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Joe' });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].display_name, 'Joe K.');
});

test('a changed preferred name clears the review stamp', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Joey' });
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].preferred_name_reviewed_at, null);
});

test('a phone-only edit does NOT clear the review stamp', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  const res = await req('PATCH', '/api/staff-portal/profile', { phone: '3125550101' });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.notEqual(rows[0].preferred_name_reviewed_at, null);
});

test('rejects a titled name with a field error and leaves the stored name alone', async () => {
  const res = await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Miss Taylor' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors?.preferred_name);
  const { rows } = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].preferred_name, 'Joey');
});

test('rejects a three-word name', async () => {
  assert.equal((await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Nicholas or Nick' })).status, 400);
});

// GRANDFATHERING (spec §3.4): a legacy value must not lock its owner out.
test('re-submitting an unchanged legacy name is accepted', async () => {
  await pool.query("UPDATE contractor_profiles SET preferred_name = 'Nicholas or Nick' WHERE user_id = $1", [userId]);
  const res = await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Nicholas or Nick', phone: '3125550102' });
  assert.equal(res.status, 200, `legacy name locked its owner out: ${JSON.stringify(res.body)}`);
  await pool.query("UPDATE contractor_profiles SET preferred_name = 'Joey' WHERE user_id = $1", [userId]);
});
