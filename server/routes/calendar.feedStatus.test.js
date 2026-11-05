'use strict';
// The calendar feed fails closed on account status, and deactivation rotates
// the feed token (audit 2026-11-05 AUTH-03).
//
// A deactivated manager's JWT dies on the next request (middleware/auth.js),
// but their calendar app kept polling GET /api/calendar/feed/:token, which
// looked the user up by token alone and, for an admin or manager, served every
// client's name, phone, email, event total and balance 30 days back and 365
// forward. The feed now applies the status predicate of middleware/auth.js in
// the lookup, and PUT /api/admin/users/:id/status rotates calendar_token in
// the same UPDATE that enters 'deactivated' or 'rejected', so a later
// re-activation does not resurrect the old subscription.
//
// Pure: the real routers run over real HTTP against a stubbed pool (the
// `pool.query = ...` seam of sms.status.test.js). The stub understands the two
// statements this suite is about: the feed's user lookup (it applies the
// status predicate when the SQL carries one, so the old lookup finds the
// deactivated row and the new one does not) and the status route's UPDATE (it
// records the text). The DB-backed sibling is calendar.feedRevocation.test.js.

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'calendar-feed-status-test-secret-0123456789abcdef';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

const BLOCKED = ['deactivated', 'rejected', 'suspended'];
const ADMIN_ID = 1;
const TARGET_ID = 2;
const LEGACY_ID = 3;
const base = { can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null };
const users = {
  [ADMIN_ID]: { id: ADMIN_ID, email: 'feed-admin@example.com', role: 'admin', onboarding_status: 'approved', calendar_token: crypto.randomUUID(), ...base },
  [TARGET_ID]: { id: TARGET_ID, email: 'feed-manager@example.com', role: 'manager', onboarding_status: 'approved', calendar_token: crypto.randomUUID(), ...base },
  // A legacy row with no status at all: middleware/auth.js lets it through
  // (none of the three blocked values), so the feed must too, which takes the
  // COALESCE in the lookup.
  [LEGACY_ID]: { id: LEGACY_ID, email: 'feed-legacy@example.com', role: 'manager', onboarding_status: null, calendar_token: crypto.randomUUID(), ...base },
};

let statements = [];
const realQuery = pool.query;
const realConnect = pool.connect;

// The lookup's status predicate, evaluated from the SQL itself rather than
// matched as a string: the `[NOT] IN (...)` list on onboarding_status, the
// COALESCE to '' only when the SQL carries it, and the `role = 'admin' OR`
// exemption. An inverted predicate (IN for NOT IN) resolves a deactivated row
// here and fails the test, as it would in Postgres; a dropped COALESCE loses
// the NULL-status legacy row, as it would there (NULL [NOT] IN (...) is NULL,
// which excludes the row either way). No predicate at all is the old lookup.
function statusPredicateAllows(text, u) {
  const m = /(COALESCE\()?onboarding_status(?:, '')?\)?\s+(NOT\s+)?IN\s*\(([^)]*)\)/.exec(text);
  if (!m) return true;
  const list = m[3].split(',').map((s) => s.trim().replace(/^'(.*)'$/, '$1'));
  const status = m[1] ? (u.onboarding_status ?? '') : u.onboarding_status;
  const inList = status === null || status === undefined ? null : list.includes(status);
  const passes = inList === null ? false : (m[2] ? !inList : inList);
  const adminExempt = /\brole = 'admin' OR\b/.test(text) && u.role === 'admin';
  return adminExempt || passes;
}

