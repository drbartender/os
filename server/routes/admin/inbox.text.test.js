require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// POST /api/admin/inbox/:personKey/text (spec 2026-10-06, section 8, and
// amendments 2, 3 and 8) against the dev DB. A fake Twilio client sits behind
// sendSMS's own seam, so the real send path runs (the 21610 hook included).
// That fake client is what keeps Twilio out: before() installs it through the
// same seam as notificationsEnabled: () => true, so SEND_NOTIFICATIONS=false
// does not stop a text while they are in place; after() puts back a null
// client and the real gate.
// Each test texts as a fresh admin, because adminWriteLimiter allows 10 writes
// a minute per user. Every seeded row is removed in before() and after().

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');

if (process.env.NODE_ENV === 'production') throw new Error('inbox.text.test.js refuses to run against production');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const sms = require('../../utils/sms');
const { notificationsEnabled } = require('../../utils/notificationsEnabled');
const { lineE164 } = require('../../utils/smsLines');
const { recordOptOut, BAD_NUMBER_MESSAGE } = require('../../utils/smsOptOut');
const cache = require('../../utils/inbox/cache');
const engine = require('../../utils/inbox/engine');
const inboxRouter = require('./inbox');

const ORIG_LINES = process.env.INBOX_TEXT_LINES;
const ORIG_888 = process.env.TWILIO_PHONE_NUMBER;
const FAKE_888 = '+18885550100';
// Fixed identifiers, not per run, so before() also clears whatever a crashed
// earlier run left behind. Invented numbers in the 555-01xx range.
const TAG = 'inbox-text-test';
const phone = (i) => `+1630555${String(100 + i).padStart(4, '0')}`;
const P = {
  plain: phone(0), twoA: phone(1), twoB: phone(2), opted: phone(3), bad: phone(4), first: phone(5),
  fail: phone(6), optfail: phone(7), cache: phone(8), staff: phone(9), cold: phone(10),
  early: phone(11), retry: phone(12), edge: phone(13),
};
// Every failure callback this suite plants in sms_status_orphans starts so.
const ORPHAN_SID = 'SMinboxtextorphan';
const TEN = Object.values(P).map((p) => p.slice(-10));
const ids = { users: [], clients: [] };
const C = {};
let staffId;
let managerId;
let server;
let baseUrl;
let calls = [];
let twilioImpl = null;

function okTwilio(params) {
  return { sid: `SMinboxtext${crypto.randomBytes(8).toString('hex')}`, from: params.from, status: 'queued' };
}

function twilioError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

function call(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function makeAdmin() {
  const r = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, token_version",
    [`${TAG}-admin-${ids.users.length}@example.com`]
  );
  ids.users.push(r.rows[0].id);
  const token = jwt.sign({ userId: r.rows[0].id, tokenVersion: r.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { id: r.rows[0].id, token };
}

async function addClient(label, ph) {
  const r = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`${label} Example ${TAG}`, ph]);
  ids.clients.push(r.rows[0].id);
  return r.rows[0].id;
}

