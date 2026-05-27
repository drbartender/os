require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { pool } = require('../db');

// Refuse to run if DATABASE_URL points at a non-test database. The before/
// after/beforeEach hooks DELETE webhook_events rows for provider='calcom',
// which would wipe legitimate dedupe history if run against prod.
if (process.env.NODE_ENV !== 'test' && !process.env.ALLOW_TEST_DB_WRITES) {
  throw new Error(
    'calcom.test.js refuses to run without NODE_ENV=test or ALLOW_TEST_DB_WRITES=1. ' +
    'These tests DELETE rows from webhook_events.'
  );
}

let _server = null;
let _baseUrl = null;

async function buildApp(secretOverride) {
  if (secretOverride !== undefined) process.env.CAL_WEBHOOK_SECRET = secretOverride;
  // Reset module cache so the route picks up the new env on this build.
  delete require.cache[require.resolve('./calcom')];
  const router = require('./calcom');
  const app = express();
  app.use('/api/calcom/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/calcom', router);

  if (_server) await new Promise(r => _server.close(r));
  await new Promise(resolve => {
    _server = app.listen(0, () => {
      const port = _server.address().port;
      _baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function signedRequest(body, secret, headerOverride) {
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(body).digest('hex')
    : '';
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (headerOverride !== undefined) {
    if (headerOverride !== null) headers['x-cal-signature-256'] = headerOverride;
  } else if (sig) {
    headers['x-cal-signature-256'] = sig;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}/api/calcom/webhook`, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Variant that lets a test override the header name (case sensitivity check).
async function customHeaderRequest(body, secret, headerName) {
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(body).digest('hex')
    : '';
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    [headerName]: sig,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}/api/calcom/webhook`, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postEvent(triggerEvent, payload, { secret = TEST_SECRET } = {}) {
  const body = Buffer.from(JSON.stringify({ triggerEvent, payload }));
  return signedRequest(body, secret);
}

const ORIGINAL_SECRET = process.env.CAL_WEBHOOK_SECRET;
const TEST_SECRET = 'test-cal-secret';

before(async () => {
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
});

after(async () => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.CAL_WEBHOOK_SECRET;
  } else {
    process.env.CAL_WEBHOOK_SECRET = ORIGINAL_SECRET;
  }
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
  if (_server) await new Promise(r => _server.close(r));
  await pool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
});

test('webhook: returns 503 when CAL_WEBHOOK_SECRET unset', async () => {
  await buildApp(''); // empty string treated as unset
  const res = await signedRequest(Buffer.from('{}'), '');
  assert.equal(res.status, 503);
  assert.match(res.text, /not configured/i);
});

test('webhook: returns 400 when signature header missing', async () => {
  await buildApp(TEST_SECRET);
  const res = await signedRequest(Buffer.from('{}'), TEST_SECRET, null);
  assert.equal(res.status, 400);
  assert.match(res.text, /missing signature/i);
});

test('webhook: returns 400 when signature is wrong', async () => {
  await buildApp(TEST_SECRET);
  const res = await signedRequest(Buffer.from('{}'), TEST_SECRET, 'wrongsig');
  assert.equal(res.status, 400);
  assert.match(res.text, /invalid signature/i);
});

test('webhook: wrong-case header still verifies (Express normalizes)', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'wrong-case-1' } }));
  // Send header as mixed-case 'X-Cal-Signature-256' instead of lowercase.
  const res = await customHeaderRequest(body, TEST_SECRET, 'X-Cal-Signature-256');
  assert.equal(res.status, 200); // signature verifies, dispatches to default (ignored)
});

test('webhook: returns 400 on malformed JSON body', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from('not json at all');
  const res = await signedRequest(body, TEST_SECRET);
  assert.equal(res.status, 400);
  assert.match(res.text, /malformed body/i);
});

test('webhook: returns 200 ignored on unknown triggerEvent', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({
    triggerEvent: 'MEETING_STARTED',
    payload: {},
  }));
  const res = await signedRequest(body, TEST_SECRET);
  assert.equal(res.status, 200);
  assert.match(res.text, /ignored/i);
});

test('webhook: dedupe returns 200 Already processed on identical replay', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({
    triggerEvent: 'MEETING_STARTED',
    payload: { uid: 'replay-test-1' },
  }));
  const first = await signedRequest(body, TEST_SECRET);
  assert.equal(first.status, 200);
  const second = await signedRequest(body, TEST_SECRET);
  assert.equal(second.status, 200);
  assert.match(second.text, /already processed/i);

  const dedupeRows = await pool.query(
    "SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'calcom'"
  );
  assert.equal(Number(dedupeRows.rows[0].n), 1);
});

