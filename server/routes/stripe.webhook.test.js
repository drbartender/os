require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripe.webhook.test.js refuses to run against production');
}

// Characterization anchor for the stripe.js -> stripeWebhook.js extraction (Batch 3a).
// The Stripe webhook has no existing tests; this pins the one behavior that proves the
// route survives the verbatim move: an unsigned / garbage POST to /api/stripe/webhook is
// rejected by the signature gate (400) — or 503 if no webhook secret is configured in this
// env — and is NEVER processed (never 2xx, never 404). Must stay green before AND after the
// extraction, so it certifies the refactor preserved the wiring + the raw-body contract.

let server, baseUrl;

before(async () => {
  const app = express();
  // Mirror server/index.js: raw body on the webhook path BEFORE any json parser, so the
  // handler receives the Buffer that constructEvent needs for signature verification.
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

function post(path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    const u = new URL(baseUrl + path);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...(headers || {}) },
      },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('POST /api/stripe/webhook with an invalid signature is rejected, never processed', async () => {
  const r = await post('/api/stripe/webhook', {
    body: JSON.stringify({ id: 'evt_test', type: 'payment_intent.succeeded', data: { object: {} } }),
    headers: { 'stripe-signature': 't=123,v1=deadbeef' },
  });
  assert.ok(r.status === 400 || r.status === 503, `expected 400 (bad sig) or 503 (no secret), got ${r.status}: ${r.body}`);
});

test('POST /api/stripe/webhook with no signature header is rejected', async () => {
  const r = await post('/api/stripe/webhook', {
    body: JSON.stringify({ id: 'evt_test', type: 'charge.refunded', data: { object: {} } }),
  });
  assert.ok(r.status === 400 || r.status === 503, `expected 400 or 503, got ${r.status}: ${r.body}`);
});
