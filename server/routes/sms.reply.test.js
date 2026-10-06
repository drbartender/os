require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// POST /api/sms/conversations/:clientId/reply after spec 2026-10-06 (Inbox,
// section 9): adminWriteLimiter, the default line (decision 9), the opt-out
// refusal (409 INBOX_OPTED_OUT, sms_optouts included), the bad-number refusal,
// metadata.line, the status callback, sent_by, and a failure callback that
// beat the row folded into it. Since checkpoint 2: the 1600 cap, every refusal
// carrying its sentence, and no step after a sent text ever answering "try
// again". Clients sit on 312-555-13xx; every row is removed in before() and
// after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('sms.reply.test.js refuses to run against production');
}

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { __setSmsDeps } = require('../utils/sms');
const { notificationsEnabled } = require('../utils/notificationsEnabled');
const { API_URL } = require('../utils/urls');
const smsRouter = require('./sms');

const NONCE = `${Date.now()}`;
const FAKE_888 = '+18885550100';
const ORIG_888 = process.env.TWILIO_PHONE_NUMBER;
const ORIG_LINES = process.env.INBOX_TEXT_LINES;
const PHONES10 = [
  '3125551301', '3125551302', '3125551303', '3125551304', '3125551305',
  '3125551306', '3125551307', '3125551308', '3125551309', '3125551310', '3125551311',
  '3125551312', '3125551313', '3125551314',
];
// The sid of the early-failure case: fixed, so clean() also removes an orphan
// a killed run left behind.
const EARLY_SID = 'SMreply_test_early';

let server;
let baseUrl;
const C = {};
const A = {};

