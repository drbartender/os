// Tests POST /rearm (admin failed->pending control) and POST /harvest-failed (agent
// outcome reporting + retry cap). Mounts the REAL agent router against scratch dev-DB
// rows. Run ALONE. MAX_HARVEST_ATTEMPTS defaults to 3.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const agentRouter = require('./thumbtackAgent');

if (process.env.NODE_ENV === 'production') {
  throw new Error('thumbtackAgent.failures.test.js refuses to run against production');
}

const SECRET = `fail-secret-${Date.now()}-abcdefghijklmnop`;
const ORIG_SECRET = process.env.THUMBTACK_AGENT_SECRET;
const SUF = `f${Date.now()}`;
let server, baseUrl, adminId, adminToken;
const clientIds = [];
const userIds = [];
const negs = [];

async function mkClient({ status = 'pending' } = {}) {
  const r = await pool.query(
    `INSERT INTO clients (name, phone, source, email_harvest_status) VALUES ($1,$2,'thumbtack',$3) RETURNING id`,
    [`Fail ${SUF}`, `+1555${String(Date.now()).slice(-7)}`, status]
  );
  clientIds.push(r.rows[0].id);
  return r.rows[0].id;
}
async function mkLead(clientId, label) {
  const neg = `${SUF}-${label}`;
  negs.push(neg);
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_name, status, raw_payload)
     VALUES ($1,$2,$3,'new','{}'::jsonb)`,
    [neg, clientId, `Fail ${SUF} ${label}`]
  );
  return neg;
}
function post(path, body, { agentSecret, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${baseUrl}/api/admin/thumbtack${path}`);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (agentSecret) headers['x-thumbtack-agent-secret'] = agentSecret;
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

before(async () => {
  process.env.THUMBTACK_AGENT_SECRET = SECRET;
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','admin','approved') RETURNING id`,
    [`${SUF}-admin@example.com`]
  );
  adminId = a.rows[0].id; userIds.push(adminId);
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/admin/thumbtack', agentRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (ORIG_SECRET === undefined) delete process.env.THUMBTACK_AGENT_SECRET;
  else process.env.THUMBTACK_AGENT_SECRET = ORIG_SECRET;
  if (server) await new Promise((r) => server.close(r));
  for (const neg of negs) await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  if (adminId) await pool.query("DELETE FROM admin_audit_log WHERE actor_user_id = $1 AND action = 'thumbtack_harvest_rearm'", [adminId]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  await pool.end();
});

// ---- rearm (Task 6) ----

test('rearm: a failed lead goes back to pending with attempts + cooldown cleared', async () => {
  const id = await mkClient({ status: 'failed' });
  await pool.query('UPDATE clients SET email_harvest_attempts=5, email_harvest_attempted_at=now() WHERE id=$1', [id]);
  const neg = await mkLead(id, 'rf');
  const r = await post('/rearm', { negotiation_id: neg }, { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'pending');
  const c = await pool.query('SELECT email_harvest_status, email_harvest_attempts, email_harvest_attempted_at FROM clients WHERE id=$1', [id]);
  assert.equal(c.rows[0].email_harvest_status, 'pending');
  assert.equal(c.rows[0].email_harvest_attempts, 0);
  assert.equal(c.rows[0].email_harvest_attempted_at, null);
});

test('rearm: a non-failed lead → 409 not_failed', async () => {
  const id = await mkClient({ status: 'pending' });
  const neg = await mkLead(id, 'rnf');
  const r = await post('/rearm', { negotiation_id: neg }, { token: adminToken });
  assert.equal(r.status, 409);
  assert.equal(r.body.status, 'not_failed');
});

test('rearm: unknown negotiation_id → 404', async () => {
  const r = await post('/rearm', { negotiation_id: `${SUF}-none` }, { token: adminToken });
  assert.equal(r.status, 404);
});

test('rearm: agent-secret-only caller (no admin JWT) is rejected 401', async () => {
  const id = await mkClient({ status: 'failed' });
  const neg = await mkLead(id, 'rauth');
  const r = await post('/rearm', { negotiation_id: neg }, { agentSecret: SECRET });
  assert.equal(r.status, 401);
});

// ---- harvest-failed (Task 7) ----

test('harvest-failed: render_timeout below cap increments attempts, stays pending', async () => {
  const id = await mkClient({ status: 'pending' });
  const neg = await mkLead(id, 'hf1');
  const r = await post('/harvest-failed', { negotiation_id: neg, reason: 'render_timeout' }, { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.attempts, 1);
  const c = await pool.query('SELECT email_harvest_status, email_harvest_attempts FROM clients WHERE id=$1', [id]);
  assert.equal(c.rows[0].email_harvest_status, 'pending');
  assert.equal(c.rows[0].email_harvest_attempts, 1);
});

test('harvest-failed: reaching MAX_ATTEMPTS marks the lead failed', async () => {
  const id = await mkClient({ status: 'pending' });
  await pool.query('UPDATE clients SET email_harvest_attempts=2 WHERE id=$1', [id]); // MAX-1 (default 3)
  const neg = await mkLead(id, 'hf2');
  const r = await post('/harvest-failed', { negotiation_id: neg, reason: 'navigation_error' }, { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'failed');
  assert.equal(r.body.attempts, 3);
  const c = await pool.query('SELECT email_harvest_status FROM clients WHERE id=$1', [id]);
  assert.equal(c.rows[0].email_harvest_status, 'failed');
});

test('harvest-failed: ambiguous is terminal failed immediately, no counter bump', async () => {
  const id = await mkClient({ status: 'pending' });
  const neg = await mkLead(id, 'hf3');
  const r = await post('/harvest-failed', { negotiation_id: neg, reason: 'ambiguous' }, { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'failed');
  const c = await pool.query('SELECT email_harvest_status, email_harvest_attempts FROM clients WHERE id=$1', [id]);
  assert.equal(c.rows[0].email_harvest_status, 'failed');
  assert.equal(c.rows[0].email_harvest_attempts, 0);
});

test('harvest-failed: session_expired leaves status + attempts untouched', async () => {
  const id = await mkClient({ status: 'pending' });
  const neg = await mkLead(id, 'hf4');
  const r = await post('/harvest-failed', { negotiation_id: neg, reason: 'session_expired' }, { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'session_expired');
  const c = await pool.query('SELECT email_harvest_status, email_harvest_attempts FROM clients WHERE id=$1', [id]);
  assert.equal(c.rows[0].email_harvest_status, 'pending');
  assert.equal(c.rows[0].email_harvest_attempts, 0);
});

test('harvest-failed: invalid reason → 400', async () => {
  const id = await mkClient({ status: 'pending' });
  const neg = await mkLead(id, 'hf5');
  const r = await post('/harvest-failed', { negotiation_id: neg, reason: 'bogus' }, { agentSecret: SECRET });
  assert.equal(r.status, 400);
});

test('harvest-failed: unknown negotiation_id → 404', async () => {
  const r = await post('/harvest-failed', { negotiation_id: `${SUF}-x`, reason: 'render_timeout' }, { agentSecret: SECRET });
  assert.equal(r.status, 404);
});
