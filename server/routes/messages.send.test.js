require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// POST /api/messages/send, pinned BEFORE its send logic moves into
// server/utils/staffText.js (spec 2026-10-06, Inbox, section 9: "The existing
// route's behavior does not change"). This suite characterizes the route as it
// is, so it passes on the code before the move and must keep passing after it.
// Fixture staff sit on 312-555-090x; every row is removed in before() and after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('messages.send.test.js refuses to run against production');
}

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { __setSmsDeps } = require('../utils/sms');
const { notificationsEnabled } = require('../utils/notificationsEnabled');
const messagesRouter = require('./messages');

const NONCE = `${Date.now()}`;
const FAKE_888 = '+18885550100';
const ORIG_888 = process.env.TWILIO_PHONE_NUMBER;
const STAFF_E164 = ['+13125550901', '+13125550902', '+13125550904', '+13125550905', '+13125550906'];
const SHIFT_MARKER = 'Msg Send Test Shift';

let server;
let baseUrl;
let adminId;
let adminToken;
let managerToken;
let shiftId;
const S = {};

async function clean() {
  const ids = (await pool.query("SELECT id FROM users WHERE email LIKE 'msg-send-%@example.com'")).rows.map((r) => r.id);
  if (ids.length) {
    await pool.query('DELETE FROM sms_messages WHERE recipient_id = ANY($1::int[]) OR sender_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM agreements WHERE user_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query('DELETE FROM message_log WHERE recipient = ANY($1::text[])', [STAFF_E164]);
  await pool.query('DELETE FROM shifts WHERE client_name = $1', [SHIFT_MARKER]);
}

async function mkUser(label, role, onboarding) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, $3, 0) RETURNING id`,
    [`msg-send-${label}-${NONCE}@example.com`, role, onboarding]
  );
  return r.rows[0].id;
}

async function mkStaffer(label, { onboarding = 'approved', phone, displayName = null, preferredName = null, consent }) {
  const id = await mkUser(label, 'staff', onboarding);
  await pool.query(
    'INSERT INTO contractor_profiles (user_id, phone, display_name, preferred_name) VALUES ($1, $2, $3, $4)',
    [id, phone, displayName, preferredName]
  );
  if (consent !== undefined) {
    await pool.query('INSERT INTO agreements (user_id, sms_consent) VALUES ($1, $2)', [id, consent]);
  }
  return id;
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

async function groupRows(groupId) {
  const r = await pool.query(
    `SELECT direction, sender_id, recipient_id, recipient_phone, recipient_name, body, message_type,
            shift_id, twilio_sid, status, error_message, metadata
       FROM sms_messages WHERE group_id = $1 ORDER BY recipient_id`,
    [groupId]
  );
  return r.rows;
}

before(async () => {
  await clean();
  const app = express();
  app.use(express.json());
  app.use('/api/messages', messagesRouter);
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

  adminId = await mkUser('admin', 'admin', 'approved');
  const managerId = await mkUser('manager', 'manager', 'approved');
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  managerToken = jwt.sign({ userId: managerId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  S.ok = await mkStaffer('ok', { phone: '(312) 555-0901', displayName: 'Testa B.', preferredName: 'Testa', consent: true });
  S.nocon = await mkStaffer('nocon', { onboarding: 'reviewed', phone: '3125550902', preferredName: 'Nocon', consent: false });
  S.badphone = await mkStaffer('badphone', { onboarding: 'submitted', phone: '12345', preferredName: 'Shortnum', consent: true });
  S.applied = await mkStaffer('applied', { onboarding: 'applied', phone: '3125550904', consent: true });
  S.noagree = await mkStaffer('noagree', { phone: '3125550905' });
  S.second = await mkStaffer('second', { phone: '3125550906', preferredName: 'Segunda', consent: true });

  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, client_name)
     VALUES (CURRENT_DATE + INTERVAL '20 days', '18:00', 'open', $1) RETURNING id`,
    [SHIFT_MARKER]
  );
  shiftId = sh.rows[0].id;
});

after(async () => {
  await clean();
  if (server) await new Promise((r) => server.close(r));
  await pool.end().catch(() => {});
});

test('POST /send without a token is 401', async () => {
  const r = await postJson('/api/messages/send', { recipient_ids: [S.ok], body: 'x' });
  assert.equal(r.status, 401);
});

test('POST /send is admin only: a manager gets 403', async () => {
  const r = await postJson('/api/messages/send', { recipient_ids: [S.ok], body: 'x' }, managerToken);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PERMISSION_DENIED');
});

test('POST /send validates body, recipients, type and the invitation shift, all at once', async () => {
  let r = await postJson('/api/messages/send', { recipient_ids: [], body: '   ', message_type: 'invitation' }, adminToken);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'VALIDATION_ERROR');
  assert.deepEqual(r.body.fieldErrors, {
    body: 'Message body is required',
    recipient_ids: 'At least one recipient is required',
    shift_id: 'Shift is required for invitation messages',
  });
  r = await postJson('/api/messages/send', { recipient_ids: [S.ok], body: 'x'.repeat(1601), message_type: 'bogus' }, adminToken);
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.fieldErrors, {
    body: 'Message must be 1600 characters or fewer',
    message_type: 'Invalid message type',
  });
});

