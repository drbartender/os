require('dotenv').config();

// GET /api/proposals/:id: the additive `consult_call` field (spec 2026-08-25
// section 5.3, task S3). Present (newest attempt on the newest consult) for a
// proposal that had a consult ring chain, null for everything else.
//
// The harness is getOne.leadCall.test.js's. What is new here is the SEAM test:
// this task adds a fourth element to a destructured Promise.all, and a
// mis-ordered destructure would silently hand the lead call rows to the consult
// field and vice versa, so one proposal carries BOTH chains and both fields are
// asserted at once. Asserting consult_call alone would pass that bug.
//
// Shared dev DB (run ALONE). Fixtures are deleted BY RECORDED ID in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const getOneRouter = require('./getOne');

let server;
let baseUrl;
let adminToken;

const RUN = `go-cc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const made = { users: [], clients: [], proposals: [], consults: [], leads: [] };

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  const passwordHash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`${RUN}-admin@example.test`, passwordHash]
  );
  made.users.push(u.id);
  adminToken = jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/proposals', getOneRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  // By recorded id, in FK order. Attempt rows cascade with their consult, and
  // lead_call_attempts cascades with its thumbtack_leads row.
  if (made.consults.length) await pool.query('DELETE FROM consults WHERE id = ANY($1::int[])', [made.consults]);
  if (made.leads.length) await pool.query('DELETE FROM thumbtack_leads WHERE id = ANY($1::int[])', [made.leads]);
  if (made.proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [made.proposals]);
  if (made.clients.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [made.clients]);
  if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [made.users]);
  await pool.end();
});

async function makeProposal(tag) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('GetOne ConsultCall Test', $1) RETURNING id`,
    [`${RUN}-${tag}@example.test`]
  );
  made.clients.push(c.id);
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, amount_paid, pricing_snapshot, total_price)
     VALUES ($1, 'sent', 0, '{}'::jsonb, 500) RETURNING id`,
    [c.id]
  );
  made.proposals.push(p.id);
  return { clientId: c.id, proposalId: p.id };
}

async function makeConsult(tag, { clientId, proposalId, dayOffset = 1 }) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO consults (client_id, proposal_id, scheduled_at, calcom_event_id, status, booker_name, booker_phone)
     VALUES ($1, $2, date_trunc('second', NOW()) + make_interval(days => $3), $4, 'scheduled', 'Route Booker', '+12565550186')
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

test('consult_call carries the newest attempt, with client_no_answer_at', async () => {
  const { clientId, proposalId } = await makeProposal('c-newest');
  const consult = await makeConsult('c-newest', { clientId, proposalId, dayOffset: 2 });
  // Rescheduled once: the earlier chain must not be the one that surfaces.
  await makeAttempt(consult, { status: 'failed', detail: '13224', slotShiftSec: -3600 });
  const newer = await makeAttempt(consult, {
    status: 'connected', answeredBy: 'va', durationSec: 137, detail: 'bridged', noAnswer: true,
  });

  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.consult_call, 'field present');
  assert.equal(res.body.consult_call.status, 'connected');
  assert.equal(res.body.consult_call.answered_by, 'va');
  assert.equal(res.body.consult_call.bridge_duration_sec, 137);
  assert.equal(res.body.consult_call.detail, 'bridged');
  assert.equal(Date.parse(res.body.consult_call.scheduled_at), Date.parse(newer.scheduled_at));
  // The column S4's "connected, no answer" label keys on. Over JSON an
  // unselected column is simply absent, which reads as "did not happen".
  assert.ok('client_no_answer_at' in res.body.consult_call, 'client_no_answer_at survives the wire');
  assert.equal(Date.parse(res.body.consult_call.client_no_answer_at), Date.parse(newer.client_no_answer_at));
});

test('consult_call keeps client_no_answer_at as an explicit null when nothing latched', async () => {
  const { clientId, proposalId } = await makeProposal('c-nolatch');
  const consult = await makeConsult('c-nolatch', { clientId, proposalId, dayOffset: 3 });
  await makeAttempt(consult, { status: 'connected', answeredBy: 'admin', durationSec: 400 });

  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.ok('client_no_answer_at' in res.body.consult_call, 'present');
  assert.equal(res.body.consult_call.client_no_answer_at, null, 'and null, not absent');
});

test('consult_call is null for a proposal that never had a consult', async () => {
  const { proposalId } = await makeProposal('c-none');
  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.consult_call, null);
});

test('consult_call is null for a consult that was never rung', async () => {
  const { clientId, proposalId } = await makeProposal('c-norings');
  await makeConsult('c-norings', { clientId, proposalId, dayOffset: 4 });
  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.consult_call, null);
});

test('the existing parallel attachments still line up (Promise.all seam)', async () => {
  // One proposal carrying BOTH chains. A destructure that shifted by one would
  // put the lead call row on consult_call and still pass a consult-only test.
  const { clientId, proposalId } = await makeProposal('c-seam');
  const consult = await makeConsult('c-seam', { clientId, proposalId, dayOffset: 5 });
  await makeAttempt(consult, { status: 'missed', detail: 'consult side' });

  const { rows: [l] } = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, proposal_id, raw_payload,
                                  first_reply_status, first_reply_template)
     VALUES ($1, 'GetOne Seam Lead', '+17735550100', $2, '{}'::jsonb, 'sent', 'day') RETURNING id`,
    [`${RUN}-seam-lead`, proposalId]
  );
  made.leads.push(l.id);
  await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, answered_by, bridge_duration_sec)
     VALUES ($1, 'connected', 'admin', 252)`,
    [l.id]
  );

  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.consult_call.status, 'missed');
  assert.equal(res.body.consult_call.detail, 'consult side');
  assert.equal(res.body.lead_call.status, 'connected');
  assert.equal(res.body.lead_call.bridge_duration_sec, 252, 'the lead call row is still the lead call row');
  assert.equal(res.body.first_reply.status, 'sent');
  assert.equal(res.body.first_reply.template, 'day');
  assert.ok(Array.isArray(res.body.addons), 'addons still an array');
  assert.ok(Array.isArray(res.body.activity), 'activity still an array');
  assert.ok(Array.isArray(res.body.messageLog), 'messageLog still an array');
});
