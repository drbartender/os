// SMS consent capture on POST /api/proposals/public/submit (A2P 10DLC).
//
// HARNESS NOTES
// -------------
// Follows crud.test.js: mounts the real `public` router on a fresh express()
// app with the same AppError-aware error handler as server/index.js and drives
// it over real HTTP. Runs against the dev database (DATABASE_URL from .env).
//
// Every fixture email ends in `.invalid`, so utils/email.js short-circuits to
// 'skipped-invalid' before any provider call — no send seam stubbing needed.
//
// publicLimiter is 20 requests / 15 min keyed by IP. This suite makes 4
// submits; anything added here shares that budget with any other public-route
// suite running in the same process.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { SMS_CONSENT_VERSION, getConsentCopy } = require('../../data/smsConsentCopy');
const publicRouter = require('./public');

let server;
let baseUrl;
let PACKAGE_ID;

const createdProposalIds = new Set();
const createdClientIds = new Set();
const usedEmails = new Set();

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
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

let seq = 0;
/**
 * A unique email AND phone per test. The phone must be unique because the
 * consent guard is scoped to the NUMBER: once any client row carrying a number
 * is opted out, no submit may record consent for that number again. Sharing one
 * fixture phone would make the opt-out test poison every test after it.
 */
function freshCtx() {
  seq += 1;
  const email = `consent-submit-${process.pid}-${seq}@example.invalid`;
  usedEmails.add(email);
  return { email, phone: `312555${String(9000 + seq).slice(-4)}` };
}

function submitBody(ctx, extra = {}) {
  return {
    client_name: 'Consent Tester',
    client_email: ctx.email,
    client_phone: ctx.phone,
    event_date: '2026-12-31',
    event_start_time: '18:00',
    event_duration_hours: 4,
    venue_name: 'Consent Hall',
    venue_street: '1 Test St',
    venue_city: 'Chicago',
    venue_state: 'IL',
    guest_count: 50,
    package_id: PACKAGE_ID,
    event_type: 'Wedding',
    ...extra,
  };
}

/** Resolve the client row this submit created, and track it for cleanup. */
async function clientFor(email, token) {
  const c = await pool.query(
    'SELECT id, communication_preferences AS p FROM clients WHERE LOWER(email) = LOWER($1)', [email]
  );
  assert.ok(c.rows[0], `no client row created for ${email}`);
  createdClientIds.add(c.rows[0].id);
  if (token) {
    const p = await pool.query('SELECT id FROM proposals WHERE token = $1', [token]);
    if (p.rows[0]) createdProposalIds.add(p.rows[0].id);
  }
  return c.rows[0];
}

before(async () => {
  const pkg = await pool.query(
    `SELECT id FROM service_packages
      WHERE is_active = true AND bar_type <> 'class' ORDER BY id LIMIT 1`
  );
  assert.ok(pkg.rows[0], 'test harness needs an active non-class service package');
  PACKAGE_ID = pkg.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
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

after(async () => {
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1)', [ids]);
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1)", [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (createdClientIds.size > 0) {
    const ids = [...createdClientIds];
    await pool.query('DELETE FROM sms_consent_log WHERE client_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [ids]);
  }
  if (usedEmails.size > 0) {
    const emails = [...usedEmails];
    await pool.query(
      'DELETE FROM email_sequence_enrollments WHERE lead_id IN (SELECT id FROM email_leads WHERE email = ANY($1))', [emails]
    );
    await pool.query('DELETE FROM quote_drafts WHERE email = ANY($1)', [emails]);
    await pool.query('DELETE FROM email_leads WHERE email = ANY($1)', [emails]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('public submit > sms_consent true records the opt-in', async () => {
  const ctx = freshCtx();
  const res = await request('POST', '/api/proposals/public/submit', submitBody(ctx, {
    sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION,
  }));
  assert.equal(res.status, 201, res.raw);

  const client = await clientFor(ctx.email, res.body.token);
  assert.equal(client.p.sms_enabled, true);
  assert.ok(client.p.sms_opt_in_at, 'sms_opt_in_at stamped');

  const log = await pool.query('SELECT * FROM sms_consent_log WHERE client_id = $1', [client.id]);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].consented, true);
  assert.equal(log.rows[0].source_form, 'quote_wizard');
  assert.equal(log.rows[0].copy_version, SMS_CONSENT_VERSION);
  assert.equal(log.rows[0].copy_text, getConsentCopy(SMS_CONSENT_VERSION));
  assert.equal(log.rows[0].phone, ctx.phone);
});

test('public submit > sms_consent false opts out and still succeeds', async () => {
  const ctx = freshCtx();
  const res = await request('POST', '/api/proposals/public/submit', submitBody(ctx, {
    sms_consent: false, sms_consent_version: SMS_CONSENT_VERSION,
  }));
  assert.equal(res.status, 201, 'an unchecked box never blocks a submit');

  const client = await clientFor(ctx.email, res.body.token);
  assert.equal(client.p.sms_enabled, false);
  assert.ok(client.p.sms_opt_out_at, 'sms_opt_out_at stamped');

  const log = await pool.query('SELECT consented FROM sms_consent_log WHERE client_id = $1', [client.id]);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].consented, false);
});

