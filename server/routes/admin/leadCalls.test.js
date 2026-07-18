require('dotenv').config();

// Route-level tests for GET /api/admin/lead-call-attention (admin/leadCalls.js).
// Harness mirrors settings.badgeCounts.test.js: minimal express() app with the
// real router + real auth/role middleware. Run ALONE (shared dev DB).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const leadCallsRouter = require('./leadCalls');

let server;
let baseUrl;
let adminToken;
let managerToken;
let staffToken;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_PREFIX = 'lead-call-attention-test-';
const RUN = `lca-test-${NONCE}`;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
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

async function makeUser(role) {
  const passwordHash = await bcrypt.hash('x', 4);
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, $3, 'approved', 0) RETURNING id, token_version`,
    [`${EMAIL_PREFIX}${role}-${NONCE}@example.com`, passwordHash, role]
  );
  return r.rows[0];
}

function tokenFor(u) {
  return jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function makeLead(i, leadStatus = 'new') {
  const r = await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, customer_name, customer_phone, status, raw_payload)
     VALUES ($1, $2, '+17735550100', $3, '{}'::jsonb) RETURNING id`,
    [`${RUN}-${i}`, `Attention Lead ${i}`, leadStatus]
  );
  return r.rows[0].id;
}

async function makeAttempt(leadId, status, ageDays = 0, detail = null) {
  const r = await pool.query(
    `INSERT INTO lead_call_attempts (lead_id, status, detail, created_at)
     VALUES ($1, $2, $3, NOW() - ($4 || ' days')::interval) RETURNING id`,
    [leadId, status, detail, ageDays]
  );
  return Number(r.rows[0].id);
}

before(async () => {
  adminToken = tokenFor(await makeUser('admin'));
  managerToken = tokenFor(await makeUser('manager'));
  staffToken = tokenFor(await makeUser('staff'));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', leadCallsRouter);
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
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  await pool.end();
});

test('returns open attention rows with the join fields, newest first', async () => {
  const missedId = await makeAttempt(await makeLead('missed'), 'missed');
  const afterHoursId = await makeAttempt(await makeLead('ah'), 'skipped_after_hours', 1);
  const res = await get('/api/admin/lead-call-attention', adminToken);
  assert.equal(res.status, 200);
  const mine = res.body.filter((r) => (r.customer_name || '').startsWith('Attention Lead'));
  assert.deepEqual(mine.map((r) => Number(r.id)), [missedId, afterHoursId], 'newest first');
  const row = mine[0];
  for (const k of ['id', 'status', 'detail', 'created_at', 'customer_name', 'proposal_id', 'client_id']) {
    assert.ok(k in row, `field ${k}`);
  }
});

test('excludes connected chains, stale rows past 7 days, and non-new leads', async () => {
  await makeAttempt(await makeLead('conn'), 'connected');
  await makeAttempt(await makeLead('old'), 'missed', 8);
  await makeAttempt(await makeLead('contacted', 'contacted'), 'missed');
  const res = await get('/api/admin/lead-call-attention', adminToken);
  const names = res.body.map((r) => r.customer_name);
  assert.ok(!names.includes('Attention Lead conn'), 'connected excluded');
  assert.ok(!names.includes('Attention Lead old'), '7-day cutoff');
  assert.ok(!names.includes('Attention Lead contacted'), 'lead no longer new clears the item');
});

test('role guard: manager allowed, staff and anonymous denied', async () => {
  assert.equal((await get('/api/admin/lead-call-attention', managerToken)).status, 200);
  assert.equal((await get('/api/admin/lead-call-attention', staffToken)).status, 403);
  assert.equal((await get('/api/admin/lead-call-attention', null)).status, 401);
});
