require('dotenv').config();

// Route-level tests for GET /api/admin/badge-counts (server/routes/admin/settings.js).
// Verifies the role guard (admin + manager allowed, staff/anon denied) and that the
// manager response zeroes new_applications, since the Hiring surface is adminOnly.
// Closes Sentry DRBARTENDER-SERVER-R, where a manager's 60s dashboard poll 403'd
// and emitted a role_denial warning every minute.
//
// Hand-rolled harness mirrors adminCoverSwaps.test.js: a minimal express() app with
// the real router + real auth/role middleware, driven via node:http + node:test.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const settingsRouter = require('./settings');

let server;
let baseUrl;
let adminToken;
let managerToken;
let staffToken;
let badgeSmsClientId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = 'badge-counts-test-';

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function makeUser(role, status = 'approved') {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, $3, $4, 0) RETURNING id, token_version`,
    [`${EMAIL_PREFIX}${role}-${status}-${NONCE}@example.com`, passwordHash, role, status]
  );
  return r.rows[0];
}

function tokenFor(u) {
  return jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

before(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);

  adminToken = tokenFor(await makeUser('admin'));
  managerToken = tokenFor(await makeUser('manager'));
  staffToken = tokenFor(await makeUser('staff'));

  // Seed one applicant so new_applications is >= 1 for an admin. This proves the
  // manager-side zeroing is a real branch, not just an empty table coincidentally
  // reading 0. applications.user_id is ON DELETE CASCADE, so the after-cleanup of
  // the applicant user removes this row too.
  const applicant = await makeUser('staff', 'applied');
  await pool.query(
    `INSERT INTO applications
       (user_id, full_name, phone, city, state, travel_distance,
        reliable_transportation, positions_interested, why_dr_bartender)
     VALUES ($1, $2, '+15555551234', 'Chicago', 'IL', '25',
             'yes', 'Bartender', 'Test')`,
    [applicant.id, `Badge Counts Applicant ${NONCE}`]
  );

  // A client to hang SMS rows off for the unread_sms relay test below. Its
  // messages are inserted and removed inside that test so the other counts here
  // never see them.
  const smsClient = await pool.query(
    `INSERT INTO clients (name, phone) VALUES ($1, '3125550401') RETURNING id`,
    [`Badge Counts SMS ${NONCE}`]
  );
  badgeSmsClientId = smsClient.rows[0].id;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', settingsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'Internal error' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (badgeSmsClientId) {
    await pool.query('DELETE FROM sms_messages WHERE client_id = $1', [badgeSmsClientId]);
    await pool.query('DELETE FROM clients WHERE id = $1', [badgeSmsClientId]);
  }
  await pool.query(`DELETE FROM users WHERE email LIKE '${EMAIL_PREFIX}%'`);
  await pool.end();
});

const COUNT_KEYS = ['pending_proposals', 'unstaffed_events', 'new_applications',
  'pending_shopping_lists', 'unread_sms', 'pending_reviews'];

test('admin reads badge-counts: all six integer counts, seeded applicant visible', async () => {
  const res = await get('/api/admin/badge-counts', adminToken);
  assert.equal(res.status, 200);
  for (const k of COUNT_KEYS) assert.equal(typeof res.body[k], 'number', `${k} should be a number`);
  assert.ok(res.body.new_applications >= 1, 'admin sees the seeded applicant in new_applications');
});

test('manager reads badge-counts but new_applications is zeroed', async () => {
  const res = await get('/api/admin/badge-counts', managerToken);
  assert.equal(res.status, 200);
  for (const k of COUNT_KEYS) assert.equal(typeof res.body[k], 'number', `${k} should be a number`);
  assert.equal(res.body.new_applications, 0, 'manager must not see the admin-only hiring count');
});

test('staff is denied badge-counts (403)', async () => {
  const res = await get('/api/admin/badge-counts', staffToken);
  assert.equal(res.status, 403);
});

test('unauthenticated is denied badge-counts (401)', async () => {
  const res = await get('/api/admin/badge-counts', null);
  assert.equal(res.status, 401);
});

test('pending_reviews rides the payload and is zeroed for managers', async () => {
  const admin = await get('/api/admin/badge-counts', adminToken);
  assert.equal(admin.status, 200);
  assert.equal(typeof admin.body.pending_reviews, 'number');
  const mgr = await get('/api/admin/badge-counts', managerToken);
  assert.equal(mgr.status, 200);
  assert.equal(mgr.body.pending_reviews, 0);
});

// unread_sms must count exactly what the Messages inbox shows. Thumbtack relay
// echoes (metadata.thumbtack_relay) are machine traffic that server/routes/sms.js
// excludes from the inbox, so counting them here made the nav badge advertise 115
// unread against an inbox holding none, with nothing to click.
test('unread_sms ignores thumbtack-relay echoes and counts real inbound', async () => {
  const before = await get('/api/admin/badge-counts', adminToken);
  assert.equal(before.status, 200);
  const baseline = before.body.unread_sms;

  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, read_at, metadata, created_at) VALUES
       ('inbound', $1, '3125550401', 'X replied to you on Thumbtack', 'general', 'received', NULL, '{"thumbtack_relay": true}'::jsonb, NOW()),
       ('inbound', $1, '3125550401', 'Your access code is 4821',      'general', 'received', NULL, '{"thumbtack_relay": true}'::jsonb, NOW()),
       ('inbound', $1, '3125550401', 'relay echo three',              'general', 'received', NULL, '{"thumbtack_relay": true}'::jsonb, NOW())`,
    [badgeSmsClientId]
  );

  const afterRelay = await get('/api/admin/badge-counts', adminToken);
  assert.equal(afterRelay.status, 200);
  assert.equal(afterRelay.body.unread_sms, baseline,
    'three unread relay echoes must not move the badge');

  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, read_at, created_at) VALUES
       ('inbound', $1, '3125550401', 'a real client question', 'general', 'received', NULL, NOW())`,
    [badgeSmsClientId]
  );

  const afterReal = await get('/api/admin/badge-counts', adminToken);
  assert.equal(afterReal.status, 200);
  assert.equal(afterReal.body.unread_sms, baseline + 1,
    'one real unread inbound must move the badge by exactly one');

  await pool.query('DELETE FROM sms_messages WHERE client_id = $1', [badgeSmsClientId]);
});
