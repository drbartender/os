require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const router = require('./voiceEscalate');

let _server = null;
let _baseUrl = null;

before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/voice/escalate', router);
  await new Promise((resolve) => {
    _server = app.listen(0, () => {
      _baseUrl = `http://127.0.0.1:${_server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (_server) await new Promise((r) => _server.close(r)); });

function post(path, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const crypto = require('node:crypto');
const cs = (label) => 'CA' + crypto.createHash('md5').update(String(label)).digest('hex');

let calls;
beforeEach(() => {
  calls = { claims: [], outcomes: [], accepted: [], wasAccepted: false };
  process.env.VM_ESCALATION_ENABLED = 'true';
  process.env.VM_MAX_LENGTH_SEC = '120';
  process.env.VA_CELL = '+639171234567';
  process.env.VM_PRIMARY_DIAL_TARGET = '+13125889401';
  process.env.VA_CALL_TIME_LIMIT_SEC = '1800';
  delete process.env.VM_ESCALATION_QUIET_ZUL;
  delete process.env.VM_ESCALATION_QUIET_PRIMARY;
  delete process.env.VM_ESCALATION_TZ_ZUL;
  delete process.env.VM_ESCALATION_TZ_PRIMARY;
  delete process.env.VM_ESCALATION_DAILY_CAP;
  router.__setEscalateDeps({
    isValidTwilioRequest: () => true,
    // Cap+claim is ONE call (voicemailEscalation.claimEscalationUnderCap):
    // capped=false, claim won is the permissive baseline.
    claimEscalationUnderCap: async (sid) => {
      calls.claims.push(sid);
      return { capped: false, claim: { line: 'zul' } };
    },
    recordEscalationOutcome: async (a) => { calls.outcomes.push(a); },
    markEscalationAccepted: async (sid) => { calls.accepted.push(sid); },
    wasEscalationAccepted: async () => calls.wasAccepted,
  });
});

test('a digit other than 1 goes straight to the recording, no dial', async () => {
  const res = await post('/api/voice/escalate?line=zul', { Digits: '7', CallSid: cs('E2') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record[^>]*maxLength="120"/);
  assert.equal(calls.claims.length, 0, 'no claim means no spend committed');
});

test('a lost claim (Twilio redelivery) records but never dials twice', async () => {
  router.__setEscalateDeps({ claimEscalationUnderCap: async () => ({ capped: false, claim: null }) });
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E3') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.equal(calls.outcomes.length, 0, 'a lost claim writes no outcome; the first pass owns the row');
});

test('a malformed CallSid records instead of dialing, with no claim', async () => {
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: 'CAtooshort' });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.equal(calls.claims.length, 0);
});

test('over the daily cap it records instead of dialing', async () => {
  router.__setEscalateDeps({ claimEscalationUnderCap: async () => ({ capped: true, claim: null }) });
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E4') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'skipped_cap');
});

test('a cap/claim DB failure records instead of dialing (fail closed on spend)', async () => {
  router.__setEscalateDeps({ claimEscalationUnderCap: async () => { throw new Error('db down'); } });
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E4b') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
});

test('inside the quiet window it records instead of ringing a cell at 3am', async () => {
  // line=primary escalates TO Zul, so Zul's window applies.
  process.env.VM_ESCALATION_QUIET_ZUL = '00:00-23:59';
  const res = await post('/api/voice/escalate?line=primary', { Digits: '1', CallSid: cs('E5') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'skipped_quiet');
  assert.equal(calls.claims.length, 0, 'a quiet-window skip must not consume a claim');
});

test('an unset target records instead of emitting an empty Dial', async () => {
  delete process.env.VM_PRIMARY_DIAL_TARGET;
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E6') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'skipped_no_target');
});

test('VM_ESCALATION_ENABLED=false makes the digit handler a plain recording', async () => {
  process.env.VM_ESCALATION_ENABLED = 'false';
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E7') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.equal(calls.claims.length, 0);
});

test('press 1 dials the other person and threads the parent sid to the whisper', async () => {
  process.env.VOICE_CALLER_ID = '+12242220082';
  const parent = cs('E1');
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: parent });
  assert.match(res.text, new RegExp(`action="[^"]*/api/voice/escalate/done\\?line=zul&amp;sid=${parent}"`));
  assert.match(res.text, /timeLimit="1800"/);
  // OUR caller ID, never the inbound From: a spoofed premium-rate From must not
  // land in the answerer's call log as a one-tap callback.
  assert.match(res.text, /<Dial[^>]*callerId="\+12242220082"/);
  assert.match(res.text, new RegExp(`<Number[^>]*url="[^"]*/api/voice/escalate/whisper\\?sid=${parent}"[^>]*>\\+13125889401</Number>`));
});

test('the spoken whisper copy contains no em dash', async () => {
  const res = await post(`/api/voice/escalate/whisper?sid=${cs('Edash')}`, { CallSid: cs('childdash') });
  assert.doesNotMatch(res.text, /—/);
});

test('the whisper screens with a Gather, hangs up on no keypress, and carries the sid', async () => {
  const parent = cs('E8');
  const res = await post(`/api/voice/escalate/whisper?sid=${parent}`, { CallSid: cs('child8') });
  assert.match(res.text, /<Gather[^>]*numDigits="1"/);
  assert.match(res.text, new RegExp(`action="[^"]*/api/voice/escalate/accept\\?sid=${parent}"`));
  assert.match(res.text, /Dr\. Bartender/);
  // "Press any key" must include #: the default finishOnKey would end the
  // Gather with zero digits and cut off a human who did as told.
  assert.match(res.text, /<Gather[^>]*finishOnKey=""/);
  // The trailing Hangup is the whole point: an unattended carrier voicemail that
  // never presses a key must NOT be bridged to the client.
  assert.match(res.text, /<\/Gather><Hangup\/>/);
});

test('the whisper hangs up outright on a malformed parent sid', async () => {
  // No valid parent means no acceptance could ever attach; playing the screen
  // would ring the target, have them press a key, and cut them off anyway.
  const res = await post('/api/voice/escalate/whisper?sid=nope', { CallSid: cs('child11') });
  assert.doesNotMatch(res.text, /<Gather/);
  assert.match(res.text, /<Hangup\/>/);
});

test('accept marks the PARENT accepted and returns an empty response so they bridge', async () => {
  const parent = cs('E9');
  // The whisper and accept callbacks run on the CHILD leg, so CallSid here is the
  // child's. The acceptance flag belongs to the parent row.
  const res = await post(`/api/voice/escalate/accept?sid=${parent}`, { Digits: '5', CallSid: cs('child9') });
  assert.match(res.text, /<Response><\/Response>|<Response\/>/);
  assert.deepEqual(calls.accepted, [parent], 'the parent sid, not the child sid');
});

test('accept with no digits hangs up and marks nothing accepted', async () => {
  const res = await post(`/api/voice/escalate/accept?sid=${cs('E10')}`, { Digits: '', CallSid: cs('child10') });
  assert.match(res.text, /<Hangup\/>/);
  assert.equal(calls.accepted.length, 0);
});

test('accept with a malformed sid hangs up rather than bridging blind', async () => {
  const res = await post('/api/voice/escalate/accept?sid=nope', { Digits: '5', CallSid: cs('child10b') });
  assert.match(res.text, /<Hangup\/>/);
  assert.equal(calls.accepted.length, 0);
});

test('escalate/done returns the recording when nobody accepted', async () => {
  calls.wasAccepted = false;
  const res = await post(`/api/voice/escalate/done?line=zul&sid=${cs('E11')}`, {
    DialCallStatus: 'no-answer', CallSid: cs('E11'),
  });
  assert.match(res.text, /<Record[^>]*maxLength="120"/);
  assert.match(res.text, /<Hangup\/>/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'no_answer');
});

test('escalate/done RECORDS a screened-out machine even though Twilio says completed', async () => {
  // THE REGRESSION TEST. Hanging up the screened leg still reports completed, so
  // trusting DialCallStatus here would hang up on a caller who never reached a
  // person. Acceptance state is the only thing that may decide this.
  calls.wasAccepted = false;
  const res = await post(`/api/voice/escalate/done?line=zul&sid=${cs('E12')}`, {
    DialCallStatus: 'completed', CallSid: cs('E12'),
  });
  assert.match(res.text, /<Record[^>]*maxLength="120"/, 'completed without acceptance is NOT a conversation');
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'no_answer');
});

