require('dotenv').config();

process.env.RESEND_WEBHOOK_SECRET = ''; // skip svix verification (non-prod path)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const webhookRouter = require('./emailMarketingWebhook');

if (process.env.NODE_ENV === 'production') {
  throw new Error('emailMarketingWebhook.suppressionSplit.test.js refuses to run against production');
}

// A BOUNCE and a COMPLAINT are different facts.
//
// Both used to flip clients.email_status = 'bad', which gates proposals,
// invoices and service agreements. So one spam click on a marketing email
// silently killed a paying client's BILLING mail, and nothing ever wrote the
// flag back. These tests pin the split so it cannot regress: a bounce still
// marks the address bad, a complaint marks them do-not-contact and leaves
// operational mail alone.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const BOUNCE_ID = `re_split_b_${NONCE}`;
const COMPLAIN_ID = `re_split_c_${NONCE}`;
const KEEP_ID = `re_split_k_${NONCE}`;
const bounceEmail = `split-bounce-${NONCE}@mkt-test.example`;
const complainEmail = `split-complain-${NONCE}@mkt-test.example`;
const keepEmail = `split-keep-${NONCE}@mkt-test.example`;
let server, baseUrl, bounceClientId, complainClientId, keepClientId;

before(async () => {
  const app = express();
  app.use(express.raw({ type: 'application/json' }));
  app.use('/api/email-marketing/webhook', webhookRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const mk = async (email) => (await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id', [`Split ${NONCE}`, email]
  )).rows[0].id;
  bounceClientId = await mk(bounceEmail);
  complainClientId = await mk(complainEmail);
  keepClientId = await mk(keepEmail);

  // A hand-written exclusion whose reason a later complaint must not clobber.
  await pool.query(
    `UPDATE clients SET marketing_excluded = true,
            marketing_excluded_reason = 'Dallas said so', marketing_excluded_at = NOW()
      WHERE id = $1`, [keepClientId]
  );
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query('DELETE FROM email_webhook_events WHERE resend_id = ANY($1)',
    [[BOUNCE_ID, COMPLAIN_ID, KEEP_ID]]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])',
    [[bounceClientId, complainClientId, keepClientId].filter(Boolean)]);
  await pool.end();
});

function postEvent(eventObj) {
  const payload = Buffer.from(JSON.stringify(eventObj));
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/email-marketing/webhook/resend');
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } },
      (res) => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode })); }
    );
    r.on('error', reject);
    r.write(payload); r.end();
  });
}

const stateOf = async (id) => (await pool.query(
  `SELECT email_status, marketing_excluded, marketing_excluded_reason, marketing_excluded_by
     FROM clients WHERE id = $1`, [id])).rows[0];

test('a permanent BOUNCE still marks the address bad', async () => {
  // Unchanged behavior: a dead address cannot receive operational mail either,
  // so the dispatcher needs email_status to fall future touches over to SMS.
  const r = await postEvent({ type: 'email.bounced', data: { email_id: BOUNCE_ID, to: [bounceEmail] } });
  assert.equal(r.status, 200);
  const s = await stateOf(bounceClientId);
  assert.equal(s.email_status, 'bad', 'a permanent bounce must still mark the address bad');
  assert.equal(s.marketing_excluded, false, 'a bounce is not a house do-not-contact decision');
});

test('a spam COMPLAINT stops marketing without touching billing mail', async () => {
  // The bug this lane fixes. email_status gates proposals, invoices and
  // agreements; a spam click on a marketing email must not reach them.
  const before = await stateOf(complainClientId);
  assert.notEqual(before.email_status, 'bad', 'fixture should start clean');

  const r = await postEvent({ type: 'email.complained', data: { email_id: COMPLAIN_ID, to: [complainEmail] } });
  assert.equal(r.status, 200);

  const s = await stateOf(complainClientId);
  assert.notEqual(s.email_status, 'bad',
    'a spam complaint must NOT kill operational email: that gates invoices');
  assert.equal(s.marketing_excluded, true, 'a complaint must stop marketing');
  assert.match(s.marketing_excluded_reason, /spam/i, 'the reason must say why, for whoever reads the record');
  assert.equal(s.marketing_excluded_by, null, 'no human set this; the system did');
});

test('a complaint never overwrites a reason a human wrote', async () => {
  const r = await postEvent({ type: 'email.complained', data: { email_id: KEEP_ID, to: [keepEmail] } });
  assert.equal(r.status, 200);
  const s = await stateOf(keepClientId);
  assert.equal(s.marketing_excluded, true);
  assert.equal(s.marketing_excluded_reason, 'Dallas said so',
    'an existing hand-written reason must survive a later complaint');
});
