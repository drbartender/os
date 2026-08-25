// Route-level tests for /api/voice/consult/{answer,digit,dialend,status}.
// Real express app + real dev DB rows (the state machine claims are the point);
// the Twilio signature gate and the three chain functions are stubbed through
// __setConsultVoiceDeps. Run ALONE (shared dev DB).
//
// R23: every stub below RECORDS its arguments and the test asserts on the
// recording afterwards. An assertion thrown INSIDE a stub would be swallowed by
// the route's own catch (which is load-bearing: advanceChain and onLegTerminal
// can reject where the tail-side functions swallow) and the test would pass no
// matter what the route did.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { pool } = require('../db');
const { API_URL } = require('../utils/urls');
const chain = require('../utils/consultCallChain');
const router = require('./voiceConsultCall');

const RUN = `vcc-test-${Date.now()}`;
const VALID_PHONE = '+12563281203';
const SPOKEN_PHONE = '256-328-1203';
// A fixed slot, carrying microseconds on purpose (R12: a value that round-trips
// through JS comes back truncated). 15:00Z on October 10th 2026 is 10 AM in
// Chicago, so the spoken time is deterministic in any process timezone.
const SLOT_SQL = "TIMESTAMPTZ '2026-10-10 15:00:00.123456+00'";
const SPOKEN_SLOT = '10 AM';

const CONSULT_CALLER_ID = '+12242221922';
const VOICE_CALLER_ID = '+12242220082';
const ENV_KEYS = ['CONSULT_CALLER_ID', 'VOICE_CALLER_ID', 'VA_CALL_TIME_LIMIT_SEC'];
const savedEnv = {};

let server; let baseUrl;
const proposalIds = [];
let legTerminalCalls = [];
let guardCalls = [];
let textCalls = [];
let guardResult = { ok: true };

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

/** Every double-quoted attribute value in a TwiML document. */
function attributeValues(xml) {
  const out = [];
  const re = /=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/**
 * One consults fixture. Explicit column list: column ORDER differs between a
 * fresh database and dev/prod (two columns arrived by ALTER TABLE).
 */
async function makeConsult(tag, opts = {}) {
  const {
    phone = VALID_PHONE, name = 'Sarah M.', status = 'scheduled', proposalId = null,
  } = opts;
  const r = await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email, booker_phone, proposal_id)
     VALUES ($1, ${SLOT_SQL}, $2, $3, $4, $5, $6)
     RETURNING id`,
    [`${RUN}-${tag}`, status, name, `${RUN}-${tag}@example.test`, phone, proposalId]
  );
  return r.rows[0].id;
}

/** The slot is copied from the consult IN SQL, never through JS (R12). */
async function makeAttempt(consultId, opts = {}) {
  const { status = 'calling_admin', adminRing = 1 } = opts;
  const r = await pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, admin_ring)
     SELECT c.id, c.scheduled_at, $2, $3 FROM consults c WHERE c.id = $1
     RETURNING id`,
    [consultId, status, adminRing]
  );
  return Number(r.rows[0].id); // pg hands BIGSERIAL back as a string; the routes parse it
}

/**
 * A consult plus its chain row in one call. `status` is the ATTEMPT status;
 * the consult's own status (scheduled / cancelled / completed / no_show) is
 * `consultStatus`, because they are different vocabularies.
 */
async function makeChain(tag, opts = {}) {
  const { consultStatus = 'scheduled', ...rest } = opts;
  const consultId = await makeConsult(tag, { ...rest, status: consultStatus });
  const attemptId = await makeAttempt(consultId, rest);
  return { consultId, attemptId };
}

