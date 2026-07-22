require('dotenv').config();

// GET /api/proposals/:id — the additive `lead_call` field (spec 2026-07-18
// §5.3): present (newest attempt) for a TT-drafted proposal with a call
// chain, null for everything else. Focused harness (crud.test.js has a known
// pre-existing break; this field gets its own suite). Run ALONE (shared dev DB).

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

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const RUN = `go-lc-${NONCE}`;

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
    [`${RUN}-admin@example.com`, passwordHash]
  );
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
  await pool.query(`DELETE FROM thumbtack_leads WHERE negotiation_id LIKE $1`, [`${RUN}-%`]);
  await pool.query(`DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)`, [`${RUN}-%`]);
  await pool.query(`DELETE FROM clients WHERE email LIKE $1`, [`${RUN}-%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${RUN}-%`]);
  await pool.end();
});

async function makeProposal() {
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('GetOne LeadCall Test', $1) RETURNING id`,
    [`${RUN}-c${crypto.randomBytes(2).toString('hex')}@example.com`]
  );
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, amount_paid, pricing_snapshot, total_price)
     VALUES ($1, 'sent', 0, '{}'::jsonb, 500) RETURNING id`,
    [c.id]
  );
  return p.id;
}

test('lead_call is present with the newest attempt for a TT-drafted proposal', async () => {
  const proposalId = await makeProposal();
  const { rows: [l] } = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, proposal_id, raw_payload)
     VALUES ($1, 'GetOne Lead', '+17735550100', $2, '{}'::jsonb) RETURNING id`,
    [`${RUN}-lead`, proposalId]
  );
  await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, answered_by, bridge_duration_sec)
     VALUES ($1, 'connected', 'admin', 252)`,
    [l.id]
  );

  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.lead_call, 'field present');
  assert.equal(res.body.lead_call.status, 'connected');
  assert.equal(res.body.lead_call.answered_by, 'admin');
  assert.equal(res.body.lead_call.bridge_duration_sec, 252);
});

test('lead_call is null for a proposal with no lead call chain', async () => {
  const proposalId = await makeProposal();
  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.lead_call, null);
});

test('first_reply carries status/template/sent_at for a sent reply', async () => {
  const proposalId = await makeProposal();
  const sentAt = '2026-07-20T20:14:00.000Z';
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, proposal_id, raw_payload,
                                  first_reply_status, first_reply_template, first_reply_sent_at)
     VALUES ($1, 'GetOne FR Sent', '+17735550101', $2, '{}'::jsonb, 'sent', 'day', $3)`,
    [`${RUN}-fr-sent`, proposalId, sentAt]
  );

  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.first_reply, 'field present');
  assert.equal(res.body.first_reply.status, 'sent');
  assert.equal(res.body.first_reply.template, 'day');
  assert.equal(Date.parse(res.body.first_reply.sent_at), Date.parse(sentAt));
});

test('first_reply is null when the lead never needed a reply', async () => {
  const proposalId = await makeProposal();
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, proposal_id, raw_payload,
                                  first_reply_status)
     VALUES ($1, 'GetOne FR NotNeeded', '+17735550102', $2, '{}'::jsonb, 'not_needed')`,
    [`${RUN}-fr-nn`, proposalId]
  );

  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.first_reply, null);
});

test('first_reply is null for a proposal with no lead row', async () => {
  const proposalId = await makeProposal();
  const res = await get(`/api/proposals/${proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.first_reply, null);
});
