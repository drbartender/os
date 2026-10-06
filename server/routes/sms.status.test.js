require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// POST /api/sms/status, the Twilio message status callback (spec 2026-10-06,
// Inbox, section 9). Signature-verified the same way /inbound is; flips a row
// to failed only on failed or undelivered; keeps a failure that beats its row
// in sms_status_orphans; writes sms_optouts on 21610; stores no other status;
// never touches clients.phone_status. Rows are keyed to SMstatus_test_ sids and
// 312-555-08xx numbers, removed in before() and after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const twilio = require('twilio');

if (process.env.NODE_ENV === 'production') {
  throw new Error('sms.status.test.js refuses to run against production');
}

const { pool } = require('../db');
const smsRouter = require('./sms');

const ORIG_NODE_ENV = process.env.NODE_ENV;
const ORIG_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const ORIG_888 = process.env.TWILIO_PHONE_NUMBER;
const PHONES = ['3125550801', '3125550802', '3125550803', '3125550804', '3125550805', '3125550806', '3125550807', '3125550808'];
const CLIENT_EMAIL = 'sms-status-client@example.com';

let server;
let baseUrl;
let clientId;

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// Form-encoded, like Twilio posts. With timeoutMs, a request the server never
// answers fails the test instead of hanging the suite.
function post(path, body, headers = {}, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = Buffer.from(new URLSearchParams(body).toString());
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length, ...headers },
      },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); }
    );
    if (timeoutMs) r.setTimeout(timeoutMs, () => r.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

async function clean() {
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid LIKE 'SMstatus_test_%'");
  await pool.query("DELETE FROM sms_status_orphans WHERE twilio_sid LIKE 'SMstatus_test_%'");
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [PHONES]);
  await pool.query('DELETE FROM clients WHERE email = $1', [CLIENT_EMAIL]);
}