async function makeProposal(eventDate, guestCount) {
  const r = await pool.query(
    `INSERT INTO proposals (event_date, guest_count) VALUES ($1, $2) RETURNING id`,
    [eventDate, guestCount]
  );
  proposalIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function rowOf(attemptId) {
  const r = await pool.query(
    `SELECT status, admin_ring, answered_by, detail, bridge_duration_sec,
            bridge_started_at, client_no_answer_at::text AS client_no_answer_at,
            admin_call_status, va_call_status, updated_at::text AS updated_at
       FROM consult_call_attempts WHERE id = $1`,
    [attemptId]
  );
  return r.rows[0] || null;
}

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CONSULT_CALLER_ID = CONSULT_CALLER_ID;
  process.env.VOICE_CALLER_ID = VOICE_CALLER_ID;
  delete process.env.VA_CALL_TIME_LIMIT_SEC;

  // Belt for the one test that calls the real chain module: even a regression
  // that got past its own guard can never reach Twilio, email or SMS.
  chain.__setDeps({
    pool,
    placeBridgedCall: async () => ({ sid: 'CA_stub_never' }),
    cancelBridgedCall: async () => ({}),
    notifyAdminCategory: async () => ({ emailed: 0 }),
    sendSMS: async () => ({ ok: true }),
  });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/voice/consult', router);
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

beforeEach(() => {
  legTerminalCalls = [];
  guardCalls = [];
  textCalls = [];
  guardResult = { ok: true };
  router.__setConsultVoiceDeps({
    isValidTwilioRequest: () => true,
    pool,
    onLegTerminal: async (args) => { legTerminalCalls.push(args); },
    guardStillScheduled: async (attemptId) => { guardCalls.push(attemptId); return guardResult; },
    // 'sent', not true: sendMissedText returns a discriminated string now, and a
    // boolean stub could not express a failure to a future consumer in this route.
    sendMissedText: async (args) => { textCalls.push(args); return 'sent'; },
  });
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise((r) => server.close(r));
  // Attempt rows cascade with the consults; the consults release the proposals.
  await pool.query('DELETE FROM consults WHERE calcom_event_id LIKE $1', [`${RUN}-%`]);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [proposalIds]);
  await pool.end();
});

// ─── signature gate ──────────────────────────────────────────────

test('every route 403s on a bad signature, in production AND with NODE_ENV unset (fail closed everywhere)', async () => {
  router.__setConsultVoiceDeps({ isValidTwilioRequest: () => false });
  const savedNodeEnv = process.env.NODE_ENV;
  try {
    for (const env of ['production', undefined]) {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      for (const path of ['/api/voice/consult/answer?attempt=1&leg=admin&ring=1',
                          '/api/voice/consult/digit?attempt=1&leg=admin&ring=1',
                          '/api/voice/consult/dialend?attempt=1&leg=admin',
                          '/api/voice/consult/status?attempt=1&leg=admin&ring=1']) {
        const res = await post(path, { Digits: '1', CallStatus: 'completed', DialCallStatus: 'no-answer' });
        assert.equal(res.status, 403, `${path} under NODE_ENV=${env}`);
      }
    }
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
  }
});

// ─── /answer ─────────────────────────────────────────────────────