test('escalate/done hangs up with no second recording once a human accepted', async () => {
  calls.wasAccepted = true;
  const res = await post(`/api/voice/escalate/done?line=zul&sid=${cs('E13')}`, {
    DialCallStatus: 'completed', CallSid: cs('E13'),
  });
  assert.doesNotMatch(res.text, /<Record/);
  assert.match(res.text, /<Hangup\/>/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'answered');
});

test('escalate/done with no attributable parent writes no outcome and offers the recording', async () => {
  const res = await post('/api/voice/escalate/done?line=zul&sid=nope', {
    DialCallStatus: 'no-answer', CallSid: 'also-not-a-sid',
  });
  assert.match(res.text, /<Record/);
  assert.equal(calls.outcomes.length, 0);
});

test('escalate/done falls back to the body CallSid when the query sid is malformed', async () => {
  // The outer <Dial action> runs on the PARENT leg, so body.CallSid is the
  // parent there; the fallback must be shape-gated like every other sid.
  const parent = cs('E15');
  calls.wasAccepted = true;
  const res = await post('/api/voice/escalate/done?line=zul&sid=nope', {
    DialCallStatus: 'completed', CallSid: parent,
  });
  assert.doesNotMatch(res.text, /<Record/);
  assert.deepEqual(calls.outcomes.at(-1), { callSid: parent, outcome: 'answered' });
});