async function addInbound(clientId, from, body, ago) {
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, status, metadata, created_at)
     VALUES ('inbound', $1, $2, $3, 'received', $4::jsonb, NOW() - $5::interval)`,
    [clientId, from, body, JSON.stringify({ from }), ago]
  );
}

// Everything this suite seeds, found by its tag, its client names and its phone block.
async function clean() {
  const users = (await pool.query('SELECT id FROM users WHERE email LIKE $1', [`${TAG}-%`])).rows.map((r) => r.id);
  const clients = (await pool.query('SELECT id FROM clients WHERE name LIKE $1', [`%${TAG}`])).rows.map((r) => r.id);
  const keys = [...clients.map((id) => `c-${id}`), ...users.map((id) => `s-${id}`), ...TEN.map((t) => `p-${t}`)];
  await pool.query('DELETE FROM inbox_sends WHERE person_key = ANY($1::text[]) OR user_id = ANY($2::int[])', [keys, users]);
  await pool.query('DELETE FROM sms_status_orphans WHERE twilio_sid LIKE $1', [`${ORPHAN_SID}%`]);
  await pool.query(
    `DELETE FROM sms_messages
      WHERE RIGHT(REGEXP_REPLACE(recipient_phone, '\\D', '', 'g'), 10) = ANY($1::text[])
         OR client_id = ANY($2::int[]) OR sender_id = ANY($3::int[]) OR recipient_id = ANY($3::int[])`,
    [TEN, clients, users]
  );
  await pool.query('DELETE FROM message_log WHERE client_id = ANY($1::int[])', [clients]);
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [TEN]);
  await pool.query('DELETE FROM agreements WHERE user_id = ANY($1::int[])', [users]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [users]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clients]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]);
}

const text = (who, personKey, body) => call('POST', `/api/admin/inbox/${personKey}/text`, { token: who.token, body });
const fresh = (body, line = '888') => ({ body, line, send_id: crypto.randomUUID() });
const rowBySendId = async (sendId) => (await pool.query(
  "SELECT client_id, recipient_id, sender_id, group_id, status, error_message, metadata FROM sms_messages WHERE metadata->>'send_id' = $1",
  [sendId]
)).rows;

before(async () => {
  await clean();
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  sms.__setSmsDeps({
    client: { messages: { create: (params) => new Promise((resolve) => { calls.push(params); resolve(twilioImpl(params)); }) } },
    notificationsEnabled: () => true,
  });
  C.plain = await addClient('Plain', P.plain);
  C.two = await addClient('Two', P.twoA);
  await addInbound(C.two, P.twoB, 'Texting from my work phone', '2 hours');
  C.opted = await addClient('Opted', P.opted);
  await recordOptOut({ phone: P.opted, source: 'keyword', line: '1922' });
  C.bad = await addClient('Bad', P.bad);
  await pool.query("UPDATE clients SET phone_status = 'bad' WHERE id = $1", [C.bad]);
  C.first = await addClient('First', P.first);
  C.fail = await addClient('Fail', P.fail);
  C.optfail = await addClient('Optfail', P.optfail);
  C.cache = await addClient('Cache', P.cache);
  C.early = await addClient('Early', P.early);
  C.retry = await addClient('Retry', P.retry);
  C.edge = await addClient('Edge', P.edge);
  await addInbound(C.cache, P.cache, 'Are you free on the 3rd?', '1 hour');
  const staff = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id",
    [`${TAG}-staff@example.com`]
  );
  staffId = staff.rows[0].id;
  ids.users.push(staffId);
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name, phone) VALUES ($1, $2, $3)', [staffId, `Sam ${TAG}`, P.staff]);
  await pool.query('INSERT INTO agreements (user_id, sms_consent) VALUES ($1, true)', [staffId]);
  const manager = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'manager', 'approved', 0) RETURNING id",
    [`${TAG}-manager@example.com`]
  );
  managerId = manager.rows[0].id;
  ids.users.push(managerId);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', inboxRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

beforeEach(() => {
  calls = [];
  twilioImpl = okTwilio;
  process.env.INBOX_TEXT_LINES = '888';
});

after(async () => {
  sms.__setSmsDeps({ client: null, notificationsEnabled });
  if (ORIG_LINES === undefined) delete process.env.INBOX_TEXT_LINES;
  else process.env.INBOX_TEXT_LINES = ORIG_LINES;
  if (ORIG_888 === undefined) delete process.env.TWILIO_PHONE_NUMBER;
  else process.env.TWILIO_PHONE_NUMBER = ORIG_888;
  if (server) await new Promise((resolve) => server.close(resolve));
  await clean();
  await pool.end();
});

test('a request that is not a text is 400 and reserves nothing', async () => {
  const admin = await makeAdmin();
  const sendId = crypto.randomUUID();
  const cases = [
    [{ body: '   ', line: '888', send_id: sendId }, 'body'],
    [{ body: 'x'.repeat(1601), line: '888', send_id: sendId }, 'body'],
    [{ body: 'Hello', line: '999', send_id: sendId }, 'line'],
    [{ body: 'Hello', line: '888', send_id: 'not-a-uuid' }, 'send_id'],
    [{ body: 'Hello', line: '888' }, 'send_id'],
  ];
  for (const [body, field] of cases) {
    const res = await text(admin, `c-${C.plain}`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const fieldError = new Map(Object.entries(res.body.fieldErrors || {})).get(field);
    assert.ok(fieldError, field);
    assert.equal(res.body.error, fieldError, 'the toast reads the real problem');
  }
  assert.equal(calls.length, 0);
  assert.equal((await pool.query('SELECT 1 FROM inbox_sends WHERE send_id = $1', [sendId])).rowCount, 0);
});

test('a client text: 201 with its thread row, sent once from the asked line with the status callback, recorded with sender, line and send id', async () => {
  const admin = await makeAdmin();
  const req = fresh('  See you Saturday  ');
  const res = await text(admin, `c-${C.plain}`, req);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const m = res.body.message;
  assert.deepEqual([m.direction, m.channel, m.line, m.text, m.author_name, m.failed], ['out', 'text', '888', 'See you Saturday', 'You', false]);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].from, calls[0].to, calls[0].body], [FAKE_888, P.plain, 'See you Saturday']);
  assert.match(calls[0].statusCallback, /\/api\/sms\/status$/);
  const rows = await rowBySendId(req.send_id);
  assert.deepEqual([rows.length, rows[0].client_id, rows[0].sender_id, rows[0].status, rows[0].metadata],
    [1, C.plain, admin.id, 'sent', { line: '888', send_id: req.send_id }]);
  const stored = (await pool.query('SELECT result FROM inbox_sends WHERE send_id = $1', [req.send_id])).rows[0].result;
  assert.deepEqual(stored, { status: 201, body: res.body });
});

test('a repeat send_id returns the first answer and sends nothing; a running one is 409; another user\'s is 409; a race texts once', async () => {
  const admin = await makeAdmin();
  const req = fresh('Once only');
  const first = await text(admin, `c-${C.plain}`, req);
  const again = await text(admin, `c-${C.plain}`, req);
  assert.deepEqual([first.status, again.status], [201, 201]);
  assert.deepEqual(again.body, first.body);
  assert.equal(calls.length, 1);
  const stolen = await text(await makeAdmin(), `c-${C.plain}`, req);
  assert.deepEqual([stolen.status, stolen.body.code], [409, 'INBOX_SEND_ID_REUSED']);
  const running = crypto.randomUUID();
  await pool.query('INSERT INTO inbox_sends (send_id, person_key, user_id) VALUES ($1, $2, $3)', [running, `c-${C.plain}`, admin.id]);
  const busy = await text(admin, `c-${C.plain}`, { ...fresh('Still going'), send_id: running });
  assert.deepEqual([busy.status, busy.body.code], [409, 'INBOX_SEND_IN_PROGRESS']);
  const race = fresh('Double tap');
  const both = await Promise.all([text(admin, `c-${C.plain}`, race), text(admin, `c-${C.plain}`, race)]);
  assert.equal(calls.length, 2, 'the race texted once');
  const statuses = both.map((r) => r.status).sort();
  assert.ok(statuses[0] === 201 && [201, 409].includes(statuses[1]), JSON.stringify(statuses));
});

test('a reservation left with no answer for over 2 minutes is 409 INBOX_SEND_UNRECORDED, never in progress for good', async () => {
  const admin = await makeAdmin();
  const stuck = crypto.randomUUID();
  await pool.query(
    "INSERT INTO inbox_sends (send_id, person_key, user_id, created_at) VALUES ($1, $2, $3, NOW() - INTERVAL '3 minutes')",
    [stuck, `c-${C.plain}`, admin.id]
  );
  const res = await text(admin, `c-${C.plain}`, { ...fresh('Hello'), send_id: stuck });
  assert.deepEqual([res.status, res.body.code], [409, 'INBOX_SEND_UNRECORDED']);
  assert.equal(calls.length, 0);
});

test('the reply goes to the number they last texted from (decision 29), not the phone on file', async () => {
  const res = await text(await makeAdmin(), `c-${C.two}`, fresh('Got it, thanks'));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(calls[0].to, P.twoB);
});

test('who cannot be texted is 422 INBOX_NOT_TEXTABLE, and nothing is sent', async () => {
  const admin = await makeAdmin();
  for (const personKey of [`p-${P.cold.slice(-10)}`, 'c-2147483000', `s-${managerId}`]) {
    const res = await text(admin, personKey, fresh('Hello'));
    assert.deepEqual([res.status, res.body.code], [422, 'INBOX_NOT_TEXTABLE'], personKey);
  }
  assert.equal(calls.length, 0);
});

test('a line not turned on is 422; staff get the 888 only, and their text goes through the staff core', async () => {
  const admin = await makeAdmin();
  const off = await text(admin, `c-${C.plain}`, fresh('From the 1922', '1922'));
  assert.deepEqual([off.status, off.body.code], [422, 'INBOX_LINE_NOT_ENABLED']);
  process.env.INBOX_TEXT_LINES = '888,1922';
  const staffKey = `s-${staffId}`;
  const no = await text(admin, staffKey, fresh('From the 1922', '1922'));
  assert.deepEqual([no.status, no.body.code], [422, 'INBOX_LINE_NOT_ALLOWED']);
  const req = fresh('Can you cover Friday?');
  const yes = await text(admin, staffKey, req);
  assert.equal(yes.status, 201, JSON.stringify(yes.body));
  assert.deepEqual([yes.body.message.channel, yes.body.message.line], ['staff_text', '888']);
  assert.deepEqual([calls.length, calls[0].to, calls[0].from], [1, P.staff, FAKE_888]);
  const [row] = await rowBySendId(req.send_id);
  assert.deepEqual([row.client_id, row.recipient_id, row.sender_id, row.metadata], [null, staffId, admin.id, { line: '888', send_id: req.send_id }]);
  assert.ok(row.group_id);
});

test('a staff text the core reports failed is an error with the failed row kept, never a 201', async () => {
  const admin = await makeAdmin();
  twilioImpl = () => { throw twilioError(30007, 'Message filtered'); };
  const req = fresh('Can you cover Sunday?');
  const res = await text(admin, `s-${staffId}`, req);
  assert.deepEqual([res.status, res.body.code], [502, 'EXTERNAL_SERVICE_ERROR']);
  assert.match(res.body.error, /Filtered by the carrier \(Twilio 30007\)/);
  const rows = await rowBySendId(req.send_id);
  assert.deepEqual([rows.length, rows[0].recipient_id, rows[0].status, rows[0].error_message], [1, staffId, 'failed', 'Twilio 30007 (failed)']);
});

test('a staff text Twilio took whose row did not save is 500 INBOX_SEND_UNRECORDED, replayed on a repeat, never sent twice', async () => {
  const admin = await makeAdmin();
  // A sid longer than sms_messages.twilio_sid (VARCHAR(100)) makes the staff
  // core's INSERT fail after the send, so it throws StaffTextUnrecordedError
  // (lane sms-lines, spec amendment 29).
  twilioImpl = (params) => ({ ...okTwilio(params), sid: `SMinboxtext${'x'.repeat(120)}` });
  const req = fresh('Can you cover Monday?');
  // Sentry is never initialized here: a dummy DSN only opens the capture
  // branch, and the stub records what it would have been handed.
  const captured = [];
  const realCapture = Sentry.captureException;
  const realDsn = process.env.SENTRY_DSN_SERVER;
  process.env.SENTRY_DSN_SERVER = 'https://public@example.invalid/1';
  Sentry.captureException = (error, context) => { captured.push({ error, context }); return 'stub'; };
  let res;
  try {
    res = await text(admin, `s-${staffId}`, req);
  } finally {
    Sentry.captureException = realCapture;
    if (realDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
    else process.env.SENTRY_DSN_SERVER = realDsn;
  }
  assert.deepEqual([res.status, res.body.code], [500, 'INBOX_SEND_UNRECORDED']);
  assert.equal(calls.length, 1);
  // Sentry gets a code-only error made at the capture site, never the raw one.
  assert.equal(captured.length, 1, 'the lost record is captured once');
  const [{ error, context }] = captured;
  assert.equal(error.constructor, Error, 'a plain Error, not the raw StaffTextUnrecordedError');
  assert.equal(error.message, 'Inbox text sent but not recorded: StaffTextUnrecordedError (22001)');
  assert.deepEqual(context.tags, { area: 'inbox_text', sqlstate: '22001' });
  const sent = JSON.stringify({ message: error.message, stack: error.stack, context });
  assert.ok(!sent.includes(P.staff.slice(-10)) && !sent.includes('Can you cover Monday?'), 'no number, no text');
  assert.equal((await rowBySendId(req.send_id)).length, 0, 'no row was written');
  const again = await text(admin, `s-${staffId}`, req);
  assert.deepEqual([again.status, again.body], [500, res.body]);
  assert.equal(calls.length, 1, 'the repeat sent nothing');
});

test('an opted-out person is refused with 409 on every line, and nothing is sent', async () => {
  const res = await text(await makeAdmin(), `c-${C.opted}`, fresh('Hello'));
  assert.deepEqual([res.status, res.body.code], [409, 'INBOX_OPTED_OUT']);
  assert.match(res.body.error, /^Texts are off for this person/);
  assert.equal(calls.length, 0);
});

test('a number marked bad is 422 INBOX_BAD_NUMBER, and nothing is sent', async () => {
  const res = await text(await makeAdmin(), `c-${C.bad}`, fresh('Hello'));
  assert.deepEqual([res.status, res.body.code, res.body.error], [422, 'INBOX_BAD_NUMBER', BAD_NUMBER_MESSAGE]);
  assert.equal(calls.length, 0);
});

test('Twilio 21610 at send: the failed row stays, sms_optouts is written, the answer is 409 and a repeat replays it', async () => {
  const admin = await makeAdmin();
  twilioImpl = () => { throw twilioError(21610, 'Attempt to send to unsubscribed recipient'); };
  const req = fresh('Hello there');
  const res = await text(admin, `c-${C.optfail}`, req);
  assert.deepEqual([res.status, res.body.code], [409, 'INBOX_OPTED_OUT']);
  const rows = await rowBySendId(req.send_id);
  assert.deepEqual([rows.length, rows[0].status, rows[0].error_message], [1, 'failed', 'Twilio 21610 (failed)']);
  const opt = await pool.query('SELECT source, cleared_at FROM sms_optouts WHERE phone_last10 = $1', [P.optfail.slice(-10)]);
  assert.deepEqual(opt.rows, [{ source: 'twilio_21610', cleared_at: null }]);
  const again = await text(admin, `c-${C.optfail}`, req);
  assert.deepEqual([again.status, again.body], [409, res.body]);
  assert.equal(calls.length, 1);
});

test('any other Twilio failure keeps the failed row and is 502, replayed on a repeat; a new send id sends again', async () => {
  const admin = await makeAdmin();
  twilioImpl = () => { throw twilioError(21211, "The 'To' number is not a valid phone number."); };
  const req = fresh('Hello there');
  const res = await text(admin, `c-${C.fail}`, req);
  assert.deepEqual([res.status, res.body.code], [502, 'EXTERNAL_SERVICE_ERROR']);
  assert.match(res.body.error, /Not a valid phone number \(Twilio 21211\)/);
  assert.match(res.body.error, /saved in the thread as failed/);
  const rows = await rowBySendId(req.send_id);
  assert.deepEqual([rows.length, rows[0].status, rows[0].error_message], [1, 'failed', 'Twilio 21211 (failed)']);
  const again = await text(admin, `c-${C.fail}`, req);
  assert.deepEqual([again.status, again.body], [502, res.body]);
  assert.equal(calls.length, 1);
  twilioImpl = okTwilio;
  assert.equal((await text(admin, `c-${C.fail}`, fresh('Hello there'))).status, 201);
  assert.equal(calls.length, 2);
});

test('the first text from a 224 line starts "Dr. Bartender: ", and the next one does not', async () => {
  const admin = await makeAdmin();
  process.env.INBOX_TEXT_LINES = '888,1922';
  const one = await text(admin, `c-${C.first}`, fresh('Hello from our new number', '1922'));
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.deepEqual([calls[0].from, calls[0].body], [lineE164('1922'), 'Dr. Bartender: Hello from our new number']);
  assert.deepEqual([one.body.message.line, one.body.message.text], ['1922', 'Dr. Bartender: Hello from our new number']);
  const two = await text(admin, `c-${C.first}`, fresh('One more thing', '1922'));
  assert.deepEqual([two.status, calls[1].body], [201, 'One more thing']);
});

test('a send clears the cache, so the person reads as answered at once', async () => {
  const admin = await makeAdmin();
  const list = async () => (await call('GET', '/api/admin/inbox', { token: admin.token })).body;
  assert.ok((await list()).waiting.some((r) => r.person_key === `c-${C.cache}`));
  const g0 = cache.generationNow();
  assert.equal((await text(admin, `c-${C.cache}`, fresh('Yes, the 3rd works'))).status, 201);
  assert.ok(cache.generationNow() > g0);
  const body = await list();
  assert.ok(!body.waiting.some((r) => r.person_key === `c-${C.cache}`));
  assert.equal(body.handled.find((r) => r.person_key === `c-${C.cache}`).reason_text, 'You texted back from 888');
});

// Merge review (database M1): the status callback can store a fast failure
// before the route's INSERT; the route folds it in as the Messages reply does.
test('a failure callback that beat the row is folded in: the row ends failed, and the 201 shows it failed with its reason', async () => {
  const admin = await makeAdmin();
  twilioImpl = async (params) => {
    const sent = { ...okTwilio(params), sid: `${ORPHAN_SID}${crypto.randomBytes(6).toString('hex')}` };
    await pool.query("INSERT INTO sms_status_orphans (twilio_sid, status, error_message) VALUES ($1, 'failed', 'Twilio 30005 (undelivered)')", [sent.sid]);
    return sent;
  };
  const req = fresh('See you at 6');
  const res = await text(admin, `c-${C.early}`, req);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual([res.body.message.failed, res.body.message.failure_reason], [true, 'Unknown or inactive number (Twilio 30005)']);
  const [row] = await rowBySendId(req.send_id);
  assert.deepEqual([row.status, row.error_message], ['failed', 'Twilio 30005 (undelivered)']);
});

test('an early failure never counts as a first text: the next text from the 1922 still starts "Dr. Bartender: "', async () => {
  const admin = await makeAdmin();
  process.env.INBOX_TEXT_LINES = '888,1922';
  const sid = `${ORPHAN_SID}first0001`;
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, status, twilio_sid, sender_id, metadata)
     VALUES ('outbound', $1, $2, 'Dr. Bartender: Hello from our new number', 'sent', $3, $4, '{"line":"1922"}'::jsonb)`,
    [C.retry, P.retry, sid, admin.id]
  );
  await pool.query("INSERT INTO sms_status_orphans (twilio_sid, status, error_message) VALUES ($1, 'failed', 'Twilio 30005 (undelivered)')", [sid]);
  const res = await text(admin, `c-${C.retry}`, fresh('Hello again from our new number', '1922'));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(calls[0].body, 'Dr. Bartender: Hello again from our new number');
});