test('/answer speaks the booker and the slot inside a Gather, then repeats once and hangs up', async () => {
  const { attemptId } = await makeChain('answer');
  const res = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=1&play=1`);
  assert.equal(res.status, 200);
  assert.match(res.body, /<Gather numDigits="1" timeout="10" method="POST"/);
  assert.ok(res.body.includes(`digit?attempt=${attemptId}&amp;leg=admin&amp;ring=1&amp;play=1`), res.body);
  const says = res.body.match(new RegExp(`Potion planning call with Sarah M, booked for ${SPOKEN_SLOT}\\.`, 'g')) || [];
  assert.equal(says.length, 2, 'spoken inside the Gather and once again after it');
  assert.match(res.body, /Press 1 to call them now\. Press 9 to hear this again\./);
  assert.match(res.body, /<Hangup\/>/);
});

test('/answer opens with Second try. on ring 2 and Last try. on ring 3', async () => {
  const two = await makeChain('answer-r2', { adminRing: 2 });
  let res = await post(`/api/voice/consult/answer?attempt=${two.attemptId}&leg=admin&ring=2`);
  assert.match(res.body, /<Say>Second try\. Potion planning call with/);

  const three = await makeChain('answer-r3', { adminRing: 3 });
  res = await post(`/api/voice/consult/answer?attempt=${three.attemptId}&leg=admin&ring=3`);
  assert.match(res.body, /<Say>Last try\. Potion planning call with/);
});

test('/answer gives Zul the missed-him wording only when Dallas was actually rung', async () => {
  const rung = await makeChain('answer-va-rung', { status: 'calling_va', adminRing: 3 });
  let res = await post(`/api/voice/consult/answer?attempt=${rung.attemptId}&leg=va&ring=0`);
  assert.match(res.body, /Dallas missed his potion planning call with Sarah M, booked for 10 AM\./);
  assert.match(res.body, /Press 1 to call them for him\./);

  // ADMIN_PHONE unset at chain-open: the Zul leg is the FIRST leg, so the
  // briefing must never say Dallas missed a call he was never rung for.
  const direct = await makeChain('answer-va-direct', { status: 'calling_va', adminRing: 0 });
  res = await post(`/api/voice/consult/answer?attempt=${direct.attemptId}&leg=va&ring=0`);
  assert.ok(!res.body.includes('missed his'), res.body);
  assert.match(res.body, /Potion planning call with Sarah M, booked for 10 AM, for Dallas\./);
});

test('/answer speaks the proposal details when there is a proposal, and skips them cleanly when there is not', async () => {
  const proposalId = await makeProposal('2026-11-14', 120);
  const withProposal = await makeChain('answer-proposal', { proposalId });
  let res = await post(`/api/voice/consult/answer?attempt=${withProposal.attemptId}&leg=admin&ring=1`);
  assert.ok(res.body.includes(`Event Saturday November 14th, 120 guests, proposal ${proposalId}.`), res.body);

  const bare = await makeChain('answer-no-proposal');
  res = await post(`/api/voice/consult/answer?attempt=${bare.attemptId}&leg=admin&ring=1`);
  assert.ok(!res.body.includes('Event '), res.body);
  assert.ok(!res.body.includes('guests'), res.body);
  assert.ok(!res.body.includes('proposal '), res.body);
});

test('/answer apologizes (never 500s) on a missing, terminal or malformed attempt, and on a leg mismatch', async () => {
  for (const path of [
    '/api/voice/consult/answer?attempt=999999999&leg=admin&ring=1',
    '/api/voice/consult/answer?attempt=abc&leg=admin&ring=1',
    '/api/voice/consult/answer?attempt=1&leg=zzz&ring=1',
  ]) {
    const res = await post(path);
    assert.equal(res.status, 200, path);
    assert.match(res.body, /Sorry, this consult call has expired\. Goodbye\./, path);
  }

  for (const status of ['pending', 'connected', 'missed', 'failed']) {
    const { attemptId } = await makeChain(`answer-${status}`, { status });
    const res = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=1`);
    assert.match(res.body, /expired/, status);
  }

  // Leg mismatch: the row is ringing Dallas, the callback claims to be Zul's.
  const { attemptId } = await makeChain('answer-legmismatch');
  const res = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=va&ring=0`);
  assert.match(res.body, /expired/);
});

test('/answer apologizes on a superseded ring instead of replaying a stale briefing (R5)', async () => {
  const { attemptId } = await makeChain('answer-stalering', { adminRing: 2 });
  for (const qs of ['&ring=1', '&ring=3', '&ring=abc', '']) {
    const res = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin${qs}`);
    assert.match(res.body, /expired/, `ring qs '${qs}'`);
  }
  const ok = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=2`);
  assert.match(ok.body, /Second try\./);
});

test('a hostile booker name is escaped into element text and NEVER reaches a TwiML attribute', async () => {
  const hostile = 'Zed "Quote" <Say>&inject</Say> Neil';
  const { attemptId } = await makeChain('hostile', { name: hostile });
  const answer = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=1`);
  assert.ok(!answer.body.includes('<Say>&inject'), 'raw injection must not appear');
  assert.ok(answer.body.includes('&lt;Say&gt;&amp;inject'), answer.body.slice(0, 400));

  const digit = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  const dialend = await post(`/api/voice/consult/dialend?attempt=${attemptId}&leg=admin`, { DialCallStatus: 'no-answer' });
  for (const [label, body] of [['answer', answer.body], ['digit', digit.body], ['dialend', dialend.body]]) {
    for (const value of attributeValues(body)) {
      for (const token of ['Zed', 'Quote', 'Neil', 'inject']) {
        assert.ok(!value.includes(token), `${label}: '${token}' reached the attribute '${value}'`);
      }
    }
  }
});

