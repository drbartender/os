require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

if (process.env.NODE_ENV === 'production') {
  throw new Error('sms.test.js refuses to run against production');
}

// Stub the two side-effecting collaborators BEFORE requiring the router. sms.js
// does `const { processInboundSms } = require('../utils/smsInbound')` at module
// load, so the destructure captures whatever the property points at THEN — set
// the stub first and the router picks it up. presenceStore.stampByNudgePhone is
// called by property access, so it can be swapped either before or after. Both
// stubs keep the "allow-through" path hermetic (no DB writes, no real sends).
const smsInbound = require('../utils/smsInbound');
const presenceStore = require('../utils/presenceStore');
let processCalls = [];
smsInbound.processInboundSms = (arg) => {
  processCalls.push(arg);
  return { reply: null, outcome: 'stubbed' };
};
presenceStore.stampByNudgePhone = () => {};

const { pool } = require('../db');
const smsRouter = require('./sms');
const { AppError } = require('../utils/errors');
const jwt = require('jsonwebtoken');

const ORIG_NODE_ENV = process.env.NODE_ENV;
const ORIG_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function restoreAuthToken() {
  if (ORIG_AUTH_TOKEN === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = ORIG_AUTH_TOKEN;
}

let server, baseUrl;
let adminToken, orderAdminUserId, orderClientA, orderClientB, orderClientC, orderClientD, orderClientE;

// Minimal request helper. Form-urlencodes an object body (Twilio posts
// application/x-www-form-urlencoded), passes strings through untouched.
function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const h = { ...headers };
    let buf = null;
    if (body !== undefined && body !== null) {
      const payload = typeof body === 'string' ? body : new URLSearchParams(body).toString();
      buf = Buffer.from(payload);
      h['Content-Length'] = buf.length;
      if (!h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); }
    );
    r.on('error', reject);
    if (buf) r.write(buf);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/sms', smsRouter);
  // AppError-aware error handler mirroring server/index.js so the auth guard's
  // next(new AppError(..., 401, ...)) surfaces as a real 401 status.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Admin user + JWT for the authorized /conversations request (beo.test.js shape).
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ('sms-order-admin@example.test', 'x', 'admin', 'approved', 0)
     RETURNING id, token_version`
  );
  orderAdminUserId = admin.rows[0].id;
  adminToken = jwt.sign(
    { userId: orderAdminUserId, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Five clients with controlled message timelines. A, B and E are READ so the
  // read-block ordering they prove is not disturbed by the unread-first sort;
  // D is the unread discriminator and E is the thumbtack-relay discriminator.
  const ca = await pool.query("INSERT INTO clients (name, phone) VALUES ('SMS Order A', '3125550301') RETURNING id");
  const cb = await pool.query("INSERT INTO clients (name, phone) VALUES ('SMS Order B', '3125550302') RETURNING id");
  const cc = await pool.query("INSERT INTO clients (name, phone) VALUES ('SMS Order C', '3125550303') RETURNING id");
  const cd = await pool.query("INSERT INTO clients (name, phone) VALUES ('SMS Order D', '3125550304') RETURNING id");
  const ce = await pool.query("INSERT INTO clients (name, phone) VALUES ('SMS Order E', '3125550305') RETURNING id");
  orderClientA = ca.rows[0].id;
  orderClientB = cb.rows[0].id;
  orderClientC = cc.rows[0].id;
  orderClientD = cd.rows[0].id;
  orderClientE = ce.rows[0].id;

  // A: inbound 10m ago (read), then an outbound reply 1m ago (most recent ACTIVITY is outbound).
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, read_at, created_at) VALUES
       ('inbound',  $1, '3125550301', 'A first', 'general', 'received', NOW(), NOW() - INTERVAL '10 minutes'),
       ('outbound', $1, '3125550301', 'A reply', 'general', 'sent',     NULL,  NOW() - INTERVAL '1 minute')`,
    [orderClientA]
  );
  // B: inbound 5m ago (read), no later outbound (most recent inbound among the read block).
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, read_at, created_at) VALUES
       ('inbound', $1, '3125550302', 'B waiting', 'general', 'received', NOW(), NOW() - INTERVAL '5 minutes')`,
    [orderClientB]
  );
  // C: outbound only 2m ago (no inbound -> last_inbound_at NULL -> sinks).
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, created_at) VALUES
       ('outbound', $1, '3125550303', 'C outreach', 'general', 'sent', NOW() - INTERVAL '2 minutes')`,
    [orderClientC]
  );
  // D: one UNREAD inbound 30 days ago. The oldest thread in the seeded set by a
  // wide margin, so its position at the TOP can only come from the unread-first
  // sort key and never from recency.
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, read_at, created_at) VALUES
       ('inbound', $1, '3125550304', 'D was never answered', 'general', 'received', NULL, NOW() - INTERVAL '30 days')`,
    [orderClientD]
  );
  // E: a real READ inbound 20m ago plus an UNREAD thumbtack-relay echo 1m ago.
  // The relay row is machine traffic the inbox excludes, so E must neither float
  // to the unread block nor have its last_inbound_at bumped to 1m ago. This is
  // the shape that made the nav badge read 115 while the inbox showed nothing.
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, read_at, metadata, created_at) VALUES
       ('inbound', $1, '3125550305', 'E real question', 'general', 'received', NOW(), '{}'::jsonb, NOW() - INTERVAL '20 minutes'),
       ('inbound', $1, '3125550305', 'E replied to you on Thumbtack', 'general', 'received', NULL, '{"thumbtack_relay": true}'::jsonb, NOW() - INTERVAL '1 minute')`,
    [orderClientE]
  );
});

