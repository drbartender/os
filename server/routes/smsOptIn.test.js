// Behavior tests for POST /api/sms/opt-in, the standalone /sms page's submit.
//
// What is worth locking in here is not the happy path (though it is covered) but
// the three ways this endpoint can go wrong quietly, all of which would be
// invisible in the UI:
//
//   1. A ticked box that records nothing. The page would show "you're signed
//      up" while we hold no proof for a carrier dispute.
//   2. A client row left SMS-ON without a recorded opt-in. clients defaults
//      communication_preferences.sms_enabled to TRUE and clientDedup's INSERT
//      never sets it, and that flag is the SOLE enforcement of an opt-out on
//      the send path — so a row created by a submit whose consent did NOT
//      record is a row we would text with no consent behind it.
//   3. The ownership rule eroding: this endpoint is unauthenticated, so
//      resolving a stranger's row by email must never mutate their preferences.
//
// Harness mirrors public.captureLeadConn.test.js: a fresh express() app mounts
// the real router over real HTTP against the dev DB (DATABASE_URL from .env).
// The error middleware mirrors server/index.js's envelope (fieldErrors), because
// the page reads fieldErrors off it.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { getConsentCopy, SMS_CONSENT_VERSION } = require('../data/smsConsentCopy');
const smsOptInRouter = require('./smsOptIn');

let server;
let baseUrl;

// Every row this suite creates is keyed by one of these, and after() deletes by
// exactly these lists — never by a LIKE pattern that could catch a real client.
const testEmails = [];
const testPhones = [];

// Names used by the email-less fixtures, so the phone-keyed cleanup can be
// scoped to rows this suite created. Any new email-less fixture must be added.
const FIXTURE_NAMES = ['Stopped Person', 'Phone Only Client'];

function newEmail() {
  const email = `sms-optin-${crypto.randomUUID()}@example.test`;
  testEmails.push(email);
  return email;
}

// 555 + 7 digits: length-valid (validatePhone checks length, not area code) and
// cannot collide with a real number in the dev DB.
function newPhone() {
  const phone = `555${crypto.randomInt(1000000, 9999999)}`;
  testPhones.push(phone);
  return phone;
}

function request(method, path, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const u = new URL(baseUrl + path);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_) { parsed = data; }
          // Tripwire, not a retry. publicLimiter is 20 per 15 min keyed on
          // 127.0.0.1 and is NOT reset between tests, so this suite's request
          // budget is finite (16 as written). Without this, adding a case makes
          // some unrelated assertion fail on a 429 body and the cause is not
          // obvious. If you see this, split the suite or drop a case — do not
          // just raise the limiter.
          if (res.statusCode === 429) {
            reject(new Error(
              'publicLimiter 429: this suite exceeded 20 requests / 15 min from 127.0.0.1'
            ));
            return;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const optIn = (over = {}) => ({
  client_name: 'Opt In Test',
  client_email: newEmail(),
  client_phone: newPhone(),
  sms_consent: true,
  sms_consent_version: SMS_CONSENT_VERSION,
  ...over,
});

async function clientByEmail(email) {
  const { rows } = await pool.query(
    'SELECT id, phone, communication_preferences FROM clients WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  return rows[0] || null;
}

async function logRowsForPhone(phone) {
  const { rows } = await pool.query(
    'SELECT * FROM sms_consent_log WHERE phone = $1 ORDER BY id',
    [phone]
  );
  return rows;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', smsOptInRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode || 400).json(body);
    }
    return res.status(500).json({ error: 'Server error' });
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (testPhones.length) {
    await pool.query('DELETE FROM sms_consent_log WHERE phone = ANY($1::text[])', [testPhones]);
  }
  if (testEmails.length) {
    await pool.query('DELETE FROM clients WHERE LOWER(email) = ANY($1::text[])',
      [testEmails.map(e => e.toLowerCase())]);
  }
  if (testPhones.length) {
    // The email-less fixtures (prior_opt_out, phone-only row) are keyed by phone.
    // ALSO scoped by name: the dev DB holds other suites' 555 fixtures with a
    // NULL email (e.g. 'Harness Emailed' at 5553606498), and a generated phone
    // could collide with one. Name-scoping makes this delete unable to reach any
    // row this suite did not create.
    await pool.query(
      `DELETE FROM clients
        WHERE email IS NULL
          AND name = ANY($2::text[])
          AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ANY($1::text[])`,
      [testPhones, FIXTURE_NAMES]
    );
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('opt-in > a ticked box on a new client records consent and turns SMS on', async () => {
  const body = optIn();
  const res = await request('POST', '/opt-in', body);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  const row = await clientByEmail(body.client_email);
  assert.ok(row, 'the submit should have created a client row');
  const prefs = row.communication_preferences || {};
  assert.equal(prefs.sms_enabled, true, 'an affirmative opt-in must leave SMS enabled');
  assert.ok(prefs.sms_opt_in_at, 'the opt-in timestamp must be stamped');
  assert.equal(prefs.sms_opt_out_at, undefined, 'an opt-in must never stamp an opt-out');

  const logs = await logRowsForPhone(body.client_phone);
  assert.equal(logs.length, 1, 'exactly one audit row');
  assert.equal(logs[0].consented, true);
  assert.equal(logs[0].source_form, 'sms_page', 'this form must be distinguishable in the log');
  assert.equal(logs[0].copy_version, SMS_CONSENT_VERSION);
  // The log has to hold what they actually read, not a pointer to it.
  assert.equal(logs[0].copy_text, getConsentCopy(SMS_CONSENT_VERSION));
});

test('opt-in > an unticked box is a validation error and creates nothing', async () => {
  // The whole point of this page is the opt-in, so an unticked box is an
  // unfinished form. It must NOT be recorded as a decline, because a decline
  // stamps the hard sms_opt_out_at that permanently blocks the number.
  const body = optIn({ sms_consent: false });
  const res = await request('POST', '/opt-in', body);
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors?.sms_consent, 'the box must report a field error');

  assert.equal(await clientByEmail(body.client_email), null, 'no client row may be created');
  assert.equal((await logRowsForPhone(body.client_phone)).length, 0, 'nothing may be logged');
});

test('opt-in > an absent consent field is rejected, never treated as consent', async () => {
  const body = optIn();
  delete body.sms_consent;
  const res = await request('POST', '/opt-in', body);
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors?.sms_consent);
  assert.equal(await clientByEmail(body.client_email), null);
});

test('opt-in > a truthy-but-not-true consent value does not opt anyone in', async () => {
  // consentFieldsFromBody whitelists true and 'true' only. 'yes' / '1' / 'on'
  // must not become an opt-in, and here they must not even pass validation.
  for (const sneaky of ['yes', '1', 'on', 1]) {
    const body = optIn({ sms_consent: sneaky });
    const res = await request('POST', '/opt-in', body);
    assert.equal(res.status, 400, `sms_consent=${JSON.stringify(sneaky)} must not be an opt-in`);
    assert.equal(await clientByEmail(body.client_email), null);
  }
});

test('opt-in > a bad phone is rejected before any row is created', async () => {
  const body = optIn({ client_phone: '123' });
  const res = await request('POST', '/opt-in', body);
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors?.client_phone);
  assert.equal(await clientByEmail(body.client_email), null);
});

