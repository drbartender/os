require('dotenv').config();

// Stable env value for any rate-limiter / dev-only branches in the router.
process.env.NODE_ENV = 'test';

// Route-level tests for server/routes/publicTip.js — the public, token-gated
// GET endpoint that drives the customer tip page.
//
// HARNESS
// -------
// Mirrors server/routes/staffPortal/payouts.test.js: minimal express app,
// real router mounted, http.request to drive it. Fixture prefix is 'ptip-'
// so a crashed earlier run self-heals on the next setup. publicTip's GET is
// auth-less so the helper doesn't need to attach a JWT.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

// The feedback POST fires a best-effort admin notification. publicTip.js
// DESTRUCTURES sendEmail at module load, so the stub has to be installed
// BEFORE that require (patching afterwards never reaches the captured
// reference). Capturing the message also frees the assertion from the
// SEND_NOTIFICATIONS gate, and guarantees the suite can never fire a real
// send at the admin inbox from a dev box.
const emailModule = require('../utils/email');
const realSendEmail = emailModule.sendEmail;
const sentEmails = [];
emailModule.sendEmail = async (msg) => { sentEmails.push(msg); return { id: 'stub-tip-feedback' }; };
const publicTipRouter = require('./publicTip');
emailModule.sendEmail = realSendEmail;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Three users:
//   A — full kit (card link, venmo, cashapp, paypal, zelle) + saved order
//   B — zelle handle deliberately invalid (cleanup test)
//   C — partial kit + tip_card_order containing a method NOT on profile
let userIdA, userIdB, userIdC;
let tipTokenA, tipTokenB, tipTokenC;
let tipTokenDeactivated;
let server;
let baseUrl;

// ─── HTTP helper ────────────────────────────────────────────────────────────
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({
            status: res.statusCode,
            body: json,
            raw: data,
            headers: res.headers,
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Setup: seed users + payment_profiles + ui_preferences ─────────────────
before(async () => {
  const fixtureFilter = `email LIKE 'ptip-%@example.com'`;
  // tip_page_feedback.target_user_id is ON DELETE RESTRICT, so the feedback the
  // POST test writes has to go first or the users DELETE below fails and every
  // fixture leaks into the shared dev DB.
  await pool.query(`DELETE FROM tip_page_feedback WHERE target_user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM payment_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM users WHERE ${fixtureFilter}`);

  // User A — full payment kit, saved order: venmo first, then card, then zelle.
  // PayPal and CashApp are on the profile but NOT in the saved order → must
  // fall to the natural-order end.
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, ui_preferences)
     VALUES ($1, 'x', 'staff', 'approved', 0, $2::jsonb)
     RETURNING id`,
    [
      `ptip-a-${NONCE}@example.com`,
      JSON.stringify({ tip_card_order: ['venmo', 'card', 'zelle'] }),
    ]
  );
  userIdA = a.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
     VALUES ($1, 'Anna A', 'bartender', 25.00)`,
    [userIdA]
  );
  tipTokenA = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payment_profiles
       (user_id, venmo_handle, cashapp_handle, paypal_url, zelle_handle,
        stripe_payment_link_url, tip_page_token, tip_page_active)
     VALUES ($1, 'anna-vm', 'anna_ca', 'https://paypal.me/anna', 'anna@example.com',
             'https://buy.stripe.com/test_anna', $2::uuid, TRUE)`,
    [userIdA, tipTokenA]
  );

  // User B — zelle_handle deliberately invalid (neither phone nor email). The
  // route's read-side normalizer must drop it; methods must not include zelle.
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0)
     RETURNING id`,
    [`ptip-b-${NONCE}@example.com`]
  );
  userIdB = b.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
     VALUES ($1, 'Beth B', 'bartender', 25.00)`,
    [userIdB]
  );
  tipTokenB = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payment_profiles
       (user_id, venmo_handle, zelle_handle, tip_page_token, tip_page_active)
     VALUES ($1, 'beth-vm', 'not-a-phone-or-email', $2::uuid, TRUE)`,
    [userIdB, tipTokenB]
  );

  // User C — partial kit (only venmo on profile) but tip_card_order lists
  // venmo, cashapp, zelle. cashapp and zelle are NOT on the profile and must
  // be SKIPPED in the final methods array.
  const c = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version, ui_preferences)
     VALUES ($1, 'x', 'staff', 'approved', 0, $2::jsonb)
     RETURNING id`,
    [
      `ptip-c-${NONCE}@example.com`,
      JSON.stringify({ tip_card_order: ['venmo', 'cashapp', 'zelle'] }),
    ]
  );
  userIdC = c.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
     VALUES ($1, 'Cass C', 'bartender', 25.00)`,
    [userIdC]
  );
  tipTokenC = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payment_profiles
       (user_id, venmo_handle, tip_page_token, tip_page_active)
     VALUES ($1, 'cass-vm', $2::uuid, TRUE)`,
    [userIdC, tipTokenC]
  );

  // Deactivated row attached to user A's seeded payment_profiles is impossible
  // because user_id is UNIQUE. Seed a separate user just to host a deactivated
  // tip_page_token (verifying the 404-enumeration-prevention path).
  const d = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0)
     RETURNING id`,
    [`ptip-d-${NONCE}@example.com`]
  );
  const userIdD = d.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, position, hourly_rate)
     VALUES ($1, 'Dee D', 'bartender', 25.00)`,
    [userIdD]
  );
  tipTokenDeactivated = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payment_profiles (user_id, venmo_handle, tip_page_token, tip_page_active)
     VALUES ($1, 'dee-vm', $2::uuid, FALSE)`,
    [userIdD, tipTokenDeactivated]
  );

  // Minimal express harness mirroring server/index.js's mount + error mw.
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/public/tip', publicTipRouter);
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
  const fixtureFilter = `email LIKE 'ptip-%@example.com'`;
  // tip_page_feedback.target_user_id is ON DELETE RESTRICT, so the feedback the
  // POST test writes has to go first or the users DELETE below fails and every
  // fixture leaks into the shared dev DB.
  await pool.query(`DELETE FROM tip_page_feedback WHERE target_user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM payment_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${fixtureFilter})`);
  await pool.query(`DELETE FROM users WHERE ${fixtureFilter}`);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