test('escalate/done falls back to recording when the acceptance read throws', async () => {
  // Fail closed toward the caller: voicemail is recoverable, silence is not.
  router.__setEscalateDeps({ wasEscalationAccepted: async () => { throw new Error('db down'); } });
  const res = await post(`/api/voice/escalate/done?line=zul&sid=${cs('E14')}`, {
    DialCallStatus: 'completed', CallSid: cs('E14'),
  });
  assert.match(res.text, /<Record/);
});

test('every escalate route fails CLOSED on a bad signature with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    router.__setEscalateDeps({ isValidTwilioRequest: () => false });
    for (const path of ['', '/done', '/whisper', '/accept']) {
      const res = await post(`/api/voice/escalate${path}`, { Digits: '1', CallSid: cs('Esig') });
      assert.equal(res.status, 403, `${path || '/'} must fail closed`);
    }
  } finally {
    if (saved !== undefined) process.env.NODE_ENV = saved;
  }
});

test('signature-failure Sentry reporting is throttled (fresh sids never trip the limiter)', async () => {
  // Each request carries a well-formed random CallSid, so every one mints its
  // own limiter bucket and reaches the signature gate: without the window
  // claim this is a 1:1 unauthenticated Sentry-quota amplifier. LAST in this
  // file: the claim state is module-level and this consumes the window.
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  const events = [];
  try {
    router.__setEscalateDeps({
      isValidTwilioRequest: () => false,
      captureMessage: (msg) => { events.push(msg); },
    });
    for (let i = 0; i < 40; i += 1) {
      const res = await post('/api/voice/escalate', { Digits: '1', CallSid: cs(`sigflood${i}`) });
      assert.equal(res.status, 403);
    }
    assert.ok(events.length <= 5, `expected <= 5 Sentry events, got ${events.length}`);
    assert.ok(events.length >= 1, 'but the signal must not be lost entirely');
  } finally {
    delete process.env.SENTRY_DSN_SERVER;
  }
});
