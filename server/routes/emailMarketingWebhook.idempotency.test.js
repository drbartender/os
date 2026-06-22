require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.RESEND_WEBHOOK_SECRET = ''; // skip svix verification for the test (non-prod path)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const webhookRouter = require('./emailMarketingWebhook');

if (process.env.NODE_ENV === 'production') {
  throw new Error('emailMarketingWebhook.idempotency.test.js refuses to run against production');
}

// Audit 3c: the Resend webhook had no replay/idempotency gate — a redelivered event re-applied
// its side-effects. The handler now does ON CONFLICT (resend_id, event_type) DO NOTHING and
// returns early on a duplicate, so a redelivery records once and re-applies nothing.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const RESEND_ID = `re_idemp_${NONCE}`;
const RESEND_ID_HEAL = `re_heal_${NONCE}`;
const RESEND_ID_TS = `re_ts_${NONCE}`;
const RESEND_ID_UNK = `re_unk_${NONCE}`;
const RESEND_ID_RACE = `re_race_${NONCE}`;
const RESEND_ID_MONO = `re_mono_${NONCE}`;
const RESEND_ID_MONO2 = `re_mono2_${NONCE}`;
let server, baseUrl, healLeadId, tsLeadId, raceLeadId, monoLeadId, mono2LeadId;