// One query of the route fails once, only after Twilio was called.
function failAfterSend(prefix) {
  const state = { armed: false };
  const realQuery = pool.query;
  pool.query = function failsOnceAfterTheSend(sql, ...rest) {
    if (state.armed && typeof sql === 'string' && sql.trim().startsWith(prefix)) {
      state.armed = false;
      return Promise.reject(Object.assign(new Error('induced failure'), { code: '57P01' }));
    }
    return realQuery.call(this, sql, ...rest);
  };
  return { state, restore: () => { pool.query = realQuery; } };
}

test('after a failed send, a stored answer that cannot be saved still answers 502 with the real copy', async () => {
  const admin = await makeAdmin();
  const induced = failAfterSend('UPDATE inbox_sends SET result');
  twilioImpl = () => { induced.state.armed = true; throw twilioError(30007, 'Message filtered'); };
  let res;
  try {
    res = await text(admin, `c-${C.edge}`, fresh('Hello there'));
  } finally {
    induced.restore();
  }
  assert.deepEqual([res.status, res.body.code], [502, 'EXTERNAL_SERVICE_ERROR']);
  assert.match(res.body.error, /Filtered by the carrier \(Twilio 30007\)/);
  assert.equal(induced.state.armed, false, 'the save was tried, and failed');
  assert.equal(calls.length, 1);
});

