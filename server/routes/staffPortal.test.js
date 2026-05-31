require('dotenv').config();

// Set NODE_ENV=test BEFORE requiring middleware so emailChangeRequestLimiter's
// skip-on-test branch fires (matches the calcomWebhookLimiter pattern). Tests
// otherwise burst many email-change requests as the same fixture user and the
// 3/24h cap would 429 cases after the third.
process.env.NODE_ENV = 'test';

// Route-level tests for server/routes/staffPortal.js.
//
// HARNESS NOTES
// -------------
// Mirrors the pattern in server/routes/beo.test.js and crud.test.js: there is
// no supertest/jest/mocha in this repo. Each suite stands up a minimal
// express() app, mounts the real router with the real auth middleware (already
// inside the router), and an AppError-aware error handler that mirrors
// server/index.js. Driven via node's built-in http module.
//
// The same harness is reused across tasks 12 to 17 — every test calls the same
// `request()` helper. Tests run against the dev database (DATABASE_URL pulled
// from ../../os/.env via the bash test prefix).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const fileUpload = require('express-fileupload');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { encrypt, decrypt } = require('../utils/encryption');
const staffPortalRouter = require('./staffPortal');

// ─── Shared harness state ──────────────────────────────────────────────────
let server;
let baseUrl;
let staffToken;
let staffUserId;
let otherStaffToken;
let otherStaffUserId;
let proposalId;
let clientId;
let shiftId;
let payPeriodId;
let payoutId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// ─── HTTP helper ────────────────────────────────────────────────────────────
// Build a multipart/form-data body by hand. node-fetch and form-data aren't in
// the repo dev deps, so build the wire format directly. Returns the body
// buffer + the Content-Type header value (including the boundary).
function buildMultipart({ fields = {}, file = null }) {
  const boundary = `----nodetest${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`
    ));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

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

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // Defensive cleanup — purge any rows left behind by a prior crashed run.
  await pool.query("DELETE FROM users WHERE email LIKE 'staff-portal-test-%'");

  const passwordHash = await bcrypt.hash('x', 4);

  // Primary staff user — the one whose payloads we mostly inspect.
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`staff-portal-test-staff-${NONCE}@example.com`, passwordHash]
  );
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign(
    { userId: staffUserId, tokenVersion: s.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550101', 'Test Staff', 'bartender', 25.00)`,
    [staffUserId]
  );

  // Second staff user — for IDOR + cover-broadcast tests.
  const o = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [`staff-portal-test-other-${NONCE}@example.com`, passwordHash]
  );
  otherStaffUserId = o.rows[0].id;
  otherStaffToken = jwt.sign(
    { userId: otherStaffUserId, tokenVersion: o.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, position, hourly_rate)
     VALUES ($1, '5555550102', 'Other Staff', 'bartender', 25.00)`,
    [otherStaffUserId]
  );

  // Client, proposal, drink_plan, shift, shift_request.
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551111') RETURNING id",
    [`Staff Portal Test ${NONCE}`, `staff-portal-test-client-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
                             event_timezone, status, event_type)
     VALUES ($1, CURRENT_DATE + 14, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, finalized_at)
     VALUES ($1, 'reviewed', '{}'::jsonb, NOW())`,
    [proposalId]
  );
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id, location)
     VALUES (CURRENT_DATE + 14, '18:00', '22:00', 'open', $1, '123 Main St')
     RETURNING id`,
    [proposalId]
  );
  shiftId = sh.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, 'approved', 'bartender')`,
    [shiftId, staffUserId]
  );

  // Pay period spanning today, plus an empty payout row so /staff-home returns
  // a meaningful current_period block.
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES (CURRENT_DATE - 3, CURRENT_DATE + 10, CURRENT_DATE + 14, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = EXCLUDED.status
     RETURNING id`
  );
  payPeriodId = pp.rows[0].id;
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, total_cents)
     VALUES ($1, $2, 12345)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET total_cents = EXCLUDED.total_cents
     RETURNING id`,
    [payPeriodId, staffUserId]
  );
  payoutId = po.rows[0].id;

  // Minimal app: real router + AppError-aware error handler matching server/index.js.
  // express-fileupload mounted so multipart tests (Task 16) get a parsed
  // req.files; mirrors the dev server's middleware order.
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 }, abortOnLimit: true, useTempFiles: false }));
  app.use('/api/me', staffPortalRouter);
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

// ─── Teardown ───────────────────────────────────────────────────────────────
after(async () => {
  await pool.query("DELETE FROM staff_audit_log WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM staff_document_history WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM pending_email_changes WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM payment_profiles WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM payout_events WHERE payout_id = $1", [payoutId]);
  await pool.query("DELETE FROM payouts WHERE id = $1", [payoutId]);
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id = $1 AND entity_type = 'proposal'", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id = $1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [staffUserId, otherStaffUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Task 12: GET /api/me/staff-home ────────────────────────────────────────

test('GET /api/me/staff-home > 401 without JWT', async () => {
  const res = await request('GET', '/api/me/staff-home');
  assert.strictEqual(res.status, 401);
});

test('GET /api/me/staff-home > composite payload shape', async () => {
  const res = await request('GET', '/api/me/staff-home', { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body, 'has body');
  assert.ok('next_shift' in res.body);
  assert.ok('pending_requests' in res.body);
  assert.ok('cover_broadcasts' in res.body);
  assert.ok('current_period' in res.body);
  assert.ok('open_shifts_teaser' in res.body);
  // Next shift should resolve to the row we seeded.
  assert.strictEqual(res.body.next_shift?.shift_id, shiftId);
  assert.strictEqual(res.body.next_shift?.proposal_id, proposalId);
  // BEO finalized_at projected, ack still null
  assert.ok(res.body.next_shift?.drink_plan_finalized_at);
  assert.strictEqual(res.body.next_shift?.beo_acknowledged_at, null);
  // Current pay-period projection includes the seeded payout total.
  assert.strictEqual(res.body.current_period?.total_cents, 12345);
  assert.ok(Array.isArray(res.body.open_shifts_teaser));
  // The seeded shift is open + future, so it surfaces in the teaser, capped at 2.
  assert.ok(res.body.open_shifts_teaser.length >= 1, 'teaser is populated when open shifts exist');
  assert.ok(res.body.open_shifts_teaser.length <= 2, 'teaser is capped at 2 (spec §6.2)');
  // open_shifts_count carries the true total for the "All (N)" link.
  assert.strictEqual(typeof res.body.open_shifts_count, 'number');
  assert.ok(res.body.open_shifts_count >= 1, 'count reflects existing open shifts');
});

test('GET /api/me/staff-home > IDOR: other user sees empty next_shift', async () => {
  // otherStaff has no approved request on the seeded shift, so the next_shift
  // query should return no row for them.
  const res = await request('GET', '/api/me/staff-home', { token: otherStaffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.next_shift, null);
  // And no current-period payout row for them either.
  assert.ok(res.body.current_period === null || res.body.current_period.payout_id === null);
});

// ─── Task 13: Payment methods ───────────────────────────────────────────────

async function clearPaymentProfile(uid) {
  await pool.query('DELETE FROM staff_audit_log WHERE user_id = $1', [uid]);
  await pool.query('DELETE FROM payment_profiles WHERE user_id = $1', [uid]);
}

test('GET /api/me/payment-methods > synthetic empty when no row', async () => {
  await clearPaymentProfile(staffUserId);
  const res = await request('GET', '/api/me/payment-methods', { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.preferred_payment_method, null);
  assert.strictEqual(res.body.venmo_handle, null);
  assert.strictEqual(res.body.zelle_handle, null);
  assert.strictEqual(res.body.routing_number_last4, null);
  assert.strictEqual(res.body.account_number_last4, null);
});

test('GET /api/me/payment-methods > projects last-4 only, never raw', async () => {
  // Encrypt seed values manually so we know what last-4 to expect.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, routing_number, account_number, venmo_handle)
     VALUES ($1, $2, $3, 'staffer-vee')
     ON CONFLICT (user_id) DO UPDATE SET routing_number = $2, account_number = $3, venmo_handle = 'staffer-vee'`,
    [staffUserId, encrypt('011000015'), encrypt('1234567890')]
  );
  const res = await request('GET', '/api/me/payment-methods', { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.routing_number_last4, '0015');
  assert.strictEqual(res.body.account_number_last4, '7890');
  assert.strictEqual(res.body.venmo_handle, 'staffer-vee');
  // No raw ciphertext or full plaintext leaks.
  for (const key of Object.keys(res.body)) {
    assert.ok(!String(res.body[key]).includes('enc:'), `no ciphertext leak in ${key}`);
    assert.ok(!String(res.body[key]).includes('1234567890'), `no raw account in ${key}`);
  }
});

