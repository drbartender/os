require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// The hooks lane inbox-engine adds to server/routes/sms.js (spec 2026-10-06,
// section 8 and amendment 7): a status callback that writes, and every
// Messages reply, clear the Inbox cache; and a Messages reply that is the
// first text from a 224 line to a number starts "Dr. Bartender: ". Not
// production, so the unsigned callback is warned about and allowed (the
// route's own suite, sms.status.test.js, covers signatures). Seeded rows are
// removed in before() and after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') throw new Error('sms.inboxHooks.test.js refuses to run against production');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { lineE164 } = require('../utils/smsLines');
const cache = require('../utils/inbox/cache');
const smsRouter = require('./sms');

const ORIG_LINES = process.env.INBOX_TEXT_LINES;
// Fixed identifiers, not per run, so before() also clears whatever a crashed
// earlier run left behind. Invented numbers in the 555-01xx range.
const TAG = 'inbox-hooks-test';
const phone = (i) => `+1847555${String(100 + i).padStart(4, '0')}`;
const P = { reply: phone(0), status: phone(1), optout: phone(2) };
const SID = 'SMinboxhookstest';
let server;
let baseUrl;
let adminId;
let token;
let clientId;

// Everything this suite seeds, found by its tag, its client name, its SIDs and its phone block.
async function clean() {
  const users = (await pool.query('SELECT id FROM users WHERE email LIKE $1', [`${TAG}-%`])).rows.map((r) => r.id);
  const clients = (await pool.query('SELECT id FROM clients WHERE name LIKE $1', [`%${TAG}`])).rows.map((r) => r.id);
  await pool.query(
    'DELETE FROM sms_messages WHERE client_id = ANY($1::int[]) OR twilio_sid LIKE $2 OR sender_id = ANY($3::int[])',
    [clients, `${SID}%`, users]
  );
  await pool.query('DELETE FROM sms_optouts WHERE phone_last10 = ANY($1::text[])', [Object.values(P).map((p) => p.slice(-10))]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clients]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]);
}

function request(method, path, { body, form, auth } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    let payload = null;
    const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
    if (form) {
      payload = Buffer.from(new URLSearchParams(form).toString());
      Object.assign(headers, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length });
    } else if (body) {
      payload = Buffer.from(JSON.stringify(body));
      Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* TwiML or empty */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  await clean();
  process.env.INBOX_TEXT_LINES = '888,1922';
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, token_version",
    [`${TAG}-admin@example.com`]
  );
  adminId = u.rows[0].id;
  token = jwt.sign({ userId: adminId, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const c = await pool.query('INSERT INTO clients (name, phone) VALUES ($1, $2) RETURNING id', [`Hook Example ${TAG}`, P.reply]);
  clientId = c.rows[0].id;
  // They last texted the 1922, so the Messages reply defaults to it (decision 9).
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, status, metadata, created_at)
     VALUES ('inbound', $1, $2, 'Is the quote ready?', 'received', $3::jsonb, NOW() - INTERVAL '1 hour')`,
    [clientId, P.reply, JSON.stringify({ from: P.reply, to: lineE164('1922') })]
  );
  for (const [suffix, to] of [['a', P.status], ['b', P.optout]]) {
    await pool.query(
      `INSERT INTO sms_messages (direction, recipient_phone, body, message_type, status, twilio_sid)
       VALUES ('outbound', $1, 'A hook test text', 'general', 'sent', $2)`,
      [to, `${SID}${suffix}`]
    );
  }
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/sms', smsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  if (ORIG_LINES === undefined) delete process.env.INBOX_TEXT_LINES;
  else process.env.INBOX_TEXT_LINES = ORIG_LINES;
  if (server) await new Promise((resolve) => server.close(resolve));
  await clean();
  await pool.end();
});

test('a delivered callback changes nothing; an undelivered one flips the row and clears the cache', async () => {
  const g0 = cache.generationNow();
  assert.equal((await request('POST', '/api/sms/status', { form: { MessageSid: `${SID}a`, MessageStatus: 'delivered' } })).status, 204);
  assert.equal(cache.generationNow(), g0);
  const res = await request('POST', '/api/sms/status', { form: { MessageSid: `${SID}a`, MessageStatus: 'undelivered', ErrorCode: '30005' } });
  assert.equal(res.status, 204);
  assert.ok(cache.generationNow() > g0);
  const row = await pool.query('SELECT status, error_message FROM sms_messages WHERE twilio_sid = $1', [`${SID}a`]);
  assert.deepEqual(row.rows[0], { status: 'failed', error_message: 'Twilio 30005 (undelivered)' });
});

test('a 21610 callback writes the opt-out and clears the cache', async () => {
  const g0 = cache.generationNow();
  const res = await request('POST', '/api/sms/status', {
    form: { MessageSid: `${SID}b`, MessageStatus: 'failed', ErrorCode: '21610', To: P.optout, From: lineE164('1922') },
  });
  assert.equal(res.status, 204);
  assert.ok(cache.generationNow() > g0);
  const opt = await pool.query('SELECT source, line FROM sms_optouts WHERE phone_last10 = $1 AND cleared_at IS NULL', [P.optout.slice(-10)]);
  assert.deepEqual(opt.rows, [{ source: 'twilio_21610', line: '1922' }]);
});

test('the Messages reply: the first from the 1922 starts "Dr. Bartender: ", the next does not, and each clears the cache', async () => {
  const g0 = cache.generationNow();
  const one = await request('POST', `/api/sms/conversations/${clientId}/reply`, { body: { body: 'Your quote is ready' }, auth: token });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.equal(one.body.body, 'Dr. Bartender: Your quote is ready');
  const g1 = cache.generationNow();
  assert.ok(g1 > g0);
  const two = await request('POST', `/api/sms/conversations/${clientId}/reply`, { body: { body: 'One more thing' }, auth: token });
  assert.equal(two.body.body, 'One more thing');
  assert.ok(cache.generationNow() > g1);
  const rows = await pool.query(
    "SELECT body, metadata->>'line' AS line FROM sms_messages WHERE client_id = $1 AND direction = 'outbound' ORDER BY id",
    [clientId]
  );
  assert.deepEqual(rows.rows, [{ body: 'Dr. Bartender: Your quote is ready', line: '1922' }, { body: 'One more thing', line: '1922' }]);
});
