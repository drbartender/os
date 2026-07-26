require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const progressRouter = require('./progress');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, userId, otherId, token, otherToken;

// NOTE: both details below are load-bearing and were wrong in an earlier
// revision of this plan, which failed every authenticated case:
//   1. auth.js reads decoded.userId / decoded.tokenVersion, NOT id / token_version.
//   2. AppError exposes statusCode, NOT status. res.status(undefined) throws.
// Both mirror server/routes/staffPortal.test.js:129 and :218 exactly.
function app() {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/progress', progressRouter);
  a.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    res.status(500).json({ error: 'server error' });
  });
  return a;
}

function request(method, path, { body, tok } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${path}`, {
      method,
      headers: {
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function makeUser(tag) {
  const hash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'in_progress', 0) RETURNING id`,
    [`draft-test-${tag}-${NONCE}@example.com`, hash]
  );
  const id = r.rows[0].id;
  // Keys MUST be userId / tokenVersion. See server/middleware/auth.js:41,46.
  return {
    id,
    token: jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }),
  };
}

before(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE 'draft-test-%'");
  ({ id: userId, token } = await makeUser('a'));
  ({ id: otherId, token: otherToken } = await makeUser('b'));
  server = app().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userId, otherId]]);
  server.close();
  await pool.end();
});

test('an absent draft reads as null rather than 404', async () => {
  const r = await request('GET', '/api/progress/draft/application', { tok: token });
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
});

test('a draft round-trips', async () => {
  const put = await request('PUT', '/api/progress/draft/application', {
    tok: token, body: { data: { full_name: 'Debbie', city: 'Chicago' } },
  });
  assert.equal(put.status, 200);

  const get = await request('GET', '/api/progress/draft/application', { tok: token });
  assert.equal(get.body.data.full_name, 'Debbie');
  assert.ok(get.body.updated_at);
});

test('a second save overwrites rather than duplicating, and advances updated_at', async () => {
  const before_ = await request('GET', '/api/progress/draft/application', { tok: token });
  // The UPSERT sets only `data`; updated_at depends entirely on the trigger from
  // Task B1. Without it the timestamp freezes at insert time and B4 renders a
  // permanently stale "We saved your answers from ..." notice.
  await new Promise(r => setTimeout(r, 1100));
  await request('PUT', '/api/progress/draft/application', { tok: token, body: { data: { city: 'Evanston' } } });
  const get = await request('GET', '/api/progress/draft/application', { tok: token });
  assert.ok(new Date(get.body.updated_at) > new Date(before_.body.updated_at),
    'update_onboarding_drafts_updated_at trigger is missing or not firing');

  assert.equal(get.body.data.city, 'Evanston');
  assert.equal(get.body.data.full_name, undefined, 'PUT replaces the payload, it does not merge');

  const rows = await pool.query('SELECT COUNT(*) FROM onboarding_drafts WHERE user_id = $1', [userId]);
  assert.equal(rows.rows[0].count, '1');
});

test('drafts are scoped per user', async () => {
  const get = await request('GET', '/api/progress/draft/application', { tok: otherToken });
  assert.equal(get.body.data, null, "another user's draft must not leak");
});

test('the two form keys are independent', async () => {
  await request('PUT', '/api/progress/draft/contractor_profile', { tok: token, body: { data: { phone: '3125551212' } } });
  const app_ = await request('GET', '/api/progress/draft/application', { tok: token });
  const cp = await request('GET', '/api/progress/draft/contractor_profile', { tok: token });
  assert.equal(app_.body.data.city, 'Evanston');
  assert.equal(cp.body.data.phone, '3125551212');
});

test('an unknown form key is rejected', async () => {
  const r = await request('PUT', '/api/progress/draft/payday_protocols', { tok: token, body: { data: { ssn: '000-00-0000' } } });
  assert.equal(r.status, 400);
  const rows = await pool.query("SELECT COUNT(*) FROM onboarding_drafts WHERE form_key = 'payday_protocols'");
  assert.equal(rows.rows[0].count, '0', 'the excluded sensitive form must never persist');
});

test('a non-object payload is rejected', async () => {
  const r = await request('PUT', '/api/progress/draft/application', { tok: token, body: { data: 'nope' } });
  assert.equal(r.status, 400);
});

test('an oversized payload is rejected', async () => {
  const r = await request('PUT', '/api/progress/draft/application', {
    tok: token, body: { data: { blob: 'x'.repeat(70 * 1024) } },
  });
  assert.equal(r.status, 400);
});

test('delete clears the draft', async () => {
  const del = await request('DELETE', '/api/progress/draft/application', { tok: token });
  assert.equal(del.status, 200);
  const get = await request('GET', '/api/progress/draft/application', { tok: token });
  assert.equal(get.body.data, null);
});

test('unauthenticated access is refused', async () => {
  const r = await request('GET', '/api/progress/draft/application');
  assert.equal(r.status, 401);
});
