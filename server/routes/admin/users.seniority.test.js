require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const usersRouter = require('./users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.seniority.test.js refuses to run against production');
}

const PREFIX = 'seniority-route-test-';
let server, baseUrl, userId, pristineUserId, noProfileUserId, adminId, adminToken;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`${PREFIX}admin@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`${PREFIX}staff@example.com`]
  );
  userId = u.rows[0].id;
  // Contractor profile, NO shifts → 0 live events. This is the mutation target.
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)`,
    [userId, `${PREFIX}Vet`]
  );

  // A profile NO test ever writes to, so the zero-baseline no-op lock below is
  // independent of test ordering rather than relying on running first.
  const p = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`${PREFIX}pristine@example.com`]
  );
  pristineUserId = p.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)`,
    [pristineUserId, `${PREFIX}Pristine`]
  );

  // A staff user with NO contractor_profiles row at all (admin-hired before
  // onboarding). 14 of 89 dev users are in this shape.
  const n = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`${PREFIX}noprofile@example.com`]
  );
  noProfileUserId = n.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/admin', usersRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  const ids = [userId, pristineUserId, noProfileUserId, adminId].filter(Boolean);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [ids]);
  await pool.end();
});

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: `Bearer ${token}` };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + (url.search || ''), headers },
      (res) => { let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null })); }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Set the baseline a test depends on, rather than inheriting it from whichever
// test happened to run before. Each test below establishes its own precondition.
async function seedBaseline(id, historical) {
  const r = await req('PUT', `/api/admin/users/${id}/seniority`, adminToken,
    { historical_events_worked: historical });
  assert.equal(r.status, 200, 'precondition PUT succeeded');
}

// Global Constraint 2: a zero baseline is a no-op for every non-migrated
// profile. This is the property that makes the lane safe to merge and deploy
// BEFORE the backfill ever runs, and nothing else asserts it. Uses a profile no
// other test writes to, so it holds regardless of execution order.
test('zero baseline is a no-op: total equals the live count for an untouched profile', async () => {
  const res = await req('GET', `/api/admin/users/${pristineUserId}/seniority`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.historical_events_worked, 0, 'column defaults to 0');
  assert.equal(res.body.events_worked_live, 0);
  assert.equal(res.body.events_worked, res.body.events_worked_live,
    'total === live when the baseline is 0 (pre-backfill no-op)');
});

test('GET seniority returns live + historical split; PUT persists the baseline', async () => {
  const put = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { historical_events_worked: 9, hire_date: '2025-03-01' });
  assert.equal(put.status, 200);

  const res = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.historical_events_worked, 9);
  assert.equal(res.body.events_worked_live, 0);
  assert.equal(res.body.events_worked, 9);              // total = live + historical
  assert.ok(res.body.computed_score >= 6.3);            // 9*0.7 + tenure*0.3 (tenure ≥ 0)
});

// The DB CHECK is a backstop, NOT the validator. Dev and prod disagree about
// which CHECK constraints exist ([[reference-dev-db-missing-check-constraints]]),
// so the route must reject bad input itself and return a field error, not let
// Postgres raise 23514/22P02/22003 into an opaque 500. Each case asserts the
// value on disk is untouched, which is what makes this a real guard rather than
// a status-code assertion.
//
// The type is checked BEFORE coercion, so this list covers the values that
// coercion would have silently accepted: true→1, ' '→0 (which would ZERO a
// backfilled baseline), [5]→5, '0x10'→16, '1e3'→1000, and 1.5 which Postgres
// rounds to 2 rather than rejecting.
test('PUT rejects a negative, oversized, fractional or non-numeric baseline with 400 and writes nothing', async () => {
  await seedBaseline(userId, 9);

  // NaN/Infinity are deliberately absent: JSON.stringify turns both into null,
  // which is the "field omitted, keep stored" signal, so they never arrive as a
  // bad value over the wire. The route still rejects them via Number.isInteger
  // for any non-HTTP caller.
  const bad = [-5, '-5', 'abc', 1.5, '1.5', true, false, [], [5], {}, ' ', '0x10', '1e3', 100001];
  for (const value of bad) {
    const r = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
      { historical_events_worked: value });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(value)}, got ${r.status}`);
    assert.ok(r.body.error, 'a client-visible message is returned');
  }

  const afterRes = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(afterRes.body.historical_events_worked, 9, 'rejected writes never landed');
});

test('PUT accepts 0 and a numeric string, and treats "" as keep', async () => {
  await seedBaseline(userId, 9);

  // Explicit 0 must WRITE (clearing a baseline is legitimate), not read as absent.
  const zero = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { historical_events_worked: 0 });
  assert.equal(zero.status, 200);
  let res = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(res.body.historical_events_worked, 0, 'explicit 0 is written, not ignored');

  // A numeric string from a form input is accepted and bound as a number.
  const str = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { historical_events_worked: '12' });
  assert.equal(str.status, 200);
  res = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(res.body.historical_events_worked, 12);

  // '' is the "not supplied" signal and must keep what is stored.
  const empty = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { historical_events_worked: '' });
  assert.equal(empty.status, 200);
  res = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(res.body.historical_events_worked, 12, '"" keeps the stored baseline');
});

// Omitting the field must KEEP the stored value (COALESCE-to-keep). This is the
// lane-ordering guard: Lane 1 merges before Lane 2, so for a window the deployed
// client PUTs a body with no historical_events_worked at all, and that must not
// zero a freshly backfilled baseline.
test('PUT without the field preserves the stored baseline', async () => {
  await seedBaseline(userId, 9);

  const r = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { seniority_adjustment: 2 });
  assert.equal(r.status, 200);
  const afterRes = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(afterRes.body.historical_events_worked, 9);
  assert.equal(afterRes.body.seniority_adjustment, 2);
});

// seniority_adjustment lives in the same handler and was previously bound raw,
// so 'abc' reached an INTEGER column (22P02 → 500) and 1.5 was silently rounded
// to 2. It gets the same guard, but allows negatives — a downward adjustment is
// the whole point of the field.
test('PUT validates seniority_adjustment with the same guard, negatives allowed', async () => {
  const set = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { seniority_adjustment: 4 });
  assert.equal(set.status, 200);

  for (const value of ['abc', 1.5, true, [], ' ', '1e3', 100001, -100001]) {
    const r = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
      { seniority_adjustment: value });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(value)}, got ${r.status}`);
    assert.ok(r.body.error, 'a client-visible message is returned');
  }
  let res = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(res.body.seniority_adjustment, 4, 'rejected writes never landed');

  // A negative adjustment is valid and must persist.
  const neg = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { seniority_adjustment: -3 });
  assert.equal(neg.status, 200);
  res = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(res.body.seniority_adjustment, -3);
});

// A user with no contractor_profiles row matched zero rows and still returned
// {success:true}, so an admin's baseline silently evaporated. The write must
// report that it went nowhere.
test('PUT on a user with no contractor profile 404s instead of reporting success', async () => {
  const r = await req('PUT', `/api/admin/users/${noProfileUserId}/seniority`, adminToken,
    { historical_events_worked: 7 });
  assert.equal(r.status, 404, 'a write that matched no row is not a success');
  assert.ok(r.body.error, 'a client-visible message is returned');

  const check = await pool.query(
    'SELECT 1 FROM contractor_profiles WHERE user_id = $1',
    [noProfileUserId]
  );
  assert.equal(check.rowCount, 0, 'the route did not conjure a profile row');
});