test('webhook: dedupe treats different bodies as different events', async () => {
  await buildApp(TEST_SECRET);
  const a = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'a' } }));
  const b = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'b' } }));
  await signedRequest(a, TEST_SECRET);
  await signedRequest(b, TEST_SECRET);
  const dedupeRows = await pool.query(
    "SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'calcom'"
  );
  assert.equal(Number(dedupeRows.rows[0].n), 2);
});

// ─── BOOKING_CREATED tests ────────────────────────────────────────

async function postCreated(payload) {
  // Uses the postEvent helper added in the Wave 2 fix-fold-in commit.
  return postEvent('BOOKING_CREATED', payload);
}

async function cleanupTestRows() {
  await pool.query("DELETE FROM consults WHERE calcom_event_id LIKE 'test-%' OR booker_email LIKE '%@calcom-test.example'");
  await pool.query("DELETE FROM clients WHERE email LIKE '%@calcom-test.example' OR name LIKE 'CalcomTest%'");
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
}

// Helper to insert a proposals row covering all NOT NULL columns.
// proposals NOT NULL set (per schema.sql):
//   event_duration_hours DEFAULT 4, guest_count DEFAULT 50,
//   pricing_snapshot DEFAULT '{}', status DEFAULT 'draft'.
// We omit those with defaults; we DO supply event_date, event_type,
// total_price, balance_due_date because tests assert on them.
async function insertTestProposal(clientId, status, eventDateOffset = 30, total = 100000) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, balance_due_date)
     VALUES ($1, $2, CURRENT_DATE + ($3 || ' days')::INTERVAL, 'birthday-party', $4, CURRENT_DATE + INTERVAL '14 days')
     RETURNING id`,
    [clientId, status, String(eventDateOffset), total]
  );
  return r.rows[0].id;
}

test('BOOKING_CREATED: returns 200 ignored when uid missing', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postCreated({ startTime: '2026-06-01T15:00:00Z', attendees: [{ name: 'CalcomTest A', email: 'a@calcom-test.example' }] });
  assert.equal(res.status, 200);
  assert.match(res.text, /malformed|ignored/i);
  const rows = await pool.query("SELECT id FROM consults WHERE booker_email = 'a@calcom-test.example'");
  assert.equal(rows.rowCount, 0);
});

test('BOOKING_CREATED: creates client + consult on unknown email', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postCreated({
    uid: 'test-uid-create-1',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Alice', email: 'alice@calcom-test.example', phoneNumber: '+15551110001' }],
  });
  assert.equal(res.status, 200);

  const clients = await pool.query("SELECT id, name, email, phone, source FROM clients WHERE email = 'alice@calcom-test.example'");
  assert.equal(clients.rowCount, 1);
  assert.equal(clients.rows[0].name, 'CalcomTest Alice');
  assert.equal(clients.rows[0].source, 'calcom');
  assert.equal(clients.rows[0].phone, '+15551110001');

  const consults = await pool.query("SELECT id, client_id, calcom_event_id, scheduled_at, status, booker_name, booker_email FROM consults WHERE calcom_event_id = 'test-uid-create-1'");
  assert.equal(consults.rowCount, 1);
  assert.equal(consults.rows[0].status, 'scheduled');
  assert.equal(consults.rows[0].client_id, clients.rows[0].id);
  assert.equal(consults.rows[0].booker_email, 'alice@calcom-test.example');
});

test('BOOKING_CREATED: links to existing client on known email', async () => {
  await cleanupTestRows();
  const existing = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('CalcomTest Bob', 'bob@calcom-test.example', 'direct') RETURNING id`
  );
  const existingId = existing.rows[0].id;

  await buildApp(TEST_SECRET);
  await postCreated({
    uid: 'test-uid-create-2',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Bob', email: 'bob@calcom-test.example' }],
  });

  const clients = await pool.query("SELECT id FROM clients WHERE email = 'bob@calcom-test.example'");
  assert.equal(clients.rowCount, 1, 'no duplicate client created');

  const consults = await pool.query("SELECT client_id FROM consults WHERE calcom_event_id = 'test-uid-create-2'");
  assert.equal(consults.rows[0].client_id, existingId);
});