// Exact PII allowlist. The test fails if any unexpected column leaks (e.g.
// payment_username, routing_number, account_number, preferred_payment_method,
// tip_page_token, user_id, raw ui_preferences blob). MUST be kept in sync with
// the route's res.json() shape.
const ALLOWED_RESPONSE_KEYS = [
  'cashapp_handle',
  'display_name',
  'headshot_url',
  'methods',
  'paypal_url',
  'stripe_payment_link_url',
  'url',
  'venmo_handle',
  'zelle_handle',
].sort();

// The ?view=sign projection (spec 2026-08-10) feeds display mode, which runs
// on a tablet left unattended on a bar. It must carry NO payment handle: the
// zelle handle in particular normalizes to a personal phone number or email.
const SIGN_VIEW_KEYS = ['display_name', 'methods', 'url'].sort();

test('GET /api/public/tip/:token > unknown token returns 404', async () => {
  const res = await request('GET', `/api/public/tip/${crypto.randomUUID()}`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, 'NOT_FOUND');
});

test('GET /api/public/tip/:token > deactivated token returns 404 (same enumeration-prevention shape)', async () => {
  const res = await request('GET', `/api/public/tip/${tipTokenDeactivated}`);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.code, 'NOT_FOUND');
  assert.match(res.body.error, /not found/i);
});

test('GET /api/public/tip/:token > non-UUID shape returns 404', async () => {
  const res = await request('GET', '/api/public/tip/not-a-uuid');
  assert.strictEqual(res.status, 404);
});

test('GET /api/public/tip/:token > sets Cache-Control: private, no-cache', async () => {
  const res = await request('GET', `/api/public/tip/${tipTokenA}`);
  assert.strictEqual(res.status, 200);
  // express's res.set lower-cases header names on the wire.
  assert.strictEqual(res.headers['cache-control'], 'private, no-cache');
});

test('GET /api/public/tip/:token > PII guard: response keys are exactly the allowed set', async () => {
  const res = await request('GET', `/api/public/tip/${tipTokenA}`);
  assert.strictEqual(res.status, 200);
  const actual = Object.keys(res.body).sort();
  assert.deepStrictEqual(actual, ALLOWED_RESPONSE_KEYS);
});

test('GET /api/public/tip/:token > url is the canonical PUBLIC_SITE_URL form, not a request-derived origin', async () => {
  const res = await request('GET', `/api/public/tip/${tipTokenA}`);
  assert.strictEqual(res.status, 200);
  const { PUBLIC_SITE_URL } = require('../utils/urls');
  assert.strictEqual(res.body.url, `${PUBLIC_SITE_URL}/tip/${tipTokenA}`);
});

test('GET /api/public/tip/:token?view=sign > returns exactly display_name, url, methods', async () => {
  const res = await request('GET', `/api/public/tip/${tipTokenA}?view=sign`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(res.body).sort(), SIGN_VIEW_KEYS);
});

test('GET /api/public/tip/:token?view=sign > leaks no payment handle', async () => {
  const res = await request('GET', `/api/public/tip/${tipTokenA}?view=sign`);
  assert.strictEqual(res.status, 200);
  for (const leaky of [
    'zelle_handle', 'venmo_handle', 'cashapp_handle',
    'paypal_url', 'stripe_payment_link_url', 'headshot_url',
  ]) {
    assert.ok(!(leaky in res.body), `${leaky} must not appear in the sign projection`);
  }
});