async function seedSent(sid, phone, rowClientId = null) {
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, twilio_sid)
     VALUES ('outbound', $1, $2, 'A status test text', 'general', 'sent', $3)`,
    [rowClientId, phone, sid]
  );
}

async function rowBySid(sid) {
  const r = await pool.query('SELECT status, error_message FROM sms_messages WHERE twilio_sid = $1', [sid]);
  return r.rows[0];
}

async function orphanBySid(sid) {
  const r = await pool.query('SELECT status, error_message FROM sms_status_orphans WHERE twilio_sid = $1', [sid]);
  return r.rows;
}

before(async () => {
  await clean();
  const app = express();
  // extended: true, as production parses it (server/index.js), so a bracketed
  // field arrives as an object here too.
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/sms', smsRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Status Test Client', $1, '3125550805') RETURNING id",
    [CLIENT_EMAIL]
  );
  clientId = c.rows[0].id;
});

after(async () => {
  await clean();
  restoreEnv('NODE_ENV', ORIG_NODE_ENV);
  restoreEnv('TWILIO_AUTH_TOKEN', ORIG_AUTH_TOKEN);
  restoreEnv('TWILIO_PHONE_NUMBER', ORIG_888);
  if (server) await new Promise((r) => server.close(r));
  await pool.end().catch(() => {});
});

test('POST /status in production without a signature is 403 and changes nothing', async () => {
  await seedSent('SMstatus_test_unsigned', '+13125550801');
  process.env.NODE_ENV = 'production';
  try {
    const r = await post('/api/sms/status', { MessageSid: 'SMstatus_test_unsigned', MessageStatus: 'failed', ErrorCode: '30007' });
    assert.equal(r.status, 403, r.body);
  } finally {
    restoreEnv('NODE_ENV', ORIG_NODE_ENV);
  }
  assert.deepEqual(await rowBySid('SMstatus_test_unsigned'), { status: 'sent', error_message: null });
});

test('POST /status in production with a valid signature flips a failed text, with the code', async () => {
  await seedSent('SMstatus_test_signed', '+13125550802');
  const params = {
    MessageSid: 'SMstatus_test_signed', MessageStatus: 'failed', ErrorCode: '30007',
    To: '+13125550802', From: '+18885550100',
  };
  process.env.NODE_ENV = 'production';
  process.env.TWILIO_AUTH_TOKEN = 'status_test_auth_token';
  try {
    const signature = twilio.getExpectedTwilioSignature('status_test_auth_token', `${baseUrl}/api/sms/status`, params);
    const r = await post('/api/sms/status', params, { 'X-Twilio-Signature': signature });
    assert.equal(r.status, 204, r.body);
  } finally {
    restoreEnv('NODE_ENV', ORIG_NODE_ENV);
    restoreEnv('TWILIO_AUTH_TOKEN', ORIG_AUTH_TOKEN);
  }
  assert.deepEqual(await rowBySid('SMstatus_test_signed'), { status: 'failed', error_message: 'Twilio 30007 (failed)' });
});

test('POST /status flips undelivered too (dev allows an unsigned callback, as /inbound does)', async () => {
  await seedSent('SMstatus_test_undelivered', '+13125550803');
  const r = await post('/api/sms/status', {
    MessageSid: 'SMstatus_test_undelivered', MessageStatus: 'undelivered', ErrorCode: '30003',
  });
  assert.equal(r.status, 204, r.body);
  assert.deepEqual(await rowBySid('SMstatus_test_undelivered'),
    { status: 'failed', error_message: 'Twilio 30003 (undelivered)' });
  assert.deepEqual(await orphanBySid('SMstatus_test_undelivered'), [], 'a callback that found its row writes no orphan');
});

test('POST /status stores no other status: accepted and every non-failure status are ignored', async () => {
  await seedSent('SMstatus_test_other', '+13125550804');
  for (const status of ['accepted', 'queued', 'sending', 'sent', 'delivered', 'read', 'canceled', 'scheduled', 'partially_delivered']) {
    const r = await post('/api/sms/status', { MessageSid: 'SMstatus_test_other', MessageStatus: status });
    assert.equal(r.status, 204, `${status}: ${r.body}`);
    assert.deepEqual(await rowBySid('SMstatus_test_other'), { status: 'sent', error_message: null },
      `${status} must never be stored`);
  }
});

test('POST /status with error 21610 writes sms_optouts for that number and line', async () => {
  process.env.TWILIO_PHONE_NUMBER = '+18885550100';
  try {
    await seedSent('SMstatus_test_21610', '+13125550807');
    const r = await post('/api/sms/status', {
      MessageSid: 'SMstatus_test_21610', MessageStatus: 'failed', ErrorCode: '21610',
      To: '+13125550807', From: '+18885550100',
    });
    assert.equal(r.status, 204, r.body);
  } finally {
    restoreEnv('TWILIO_PHONE_NUMBER', ORIG_888);
  }
  assert.deepEqual(await rowBySid('SMstatus_test_21610'), { status: 'failed', error_message: 'Twilio 21610 (failed)' });
  const optout = await pool.query(
    "SELECT source, line, cleared_at FROM sms_optouts WHERE phone_last10 = '3125550807'"
  );
  assert.deepEqual(optout.rows, [{ source: 'twilio_21610', line: '888', cleared_at: null }]);
});

test('POST /status keeps a failure that beats its row in sms_status_orphans', async () => {
  // The sender writes its row after Twilio answers the create call, so a fast
  // failure can arrive first. It is kept for the Inbox reader, never dropped.
  let r = await post('/api/sms/status', { MessageSid: 'SMstatus_test_early', MessageStatus: 'failed', ErrorCode: '30005' });
  assert.equal(r.status, 204, r.body);
  r = await post('/api/sms/status', { MessageSid: 'SMstatus_test_early', MessageStatus: 'undelivered', ErrorCode: '30006' });
  assert.equal(r.status, 204, r.body);
  assert.deepEqual(await orphanBySid('SMstatus_test_early'), [{ status: 'failed', error_message: 'Twilio 30005 (failed)' }],
    'one orphan per sid, and the first failure wins');
  const { rows } = await pool.query("SELECT 1 FROM sms_messages WHERE twilio_sid = 'SMstatus_test_early'");
  assert.equal(rows.length, 0, 'the orphan never invents an sms_messages row');
  r = await post('/api/sms/status', { MessageSid: 'SMstatus_test_early_ok', MessageStatus: 'delivered' });
  assert.equal(r.status, 204, r.body);
  assert.deepEqual(await orphanBySid('SMstatus_test_early_ok'), [], 'only a failure is ever kept');
});

test('POST /status flips a row that lands between its first flip and its orphan, once the orphan is stored', async () => {
  // The reply writes its row after Twilio answers and folds any orphan right
  // after; this side flips first and stores the orphan second. Land the row
  // in that gap and the reply's fold has already missed the orphan, so the
  // callback's second flip is what must catch it.
  const sid = 'SMstatus_test_race';
  const realQuery = pool.query;
  let armed = true;
  pool.query = function rowLandsInTheGap(text, ...rest) {
    if (armed && typeof text === 'string' && text.includes('INSERT INTO sms_status_orphans')) {
      armed = false;
      return seedSent(sid, '+13125550806').then(() => realQuery.call(pool, text, ...rest));
    }
    return realQuery.call(pool, text, ...rest);
  };
  let r;
  try {
    r = await post('/api/sms/status', { MessageSid: sid, MessageStatus: 'failed', ErrorCode: '30007' }, {}, 3000);
  } finally {
    pool.query = realQuery;
  }
  assert.equal(armed, false, 'the row landed between the flip and the orphan');
  assert.equal(r.status, 204, r.body);
  assert.deepEqual(await rowBySid(sid), { status: 'failed', error_message: 'Twilio 30007 (failed)' });
  assert.deepEqual(await orphanBySid(sid), [{ status: 'failed', error_message: 'Twilio 30007 (failed)' }],
    'the orphan stays for the Inbox reader');
});

test('POST /status never touches clients.phone_status (that is on the fix list)', async () => {
  await seedSent('SMstatus_test_client', '+13125550805', clientId);
  const r = await post('/api/sms/status', {
    MessageSid: 'SMstatus_test_client', MessageStatus: 'undelivered', ErrorCode: '30006',
  });
  assert.equal(r.status, 204, r.body);
  assert.equal((await rowBySid('SMstatus_test_client')).status, 'failed');
  const c = await pool.query('SELECT phone_status FROM clients WHERE id = $1', [clientId]);
  assert.equal(c.rows[0].phone_status, 'ok');
});

test('POST /status only ever flips an outbound row', async () => {
  await pool.query(
    `INSERT INTO sms_messages (direction, recipient_phone, body, message_type, status, twilio_sid)
     VALUES ('inbound', '+13125550806', 'An inbound status test text', 'general', 'received', 'SMstatus_test_inbound')`
  );
  const r = await post('/api/sms/status', { MessageSid: 'SMstatus_test_inbound', MessageStatus: 'failed', ErrorCode: '30007' });
  assert.equal(r.status, 204, r.body);
  assert.deepEqual(await rowBySid('SMstatus_test_inbound'), { status: 'received', error_message: null });
  assert.deepEqual(await orphanBySid('SMstatus_test_inbound'), [], 'a sid that belongs to an inbound row is never an orphan');
});

test('POST /status never throws on a malformed field, and stores only a numeric error code', async () => {
  // extended parsing turns a bracketed field into an object whose toString is a
  // plain string, which String() cannot convert. The callback must still
  // answer 204 at once and write nothing: no flip, no orphan, no opt-out.
  await seedSent('SMstatus_test_nested', '+13125550808');
  let r = await post('/api/sms/status', {
    MessageSid: 'SMstatus_test_nested', 'MessageStatus[toString]': 'failed', 'ErrorCode[toString]': '21610',
    To: '+13125550808', From: '+18885550100',
  }, {}, 3000);
  assert.equal(r.status, 204, r.body);
  assert.deepEqual(await rowBySid('SMstatus_test_nested'), { status: 'sent', error_message: null });
  assert.deepEqual(await orphanBySid('SMstatus_test_nested'), []);
  const optout = await pool.query("SELECT 1 FROM sms_optouts WHERE phone_last10 = '3125550808'");
  assert.equal(optout.rows.length, 0, 'a code that is not a string is no code at all');

  // A non-numeric ErrorCode never reaches the row; a padded numeric one does, trimmed.
  await seedSent('SMstatus_test_badcode', '+13125550808');
  r = await post('/api/sms/status', { MessageSid: 'SMstatus_test_badcode', MessageStatus: 'failed', ErrorCode: '30007 <b>forged</b>' }, {}, 3000);
  assert.equal(r.status, 204, r.body);
  assert.deepEqual(await rowBySid('SMstatus_test_badcode'), { status: 'failed', error_message: 'Twilio error (failed)' });
  await seedSent('SMstatus_test_padded', '+13125550808');
  r = await post('/api/sms/status', { MessageSid: 'SMstatus_test_padded', MessageStatus: 'undelivered', ErrorCode: ' 30008 ' }, {}, 3000);
  assert.equal(r.status, 204, r.body);
  assert.deepEqual(await rowBySid('SMstatus_test_padded'), { status: 'failed', error_message: 'Twilio 30008 (undelivered)' });
});
