require('dotenv').config();
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const adminPush = require('../utils/adminPush');
const { AppError } = require('../utils/errors');

const NONCE = `${Date.now()}-${process.pid}`;
let server; let baseUrl; let admin; let admin2; let staff; let adminToken; let admin2Token; let staffToken;

const mint = (u) => jwt.sign({ userId: u.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(new URL(path, baseUrl), {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

before(async () => {
  admin = (await pool.query(`INSERT INTO users (email, password_hash, role, staff_notification_preferences) VALUES ($1, 'x', 'admin', jsonb_build_object('push_subscriptions', '[{"endpoint":"https://push.example.test/t","keys":{"p256dh":"p","auth":"a"}}]'::jsonb)) RETURNING id`, [`me-push-a-${NONCE}@example.com`])).rows[0];
  admin2 = (await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`, [`me-push-a2-${NONCE}@example.com`])).rows[0];
  staff = (await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`, [`me-push-s-${NONCE}@example.com`])).rows[0];
  adminToken = mint(admin); admin2Token = mint(admin2); staffToken = mint(staff);
  const app = express();
  app.use(express.json());
  app.use('/api/me', require('./me'));
  app.use('/api/me', require('./mePush'));
  // Mounted after mePush as in server/index.js: the staff portal router owns
  // POST /push-subscriptions, where a device declares its surface.
  app.use('/api/me', require('./staffPortal'));
  // The repo's global handler is inline in server/index.js; a route harness
  // writes its own. This is webauthn.test.js:135-143 verbatim (AppError ->
  // its statusCode and message; anything else 500).
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
// Delete first and guard everything: when before throws after its INSERTs
// (the RED step does), server is undefined and the fixtures must still go.
after(async () => {
  try {
    try {
      const ids = [admin, admin2, staff].filter(Boolean).map((u) => u.id);
      if (ids.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
    } finally {
      if (server) await new Promise((r) => server.close(r));
    }
  } finally {
    await pool.end();
  }
});

test('GET notification-preferences carries every kind (absent = on) and the push block', async () => {
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub-test'; process.env.VAPID_PRIVATE_KEY = 'priv-test';
  try {
    const res = await request('GET', '/api/me/notification-preferences', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.push, { public_key: 'pub-test', kinds: [...adminPush.PUSH_KINDS] });
    assert.deepEqual(Object.keys(res.body.admin_push_preferences), [...adminPush.PUSH_KINDS]);
    assert.equal(res.body.admin_push_preferences.staffing_drop, true);
    assert.ok(res.body.notification_preferences);
  } finally {
    [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
    if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
    if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
  }
});

test('GET push.public_key is null when the server cannot sign', async () => {
  const saved = process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_PRIVATE_KEY;
  try {
    const res = await request('GET', '/api/me/notification-preferences', { token: adminToken });
    assert.equal(res.body.push.public_key, null);
  } finally { if (saved !== undefined) process.env.VAPID_PRIVATE_KEY = saved; }
});

test('PATCH stores a kind switch, alone or beside a category, and rejects an empty body', async () => {
  let res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { admin_push_preferences: { staffing_drop: false } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.admin_push_preferences.staffing_drop, false);
  assert.equal(res.body.admin_push_preferences.payment_landed, true);
  res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { system_error: false, admin_push_preferences: { staffing_drop: true } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.notification_preferences.system_error, false);
  assert.equal(res.body.admin_push_preferences.staffing_drop, true);
  const row = (await pool.query('SELECT admin_push_preferences AS p FROM users WHERE id = $1', [admin.id])).rows[0].p;
  assert.deepEqual(row, { staffing_drop: true });
  res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { system_error: true, admin_push_preferences: 'x' } });
  assert.equal(res.status, 400);
  const untouched = (await pool.query('SELECT notification_preferences AS n, admin_push_preferences AS p FROM users WHERE id = $1', [admin.id])).rows[0];
  assert.equal(untouched.n.system_error, false);
  assert.deepEqual(untouched.p, { staffing_drop: true });
  res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { system_error: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.admin_push_preferences.staffing_drop, true);
  const kept = (await pool.query('SELECT admin_push_preferences AS p FROM users WHERE id = $1', [admin.id])).rows[0].p;
  assert.deepEqual(kept, { staffing_drop: true });
  res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: {} });
  assert.equal(res.status, 400);
  res = await request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { admin_push_preferences: { routine_thumbtack: false } } });
  assert.equal(res.status, 400);
  res = await request('PATCH', '/api/me/notification-preferences', { token: staffToken, body: { admin_push_preferences: { staffing_drop: false } } });
  assert.equal(res.status, 403);
});

// The phone flips each kind with its own PATCH, and the desktop toggles
// categories on the same row. Two writes in flight must both land.
test('PATCH merges in SQL: concurrent switches, and a category beside a kind, never lose an update', async () => {
  const read = async () => (await pool.query('SELECT notification_preferences AS n, admin_push_preferences AS p FROM users WHERE id = $1', [admin.id])).rows[0];
  const start = await read();
  try {
    const [a, b] = await Promise.all([
      request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { admin_push_preferences: { staffing_drop: false } } }),
      request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { admin_push_preferences: { payment_landed: false } } }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    let row = await read();
    assert.equal(row.p.staffing_drop, false);
    assert.equal(row.p.payment_landed, false);
    const flipped = !row.n.system_error;
    const [c, d] = await Promise.all([
      request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { system_error: flipped } }),
      request('PATCH', '/api/me/notification-preferences', { token: adminToken, body: { admin_push_preferences: { booking_signed: false } } }),
    ]);
    assert.equal(c.status, 200);
    assert.equal(d.status, 200);
    row = await read();
    assert.equal(row.n.system_error, flipped);
    assert.deepEqual(row.p, { staffing_drop: false, payment_landed: false, booking_signed: false });
  } finally {
    await pool.query('UPDATE users SET notification_preferences = $2, admin_push_preferences = $3 WHERE id = $1', [admin.id, JSON.stringify(start.n), JSON.stringify(start.p)]);
  }
});

