require('dotenv').config();
process.env.NODE_ENV = 'test';

// GET /api/clients/:id: the additive `consult_calls` field (spec 2026-08-25
// section 5.3, task S3). One row per consult this client has had, each showing
// that consult's LATEST ring chain, newest slot first.
//
// clients.list.test.js covers GET /api/clients. This file is the detail route,
// which had no coverage at all. Two assertions here are load-bearing:
//
//   - client_no_answer_at is checked with `in`, not truthiness. Over JSON an
//     unselected column is simply absent, and S4's "connected, no answer" label
//     keys on exactly that column, so a dropped column would silently disable a
//     label rather than fail anything.
//   - the pre-existing `proposals` and `thumbtack_negotiation_id` attachments
//     are asserted on the same response. This task adds a fourth element to a
//     destructured Promise.all, and a shifted destructure is the failure mode.
//
// Shared dev DB (run ALONE). Fixtures are deleted BY RECORDED ID in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const router = require('./clients');

const RUN = `cl-cc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const made = { users: [], clients: [], proposals: [], consults: [], leads: [] };

let server, base, adminToken;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${path}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id`,
    [`${RUN}-admin@example.test`]
  );
  made.users.push(u.id);
  adminToken = jwt.sign({ userId: u.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json());
  app.use('/api/clients', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, code: err.code });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // By recorded id, in FK order. Attempts cascade with their consult.
  if (made.consults.length) await pool.query('DELETE FROM consults WHERE id = ANY($1::int[])', [made.consults]);
  if (made.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [made.leads]);
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [made.users]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

async function makeClient(tag) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`Clients ConsultCalls ${tag}`, `${RUN}-${tag}@example.test`]
  );
  made.clients.push(c.id);
  return c.id;
}

