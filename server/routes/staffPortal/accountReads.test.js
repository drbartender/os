require('dotenv').config();

// Match staffPortal.test.js / payouts.test.js — set NODE_ENV before requiring
// the router so any rate-limiter / dev-only branches see a stable env value.
process.env.NODE_ENV = 'test';

// Route-level tests for server/routes/staffPortal/accountReads.js — the three
// staffer-facing READ endpoints exposed under /api/me/profile,
// /api/me/calendar-settings, /api/me/documents.
//
// HARNESS
// -------
// Mirrors server/routes/staffPortal/payouts.test.js (no supertest in the repo;
// stand up a minimal express app, mount the real router, drive it via
// node:http). Fixtures use an 'acctq-' email prefix so a crashed earlier run
// self-heals on the next setup.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const staffPortalRouter = require('../staffPortal');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

let server;
let baseUrl;
// User A — fully populated staffer (profile, agreement, payment_profile, docs).
let userA, tokenA, emailA;
// User B — new hire, no child rows (empty-case coverage).
let userB, tokenB, emailB;
// User C — has application but NO agreement (legal_name falls back to
// applications.full_name).
let userC, tokenC, emailC;

// Pending-email-change fixture for the banner test.
const PENDING_NEW_EMAIL = `acctq-newaddr-${NONCE}@example.com`;
let pendingEmailRowId;

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, { token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    req.end();
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────
before(async () => {
  // Defensive pre-clean: anything from a prior crashed run that matches our
  // email prefix. Children before parents.
  const fixtureFilter = `email LIKE 'acctq-%@example.com'`;
  await pool.query(`DELETE FROM pending_email_changes WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM agreements           WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM applications         WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM payment_profiles     WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM contractor_profiles  WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM users WHERE ${fixtureFilter}`);

  const pwHash = await bcrypt.hash('x', 4);

  // User A — fully populated staffer.
  emailA = `acctq-a-${NONCE}@example.com`;
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [emailA, pwHash]
  );
  userA = a.rows[0].id;
  tokenA = jwt.sign(
    { userId: userA, tokenVersion: a.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  // Profile row with every column the endpoint projects. The R2-key columns
  // (alcohol_certification_file_url, agreements.pdf_storage_key,
  // payment_profiles.w9_file_url) deliberately contain a 'staff/<type>/'
  // prefix so the PII guard assertion later — "raw R2 keys MUST NOT be
  // projected" — has something concrete to look for in the JSON response.
  await pool.query(
    `INSERT INTO contractor_profiles
       (user_id, preferred_name, phone, street_address, city, state, zip_code,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
        alcohol_certification_file_url, alcohol_certification_filename,
        alcohol_certification_expires_on, hourly_rate)
     VALUES ($1, 'Dan', '5125550100', '123 Main St', 'Austin', 'TX', '78701',
             'Jane Doe', '5125550199', 'spouse',
             'staff/alcohol_certification/fixture/abc.pdf', 'tabc.pdf',
             '2027-01-15', 25.00)`,
    [userA]
  );
  // Signed agreement → legal_name source for User A.
  await pool.query(
    `INSERT INTO agreements (user_id, full_name, email, phone, signed_at, pdf_storage_key)
     VALUES ($1, 'Daniel A. Bartender', $2, '5125550100', NOW(),
             'staff/agreement/fixture/agreement.pdf')`,
    [userA, emailA]
  );
  // payment_profile with w9.
  await pool.query(
    `INSERT INTO payment_profiles (user_id, w9_file_url, w9_filename)
     VALUES ($1, 'staff/w9/fixture/w9.pdf', 'dan-w9.pdf')`,
    [userA]
  );
  // Pending-email-change row (non-consumed, not yet expired).
  const pe = await pool.query(
    `INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '23 hours') RETURNING id`,
    [userA, PENDING_NEW_EMAIL, crypto.randomBytes(32).toString('hex')]
  );
  pendingEmailRowId = pe.rows[0].id;

  // User B — brand-new hire. ONLY a users row. No contractor_profile, no
  // agreement, no application, no payment_profile. Exercises the new-hire
  // path: every projected field must collapse to null / present:false, no 500.
  emailB = `acctq-b-${NONCE}@example.com`;
  // 'applied' is an allowed value in users_onboarding_status_check (the
  // brand-new-applicant state, before agreement / payment_profile exist).
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'applied', 0) RETURNING id, token_version`,
    [emailB, pwHash]
  );
  userB = b.rows[0].id;
  tokenB = jwt.sign(
    { userId: userB, tokenVersion: b.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // User C — has application (not agreement) → legal_name falls back to
  // applications.full_name per the COALESCE in the SELECT.
  emailC = `acctq-c-${NONCE}@example.com`;
  const c = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'staff', 'approved', 0) RETURNING id, token_version`,
    [emailC, pwHash]
  );
  userC = c.rows[0].id;
  tokenC = jwt.sign(
    { userId: userC, tokenVersion: c.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  await pool.query(
    `INSERT INTO applications (user_id, full_name, phone, city, state,
                                travel_distance, reliable_transportation,
                                positions_interested, why_dr_bartender)
     VALUES ($1, 'Casey Application-Only', '5125550101', 'Austin', 'TX',
             '0-25', 'yes', 'bartender', 'because')`,
    [userC]
  );

  // Minimal app — real router + AppError-aware error middleware (mirrors
  // server/index.js).
  const app = express();
  app.use(express.json({ limit: '1mb' }));
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
  await pool.query('DELETE FROM pending_email_changes WHERE user_id IN ($1, $2, $3)', [userA, userB, userC]);
  await pool.query('DELETE FROM agreements           WHERE user_id IN ($1, $2, $3)', [userA, userB, userC]);
  await pool.query('DELETE FROM applications         WHERE user_id IN ($1, $2, $3)', [userA, userB, userC]);
  await pool.query('DELETE FROM payment_profiles     WHERE user_id IN ($1, $2, $3)', [userA, userB, userC]);
  await pool.query('DELETE FROM contractor_profiles  WHERE user_id IN ($1, $2, $3)', [userA, userB, userC]);
  await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [userA, userB, userC]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── /profile tests ─────────────────────────────────────────────────────────

test('GET /api/me/profile > 401 without JWT', async () => {
  const res = await request('GET', '/api/me/profile');
  assert.strictEqual(res.status, 401);
});

test('GET /api/me/profile > populated staffer: returns seeded fields + agreement legal_name + pending-email row', async () => {
  const res = await request('GET', '/api/me/profile', { token: tokenA });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.email, emailA);
  assert.strictEqual(res.body.preferred_name, 'Dan');
  // legal_name MUST come from the agreement (the signed legal doc), not the
  // application — that's the canonical legal name source.
  assert.strictEqual(res.body.legal_name, 'Daniel A. Bartender');
  assert.strictEqual(res.body.phone, '5125550100');
  assert.strictEqual(res.body.street_address, '123 Main St');
  assert.strictEqual(res.body.city, 'Austin');
  assert.strictEqual(res.body.state, 'TX');
  assert.strictEqual(res.body.zip_code, '78701');
  assert.strictEqual(res.body.emergency_contact_name, 'Jane Doe');
  assert.strictEqual(res.body.emergency_contact_phone, '5125550199');
  assert.strictEqual(res.body.emergency_contact_relationship, 'spouse');
  // Pending-email banner: the row we seeded.
  assert.ok(res.body.pending_email_change, 'pending_email_change is non-null');
  assert.strictEqual(res.body.pending_email_change.new_email, PENDING_NEW_EMAIL);
  assert.ok(res.body.pending_email_change.expires_at, 'expires_at is present');
});

test('GET /api/me/profile > new hire (no child rows): every nullable collapses to null, no 500', async () => {
  const res = await request('GET', '/api/me/profile', { token: tokenB });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.email, emailB); // users row always present
  assert.strictEqual(res.body.preferred_name, null);
  assert.strictEqual(res.body.legal_name, null);
  assert.strictEqual(res.body.phone, null);
  assert.strictEqual(res.body.street_address, null);
  assert.strictEqual(res.body.city, null);
  assert.strictEqual(res.body.state, null);
  assert.strictEqual(res.body.zip_code, null);
  assert.strictEqual(res.body.emergency_contact_name, null);
  assert.strictEqual(res.body.emergency_contact_phone, null);
  assert.strictEqual(res.body.emergency_contact_relationship, null);
  assert.strictEqual(res.body.pending_email_change, null);
});

test('GET /api/me/profile > application-only staffer falls back to applications.full_name for legal_name', async () => {
  const res = await request('GET', '/api/me/profile', { token: tokenC });
  assert.strictEqual(res.status, 200);
  // No agreement → COALESCE picks applications.full_name.
  assert.strictEqual(res.body.legal_name, 'Casey Application-Only');
});

test('GET /api/me/profile > consumed/expired pending-email rows do NOT surface', async () => {
  // Consume the existing pending row, verify pending_email_change goes null.
  await pool.query(
    'UPDATE pending_email_changes SET consumed_at = NOW() WHERE id = $1',
    [pendingEmailRowId]
  );
  const res = await request('GET', '/api/me/profile', { token: tokenA });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.pending_email_change, null);
  // Restore for any later test that depends on the populated-staffer fixture.
  await pool.query(
    'UPDATE pending_email_changes SET consumed_at = NULL WHERE id = $1',
    [pendingEmailRowId]
  );
});

// ─── /calendar-settings tests ───────────────────────────────────────────────

test('GET /api/me/calendar-settings > 401 without JWT', async () => {
  const res = await request('GET', '/api/me/calendar-settings');
  assert.strictEqual(res.status, 401);
});

test('GET /api/me/calendar-settings > fresh user: token + token_created_at present, last_ics_fetch_at null, subscribed_app null', async () => {
  const res = await request('GET', '/api/me/calendar-settings', { token: tokenB });
  assert.strictEqual(res.status, 200);
  // calendar_token is generated by the schema DEFAULT on users insert, so a
  // fresh user already has one.
  assert.ok(res.body.calendar_token, 'calendar_token is present');
  assert.match(
    res.body.calendar_token,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'calendar_token is a UUID'
  );
  assert.ok(res.body.calendar_token_created_at, 'calendar_token_created_at present');
  // Fresh user has never had a feed fetch + has not picked an app.
  assert.strictEqual(res.body.last_ics_fetch_at, null);
  assert.strictEqual(res.body.calendar_subscribed_app, null);
  // feed_url is composed server-side using the same apiBase pattern as
  // calendar.js, so the client + server agree on the path.
  assert.ok(res.body.feed_url, 'feed_url is present');
  assert.ok(
    res.body.feed_url.endsWith(`/api/calendar/feed/${res.body.calendar_token}`),
    'feed_url ends with /api/calendar/feed/<token>'
  );
});

test('GET /api/me/calendar-settings > reflects last_ics_fetch_at + ui_preferences.calendar_subscribed_app after they\'re set', async () => {
  // Simulate what calendar.js does after a successful feed fetch.
  await pool.query(
    `UPDATE users
        SET last_ics_fetch_at = NOW(),
            ui_preferences = jsonb_set(
              COALESCE(ui_preferences, '{}'::jsonb),
              '{calendar_subscribed_app}',
              '"google_calendar"'::jsonb,
              true
            )
      WHERE id = $1`,
    [userA]
  );
  const res = await request('GET', '/api/me/calendar-settings', { token: tokenA });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.last_ics_fetch_at, 'last_ics_fetch_at is populated');
  assert.strictEqual(res.body.calendar_subscribed_app, 'google_calendar');
});