before(async () => {
  const app = express();
  app.use(express.raw({ type: 'application/json' })); // mirror index.js raw body for svix
  app.use('/api/email-marketing/webhook', webhookRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query('DELETE FROM email_webhook_events WHERE resend_id = ANY($1)', [[RESEND_ID, RESEND_ID_HEAL, RESEND_ID_TS, RESEND_ID_UNK, RESEND_ID_RACE, RESEND_ID_MONO, RESEND_ID_MONO2]]);
  await pool.query('DELETE FROM email_sends WHERE resend_id = ANY($1)', [[RESEND_ID_HEAL, RESEND_ID_TS, RESEND_ID_RACE, RESEND_ID_MONO, RESEND_ID_MONO2]]);
  const leads = [healLeadId, tsLeadId, raceLeadId, monoLeadId, mono2LeadId].filter(Boolean);
  if (leads.length) await pool.query('DELETE FROM email_leads WHERE id = ANY($1::int[])', [leads]);
  await pool.end();
});

function postEvent(eventObj) {
  const payload = Buffer.from(JSON.stringify(eventObj));
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/email-marketing/webhook/resend');
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('a redelivered Resend webhook event is recorded once and re-applies nothing (ON CONFLICT idempotency)', async () => {
  const event = { type: 'email.delivered', data: { email_id: RESEND_ID } };

  const first = await postEvent(event);
  assert.equal(first.status, 200, `first delivery: ${first.status} ${JSON.stringify(first.body)}`);

  const second = await postEvent(event);
  assert.equal(second.status, 200, `redelivery should not error: ${second.status} ${JSON.stringify(second.body)}`);
  assert.equal(second.body && second.body.duplicate, true, 'redelivery should be flagged duplicate');

  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM email_webhook_events WHERE resend_id = $1', [RESEND_ID]);
  assert.equal(cnt.rows[0].n, 1, 'exactly one webhook_events row for the redelivered event');
});

test('a recorded-but-unprocessed event re-applies its (idempotent) side-effects on redelivery (mid-processing-failure heal)', async () => {
  // Simulate a prior delivery that INSERTed the webhook row but 500'd before applying the
  // side-effects (processed stayed false) — so the bounce never suppressed the lead. The
  // idempotency gate must skip ONLY fully-processed rows, else the event is stranded forever.
  const lead = await pool.query(
    `INSERT INTO email_leads (name, email, status) VALUES ('Heal Test', $1, 'active') RETURNING id`,
    [`heal-${NONCE}@example.com`]
  );
  healLeadId = lead.rows[0].id;
  await pool.query(
    `INSERT INTO email_sends (lead_id, resend_id, status) VALUES ($1, $2, 'sent')`,
    [healLeadId, RESEND_ID_HEAL]
  );
  await pool.query(
    `INSERT INTO email_webhook_events (resend_id, event_type, payload, processed)
     VALUES ($1, 'email.bounced', '{}', false)`,
    [RESEND_ID_HEAL]
  );

  const res = await postEvent({ type: 'email.bounced', data: { email_id: RESEND_ID_HEAL } });
  assert.equal(res.status, 200, `redelivery should process: ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(!(res.body && res.body.duplicate), 'an unprocessed row must NOT be skipped as a duplicate');

  const leadAfter = await pool.query('SELECT status FROM email_leads WHERE id = $1', [healLeadId]);
  assert.equal(leadAfter.rows[0].status, 'bounced', 'the bounce side-effect healed: the lead is now suppressed');

  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM email_webhook_events WHERE resend_id = $1', [RESEND_ID_HEAL]);
  assert.equal(cnt.rows[0].n, 1, 'still exactly one webhook_events row (no duplicate insert)');
  const proc = await pool.query('SELECT processed FROM email_webhook_events WHERE resend_id = $1', [RESEND_ID_HEAL]);
  assert.equal(proc.rows[0].processed, true, 'the row is now marked processed');
});

test('the heal does NOT re-stamp an existing *_at timestamp (COALESCE keeps the first event time)', async () => {
  const lead = await pool.query(
    `INSERT INTO email_leads (name, email, status) VALUES ('TS Test', $1, 'active') RETURNING id`,
    [`ts-${NONCE}@example.com`]
  );
  tsLeadId = lead.rows[0].id;
  // email_sends already carries bounced_at from the original (pre-strand) processing.
  const original = '2020-01-02T03:04:05.000Z';
  await pool.query(
    `INSERT INTO email_sends (lead_id, resend_id, status, bounced_at) VALUES ($1, $2, 'bounced', $3)`,
    [tsLeadId, RESEND_ID_TS, original]
  );
  await pool.query(
    `INSERT INTO email_webhook_events (resend_id, event_type, payload, processed) VALUES ($1, 'email.bounced', '{}', false)`,
    [RESEND_ID_TS]
  );

  const res = await postEvent({ type: 'email.bounced', data: { email_id: RESEND_ID_TS } });
  assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body)}`);
  const send = await pool.query('SELECT bounced_at FROM email_sends WHERE resend_id = $1', [RESEND_ID_TS]);
  assert.equal(
    new Date(send.rows[0].bounced_at).toISOString(), new Date(original).toISOString(),
    'bounced_at must keep the original event time, not the replay wall-clock'
  );
});

test('concurrent redeliveries serialize on the row lock and do not double-apply the side-effects', async () => {
  // The race this guards: two redeliveries of the same (resend_id, event_type) both
  // read processed=false and both run the side-effects. The handler now takes a
  // SELECT ... FOR UPDATE row lock, so a second delivery blocks until the first
  // commits, then sees processed=true and skips. We simulate "delivery A is
  // mid-flight" by holding the row lock open in our own transaction, fire delivery
  // B through the handler, prove B blocks, then release and confirm B skipped.
  const lead = await pool.query(
    `INSERT INTO email_leads (name, email, status) VALUES ('Race Test', $1, 'active') RETURNING id`,
    [`race-${NONCE}@example.com`]
  );
  raceLeadId = lead.rows[0].id;
  await pool.query(
    `INSERT INTO email_sends (lead_id, resend_id, status) VALUES ($1, $2, 'sent')`,
    [raceLeadId, RESEND_ID_RACE]
  );
  await pool.query(
    `INSERT INTO email_webhook_events (resend_id, event_type, payload, processed)
     VALUES ($1, 'email.bounced', '{}', false)`,
    [RESEND_ID_RACE]
  );

  // Delivery A: hold the FOR UPDATE row lock open in a transaction.
  const clientA = await pool.connect();
  await clientA.query('BEGIN');
  await clientA.query(
    'SELECT processed FROM email_webhook_events WHERE resend_id = $1 AND event_type = $2 FOR UPDATE',
    [RESEND_ID_RACE, 'email.bounced']
  );

  // Delivery B fires concurrently; it must block on the same row lock.
  const bPromise = postEvent({ type: 'email.bounced', data: { email_id: RESEND_ID_RACE } });

  // Prove B is blocked: it has not resolved while A holds the lock.
  const phase = await Promise.race([
    bPromise.then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('pending'), 700)),
  ]);
  assert.equal(phase, 'pending', 'delivery B must block on the row lock while A holds it');

  // The lead is still untouched while B is blocked (B has applied nothing).
  const midLead = await pool.query('SELECT status FROM email_leads WHERE id = $1', [raceLeadId]);
  assert.equal(midLead.rows[0].status, 'active', 'B applied no side-effects while blocked');

  // A finishes: applies the bounce exactly once, marks processed, commits, releases.
  await clientA.query(`UPDATE email_leads SET status = 'bounced' WHERE id = $1`, [raceLeadId]);
  await clientA.query(
    'UPDATE email_webhook_events SET processed = true WHERE resend_id = $1 AND event_type = $2',
    [RESEND_ID_RACE, 'email.bounced']
  );
  await clientA.query('COMMIT');
  clientA.release();

  // B unblocks, sees processed=true, and skips as a duplicate (no second apply).
  const b = await bPromise;
  assert.equal(b.status, 200, `B should ack: ${b.status} ${JSON.stringify(b.body)}`);
  assert.equal(b.body && b.body.duplicate, true, 'B serialized behind A and then skipped as duplicate');

  const leadAfter = await pool.query('SELECT status FROM email_leads WHERE id = $1', [raceLeadId]);
  assert.equal(leadAfter.rows[0].status, 'bounced', 'the bounce applied exactly once (by A); B did not re-apply');
});