test('PATCH /api/me/payment-methods > unknown key rejected 400 pre-DB', async () => {
  await clearPaymentProfile(staffUserId);
  const res = await request('PATCH', '/api/me/payment-methods', {
    token: staffToken,
    body: { user_id: 99, venmo_handle: 'evil' },
  });
  assert.strictEqual(res.status, 400);
  // And no payment_profiles row should have been created — proves the
  // allowlist check fired before any DB write.
  const { rows } = await pool.query('SELECT id FROM payment_profiles WHERE user_id = $1', [staffUserId]);
  assert.strictEqual(rows.length, 0);
});

test('PATCH /api/me/payment-methods > only-routing leaves account ciphertext untouched', async () => {
  await clearPaymentProfile(staffUserId);
  const origRouting = encrypt('011000015');
  const origAccount = encrypt('1234567890');
  await pool.query(
    `INSERT INTO payment_profiles (user_id, routing_number, account_number)
     VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
    [staffUserId, origRouting, origAccount]
  );
  const res = await request('PATCH', '/api/me/payment-methods', {
    token: staffToken,
    body: { routing_number: '011000138' }, // Different valid ABA (FRB Atlanta)
  });
  assert.strictEqual(res.status, 200);

  const { rows } = await pool.query(
    'SELECT routing_number, account_number FROM payment_profiles WHERE user_id = $1',
    [staffUserId]
  );
  // Account ciphertext untouched (still decrypts to the original plaintext).
  assert.strictEqual(decrypt(rows[0].account_number), '1234567890');
  // The stored ciphertext should be byte-identical to what we wrote (no
  // re-encrypt on the unchanged side).
  assert.strictEqual(rows[0].account_number, origAccount);
  // Routing was changed; decrypts to the new plaintext.
  assert.strictEqual(decrypt(rows[0].routing_number), '011000138');
  assert.notStrictEqual(rows[0].routing_number, origRouting);
});

test('PATCH /api/me/payment-methods > clearing preferred target auto-NULLs preferred_payment_method', async () => {
  await clearPaymentProfile(staffUserId);
  // Seed with venmo as preferred.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, venmo_handle, preferred_payment_method)
     VALUES ($1, 'staffer-vee', 'venmo')`,
    [staffUserId]
  );

  const res = await request('PATCH', '/api/me/payment-methods', {
    token: staffToken,
    body: { venmo_handle: null },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.preferred_cleared, true);
  assert.strictEqual(res.body.preferred_payment_method, null);

  const { rows } = await pool.query(
    'SELECT preferred_payment_method FROM payment_profiles WHERE user_id = $1',
    [staffUserId]
  );
  assert.strictEqual(rows[0].preferred_payment_method, null);
});

test('PATCH /api/me/payment-methods > audit log row written on every mutation', async () => {
  await clearPaymentProfile(staffUserId);
  await request('PATCH', '/api/me/payment-methods', {
    token: staffToken,
    body: { venmo_handle: 'logme' },
  });
  const { rows } = await pool.query(
    "SELECT action, details FROM staff_audit_log WHERE user_id = $1 AND action = 'payment_method_change' ORDER BY id DESC LIMIT 1",
    [staffUserId]
  );
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].details.fields_changed, ['venmo_handle']);
  assert.deepStrictEqual(rows[0].details.cleared, []);
});