test('opt-in > a bad email is rejected before any row is created', async () => {
  const phone = newPhone();
  const res = await request('POST', '/opt-in', {
    client_name: 'Opt In Test', client_email: 'not-an-email', client_phone: phone,
    sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION,
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors?.client_email);
  assert.equal((await logRowsForPhone(phone)).length, 0);
});

test('opt-in > an EXISTING client row is never mutated (the ownership rule)', async () => {
  // This endpoint is unauthenticated and clientDedup resolves by email alone, so
  // knowing a stranger's email hands you their row. Submitting must not flip
  // their preferences, resurrect an opt-out, or forge an audit row for them.
  const email = newEmail();
  const victimPhone = newPhone();
  const seeded = await pool.query(
    `INSERT INTO clients (name, email, phone, source, communication_preferences)
     VALUES ($1, $2, $3, 'website', '{"sms_enabled":false,"email_enabled":true,"marketing_enabled":true}'::jsonb)
     RETURNING id`,
    ['Existing Client', email, victimPhone]
  );
  const victimId = seeded.rows[0].id;

  const attackerPhone = newPhone();
  const res = await request('POST', '/opt-in', {
    client_name: 'Someone Else', client_email: email, client_phone: attackerPhone,
    sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION,
  });
  // Generic success: a per-outcome response would make this form an oracle for
  // "is this email one of your clients".
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  const after = await pool.query(
    'SELECT phone, communication_preferences FROM clients WHERE id = $1', [victimId]
  );
  assert.equal(after.rows[0].communication_preferences.sms_enabled, false,
    'the existing row must keep its own preference');
  assert.equal(after.rows[0].communication_preferences.sms_opt_in_at, undefined,
    'no opt-in may be stamped on a row this submit did not create');
  assert.equal(after.rows[0].phone, victimPhone,
    'the submitted phone must never overwrite an email-matched row');
  assert.equal((await logRowsForPhone(attackerPhone)).length, 0,
    'no audit row may be forged against someone else\'s client');
});

test('opt-in > a number under an active STOP is not opted in, and leaves no SMS-on row', async () => {
  // Owning a ROW is not owning a NUMBER: a throwaway email plus someone's real
  // phone gets a brand-new row and sails through the subjectIsNew gate. The
  // phone-scoped guard in recordSmsConsent is what stops it — and this endpoint
  // then rolls the whole submit back, so no row survives SMS-on by default.
  const stoppedPhone = newPhone();
  await pool.query(
    `INSERT INTO clients (name, phone, source, communication_preferences)
     VALUES ($1, $2, 'website',
       jsonb_build_object('sms_enabled', false, 'sms_opt_out_at', NOW()::text))`,
    ['Stopped Person', stoppedPhone]
  );

  const email = newEmail();
  const res = await request('POST', '/opt-in', {
    client_name: 'Throwaway', client_email: email, client_phone: stoppedPhone,
    sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION,
  });
  assert.equal(res.status, 200, 'generic success — the response must not confirm the opt-out');
  assert.deepEqual(res.body, { ok: true });

  assert.equal(await clientByEmail(email), null,
    'the created row must be rolled back, never left SMS-on with no consent');
  assert.equal((await logRowsForPhone(stoppedPhone)).length, 0,
    'no consent may be recorded against a number under an active STOP');
});

test('opt-in > a PHONE-ONLY client row keeps its NULL email (no portal takeover)', async () => {
  // The hole this locks shut: clientDedup's phone branch matches a row whose
  // email IS NULL on normalized phone + exact name, and BACKFILLS the submitted
  // email onto that existing row (the wizard's "Jim fix"). It returns
  // created=false, so recordSmsConsent refuses — but a rollback gated on
  // `created` would let the email write COMMIT. Since the client portal mails its
  // login code to clients.email, that hands the submitter this client's portal.
  const victimPhone = newPhone();
  const seeded = await pool.query(
    `INSERT INTO clients (name, phone, source) VALUES ($1, $2, 'thumbtack') RETURNING id`,
    ['Phone Only Client', victimPhone]
  );
  const victimId = seeded.rows[0].id;

  const attackerEmail = newEmail();
  const res = await request('POST', '/opt-in', {
    // Same name and number: exactly what clientDedup's phone branch matches on,
    // and both are visible in a Thumbtack thread.
    client_name: 'Phone Only Client', client_email: attackerEmail, client_phone: victimPhone,
    sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  const after = await pool.query('SELECT email FROM clients WHERE id = $1', [victimId]);
  assert.equal(after.rows[0].email, null,
    'the submitted email must NOT be backfilled onto a row this submit did not create');
  assert.equal((await logRowsForPhone(victimPhone)).length, 0, 'nothing may be logged');
});

test('opt-in > an unknown consent version records nothing and asks for a retry', async () => {
  // Deploy skew (Vercel ships the bundle before Render ships the server). We
  // cannot say what they agreed to, so we must not show a success screen.
  const body = optIn({ sms_consent_version: 'v-not-a-real-version' });
  const res = await request('POST', '/opt-in', body);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'SMS_CONSENT_VERSION_SKEW');

  assert.equal(await clientByEmail(body.client_email), null, 'the submit must be rolled back');
  assert.equal((await logRowsForPhone(body.client_phone)).length, 0);
});

test('opt-in > a bad version answers the same for a known and an unknown email', async () => {
  // THE ENUMERATION REGRESSION TEST. recordSmsConsent checks the ownership gate
  // BEFORE the version, so a version check placed after the DB work answered 503
  // for a stranger's email and 200 for an existing client's — a side-effect-free
  // membership oracle for "is this address a Dr. Bartender client". The version
  // must be resolved before any DB work so both answers are identical.
  const knownEmail = newEmail();
  await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, 'website')`,
    ['Known Client', knownEmail, newPhone()]
  );

  const bogus = 'v-not-a-real-version';
  const known = await request('POST', '/opt-in', {
    client_name: 'Probe', client_email: knownEmail, client_phone: newPhone(),
    sms_consent: true, sms_consent_version: bogus,
  });
  const unknown = await request('POST', '/opt-in', optIn({ sms_consent_version: bogus }));

  assert.equal(known.status, unknown.status,
    'status must not reveal whether the email is an existing client');
  assert.deepEqual(known.body, unknown.body,
    'body must not reveal whether the email is an existing client');
  assert.equal(known.status, 503);
});

test('opt-in > holds exactly one pooled connection, never two', async () => {
  // The capture-lead deadlock (2026-07-13) came from a handler that held one
  // pooled client and then ran bare pool.query() calls, each checking out a
  // SECOND connection: at `max` concurrent such requests the pool starves. This
  // endpoint has the same shape (transaction + helpers), and CLAUDE.md calls the
  // invariant load-bearing, so it gets the same guard as
  // proposals/public.captureLeadConn.test.js. pg's Pool.query() routes through
  // connect(), so patching connect observes implicit checkouts too.
  const originalConnect = pool.connect.bind(pool);
  let live = 0, peak = 0, total = 0;
  const track = (client) => {
    live += 1; total += 1; peak = Math.max(peak, live);
    const originalRelease = client.release.bind(client);
    let released = false;
    client.release = (...args) => {
      if (!released) { released = true; live -= 1; }
      return originalRelease(...args);
    };
    return client;
  };
  pool.connect = function connectProbe(cb) {
    if (typeof cb === 'function') {
      return originalConnect((err, client, release) => {
        if (!err && client) track(client);
        return cb(err, client, release);
      });
    }
    return originalConnect().then(track);
  };

  try {
    const res = await request('POST', '/opt-in', optIn());
    assert.equal(res.status, 200);
    assert.equal(peak, 1, `held ${peak} pooled connections at once; must never exceed 1`);
    assert.equal(total, 1, `checked out ${total} pooled connections; must use exactly 1`);
    assert.equal(live, 0, 'the connection must be released');
  } finally {
    pool.connect = originalConnect;
  }
});
