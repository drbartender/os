require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Requiring the router pulls in ../utils/{telegram,pendingCall,sms,usPhone}.
// None connect on require (pg pool is lazy); all effects are injected below.
const router = require('./telegram');

let server = null;
let baseUrl = null;
let calls = null;

// Fresh recording stubs for each test. Any dep can be overridden per-test.
function freshStubs(overrides = {}) {
  calls = {
    verifyTelegramSecret: [], isNewUpdate: [], sendTelegramMessage: [],
    upsertPending: [], claimForDial: [], attachCallSid: [],
    countPlacedSince: [], recordAudit: [], placeBridgedCall: [], toUsE164: [],
    getTelegramTrackedUserId: [], hasPendingNudge: [], presenceTouch: [],
  };
  router.__setDeps({
    verifyTelegramSecret: (req) => { calls.verifyTelegramSecret.push(1); return true; },
    isNewUpdate: async (id) => { calls.isNewUpdate.push(id); return true; },
    sendTelegramMessage: async (chatId, text) => { calls.sendTelegramMessage.push({ chatId, text }); return { ok: true }; },
    upsertPending: async (a) => { calls.upsertPending.push(a); },
    claimForDial: async (u) => { calls.claimForDial.push(u); return { id: 1, targetE164: '+13125551234' }; },
    attachCallSid: async (id, sid) => { calls.attachCallSid.push({ id, sid }); },
    countPlacedSince: async (i) => { calls.countPlacedSince.push(i); return 0; },
    recordAudit: async (a) => { calls.recordAudit.push(a); },
    placeBridgedCall: async (a) => { calls.placeBridgedCall.push(a); return { sid: 'CA_test_sid' }; },
    toUsE164: (raw) => { calls.toUsE164.push(raw); return String(raw).replace(/\D/g, '').length >= 10 ? '+13125551234' : null; },
    // Presence sign-of-life deps (non-DB defaults; recording stubs match the
    // harness so the "touched with 42" assertion is verifiable).
    getTelegramTrackedUserId: async () => { calls.getTelegramTrackedUserId.push(1); return 42; },
    hasPendingNudge: async () => { calls.hasPendingNudge.push(1); return false; },
    presenceTouch: (userId) => { calls.presenceTouch.push(userId); },
    ...overrides,
  });
}

async function post(path, body, headers = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d })); }
    );
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function msg(fromId, text, updateId = Date.now() + Math.floor(Math.random() * 1e6)) {
  return { update_id: updateId, message: { text, chat: { id: fromId }, from: { id: fromId } } };
}

before(async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 'testsecret';
  process.env.TELEGRAM_ALLOWED_USER_ID = '555';
  process.env.VA_CELL = '+639171234567';
  process.env.VOICE_CALLER_ID = '+12242220082';
  const app = express();
  app.use(express.json());
  app.use('/api/telegram', router);
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => { if (server) await new Promise((r) => server.close(r)); });

beforeEach(() => { process.env.TELEGRAM_ALLOWED_USER_ID = '555'; freshStubs(); });

test('bad secret_token header => 403 and never dials', async () => {
  freshStubs({ verifyTelegramSecret: () => false });
  const res = await post('/api/telegram/testsecret', msg(555, '3125551234'));
  assert.equal(res.status, 403);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.isNewUpdate.length, 0); // rejected before de-dupe is consumed
});

test('wrong URL secret path => 403 even with a valid header', async () => {
  freshStubs({ verifyTelegramSecret: () => true });
  const res = await post('/api/telegram/wrongpath', msg(555, '3125551234'));
  assert.equal(res.status, 403);
  assert.equal(calls.placeBridgedCall.length, 0);
});

test('non-allowlisted sender => 200 no-op, no dial, silent (no reply)', async () => {
  const res = await post('/api/telegram/testsecret', msg(999, 'YES'));
  assert.equal(res.status, 200);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.sendTelegramMessage.length, 0);
});

test('bootstrap mode (ALLOWED unset) echoes the sender id, never dials', async () => {
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  const res = await post('/api/telegram/testsecret', msg(777, 'hello'));
  assert.equal(res.status, 200);
  assert.equal(calls.sendTelegramMessage.length, 1);
  assert.match(calls.sendTelegramMessage[0].text, /Your Telegram id is 777/);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.upsertPending.length, 0);
});

test('valid US target => upsertPending + "Reply YES" prompt, no dial', async () => {
  const res = await post('/api/telegram/testsecret', msg(555, '(312) 555-1234'));
  assert.equal(res.status, 200);
  assert.equal(calls.upsertPending.length, 1);
  assert.equal(calls.upsertPending[0].targetE164, '+13125551234');
  assert.equal(calls.upsertPending[0].userId, 555);
  assert.ok(calls.upsertPending[0].ttlSeconds > 0);
  assert.match(calls.sendTelegramMessage[0].text, /Reply YES to call/);
  assert.equal(calls.placeBridgedCall.length, 0);
});