test('POST push-test is admin or manager only and reports what it could send', async () => {
  const real = adminPush.sendPushToUser;
  const calls = [];
  require('../utils/adminPush').sendPushToUser = (args) => { calls.push(args); return Promise.resolve({ subscriptions: 1, sent: 1, failed: 0, gone: 0 }); };
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub-test'; process.env.VAPID_PRIVATE_KEY = 'priv-test';
  try {
    let res = await request('POST', '/api/me/push-test', { token: staffToken });
    assert.equal(res.status, 403);
    res = await request('POST', '/api/me/push-test', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { subscriptions: 1, sent: 1, failed: 0, gone: 0, reason: null });
    assert.equal(calls[0].userId, admin.id);
    assert.equal(calls[0].url, '/more/notifications');
    assert.equal(calls[0].tag, 'push_test');
    assert.equal(calls[0].surface, 'admin');
    delete process.env.VAPID_PRIVATE_KEY;
    res = await request('POST', '/api/me/push-test', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.reason, 'vapid_unset');
    assert.equal(res.body.sent, 0);
  } finally {
    require('../utils/adminPush').sendPushToUser = real;
    [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
    if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
    if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
  }
});

test('POST push-test reports a failed read as read_failed, from the flag only, and never the error text', async () => {
  const real = adminPush.sendPushToUser;
  require('../utils/adminPush').sendPushToUser = () => Promise.resolve({ subscriptions: 0, sent: 0, failed: 0, gone: 0, readFailed: true, error: 'relation does not exist' });
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub-test'; process.env.VAPID_PRIVATE_KEY = 'priv-test';
  try {
    const res = await request('POST', '/api/me/push-test', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { subscriptions: 0, sent: 0, failed: 0, gone: 0, reason: 'read_failed' });
    assert.ok(!JSON.stringify(res.body).includes('relation'), 'the database error never reaches the response');
  } finally {
    require('../utils/adminPush').sendPushToUser = real;
    [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
    if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
    if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
  }
});

test('POST push-test answers no_subscriptions for an admin with no device (the real send, nothing leaves the box)', async () => {
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub-test'; process.env.VAPID_PRIVATE_KEY = 'priv-test';
  try {
    const res = await request('POST', '/api/me/push-test', { token: admin2Token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { subscriptions: 0, sent: 0, failed: 0, gone: 0, reason: 'no_subscriptions' });
  } finally {
    [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
    if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
    if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
  }
});

// An admin-phone device and a staff-portal device on one account: the
// subscribe stores the surface only when it is exactly 'admin', and the test
// banner reaches only the admin entry (the real sendPushToUser, the sender
// stubbed, so nothing leaves the box).
test('POST push-subscriptions stores the admin surface, and push-test sends only to the admin entry', async () => {
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  process.env.VAPID_PUBLIC_KEY = 'pub-test'; process.env.VAPID_PRIVATE_KEY = 'priv-test';
  const pushSender = require('../utils/pushSender');
  const realSend = pushSender.sendPush;
  const sentTo = [];
  pushSender.sendPush = async ({ subscription }) => { await Promise.resolve(); sentTo.push(subscription.endpoint); return { ok: true }; };
  const ep = (n) => `https://push.example.test/${NONCE}/surface-${n}`;
  const keys = { p256dh: 'p', auth: 'a' };
  try {
    let res = await request('POST', '/api/me/push-subscriptions', { token: admin2Token, body: { endpoint: ep('admin'), keys, surface: 'admin' } });
    assert.equal(res.status, 200);
    res = await request('POST', '/api/me/push-subscriptions', { token: admin2Token, body: { endpoint: ep('plain'), keys } });
    assert.equal(res.status, 200);
    res = await request('POST', '/api/me/push-subscriptions', { token: admin2Token, body: { endpoint: ep('other'), keys, surface: 'staff' } });
    assert.equal(res.status, 200);
    const stored = (await pool.query(`SELECT staff_notification_preferences->'push_subscriptions' AS s FROM users WHERE id = $1`, [admin2.id])).rows[0].s;
    assert.deepEqual(stored.map((x) => [x.endpoint, x.surface]), [[ep('admin'), 'admin'], [ep('plain'), undefined], [ep('other'), undefined]], 'only an exact admin stores a surface');
    res = await request('POST', '/api/me/push-test', { token: admin2Token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { subscriptions: 1, sent: 1, failed: 0, gone: 0, reason: null });
    assert.deepEqual(sentTo, [ep('admin')]);
  } finally {
    pushSender.sendPush = realSend;
    [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
    if (saved[0] === undefined) delete process.env.VAPID_PUBLIC_KEY;
    if (saved[1] === undefined) delete process.env.VAPID_PRIVATE_KEY;
  }
});
