// Route tests for the optional client_phone capture on the public sign POST and
// the client_phone_prefill field on the public GET (spec 2026-06-11 Component 4).
// Mounts the real router on a throwaway express app; runs against the dev DB;
// cleans every row it creates. Run ALONE (shared dev DB).
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const crypto = require('node:crypto');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicTokenRouter = require('./publicToken');
const { KNOWN_AGREEMENT_VERSIONS } = require('../../utils/agreementVersions');

let server, baseUrl, clientId, proposalId;
const token = crypto.randomUUID();
const DOC_VERSION = KNOWN_AGREEMENT_VERSIONS[KNOWN_AGREEMENT_VERSIONS.length - 1];
const NEG_ID = 'sign-phone-lead-test';

function httpReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + path, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function signBody(overrides = {}) {
  return JSON.stringify({
    client_signed_name: 'Sign Phone Client',
    client_signature_data: 'data:image/png;base64,AAAA',
    client_signature_method: 'type',
    document_version: DOC_VERSION,
    venue_street: '1 Test St', venue_city: 'Chicago', venue_state: 'Illinois',
    ...overrides,
  });
}

before(async () => {
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [NEG_ID]);
  await pool.query("DELETE FROM clients WHERE email = 'sign-phone-test@example.com'");
  // phone_status 'bad' on purpose: a successful capture must reset it to 'ok'.
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone, phone_status, source)
     VALUES ('Sign Phone Client', 'sign-phone-test@example.com', '8392750009', 'bad', 'thumbtack') RETURNING id`
  );
  clientId = c.rows[0].id;
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_phone, customer_name, raw_payload)
     VALUES ($1, $2, '8392750009', 'Sign Phone Client', '{}'::jsonb)`,
    [NEG_ID, clientId]
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, token, status, total_price) VALUES ($1, $2, 'sent', 500) RETURNING id`,
    [clientId, token]
  );
  proposalId = p.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicTokenRouter);
  app.use((err, req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message });
  });
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => {
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [NEG_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('GET /t/:token blanks a thumbtack proxy phone in client_phone_prefill, leaks no raw fields', async () => {
  const res = await httpReq('GET', `/api/proposals/t/${token}`);
  assert.equal(res.status, 200);
  assert.strictEqual(res.body.client_phone_prefill, '');
  assert.ok(!('client_phone_raw' in res.body), 'raw phone must not leak');
  assert.ok(!('client_source' in res.body), 'source must not leak');
});

test('invalid client_phone -> 400, signature NOT recorded, phone untouched', async () => {
  const res = await httpReq('POST', `/api/proposals/t/${token}/sign`, signBody({ client_phone: '123' }));
  assert.equal(res.status, 400);
  const p = await pool.query('SELECT client_signed_at FROM proposals WHERE id = $1', [proposalId]);
  assert.strictEqual(p.rows[0].client_signed_at, null);
  const c = await pool.query('SELECT phone FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(c.rows[0].phone, '8392750009');
});

test('valid client_phone on a successful sign updates phone, resets phone_status, logs phone_updated', async () => {
  const res = await httpReq('POST', `/api/proposals/t/${token}/sign`, signBody({ client_phone: '(773) 555-0042' }));
  assert.equal(res.status, 200);
  const c = await pool.query('SELECT phone, phone_status FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(c.rows[0].phone, '7735550042');
  assert.strictEqual(c.rows[0].phone_status, 'ok');
  const log = await pool.query(
    `SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'signed' ORDER BY id DESC LIMIT 1`,
    [proposalId]
  );
  assert.strictEqual(log.rows[0].details.phone_updated, true);
});

test('a replayed sign (ALREADY_ACCEPTED) performs no phone write', async () => {
  const res = await httpReq('POST', `/api/proposals/t/${token}/sign`, signBody({ client_phone: '(312) 555-9999' }));
  assert.equal(res.status, 409);
  const c = await pool.query('SELECT phone FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(c.rows[0].phone, '7735550042', 'replay must not mutate the phone');
});