// ─── /documents tests ───────────────────────────────────────────────────────

test('GET /api/me/documents > 401 without JWT', async () => {
  const res = await request('GET', '/api/me/documents');
  assert.strictEqual(res.status, 401);
});

test('GET /api/me/documents > new hire: all three docs return present:false with null filename/expires_on', async () => {
  const res = await request('GET', '/api/me/documents', { token: tokenB });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, {
    w9: { present: false, filename: null },
    agreement: { present: false },
    alcohol_certification: {
      present: false,
      filename: null,
      expires_on: null,
    },
  });
});

test('GET /api/me/documents > seeded staffer: present:true + filename + cert expires_on, NO raw R2 keys', async () => {
  const res = await request('GET', '/api/me/documents', { token: tokenA });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.w9.present, true);
  assert.strictEqual(res.body.w9.filename, 'dan-w9.pdf');
  assert.strictEqual(res.body.agreement.present, true);
  assert.strictEqual(res.body.alcohol_certification.present, true);
  assert.strictEqual(res.body.alcohol_certification.filename, 'tabc.pdf');
  // The cert expires_on is a DATE column. pg returns it as a JS Date which
  // JSON-serializes to an ISO string starting with the YYYY-MM-DD we seeded.
  assert.ok(
    String(res.body.alcohol_certification.expires_on).startsWith('2027-01-15'),
    `cert expires_on starts with 2027-01-15 (got ${res.body.alcohol_certification.expires_on})`
  );
  // PII guard: raw R2 keys/URLs MUST NOT be projected. Anything containing
  // 'staff/' or a storage prefix would be a leak.
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('staff/w9/'),                'w9 storage key not projected');
  assert.ok(!raw.includes('staff/agreement/'),         'agreement storage key not projected');
  assert.ok(!raw.includes('staff/alcohol_certification/'), 'cert storage key not projected');
  // Field-name guard too — clients should not get `file_url` / `pdf_storage_key`.
  assert.ok(!('file_url' in res.body.w9),                'w9.file_url not exposed');
  assert.ok(!('file_url' in res.body.alcohol_certification), 'cert.file_url not exposed');
  assert.ok(!('pdf_storage_key' in res.body.agreement),  'agreement.pdf_storage_key not exposed');
});