test('an unknown event type is marked processed=true (terminal no-op, not perpetually re-runnable)', async () => {
  const res = await postEvent({ type: 'email.somethingnew', data: { email_id: RESEND_ID_UNK } });
  assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(res.body && res.body.received, 'unknown type still acks received');
  const ev = await pool.query(
    'SELECT processed FROM email_webhook_events WHERE resend_id = $1 AND event_type = $2',
    [RESEND_ID_UNK, 'email.somethingnew']
  );
  assert.equal(ev.rows[0].processed, true, 'an unknown-type row is marked processed (terminal)');
});

test('status is monotonic: a late engagement event does not regress a terminal bounce (audit F2)', async () => {
  // Resend can deliver out of order. A send already 'bounced' must NOT be dragged
  // back to 'opened' by a late open event (the old bare `status=$1` overwrite did).
  const lead = await pool.query(
    `INSERT INTO email_leads (name, email, status) VALUES ('Mono Test', $1, 'active') RETURNING id`,
    [`mono-${NONCE}@example.com`]
  );
  monoLeadId = lead.rows[0].id;
  await pool.query(
    `INSERT INTO email_sends (lead_id, resend_id, status, bounced_at) VALUES ($1, $2, 'bounced', NOW())`,
    [monoLeadId, RESEND_ID_MONO]
  );

  const res = await postEvent({ type: 'email.opened', data: { email_id: RESEND_ID_MONO } });
  assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body)}`);

  const send = await pool.query('SELECT status FROM email_sends WHERE resend_id = $1', [RESEND_ID_MONO]);
  assert.equal(send.rows[0].status, 'bounced', 'a late opened must not regress a terminal bounce (would be "opened" pre-fix)');
});

test('status still advances forward: sent -> delivered -> opened -> clicked (monotonic guard does not over-block)', async () => {
  // Guards the other direction: the rank CASE must not freeze legit progression.
  const lead = await pool.query(
    `INSERT INTO email_leads (name, email, status) VALUES ('Mono2 Test', $1, 'active') RETURNING id`,
    [`mono2-${NONCE}@example.com`]
  );
  mono2LeadId = lead.rows[0].id;
  await pool.query(
    `INSERT INTO email_sends (lead_id, resend_id, status) VALUES ($1, $2, 'sent')`,
    [mono2LeadId, RESEND_ID_MONO2]
  );

  await postEvent({ type: 'email.delivered', data: { email_id: RESEND_ID_MONO2 } });
  await postEvent({ type: 'email.opened', data: { email_id: RESEND_ID_MONO2 } });
  await postEvent({ type: 'email.clicked', data: { email_id: RESEND_ID_MONO2 } });

  const send = await pool.query('SELECT status FROM email_sends WHERE resend_id = $1', [RESEND_ID_MONO2]);
  assert.equal(send.rows[0].status, 'clicked', 'forward progression must still reach the highest rank');
});