test('PATCH /api/me/payment-methods > decrypt-fail on unchanged side: GET returns null, PATCH proceeds', async () => {
  await clearPaymentProfile(staffUserId);
  // Stash a corrupt ciphertext on account_number, valid on routing.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, routing_number, account_number)
     VALUES ($1, $2, 'enc:deadbeef:cafe:01ff') ON CONFLICT (user_id) DO NOTHING`,
    [staffUserId, encrypt('011000015')]
  );

  const getRes = await request('GET', '/api/me/payment-methods', { token: staffToken });
  assert.strictEqual(getRes.status, 200);
  assert.strictEqual(getRes.body.routing_number_last4, '0015');
  // Corrupt one returns null without 500ing.
  assert.strictEqual(getRes.body.account_number_last4, null);

  // PATCH that touches venmo only — should succeed even though account
  // ciphertext is unreadable.
  const patchRes = await request('PATCH', '/api/me/payment-methods', {
    token: staffToken,
    body: { venmo_handle: 'survive' },
  });
  assert.strictEqual(patchRes.status, 200);
});

test('PUT /api/me/preferred-payment-method > rejects when handle missing', async () => {
  await clearPaymentProfile(staffUserId);
  const res = await request('PUT', '/api/me/preferred-payment-method', {
    token: staffToken,
    body: { method: 'venmo' },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors?.venmo_handle);
});

test('PUT /api/me/preferred-payment-method > direct_deposit requires both routing+account', async () => {
  await clearPaymentProfile(staffUserId);
  await pool.query(
    `INSERT INTO payment_profiles (user_id, routing_number) VALUES ($1, $2)`,
    [staffUserId, encrypt('011000015')]
  );
  // Routing only — should reject.
  let res = await request('PUT', '/api/me/preferred-payment-method', {
    token: staffToken,
    body: { method: 'direct_deposit' },
  });
  assert.strictEqual(res.status, 400);

  // Add account, retry — should succeed.
  await pool.query(
    `UPDATE payment_profiles SET account_number = $2 WHERE user_id = $1`,
    [staffUserId, encrypt('1234567890')]
  );
  res = await request('PUT', '/api/me/preferred-payment-method', {
    token: staffToken,
    body: { method: 'direct_deposit' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.preferred_payment_method, 'direct_deposit');

  // Audit row should reflect the from→to.
  const { rows } = await pool.query(
    "SELECT details FROM staff_audit_log WHERE user_id = $1 AND action = 'preferred_payment_method_change' ORDER BY id DESC LIMIT 1",
    [staffUserId]
  );
  assert.strictEqual(rows[0].details.to, 'direct_deposit');
});

// ─── Task 14: tip-card-order, profile, ui-preferences ─────────────────────

test('PUT /api/me/tip-card-order > rejects unknown tokens', async () => {
  const res = await request('PUT', '/api/me/tip-card-order', {
    token: staffToken,
    body: { order: ['venmo', 'bitcoin'] },
  });
  assert.strictEqual(res.status, 400);
});

test('PUT /api/me/tip-card-order > writes to ui_preferences.tip_card_order', async () => {
  const order = ['venmo', 'card', 'zelle'];
  const res = await request('PUT', '/api/me/tip-card-order', { token: staffToken, body: { order } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.tip_card_order, order);

  const { rows } = await pool.query(
    "SELECT ui_preferences->'tip_card_order' AS o FROM users WHERE id = $1",
    [staffUserId]
  );
  assert.deepStrictEqual(rows[0].o, order);
});

test('PATCH /api/me/profile > rejects email key (not in allowlist)', async () => {
  const res = await request('PATCH', '/api/me/profile', {
    token: staffToken,
    body: { email: 'attacker@example.com' },
  });
  assert.strictEqual(res.status, 400);
});

test('PATCH /api/me/profile > writes allowlisted fields to contractor_profiles', async () => {
  const res = await request('PATCH', '/api/me/profile', {
    token: staffToken,
    body: {
      preferred_name: 'Updated Name',
      street_address: '456 New St',
      city: 'Chicago',
      state: 'IL',
      zip_code: '60601-1234',
      emergency_contact_name: 'Jane Doe',
      emergency_contact_phone: '5555550199',
      emergency_contact_relationship: 'sister',
    },
  });
  assert.strictEqual(res.status, 200);

  const { rows } = await pool.query(
    `SELECT preferred_name, street_address, city, state, zip_code,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relationship
       FROM contractor_profiles WHERE user_id = $1`,
    [staffUserId]
  );
  assert.strictEqual(rows[0].preferred_name, 'Updated Name');
  assert.strictEqual(rows[0].zip_code, '60601-1234');
  assert.strictEqual(rows[0].emergency_contact_name, 'Jane Doe');
});

test('PATCH /api/me/profile > rejects invalid zip', async () => {
  const res = await request('PATCH', '/api/me/profile', {
    token: staffToken,
    body: { zip_code: 'abc' },
  });
  assert.strictEqual(res.status, 400);
});

test('PATCH /api/me/profile > phone change writes audit row with last-4-only', async () => {
  await pool.query('DELETE FROM staff_audit_log WHERE user_id = $1', [staffUserId]);
  // Seed phone to a known value.
  await pool.query(
    "UPDATE contractor_profiles SET phone = '5555550101' WHERE user_id = $1",
    [staffUserId]
  );
  const res = await request('PATCH', '/api/me/profile', {
    token: staffToken,
    body: { phone: '5555559876' },
  });
  assert.strictEqual(res.status, 200);

  const { rows } = await pool.query(
    "SELECT details FROM staff_audit_log WHERE user_id = $1 AND action = 'profile_phone_change' ORDER BY id DESC LIMIT 1",
    [staffUserId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].details.old_phone_last4, '0101');
  assert.strictEqual(rows[0].details.new_phone_last4, '9876');
});

test('PATCH /api/me/ui-preferences > theme allowlist + merge', async () => {
  // Seed a sibling key to confirm jsonb_set merges, not clobbers.
  await pool.query(
    `UPDATE users SET ui_preferences = '{"tip_card_order":["card"]}'::jsonb WHERE id = $1`,
    [staffUserId]
  );

  const res = await request('PATCH', '/api/me/ui-preferences', {
    token: staffToken,
    body: { theme: 'dark', calendar_subscribed_app: 'google' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ui_preferences.theme, 'dark');
  assert.strictEqual(res.body.ui_preferences.calendar_subscribed_app, 'google');
  // Sibling key NOT clobbered.
  assert.deepStrictEqual(res.body.ui_preferences.tip_card_order, ['card']);
});

test('PATCH /api/me/ui-preferences > rejects invalid theme', async () => {
  const res = await request('PATCH', '/api/me/ui-preferences', {
    token: staffToken,
    body: { theme: 'neon' },
  });
  assert.strictEqual(res.status, 400);
});

test('PATCH /api/me/ui-preferences > rejects unknown key', async () => {
  const res = await request('PATCH', '/api/me/ui-preferences', {
    token: staffToken,
    body: { dangerous_key: 'x' },
  });
  assert.strictEqual(res.status, 400);
});

// ─── Task 15: staff-notifications + push-subscriptions ───────────────────

async function resetUserNotificationState(uid) {
  await pool.query(
    `UPDATE users
        SET staff_notification_preferences = '{
          "channels": {
            "shift_offered":   ["push","sms","email"],
            "shift_decided":   ["push","sms"],
            "cover_needed":    ["push"],
            "beo_finalized":   ["push","sms","email"],
            "beo_reminder_t3": ["push","sms"],
            "schedule_change": ["push","sms","email"],
            "payday":          ["sms","email"],
            "tip_received":    ["push"]
          },
          "push_subscriptions": [],
          "quiet_hours": null
        }'::jsonb
      WHERE id = $1`,
    [uid]
  );
}

test('GET /api/me/staff-notifications > returns prefs + comms', async () => {
  await resetUserNotificationState(staffUserId);
  const res = await request('GET', '/api/me/staff-notifications', { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.prefs);
  assert.ok('comms' in res.body);
  assert.ok(res.body.prefs.channels);
  assert.ok(Array.isArray(res.body.prefs.channels.beo_finalized));
});

test('PATCH /api/me/staff-notifications > accepts partial channel merge', async () => {
  await resetUserNotificationState(staffUserId);
  const res = await request('PATCH', '/api/me/staff-notifications', {
    token: staffToken,
    body: { channels: { shift_offered: ['email'] } },
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.prefs.channels.shift_offered, ['email']);
  // Sibling categories unchanged.
  assert.deepStrictEqual(res.body.prefs.channels.beo_finalized, ['push', 'sms', 'email']);
});

test('PATCH /api/me/staff-notifications > rejects empty channel array on critical category', async () => {
  await resetUserNotificationState(staffUserId);
  const res = await request('PATCH', '/api/me/staff-notifications', {
    token: staffToken,
    body: { channels: { beo_finalized: [] } },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors?._form);
});

test('PATCH /api/me/staff-notifications > per-category-not-aggregate: muting payday only is OK', async () => {
  await resetUserNotificationState(staffUserId);
  // Aggregate would forbid muting any critical category; per-category permits
  // muting `payday` IF that category retains at least one channel. Here we
  // give payday a single channel and confirm it's accepted.
  const res = await request('PATCH', '/api/me/staff-notifications', {
    token: staffToken,
    body: { channels: { payday: ['email'] } },
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.prefs.channels.payday, ['email']);
});

test('PATCH /api/me/staff-notifications > each critical category rejected independently', async () => {
  for (const cat of ['beo_finalized', 'schedule_change', 'payday']) {
    await resetUserNotificationState(staffUserId);
    const res = await request('PATCH', '/api/me/staff-notifications', {
      token: staffToken,
      body: { channels: { [cat]: [] } },
    });
    assert.strictEqual(res.status, 400, `${cat} muted alone rejects`);
  }
});

test('POST /api/me/push-subscriptions > replaces existing endpoint in place', async () => {
  await resetUserNotificationState(staffUserId);
  const sub = {
    endpoint: 'https://example.com/push/abc',
    keys: { p256dh: 'p1', auth: 'a1' },
    user_agent: 'Mozilla iPhone',
  };
  let res = await request('POST', '/api/me/push-subscriptions', { token: staffToken, body: sub });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.count, 1);

  // Re-POST same endpoint with new keys — count stays 1.
  res = await request('POST', '/api/me/push-subscriptions', {
    token: staffToken,
    body: { ...sub, keys: { p256dh: 'p2', auth: 'a2' } },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.count, 1);

  const { rows } = await pool.query(
    "SELECT staff_notification_preferences->'push_subscriptions' AS subs FROM users WHERE id = $1",
    [staffUserId]
  );
  assert.strictEqual(rows[0].subs.length, 1);
  assert.strictEqual(rows[0].subs[0].keys.p256dh, 'p2');
});

test('POST /api/me/push-subscriptions > evicts oldest at cap=10', async () => {
  await resetUserNotificationState(staffUserId);
  // Pre-load 10 stale subs directly with ascending timestamps.
  const seed = [];
  for (let i = 0; i < 10; i += 1) {
    seed.push({
      endpoint: `https://example.com/push/seed-${i}`,
      keys: { p256dh: `p${i}`, auth: `a${i}` },
      user_agent: 'seed',
      subscribed_at: new Date(2026, 0, 1, 0, i).toISOString(),
    });
  }
  await pool.query(
    `UPDATE users SET staff_notification_preferences = jsonb_set(
       staff_notification_preferences, '{push_subscriptions}', $2::jsonb, true)
      WHERE id = $1`,
    [staffUserId, JSON.stringify(seed)]
  );

  // POST a fresh subscription. Oldest (seed-0) should evict.
  const res = await request('POST', '/api/me/push-subscriptions', {
    token: staffToken,
    body: {
      endpoint: 'https://example.com/push/fresh',
      keys: { p256dh: 'pf', auth: 'af' },
      user_agent: 'iPhone',
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.count, 10);

  const { rows } = await pool.query(
    "SELECT staff_notification_preferences->'push_subscriptions' AS subs FROM users WHERE id = $1",
    [staffUserId]
  );
  const endpoints = rows[0].subs.map((s) => s.endpoint);
  assert.ok(!endpoints.includes('https://example.com/push/seed-0'), 'oldest evicted');
  assert.ok(endpoints.includes('https://example.com/push/fresh'), 'fresh present');
  assert.ok(endpoints.includes('https://example.com/push/seed-9'), 'newest seed survives');
});