async function clean() {
  await pool.query("DELETE FROM thumbtack_leads WHERE negotiation_id LIKE 'tt-reply-proxy-%'");
  const ids = (await pool.query("SELECT id FROM clients WHERE email LIKE 'sms-reply-%@example.com'")).rows.map((r) => r.id);
  if (ids.length) {
    await pool.query('DELETE FROM sms_messages WHERE client_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM message_log WHERE client_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE client_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [PHONES10]);
  await pool.query('DELETE FROM sms_status_orphans WHERE twilio_sid = $1', [EARLY_SID]);
  await pool.query("DELETE FROM users WHERE email LIKE 'sms-reply-admin-%@example.com'");
}

async function mkClient(label, phone, { prefs = null, phoneStatus = 'ok' } = {}) {
  const r = await pool.query(
    `INSERT INTO clients (name, email, phone, communication_preferences, phone_status)
     VALUES ($1, $2, $3,
             COALESCE($4::jsonb, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb), $5)
     RETURNING id`,
    [`Reply Test ${label}`, `sms-reply-${label}-${NONCE}@example.com`, phone,
      prefs ? JSON.stringify(prefs) : null, phoneStatus]
  );
  return r.rows[0].id;
}

async function mkAdmin(label) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`sms-reply-admin-${label}-${NONCE}@example.com`]
  );
  const id = r.rows[0].id;
  return { id, token: jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

function postJson(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(baseUrl + path);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function withTwilio(createImpl) {
  const calls = [];
  __setSmsDeps({
    client: { messages: { create: async (params) => { calls.push(params); return createImpl(params); } } },
    notificationsEnabled: () => true,
  });
  process.env.TWILIO_PHONE_NUMBER = FAKE_888;
  return calls;
}

function restoreTwilio() {
  __setSmsDeps({ client: null, notificationsEnabled });
  if (ORIG_888 === undefined) delete process.env.TWILIO_PHONE_NUMBER;
  else process.env.TWILIO_PHONE_NUMBER = ORIG_888;
}

function setLines(value) {
  if (value === undefined) delete process.env.INBOX_TEXT_LINES;
  else process.env.INBOX_TEXT_LINES = value;
}

async function rowById(id) {
  const r = await pool.query('SELECT status, sender_id, metadata FROM sms_messages WHERE id = $1', [id]);
  return r.rows[0];
}

before(async () => {
  await clean();
  const app = express();
  app.use(express.json());
  app.use('/api/sms', smsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  A.a = await mkAdmin('a');
  A.b = await mkAdmin('b');
  A.limit = await mkAdmin('limit');
  // Its own limiter bucket, for the checkpoint 2 cases at the end.
  A.c = await mkAdmin('c');

  C.plain = await mkClient('plain', '3125551301');
  C.prefsOff = await mkClient('prefsoff', '3125551302', {
    prefs: { sms_enabled: false, marketing_enabled: true, sms_opt_out_at: '2026-09-01 15:00:00+00' },
  });
  C.optout = await mkClient('optout', '3125551303');
  C.cleared = await mkClient('cleared', '3125551304');
  C.history = await mkClient('history', '3125551305');
  C.bad = await mkClient('bad', '3125551306', { phoneStatus: 'bad' });
  C.proxy = await mkClient('proxy', '3125551307');
  C.t21610 = await mkClient('t21610', '3125551308');
  C.sentBy = await mkClient('sentby', '3125551309');
  C.relay = await mkClient('relay', '3125551310');
  C.fail = await mkClient('fail', '3125551311');
  C.early = await mkClient('early', '3125551312');
  C.unrecorded = await mkClient('unrecorded', '3125551313');
  C.foldFail = await mkClient('foldfail', '3125551314');

  await pool.query(
    `INSERT INTO sms_optouts (phone_last10, opted_out_at, source, line)
     VALUES ('3125551303', '2026-09-03T12:00:00Z', 'keyword', '888')`
  );
  await pool.query(
    `INSERT INTO sms_optouts (phone_last10, opted_out_at, source, line, cleared_at)
     VALUES ('3125551304', '2026-09-03T12:00:00Z', 'keyword', '888', '2026-09-04T12:00:00Z')`
  );
  // The history and proxy clients last texted the 1922.
  for (const [clientId, phone] of [[C.history, '+13125551305'], [C.proxy, '+13125551307']]) {
    await pool.query(
      `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, metadata, created_at)
       VALUES ('inbound', $1, $2, 'Is Saturday still on?', 'general', 'received', '{"to":"+12242221922"}', NOW() - INTERVAL '1 hour')`,
      [clientId, phone]
    );
  }
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_phone, customer_name, raw_payload)
     VALUES ($1, $2, '3125551307', 'Reply Proxy Lead', '{}'::jsonb)`,
    [`tt-reply-proxy-${NONCE}`, C.proxy]
  );
  await pool.query("INSERT INTO proposals (client_id, status) VALUES ($1, 'draft')", [C.sentBy]);
  // The relay client texted the 1922, then wrote again through a Thumbtack
  // proxy number, which only ever texts the 888.
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, metadata, created_at) VALUES
       ('inbound', $1, '+13125551310', 'Can we talk tomorrow?', 'general', 'received',
        '{"to":"+12242221922"}', NOW() - INTERVAL '2 hours'),
       ('inbound', $1, '+13125551398', 'Following up on my quote', 'general', 'received',
        '{"to":"+18885550100","thumbtack_relay":true}', NOW() - INTERVAL '1 hour')`,
    [C.relay]
  );
});

after(async () => {
  await clean();
  setLines(ORIG_LINES);
  if (server) await new Promise((r) => server.close(r));
  await pool.end().catch(() => {});
});

test('reply: from the 888 by default, with the status callback, metadata.line and the sender', async () => {
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_plain', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.plain}/reply`, { body: 'Thanks, see you Saturday' }, A.a.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(calls, [{
    from: FAKE_888, to: '+13125551301', body: 'Thanks, see you Saturday',
    statusCallback: `${API_URL}/api/sms/status`,
  }]);
  const row = await rowById(r.body.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.sender_id, A.a.id);
  assert.deepEqual(row.metadata, { line: '888' });
});

test('reply: keeps the client on the line they last texted, when that line is enabled', async () => {
  setLines('888,1922');
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_history', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.history}/reply`, { body: 'Yes, Saturday still works' }, A.a.token);
  } finally {
    restoreTwilio();
    setLines(ORIG_LINES);
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(calls[0].from, '+12242221922');
  assert.deepEqual((await rowById(r.body.id)).metadata, { line: '1922' });
});