after(async () => {
  const seeded = [orderClientA, orderClientB, orderClientC, orderClientD, orderClientE];
  await pool.query('DELETE FROM sms_messages WHERE client_id = ANY($1)', [seeded]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [seeded]);
  await pool.query('DELETE FROM users WHERE id = $1', [orderAdminUserId]);
  process.env.NODE_ENV = ORIG_NODE_ENV;
  restoreAuthToken();
  if (server) await new Promise((r) => server.close(r));
  await pool.end().catch(() => {});
});

// ── Signature gate ───────────────────────────────────────────────────────────
// In production a missing/invalid Twilio signature is rejected (403) and the
// handler returns BEFORE presenceStore/processInboundSms, so these cases touch
// no DB. In dev the same unverified request is allowed through so the webhook
// stays locally testable.

test('POST /inbound in production with a MISSING X-Twilio-Signature returns 403 (no processing)', async () => {
  processCalls = [];
  process.env.NODE_ENV = 'production';
  try {
    const r = await request('POST', '/api/sms/inbound', {
      body: { From: '+13125550111', Body: 'hi', MessageSid: 'SM_test_missing' },
    });
    assert.equal(r.status, 403, r.body);
  } finally {
    process.env.NODE_ENV = ORIG_NODE_ENV;
  }
  assert.equal(processCalls.length, 0, 'processInboundSms is not called on a rejected signature');
});

test('POST /inbound in production with an INVALID signature returns 403 (no processing)', async () => {
  processCalls = [];
  process.env.NODE_ENV = 'production';
  // A known token so isValidTwilioRequest reaches twilio.validateRequest, which
  // returns false for the bogus signature below → prod rejects.
  process.env.TWILIO_AUTH_TOKEN = 'test_dummy_auth_token';
  try {
    const r = await request('POST', '/api/sms/inbound', {
      headers: { 'X-Twilio-Signature': 'obviously-not-a-valid-signature' },
      body: { From: '+13125550111', Body: 'hi', MessageSid: 'SM_test_invalid' },
    });
    assert.equal(r.status, 403, r.body);
  } finally {
    process.env.NODE_ENV = ORIG_NODE_ENV;
    restoreAuthToken();
  }
  assert.equal(processCalls.length, 0, 'processInboundSms is not called on a rejected signature');
});

test('POST /inbound in dev (non-production) with no valid signature is allowed through and processes', async () => {
  processCalls = [];
  process.env.NODE_ENV = 'test'; // any non-production value takes the dev allow-through branch
  const r = await request('POST', '/api/sms/inbound', {
    body: { From: '+13125550111', Body: 'CONFIRM', MessageSid: 'SM_test_dev' },
  });
  assert.equal(r.status, 200, r.body);
  // reply is null (stub) → empty TwiML Response envelope.
  assert.match(r.body, /<Response><\/Response>/);
  assert.equal(processCalls.length, 1, 'dev mode processes the inbound message');
  assert.equal(processCalls[0].twilioSid, 'SM_test_dev', 'MessageSid is forwarded to processInboundSms');
});

// ── /conversations auth guard ────────────────────────────────────────────────
// Every /conversations endpoint is behind `auth` + `requireAdminOrManager`.
// `auth` short-circuits with next(AppError 401) on a missing token BEFORE any
// DB query, so these guard cases are DB-free.

test('GET /conversations without a token is rejected (401) before any DB access', async () => {
  const r = await request('GET', '/api/sms/conversations');
  assert.equal(r.status, 401, r.body);
});

