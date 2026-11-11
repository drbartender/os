// The public quote wizard resolves a phone-only client row by name and phone
// but never stamps it, and treats it as a matched row: the token is withheld
// and the link goes only to the phone on file (audit 2026-11-05 AUTH-02).
//
// HARNESS NOTES
// -------------
// Mirrors publicSmsConsent.test.js: the real `public` router (and the real
// clientAuth router, for the takeover step) on a fresh express() app with the
// AppError-aware error handler of server/index.js, over real HTTP against the
// dev database (DATABASE_URL from .env). Every fixture email ends in
// `.invalid`, so utils/email.js short-circuits before any provider call. The
// pure companion is server/utils/clientDedup.stampEmail.test.js.
//
// The attack this pins: a client row {name, phone, email NULL} exists (the
// Thumbtack webhook creates these). A submit with that name and phone and the
// attacker's email used to stamp the email onto the row; the OTP login then
// resolved that email to the victim's client id. Now the submit attaches to
// the victim's row WITHOUT writing the email, withholds the token, and sends
// the link only to the phone on file, so the submitter gets nothing back and
// the OTP request for their email resolves to no client at all. One row per
// person keeps the drip sibling check and the alternatives sweep working.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicRouter = require('./public');
const clientAuthRouter = require('../clientAuth');

let server;
let baseUrl;
let PACKAGE_ID;
let victimId;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const VICTIM_NAME = `Wizard Match ${NONCE}`;
// 555 + 7 digits: length-valid (validatePhone checks length, not area code)
// and cannot collide with a real number in the dev DB.
const VICTIM_PHONE = `555${crypto.randomInt(1000000, 9999999)}`;
const STRANGER_EMAIL = `wizard-match-${NONCE}@example.invalid`;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
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

before(async () => {
  const pkg = await pool.query(
    `SELECT id FROM service_packages
      WHERE is_active = true AND bar_type <> 'class' ORDER BY id LIMIT 1`
  );
  assert.ok(pkg.rows[0], 'test harness needs an active non-class service package');
  PACKAGE_ID = pkg.rows[0].id;

  // The phone-only row, as the Thumbtack webhook leaves it.
  const v = await pool.query(
    `INSERT INTO clients (name, phone, source) VALUES ($1, $2, 'thumbtack') RETURNING id`,
    [VICTIM_NAME, VICTIM_PHONE]
  );
  victimId = v.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicRouter);
  app.use('/api/client-auth', clientAuthRouter);
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
  const strangers = await pool.query('SELECT id FROM clients WHERE LOWER(email) = LOWER($1)', [STRANGER_EMAIL]);
  const clientIds = [victimId, ...strangers.rows.map((r) => r.id)].filter(Boolean);
  const props = await pool.query('SELECT id FROM proposals WHERE client_id = ANY($1::int[])', [clientIds]);
  const ids = props.rows.map((r) => r.id);
  if (ids.length) {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1)', [ids]);
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1)", [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (clientIds.length) {
    // The matched path texts the phone on file, which logs an sms_messages row
    // whose client_id would be nulled, not removed, by the client delete.
    await pool.query('DELETE FROM sms_messages WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM sms_consent_log WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
  }
  await pool.query(
    'DELETE FROM email_sequence_enrollments WHERE lead_id IN (SELECT id FROM email_leads WHERE email = $1)', [STRANGER_EMAIL]
  );
  await pool.query('DELETE FROM quote_drafts WHERE email = $1', [STRANGER_EMAIL]);
  await pool.query('DELETE FROM email_leads WHERE email = $1', [STRANGER_EMAIL]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('public submit with a phone-only client\'s name and phone attaches to that row, stamps nothing and withholds the token', async () => {
  const res = await request('POST', '/api/proposals/public/submit', {
    client_name: VICTIM_NAME,
    client_email: STRANGER_EMAIL,
    client_phone: VICTIM_PHONE,
    event_date: '2026-12-31',
    event_start_time: '18:00',
    event_duration_hours: 4,
    venue_name: 'Match Hall',
    venue_street: '1 Test St',
    venue_city: 'Chicago',
    venue_state: 'IL',
    guest_count: 50,
    package_id: PACKAGE_ID,
    event_type: 'Wedding',
  });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.token, null, 'a matched row never hands the submitter its token');
  assert.equal(res.body.delivered_to, null, 'no email is on file, so none is claimed');
  assert.ok(
    res.body.delivery_failed === true || /^\*\*\*-\*\*\*-\d{4}$/.test(res.body.delivered_to_phone || ''),
    `the link went by text to the masked number on file, or the panel says it did not: ${res.raw}`
  );

  const victim = await pool.query('SELECT email, auth_token FROM clients WHERE id = $1', [victimId]);
  assert.equal(victim.rows[0].email, null, 'the phone-only row must not receive the submitted email');

  const p = await pool.query('SELECT id, token FROM proposals WHERE client_id = $1', [victimId]);
  assert.equal(p.rows.length, 1, 'the proposal hangs off the existing row');
  assert.ok(!res.raw.includes(p.rows[0].token), 'its token appears nowhere in the response');
  const strangers = await pool.query('SELECT id FROM clients WHERE LOWER(email) = LOWER($1)', [STRANGER_EMAIL]);
  assert.equal(strangers.rows.length, 0, 'no second client row, and the submitted email is saved nowhere on clients');
});

test('an OTP request for the submitted email never touches the phone-only row', async () => {
  const res = await request('POST', '/api/client-auth/request', { email: STRANGER_EMAIL });
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.body, { success: true });
  const victim = await pool.query('SELECT auth_token, email FROM clients WHERE id = $1', [victimId]);
  assert.equal(victim.rows[0].email, null);
  assert.equal(victim.rows[0].auth_token, null, 'no OTP may be minted against the victim\'s client id');
});