test('reply: a default line that is not enabled falls back to the 888', async () => {
  setLines(undefined);
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_fallback', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.history}/reply`, { body: 'Following up' }, A.a.token);
  } finally {
    restoreTwilio();
    setLines(ORIG_LINES);
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(calls[0].from, FAKE_888);
});

test('reply: a Thumbtack proxy number is answered from the 888 only, whatever the history', async () => {
  setLines('888,1922');
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_proxy', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.proxy}/reply`, { body: 'Got your message' }, A.a.token);
  } finally {
    restoreTwilio();
    setLines(ORIG_LINES);
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(calls[0].from, FAKE_888);
  assert.deepEqual((await rowById(r.body.id)).metadata, { line: '888' });
});

test('reply: a Thumbtack relay text counts as their 888 text for the default line', async () => {
  setLines('888,1922');
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_relay', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.relay}/reply`, { body: 'Thanks for the update' }, A.a.token);
  } finally {
    restoreTwilio();
    setLines(ORIG_LINES);
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(calls[0].from, FAKE_888, 'the newest human-involved text is the relay, which reached the 888');
  assert.deepEqual((await rowById(r.body.id)).metadata, { line: '888' });
});

test('reply: a Twilio failure saves the row with the Twilio code and answers 400', async () => {
  withTwilio(() => {
    throw Object.assign(new Error('Unknown error while sending to +13125551311'), { code: 30008, status: 400 });
  });
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.fail}/reply`, { body: 'Hello?' }, A.a.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 400);
  assert.equal(r.body.fieldErrors.body, 'The SMS could not be sent. It is saved in the thread as failed.');
  assert.equal(r.body.error, 'The SMS could not be sent. It is saved in the thread as failed.',
    'the Messages pane toasts the real sentence, not the default');
  const rows = await pool.query(
    "SELECT status, error_message FROM sms_messages WHERE client_id = $1 AND direction = 'outbound'", [C.fail]
  );
  assert.deepEqual(rows.rows, [{ status: 'failed', error_message: 'Twilio 30008 (failed)' }],
    'the stored text is the Twilio code, never the provider prose');
});

test('reply: a failure callback that beat the row is folded into it, and the orphan stays', async () => {
  // Twilio reported the failure before the reply's INSERT existed, so
  // POST /status kept it in sms_status_orphans under the sid the send returns.
  await pool.query(
    `INSERT INTO sms_status_orphans (twilio_sid, status, error_message)
     VALUES ($1, 'failed', 'Twilio 30007 (undelivered)')`,
    [EARLY_SID]
  );
  withTwilio((p) => ({ sid: EARLY_SID, from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.early}/reply`, { body: 'Are you still there?' }, A.a.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = await pool.query(
    "SELECT status, error_message FROM sms_messages WHERE client_id = $1 AND direction = 'outbound'", [C.early]
  );
  assert.deepEqual(rows.rows, [{ status: 'failed', error_message: 'Twilio 30007 (undelivered)' }]);
  assert.equal(r.body.status, 'failed', 'the response carries the folded row');
  assert.deepEqual(Object.keys(r.body).sort(),
    ['body', 'created_at', 'direction', 'id', 'read_at', 'status', 'twilio_sid'],
    'the response keeps its shape');
  const orphan = await pool.query('SELECT status FROM sms_status_orphans WHERE twilio_sid = $1', [EARLY_SID]);
  assert.equal(orphan.rows.length, 1, 'the orphan stays for the Inbox reader');
});

test('reply: an opted-out client gets 409 INBOX_OPTED_OUT with the Chicago date, and nothing is sent', async () => {
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_never1', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.prefsOff}/reply`, { body: 'Hello?' }, A.b.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'INBOX_OPTED_OUT');
  assert.equal(r.body.error,
    'Texts are off for this person since Sep 1, 2026. Texts from 888, 1922 or 0082 will not deliver.');
  assert.equal(calls.length, 0);
  const n = await pool.query(
    "SELECT COUNT(*)::int AS n FROM sms_messages WHERE client_id = $1 AND direction = 'outbound'", [C.prefsOff]
  );
  assert.equal(n.rows[0].n, 0, 'a refusal writes no row');
});