test('BOOKING_CREATED: idempotent retry does not duplicate rows', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const payload = {
    uid: 'test-uid-create-3',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Carol', email: 'carol@calcom-test.example' }],
  };
  await postCreated(payload);
  // First call hits dedupe table, so direct replay returns dedupe. Test the
  // idempotent FAST-PATH instead: clear webhook_events and re-post.
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
  await postCreated(payload);
  const consults = await pool.query("SELECT id FROM consults WHERE calcom_event_id = 'test-uid-create-3'");
  assert.equal(consults.rowCount, 1);
  const clients = await pool.query("SELECT id FROM clients WHERE email = 'carol@calcom-test.example'");
  assert.equal(clients.rowCount, 1);
});

test('BOOKING_CREATED: NULL-email path soft-dedupes by name+phone', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const payload1 = {
    uid: 'test-uid-create-noemail-1',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Dave', email: '', phoneNumber: '+15551110002' }],
  };
  await postCreated(payload1);

  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
  const payload2 = {
    uid: 'test-uid-create-noemail-2',
    startTime: '2026-06-08T15:00:00Z',
    attendees: [{ name: 'CalcomTest Dave', email: '', phoneNumber: '+15551110002' }],
  };
  await postCreated(payload2);

  const clients = await pool.query(
    "SELECT id FROM clients WHERE name = 'CalcomTest Dave' AND phone = '+15551110002' AND email IS NULL"
  );
  assert.equal(clients.rowCount, 1, 'second NULL-email booking reuses the first auto-created client');

  const consults = await pool.query(
    "SELECT calcom_event_id FROM consults WHERE booker_name = 'CalcomTest Dave' ORDER BY calcom_event_id"
  );
  assert.equal(consults.rowCount, 2);
});

test('BOOKING_CREATED: links to most recent non-terminal proposal', async () => {
  await cleanupTestRows();
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('CalcomTest Eve', 'eve@calcom-test.example', 'direct') RETURNING id`
  );
  const clientId = c.rows[0].id;
  await insertTestProposal(clientId, 'sent', 60);                  // older active
  const newerId = await insertTestProposal(clientId, 'deposit_paid', 30, 200000); // most recent active
  await insertTestProposal(clientId, 'archived', 15, 50000);       // archived (excluded)

  await buildApp(TEST_SECRET);
  await postCreated({
    uid: 'test-uid-create-link',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Eve', email: 'eve@calcom-test.example' }],
  });

  const consults = await pool.query("SELECT proposal_id FROM consults WHERE calcom_event_id = 'test-uid-create-link'");
  assert.equal(consults.rows[0].proposal_id, newerId);
});

test('BOOKING_CREATED: NULL proposal_id when client has only archived/completed proposals', async () => {
  await cleanupTestRows();
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('CalcomTest Frank', 'frank@calcom-test.example', 'direct') RETURNING id`
  );
  await insertTestProposal(c.rows[0].id, 'completed', -30);

  await buildApp(TEST_SECRET);
  await postCreated({
    uid: 'test-uid-create-no-link',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Frank', email: 'frank@calcom-test.example' }],
  });
  const consults = await pool.query("SELECT proposal_id FROM consults WHERE calcom_event_id = 'test-uid-create-no-link'");
  assert.equal(consults.rows[0].proposal_id, null);
});

test('BOOKING_CREATED: concurrent race with same email → exactly one client, orphan cleaned up', async () => {
  // Spec §12 explicitly requires this test. Exercises the partial-UNIQUE
  // serialization in clients(email), the 23505 catch branch, and the
  // orphan-cleanup branch in the handler. Without this test, regressions
  // in those code paths would not be caught.
  await cleanupTestRows();
  await buildApp(TEST_SECRET);

  const email = 'race@calcom-test.example';
  const payloadA = {
    uid: 'test-uid-race-A',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Race', email }],
  };
  const payloadB = {
    uid: 'test-uid-race-B',
    startTime: '2026-06-08T15:00:00Z',
    attendees: [{ name: 'CalcomTest Race', email }],
  };

  // True parallel: kick both off without awaiting, then Promise.all.
  // Postgres' partial UNIQUE on clients(email) WHERE email IS NOT NULL
  // serializes the concurrent INSERTs; the loser catches 23505 and
  // re-SELECTs the winner's id. Both consults rows reference the same
  // (single) client; no orphan is left behind.
  await Promise.all([postCreated(payloadA), postCreated(payloadB)]);

  const clients = await pool.query("SELECT id FROM clients WHERE email = $1", [email]);
  assert.equal(clients.rowCount, 1, 'partial UNIQUE serializes auto-creates → exactly one client');

  const consults = await pool.query(
    "SELECT client_id FROM consults WHERE calcom_event_id LIKE 'test-uid-race-%' ORDER BY calcom_event_id"
  );
  assert.equal(consults.rowCount, 2, 'both bookings filed');
  assert.equal(consults.rows[0].client_id, clients.rows[0].id);
  assert.equal(consults.rows[1].client_id, clients.rows[0].id);
});