// The stub's reading of the two statements it emulates; everything else is
// "no rows", which is enough for the feed (an empty calendar) and the status
// route's tail (no profile, no application, no payment profile).
function answer(raw, params) {
  // Whitespace-normalized, so a statement reflowed over several lines still
  // matches its fragment.
  const text = String(raw).replace(/\s+/g, ' ').trim();
  statements.push({ text, params });
  if (text.includes('FROM users WHERE calendar_token = $1')) {
    const u = Object.values(users).find((x) => x.calendar_token === params[0]);
    if (!u) return { rows: [], rowCount: 0 };
    return statusPredicateAllows(text, u) ? { rows: [{ id: u.id, role: u.role }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (text.includes('FROM users WHERE id = $1')) {
    const u = users[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  if (text.includes('SELECT onboarding_status FROM users WHERE id=$1')) {
    const u = users[params[0]];
    return { rows: u ? [{ onboarding_status: u.onboarding_status }] : [], rowCount: u ? 1 : 0 };
  }
  if (text.startsWith('UPDATE users SET onboarding_status=$1')) {
    const u = users[params[1]];
    if (!u) return { rows: [], rowCount: 0 };
    u.onboarding_status = params[0];
    if (text.includes('calendar_token = gen_random_uuid()')) u.calendar_token = crypto.randomUUID();
    return { rows: [{ id: u.id, email: u.email, onboarding_status: u.onboarding_status }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

let server;
let baseUrl;
const adminJwt = () => jwt.sign({ userId: ADMIN_ID, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(new URL(path, baseUrl), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* ics or empty */ }
        resolve({ status: res.statusCode, body: json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  pool.query = (text, params) => Promise.resolve(answer(String(text), params || []));
  pool.connect = () => Promise.resolve({
    query: (text, params) => Promise.resolve(answer(String(text), params || [])),
    release() {},
  });
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', require('./calendar'));
  app.use('/api/admin', require('./admin/users'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = realQuery;
  pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

test('the feed answers an active manager\'s token', async () => {
  const res = await request('GET', `/api/calendar/feed/${users[TARGET_ID].calendar_token}`);
  assert.equal(res.status, 200, res.raw);
  assert.match(res.headers['content-type'], /text\/calendar/);
});

for (const status of BLOCKED) {
  test(`the feed is 404 for a ${status} manager's token, as for an unknown token`, async () => {
    const token = users[TARGET_ID].calendar_token;
    users[TARGET_ID].onboarding_status = status;
    try {
      statements = [];
      const res = await request('GET', `/api/calendar/feed/${token}`);
      assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.raw.slice(0, 120)}`);
      assert.equal(res.body.code, 'NOT_FOUND');
      assert.ok(!statements.some((s) => s.text.includes('FROM shifts s')), 'no shift was read for a blocked account');
    } finally {
      users[TARGET_ID].onboarding_status = 'approved';
    }
  });
}

test('a legacy row with a NULL status still gets its feed, as middleware/auth.js still lets it in', async () => {
  const res = await request('GET', `/api/calendar/feed/${users[LEGACY_ID].calendar_token}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw.slice(0, 120)}`);
});

test('the feed lookup fails closed the way middleware/auth.js does (admin exempt, the three statuses blocked)', async () => {
  statements = [];
  await request('GET', `/api/calendar/feed/${users[TARGET_ID].calendar_token}`);
  const lookup = statements.find((s) => s.text.includes('FROM users WHERE calendar_token = $1'));
  assert.ok(lookup, 'the lookup ran');
  for (const s of BLOCKED) assert.ok(lookup.text.includes(`'${s}'`), `the lookup names '${s}'`);
  assert.ok(lookup.text.includes("role = 'admin'"), 'the admin exemption of middleware/auth.js is mirrored');
});

for (const status of ['deactivated', 'rejected']) {
  test(`PUT /users/:id/status ${status} rotates calendar_token in the same UPDATE`, async () => {
    const before = users[TARGET_ID].calendar_token;
    statements = [];
    const res = await request('PUT', `/api/admin/users/${TARGET_ID}/status`, { token: adminJwt(), body: { status } });
    assert.equal(res.status, 200, res.raw);
    const update = statements.find((s) => s.text.startsWith('UPDATE users SET onboarding_status=$1'));
    assert.ok(update, 'the status UPDATE ran');
    assert.ok(update.text.includes('calendar_token = gen_random_uuid()'), `the ${status} UPDATE rotates the token: ${update.text}`);
    assert.ok(update.text.includes('calendar_token_created_at = NOW()'), 'and restamps created_at');
    assert.notEqual(users[TARGET_ID].calendar_token, before, 'the token changed');
    const feed = await request('GET', `/api/calendar/feed/${before}`);
    assert.equal(feed.status, 404, 'the old subscription URL is dead');
    users[TARGET_ID].onboarding_status = 'approved';
  });
}

test('re-activation (approved) does not rotate the token, and the old URL stays dead', async () => {
  users[TARGET_ID].onboarding_status = 'deactivated';
  const old = users[TARGET_ID].calendar_token;
  users[TARGET_ID].calendar_token = crypto.randomUUID(); // what the deactivation rotated to
  statements = [];
  const res = await request('PUT', `/api/admin/users/${TARGET_ID}/status`, { token: adminJwt(), body: { status: 'approved' } });
  assert.equal(res.status, 200, res.raw);
  const update = statements.find((s) => s.text.startsWith('UPDATE users SET onboarding_status=$1'));
  assert.ok(update && !update.text.includes('gen_random_uuid'), 'an ordinary status change leaves the token alone');
  const feed = await request('GET', `/api/calendar/feed/${old}`);
  assert.equal(feed.status, 404);
  const fresh = await request('GET', `/api/calendar/feed/${users[TARGET_ID].calendar_token}`);
  assert.equal(fresh.status, 200);
});
