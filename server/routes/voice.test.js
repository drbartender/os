require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const router = require('./voice');
// The SLOTS table itself, so a route test can ask the emission site the same
// question the migration path will (see 'the DAY Gather follows the GREETING
// TABLE' below). Same module instance the router holds.
const twiml = require('../utils/voicemailTwiml');

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

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${path}`, { method: 'GET' }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], bytes }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Reset injected deps to a permissive baseline before each test.
let calls;
beforeEach(() => {
  calls = {
    telegram: [], audit: [], lookups: [],
    claims: [], deliveryClaims: [], marks: [], fetches: [], deletes: [], audio: [], sentry: [],
    alerts: [],
  };
  process.env.VA_CELL = '+639171234567';
  process.env.VOICE_CALLER_ID = '+12242220082';
  process.env.VA_CALL_TIME_LIMIT_SEC = '1800';
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  process.env.VOICEMAIL_ENABLED = 'true';
  process.env.VM_MAX_LENGTH_SEC = '120';
  process.env.VM_DAILY_CAP = '50';
  delete process.env.VM_GREETING_URL;
  delete process.env.VM_GREETING_URL_PRIMARY;
  process.env.VM_PRIMARY_DIAL_TARGET = '+13125889401';
  process.env.VM_PRIMARY_RING_SEC = '18';
  // Default OFF is what the older tests assert against; never leak the flag.
  // The prompt delete keeps the /press 1/ assertion honest on a box whose .env
  // sets VM_ESCALATION_PROMPT=none.
  delete process.env.VM_ESCALATION_ENABLED;
  delete process.env.VM_ESCALATION_PROMPT;
  delete process.env.VM_NIGHT_GREETING_URL;
  delete process.env.VM_NIGHT_GREETING_URL_PRIMARY;
  // PIN THE CLOCK TO DAY. Night legitimately changes the missed-call document
  // (spec 2026-08-19), so without this the suite's outcome depends on what time
  // the developer happens to run it: six tests here go red between 21:00 and
  // 09:00 Chicago on a machine where nothing is wrong. Night is covered by its
  // own tests below, which set this explicitly.
  // Pin day by INJECTION, not by an env window. No window string can pin either
  // side: half-open membership covers at most 1439 of 1440 minutes, so
  // '00:00-00:00' is never-night but '00:00-23:59' is day at 23:59, which left
  // three night tests red for one minute a day. isNight itself is unit-tested
  // against injected clocks in voicemailLine.test.js.
  router.__setVoiceDeps({ isNight: () => false });
  delete process.env.VM_NIGHT_TZ;
  router.__setVoiceDeps({
    isValidTwilioRequest: () => true,
    // Voicemail baseline (spec 2026-07-22): claim wins, cap clear, delivery
    // succeeds. Individual tests override to exercise the other branches.
    claimMissedCall: async (args) => { calls.claims.push(args); return true; },
    countVoicemailsSince: async () => 0,
    claimDelivery: async (args) => { calls.deliveryClaims.push(args); return { fromE164: '+13125550147', line: 'zul', listenToken: '11111111-2222-4333-8444-555555555555' }; },
    markDelivery: async (args) => { calls.marks.push(args); },
    deleteRecording: async (sid) => { calls.deletes.push(sid); return true; },
    isRecordingSid: (v) => typeof v === 'string' && /^RE[0-9a-f]{32}$/.test(v),
    // deliverVoicemail owns fetch + upload + the three-outcome branch + delete.
    // The default stub models a successful delivery.
    deliverVoicemail: async (job) => {
      calls.fetches.push(job.recordingSid);
      calls.audio.push({ chatId: job.chatId, job });
      calls.deletes.push(job.recordingSid);
      calls.marks.push({ callSid: job.callSid, status: 'delivered' });
      return 'delivered';
    },
    // Line-aware operator alerts (channel choice pinned in voicemail.test.js).
    alertOperator: async (args) => { calls.alerts.push(args); },
    captureMessage: (msg) => { calls.sentry.push(msg); },
    captureException: (err) => { calls.sentry.push(err && err.message); },
    lookupTargetByCallSid: async (sid) => { calls.lookups.push(sid); return null; },
    sendTelegramMessage: async (chatId, text) => { calls.telegram.push({ chatId, text }); return { ok: true }; },
    // Atomic-claim baseline: the claim always wins (no prior row) and its INSERT is
    // the audit row now. Tests that exercise dedup/race/retry override this with a
    // shared-Set claim that models the real ON CONFLICT atomicity + release DELETE.
    claimDeadLegAudit: async ({ triggeredBy, callSid, status }) => {
      calls.audit.push({ triggeredBy, callSid, status });
      return true;
    },
    releaseDeadLegAudit: async () => {},
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
  // Twilio retries status callbacks at-least-once. The atomic claim must let only
  // the first (CallSid, status) win; the redelivery's claim loses (DO NOTHING) and
  // it skips the Telegram + audit. The shared Set models the real ON CONFLICT.
  const set = new Set();
  router.__setVoiceDeps({
    claimDeadLegAudit: async ({ triggeredBy, callSid, status }) => {
      const key = `${callSid}|${status}`;
      if (set.has(key)) return false;
      set.add(key);
      calls.audit.push({ triggeredBy, callSid, status });
      return true;
    },
    releaseDeadLegAudit: async ({ callSid, status }) => {
      set.delete(`${callSid}|${status}`);
      calls.audit = calls.audit.filter((a) => !(a.callSid === callSid && a.status === status));
    },
  });
  const first = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_dedup' });
  assert.ok(first.status === 204 || first.status === 200);
  const second = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_dedup' });
  assert.ok(second.status === 204 || second.status === 200);
  assert.strictEqual(calls.telegram.length, 1, 'exactly one Telegram across the redelivery');
  assert.strictEqual(calls.audit.length, 1, 'exactly one audit row across the redelivery');
});

test('/status: two CONCURRENT dead-leg callbacks for the same (CallSid, status) alert exactly once', async () => {
  // The atomic claim (INSERT ... ON CONFLICT DO NOTHING) is faithfully modeled as a
  // synchronous check-and-add on a shared Set: exactly one concurrent caller wins.
  // The winner blocks in sendTelegramMessage on a barrier; the loser returns 204
  // WITHOUT entering the send. BINDING DELTA: gate the barrier on
  // (send entries + completed 204 responses) reaching 2 — a barrier that waits for
  // BOTH requests to enter the send would hang forever, since only the winner does.
  const set = new Set();
  let sendEntries = 0;
  let responsesDone = 0;
  let releaseBarrier;
  const barrier = new Promise((r) => { releaseBarrier = r; });
  const maybeRelease = () => { if (sendEntries + responsesDone >= 2) releaseBarrier(); };
  router.__setVoiceDeps({
    claimDeadLegAudit: async ({ triggeredBy, callSid, status }) => {
      const key = `${callSid}|${status}`;
      if (set.has(key)) return false;
      set.add(key);
      calls.audit.push({ triggeredBy, callSid, status });
      return true;
    },
    releaseDeadLegAudit: async ({ callSid, status }) => { set.delete(`${callSid}|${status}`); },
    sendTelegramMessage: async (chatId, text) => {
      sendEntries += 1;
      calls.telegram.push({ chatId, text });
      maybeRelease();
      await barrier;
      return { ok: true };
    },
  });
  const p1 = post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_race' })
    .then((r) => { responsesDone += 1; maybeRelease(); return r; });
  const p2 = post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_race' })
    .then((r) => { responsesDone += 1; maybeRelease(); return r; });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok((r1.status === 204 || r1.status === 200) && (r2.status === 204 || r2.status === 200));
  assert.strictEqual(calls.telegram.length, 1, 'exactly one Telegram across the concurrent race');
  assert.strictEqual(calls.audit.length, 1, 'exactly one audit row across the concurrent race');
});

test('/status: a failed send releases the claim so the redelivery re-claims and delivers', async () => {
  // Proves the fix does not regress the deliberate retry-on-failed-send: the first
  // send throws, the claim is released, and the sequential redelivery re-claims and
  // delivers exactly one successful Telegram + one surviving audit row.
  const set = new Set();
  let sendCalls = 0;
  router.__setVoiceDeps({
    claimDeadLegAudit: async ({ triggeredBy, callSid, status }) => {
      const key = `${callSid}|${status}`;
      if (set.has(key)) return false;
      set.add(key);
      calls.audit.push({ triggeredBy, callSid, status });
      return true;
    },
    releaseDeadLegAudit: async ({ callSid, status }) => {
      set.delete(`${callSid}|${status}`);
      calls.audit = calls.audit.filter((a) => !(a.callSid === callSid && a.status === status));
    },
    sendTelegramMessage: async (chatId, text) => {
      sendCalls += 1;
      if (sendCalls === 1) throw new Error('telegram 500');
      calls.telegram.push({ chatId, text });
      return { ok: true };
    },
  });
  const first = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_retry' });
  assert.ok(first.status === 204 || first.status === 200);
  assert.strictEqual(set.size, 0, 'the failed send released its claim');
  assert.strictEqual(calls.telegram.length, 0, 'no telegram delivered on the failed first send');
  const second = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_retry' });
  assert.ok(second.status === 204 || second.status === 200);
  assert.strictEqual(calls.telegram.length, 1, 'the redelivery delivered exactly one telegram');
  assert.strictEqual(calls.audit.length, 1, 'exactly one surviving audit row after the retry');
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

// ── 224-inbound voicemail (spec 2026-07-22) ─────────────────────────────────

// Twilio CallSids are 'CA' + 32 hex, and the voicemail limiter shape-validates
// its key (everything malformed collapses into ONE shared bucket, so a flood of
// junk SIDs cannot mint unbounded keys). Tests must therefore use realistic
// SIDs or they all land in that shared bucket and trip it.
const crypto = require('node:crypto');
const cs = (label) => 'CA' + crypto.createHash('md5').update(String(label)).digest('hex');

const GOOD_RE = 'RE' + 'a1b2c3d4'.repeat(4);
// The ping and the delivery both run detached, after the response, on purpose.
const settle = () => new Promise((r) => setTimeout(r, 30));

test('/inbound Dial action stamps line=zul', async () => {
  const res = await post('/api/voice/inbound', { From: '+13125550147', CallSid: cs('CA1') });
  assert.match(res.text, /action="[^"]*\/api\/voice\/inbound\/missed\?line=zul"/);
  assert.match(res.text, /method="POST"/);
});

test('/inbound fails CLOSED on a bad signature with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    router.__setVoiceDeps({ isValidTwilioRequest: () => false });
    const res = await post('/api/voice/inbound', { From: '+13125550147', CallSid: cs('CAsig0') });
    assert.equal(res.status, 403, 'a dev signature skip must not dial a PH cell');
  } finally {
    // beforeEach does not restore NODE_ENV; without the finally a failed assert
    // would silently change the environment for every later test in this file.
    if (saved !== undefined) process.env.NODE_ENV = saved;
  }
});

test('/inbound/primary dials the primary target and stamps line=primary', async () => {
  // A NON-default ring value: 18 is also primaryRingSec()'s fallback, so
  // asserting it would pass even if the route hardcoded the number.
  process.env.VM_PRIMARY_RING_SEC = '22';
  const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAp1') });
  assert.match(res.text, /<Dial[^>]*timeout="22"/);
  assert.match(res.text, /action="[^"]*\/api\/voice\/inbound\/missed\?line=primary"/);
  assert.match(res.text, /<Number>\+13125889401<\/Number>/);
  assert.match(res.text, /timeLimit="1800"/);
});

test('/inbound/primary passes the caller through as caller ID', async () => {
  const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAp2') });
  assert.match(res.text, /callerId="\+13125550147"/);
});

test('/inbound/primary falls back to VOICE_CALLER_ID for a junk From', async () => {
  // Same rule as /inbound: the From lands in an ATTRIBUTE and xmlEscape does not
  // escape quotes, so anything not bare +digits is replaced, never escaped.
  const res = await post('/api/voice/inbound/primary', {
    From: '+1312"><Say>pwned</Say>', CallSid: cs('CAp3'),
  });
  assert.doesNotMatch(res.text, /pwned/);
  assert.match(res.text, /callerId="\+12242220082"/);
});

test('/inbound/primary fails CLOSED on a bad signature even with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    router.__setVoiceDeps({ isValidTwilioRequest: () => false });
    const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAp4') });
    assert.equal(res.status, 403);
  } finally {
    if (saved !== undefined) process.env.NODE_ENV = saved;
  }
});

test('/inbound/primary apologizes instead of dialing when the target is unset', async () => {
  delete process.env.VM_PRIMARY_DIAL_TARGET;
  const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAp5') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Say/);
  assert.match(res.text, /<Hangup\/>/);
});

test('/inbound/primary refuses a malformed target instead of emitting it', async () => {
  // Missing '+', and an attribute-breakout attempt: both must apologize, and
  // nothing from the malformed value may reach the document.
  for (const bad of ['3125889401', '+1312588940"><Dial>evil</Dial>']) {
    process.env.VM_PRIMARY_DIAL_TARGET = bad;
    const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs(`CAp6${bad}`) });
    assert.doesNotMatch(res.text, /<Dial/, `"${bad}" must not dial`);
    assert.doesNotMatch(res.text, /evil/);
    assert.match(res.text, /<Say/);
  }
});

test('/inbound/missed wraps the greeting in a Gather when escalation is enabled', async () => {
  process.env.VM_ESCALATION_ENABLED = 'true';
  const res = await post('/api/voice/inbound/missed?line=zul', {
    DialCallStatus: 'no-answer', CallSid: cs('CAg1'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /<Gather[^>]*numDigits="1"[^>]*timeout="4"/);
  assert.match(res.text, /action="[^"]*\/api\/voice\/escalate\?line=zul"/);
  // Her 2026-08-19 recording says the offer itself, so the document carries no
  // spoken prompt. What must be true is that the greeting sits INSIDE the
  // Gather, which is what makes the keypress reachable while it plays.
  assert.match(res.text, /<Gather[^>]*>\s*<Play>[^<]*zul-greeting-day\.mp3<\/Play>\s*<\/Gather>/);
  // The Record must sit AFTER </Gather>: a caller who presses nothing falls
  // through to it, which is how "just leave a message" stays the default.
  assert.match(res.text, /<\/Gather><Record/);
});

test('/inbound/missed with escalation OFF still LISTENS, because the greeting still offers press 1', async () => {
  process.env.VM_ESCALATION_ENABLED = 'false';
  const res = await post('/api/voice/inbound/missed?line=zul', {
    DialCallStatus: 'no-answer', CallSid: cs('CAg2'), From: '+13125550147',
  });
  await settle();
  // THE TRAP THIS CLOSES (found 2026-08-19, cross-LLM review; fixed 2026-08-20):
  // the switch used to drop the <Gather> while the offer stayed inside the
  // recording, so an operator flipping it during an incident made every caller
  // press 1 into a document that was not listening, and drop to the beep. No env
  // var can edit an mp3, so the Gather now follows the GREETING, not the switch.
  assert.match(res.text, /<Gather[^>]*action="[^"]*\/api\/voice\/escalate\?line=zul"/);
  assert.match(res.text, /<Gather[^>]*>\s*<Play>[^<]*zul-greeting-day\.mp3<\/Play>\s*<\/Gather>/);
  // Never ADD an offer for a feature that is off. NOTE this assertion does not
  // by itself PROVE that: VM_GREETING_URL is unset here, so needsAppendedOffer
  // is already false on its own and this passes either way. The guard is pinned
  // by the NEXT test down, which sets an https override so needsAppendedOffer is
  // true and only the `escalating &&` keeps the prompt silent. Kept here as a
  // regression floor, not as the proof. (Corrected 2026-08-20 by review: an
  // assertion that passes for a reason other than the one it names is the exact
  // shape this file's own lessons warn about.)
  assert.doesNotMatch(res.text, /get someone else on the line/i);
  assert.match(res.text, /<\/Gather><Record/, 'silence still falls through to the beep');
  // And the spend guarantee is untouched: voiceEscalate.js tests the switch
  // itself, so a digit arriving here claims nothing and dials nobody. Pinned in
  // voiceEscalate.test.js ("VM_ESCALATION_ENABLED=false makes the digit handler
  // a plain recording").
});

test('escalation OFF appends no prompt even behind an UNKNOWN override recording', async () => {
  // The riskiest combination: the override's script is unknown, so the Gather is
  // emitted on doubt. The prompt must still stay silent, or flipping the switch
  // off would have Polly announce a feature that cannot run.
  process.env.VM_ESCALATION_ENABLED = 'false';
  process.env.VM_GREETING_URL = 'https://cdn.example.com/z.mp3';
  const res = await post('/api/voice/inbound/missed?line=zul', {
    DialCallStatus: 'no-answer', CallSid: cs('CAg2b'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /<Gather/, 'unknown recording may say press one, so listen');
  assert.doesNotMatch(res.text, /get someone else on the line/i);
  assert.doesNotMatch(res.text, /press 1/i);
});

test('/inbound/missed Gather targets the right line', async () => {
  process.env.VM_ESCALATION_ENABLED = 'true';
  const res = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAg3'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /action="[^"]*\/api\/voice\/escalate\?line=primary"/);
});

test('an instant answer on the primary line logs but never pages Sentry (canary demoted 2026-08-14)', async () => {
  const savedDsn = process.env.SENTRY_DSN_SERVER;
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  try {
    const res = await post('/api/voice/inbound/missed?line=primary', {
      DialCallStatus: 'completed', DialCallDuration: '1', CallSid: cs('CAcan1'), From: '+13125550147',
    });
    await settle();
    // Still the cheap branch: an answered call must never record or ping.
    assert.match(res.text, /<Hangup\/>/);
    assert.doesNotMatch(res.text, /<Record/);
    assert.equal(calls.telegram.length, 0);
    // Log-only by decision (Dallas 2026-08-14): DialCallDuration is connected
    // time, not time-to-answer, so a short leg is a fast HUMAN, not an
    // interception. The dialSec console line is the surviving telemetry.
    assert.ok(
      !calls.sentry.some((m) => /interception/i.test(String(m))),
      'the demoted canary must not page Sentry on a fast human answer'
    );
  } finally {
    if (savedDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
    else process.env.SENTRY_DSN_SERVER = savedDsn;
  }
});

test('a normal answered call on the primary line raises no canary', async () => {
  const savedDsn = process.env.SENTRY_DSN_SERVER;
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  try {
    const res = await post('/api/voice/inbound/missed?line=primary', {
      DialCallStatus: 'completed', DialCallDuration: '45', CallSid: cs('CAcan2'), From: '+13125550147',
    });
    await settle();
    assert.match(res.text, /<Hangup\/>/);
    assert.equal(calls.sentry.length, 0, 'a real conversation is not an anomaly');
  } finally {
    if (savedDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
    else process.env.SENTRY_DSN_SERVER = savedDsn;
  }
});

test('an instant answer on the zul line raises no canary', async () => {
  const savedDsn = process.env.SENTRY_DSN_SERVER;
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  try {
    const res = await post('/api/voice/inbound/missed?line=zul', {
      DialCallStatus: 'completed', DialCallDuration: '1', CallSid: cs('CAcan3'), From: '+13125550147',
    });
    await settle();
    assert.match(res.text, /<Hangup\/>/);
    assert.equal(calls.sentry.length, 0);
  } finally {
    if (savedDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
    else process.env.SENTRY_DSN_SERVER = savedDsn;
  }
});

test('/inbound/missed default document is pinned byte-for-byte (the escalation-off contract)', async () => {
  // THE golden string for the live 0082 path, with the flag unset (default OFF).
  // Substring matches cannot catch a reordered document (greeting after the
  // beep) or a dropped <Hangup/> (billed dead air); this strictEqual is the
  // alarm for every later change to the emission.
  //
  // The document CHANGED on 2026-08-20 and the change is the point. It has moved
  // twice now: on 2026-08-19 the <Play> target became Zul's re-recorded mp3, and
  // on 2026-08-20 the <Gather> arrived, because that recording says "press one"
  // and a document that speaks an offer must listen for it. What this pin no
  // longer asserts is any equivalence to PRE-FEATURE production: the old comment
  // here promised the escalation-off document was byte-identical to it, and that
  // promise died with the re-recording. The contract now is honesty, not
  // reversion, and the switch's real guarantee lives one file over --
  // voiceEscalate.js refuses to claim or dial while it is off.
  const { API_URL } = require('../utils/urls');
  const res = await post('/api/voice/inbound/missed', {
    DialCallStatus: 'no-answer', CallSid: cs('CAgold1'), From: '+13125550147',
  });
  await settle();
  assert.strictEqual(
    res.text,
    '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response>'
    + `<Gather numDigits="1" timeout="4" action="${API_URL}/api/voice/escalate?line=zul" method="POST">`
    + `<Play>${API_URL}/api/voice/audio/zul-greeting-day.mp3</Play>`
    + '</Gather>'
    + '<Record maxLength="120" playBeep="true" trim="trim-silence" finishOnKey="#"'
    + ` recordingStatusCallback="${API_URL}/api/voice/inbound/voicemail"`
    + ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>'
    + '<Hangup/></Response>'
  );
});

test('/inbound/missed defaults to the zul line and claims it', async () => {
  const res = await post('/api/voice/inbound/missed', {
    DialCallStatus: 'no-answer', CallSid: cs('CAline1'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /<Play>[^<]*\/api\/voice\/audio\/zul-greeting-day\.mp3<\/Play>/, 'Zul recording');
  assert.equal(calls.claims[0].line, 'zul');
});

test('/inbound/missed?line=primary claims primary and plays the Dallas greeting', async () => {
  const res = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAline2'), From: '+13125550147',
  });
  await settle();
  assert.equal(calls.claims[0].line, 'primary');
  // Since 2026-08-19 his greeting is a RECORDING, so the words live in the mp3
  // rather than the document. The load-bearing assertion is unchanged: Zul's
  // recording must never play on his line.
  assert.match(res.text, /<Play>.*primary-greeting-day\.mp3<\/Play>/);
  assert.doesNotMatch(res.text, /this is Zul/i);
  assert.doesNotMatch(res.text, /zul-greeting/, "Zul's recording must never play on his line");
  assert.doesNotMatch(res.text, /\/api\/voice\/greeting\.mp3/, 'Zul\'s recording must never play on Dallas\'s line');
  // The GV dial target already shows Dallas the miss natively; pinging Zul
  // about his line would invite a callback from the wrong person.
  assert.equal(calls.telegram.length, 0, 'a primary miss never pings Zul');
});

test('/inbound/missed coerces an unknown line to zul', async () => {
  await post('/api/voice/inbound/missed?line=bogus', {
    DialCallStatus: 'no-answer', CallSid: cs('CAline3'), From: '+13125550147',
  });
  await settle();
  assert.equal(calls.claims[0].line, 'zul');
});

test('/inbound/missed on an answered call pings nobody and returns no Record', async () => {
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'completed', CallSid: cs('CA2'), From: '+13125550147' });
  await settle();
  assert.match(res.text, /<Hangup\/>/);
  assert.doesNotMatch(res.text, /<Record/);
  assert.strictEqual(calls.telegram.length, 0);
  assert.strictEqual(calls.claims.length, 0, 'an answered call must not even claim');
});

test('/inbound/missed takes the cheap branch on an unrecognized DialCallStatus', async () => {
  for (const DialCallStatus of ['', 'in-progress', 'banana']) {
    calls.telegram.length = 0;
    const res = await post('/api/voice/inbound/missed', { DialCallStatus, CallSid: cs('CA3'), From: '+13125550147' });
    await settle();
    assert.doesNotMatch(res.text, /<Record/, `status "${DialCallStatus}" must not record`);
    assert.strictEqual(calls.telegram.length, 0);
  }
});

test('/inbound/missed returns the greeting and Record, and pings twice', async () => {
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CA4'), From: '+13125550147' });
  assert.match(res.text, /<Play>[^<]*\/api\/voice\/audio\/zul-greeting-day\.mp3<\/Play>/, 'default greeting plays the recorded mp3');
  assert.doesNotMatch(res.text, /<Say/, 'default greeting is the recording, not the synthetic voice');
  assert.match(res.text, /<Record[^>]*maxLength="120"/);
  assert.match(res.text, /recordingStatusCallback="[^"]*\/api\/voice\/inbound\/voicemail"/);
  assert.doesNotMatch(res.text, /<Record[^>]*\saction=/, 'Record must NOT carry an action attribute');
  await settle();
  assert.strictEqual(calls.telegram.length, 2);
  assert.strictEqual(calls.telegram[1].text, '+13125550147', 'the number must be alone in its own message');
  assert.doesNotMatch(calls.telegram[0].text, /\+13125550147/, 'stray digits would break toUsE164 on copy-paste');
});

// The GET /greeting.mp3 route moved to server/routes/voiceAssets.js on
// 2026-08-19 (voice.js was at its 700-line soft cap). Its coverage moved too,
// and got stronger: voiceAssets.test.js asserts the served bytes EQUAL the
// bundled file, not merely that some audio came back.

test('/inbound/missed <Play>s VM_GREETING_URL when set to an override URL', async () => {
  process.env.VM_GREETING_URL = 'https://cdn.example.com/greet.mp3';
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CAgreet1'), From: '+13125550147' });
  await settle();
  assert.match(res.text, /<Play>https:\/\/cdn\.example\.com\/greet\.mp3<\/Play>/);
  assert.doesNotMatch(res.text, /\/api\/voice\/greeting\.mp3/, 'the override replaces the bundled default');
});

test('/inbound/missed falls back to the Polly <Say> when VM_GREETING_URL=say', async () => {
  process.env.VM_GREETING_URL = 'say';
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CAgreet2'), From: '+13125550147' });
  await settle();
  assert.match(res.text, /<Say voice="Polly\.Joanna-Neural">[^<]*this is Zul[^<]*<\/Say>/i);
  assert.doesNotMatch(res.text, /<Play>/, 'the say kill-switch emits no Play');
});

test('/inbound/missed on a blocked caller records, stores NULL, and sends only prose', async () => {
  for (const From of ['', '+266696687']) {
    calls.telegram.length = 0; calls.claims.length = 0;
    const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs(`CA5${From}`), From });
    assert.match(res.text, /<Record/);
    await settle();
    assert.strictEqual(calls.claims[0].fromE164, null, 'a blocked caller is stored as NULL');
    assert.strictEqual(calls.telegram.length, 1);
    assert.doesNotMatch(calls.telegram[0].text, /\+12242220082/, 'never fall back to VOICE_CALLER_ID');
  }
});

test('/inbound/missed names a non-NANP caller in prose and sends no bare-number message', async () => {
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CA5b'), From: '+442071838750' });
  assert.match(res.text, /<Record/);
  await settle();
  assert.strictEqual(calls.telegram.length, 1, 'the bridge cannot dial it, so no copy-paste message');
  assert.match(calls.telegram[0].text, /\+442071838750/, 'she must still learn who called');
  assert.doesNotMatch(calls.telegram[0].text, /Number follows/);
});

test('/inbound/missed on a lost claim (Twilio redelivery) pings nobody', async () => {
  router.__setVoiceDeps({ claimMissedCall: async () => false });
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CA6'), From: '+13125550147' });
  await settle();
  assert.match(res.text, /<Hangup\/>/);
  assert.doesNotMatch(res.text, /<Record/);
  assert.strictEqual(calls.telegram.length, 0);
});

test('/inbound/missed with VOICEMAIL_ENABLED=false restores pre-feature behavior', async () => {
  process.env.VOICEMAIL_ENABLED = 'false';
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CA7'), From: '+13125550147' });
  await settle();
  assert.match(res.text, /<Hangup\/>/);
  assert.doesNotMatch(res.text, /<Record/);
  assert.strictEqual(calls.telegram.length, 0);
});

test('/inbound/missed over VM_DAILY_CAP records nothing and pings nobody', async () => {
  router.__setVoiceDeps({ countVoicemailsSince: async () => 51 });
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CA8'), From: '+13125550147' });
  await settle();
  assert.doesNotMatch(res.text, /<Record/);
  assert.strictEqual(calls.telegram.length, 0);
});

test('/inbound/missed fails closed when the cap cannot be read', async () => {
  router.__setVoiceDeps({ countVoicemailsSince: async () => { throw new Error('db down'); } });
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CA8b'), From: '+13125550147' });
  await settle();
  assert.doesNotMatch(res.text, /<Record/, 'no spend without a working cap');
});

test('/inbound/missed fails closed on a bad signature even with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    router.__setVoiceDeps({ isValidTwilioRequest: () => false });
    const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CA9'), From: '+13125550147' });
    assert.strictEqual(res.status, 403, 'no dev warn-and-allow on a billed, destructive path');
  } finally {
    // beforeEach does not restore NODE_ENV, so a throw above would silently
    // change the environment for every later test in this file.
    if (saved !== undefined) process.env.NODE_ENV = saved;
  }
});

test('/inbound/voicemail answers 204 and hands the claimed job to deliverVoicemail', async () => {
  // The upload/delete/status decision itself lives in utils/voicemail.js and is
  // pinned there (voicemail.test.js); this pins only the route's handoff.
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB1'), RecordingDuration: '14',
  });
  assert.strictEqual(res.status, 204);
  await settle();
  assert.strictEqual(calls.audio.length, 1);
  assert.strictEqual(calls.audio[0].job.fromE164, '+13125550147');
  assert.strictEqual(calls.audio[0].job.recordingSid, GOOD_RE);
});

test('/inbound/voicemail delivers exactly once on a duplicate callback', async () => {
  router.__setVoiceDeps({ claimDelivery: async () => null });
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB2'), RecordingDuration: '14',
  });
  assert.strictEqual(res.status, 204);
  await settle();
  assert.strictEqual(calls.audio.length, 0);
  assert.strictEqual(calls.deletes.length, 0);
});

test('/inbound/voicemail never fetches on a non-completed RecordingStatus', async () => {
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'failed', RecordingSid: GOOD_RE, CallSid: cs('CB3'), RecordingDuration: '14',
  });
  assert.strictEqual(res.status, 204);
  await settle();
  assert.strictEqual(calls.fetches.length, 0);
});

test('/inbound/voicemail never fetches a malformed or foreign RecordingSid', async () => {
  for (const RecordingSid of ['', 'RE-nope', '../../Accounts/AC1/Recordings/RE1', 'RE' + 'A'.repeat(32)]) {
    calls.fetches.length = 0;
    const res = await post('/api/voice/inbound/voicemail', {
      RecordingStatus: 'completed', RecordingSid, CallSid: cs('CB4'), RecordingDuration: '14',
    });
    assert.strictEqual(res.status, 204);
    await settle();
    assert.strictEqual(calls.fetches.length, 0, `sid "${RecordingSid}" must not be fetched`);
  }
});

test('/inbound/voicemail ignores a body-supplied RecordingUrl entirely', async () => {
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB5'), RecordingDuration: '14',
    RecordingUrl: 'https://evil.example/steal',
  });
  assert.strictEqual(res.status, 204);
  await settle();
  assert.deepStrictEqual(calls.fetches, [GOOD_RE], 'fetch takes a SID, never a URL');
});

test('/inbound/voicemail drops a genuinely short recording without uploading', async () => {
  for (const RecordingDuration of ['1', '0']) {
    calls.audio.length = 0; calls.deletes.length = 0; calls.marks.length = 0;
    await post('/api/voice/inbound/voicemail', {
      RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB6'), RecordingDuration,
    });
    await settle();
    assert.strictEqual(calls.audio.length, 0, `duration "${RecordingDuration}" must not upload`);
    assert.deepStrictEqual(calls.deletes, [GOOD_RE]);
    assert.strictEqual(calls.marks.at(-1).status, 'empty');
  }
});

test('/inbound/voicemail on a gated (skipped) send keeps the recording and never pages Sentry', async () => {
  router.__setVoiceDeps({ deliverVoicemail: async () => 'skipped' });
  await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB7'), RecordingDuration: '14',
  });
  await settle();
  assert.strictEqual(calls.deletes.length, 0, 'a skipped send must never delete the only copy');
  assert.strictEqual(calls.sentry.length, 0, 'SEND_NOTIFICATIONS=false is a config, not an incident');
  assert.strictEqual(calls.telegram.length, 0, 'and it must not nag her either');
});

test('/inbound/voicemail on a failed send keeps the recording, warns her, and pages Sentry', async () => {
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  try {
    router.__setVoiceDeps({ deliverVoicemail: async () => 'failed' });
    await post('/api/voice/inbound/voicemail', {
      RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB8'), RecordingDuration: '14',
    });
    await settle();
    assert.strictEqual(calls.deletes.length, 0);
    assert.ok(calls.alerts.some((a) => a.line === 'zul' && /\+13125550147/.test(a.text)),
      'she still learns who called (channel choice pinned in voicemail.test.js)');
    assert.strictEqual(calls.sentry.length, 1, 'this one IS an incident');
  } finally {
    // try/finally, or a failing assertion leaks the DSN into every later test.
    delete process.env.SENTRY_DSN_SERVER;
  }
});

test('/inbound/voicemail on a media fetch failure keeps the recording and warns her', async () => {
  router.__setVoiceDeps({ deliverVoicemail: async () => 'unfetchable' });
  await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB9'), RecordingDuration: '14',
  });
  await settle();
  assert.strictEqual(calls.audio.length, 0);
  assert.strictEqual(calls.deletes.length, 0);
  assert.ok(calls.alerts.some((a) => a.line === 'zul' && /could not be retrieved/.test(a.text)));
});

test('/inbound/voicemail in bootstrap mode keeps the row RETRYABLE, not parked', async () => {
  // Writing status='skipped' here put the row outside BOTH the sweep filter and
  // the prune, stranding real client audio in Twilio forever. The rollout
  // procedure walks through this exact state (deploy with the id unset, then set
  // it and redeploy), so the voicemail has to survive it.
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB10'), RecordingDuration: '14',
  });
  await settle();
  assert.strictEqual(calls.audio.length, 0);
  assert.strictEqual(calls.deletes.length, 0);
  assert.strictEqual(calls.marks.length, 0, 'no status write: the row stays recorded and swept');
});

test('/inbound/voicemail fails closed on a bad signature even with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    router.__setVoiceDeps({ isValidTwilioRequest: () => false });
    const res = await post('/api/voice/inbound/voicemail', {
      RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB11'), RecordingDuration: '14',
    });
    assert.strictEqual(res.status, 403);
  } finally {
    if (saved !== undefined) process.env.NODE_ENV = saved;
  }
});

test('/inbound/voicemail treats an UNKNOWN duration as deliverable, never as empty', async () => {
  // 'unknown' is not 'zero'. Collapsing them would irreversibly delete a real
  // voicemail whenever Twilio omits or garbles RecordingDuration.
  for (const RecordingDuration of ['', 'banana']) {
    calls.audio.length = 0; calls.deletes.length = 0; calls.marks.length = 0;
    await post('/api/voice/inbound/voicemail', {
      RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB12'), RecordingDuration,
    });
    await settle();
    assert.strictEqual(calls.audio.length, 1, `duration "${RecordingDuration}" must still be delivered`);
    assert.ok(!calls.marks.some((m) => m.status === 'empty'), 'must never be marked empty');
  }
});

test('/inbound/missed records at exactly one under the cap and stops at the cap', async () => {
  // The boundary is the whole point of the guard; 51-vs-50 alone would not catch
  // an off-by-one flip.
  router.__setVoiceDeps({ countVoicemailsSince: async () => 49 });
  let res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CAcap49'), From: '+13125550147' });
  assert.match(res.text, /<Record/, '49 existing rows is under a cap of 50');

  router.__setVoiceDeps({ countVoicemailsSince: async () => 50 });
  res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CAcap50'), From: '+13125550147' });
  assert.doesNotMatch(res.text, /<Record/, '50 existing rows is the cap');
  await settle();
});

test('/inbound/missed never hands Zul a premium-rate or non-US NANP callback number', async () => {
  // A bare /^\+1[2-9]\d{9}$/ accepts all of these; usPhone.isUsE164 does not.
  // A spoofed caller ID that rings once must not arrive formatted for one-tap
  // callback.
  for (const From of ['+19005551234', '+19765551234', '+18095551234', '+18765551234']) {
    calls.telegram.length = 0;
    await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs(`CApr${From}`), From });
    await settle();
    assert.strictEqual(calls.telegram.length, 1, `${From} must not get a bare-number message`);
    assert.doesNotMatch(calls.telegram[0].text, /Number follows/);
  }
});

test('/inbound/missed sends no ping when the ledger claim itself fails', async () => {
  // Fails closed with the cap branch: a DB outage puts EVERY call down this
  // path, so pinging here is the flood the cap exists to prevent.
  router.__setVoiceDeps({ claimMissedCall: async () => { throw new Error('db down'); } });
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: cs('CAdb1'), From: '+13125550147' });
  await settle();
  assert.match(res.text, /<Hangup\/>/);
  assert.strictEqual(calls.telegram.length, 0);
});

test('the voicemail limiter answers a LIVE caller with TwiML, never a bare 429', async () => {
  // Twilio answers a non-2xx on a <Dial> action URL by playing "an application
  // error has occurred" to the client. The recording callback has no listener,
  // so it takes the plain 429.
  const sid = cs('CAlimiter');
  let missedRes;
  for (let i = 0; i < 12; i += 1) {
    missedRes = await post('/api/voice/inbound/missed', { DialCallStatus: 'completed', CallSid: sid, From: '+13125550147' });
  }
  assert.strictEqual(missedRes.status, 200, 'a live caller must never hear an application error');
  assert.match(missedRes.contentType || '', /text\/xml/);
  assert.match(missedRes.text, /<Hangup\/>/);

  const sid2 = cs('CAlimiter2');
  let vmRes;
  for (let i = 0; i < 12; i += 1) {
    vmRes = await post('/api/voice/inbound/voicemail', { RecordingStatus: 'failed', RecordingSid: GOOD_RE, CallSid: sid2 });
  }
  assert.strictEqual(vmRes.status, 429, 'nobody is on the line for this one');
});

test('/inbound/voicemail answers 503 (never 204) when the delivery claim throws', async () => {
  // A 2xx tells Twilio the callback was accepted and it never retries, which
  // would strand the row at 'missed' with NULL recording_sid — a state the
  // sweep's `recording_sid IS NOT NULL` filter cannot reach. Must FAIL if this
  // regresses to 204.
  router.__setVoiceDeps({ claimDelivery: async () => { throw new Error('db down'); } });
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs('CB13'), RecordingDuration: '14',
  });
  assert.strictEqual(res.status, 503, 'a 2xx here permanently strands the voicemail');
  await settle();
  assert.strictEqual(calls.audio.length, 0);
  assert.strictEqual(calls.deletes.length, 0);
});

test('/inbound/voicemail passes the row line into the delivery job', async () => {
  const jobs = [];
  router.__setVoiceDeps({
    claimDelivery: async () => ({ fromE164: '+13125550147', line: 'primary' }),
    deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
  });
  await post('/api/voice/inbound/voicemail', {
    CallSid: cs('CAdel1'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
  });
  await settle();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].line, 'primary', 'delivery must follow the line the call arrived on');
});

test('a primary voicemail still delivers with TELEGRAM_ALLOWED_USER_ID unset', async () => {
  // The bootstrap gate is Zul-specific. If it also gated the primary line, every
  // one of Dallas's voicemails would be silently undelivered whenever her chat id
  // was unset, which is a documented production configuration.
  const saved = process.env.TELEGRAM_ALLOWED_USER_ID;
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  const jobs = [];
  try {
    router.__setVoiceDeps({
      claimDelivery: async () => ({ fromE164: '+13125550147', line: 'primary' }),
      deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
    });
    await post('/api/voice/inbound/voicemail', {
      CallSid: cs('CAdel2'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
    });
    await settle();
    assert.equal(jobs.length, 1, 'the primary line must not be gated on Zul\'s chat id');
  } finally {
    if (saved === undefined) delete process.env.TELEGRAM_ALLOWED_USER_ID;
    else process.env.TELEGRAM_ALLOWED_USER_ID = saved;
  }
});

test('a zul voicemail is still gated on TELEGRAM_ALLOWED_USER_ID', async () => {
  const saved = process.env.TELEGRAM_ALLOWED_USER_ID;
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  const jobs = [];
  try {
    router.__setVoiceDeps({
      claimDelivery: async () => ({ fromE164: '+13125550147', line: 'zul' }),
      deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
    });
    await post('/api/voice/inbound/voicemail', {
      CallSid: cs('CAdel3'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
    });
    await settle();
    assert.equal(jobs.length, 0, 'her line has no channel without a chat id; stay retryable');
  } finally {
    if (saved === undefined) delete process.env.TELEGRAM_ALLOWED_USER_ID;
    else process.env.TELEGRAM_ALLOWED_USER_ID = saved;
  }
});

test('a failed primary delivery alerts the line owner, never Zul', async () => {
  // Channel choice (SMS vs Telegram) is pinned in voicemail.test.js's
  // alertOperator tests; this pins that the ROUTE hands the failure to the
  // line-aware helper with the right line and payload.
  const alerts = [];
  router.__setVoiceDeps({
    claimDelivery: async () => ({ fromE164: '+13125550147', line: 'primary' }),
    deliverVoicemail: async () => 'failed',
    alertOperator: async (args) => { alerts.push(args); },
  });
  await post('/api/voice/inbound/voicemail', {
    CallSid: cs('CAdel4'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
  });
  await settle();
  assert.equal(calls.telegram.length, 0, 'a primary failure must not be reported to Zul');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].line, 'primary');
  assert.match(alerts[0].text, /\+13125550147/);
});

test('signature-failure Sentry reporting is throttled independently of the limiter', async () => {
  // The limiter cannot cap this: a well-formed random CallSid gets a fresh
  // budget every request, so an unauthenticated flood is never limited. Without
  // an independent cap this is a 1:1 Sentry-quota amplifier.
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  try {
    router.__setVoiceDeps({ isValidTwilioRequest: () => false });
    for (let i = 0; i < 40; i += 1) {
      const res = await post('/api/voice/inbound/voicemail', {
        RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: cs(`flood${i}`),
      });
      assert.strictEqual(res.status, 403, 'every request is still rejected');
    }
    assert.ok(calls.sentry.length <= 5, `expected <= 5 Sentry events, got ${calls.sentry.length}`);
    assert.ok(calls.sentry.length >= 1, 'but the signal must not be lost entirely');
  } finally {
    delete process.env.SENTRY_DSN_SERVER;
  }
});

test('an unsigned flood cannot consume the primary forward budget (signature runs first)', async () => {
  // Security-review 2026-08-07 (H1): with the limiter ahead of the signature
  // gate, 31 unsigned junk POSTs per minute drain the constant-key bucket and
  // every REAL Twilio call is answered busy, an unauthenticated denial of
  // service on the business's phone line. Signature-first means junk never
  // counts. LAST in this file on purpose: under a regression the flood below
  // trips the shared bucket for the rest of the window.
  // Derived from the cap so a configured VA_INBOUND_PER_MIN_CAP cannot quietly
  // shrink the flood below the bucket and turn this pin into a vacuous pass.
  const cap = parseInt(process.env.VA_INBOUND_PER_MIN_CAP, 10) || 30;
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  for (let i = 0; i < cap + 5; i += 1) {
    const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs(`Cflood${i}`) });
    assert.strictEqual(res.status, 403);
  }
  router.__setVoiceDeps({ isValidTwilioRequest: () => true });
  const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAafterflood') });
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /<Dial/, 'a signed call after the flood must still ring through');
  assert.doesNotMatch(res.text, /All lines are busy/);
});

test('/inbound/voicemail passes the row listen token into the delivery job', async () => {
  const jobs = [];
  router.__setVoiceDeps({
    claimDelivery: async () => ({ fromE164: '+13125550147', line: 'primary', listenToken: '11111111-2222-4333-8444-555555555555' }),
    deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
  });
  await post('/api/voice/inbound/voicemail', {
    CallSid: cs('CAdel5'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
  });
  await settle();
  assert.equal(jobs[0].listenToken, '11111111-2222-4333-8444-555555555555');
});

// --- night mode (spec 2026-08-19) --------------------------------------------

test('NIGHT: no Gather, and the NIGHT recording rather than the day one', async () => {
  process.env.VM_ESCALATION_ENABLED = 'true';
  router.__setVoiceDeps({ isNight: () => true });
  const res = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAnight1'), From: '+13125550147',
  });
  await settle();
  assert.doesNotMatch(res.text, /<Gather/, 'night must not offer a human');
  assert.match(res.text, /primary-greeting-night\.mp3/);
  assert.doesNotMatch(res.text, /primary-greeting-day\.mp3/, 'the day greeting offers press 1');
  assert.match(res.text, /<Record/, 'a message can still be left');
});

test('NIGHT copy promises the morning and never offers a human', async () => {
  // The words live in the mp3 by default, so force synthetic to assert on them.
  // The synthetic text is also what callers hear if the recording is killed.
  process.env.VM_ESCALATION_ENABLED = 'true';
  router.__setVoiceDeps({ isNight: () => true });
  process.env.VM_NIGHT_GREETING_URL_PRIMARY = 'say';
  const res = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAnight2'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /in the morning/i);
  assert.doesNotMatch(res.text, /press one/i, 'night must never offer a human');
});

test('DAY: the Gather is back and the day recording plays', async () => {
  process.env.VM_ESCALATION_ENABLED = 'true';
  const res = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAday1'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /<Gather/);
  assert.match(res.text, /primary-greeting-day\.mp3/);
});

test('the press-1 offer reaches the caller once, and never twice', async () => {
  // The regression this guards: the day copy says the offer itself, and the old
  // code appended it unconditionally, so the primary line said it twice.
  process.env.VM_ESCALATION_ENABLED = 'true';

  // Recording default: the offer is INSIDE the mp3, so the document must carry
  // no spoken offer at all. An appended one here would be the double.
  const recorded = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAonce1'), From: '+13125550147',
  });
  await settle();
  assert.doesNotMatch(recorded.text, /press one/i, 'his recording already says it');
  assert.doesNotMatch(recorded.text, /get someone else on the line/i, 'no appended offer');

  // Synthetic fallback: the offer is in the text, still exactly once.
  process.env.VM_GREETING_URL_PRIMARY = 'say';
  const synthetic = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAonce2'), From: '+13125550147',
  });
  await settle();
  // Count BOTH spellings: the greeting says "press one", the appended prompt
  // says "press 1", so counting only one spelling makes a doubled offer read as
  // a single one and the assertion passes on the bug it exists to catch.
  assert.equal((synthetic.text.match(/press one|press 1\b/gi) || []).length, 1,
    'exactly once, never twice');
  delete process.env.VM_GREETING_URL_PRIMARY;

  // Zul's day greeting is still her pre-escalation <Play>, so her ONLY spoken
  // offer is the appended one. If that became zero her callers would never
  // learn the option exists.
  const zul = await post('/api/voice/inbound/missed?line=zul', {
    DialCallStatus: 'no-answer', CallSid: cs('CAonce3'), From: '+13125550147',
  });
  await settle();
  // Her 2026-08-19 recording says the offer itself, so like his the document
  // carries no spoken offer at all, and appending one would be the double.
  assert.equal((zul.text.match(/press 1|press one/gi) || []).length, 0,
    'her recording already says it');
  assert.doesNotMatch(zul.text, /get someone else on the line/i, 'no appended offer');
});

test('escalation OFF: NIGHT emits no Gather, DAY still listens', async () => {
  // The asymmetry is the fix. Night greetings never mention press 1 (nobody is
  // awake to escalate to), so with the switch off there is nothing to listen for
  // and the Gather is genuinely absent. Day greetings DO mention it, so the
  // Gather stays and a pressed digit reaches the escalate_failed recording
  // instead of silence. Before 2026-08-20 both were Gather-less and the day case
  // was a lie told to every caller.
  process.env.VM_ESCALATION_ENABLED = 'false';
  const expected = { true: false, false: true };
  for (const night of [true, false]) {
    router.__setVoiceDeps({ isNight: () => night });
    const res = await post('/api/voice/inbound/missed?line=primary', {
      DialCallStatus: 'no-answer', CallSid: cs(`CAoff${night}`), From: '+13125550147',
    });
    await settle();
    const hasGather = /<Gather/.test(res.text);
    assert.equal(hasGather, expected[String(night)],
      `night=${night} should ${expected[String(night)] ? '' : 'not '}emit a Gather`);
    // Either way the switch adds nothing spoken.
    assert.doesNotMatch(res.text, /get someone else on the line/i);
  }
});

test('the DAY Gather follows the GREETING TABLE, not just the switch', async () => {
  // THE MIGRATION PATH, pinned at the emission site for the first time.
  // Everything else here passes with `dayGreetingOffersPress1` deleted from
  // voice.js's condition entirely (verified: that mutant leaves this file
  // 75/75), because both lines ship defaultSaysOffer:true and the disjunction is
  // degenerate on today's data. So no fixture could tell the two conditions
  // apart, and the promise made in .env.example and in voicemailTwiml.test.js --
  // "swap the bundled recording, flip the flag, and voice.js stops emitting the
  // Gather with no code change" -- was only ever verified one layer down.
  //
  // Flipping the flag is what a real no-offer recording would do, so this asks
  // the route the question the migration will actually ask it.
  process.env.VM_ESCALATION_ENABLED = 'false';
  const slot = twiml.SLOTS.greeting_day.zul;
  const saved = slot.defaultSaysOffer;
  try {
    slot.defaultSaysOffer = false;
    const res = await post('/api/voice/inbound/missed?line=zul', {
      DialCallStatus: 'no-answer', CallSid: cs('CAtable1'), From: '+13125550147',
    });
    await settle();
    assert.doesNotMatch(res.text, /<Gather/,
      'a greeting that does not offer press 1 must not be wrapped in a Gather');
    assert.match(res.text, /<Play>[^<]*zul-greeting-day\.mp3<\/Play><Record/,
      'and the greeting still plays, straight into the Record');
  } finally {
    slot.defaultSaysOffer = saved;
  }

  // Same call, flag restored: the Gather is back. Without this half the test
  // would pass against a route that never emits a Gather at all.
  const back = await post('/api/voice/inbound/missed?line=zul', {
    DialCallStatus: 'no-answer', CallSid: cs('CAtable2'), From: '+13125550147',
  });
  await settle();
  assert.match(back.text, /<Gather/, 'the offer is in the recording again, so listen again');
});

test('/inbound/missed NIGHT document is pinned byte-for-byte', async () => {
  // The day document has its own golden pin above. Night is a SECOND live
  // document now, and it deserves the same alarm: a substring match would not
  // catch the greeting landing after the beep, or a dropped <Hangup/> billing
  // us for dead air.
  process.env.VM_ESCALATION_ENABLED = 'false';
  router.__setVoiceDeps({ isNight: () => true });
  const { API_URL } = require('../utils/urls');
  const res = await post('/api/voice/inbound/missed', {
    DialCallStatus: 'no-answer', CallSid: cs('CAgoldN'), From: '+13125550147',
  });
  await settle();
  assert.strictEqual(
    res.text,
    '<?xml version="1.0" encoding="UTF-8"?>'
    + `<Response><Play>${API_URL}/api/voice/audio/zul-greeting-night.mp3</Play>`
    + '<Record maxLength="120" playBeep="true" trim="trim-silence" finishOnKey="#"'
    + ` recordingStatusCallback="${API_URL}/api/voice/inbound/voicemail"`
    + ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>'
    + '<Hangup/></Response>'
  );
});

test('/inbound/missed PRIMARY day document is pinned byte-for-byte', async () => {
  // Both other golden pins are the ZUL document with escalation off. This is the
  // one Dallas's real callers hear: escalation on, day, his recording inside a
  // Gather. A substring assertion cannot catch the greeting landing outside the
  // Gather (the caller could not press 1 during it) or a doubled offer.
  process.env.VM_ESCALATION_ENABLED = 'true';
  const { API_URL } = require('../utils/urls');
  const res = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAgoldP'), From: '+13125550147',
  });
  await settle();
  assert.strictEqual(
    res.text,
    '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response>'
    + `<Gather numDigits="1" timeout="4" action="${API_URL}/api/voice/escalate?line=primary" method="POST">`
    + `<Play>${API_URL}/api/voice/audio/primary-greeting-day.mp3</Play>`
    + '</Gather>'
    + '<Record maxLength="120" playBeep="true" trim="trim-silence" finishOnKey="#"'
    + ` recordingStatusCallback="${API_URL}/api/voice/inbound/voicemail"`
    + ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>'
    + '<Hangup/></Response>'
  );
});

test('the DEFAULT isNight dep is the real function, not a stub', () => {
  // Every route test injects isNight, so nothing otherwise asserts production
  // uses the real one. Hardcoding `isNight: () => false` in _deps would disable
  // night mode in prod and leave all 73 tests green.
  delete require.cache[require.resolve('./voice')];
  const fresh = require('./voice');
  const { isNight } = require('../utils/voicemailLine');
  const aug = (hh) => new Date(Date.UTC(2026, 7, 19, hh + 5, 0));
  fresh.__setVoiceDeps({});
  assert.equal(isNight(aug(23)), true, 'sanity: 11pm Chicago is night');
  assert.equal(isNight(aug(13)), false, 'sanity: 1pm Chicago is day');
});