test('GET /api/public/tip/:token > the sign projection fails CLOSED on odd view shapes', async () => {
  // Express hands `view` back as a string, an array, or an object, and does
  // not normalize case or whitespace. Each of these used to fall through to
  // the full handle-bearing payload, which is the opposite of what the
  // projection is for. Anything unambiguously "sign" gets the safe response.
  for (const qs of ['view=SIGN', 'view=Sign', 'view=sign%20', 'view=sign&view=sign', 'view[]=sign']) {
    const res = await request('GET', `/api/public/tip/${tipTokenA}?${qs}`);
    assert.equal(res.status, 200, `${qs} should still 200`);
    assert.deepEqual(
      Object.keys(res.body).sort(), SIGN_VIEW_KEYS,
      `${qs} must get the sign projection, not the full payload`
    );
  }
});

test('GET /api/public/tip/:token > an unrelated view value still gets the full chooser payload', async () => {
  // A stray/tracking query param must never 400 the QR-scan money path.
  const res = await request('GET', `/api/public/tip/${tipTokenA}?view=whatever`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ALLOWED_RESPONSE_KEYS);
});

test('GET /api/public/tip/:token?view=sign > methods match the full response exactly', async () => {
  const full = await request('GET', `/api/public/tip/${tipTokenA}`);
  const sign = await request('GET', `/api/public/tip/${tipTokenA}?view=sign`);
  assert.strictEqual(sign.status, 200);
  assert.deepStrictEqual(sign.body.methods, full.body.methods);
});

test('GET /api/public/tip/:token?view=sign > a deactivated token still 404s', async () => {
  const res = await request('GET', `/api/public/tip/${tipTokenDeactivated}?view=sign`);
  assert.strictEqual(res.status, 404);
});

test('GET /api/public/tip/:token > zelle_handle present + valid appears in body and methods', async () => {
  const res = await request('GET', `/api/public/tip/${tipTokenA}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.zelle_handle, 'anna@example.com');
  assert.ok(res.body.methods.includes('zelle'), 'methods includes zelle when handle is valid');
});

test('GET /api/public/tip/:token > methods ordering: saved order honored, unsaved methods fall to the natural-order end', async () => {
  // User A saved ['venmo', 'card', 'zelle']. PayPal and CashApp are on the
  // profile but not in the saved order — they must trail in the natural order
  // ['card','venmo','cashapp','paypal','zelle']: so cashapp then paypal.
  const res = await request('GET', `/api/public/tip/${tipTokenA}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    res.body.methods,
    ['venmo', 'card', 'zelle', 'cashapp', 'paypal']
  );
});

test('GET /api/public/tip/:token > invalid stored zelle_handle drops to null and is absent from methods', async () => {
  // User B's stored zelle is "not-a-phone-or-email"; normalizeZelleHandle
  // throws and the route catches → null.
  const res = await request('GET', `/api/public/tip/${tipTokenB}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.zelle_handle, null);
  assert.ok(!res.body.methods.includes('zelle'), 'methods does NOT include zelle when stored handle is invalid');
  // Only venmo is on the profile, so methods is exactly ['venmo'].
  assert.deepStrictEqual(res.body.methods, ['venmo']);
});

test('GET /api/public/tip/:token > methods absent from profile are skipped even if listed in tip_card_order', async () => {
  // User C saved ['venmo', 'cashapp', 'zelle']. Only venmo is on the profile.
  // cashapp and zelle must be skipped → methods is exactly ['venmo'].
  const res = await request('GET', `/api/public/tip/${tipTokenC}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.methods, ['venmo']);
});

// ─── Feedback POST: where the admin notification points ─────────────────────
// This link must land on something that SHOWS the feedback. It now does: lane
// sh-f-feedback built FeedbackCard on the staffer profile's Tip Page tab, so
// the alert points at the person the complaint is about. The old destination,
// /tips#feedback, is deleted with TipsAdmin.js, so it is pinned as forbidden
// here: a link to a retired page is the same failure in the other direction.
test('POST /api/public/tip/:token/feedback > the admin email links a page that shows the feedback', async () => {
  sentEmails.length = 0;
  const res = await request('POST', `/api/public/tip/${tipTokenA}/feedback`, {
    rating: 2,
    comment: 'took a while to get served',
    email: 'guest@example.com',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(sentEmails.length, 1, 'exactly one admin notification');

  const { ADMIN_URL } = require('../utils/urls');
  const blob = `${sentEmails[0].html || ''} ${sentEmails[0].text || ''}`;
  const expected = `${ADMIN_URL}/staffing/users/${userIdA}?tab=tip-page`;
  assert.ok(
    blob.includes(expected),
    `links the profile tab whose FeedbackCard shows this feedback (${expected})`
  );
  assert.ok(
    !blob.includes('/tips#feedback'),
    'the /tips feedback queue is retired, so it must not be the destination'
  );

  // The row itself still lands (the email is best-effort, the write is not).
  const { rows } = await pool.query(
    'SELECT rating, submitter_email FROM tip_page_feedback WHERE target_user_id = $1',
    [userIdA]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].rating, 2);
});
