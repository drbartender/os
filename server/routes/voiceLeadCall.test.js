// Route-level tests for /api/voice/lead/{answer,digit,status}. Real express
// app + real dev DB rows (state machine claims are the point); Twilio
// signature, advanceChain, and sendChainEmail are stubbed through
// __setLeadVoiceDeps. Run ALONE (shared dev DB).
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { pool } = require('../db');
const router = require('./voiceLeadCall');

const RUN = `vlc-test-${Date.now()}`;
let server; let baseUrl;
let advanceCalls = [];
let emailCalls = [];

function post(path, form = {}) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function makeLead(i, overrides = {}) {
  const r = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, category, event_date, guest_count, location_city, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb) RETURNING id`,
    [`${RUN}-${i}`,
     overrides.customer_name !== undefined ? overrides.customer_name : 'Sarah M.',
     overrides.customer_phone !== undefined ? overrides.customer_phone : '+17735550100',
     'Wedding', '2026-10-10T23:00:00.000Z', 120, 'Naperville']
  );
  return r.rows[0].id;
}

async function makeAttempt(leadId, status = 'calling_admin') {
  const r = await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status) VALUES ($1, $2) RETURNING id`,
    [leadId, status]
  );
  return Number(r.rows[0].id); // pg returns BIGSERIAL as a string; the routes parse to number
}

async function attemptRow(attemptId) {
  const r = await pool.query('SELECT * FROM lead_call_attempts WHERE id = $1', [attemptId]);
  return r.rows[0] || null;
}

before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/voice/lead', router);
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