test('DELETE /api/me/push-subscriptions > prunes matching endpoint', async () => {
  await resetUserNotificationState(staffUserId);
  await pool.query(
    `UPDATE users SET staff_notification_preferences = jsonb_set(
       staff_notification_preferences, '{push_subscriptions}', $2::jsonb, true)
      WHERE id = $1`,
    [staffUserId, JSON.stringify([
      { endpoint: 'https://example.com/push/keep', keys: { p256dh: 'k', auth: 'k' }, user_agent: '', subscribed_at: new Date().toISOString() },
      { endpoint: 'https://example.com/push/drop', keys: { p256dh: 'd', auth: 'd' }, user_agent: '', subscribed_at: new Date().toISOString() },
    ])]
  );
  const res = await request('DELETE', '/api/me/push-subscriptions', {
    token: staffToken,
    body: { endpoint: 'https://example.com/push/drop' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.removed, 1);
  assert.strictEqual(res.body.count, 1);
});

// ─── Task 16: Documents replace endpoint ──────────────────────────────────
//
// Stubs uploadFile so the test never hits real R2. The stub records its
// arguments so we can assert the R2 key shape.

let uploadFileCalls = [];
let uploadFileThrows = null;

// Activated in a setup-style test below — keep it tidy so other tests are
// unaffected.
function installUploadStub() {
  uploadFileCalls = [];
  uploadFileThrows = null;
  staffPortalRouter.__setDeps({
    uploadFile: async (buffer, key) => {
      uploadFileCalls.push({ buffer, key });
      if (uploadFileThrows) throw uploadFileThrows;
    },
  });
}

// Minimal valid PDF (just the %PDF magic) so isValidUpload passes.
const PDF_BYTES = Buffer.from('%PDF-1.4\n%binary\n');
// 4-byte invalid header so magic-byte check fails.
const NOT_A_PDF = Buffer.from('XXXX', 'utf8');

test('POST /api/me/documents/w9/replace > writes to payment_profiles + history', async () => {
  installUploadStub();
  await pool.query('DELETE FROM staff_document_history WHERE user_id = $1', [staffUserId]);

  const { body: mpBody, contentType } = buildMultipart({
    file: { field: 'file', filename: 'my-w9.pdf', contentType: 'application/pdf', data: PDF_BYTES },
  });
  const res = await request('POST', '/api/me/documents/w9/replace', {
    token: staffToken,
    body: mpBody,
    headers: { 'Content-Type': contentType },
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.file_url.startsWith(`staff/w9/${staffUserId}/`));
  assert.strictEqual(res.body.filename, 'my-w9.pdf');
  assert.strictEqual(uploadFileCalls.length, 1);

  // payment_profiles row updated.
  const pp = await pool.query(
    'SELECT w9_file_url, w9_filename FROM payment_profiles WHERE user_id = $1',
    [staffUserId]
  );
  assert.strictEqual(pp.rows[0].w9_filename, 'my-w9.pdf');
  assert.ok(pp.rows[0].w9_file_url.startsWith('staff/w9/'));

  // history row inserted.
  const hist = await pool.query(
    `SELECT doc_type, replaced_by_user_id FROM staff_document_history
       WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [staffUserId]
  );
  assert.strictEqual(hist.rows[0].doc_type, 'w9');
  assert.strictEqual(hist.rows[0].replaced_by_user_id, staffUserId);
});

test('POST /api/me/documents/alcohol_certification/replace > requires future expires_on', async () => {
  installUploadStub();
  const { body: mpBody, contentType } = buildMultipart({
    fields: { expires_on: '2020-01-01' }, // past
    file: { field: 'file', filename: 'cert.pdf', contentType: 'application/pdf', data: PDF_BYTES },
  });
  const res = await request('POST', '/api/me/documents/alcohol_certification/replace', {
    token: staffToken,
    body: mpBody,
    headers: { 'Content-Type': contentType },
  });
  assert.strictEqual(res.status, 400);
  // No R2 call (validation runs BEFORE upload).
  assert.strictEqual(uploadFileCalls.length, 0);
});

test('POST /api/me/documents/alcohol_certification/replace > writes 3 fields', async () => {
  installUploadStub();
  await pool.query('DELETE FROM staff_document_history WHERE user_id = $1', [staffUserId]);
  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const { body: mpBody, contentType } = buildMultipart({
    fields: { expires_on: future },
    file: { field: 'file', filename: 'basset.png', contentType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]) },
  });
  const res = await request('POST', '/api/me/documents/alcohol_certification/replace', {
    token: staffToken,
    body: mpBody,
    headers: { 'Content-Type': contentType },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.expires_on, future);

  const cp = await pool.query(
    `SELECT alcohol_certification_file_url, alcohol_certification_filename,
            alcohol_certification_expires_on
       FROM contractor_profiles WHERE user_id = $1`,
    [staffUserId]
  );
  assert.strictEqual(cp.rows[0].alcohol_certification_filename, 'basset.png');
  assert.ok(cp.rows[0].alcohol_certification_file_url.startsWith('staff/alcohol_certification/'));
  // pg returns DATE as a Date object; coerce to YYYY-MM-DD for the assertion.
  const dateOut = cp.rows[0].alcohol_certification_expires_on;
  const dateStr = dateOut instanceof Date
    ? `${dateOut.getFullYear()}-${String(dateOut.getMonth() + 1).padStart(2, '0')}-${String(dateOut.getDate()).padStart(2, '0')}`
    : String(dateOut).slice(0, 10);
  assert.strictEqual(dateStr, future);
});

test('POST /api/me/documents/w9/replace > invalid mime rejected, no DB write', async () => {
  installUploadStub();
  await pool.query('DELETE FROM staff_document_history WHERE user_id = $1', [staffUserId]);

  const { body: mpBody, contentType } = buildMultipart({
    file: { field: 'file', filename: 'evil.exe', contentType: 'application/pdf', data: NOT_A_PDF },
  });
  const res = await request('POST', '/api/me/documents/w9/replace', {
    token: staffToken,
    body: mpBody,
    headers: { 'Content-Type': contentType },
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(uploadFileCalls.length, 0);
  // No history row written.
  const hist = await pool.query(
    'SELECT COUNT(*)::int AS n FROM staff_document_history WHERE user_id = $1',
    [staffUserId]
  );
  assert.strictEqual(hist.rows[0].n, 0);
});

test('POST /api/me/documents/w9/replace > path traversal in filename sanitized', async () => {
  installUploadStub();
  const evilName = '../../../etc/passwd.pdf';
  const { body: mpBody, contentType } = buildMultipart({
    file: { field: 'file', filename: evilName, contentType: 'application/pdf', data: PDF_BYTES },
  });
  const res = await request('POST', '/api/me/documents/w9/replace', {
    token: staffToken,
    body: mpBody,
    headers: { 'Content-Type': contentType },
  });
  assert.strictEqual(res.status, 200);
  // Slugified — no slashes, no leading dots.
  assert.ok(!res.body.file_url.includes('..'), `R2 key safe: ${res.body.file_url}`);
  assert.ok(!res.body.filename.includes('/'), 'no slashes in slugified filename');
  assert.ok(!res.body.filename.startsWith('.'), 'no leading dot');
});

test('POST /api/me/documents/w9/replace > R2 failure → 502, no DB changes', async () => {
  installUploadStub();
  const { ExternalServiceError } = require('../utils/errors');
  uploadFileThrows = new ExternalServiceError('r2', new Error('500 from R2'), 'R2 down');

  await pool.query('DELETE FROM staff_document_history WHERE user_id = $1', [staffUserId]);
  const histBefore = await pool.query(
    'SELECT COUNT(*)::int AS n FROM staff_document_history WHERE user_id = $1',
    [staffUserId]
  );

  const { body: mpBody, contentType } = buildMultipart({
    file: { field: 'file', filename: 'doc.pdf', contentType: 'application/pdf', data: PDF_BYTES },
  });
  const res = await request('POST', '/api/me/documents/w9/replace', {
    token: staffToken,
    body: mpBody,
    headers: { 'Content-Type': contentType },
  });
  assert.strictEqual(res.status, 502);

  const histAfter = await pool.query(
    'SELECT COUNT(*)::int AS n FROM staff_document_history WHERE user_id = $1',
    [staffUserId]
  );
  assert.strictEqual(histAfter.rows[0].n, histBefore.rows[0].n);
});

test('POST /api/me/documents/:unknown/replace > rejects unknown doc_type', async () => {
  installUploadStub();
  const { body: mpBody, contentType } = buildMultipart({
    file: { field: 'file', filename: 'x.pdf', contentType: 'application/pdf', data: PDF_BYTES },
  });
  const res = await request('POST', '/api/me/documents/bogus/replace', {
    token: staffToken,
    body: mpBody,
    headers: { 'Content-Type': contentType },
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(uploadFileCalls.length, 0);
});

// ─── Task 17: Email-change request + cancel ───────────────────────────────

// Stub sendEmail so the test never actually triggers Resend. Capture the
// calls so we can verify both the verify email and the warn email fire.
let sendEmailCalls = [];

function installSendEmailStub() {
  sendEmailCalls = [];
  staffPortalRouter.__setDeps({
    sendEmail: async (args) => {
      sendEmailCalls.push(args);
      return { id: 'stub-id' };
    },
  });
}

test('POST /api/me/request-email-change > 400 on invalid format', async () => {
  installSendEmailStub();
  const res = await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: 'not-an-email' },
  });
  assert.strictEqual(res.status, 400);
});

test('POST /api/me/request-email-change > 400 when same as current', async () => {
  installSendEmailStub();
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [staffUserId]);
  const res = await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: rows[0].email },
  });
  assert.strictEqual(res.status, 400);
});

test('POST /api/me/request-email-change > 409 when email already in use', async () => {
  installSendEmailStub();
  // Try to change staff's email to otherStaff's email.
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [otherStaffUserId]);
  const res = await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: rows[0].email },
  });
  assert.strictEqual(res.status, 409);
});

test('POST /api/me/request-email-change > creates pending row + sends 2 emails + audit', async () => {
  installSendEmailStub();
  await pool.query('DELETE FROM pending_email_changes WHERE user_id = $1', [staffUserId]);
  await pool.query("DELETE FROM staff_audit_log WHERE user_id = $1 AND action = 'email_change_requested'", [staffUserId]);

  const newEmail = `staff-portal-test-new-${Date.now()}@example.com`;
  const res = await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: newEmail },
  });
  assert.strictEqual(res.status, 200);

  const { rows } = await pool.query(
    `SELECT new_email, token_hash, expires_at, consumed_at FROM pending_email_changes
       WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [staffUserId]
  );
  assert.strictEqual(rows[0].new_email, newEmail.toLowerCase());
  assert.strictEqual(rows[0].consumed_at, null);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);

  // Two emails: one to NEW address (verify), one to OLD address (warn).
  assert.strictEqual(sendEmailCalls.length, 2);
  const recipients = sendEmailCalls.map((c) => c.to);
  assert.ok(recipients.includes(newEmail.toLowerCase()), 'verify email to new address');

  // Audit row.
  const audit = await pool.query(
    "SELECT details FROM staff_audit_log WHERE user_id = $1 AND action = 'email_change_requested' ORDER BY id DESC LIMIT 1",
    [staffUserId]
  );
  assert.strictEqual(audit.rows[0].details.new_email, newEmail.toLowerCase());
});

test('POST /api/me/request-email-change > supersedes prior pending row', async () => {
  installSendEmailStub();
  await pool.query('DELETE FROM pending_email_changes WHERE user_id = $1', [staffUserId]);

  // First request — creates a pending row.
  const first = `staff-portal-test-first-${Date.now()}@example.com`;
  await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: first },
  });
  // Second request — should mark first as consumed and create a new one.
  const second = `staff-portal-test-second-${Date.now()}@example.com`;
  await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: second },
  });

  const { rows } = await pool.query(
    `SELECT new_email, consumed_at FROM pending_email_changes WHERE user_id = $1 ORDER BY id ASC`,
    [staffUserId]
  );
  assert.strictEqual(rows.length, 2);
  // First was superseded.
  assert.strictEqual(rows[0].new_email, first.toLowerCase());
  assert.ok(rows[0].consumed_at, 'first row consumed_at set');
  // Second still pending.
  assert.strictEqual(rows[1].new_email, second.toLowerCase());
  assert.strictEqual(rows[1].consumed_at, null);
});