// ─── BOOKING_CANCELLED tests ──────────────────────────────────────

async function postCancelled(payload) {
  return postEvent('BOOKING_CANCELLED', payload);
}

test('BOOKING_CANCELLED: flips existing scheduled row to cancelled', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ('test-uid-cancel-1', '2026-06-01T15:00:00Z', 'scheduled', 'CalcomTest Gina', 'gina@calcom-test.example')`
  );
  await buildApp(TEST_SECRET);
  await postCancelled({
    uid: 'test-uid-cancel-1',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Gina', email: 'gina@calcom-test.example' }],
  });
  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'test-uid-cancel-1'");
  assert.equal(row.rows[0].status, 'cancelled');
});

test('BOOKING_CANCELLED: defensive insert when no prior row exists', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  await postCancelled({
    uid: 'test-uid-cancel-2',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Henry', email: 'henry@calcom-test.example' }],
  });
  const row = await pool.query(
    "SELECT status, booker_name, booker_email, client_id FROM consults WHERE calcom_event_id = 'test-uid-cancel-2'"
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].status, 'cancelled');
  assert.equal(row.rows[0].booker_name, 'CalcomTest Henry');
  assert.equal(row.rows[0].booker_email, 'henry@calcom-test.example');
  assert.equal(row.rows[0].client_id, null, 'defensive insert leaves client_id NULL');
});

test('BOOKING_CANCELLED: missing startTime falls back to NOW() (no NOT NULL violation)', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const before = Date.now();
  await postCancelled({
    uid: 'test-uid-cancel-3',
    attendees: [{ name: 'CalcomTest Iris', email: 'iris@calcom-test.example' }],
  });
  const row = await pool.query(
    "SELECT status, EXTRACT(EPOCH FROM scheduled_at) * 1000 AS ms FROM consults WHERE calcom_event_id = 'test-uid-cancel-3'"
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].status, 'cancelled');
  assert.ok(Number(row.rows[0].ms) >= before, 'scheduled_at falls back to a time at-or-after the request');
});

test('BOOKING_CANCELLED: missing uid is a 200 no-op', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postCancelled({ attendees: [{ name: 'CalcomTest Jack', email: 'jack@calcom-test.example' }] });
  assert.equal(res.status, 200);
  const rows = await pool.query("SELECT id FROM consults WHERE booker_email = 'jack@calcom-test.example'");
  assert.equal(rows.rowCount, 0);
});

test('BOOKING_CANCELLED: completed row is protected (late cancel does not flip)', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ('test-uid-cancel-completed', '2026-06-01T15:00:00Z', 'completed', 'CalcomTest Kate', 'kate@calcom-test.example')`
  );
  await buildApp(TEST_SECRET);
  const res = await postCancelled({
    uid: 'test-uid-cancel-completed',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Kate', email: 'kate@calcom-test.example' }],
  });
  assert.equal(res.status, 200);
  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'test-uid-cancel-completed'");
  assert.equal(row.rows[0].status, 'completed', 'completed consult must not be flipped to cancelled');
});

// ─── BOOKING_RESCHEDULED tests ────────────────────────────────────

async function postRescheduled(payload) {
  return postEvent('BOOKING_RESCHEDULED', payload);
}

test('BOOKING_RESCHEDULED: updates existing row in place using rescheduleUid', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ('test-uid-resched-old-1', '2026-06-01T15:00:00Z', 'scheduled', 'CalcomTest Kate', 'kate@calcom-test.example')`
  );
  await buildApp(TEST_SECRET);
  const res = await postRescheduled({
    uid: 'test-uid-resched-new-1',
    startTime: '2026-06-08T15:00:00Z',
    rescheduleUid: 'test-uid-resched-old-1',
    attendees: [{ name: 'CalcomTest Kate', email: 'kate@calcom-test.example' }],
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /rescheduled in place/i);

  const rows = await pool.query(
    "SELECT calcom_event_id, status, scheduled_at FROM consults WHERE calcom_event_id IN ('test-uid-resched-old-1', 'test-uid-resched-new-1')"
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].calcom_event_id, 'test-uid-resched-new-1');
  assert.equal(rows.rows[0].status, 'scheduled');
});

test('BOOKING_RESCHEDULED: probes alternative old-uid field names', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status)
     VALUES ('test-uid-resched-old-meta', '2026-06-01T15:00:00Z', 'scheduled')`
  );
  await buildApp(TEST_SECRET);
  await postRescheduled({
    uid: 'test-uid-resched-new-meta',
    startTime: '2026-06-08T15:00:00Z',
    metadata: { rescheduleUid: 'test-uid-resched-old-meta' },
  });
  const row = await pool.query("SELECT id FROM consults WHERE calcom_event_id = 'test-uid-resched-new-meta'");
  assert.equal(row.rowCount, 1);
});