async function makeConsult(tag, { clientId, proposalId = null, dayOffset = 1 }) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO consults (client_id, proposal_id, scheduled_at, calcom_event_id, status, booker_name, booker_phone)
     VALUES ($1, $2, date_trunc('second', NOW()) + make_interval(days => $3), $4, 'scheduled', 'Detail Booker', '+12563281203')
     RETURNING id, scheduled_at`,
    [clientId, proposalId, dayOffset, `${RUN}-${tag}`]
  );
  made.consults.push(c.id);
  return c;
}

async function makeAttempt(consult, { status, answeredBy = null, durationSec = null, detail = null, noAnswer = false, slotShiftSec = 0 }) {
  const { rows: [a] } = await pool.query(
    // The slot is derived from the consults row IN SQL and never round-trips
    // through JavaScript (ruling R12): node-pg truncates a TIMESTAMPTZ to
    // milliseconds, so a slot handed back into a write stops matching the
    // (consult_id, scheduled_at) UNIQUE the moment a real Cal.com slot carries
    // microseconds. Explicit column list, because column ORDER differs between
    // a fresh database and prod.
    `INSERT INTO consult_call_attempts
       (consult_id, scheduled_at, status, answered_by, bridge_duration_sec, detail, client_no_answer_at)
     SELECT c.id, c.scheduled_at + make_interval(secs => $2), $3, $4, $5, $6,
            CASE WHEN $7::boolean THEN date_trunc('second', NOW()) ELSE NULL END
       FROM consults c WHERE c.id = $1
     RETURNING id, scheduled_at, client_no_answer_at`,
    [consult.id, slotShiftSec, status, answeredBy, durationSec, detail, noAnswer]
  );
  return a;
}

test('consult_calls carries one row per consult, latest chain each, newest first', async () => {
  const clientId = await makeClient('multi');
  const older = await makeConsult('multi-old', { clientId, dayOffset: 1 });
  const newer = await makeConsult('multi-new', { clientId, dayOffset: 9 });

  // The older consult was rescheduled: only its second chain may surface.
  await makeAttempt(older, { status: 'failed', detail: 'first slot', slotShiftSec: -7200 });
  await makeAttempt(older, { status: 'missed', detail: 'second slot' });
  const latched = await makeAttempt(newer, {
    status: 'connected', answeredBy: 'va', durationSec: 61, detail: 'newer consult', noAnswer: true,
  });

  const res = await get(`/api/clients/${clientId}`, adminToken);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.consult_calls), 'field present and an array');
  assert.equal(res.body.consult_calls.length, 2, 'one row per consult, not one per attempt');

  const [first, second] = res.body.consult_calls;
  // consult_id is S4's list key and it reads it from the API, not from the
  // lookup, so the field has to survive the route or the key is not there at
  // all. A slot cannot serve as the key: two consults for one client can
  // share one.
  assert.equal(first.consult_id, newer.id, 'the key identifies the right consult');
  assert.equal(second.consult_id, older.id);
  assert.equal(first.status, 'connected');
  assert.equal(first.answered_by, 'va');
  assert.equal(first.bridge_duration_sec, 61);
  assert.equal(first.detail, 'newer consult');
  assert.equal(second.status, 'missed', 'the rescheduled consult shows its LATEST attempt');
  assert.equal(second.detail, 'second slot');
  assert.ok(Date.parse(first.scheduled_at) > Date.parse(second.scheduled_at), 'newest slot first');

  // The column S4's "connected, no answer" label keys on, checked by name.
  assert.ok('client_no_answer_at' in first, 'client_no_answer_at survives the wire');
  assert.equal(Date.parse(first.client_no_answer_at), Date.parse(latched.client_no_answer_at));
  assert.ok('client_no_answer_at' in second, 'present on an unlatched row too');
  assert.equal(second.client_no_answer_at, null, 'null, not absent');
});

test('consult_calls is an empty array for a client who never booked a consult', async () => {
  const clientId = await makeClient('none');
  const res = await get(`/api/clients/${clientId}`, adminToken);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.consult_calls));
  assert.equal(res.body.consult_calls.length, 0);
});

test('consult_calls never carries another client\'s consult', async () => {
  const mine = await makeClient('mine');
  const mineConsult = await makeConsult('mine', { clientId: mine, dayOffset: 2 });
  await makeAttempt(mineConsult, { status: 'missed', detail: 'mine' });

  const other = await makeClient('other');
  const otherConsult = await makeConsult('other', { clientId: other, dayOffset: 20 });
  await makeAttempt(otherConsult, { status: 'connected', answeredBy: 'admin', durationSec: 500, detail: 'theirs' });

  const res = await get(`/api/clients/${mine}`, adminToken);
  assert.equal(res.body.consult_calls.length, 1);
  assert.equal(res.body.consult_calls[0].detail, 'mine');
});

test('the existing detail attachments still line up (Promise.all seam)', async () => {
  const clientId = await makeClient('seam');
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, amount_paid, pricing_snapshot, total_price)
     VALUES ($1, 'sent', 0, '{}'::jsonb, 500) RETURNING id`,
    [clientId]
  );
  made.proposals.push(p.id);
  const { rows: [l] } = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, client_id, raw_payload)
     VALUES ($1, 'Clients Seam Lead', '+17735550100', $2, '{}'::jsonb) RETURNING id`,
    [`${RUN}-seam-lead`, clientId]
  );
  made.leads.push(l.id);
  const consult = await makeConsult('seam', { clientId, proposalId: p.id, dayOffset: 3 });
  await makeAttempt(consult, { status: 'skipped_cap', detail: 'va_leg_cap_tripped' });

  const res = await get(`/api/clients/${clientId}`, adminToken);
  assert.equal(res.status, 200);
  // A shifted destructure would put one of these rowsets on the wrong field.
  assert.equal(res.body.id, clientId, 'the client row is still the client row');
  assert.equal(res.body.proposals.length, 1);
  assert.equal(res.body.proposals[0].id, p.id);
  assert.equal(res.body.thumbtack_negotiation_id, `${RUN}-seam-lead`);
  assert.equal(res.body.consult_calls.length, 1);
  assert.equal(res.body.consult_calls[0].status, 'skipped_cap');
  // detail is diagnostic free text, never an enum. skipped_cap carries THREE
  // distinct values and they ride through verbatim: cap_tripped, which openChain
  // writes when the chain-open daily cap trips and which DOMINATES because it is
  // what a stranger hammering the public booking page hits first, plus
  // dial_cap_tripped for rings to Dallas and va_leg_cap_tripped for the
  // international legs to Zul. detail also carries a raw Twilio error code from
  // a failed calls.create, which is why nothing may treat it as an enum.
  assert.equal(res.body.consult_calls[0].detail, 'va_leg_cap_tripped');
});

test('an unknown client is still a 404, not an empty consult_calls payload', async () => {
  const res = await get('/api/clients/999999999', adminToken);
  assert.equal(res.status, 404);
});

test('an unauthenticated caller still cannot read a client detail', async () => {
  const clientId = await makeClient('auth');
  assert.equal((await get(`/api/clients/${clientId}`, null)).status, 401);
});