test('POST /api/me/request-email-change > race: second different-user request to same email returns 409 already_pending', async () => {
  installSendEmailStub();
  await pool.query('DELETE FROM pending_email_changes WHERE user_id IN ($1, $2)', [staffUserId, otherStaffUserId]);

  const target = `staff-portal-test-race-${Date.now()}@example.com`;
  // staff requests first.
  const r1 = await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: target },
  });
  assert.strictEqual(r1.status, 200);
  // otherStaff tries for the same target — ON CONFLICT triggers the
  // already_pending path.
  const r2 = await request('POST', '/api/me/request-email-change', {
    token: otherStaffToken,
    body: { new_email: target },
  });
  assert.strictEqual(r2.status, 409);
  assert.strictEqual(r2.body.reason, 'already_pending');
});

test('POST /api/me/cancel-pending-email-change > marks pending consumed', async () => {
  installSendEmailStub();
  await pool.query('DELETE FROM pending_email_changes WHERE user_id = $1', [staffUserId]);
  const target = `staff-portal-test-cancel-${Date.now()}@example.com`;
  await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: target },
  });
  const res = await request('POST', '/api/me/cancel-pending-email-change', { token: staffToken });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.cancelled >= 1);

  const { rows } = await pool.query(
    `SELECT consumed_at FROM pending_email_changes WHERE user_id = $1 AND new_email = $2`,
    [staffUserId, target.toLowerCase()]
  );
  assert.ok(rows[0].consumed_at, 'consumed_at populated');
});

