require('dotenv').config();

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
  assert.strictEqual(res.body.open_shifts_teaser.length, 0);
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