test('POST /send texts each eligible staffer from the 888 and records one row per eligible recipient', async () => {
  const calls = withTwilio(() => ({ sid: 'SMmsgsend_ok', from: FAKE_888 }));
  let r;
  try {
    r = await postJson('/api/messages/send', {
      recipient_ids: [S.ok, S.nocon, S.badphone, S.applied, S.noagree], body: '  Hello team  ',
    }, adminToken);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 200);
  assert.match(r.body.group_id, /^[0-9a-f-]{36}$/);
  assert.equal(r.body.total, 3, 'an applicant and a staffer with no agreement are not eligible');
  assert.equal(r.body.sent, 1);
  assert.equal(r.body.failed, 2);
  const byIdOrder = (a, b) => a.recipient_id - b.recipient_id;
  assert.deepEqual([...r.body.results].sort(byIdOrder), [
    { recipient_id: S.ok, status: 'sent' },
    { recipient_id: S.nocon, status: 'failed', error_message: 'No SMS consent' },
    { recipient_id: S.badphone, status: 'failed', error_message: 'Invalid phone number' },
  ].sort(byIdOrder));

  assert.equal(calls.length, 1, 'only the consenting staffer with a usable phone is texted');
  assert.deepEqual(calls[0], { from: FAKE_888, to: '+13125550901', body: 'Hello team' },
    'exactly from, to and body: no line, no status callback');

  const rows = new Map((await groupRows(r.body.group_id)).map((row) => [row.recipient_id, row]));
  assert.equal(rows.size, 3);
  const base = {
    direction: 'outbound', sender_id: adminId, body: 'Hello team', message_type: 'general',
    shift_id: null, metadata: {},
  };
  assert.deepEqual(rows.get(S.ok), {
    ...base, recipient_id: S.ok, recipient_phone: '+13125550901', recipient_name: 'Testa B.',
    twilio_sid: 'SMmsgsend_ok', status: 'sent', error_message: null,
  });
  assert.deepEqual(rows.get(S.nocon), {
    ...base, recipient_id: S.nocon, recipient_phone: '3125550902', recipient_name: 'Nocon',
    twilio_sid: null, status: 'failed', error_message: 'No SMS consent',
  });
  assert.deepEqual(rows.get(S.badphone), {
    ...base, recipient_id: S.badphone, recipient_phone: '12345', recipient_name: 'Shortnum',
    twilio_sid: null, status: 'failed', error_message: 'Invalid phone number',
  });
});

test('POST /send records a Twilio failure on that recipient and still texts the rest', async () => {
  const calls = withTwilio((params) => {
    if (params.to === '+13125550901') throw new Error('carrier said no');
    return { sid: 'SMmsgsend_second', from: FAKE_888 };
  });
  let r;
  try {
    r = await postJson('/api/messages/send', { recipient_ids: [S.ok, S.second], body: 'Second try' }, adminToken);
  } finally {
    restoreTwilio();
  }
  assert.equal(r.status, 200);
  assert.deepEqual({ total: r.body.total, sent: r.body.sent, failed: r.body.failed }, { total: 2, sent: 1, failed: 1 });
  assert.equal(calls.length, 2);
  const results = new Map(r.body.results.map((x) => [x.recipient_id, x]));
  assert.deepEqual(results.get(S.ok), { recipient_id: S.ok, status: 'failed', error_message: 'carrier said no' });
  assert.deepEqual(results.get(S.second), { recipient_id: S.second, status: 'sent' });
  const rows = new Map((await groupRows(r.body.group_id)).map((row) => [row.recipient_id, row]));
  assert.equal(rows.get(S.ok).status, 'failed');
  assert.equal(rows.get(S.ok).recipient_phone, '+13125550901', 'a send failure keeps the normalized number');
  assert.equal(rows.get(S.ok).twilio_sid, null);
  assert.equal(rows.get(S.ok).error_message, 'carrier said no');
  assert.equal(rows.get(S.second).twilio_sid, 'SMmsgsend_second');
});

test('POST /send with Twilio gated off still records a sent row with the dev sid', async () => {
  const r = await postJson('/api/messages/send', { recipient_ids: [S.second], body: 'Gated' }, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 1);
  const [row] = await groupRows(r.body.group_id);
  assert.equal(row.status, 'sent');
  assert.match(row.twilio_sid, /^dev-skipped-/);
});