test('GET /api/me/staff-home > cover broadcasts surface for teammates only', async () => {
  // Set staff's request to cover_requested. otherStaff should see it; staff
  // (the requester) should NOT (cover_broadcasts filters requester != viewer).
  await pool.query(
    "UPDATE shift_requests SET cover_requested_at = NOW(), cover_reason = 'sick' WHERE shift_id = $1 AND user_id = $2",
    [shiftId, staffUserId]
  );

  const resOther = await request('GET', '/api/me/staff-home', { token: otherStaffToken });
  assert.strictEqual(resOther.status, 200);
  const broadcast = resOther.body.cover_broadcasts.find((b) => b.shift_id === shiftId);
  assert.ok(broadcast, 'other staff sees the cover broadcast');
  assert.strictEqual(broadcast.requester_id, staffUserId);
  assert.strictEqual(broadcast.you_are_on_team, false);

  const resSelf = await request('GET', '/api/me/staff-home', { token: staffToken });
  const selfBroadcast = resSelf.body.cover_broadcasts.find((b) => b.shift_id === shiftId);
  assert.ok(!selfBroadcast, 'requester does not see their own broadcast');

  // Reset.
  await pool.query(
    "UPDATE shift_requests SET cover_requested_at = NULL, cover_reason = NULL WHERE shift_id = $1 AND user_id = $2",
    [shiftId, staffUserId]
  );
});

