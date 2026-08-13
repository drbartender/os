require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const router = require('./designer');

// POST /campaigns/:id/test was the FOURTH ungated marketing sender: it mails
// the same campaign body the blast path was retired for, to any address, and
// checked no suppression at all. Lane mkt-f gave it a real 365-day unsubscribe
// token, which made gating it more urgent, not less. These pin the gate.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, adminToken, campaignId, excludedClientId, unsubLeadId, okClientId;
const excludedEmail = `dsg-excl-${NONCE}@mkt-test.example`;
const unsubLeadEmail = `dsg-lead-${NONCE}@mkt-test.example`;
const okEmail = `dsg-ok-${NONCE}@mkt-test.example`;

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = ''; res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1,'x','admin','approved') RETURNING id`, [`dsg-admin-${NONCE}@mkt-test.example`]);
  adminToken = jwt.sign({ userId: a.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    `INSERT INTO email_campaigns (name, type, status, subject, html_body)
     VALUES ($1,'blast','draft','Test subject','<p>body</p>') RETURNING id`, [`DSG ${NONCE}`]);
  campaignId = c.rows[0].id;

  excludedClientId = (await pool.query(
    `INSERT INTO clients (name,email,marketing_excluded,marketing_excluded_reason)
     VALUES ($1,$2,true,'designer gate test') RETURNING id`, [`Excl ${NONCE}`, excludedEmail])).rows[0].id;
  okClientId = (await pool.query(
    'INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', [`Ok ${NONCE}`, okEmail])).rows[0].id;
  unsubLeadId = (await pool.query(
    `INSERT INTO email_leads (name,email,status,lead_source)
     VALUES ($1,$2,'unsubscribed','quote_wizard') RETURNING id`, [`Lead ${NONCE}`, unsubLeadEmail])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/email-marketing', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM email_leads WHERE id = $1', [unsubLeadId]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [[excludedClientId, okClientId]]);
  await pool.query('DELETE FROM email_campaigns WHERE id = $1', [campaignId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`dsg-admin-${NONCE}@mkt-test.example`]);
  if (server) await new Promise(r => server.close(r));
  await pool.end();
});

test('a test send to a do-not-contact client is refused', async () => {
  const r = await req('POST', `/api/email-marketing/campaigns/${campaignId}/test`, adminToken,
    { email: excludedEmail });
  assert.equal(r.status, 400, 'the test send must honor the do-not-contact list');
  assert.match(JSON.stringify(r.body.fieldErrors || r.body), /do-not-contact|unsubscribed/i);
});

test('a test send to an unsubscribed LEAD is refused', async () => {
  // The other identity row. A sender that only checks clients misses this.
  const r = await req('POST', `/api/email-marketing/campaigns/${campaignId}/test`, adminToken,
    { email: unsubLeadEmail });
  assert.equal(r.status, 400, 'the test send must honor a lead-side unsubscribe');
});

test('the gate is case and whitespace insensitive', async () => {
  const r = await req('POST', `/api/email-marketing/campaigns/${campaignId}/test`, adminToken,
    { email: `  ${excludedEmail.toUpperCase()} ` });
  assert.equal(r.status, 400, 'a padded, differently-cased address must still be refused');
});

test('a test send to an ordinary address is NOT refused by the gate', async () => {
  // Must not over-suppress. Sending is gated off in test env, so anything other
  // than the suppression 400 means the gate let it through.
  const r = await req('POST', `/api/email-marketing/campaigns/${campaignId}/test`, adminToken,
    { email: okEmail });
  const body = JSON.stringify(r.body || {});
  assert.ok(!/do-not-contact list/i.test(body),
    `the gate must not block an ordinary address (got ${r.status} ${body})`);
});
