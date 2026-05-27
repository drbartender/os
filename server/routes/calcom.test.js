require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { pool } = require('../db');

let _server = null;
let _baseUrl = null;

async function buildApp(secretOverride) {
  if (secretOverride !== undefined) process.env.CAL_WEBHOOK_SECRET = secretOverride;
  // Reset module cache so the route picks up the new env on this build.
  delete require.cache[require.resolve('./calcom')];
  const router = require('./calcom');
  const app = express();
  app.use('/api/calcom/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/calcom', router);

  if (_server) await new Promise(r => _server.close(r));
  await new Promise(resolve => {
    _server = app.listen(0, () => {
      const port = _server.address().port;
      _baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function signedRequest(body, secret, headerOverride) {
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(body).digest('hex')
    : '';
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (headerOverride !== undefined) {
    if (headerOverride !== null) headers['x-cal-signature-256'] = headerOverride;
  } else if (sig) {
    headers['x-cal-signature-256'] = sig;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}/api/calcom/webhook`, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Variant that lets a test override the header name (case sensitivity check).
async function customHeaderRequest(body, secret, headerName) {
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(body).digest('hex')
    : '';
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    [headerName]: sig,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}/api/calcom/webhook`, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const ORIGINAL_SECRET = process.env.CAL_WEBHOOK_SECRET;
const TEST_SECRET = 'test-cal-secret';

before(async () => {
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
});

after(async () => {
  process.env.CAL_WEBHOOK_SECRET = ORIGINAL_SECRET;
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
  if (_server) await new Promise(r => _server.close(r));
  await pool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
});

test('webhook: returns 503 when CAL_WEBHOOK_SECRET unset', async () => {
  await buildApp(''); // empty string treated as unset
  const res = await signedRequest(Buffer.from('{}'), '');
  assert.equal(res.status, 503);
  assert.match(res.text, /not configured/i);
});

test('webhook: returns 400 when signature header missing', async () => {
  await buildApp(TEST_SECRET);
  const res = await signedRequest(Buffer.from('{}'), TEST_SECRET, null);
  assert.equal(res.status, 400);
  assert.match(res.text, /missing signature/i);
});

test('webhook: returns 400 when signature is wrong', async () => {
  await buildApp(TEST_SECRET);
  const res = await signedRequest(Buffer.from('{}'), TEST_SECRET, 'wrongsig');
  assert.equal(res.status, 400);
  assert.match(res.text, /invalid signature/i);
});

test('webhook: wrong-case header still verifies (Express normalizes)', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'wrong-case-1' } }));
  // Send header as mixed-case 'X-Cal-Signature-256' instead of lowercase.
  const res = await customHeaderRequest(body, TEST_SECRET, 'X-Cal-Signature-256');
  assert.equal(res.status, 200); // signature verifies, dispatches to default (ignored)
});

test('webhook: returns 400 on malformed JSON body', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from('not json at all');
  const res = await signedRequest(body, TEST_SECRET);
  assert.equal(res.status, 400);
  assert.match(res.text, /malformed body/i);
});

test('webhook: returns 200 ignored on unknown triggerEvent', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({
    triggerEvent: 'MEETING_STARTED',
    payload: {},
  }));
  const res = await signedRequest(body, TEST_SECRET);
  assert.equal(res.status, 200);
  assert.match(res.text, /ignored/i);
});

test('webhook: dedupe returns 200 Already processed on identical replay', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({
    triggerEvent: 'MEETING_STARTED',
    payload: { uid: 'replay-test-1' },
  }));
  const first = await signedRequest(body, TEST_SECRET);
  assert.equal(first.status, 200);
  const second = await signedRequest(body, TEST_SECRET);
  assert.equal(second.status, 200);
  assert.match(second.text, /already processed/i);

  const dedupeRows = await pool.query(
    "SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'calcom'"
  );
  assert.equal(Number(dedupeRows.rows[0].n), 1);
});

test('webhook: dedupe treats different bodies as different events', async () => {
  await buildApp(TEST_SECRET);
  const a = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'a' } }));
  const b = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'b' } }));
  await signedRequest(a, TEST_SECRET);
  await signedRequest(b, TEST_SECRET);
  const dedupeRows = await pool.query(
    "SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'calcom'"
  );
  assert.equal(Number(dedupeRows.rows[0].n), 2);
});