test('POST /send carries the invitation type and its shift onto every row', async () => {
  const r = await postJson('/api/messages/send', {
    recipient_ids: [S.second, S.nocon], body: 'Shift open Saturday', message_type: 'invitation', shift_id: shiftId,
  }, adminToken);
  assert.equal(r.status, 200);
  const rows = await groupRows(r.body.group_id);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.message_type, 'invitation');
    assert.equal(row.shift_id, shiftId);
  }
});

test('POST /send with nobody eligible answers 200 with sent 0 and writes nothing', async () => {
  const r = await postJson('/api/messages/send', { recipient_ids: [S.applied, S.noagree], body: 'Anyone?' }, adminToken);
  assert.equal(r.status, 200);
  assert.deepEqual(
    { total: r.body.total, sent: r.body.sent, failed: r.body.failed, results: r.body.results },
    { total: 0, sent: 0, failed: 0, results: [] }
  );
  assert.equal((await groupRows(r.body.group_id)).length, 0);
});

// ─── Amendment 29 (spec 2026-10-06): a group send never stops partway ──────
// Appended with the core, after the characterization above was committed
// against the old route (which lost every row when its one batch INSERT failed).
test('POST /send > a record that fails to save is logged without text or number, and the group carries on', async () => {
  const third = await mkStaffer('a29-third', { phone: '(312) 555-0907', preferredName: 'Tercera', consent: true });
  let n = 0;
  const calls = withTwilio(() => {
    n += 1;
    // The FIRST send's sid overflows sms_messages.twilio_sid (VARCHAR(100)), so its
    // row fails after Twilio took the text; the loop must still reach the rest.
    return { sid: n === 1 ? `SM${'x'.repeat(120)}` : `SMa29${NONCE}${n}`, from: FAKE_888 };
  });
  const logged = [];
  const realError = console.error;
  console.error = (...args) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const body = 'Group carries on';
  let res;
  try {
    res = await postJson('/api/messages/send', { recipient_ids: [S.ok, S.second, third], body }, adminToken);
  } finally {
    console.error = realError;
    restoreTwilio();
    await pool.query("DELETE FROM message_log WHERE recipient = '+13125550907'");
  }
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(calls.length, 3, 'every staffer was texted');
  assert.deepEqual([res.body.total, res.body.sent, res.body.failed], [3, 3, 0], 'the unrecorded text still went out');
  const rows = await groupRows(res.body.group_id);
  assert.equal(rows.length, 2, 'only the unrecorded text has no row');
  assert.ok(!rows.some((r) => r.recipient_phone === calls[0].to), 'the first send is the one with no row');
  assert.ok(rows.every((r) => r.status === 'sent'));
  const line = logged.find((l) => l.includes('did not save'));
  assert.ok(line, 'the lost record is logged');
  assert.ok(!line.includes(body), 'no message text in the log');
  const flat = line.replace(/[\s().+-]/g, '');
  for (const c of calls) {
    assert.ok(!flat.includes(c.to.replace(/\D/g, '').slice(-10)), 'no phone number in the log');
  }
});

// ─── Checkpoint 2 (spec 2026-10-06): the shift_id is checked before any send ─
// Every row carries shift_id, so a malformed or deleted one used to fail each
// row's INSERT after its text went out, losing the group's records behind a 200.
test('POST /send > an invitation naming a shift that does not exist is a 400, and nothing is sent or written', async () => {
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, client_name)
     VALUES (CURRENT_DATE + INTERVAL '21 days', '18:00', 'open', $1) RETURNING id`,
    [SHIFT_MARKER]
  );
  const goneId = sh.rows[0].id;
  await pool.query('DELETE FROM shifts WHERE id = $1', [goneId]);
  const body = 'Shift open Sunday, then deleted';
  const calls = withTwilio(() => ({ sid: 'SMmsgsend_never', from: FAKE_888 }));
  let gone;
  let malformed;
  try {
    gone = await postJson('/api/messages/send', {
      recipient_ids: [S.ok, S.second], body, message_type: 'invitation', shift_id: goneId,
    }, adminToken);
    malformed = await postJson('/api/messages/send', {
      recipient_ids: [S.ok], body, message_type: 'general', shift_id: 'not-a-shift',
    }, adminToken);
  } finally {
    restoreTwilio();
  }
  assert.equal(gone.status, 400, JSON.stringify(gone.body));
  assert.equal(gone.body.code, 'VALIDATION_ERROR');
  assert.equal(gone.body.fieldErrors.shift_id, 'That shift no longer exists');
  assert.equal(gone.body.error, 'That shift no longer exists', 'a real sentence, not the default');
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
  assert.equal(malformed.body.fieldErrors.shift_id, 'That is not a valid shift');
  assert.equal(malformed.body.error, 'That is not a valid shift');
  assert.equal(calls.length, 0, 'Twilio is never called');
  const rows = await pool.query(
    'SELECT 1 FROM sms_messages WHERE body = $1 AND recipient_id = ANY($2::int[])', [body, [S.ok, S.second]]
  );
  assert.equal(rows.rowCount, 0, 'no row is written');
});