// ─── /digit ──────────────────────────────────────────────────────

test('/digit press 1 on the admin leg claims the bridge and dials the booker from the 1922', async () => {
  const { attemptId } = await makeChain('press1-admin', { adminRing: 2 });
  const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=2`, { Digits: '1' });
  assert.equal(res.status, 200);
  assert.match(res.body, new RegExp(`<Dial answerOnBridge="true" callerId="\\${CONSULT_CALLER_ID}" timeLimit="1800"`));
  assert.ok(res.body.includes(`action="/api/voice/consult/dialend?attempt=${attemptId}&amp;leg=admin"`), res.body);
  assert.ok(res.body.includes(
    `<Number statusCallback="${API_URL}/api/voice/consult/status?attempt=${attemptId}&amp;leg=client">${VALID_PHONE}</Number>`
  ), res.body);

  assert.deepEqual(guardCalls, [attemptId], 'the consult is re-checked before the claim');
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'connected');
  assert.equal(row.answered_by, 'admin');
  assert.ok(row.bridge_started_at);
});

test('/digit press 1 on the Zul leg dials from the 0082, never the 1922', async () => {
  const { attemptId } = await makeChain('press1-va');
  await pool.query(`UPDATE consult_call_attempts SET status = 'calling_va' WHERE id = $1`, [attemptId]);
  const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=va&ring=0`, { Digits: '1' });
  assert.match(res.body, new RegExp(`callerId="\\${VOICE_CALLER_ID}"`));
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'connected');
  assert.equal(row.answered_by, 'va');
});

test('/digit press 1 falls back to VOICE_CALLER_ID when CONSULT_CALLER_ID is unset or malformed', async () => {
  for (const [label, value] of [['unset', undefined], ['malformed', '224-222-1922'], ['empty', '   ']]) {
    const { attemptId } = await makeChain(`press1-fallback-${label}`);
    if (value === undefined) delete process.env.CONSULT_CALLER_ID; else process.env.CONSULT_CALLER_ID = value;
    try {
      const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
      assert.match(res.body, new RegExp(`callerId="\\${VOICE_CALLER_ID}"`), label);
    } finally {
      process.env.CONSULT_CALLER_ID = CONSULT_CALLER_ID;
    }
  }
});

test('/digit press 1 on a cancelled consult speaks the cancellation and NEVER claims', async () => {
  const { attemptId } = await makeChain('press1-cancelled');
  guardResult = { ok: false, detail: 'cancelled' };
  const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  assert.match(res.body, /<Say>This consult was cancelled\. Goodbye\.<\/Say><Hangup\/>/);
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_admin', 'the claim must be unspent so the callback can land skipped_cancelled');
  assert.equal(row.answered_by, null);
});

test('/digit press 1 with an undialable booker phone apologizes without claiming, and never reaches the guard', async () => {
  const { attemptId } = await makeChain('press1-badphone', { phone: '+442071234567' });
  const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  assert.match(res.body, /expired/);
  assert.deepEqual(guardCalls, [], 'the dial target is validated FIRST, before any other work');
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_admin', 'a claimed-but-unbridged connected row would never be reaped');
  assert.equal(row.answered_by, null);
});

test('/digit a second press apologizes and leaves the row connected to its first answerer', async () => {
  const { attemptId } = await makeChain('press1-twice');
  const first = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  assert.match(first.body, /<Dial /);
  const before = await rowOf(attemptId);

  const second = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  assert.match(second.body, /expired/);
  assert.ok(!second.body.includes('<Dial '), 'a duplicate press must never place a second billed call');
  const after = await rowOf(attemptId);
  assert.equal(after.status, 'connected');
  assert.equal(after.answered_by, 'admin');
  assert.equal(after.bridge_started_at.toISOString(), before.bridge_started_at.toISOString());
});