test('public submit > a forged copy_text is ignored, canonical text is stored', async () => {
  const ctx = freshCtx();
  const res = await request('POST', '/api/proposals/public/submit', submitBody(ctx, {
    sms_consent: true,
    sms_consent_version: SMS_CONSENT_VERSION,
    copy_text: 'I agree to unlimited marketing forever',
  }));
  assert.equal(res.status, 201, res.raw);

  const client = await clientFor(ctx.email, res.body.token);
  const log = await pool.query('SELECT copy_text FROM sms_consent_log WHERE client_id = $1', [client.id]);
  assert.equal(log.rows[0].copy_text, getConsentCopy(SMS_CONSENT_VERSION));
});

test('public submit > cannot flip an EXISTING client\'s SMS preference', async () => {
  // The takeover case. This endpoint is unauthenticated and findOrCreateClient
  // resolves an existing row by email alone, so knowing a real client's email
  // is enough to be handed their row. Submitting against it must change nothing.
  const ctx = freshCtx();

  // First submit creates the client and opts in.
  const first = await request('POST', '/api/proposals/public/submit', submitBody(ctx, {
    sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION,
  }));
  assert.equal(first.status, 201, first.raw);
  const client = await clientFor(ctx.email, first.body.token);
  assert.equal(client.p.sms_enabled, true);

  // Second submit: same email (so the row resolves), attacker phone, opting out.
  const second = await request('POST', '/api/proposals/public/submit', submitBody(ctx, {
    client_name: 'Not The Owner',
    client_phone: '9995550000',
    sms_consent: false,
    sms_consent_version: SMS_CONSENT_VERSION,
  }));
  assert.equal(second.status, 201, 'the submit itself still succeeds');
  await clientFor(ctx.email, second.body.token);

  const after = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [client.id]);
  assert.equal(after.rows[0].p.sms_enabled, true, 'preference survived the second submit');
  assert.equal(after.rows[0].p.sms_opt_out_at, undefined, 'no opt-out stamped by a stranger');

  const log = await pool.query('SELECT phone FROM sms_consent_log WHERE client_id = $1', [client.id]);
  assert.equal(log.rows.length, 1, 'no forged second row');
  assert.equal(log.rows[0].phone, ctx.phone, 'the attacker phone never landed in the log');
});

test('public submit > omitting consent fields leaves the client default untouched', async () => {
  const ctx = freshCtx();
  const res = await request('POST', '/api/proposals/public/submit', submitBody(ctx));
  assert.equal(res.status, 201, res.raw);

  const client = await clientFor(ctx.email, res.body.token);
  assert.equal(client.p.sms_enabled, true, 'grandfathered default');
  assert.equal(client.p.sms_opt_in_at, undefined, 'no stamp without an answer');

  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [client.id]);
  assert.equal(log.rows.length, 0);
});