beforeEach(() => {
  advanceCalls = [];
  emailCalls = [];
  router.__setLeadVoiceDeps({
    isValidTwilioRequest: () => true,
    pool,
    advanceChain: async (args) => { advanceCalls.push(args); },
    sendChainEmail: async (args) => { emailCalls.push(args); },
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id LIKE $1', [`${RUN}-%`]);
  await pool.end();
});

// ─── signature gate ──────────────────────────────────────────────

test('signature failure 403s in production AND with NODE_ENV unset (fail closed everywhere)', async () => {
  router.__setLeadVoiceDeps({ isValidTwilioRequest: () => false });
  const savedEnv = process.env.NODE_ENV;
  try {
    for (const env of ['production', undefined]) {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      for (const path of ['/api/voice/lead/answer?attempt=1&leg=admin',
                          '/api/voice/lead/digit?attempt=1&leg=admin',
                          '/api/voice/lead/status?attempt=1&leg=admin']) {
        const res = await post(path, { CallStatus: 'completed' });
        assert.equal(res.status, 403, `${path} under NODE_ENV=${env}`);
      }
    }
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
  }
});

// ─── /answer ─────────────────────────────────────────────────────

test('/answer plays the Gather-wrapped briefing with one automatic repeat', async () => {
  const attemptId = await makeAttempt(await makeLead('answer'));
  const res = await post(`/api/voice/lead/answer?attempt=${attemptId}&leg=admin`);
  assert.equal(res.status, 200);
  assert.match(res.body, /<Gather numDigits="1" timeout="10"/);
  assert.ok(res.body.includes(`digit?attempt=${attemptId}&amp;leg=admin&amp;play=1`), res.body);
  const says = res.body.match(/New Thumbtack lead: Sarah M/g) || [];
  assert.equal(says.length, 2, 'briefing spoken inside Gather and once again after');
  assert.match(res.body, /<Hangup\/>/);
});

test('/answer apologizes (never 500s) on a missing, terminal, or malformed attempt', async () => {
  for (const path of [
    '/api/voice/lead/answer?attempt=999999999&leg=admin',
    '/api/voice/lead/answer?attempt=abc&leg=admin',
    '/api/voice/lead/answer?attempt=1&leg=zzz',
  ]) {
    const res = await post(path);
    assert.equal(res.status, 200, path);
    assert.match(res.body, /expired/, path);
  }
  const doneId = await makeAttempt(await makeLead('answer-done'), 'connected');
  const res = await post(`/api/voice/lead/answer?attempt=${doneId}&leg=admin`);
  assert.match(res.body, /expired/);
});

test('/answer xmlEscapes a hostile customer_name into the <Say>', async () => {
  const leadId = await makeLead('hostile', { customer_name: 'A <Say>&inject</Say> "B"' });
  const attemptId = await makeAttempt(leadId);
  const res = await post(`/api/voice/lead/answer?attempt=${attemptId}&leg=admin`);
  assert.ok(!res.body.includes('<Say>&inject'), 'raw injection must not appear');
  assert.ok(res.body.includes('&lt;Say&gt;&amp;inject'), res.body.slice(0, 400));
});

// ─── /digit ──────────────────────────────────────────────────────

test('/digit press-1 claims the bridge and dials the validated lead from the 224', async () => {
  const attemptId = await makeAttempt(await makeLead('press1'), 'calling_va');
  const saved = process.env.VOICE_CALLER_ID;
  process.env.VOICE_CALLER_ID = '+12242220082';
  try {
    const res = await post(`/api/voice/lead/digit?attempt=${attemptId}&leg=va`, { Digits: '1' });
    assert.match(res.body, /<Dial answerOnBridge="true" callerId="\+12242220082"/);
    assert.match(res.body, /<Number statusCallback="[^"]*leg=lead">\+17735550100<\/Number>/);
  } finally {
    if (saved === undefined) delete process.env.VOICE_CALLER_ID; else process.env.VOICE_CALLER_ID = saved;
  }
  const row = await attemptRow(attemptId);
  assert.equal(row.status, 'connected');
  assert.equal(row.answered_by, 'va');
  assert.ok(row.bridge_started_at);

  // Duplicate/stale press-1: claim already spent, polite apology, no dial.
  const dup = await post(`/api/voice/lead/digit?attempt=${attemptId}&leg=va`, { Digits: '1' });
  assert.match(dup.body, /expired/);
});

test('/digit press-1 with an invalid stored phone apologizes WITHOUT claiming (row never strands as connected)', async () => {
  // Belt for the can't-happen path: trigger validated at chain-open, but if
  // the stored phone were somehow bad, the leg must stay calling_* so the
  // status callback still advances the chain (a claimed-but-unbridged
  // 'connected' row would be invisible forever: the reaper skips connected).
  const leadId = await makeLead('badphone', { customer_phone: '+442071234567' });
  const attemptId = await makeAttempt(leadId, 'calling_va');
  const res = await post(`/api/voice/lead/digit?attempt=${attemptId}&leg=va`, { Digits: '1' });
  assert.match(res.body, /expired/);
  const row = await attemptRow(attemptId);
  assert.equal(row.status, 'calling_va', 'claim must not have been spent');
  assert.equal(row.answered_by, null);
});

test('/digit press-9 replays up to 3 total plays, then apologizes', async () => {
  const attemptId = await makeAttempt(await makeLead('replay'));
  const r1 = await post(`/api/voice/lead/digit?attempt=${attemptId}&leg=admin&play=1`, { Digits: '9' });
  assert.ok(r1.body.includes(`answer?attempt=${attemptId}&amp;leg=admin&amp;play=2`), r1.body);
  const r2 = await post(`/api/voice/lead/digit?attempt=${attemptId}&leg=admin&play=2`, { Digits: '9' });
  assert.ok(r2.body.includes('play=3'), r2.body);
  const r3 = await post(`/api/voice/lead/digit?attempt=${attemptId}&leg=admin&play=3`, { Digits: '9' });
  assert.match(r3.body, /expired/);
});

test('/digit any other key hangs up and leaves the state to the status callback', async () => {
  const attemptId = await makeAttempt(await makeLead('otherkey'));
  const res = await post(`/api/voice/lead/digit?attempt=${attemptId}&leg=admin`, { Digits: '5' });
  assert.match(res.body, /<Response><Hangup\/><\/Response>/);
  assert.equal((await attemptRow(attemptId)).status, 'calling_admin');
});

// ─── /status ─────────────────────────────────────────────────────

test('/status admin terminal records the disposition and advances the chain', async () => {
  const attemptId = await makeAttempt(await makeLead('adv'));
  const res = await post(`/api/voice/lead/status?attempt=${attemptId}&leg=admin`, { CallStatus: 'no-answer' });
  assert.equal(res.status, 200);
  assert.equal((await attemptRow(attemptId)).admin_call_status, 'no-answer');
  assert.deepEqual(advanceCalls, [{ attemptId, fromLeg: 'admin' }]);
});

test('/status va terminal marks missed and emails exactly once under a duplicated callback', async () => {
  const attemptId = await makeAttempt(await makeLead('missed'), 'calling_va');
  await post(`/api/voice/lead/status?attempt=${attemptId}&leg=va`, { CallStatus: 'no-answer' });
  await post(`/api/voice/lead/status?attempt=${attemptId}&leg=va`, { CallStatus: 'no-answer' });
  const row = await attemptRow(attemptId);
  assert.equal(row.status, 'missed');
  assert.equal(row.va_call_status, 'no-answer');
  assert.equal(emailCalls.length, 1, 'at-least-once delivery must email exactly once');
  assert.deepEqual(emailCalls[0], { attemptId, reason: 'missed' });
});

test('/status va terminal after a press-1 leaves connected untouched (race: first writer wins)', async () => {
  const attemptId = await makeAttempt(await makeLead('race'), 'connected');
  await post(`/api/voice/lead/status?attempt=${attemptId}&leg=va`, { CallStatus: 'completed' });
  assert.equal((await attemptRow(attemptId)).status, 'connected');
  assert.equal(emailCalls.length, 0);
});

test('/status lead leg stores duration and flips contacted only at the 20s floor', async () => {
  // 25s bridge: real conversation, lead flips to contacted.
  const lead1 = await makeLead('flip');
  const a1 = await makeAttempt(lead1, 'connected');
  await post(`/api/voice/lead/status?attempt=${a1}&leg=lead`, { CallStatus: 'completed', CallDuration: '25' });
  assert.equal((await attemptRow(a1)).bridge_duration_sec, 25);
  let lead = await pool.query('SELECT status FROM thumbtack_leads WHERE id = $1', [lead1]);
  assert.equal(lead.rows[0].status, 'contacted');

  // 19s: below the floor (relay refusal shape), lead stays new.
  const lead2 = await makeLead('noflip');
  const a2 = await makeAttempt(lead2, 'connected');
  await post(`/api/voice/lead/status?attempt=${a2}&leg=lead`, { CallStatus: 'completed', CallDuration: '19' });
  assert.equal((await attemptRow(a2)).bridge_duration_sec, 19);
  lead = await pool.query('SELECT status FROM thumbtack_leads WHERE id = $1', [lead2]);
  assert.equal(lead.rows[0].status, 'new');

  // Garbage duration: NULL, no flip, no crash.
  const lead3 = await makeLead('badduration');
  const a3 = await makeAttempt(lead3, 'connected');
  const res = await post(`/api/voice/lead/status?attempt=${a3}&leg=lead`, { CallStatus: 'completed', CallDuration: 'abc' });
  assert.equal(res.status, 200);
  assert.equal((await attemptRow(a3)).bridge_duration_sec, null);
  lead = await pool.query('SELECT status FROM thumbtack_leads WHERE id = $1', [lead3]);
  assert.equal(lead.rows[0].status, 'new');
});

test('/status ignores non-terminal and unknown CallStatus values', async () => {
  const attemptId = await makeAttempt(await makeLead('ringing'));
  for (const cs of ['ringing', 'in-progress', 'weird-new-status', '']) {
    const res = await post(`/api/voice/lead/status?attempt=${attemptId}&leg=admin`, { CallStatus: cs });
    assert.equal(res.status, 200, cs);
  }
  const row = await attemptRow(attemptId);
  assert.equal(row.status, 'calling_admin');
  assert.equal(row.admin_call_status, null);
  assert.equal(advanceCalls.length, 0);
});