test('/digit press 1 from a superseded ring never claims (R9: the ring is bound into the claim)', async () => {
  const { attemptId } = await makeChain('press1-stalering', { adminRing: 2 });
  const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  assert.match(res.body, /expired/);
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_admin');
  assert.equal(row.answered_by, null);
});

test('/digit press 1 loses the claim when the ring moved between the read and the write (R9: the guard is on the WRITE)', async () => {
  // The race the ring guard exists for: the sweep places ring 2 while Dallas is
  // still on ring 1's leg. legMatches read a row that was current; only the
  // claim's own admin_ring = $4 can catch what happened after that read.
  const { attemptId } = await makeChain('press1-race');
  let bumped = false;
  router.__setConsultVoiceDeps({
    pool: {
      query: async (...args) => {
        const r = await pool.query(...args);
        if (!bumped) {
          bumped = true;
          await pool.query(`UPDATE consult_call_attempts SET admin_ring = 2 WHERE id = $1`, [attemptId]);
        }
        return r;
      },
    },
  });
  const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  assert.match(res.body, /expired/);
  assert.ok(!res.body.includes('<Dial '), 'a superseded ring must never bridge');
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_admin');
  assert.equal(row.answered_by, null);
});

test('/digit press 9 replays up to three plays, then apologizes', async () => {
  const { attemptId } = await makeChain('replay');
  const r1 = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1&play=1`, { Digits: '9' });
  assert.ok(r1.body.includes(`answer?attempt=${attemptId}&amp;leg=admin&amp;ring=1&amp;play=2`), r1.body);
  const r2 = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1&play=2`, { Digits: '9' });
  assert.ok(r2.body.includes('play=3'), r2.body);
  const r3 = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1&play=3`, { Digits: '9' });
  assert.match(r3.body, /expired/);
  assert.equal((await rowOf(attemptId)).status, 'calling_admin', 'a replay never touches the row');

  // An out-of-range play restarts the budget instead of being echoed into an
  // attribute: 'play=-9' + 1 would otherwise buy eight more replays.
  for (const junk of ['-9', 'abc', '99']) {
    const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1&play=${junk}`, { Digits: '9' });
    assert.ok(res.body.includes('play=2'), `play '${junk}' -> ${res.body}`);
    const answer = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=1&play=${junk}`);
    assert.ok(answer.body.includes('&amp;play=1'), `play '${junk}' -> ${answer.body}`);
  }
});

test('/digit any other key hangs up and leaves the chain to the status callback', async () => {
  const { attemptId } = await makeChain('otherkey');
  for (const digits of ['5', '', '0']) {
    const res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: digits });
    assert.match(res.body, /<Response><Hangup\/><\/Response>/, `digits '${digits}'`);
  }
  assert.equal((await rowOf(attemptId)).status, 'calling_admin');
});

// ─── /dialend ────────────────────────────────────────────────────

test('/dialend on a completed dial hangs up silently: no latch, no text', async () => {
  const { attemptId } = await makeChain('dialend-completed', { status: 'connected' });
  const res = await post(`/api/voice/consult/dialend?attempt=${attemptId}&leg=admin`, { DialCallStatus: 'completed' });
  assert.match(res.body, /<Response><Hangup\/><\/Response>/);
  assert.equal(textCalls.length, 0);
  const row = await rowOf(attemptId);
  assert.equal(row.client_no_answer_at, null);
  assert.equal(row.status, 'connected');
});

test('/dialend takes the cheap branch on an unrecognized DialCallStatus (allowlist, not a denylist of one)', async () => {
  // voice.js's MISSED_STATUSES precedent: only an explicitly recognized miss
  // costs money. A denylist of 'completed' would stamp the latch, text Dallas
  // and tell an agent who just had a good conversation that nobody answered,
  // on an absent DialCallStatus or any word Twilio adds later.
  for (const dialStatus of ['', 'in-progress', 'answered', 'banana', 'COMPLETED']) {
    const { attemptId } = await makeChain(`dialend-unknown-${dialStatus || 'empty'}`, { status: 'connected' });
    const form = dialStatus === '' ? {} : { DialCallStatus: dialStatus };
    const res = await post(`/api/voice/consult/dialend?attempt=${attemptId}&leg=admin`, form);
    assert.match(res.body, /<Response><Hangup\/><\/Response>/, `status '${dialStatus}' must not speak`);
    assert.equal((await rowOf(attemptId)).client_no_answer_at, null, `status '${dialStatus}' must not latch`);
  }
  assert.equal(textCalls.length, 0, 'an unrecognized dial status never texts');

  // canceled is the fourth recognized miss and is not covered above.
  const real = await makeChain('dialend-canceled', { status: 'connected' });
  const res = await post(`/api/voice/consult/dialend?attempt=${real.attemptId}&leg=admin`, { DialCallStatus: 'canceled' });
  assert.ok(res.body.includes('They did not answer.'), res.body);
  assert.deepEqual(textCalls, [{ attemptId: real.attemptId, kind: 'client_no_answer' }]);
});

test('/dialend on a no-answer latches once and texts once even when Twilio delivers it twice', async () => {
  const { attemptId } = await makeChain('dialend-noanswer', { status: 'connected' });
  const first = await post(`/api/voice/consult/dialend?attempt=${attemptId}&leg=admin`, { DialCallStatus: 'no-answer' });
  assert.ok(first.body.includes(`They did not answer. Their number is ${SPOKEN_PHONE}. Goodbye.`), first.body);
  assert.match(first.body, /<Hangup\/><\/Response>$/);
  assert.deepEqual(textCalls, [{ attemptId, kind: 'client_no_answer' }]);
  const stamped = await rowOf(attemptId);
  assert.ok(stamped.client_no_answer_at, 'the latch is its own column (R14)');
  assert.equal(stamped.status, 'connected', 'connected is terminal: the bridge happened');

  for (const dialStatus of ['no-answer', 'busy', 'failed']) {
    const dup = await post(`/api/voice/consult/dialend?attempt=${attemptId}&leg=admin`, { DialCallStatus: dialStatus });
    assert.ok(dup.body.includes('They did not answer.'), dialStatus);
  }
  assert.equal(textCalls.length, 1, 'a redelivered callback must never text a second time');
  assert.equal((await rowOf(attemptId)).client_no_answer_at, stamped.client_no_answer_at);
});

test('/dialend latches on the column, not detail, so an earlier Twilio error code cannot swallow the text (R14)', async () => {
  const { attemptId } = await makeChain('dialend-detail', { status: 'connected' });
  // Exactly what placeLeg's catch writes when an earlier ring failed to place.
  await pool.query(`UPDATE consult_call_attempts SET detail = '21211' WHERE id = $1`, [attemptId]);
  await post(`/api/voice/consult/dialend?attempt=${attemptId}&leg=admin`, { DialCallStatus: 'no-answer' });
  assert.deepEqual(textCalls, [{ attemptId, kind: 'client_no_answer' }]);
  const row = await rowOf(attemptId);
  assert.ok(row.client_no_answer_at);
  assert.equal(row.detail, '21211', 'detail stays the diagnostic an operator can look up');
});

test('/dialend on a row that is not connected texts nothing, and an unusable number drops the number only', async () => {
  // Never claimed (the press-1 lost its race): nothing to report.
  const stale = await makeChain('dialend-stale');
  await post(`/api/voice/consult/dialend?attempt=${stale.attemptId}&leg=admin`, { DialCallStatus: 'no-answer' });
  assert.equal(textCalls.length, 0);
  assert.equal((await rowOf(stale.attemptId)).client_no_answer_at, null);

  // Number edited out mid-chain: say what is known rather than a number nobody can call.
  const bad = await makeChain('dialend-badphone', { status: 'connected', phone: '+442071234567' });
  const res = await post(`/api/voice/consult/dialend?attempt=${bad.attemptId}&leg=admin`, { DialCallStatus: 'no-answer' });
  assert.ok(res.body.includes('<Say>They did not answer. Goodbye.</Say>'), res.body);
  assert.equal(textCalls.length, 1, 'the miss is still reported');
});

// ─── /status ─────────────────────────────────────────────────────

test('/status client leg stores a validated duration and NULLs anything else', async () => {
  for (const [raw, expected] of [['252', 252], ['0', 0], ['-1', null], ['abc', null], ['', null], ['3.5', null]]) {
    const { attemptId } = await makeChain(`status-dur-${raw || 'empty'}`, { status: 'connected' });
    const res = await post(`/api/voice/consult/status?attempt=${attemptId}&leg=client`,
      { CallStatus: 'completed', CallDuration: raw });
    assert.equal(res.status, 200, raw);
    assert.match(res.body, /<Response\/>/, raw);
    assert.equal((await rowOf(attemptId)).bridge_duration_sec, expected, `CallDuration '${raw}'`);
    assert.equal(legTerminalCalls.length, 0, 'the client leg never advances the chain');
  }

  // A redelivery carrying a bad value must never ERASE a good one already
  // recorded, the way writeLegStatus refuses the symmetric case.
  const { attemptId } = await makeChain('status-dur-redeliver', { status: 'connected' });
  await post(`/api/voice/consult/status?attempt=${attemptId}&leg=client`, { CallStatus: 'completed', CallDuration: '252' });
  assert.equal((await rowOf(attemptId)).bridge_duration_sec, 252);
  for (const raw of ['', 'abc', '-1']) {
    await post(`/api/voice/consult/status?attempt=${attemptId}&leg=client`, { CallStatus: 'completed', CallDuration: raw });
    assert.equal((await rowOf(attemptId)).bridge_duration_sec, 252, `redelivery with '${raw}' kept the recorded duration`);
  }
});

test('/status admin and va terminals hand off to onLegTerminal exactly once, carrying the ring', async () => {
  const admin = await makeChain('status-admin', { adminRing: 2 });
  const res = await post(`/api/voice/consult/status?attempt=${admin.attemptId}&leg=admin&ring=2`, { CallStatus: 'no-answer' });
  assert.equal(res.status, 200);
  assert.deepEqual(legTerminalCalls, [{ attemptId: admin.attemptId, leg: 'admin', ring: 2, callStatus: 'no-answer' }]);

  legTerminalCalls = [];
  const va = await makeChain('status-va');
  await pool.query(`UPDATE consult_call_attempts SET status = 'calling_va' WHERE id = $1`, [va.attemptId]);
  await post(`/api/voice/consult/status?attempt=${va.attemptId}&leg=va&ring=0`, { CallStatus: 'busy' });
  assert.deepEqual(legTerminalCalls, [{ attemptId: va.attemptId, leg: 'va', ring: 0, callStatus: 'busy' }]);

  legTerminalCalls = [];
  for (const path of ['/api/voice/consult/status?attempt=abc&leg=admin&ring=1',
                      `/api/voice/consult/status?attempt=${admin.attemptId}&leg=zzz&ring=1`]) {
    const bad = await post(path, { CallStatus: 'completed' });
    assert.equal(bad.status, 200, path);
  }
  assert.equal(legTerminalCalls.length, 0, 'a malformed callback advances nothing');
});

test('/status R25 gate 1: a non-terminal status is a COMPLETE no-op, on every leg', async () => {
  const { attemptId } = await makeChain('status-nonterminal', { adminRing: 1 });
  const before = await rowOf(attemptId);
  for (const callStatus of ['answered', 'ringing', 'in-progress', 'queued', 'initiated', 'weird-new-status', '']) {
    for (const leg of ['admin', 'va', 'client']) {
      const res = await post(`/api/voice/consult/status?attempt=${attemptId}&leg=${leg}&ring=1`,
        { CallStatus: callStatus, CallDuration: '99' });
      assert.equal(res.status, 200, `${leg}/${callStatus}`);
      assert.match(res.body, /<Response\/>/, `${leg}/${callStatus}`);
    }
  }
  assert.equal(legTerminalCalls.length, 0,
    'answered on a live ring 1 would re-arm the chain and ring Dallas a second time mid-briefing');
  assert.deepEqual(await rowOf(attemptId), before, 'not one column may move');
});

test('R25 gate 2: onLegTerminal itself refuses a non-terminal status, without trusting its only caller', async () => {
  const { attemptId } = await makeChain('gate2', { adminRing: 1 });
  const before = await rowOf(attemptId);
  for (const callStatus of ['answered', 'ringing', 'in-progress', 'queued']) {
    await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 1, callStatus });
  }
  assert.deepEqual(await rowOf(attemptId), before, 'the billed-effect boundary defends itself');

  // And the real terminal statuses still get through (the guard is a filter, not a wall).
  await chain.onLegTerminal({ attemptId, leg: 'admin', ring: 1, callStatus: 'no-answer' });
  const after = await rowOf(attemptId);
  assert.equal(after.status, 'pending', 'ring 1 no-answer still re-arms for ring 2');
  assert.equal(after.admin_call_status, 'no-answer');
});

// ─── never a 5xx to Twilio ───────────────────────────────────────

test('every route answers 200 when a dependency rejects (Twilio retries 5xx, and a retried callback is the hazard)', async () => {
  const { attemptId } = await makeChain('boom', { status: 'connected' });
  const boom = async () => { throw new Error('boom'); };
  router.__setConsultVoiceDeps({
    pool: { query: boom },
    onLegTerminal: boom,
    guardStillScheduled: boom,
    sendMissedText: boom,
  });

  const answer = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=1`);
  assert.equal(answer.status, 200);
  assert.match(answer.body, /expired/);

  const digit = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  assert.equal(digit.status, 200);
  assert.match(digit.body, /expired/);

  const dialend = await post(`/api/voice/consult/dialend?attempt=${attemptId}&leg=admin`, { DialCallStatus: 'no-answer' });
  assert.equal(dialend.status, 200);
  assert.match(dialend.body, /<Response>/);

  const status = await post(`/api/voice/consult/status?attempt=${attemptId}&leg=admin&ring=1`, { CallStatus: 'completed' });
  assert.equal(status.status, 200);
  assert.match(status.body, /<Response\/>/);

  // A throwing signature check must not 500 either, and must never do work.
  router.__setConsultVoiceDeps({ isValidTwilioRequest: () => { throw new Error('gate boom'); } });
  const gated = await post(`/api/voice/consult/status?attempt=${attemptId}&leg=admin&ring=1`, { CallStatus: 'completed' });
  assert.equal(gated.status, 200);
});