test('after a failed send, an opt-out lookup that fails falls back to the 502, never "may have gone out"', async () => {
  const admin = await makeAdmin();
  const induced = failAfterSend('SELECT opted_out_at, source, line FROM sms_optouts');
  twilioImpl = () => { induced.state.armed = true; throw twilioError(30007, 'Message filtered'); };
  let res;
  try {
    res = await text(admin, `c-${C.edge}`, fresh('Hello there'));
  } finally {
    induced.restore();
  }
  assert.deepEqual([res.status, res.body.code], [502, 'EXTERNAL_SERVICE_ERROR']);
  assert.match(res.body.error, /saved in the thread as failed/);
  assert.equal(induced.state.armed, false, 'the lookup was tried, and failed');
});

test('a refused text keeps the cache: the snapshot its fresh read loaded serves the next list read', async () => {
  const admin = await makeAdmin();
  let loads = 0;
  engine.__setEngineDeps({ computeSnapshot: (args) => { loads += 1; return engine.computeSnapshot(args); } });
  try {
    const res = await text(admin, `c-${C.opted}`, fresh('Hello'));
    assert.deepEqual([res.status, res.body.code, calls.length], [409, 'INBOX_OPTED_OUT', 0]);
    assert.equal(loads, 1, 'the route read once, fresh');
    assert.equal((await call('GET', '/api/admin/inbox', { token: admin.token })).status, 200);
    assert.equal(loads, 1, 'a refusal writes nothing the engine reads, so the list reuses that snapshot');
  } finally {
    engine.__setEngineDeps({ computeSnapshot: null });
  }
});

test('a fold that fails is best effort: the 201 stands with the row as inserted, and the log carries no number and no text', async () => {
  const admin = await makeAdmin();
  const induced = failAfterSend('UPDATE sms_messages m SET status');
  twilioImpl = (params) => { induced.state.armed = true; return okTwilio(params); };
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  let res;
  try {
    res = await text(admin, `c-${C.edge}`, fresh('See you at 7'));
  } finally {
    console.error = realError;
    induced.restore();
  }
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.message.failed, false);
  assert.equal(induced.state.armed, false, 'the fold was tried, and failed');
  const line = logged.find((l) => l.includes('could not fold'));
  assert.ok(line, 'the failure is logged');
  assert.ok(!line.includes(P.edge.slice(-10)) && !line.includes('See you at 7'), 'no number, no text');
});