test('invalid target => rejected_validation audit + guidance, no upsert', async () => {
  freshStubs({ toUsE164: () => null });
  const res = await post('/api/telegram/testsecret', msg(555, 'call my cousin'));
  assert.equal(res.status, 200);
  assert.equal(calls.upsertPending.length, 0);
  assert.equal(calls.recordAudit.length, 1);
  assert.equal(calls.recordAudit[0].status, 'rejected_validation');
  assert.equal(calls.sendTelegramMessage.length, 1);
});

test('YES => cap-check, claim, placeBridgedCall ONCE, attachCallSid, recordAudit placed', async () => {
  const res = await post('/api/telegram/testsecret', msg(555, 'yes'));
  assert.equal(res.status, 200);
  assert.equal(calls.claimForDial.length, 1);
  assert.equal(calls.claimForDial[0], 555);
  assert.equal(calls.placeBridgedCall.length, 1);
  assert.equal(calls.placeBridgedCall[0].to, '+639171234567');       // VA_CELL, never normalized
  assert.equal(calls.placeBridgedCall[0].callerId, '+12242220082');  // the 224
  assert.match(calls.placeBridgedCall[0].url, /\/api\/voice\/bridge$/);
  assert.match(calls.placeBridgedCall[0].statusCallback, /\/api\/voice\/status$/);
  assert.equal(calls.placeBridgedCall[0].timeLimit, 1800);
  assert.equal(calls.attachCallSid.length, 1);
  assert.deepEqual(calls.attachCallSid[0], { id: 1, sid: 'CA_test_sid' });
  assert.equal(calls.recordAudit.at(-1).status, 'placed');
  // PII: reply and log redact to last-4, not the full number.
  assert.match(calls.sendTelegramMessage[0].text, /1234/);
  assert.doesNotMatch(calls.sendTelegramMessage[0].text, /3125551234/);
  // Sign of life stamps on every allowed message.
  assert.deepEqual(calls.presenceTouch, [42]);
});

test('YES with no claimable pending row => expired message, no dial', async () => {
  freshStubs({ claimForDial: async () => null });
  const res = await post('/api/telegram/testsecret', msg(555, 'YES'));
  assert.equal(res.status, 200);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.match(calls.sendTelegramMessage[0].text, /expired|nothing to confirm/i);
});

test('cap trip => rejected_cap audit, no claim, no dial', async () => {
  freshStubs({ countPlacedSince: async () => 999 });
  const res = await post('/api/telegram/testsecret', msg(555, 'YES'));
  assert.equal(res.status, 200);
  assert.equal(calls.claimForDial.length, 0);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.recordAudit.at(-1).status, 'rejected_cap');
  assert.equal(calls.sendTelegramMessage.length, 1);
});

test('duplicate update_id => 200 no-op (Telegram retry safety)', async () => {
  freshStubs({ isNewUpdate: async () => false });
  const res = await post('/api/telegram/testsecret', msg(555, 'YES'));
  assert.equal(res.status, 200);
  assert.equal(calls.claimForDial.length, 0);
  assert.equal(calls.placeBridgedCall.length, 0);
});

test('nudge pending + "yes" + no claimable call => nudge ack, no dial', async () => {
  freshStubs({ claimForDial: async () => null, hasPendingNudge: async () => true });
  const res = await post('/api/telegram/testsecret', msg(555, 'yes'));
  assert.equal(res.status, 200);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.sendTelegramMessage.at(-1).text, 'Got it, keeping you on desk.');
});

test('nudge pending + "yes" + live pending call => call places (confirm wins over ack)', async () => {
  freshStubs({ hasPendingNudge: async () => true });
  const res = await post('/api/telegram/testsecret', msg(555, 'yes'));
  assert.equal(res.status, 200);
  assert.equal(calls.claimForDial.length, 1);
  assert.equal(calls.placeBridgedCall.length, 1);
  assert.equal(calls.recordAudit.at(-1).status, 'placed');
  assert.match(calls.sendTelegramMessage.at(-1).text, /Calling/);
});

test('nudge pending + unparseable text => ack, no rejected_validation audit', async () => {
  freshStubs({ toUsE164: () => null, hasPendingNudge: async () => true });
  const res = await post('/api/telegram/testsecret', msg(555, 'still here'));
  assert.equal(res.status, 200);
  assert.equal(calls.sendTelegramMessage.at(-1).text, 'Got it, keeping you on desk.');
  assert.equal(calls.recordAudit.filter((a) => a.status === 'rejected_validation').length, 0);
  assert.equal(calls.upsertPending.length, 0);
});

test('no nudge pending + unparseable text => rejected_validation audit + guidance (unchanged)', async () => {
  freshStubs({ toUsE164: () => null, hasPendingNudge: async () => false });
  const res = await post('/api/telegram/testsecret', msg(555, 'call my cousin'));
  assert.equal(res.status, 200);
  assert.equal(calls.recordAudit.length, 1);
  assert.equal(calls.recordAudit[0].status, 'rejected_validation');
  assert.match(calls.sendTelegramMessage.at(-1).text, /does not look like a US number/);
});