test('a non-Error rejection still answers TwiML: an unguarded err.message would leave the call HANGING', { timeout: 15000 }, async () => {
  // The failure this pins is not a 5xx. err.message on a null rejection throws
  // a TypeError inside the catch, the async handler rejects, Express 4 does not
  // await it, and no response is ever sent: the leg hangs until Twilio times
  // out. consultCallChain's captureError guards the same value for the same
  // reason. Rejecting with null, a string and a plain object covers the shapes.
  const { attemptId } = await makeChain('nonerror', { status: 'connected' });
  for (const value of [null, undefined, 'boom', { code: 42 }]) {
    const reject = async () => { throw value; };
    router.__setConsultVoiceDeps({
      pool: { query: reject }, onLegTerminal: reject, guardStillScheduled: reject, sendMissedText: reject,
    });
    const label = String(value);
    for (const [path, form] of [
      [`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=1`, {}],
      [`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' }],
      [`/api/voice/consult/dialend?attempt=${attemptId}&leg=admin`, { DialCallStatus: 'no-answer' }],
      [`/api/voice/consult/status?attempt=${attemptId}&leg=admin&ring=1`, { CallStatus: 'completed' }],
    ]) {
      const res = await post(path, form);
      assert.equal(res.status, 200, `${path} rejected with ${label}`);
      assert.match(res.body, /<Response/, `${path} rejected with ${label}`);
    }
  }
});