test('reply: an active sms_optouts row refuses the reply, whatever lines are enabled', async () => {
  setLines('888,1922,0082');
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_never2', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.optout}/reply`, { body: 'Hello?' }, A.b.token);
  } finally {
    restoreTwilio();
    setLines(ORIG_LINES);
  }
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'INBOX_OPTED_OUT');
  assert.match(r.body.error, /since Sep 3, 2026\./);
  assert.equal(calls.length, 0);
});

test('reply: a cleared sms_optouts row does not block', async () => {
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_cleared', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.cleared}/reply`, { body: 'Welcome back' }, A.b.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(calls.length, 1);
});

test('reply: a number marked bad is refused before sending', async () => {
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_never3', from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.bad}/reply`, { body: 'Hello?' }, A.b.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "This number can't receive texts.");
  assert.equal(calls.length, 0);
});

test('reply: Twilio 21610 writes sms_optouts and answers 409, keeping the failed row in the thread', async () => {
  withTwilio(() => {
    throw Object.assign(new Error('Attempt to send to unsubscribed recipient'), { code: 21610, status: 400 });
  });
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.t21610}/reply`, { body: 'Hello?' }, A.b.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'INBOX_OPTED_OUT');
  const optout = await pool.query(
    "SELECT source, line FROM sms_optouts WHERE phone_last10 = '3125551308' AND cleared_at IS NULL"
  );
  assert.deepEqual(optout.rows, [{ source: 'twilio_21610', line: '888' }]);
  const rows = await pool.query(
    "SELECT status, error_message, metadata, sender_id FROM sms_messages WHERE client_id = $1 AND direction = 'outbound'", [C.t21610]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].status, 'failed');
  assert.equal(rows.rows[0].error_message, 'Twilio 21610 (failed)');
  assert.deepEqual(rows.rows[0].metadata, { line: '888' });
  assert.equal(rows.rows[0].sender_id, A.b.id);
});

test('reply: the message_log row records who sent it', async () => {
  const sid = `SMreply_test_sentby_${NONCE}`;
  withTwilio((p) => ({ sid, from: p.from }));
  let r;
  try {
    r = await postJson(`/api/sms/conversations/${C.sentBy}/reply`, { body: 'Your shopping list is ready' }, A.b.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // logClientMessage is fire-and-forget: poll briefly for the ledger row.
  let logged = null;
  for (let i = 0; i < 30 && !logged; i += 1) {
    const q = await pool.query('SELECT sent_by, client_id FROM message_log WHERE provider_id = $1', [sid]);
    logged = q.rows[0] || null;
    if (!logged) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(logged, 'the send was ledgered');
  assert.equal(logged.sent_by, A.b.id);
  assert.equal(logged.client_id, C.sentBy);
});

test('reply: adminWriteLimiter caps it at 10 a minute per user', async () => {
  for (let i = 0; i < 10; i += 1) {
    const r = await postJson(`/api/sms/conversations/${C.plain}/reply`, { body: '' }, A.limit.token);
    assert.equal(r.status, 400, `request ${i + 1} reaches the handler`);
  }
  const blocked = await postJson(`/api/sms/conversations/${C.plain}/reply`, { body: '' }, A.limit.token);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'Too many requests. Please slow down.');
});

// ─── Checkpoint 2 (spec 2026-10-06, Inbox): the cap, the refusal copy, and ──
// nothing after a sent text that could invite a second send.

/** Run fn with console.error captured; returns every line it printed. */
async function captureErrors(fn) {
  const lines = [];
  const realError = console.error;
  console.error = (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.error = realError;
  }
  return lines;
}

test('reply: a body over 1600 characters is refused with its sentence before anything is read or sent', async () => {
  const calls = withTwilio((p) => ({ sid: 'SMreply_test_never_long', from: p.from }));
  const missing = (await pool.query('SELECT COALESCE(MAX(id), 0) + 1000000 AS id FROM clients')).rows[0].id;
  let long;
  let unread;
  let empty;
  try {
    long = await postJson(`/api/sms/conversations/${C.plain}/reply`, { body: 'x'.repeat(1601) }, A.c.token);
    // No such client: a 400 and not a 404 shows the cap ran before the client read.
    unread = await postJson(`/api/sms/conversations/${missing}/reply`, { body: 'x'.repeat(1601) }, A.c.token);
    empty = await postJson(`/api/sms/conversations/${C.plain}/reply`, { body: '   ' }, A.c.token);
  } finally {
    restoreTwilio();
  }
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'Message must be 1600 characters or fewer');
  assert.equal(long.body.fieldErrors.body, 'Message must be 1600 characters or fewer');
  assert.equal(unread.status, 400, JSON.stringify(unread.body));
  assert.equal(unread.body.error, 'Message must be 1600 characters or fewer');
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'Message body is required.', 'the real sentence, not the default');
  assert.equal(calls.length, 0, 'Twilio is never called');
  const n = await pool.query(
    "SELECT COUNT(*)::int AS n FROM sms_messages WHERE client_id = $1 AND body LIKE 'xxxx%'", [C.plain]
  );
  assert.equal(n.rows[0].n, 0, 'nothing is written');
});

test('reply: a row that fails to save after Twilio took the text answers 500 SMS_REPLY_UNRECORDED, never "try again"', async () => {
  const body = 'Unrecorded reply text';
  // sms_messages.twilio_sid is VARCHAR(100): a longer sid makes the reply's
  // INSERT fail after Twilio has taken the text.
  const calls = withTwilio((p) => ({ sid: `SM${'x'.repeat(120)}`, from: p.from }));
  let r;
  let logged;
  try {
    logged = await captureErrors(async () => {
      r = await postJson(`/api/sms/conversations/${C.unrecorded}/reply`, { body }, A.c.token);
    });
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.code, 'SMS_REPLY_UNRECORDED');
  assert.equal(r.body.error, 'The text went out, but it could not be saved to the thread. Do not send it again.');
  assert.equal(calls.length, 1, 'Twilio took the text');
  const rows = await pool.query(
    "SELECT 1 FROM sms_messages WHERE client_id = $1 AND direction = 'outbound'", [C.unrecorded]
  );
  assert.equal(rows.rowCount, 0, 'no row was saved');
  const line = logged.find((l) => l.includes('[sms/reply]'));
  assert.ok(line, 'the lost record is logged');
  assert.ok(line.includes(`client ${C.unrecorded}`), 'with the client id');
  assert.ok(line.includes('22001'), 'and the SQLSTATE');
  assert.ok(!line.includes(body), 'never the text');
  assert.ok(!line.replace(/[\s().+-]/g, '').includes('3125551313'), 'never the number');
});

test('reply: an orphan fold that fails after the send still answers 201 with the inserted row', async () => {
  const body = 'Fold fails quietly';
  withTwilio((p) => ({ sid: `SMreply_test_foldfail_${NONCE}`, from: p.from }));
  // The fold is the one statement that reads sms_status_orphans; fail it once.
  const realQuery = pool.query;
  let armed = true;
  pool.query = function inducedFoldFailure(text, ...rest) {
    if (armed && typeof text === 'string' && text.includes('FROM sms_status_orphans o')) {
      armed = false;
      return Promise.reject(Object.assign(new Error('induced fold failure'), { code: '57014' }));
    }
    return realQuery.call(pool, text, ...rest);
  };
  let r;
  let logged;
  try {
    logged = await captureErrors(async () => {
      r = await postJson(`/api/sms/conversations/${C.foldFail}/reply`, { body }, A.c.token);
    });
  } finally {
    pool.query = realQuery;
    restoreTwilio();
  }
  assert.equal(armed, false, 'the fold ran');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'sent', 'the inserted row');
  assert.deepEqual(Object.keys(r.body).sort(),
    ['body', 'created_at', 'direction', 'id', 'read_at', 'status', 'twilio_sid'], 'the response keeps its shape');
  assert.equal((await rowById(r.body.id)).status, 'sent');
  const line = logged.find((l) => l.includes('[sms/reply]'));
  assert.ok(line, 'the failed fold is logged');
  assert.ok(line.includes(`client ${C.foldFail}`) && line.includes('57014'), 'with the client id and the SQLSTATE');
  assert.ok(!line.includes(body), 'never the text');
  assert.ok(!line.replace(/[\s().+-]/g, '').includes('3125551314'), 'never the number');
});
