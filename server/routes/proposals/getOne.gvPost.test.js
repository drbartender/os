require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  throw new Error('getOne.gvPost.test.js refuses to run against production');
}
process.env.SEND_NOTIFICATIONS = 'false';

// GET /api/proposals/:id carries gv_post (the proposal's latest GV post into
// the Thumbtack thread, as gvPostStatusForProposal reads it; null without
// one), and GET /api/proposals/:id/gv-post returns it alone for the proposal
// page's poll (plan Task 10 of docs/superpowers/plans/2026-10-17-tt-proposal-link-via-gv.md).
// Run ALONE (shared dev DB). The one post is hand-inserted as 'sent', never
// queued, so no lease could offer it and no sweep arm touches it. Every
// fixture is invented (names, a 555-01xx number, example.com emails) and
// deleted in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { proposalUrl } = require('../../utils/urls');
const getOneRouter = require('./getOne');

let server;
let baseUrl;
let adminToken;
let staffToken;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const RUN = `go-gv-${NONCE}`;

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

async function mkUser(role) {
  const passwordHash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, $3, 'approved', 0) RETURNING id, token_version`,
    [`${RUN}-${role}@example.com`, passwordHash, role]
  );
  return jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

before(async () => {
  adminToken = await mkUser('admin');
  staffToken = await mkUser('staff');

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
  try {
    await new Promise((r) => server.close(r));
    await pool.query(
      `DELETE FROM gv_posts WHERE proposal_id IN
         (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))`,
      [`${RUN}-%`]
    );
    await pool.query(`DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)`, [`${RUN}-%`]);
    await pool.query(`DELETE FROM clients WHERE email LIKE $1`, [`${RUN}-%`]);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${RUN}-%`]);
  } finally {
    await pool.end();
  }
});

async function makeProposal() {
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('GetOne GvPost Test', $1, '3125550142') RETURNING id`,
    [`${RUN}-c${crypto.randomBytes(2).toString('hex')}@example.com`]
  );
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, amount_paid, pricing_snapshot, total_price)
     VALUES ($1, 'sent', 0, '{}'::jsonb, 500) RETURNING id, token`,
    [c.id]
  );
  return { proposalId: p.id, token: p.token, clientId: c.id };
}

async function makeSentPost({ proposalId, token, clientId }) {
  await pool.query(
    `INSERT INTO gv_posts (proposal_id, client_id, negotiation_id, body, send_path, status, leased_at, reported_at, clicked_at, created_at)
     VALUES ($1, $2, $3, $4, 'compose', 'sent', now() - interval '6 minutes', now() - interval '5 minutes',
             now() - interval '5 minutes', now() - interval '6 minutes')`,
    [proposalId, clientId, `${RUN}-neg`, `Your proposal is ready: ${proposalUrl(token)}`]
  );
}

test('GET /proposals/:id carries gv_post, null without a post', async () => {
  const fixture = await makeProposal();
  const none = await get(`/api/proposals/${fixture.proposalId}`, adminToken);
  assert.equal(none.status, 200);
  assert.ok('gv_post' in none.body, 'key present');
  assert.equal(none.body.gv_post, null);

  await makeSentPost(fixture);
  const res = await get(`/api/proposals/${fixture.proposalId}`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.gv_post.status, 'sent');
  assert.equal(res.body.gv_post.display, 'sent_not_seen');
  assert.equal(res.body.gv_post.hand_pasted, false);
  assert.equal(res.body.gv_post.phone_last4, '0142');
  assert.ok(!('body' in res.body.gv_post), 'the post body stays on the server');
});

test('GET /proposals/:id/gv-post returns the latest status and 401 without auth', async () => {
  const fixture = await makeProposal();
  const empty = await get(`/api/proposals/${fixture.proposalId}/gv-post`, adminToken);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { gv_post: null });

  await makeSentPost(fixture);
  const res = await get(`/api/proposals/${fixture.proposalId}/gv-post`, adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['gv_post']);
  assert.equal(res.body.gv_post.display, 'sent_not_seen');

  assert.equal((await get(`/api/proposals/${fixture.proposalId}/gv-post`)).status, 401);
  assert.equal((await get(`/api/proposals/${fixture.proposalId}/gv-post`, staffToken)).status, 403);
  assert.equal((await get('/api/proposals/not-a-number/gv-post', adminToken)).status, 400);
});