test('GET /conversations/:clientId without a token is rejected (401)', async () => {
  const r = await request('GET', '/api/sms/conversations/1');
  assert.equal(r.status, 401, r.body);
});

test('POST /conversations/:clientId/reply without a token is rejected (401)', async () => {
  const r = await request('POST', '/api/sms/conversations/1/reply', { body: { body: 'hello' } });
  assert.equal(r.status, 401, r.body);
});

// ── /conversations ordering (spec 2026-07-18, unread-first 2026-08-25) ──────
// The inbox sorts in two blocks: every thread with an unread inbound first, then
// everything else. Within each block, ordering is by the client's most recent
// INBOUND message, newest first, with outbound-only threads sinking to the very
// bottom (NULLS LAST). A fresh outbound reply must NOT bump a handled thread, and
// a thumbtack-relay echo must neither float a thread nor count as unread.
test('GET /conversations puts unread threads first, then newest received', async () => {
  const r = await request('GET', '/api/sms/conversations', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.status, 200, r.body);
  const rows = JSON.parse(r.body);

  // Global ORDER BY contract on live data (robust to other rows and to LIMIT 200):
  // all unread rows precede all read rows; inside each block last_inbound_at runs
  // descending with the nulls (outbound-only) at the end.
  let seenRead = false;
  let prev = null;
  let seenNull = false;
  for (const row of rows) {
    const unread = row.unread_count > 0;
    if (!unread) {
      if (!seenRead) { seenRead = true; prev = null; seenNull = false; }
    } else {
      assert.ok(!seenRead, `an unread thread must not follow a read one: ${r.body}`);
    }
    if (row.last_inbound_at === null) { seenNull = true; continue; }
    assert.ok(!seenNull, `a non-null last_inbound_at must not follow a null one (NULLS LAST): ${r.body}`);
    if (prev !== null) {
      assert.ok(new Date(row.last_inbound_at) <= new Date(prev),
        `last_inbound_at must be descending within its block: ${r.body}`);
    }
    prev = row.last_inbound_at;
  }

  const seeded = [orderClientA, orderClientB, orderClientC, orderClientD, orderClientE];
  const mine = rows.filter(x => seeded.includes(x.client_id)).map(x => x.client_id);
  assert.ok(mine.includes(orderClientA) && mine.includes(orderClientB) && mine.includes(orderClientD),
    `seeded A, B and D must appear: ${r.body}`);

  // D's inbound is 30 days old and every other seeded thread is fresher, so D
  // riding at the top of the seeded set is the unread-first key and nothing else.
  assert.equal(mine[0], orderClientD, `unread D must outrank every read thread: ${r.body}`);

  // Read-block discriminator (would FAIL under the old `ORDER BY last_message_at DESC`,
  // which returns [A, C, B]): B (inbound 5m ago) outranks A (inbound 10m ago) even
  // though A has a newer OUTBOUND reply (1m ago).
  assert.ok(mine.indexOf(orderClientB) < mine.indexOf(orderClientA),
    `B (recent inbound) must outrank A (older inbound + newer outbound): ${r.body}`);

  // E carries an unread thumbtack-relay echo from 1m ago. Excluded from both the
  // unread count and last_inbound_at, so E stays in the read block BELOW A on the
  // strength of its real 20m-old inbound alone.
  if (mine.includes(orderClientE)) {
    assert.ok(mine.indexOf(orderClientA) < mine.indexOf(orderClientE),
      `relay echo must not float E above A: ${r.body}`);
  }

  // C is outbound-only (last_inbound_at NULL): when present it must sink below A.
  if (mine.includes(orderClientC)) {
    assert.ok(mine.indexOf(orderClientA) < mine.indexOf(orderClientC), `outbound-only C must sink below A: ${r.body}`);
  }
});

// A relay echo is machine traffic: it must never raise a thread's unread badge.
test('GET /conversations does not count thumbtack-relay echoes as unread', async () => {
  const r = await request('GET', '/api/sms/conversations', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.status, 200, r.body);
  const rows = JSON.parse(r.body);

  const e = rows.find(x => x.client_id === orderClientE);
  assert.ok(e, `seeded E must appear: ${r.body}`);
  assert.equal(e.unread_count, 0, `E's only unread inbound is a relay echo: ${r.body}`);

  const d = rows.find(x => x.client_id === orderClientD);
  assert.ok(d, `seeded D must appear: ${r.body}`);
  assert.equal(d.unread_count, 1, `D's real unread inbound must count: ${r.body}`);
});
