require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.RESEND_WEBHOOK_SECRET = ''; // skip svix verification for the test (non-prod path)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const webhookRouter = require('./emailMarketingWebhook');

if (process.env.NODE_ENV === 'production') {
  throw new Error('emailMarketingWebhook.idempotency.test.js refuses to run against production');
}

// Audit 3c: the Resend webhook had no replay/idempotency gate — a redelivered event re-applied
// its side-effects. The handler now does ON CONFLICT (resend_id, event_type) DO NOTHING and
// returns early on a duplicate, so a redelivery records once and re-applies nothing.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const RESEND_ID = `re_idemp_${NONCE}`;
const RESEND_ID_HEAL = `re_heal_${NONCE}`;
let server, baseUrl, healLeadId;

before(async () => {
  const app = express();
  app.use(express.raw({ type: 'application/json' })); // mirror index.js raw body for svix
  app.use('/api/email-marketing/webhook', webhookRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query('DELETE FROM email_webhook_events WHERE resend_id = ANY($1)', [[RESEND_ID, RESEND_ID_HEAL]]);
  await pool.query('DELETE FROM email_sends WHERE resend_id = $1', [RESEND_ID_HEAL]);
  if (healLeadId) await pool.query('DELETE FROM email_leads WHERE id = $1', [healLeadId]);
  await pool.end();
});

function postEvent(eventObj) {
  const payload = Buffer.from(JSON.stringify(eventObj));
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/email-marketing/webhook/resend');
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('a redelivered Resend webhook event is recorded once and re-applies nothing (ON CONFLICT idempotency)', async () => {
  const event = { type: 'email.delivered', data: { email_id: RESEND_ID } };

  const first = await postEvent(event);
  assert.equal(first.status, 200, `first delivery: ${first.status} ${JSON.stringify(first.body)}`);

  const second = await postEvent(event);
  assert.equal(second.status, 200, `redelivery should not error: ${second.status} ${JSON.stringify(second.body)}`);
  assert.equal(second.body && second.body.duplicate, true, 'redelivery should be flagged duplicate');

  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM email_webhook_events WHERE resend_id = $1', [RESEND_ID]);
  assert.equal(cnt.rows[0].n, 1, 'exactly one webhook_events row for the redelivered event');
});

test('a recorded-but-unprocessed event re-applies its (idempotent) side-effects on redelivery (mid-processing-failure heal)', async () => {
  // Simulate a prior delivery that INSERTed the webhook row but 500'd before applying the
  // side-effects (processed stayed false) — so the bounce never suppressed the lead. The
  // idempotency gate must skip ONLY fully-processed rows, else the event is stranded forever.
  const lead = await pool.query(
    `INSERT INTO email_leads (name, email, status) VALUES ('Heal Test', $1, 'active') RETURNING id`,
    [`heal-${NONCE}@example.com`]
  );
  healLeadId = lead.rows[0].id;
  await pool.query(
    `INSERT INTO email_sends (lead_id, resend_id, status) VALUES ($1, $2, 'sent')`,
    [healLeadId, RESEND_ID_HEAL]
  );
  await pool.query(
    `INSERT INTO email_webhook_events (resend_id, event_type, payload, processed)
     VALUES ($1, 'email.bounced', '{}', false)`,
    [RESEND_ID_HEAL]
  );

  const res = await postEvent({ type: 'email.bounced', data: { email_id: RESEND_ID_HEAL } });
  assert.equal(res.status, 200, `redelivery should process: ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(!(res.body && res.body.duplicate), 'an unprocessed row must NOT be skipped as a duplicate');

  const leadAfter = await pool.query('SELECT status FROM email_leads WHERE id = $1', [healLeadId]);
  assert.equal(leadAfter.rows[0].status, 'bounced', 'the bounce side-effect healed: the lead is now suppressed');

  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM email_webhook_events WHERE resend_id = $1', [RESEND_ID_HEAL]);
  assert.equal(cnt.rows[0].n, 1, 'still exactly one webhook_events row (no duplicate insert)');
  const proc = await pool.query('SELECT processed FROM email_webhook_events WHERE resend_id = $1', [RESEND_ID_HEAL]);
  assert.equal(proc.rows[0].processed, true, 'the row is now marked processed');
});