test('BOOKING_RESCHEDULED: falls through to handleCreated when old uid unresolvable', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  await postRescheduled({
    uid: 'test-uid-resched-fresh',
    startTime: '2026-06-08T15:00:00Z',
    attendees: [{ name: 'CalcomTest Liam', email: 'liam@calcom-test.example' }],
  });
  const consult = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'test-uid-resched-fresh'");
  assert.equal(consult.rowCount, 1);
  assert.equal(consult.rows[0].status, 'scheduled');
  const client = await pool.query("SELECT id FROM clients WHERE email = 'liam@calcom-test.example'");
  assert.equal(client.rowCount, 1, 'fall-through created a client');
});

test('BOOKING_RESCHEDULED: missing newUid or newStartTime is 200 ignored', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postRescheduled({ rescheduleUid: 'whatever' });
  assert.equal(res.status, 200);
  assert.match(res.text, /malformed|ignored/i);
});

test('BOOKING_RESCHEDULED: oldUid present but no row matches → falls through to handleCreated', async () => {
  // The Sentry warning's documented promise: when we get a reschedule for
  // an oldUid we never recorded (e.g., we had downtime when the original
  // CREATE fired), the handler falls through to handleCreated and files
  // the new uid as a fresh booking. This locks that behavior against
  // regression.
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  await postRescheduled({
    uid: 'test-uid-resched-orphan-new',
    startTime: '2026-06-08T15:00:00Z',
    rescheduleUid: 'test-uid-resched-orphan-old-never-existed',
    attendees: [{ name: 'CalcomTest Mona', email: 'mona@calcom-test.example' }],
  });

  // Old uid should not exist in our DB (we never seeded it).
  const old = await pool.query(
    "SELECT id FROM consults WHERE calcom_event_id = 'test-uid-resched-orphan-old-never-existed'"
  );
  assert.equal(old.rowCount, 0, 'old uid was never in our DB to begin with');

  // New uid was filed as fresh via handleCreated's auto-create flow.
  const consult = await pool.query(
    "SELECT status FROM consults WHERE calcom_event_id = 'test-uid-resched-orphan-new'"
  );
  assert.equal(consult.rowCount, 1);
  assert.equal(consult.rows[0].status, 'scheduled');

  // handleCreated's auto-create also fired (since 'mona' was not a known client).
  const client = await pool.query(
    "SELECT id FROM clients WHERE email = 'mona@calcom-test.example'"
  );
  assert.equal(client.rowCount, 1, 'handleCreated auto-created the client');
});

// ─── BOOKING_NO_SHOW_UPDATED tests ────────────────────────────────

async function postNoShow(payload) {
  return postEvent('BOOKING_NO_SHOW_UPDATED', payload);
}

test('BOOKING_NO_SHOW_UPDATED: flips existing row to no_show', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status)
     VALUES ('test-uid-noshow-1', '2026-06-01T15:00:00Z', 'scheduled')`
  );
  await buildApp(TEST_SECRET);
  const res = await postNoShow({ uid: 'test-uid-noshow-1' });
  assert.equal(res.status, 200);
  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'test-uid-noshow-1'");
  assert.equal(row.rows[0].status, 'no_show');
});

test('BOOKING_NO_SHOW_UPDATED: zero-row update is a 200 (with Sentry breadcrumb in real Sentry env)', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postNoShow({ uid: 'test-uid-noshow-unknown' });
  assert.equal(res.status, 200);
});

test('BOOKING_NO_SHOW_UPDATED: missing uid is 200 ignored', async () => {
  await buildApp(TEST_SECRET);
  const res = await postNoShow({});
  assert.equal(res.status, 200);
});

test('BOOKING_NO_SHOW_UPDATED: completed row is protected (late no-show does not flip)', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status)
     VALUES ('test-uid-noshow-completed', '2026-06-01T15:00:00Z', 'completed')`
  );
  await buildApp(TEST_SECRET);
  const res = await postNoShow({ uid: 'test-uid-noshow-completed' });
  assert.equal(res.status, 200);
  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'test-uid-noshow-completed'");
  assert.equal(row.rows[0].status, 'completed', 'completed consult must not be flipped to no_show');
});
