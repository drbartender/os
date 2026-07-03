require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const router = require('./voice');

// --- test harness: real express+http server, global urlencoded parser (Twilio
// posts application/x-www-form-urlencoded, same as the app relies on for
// server/routes/sms.js — see server/index.js body parsers ~166-168). ----------
let _server = null;
let _baseUrl = null;

before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/voice', router);
  await new Promise((resolve) => {
    _server = app.listen(0, () => {
      _baseUrl = `http://127.0.0.1:${_server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (_server) await new Promise((r) => _server.close(r));
});

function post(path, form) {
  const body = new URLSearchParams(form).toString();
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
  };
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${path}`, { method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data, contentType: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Reset injected deps to a permissive baseline before each test.
let calls;
beforeEach(() => {
  calls = { telegram: [], audit: [], lookups: [] };
  process.env.VA_CELL = '+639171234567';
  process.env.VOICE_CALLER_ID = '+12242220082';
  process.env.VA_CALL_TIME_LIMIT_SEC = '1800';
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  router.__setVoiceDeps({
    isValidTwilioRequest: () => true,
    lookupTargetByCallSid: async (sid) => { calls.lookups.push(sid); return null; },
    recordAudit: async (row) => { calls.audit.push(row); },
    sendTelegramMessage: async (chatId, text) => { calls.telegram.push({ chatId, text }); return { ok: true }; },
    // Default: no prior audit row, so the status handler notifies as before. Tests
    // that exercise the redelivery de-dupe override this to reflect the ledger.
    auditRowExists: async () => false,
  });
});

test('/inbound returns a Dial to VA_CELL with a valid client caller as callerId, time-limited, as text/xml', async () => {
  // A bare +digits E.164 From is passed through as callerId (safe by construction).
  const res = await post('/api/voice/inbound', { From: '+13125550100' });
  assert.strictEqual(res.status, 200);
  assert.match(res.contentType || '', /text\/xml/);
  assert.match(res.text, /callerId="\+13125550100"/);
  assert.match(res.text, /timeout="20"/);
  assert.match(res.text, /timeLimit="1800"/); // hard per-leg duration cap (fix 3)
  assert.match(res.text, /<Number>\+639171234567<\/Number>/);
});

test('/inbound with a From containing a double-quote falls back to VOICE_CALLER_ID (no attribute breakout)', async () => {
  // A quote in the callerId attribute could break out of it; a non-E.164 From
  // must instead fall back to the configured 224 and never be reflected.
  const res = await post('/api/voice/inbound', { From: '+1312"><Say>pwned</Say>' });
  assert.strictEqual(res.status, 200);
  assert.match(res.contentType || '', /text\/xml/);
  assert.doesNotMatch(res.text, /pwned/); // injection payload is not reflected
  assert.match(res.text, /callerId="\+12242220082"/); // fell back to the 224
  assert.match(res.text, /<Number>\+639171234567<\/Number>/);
});

test('/bridge with a known CallSid returns an answerOnBridge Dial to the stored target', async () => {
  router.__setVoiceDeps({
    lookupTargetByCallSid: async (sid) => { calls.lookups.push(sid); return '+13125550123'; },
  });
  const res = await post('/api/voice/bridge', { CallSid: 'CA_known' });
  assert.strictEqual(res.status, 200);
  assert.match(res.contentType || '', /text\/xml/);
  assert.deepStrictEqual(calls.lookups, ['CA_known']);
  assert.match(res.text, /answerOnBridge="true"/);
  assert.match(res.text, /callerId="\+12242220082"/);
  assert.match(res.text, /timeLimit="1800"/);
  assert.match(res.text, /<Number>\+13125550123<\/Number>/);
});

test('/bridge with an unknown CallSid returns Say + Hangup, never a Dial', async () => {
  // Baseline lookup stub returns null.
  const res = await post('/api/voice/bridge', { CallSid: 'CA_unknown' });
  assert.strictEqual(res.status, 200);
  assert.match(res.contentType || '', /text\/xml/);
  assert.match(res.text, /<Say>Sorry, the call could not be completed\.<\/Say>/);
  assert.match(res.text, /<Hangup\/>/);
  assert.doesNotMatch(res.text, /<Dial/);
});

test('/status with a failed leg messages Zul on Telegram and audits the status', async () => {
  const res = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_status' });
  assert.ok(res.status === 204 || res.status === 200, `expected 2xx, got ${res.status}`);
  assert.strictEqual(calls.telegram.length, 1);
  assert.strictEqual(calls.telegram[0].chatId, '5550001');
  assert.match(calls.telegram[0].text, /didn't connect/);
  assert.strictEqual(calls.audit.length, 1);
  assert.strictEqual(calls.audit[0].status, 'failed');
  assert.strictEqual(calls.audit[0].callSid, 'CA_status');
});

test('/status dedups a redelivered dead-leg by (CallSid, CallStatus): one telegram, one audit', async () => {
  // Twilio retries status callbacks at-least-once. The guard must skip the second
  // Telegram + audit for an identical (CallSid, status). The stub models the
  // ledger: a row "exists" once recordAudit has written that exact pair.
  const seen = new Set();
  router.__setVoiceDeps({
    auditRowExists: async (callSid, status) => seen.has(`${callSid}|${status}`),
    recordAudit: async (row) => { calls.audit.push(row); seen.add(`${row.callSid}|${row.status}`); },
  });
  const first = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_dedup' });
  assert.ok(first.status === 204 || first.status === 200);
  const second = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_dedup' });
  assert.ok(second.status === 204 || second.status === 200);
  assert.strictEqual(calls.telegram.length, 1, 'exactly one Telegram across the redelivery');
  assert.strictEqual(calls.audit.length, 1, 'exactly one audit row across the redelivery');
});

test('/status with a completed leg does NOT message Zul', async () => {
  const res = await post('/api/voice/status', { CallStatus: 'completed', CallSid: 'CA_ok' });
  assert.ok(res.status === 204 || res.status === 200);
  assert.strictEqual(calls.telegram.length, 0);
  assert.strictEqual(calls.audit.length, 0);
});

test('production bad signature => 403 and no dial lookup', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  try {
    const res = await post('/api/voice/bridge', { CallSid: 'CA_x' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(calls.lookups.length, 0);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('production bad signature => 403 on /inbound (no dial forwarded)', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  try {
    const res = await post('/api/voice/inbound', { From: '+13125550100' });
    assert.strictEqual(res.status, 403);
    assert.doesNotMatch(res.text || '', /<Dial/);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('production bad signature => 403 on /status (no telegram, no audit)', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  try {
    const res = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_x' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(calls.telegram.length, 0);
    assert.strictEqual(calls.audit.length, 0);
  } finally {
    process.env.NODE_ENV = prev;
  }
});