// ─── Task 20: Auth-gate + IDOR round-out (spec section 11) ────────────────
//
// Auth pass: every /api/me/* endpoint requires a JWT — hit without one and
// the auth middleware returns 401 before the handler ever runs.
//
// IDOR pass: every PATCH / PUT / POST / DELETE on /api/me/* targets the
// caller's own row implicitly (no request param carries a user id). Auth as
// user B, mutate; assert that user A's row is untouched. The endpoints
// don't accept a target-user param, so the test reduces to "JWT decides the
// subject, never the body" — the harness verifies this by reading A's row
// state before + after and asserting strict equality.

const AUTH_ENDPOINTS = [
  { method: 'GET',    path: '/api/me/payment-methods' },
  { method: 'PATCH',  path: '/api/me/payment-methods' },
  { method: 'PUT',    path: '/api/me/preferred-payment-method' },
  { method: 'PUT',    path: '/api/me/tip-card-order' },
  { method: 'PATCH',  path: '/api/me/profile' },
  { method: 'PATCH',  path: '/api/me/ui-preferences' },
  { method: 'GET',    path: '/api/me/staff-notifications' },
  { method: 'PATCH',  path: '/api/me/staff-notifications' },
  { method: 'POST',   path: '/api/me/push-subscriptions' },
  { method: 'DELETE', path: '/api/me/push-subscriptions' },
  { method: 'POST',   path: '/api/me/documents/w9/replace' },
  { method: 'POST',   path: '/api/me/request-email-change' },
  { method: 'POST',   path: '/api/me/cancel-pending-email-change' },
];

for (const ep of AUTH_ENDPOINTS) {
  test(`AUTH-GATE > ${ep.method} ${ep.path} returns 401 without JWT`, async () => {
    const res = await request(ep.method, ep.path, { body: {} });
    assert.strictEqual(res.status, 401, `expected 401, got ${res.status} (${res.raw?.slice(0, 80)})`);
  });
}

test('IDOR > PATCH /api/me/profile by B does not touch A row', async () => {
  // Snapshot A's contractor_profiles state.
  const beforeA = await pool.query(
    `SELECT preferred_name, street_address, city, state, zip_code,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
            phone
       FROM contractor_profiles WHERE user_id = $1`,
    [staffUserId]
  );
  // Auth as B, mutate via PATCH. The body has no user id, so the JWT must
  // be the only subject signal.
  const res = await request('PATCH', '/api/me/profile', {
    token: otherStaffToken,
    body: { preferred_name: 'B-IDOR-Attempt', city: 'Springfield' },
  });
  assert.strictEqual(res.status, 200);

  // A is unchanged.
  const afterA = await pool.query(
    `SELECT preferred_name, street_address, city, state, zip_code,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
            phone
       FROM contractor_profiles WHERE user_id = $1`,
    [staffUserId]
  );
  assert.deepStrictEqual(afterA.rows[0], beforeA.rows[0], 'A profile untouched by B PATCH');

  // B's row carries the write.
  const afterB = await pool.query(
    'SELECT preferred_name, city FROM contractor_profiles WHERE user_id = $1',
    [otherStaffUserId]
  );
  assert.strictEqual(afterB.rows[0].preferred_name, 'B-IDOR-Attempt');
  assert.strictEqual(afterB.rows[0].city, 'Springfield');
});

test('IDOR > PATCH /api/me/payment-methods by B does not touch A row', async () => {
  await pool.query("DELETE FROM payment_profiles WHERE user_id = $1", [otherStaffUserId]);
  // Seed A with a known venmo handle.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, venmo_handle)
     VALUES ($1, 'A-protected-handle')
     ON CONFLICT (user_id) DO UPDATE SET venmo_handle = 'A-protected-handle'`,
    [staffUserId]
  );

  // B authenticates and PATCHes — the write must land on B's row, not A's.
  const res = await request('PATCH', '/api/me/payment-methods', {
    token: otherStaffToken,
    body: { venmo_handle: 'B-IDOR-target' },
  });
  assert.strictEqual(res.status, 200);

  // A's handle unchanged.
  const a = await pool.query('SELECT venmo_handle FROM payment_profiles WHERE user_id = $1', [staffUserId]);
  assert.strictEqual(a.rows[0].venmo_handle, 'A-protected-handle');

  // B's handle reflects the write.
  const b = await pool.query('SELECT venmo_handle FROM payment_profiles WHERE user_id = $1', [otherStaffUserId]);
  assert.strictEqual(b.rows[0].venmo_handle, 'B-IDOR-target');
});

test('IDOR > PUT /api/me/tip-card-order by B does not touch A ui_preferences', async () => {
  // Seed A with a known order.
  await pool.query(
    `UPDATE users SET ui_preferences = '{"tip_card_order":["card","venmo"]}'::jsonb WHERE id = $1`,
    [staffUserId]
  );
  const res = await request('PUT', '/api/me/tip-card-order', {
    token: otherStaffToken,
    body: { order: ['zelle', 'card'] },
  });
  assert.strictEqual(res.status, 200);

  // A's order unchanged.
  const a = await pool.query(
    "SELECT ui_preferences->'tip_card_order' AS o FROM users WHERE id = $1",
    [staffUserId]
  );
  assert.deepStrictEqual(a.rows[0].o, ['card', 'venmo']);

  // B's order reflects the write.
  const b = await pool.query(
    "SELECT ui_preferences->'tip_card_order' AS o FROM users WHERE id = $1",
    [otherStaffUserId]
  );
  assert.deepStrictEqual(b.rows[0].o, ['zelle', 'card']);
});

test('IDOR > PATCH /api/me/ui-preferences by B does not touch A row', async () => {
  await pool.query(
    `UPDATE users SET ui_preferences = '{"theme":"light"}'::jsonb WHERE id = $1`,
    [staffUserId]
  );
  const res = await request('PATCH', '/api/me/ui-preferences', {
    token: otherStaffToken,
    body: { theme: 'dark' },
  });
  assert.strictEqual(res.status, 200);

  const a = await pool.query(
    "SELECT ui_preferences->'theme' AS t FROM users WHERE id = $1",
    [staffUserId]
  );
  assert.strictEqual(a.rows[0].t, 'light', 'A theme unchanged');

  const b = await pool.query(
    "SELECT ui_preferences->'theme' AS t FROM users WHERE id = $1",
    [otherStaffUserId]
  );
  assert.strictEqual(b.rows[0].t, 'dark', 'B theme updated');
});

test('IDOR > PATCH /api/me/staff-notifications by B does not touch A row', async () => {
  await resetUserNotificationState(staffUserId);
  await resetUserNotificationState(otherStaffUserId);
  const before = await pool.query(
    "SELECT staff_notification_preferences->'channels'->'shift_offered' AS so FROM users WHERE id = $1",
    [staffUserId]
  );

  const res = await request('PATCH', '/api/me/staff-notifications', {
    token: otherStaffToken,
    body: { channels: { shift_offered: ['email'] } },
  });
  assert.strictEqual(res.status, 200);

  const afterA = await pool.query(
    "SELECT staff_notification_preferences->'channels'->'shift_offered' AS so FROM users WHERE id = $1",
    [staffUserId]
  );
  assert.deepStrictEqual(afterA.rows[0].so, before.rows[0].so, 'A shift_offered unchanged');

  const afterB = await pool.query(
    "SELECT staff_notification_preferences->'channels'->'shift_offered' AS so FROM users WHERE id = $1",
    [otherStaffUserId]
  );
  assert.deepStrictEqual(afterB.rows[0].so, ['email'], 'B shift_offered updated');
});

test('IDOR > POST /api/me/push-subscriptions by B does not touch A row', async () => {
  await resetUserNotificationState(staffUserId);
  await resetUserNotificationState(otherStaffUserId);
  // A starts with no subs after reset.
  const sub = {
    endpoint: 'https://example.com/push/idor-b-only',
    keys: { p256dh: 'p', auth: 'a' },
    user_agent: 'B-device',
  };
  const res = await request('POST', '/api/me/push-subscriptions', {
    token: otherStaffToken,
    body: sub,
  });
  assert.strictEqual(res.status, 200);

  const a = await pool.query(
    "SELECT staff_notification_preferences->'push_subscriptions' AS subs FROM users WHERE id = $1",
    [staffUserId]
  );
  assert.deepStrictEqual(a.rows[0].subs, [], 'A has no push_subscriptions');

  const b = await pool.query(
    "SELECT staff_notification_preferences->'push_subscriptions' AS subs FROM users WHERE id = $1",
    [otherStaffUserId]
  );
  assert.strictEqual(b.rows[0].subs.length, 1);
  assert.strictEqual(b.rows[0].subs[0].endpoint, 'https://example.com/push/idor-b-only');
});

test('IDOR > POST /api/me/cancel-pending-email-change by B does not consume A pending row', async () => {
  installSendEmailStub();
  await pool.query('DELETE FROM pending_email_changes WHERE user_id IN ($1, $2)', [staffUserId, otherStaffUserId]);
  // A creates a pending row.
  const aTarget = `staff-portal-test-idor-cancel-a-${Date.now()}@example.com`;
  await request('POST', '/api/me/request-email-change', {
    token: staffToken,
    body: { new_email: aTarget },
  });

  // B cancels — A's pending row must remain unconsumed.
  const res = await request('POST', '/api/me/cancel-pending-email-change', { token: otherStaffToken });
  assert.strictEqual(res.status, 200);

  const a = await pool.query(
    "SELECT consumed_at FROM pending_email_changes WHERE user_id = $1 AND new_email = $2",
    [staffUserId, aTarget.toLowerCase()]
  );
  assert.strictEqual(a.rows[0].consumed_at, null, 'A pending row NOT consumed by B cancel');
});

test('IDOR > PUT /api/me/preferred-payment-method by B does not touch A row', async () => {
  // Seed A with venmo handle + preferred=venmo.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, venmo_handle, preferred_payment_method)
     VALUES ($1, 'A-vee', 'venmo')
     ON CONFLICT (user_id) DO UPDATE SET venmo_handle = 'A-vee', preferred_payment_method = 'venmo'`,
    [staffUserId]
  );
  // Seed B with their own venmo handle so the eligibility check passes.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, venmo_handle)
     VALUES ($1, 'B-vee')
     ON CONFLICT (user_id) DO UPDATE SET venmo_handle = 'B-vee', preferred_payment_method = NULL`,
    [otherStaffUserId]
  );

  // B sets their preferred to check. A's preferred MUST stay venmo.
  const res = await request('PUT', '/api/me/preferred-payment-method', {
    token: otherStaffToken,
    body: { method: 'check' },
  });
  assert.strictEqual(res.status, 200);

  const a = await pool.query(
    "SELECT preferred_payment_method FROM payment_profiles WHERE user_id = $1",
    [staffUserId]
  );
  assert.strictEqual(a.rows[0].preferred_payment_method, 'venmo', 'A preferred unchanged');

  const b = await pool.query(
    "SELECT preferred_payment_method FROM payment_profiles WHERE user_id = $1",
    [otherStaffUserId]
  );
  assert.strictEqual(b.rows[0].preferred_payment_method, 'check', 'B preferred updated');
});
