// Tests POST /api/admin/thumbtack/email-harvested (the writeback). Covers set,
// already_set, not_pending (agent), lead_not_found, the wrong-address guards (pro
// domain + active staff), collision-as-failed on the AGENT path vs recoverable on the
// ADMIN path, the admin override + audit row, and the after-commit drip re-arm.
// Mounts the REAL agent router against scratch dev-DB rows. Run ALONE.
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
  throw new Error('thumbtackAgent.harvested.test.js refuses to run against production');
}

const SECRET = `harv-secret-${Date.now()}-abcdefghijklmnop`;
const ORIG_SECRET = process.env.THUMBTACK_AGENT_SECRET;
const SUF = `h${Date.now()}`;
const PRO_DOMAIN = (process.env.ADMIN_EMAIL || 'contact@drbartender.com').split('@')[1];
let server, baseUrl, adminId, adminToken;
const clientIds = [];
const userIds = [];
const negs = [];
const proposalIds = [];
const smIds = [];

async function mkClient({ status = 'pending', email = null } = {}) {
  const r = await pool.query(
    `INSERT INTO clients (name, phone, email, source, email_harvest_status)
     VALUES ($1,$2,$3,'thumbtack',$4) RETURNING id`,
    [`Harv ${SUF}`, `+1555${String(Date.now()).slice(-7)}`, email, status]
  );
  clientIds.push(r.rows[0].id);
  return r.rows[0].id;
}
async function mkLead(clientId, label, status = 'new') {
  const neg = `${SUF}-${label}`;
  negs.push(neg);
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_name, status, raw_payload)
     VALUES ($1,$2,$3,$4,'{}'::jsonb)`,
    [neg, clientId, `Harv ${SUF} ${label}`, status]
  );
  return neg;
}
async function mkProposal(clientId) {
  const r = await pool.query('INSERT INTO proposals (client_id) VALUES ($1) RETURNING id', [clientId]);
  proposalIds.push(r.rows[0].id);
  return r.rows[0].id;
}
async function mkSched(proposalId, recipientId, { scheduledFor, status = 'suppressed', errorMessage = 'client_no_email' }) {
  const r = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, error_message)
     VALUES ($1,'proposal','drip','client',$2,'email',$3,$4,$5) RETURNING id`,
    [proposalId, recipientId, scheduledFor, status, errorMessage]
  );
  smIds.push(r.rows[0].id);
  return r.rows[0].id;
}
function postHarvested(body, { agentSecret, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(baseUrl + '/api/admin/thumbtack/email-harvested');
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
async function waitFor(fn, tries = 50, delayMs = 40) {
  for (let i = 0; i < tries; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, delayMs)); }
  return false;
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
  if (smIds.length) await pool.query('DELETE FROM scheduled_messages WHERE id = ANY($1::int[])', [smIds]);
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  for (const neg of negs) await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  if (adminId) await pool.query("DELETE FROM admin_audit_log WHERE actor_user_id = $1 AND action = 'thumbtack_email_harvested'", [adminId]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  await pool.end();
});

test('set: agent stamps email on a pending+null client', async () => {
  const id = await mkClient({ status: 'pending' });
  const neg = await mkLead(id, 'set');
  const email = `set-${SUF}@example.test`;
  const r = await postHarvested({ negotiation_id: neg, email }, { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'set');
  const c = await pool.query('SELECT email, email_harvest_status FROM clients WHERE id = $1', [id]);
  assert.equal(c.rows[0].email, email);
  assert.equal(c.rows[0].email_harvest_status, 'harvested');
});

test('already_set: a client that already has an email is resolved as-is, pending promoted to harvested', async () => {
  const existing = `already-${SUF}@example.test`;
  const id = await mkClient({ status: 'pending', email: existing });
  const neg = await mkLead(id, 'already');
  const r = await postHarvested({ negotiation_id: neg, email: `different-${SUF}@example.test` }, { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'already_set');
  const c = await pool.query('SELECT email, email_harvest_status FROM clients WHERE id = $1', [id]);
  assert.equal(c.rows[0].email, existing, 'the existing email is NOT overwritten');
  assert.equal(c.rows[0].email_harvest_status, 'harvested', 'pending is promoted to harvested');
});

test('not_pending: agent cannot write a client whose status is not pending', async () => {
  const id = await mkClient({ status: 'failed' });
  const neg = await mkLead(id, 'notpending');
  const r = await postHarvested({ negotiation_id: neg, email: `np-${SUF}@example.test` }, { agentSecret: SECRET });
  assert.equal(r.status, 409);
  assert.equal(r.body.status, 'not_pending');
  const c = await pool.query('SELECT email, email_harvest_status FROM clients WHERE id = $1', [id]);
  assert.equal(c.rows[0].email, null);
  assert.equal(c.rows[0].email_harvest_status, 'failed');
});

test('lead_not_found: unknown negotiation_id → 404', async () => {
  const r = await postHarvested({ negotiation_id: `${SUF}-nope`, email: `x-${SUF}@example.test` }, { agentSecret: SECRET });
  assert.equal(r.status, 404);
  assert.equal(r.body.status, 'lead_not_found');
});

test('wrong-address: pro-domain and active-staff addresses are rejected (400)', async () => {
  const id = await mkClient({ status: 'pending' });
  const neg = await mkLead(id, 'wrong');

  const proDomain = await postHarvested({ negotiation_id: neg, email: `someone@${PRO_DOMAIN}` }, { agentSecret: SECRET });
  assert.equal(proDomain.status, 400, 'pro-domain email must be rejected');

  // An ACTIVE staff member's personal address must be rejected too.
  const staffEmail = `${SUF}-staff@personal.test`;
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','approved') RETURNING id`,
    [staffEmail]
  );
  userIds.push(s.rows[0].id);
  const staff = await postHarvested({ negotiation_id: neg, email: staffEmail }, { agentSecret: SECRET });
  assert.equal(staff.status, 400, 'an active staff address must be rejected');

  const c = await pool.query('SELECT email FROM clients WHERE id = $1', [id]);
  assert.equal(c.rows[0].email, null, 'no wrong address was stamped');
});

test('collision (agent): a duplicate email marks THIS client failed, no merge, no stamp', async () => {
  const collideEmail = `collide-${SUF}@example.test`;
  const owner = await mkClient({ status: 'not_needed', email: collideEmail });
  const victim = await mkClient({ status: 'pending' });
  const neg = await mkLead(victim, 'colA');
  const r = await postHarvested({ negotiation_id: neg, email: collideEmail }, { agentSecret: SECRET });
  assert.equal(r.status, 409);
  assert.equal(r.body.status, 'collision');
  const v = await pool.query('SELECT email, email_harvest_status FROM clients WHERE id = $1', [victim]);
  assert.equal(v.rows[0].email, null, 'no email stamped on the victim');
  assert.equal(v.rows[0].email_harvest_status, 'failed', 'agent collision marks the victim failed');
  const o = await pool.query('SELECT email FROM clients WHERE id = $1', [owner]);
  assert.equal(o.rows[0].email, collideEmail, 'the original owner is untouched (no merge)');
});

test('collision (admin): a duplicate email is recoverable — NOT failed, NOT stamped', async () => {
  const collideEmail = `collide-admin-${SUF}@example.test`;
  await mkClient({ status: 'not_needed', email: collideEmail }); // owner
  const victim = await mkClient({ status: 'pending' });
  const neg = await mkLead(victim, 'colB');
  const r = await postHarvested({ negotiation_id: neg, email: collideEmail }, { token: adminToken });
  assert.equal(r.status, 409);
  assert.equal(r.body.status, 'collision');
  const v = await pool.query('SELECT email, email_harvest_status FROM clients WHERE id = $1', [victim]);
  assert.equal(v.rows[0].email, null, 'no email stamped');
  assert.equal(v.rows[0].email_harvest_status, 'pending', 'admin collision stays pending (recoverable), NOT failed');
});

test('admin override: admin sets an email on a failed client and an audit row is written', async () => {
  const id = await mkClient({ status: 'failed' });
  const neg = await mkLead(id, 'override');
  const email = `override-${SUF}@example.test`;
  const r = await postHarvested({ negotiation_id: neg, email }, { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'set');
  const c = await pool.query('SELECT email, email_harvest_status FROM clients WHERE id = $1', [id]);
  assert.equal(c.rows[0].email, email);
  assert.equal(c.rows[0].email_harvest_status, 'harvested');
  const audited = await waitFor(async () => {
    const a = await pool.query(
      "SELECT 1 FROM admin_audit_log WHERE actor_user_id = $1 AND action = 'thumbtack_email_harvested' AND metadata->>'negotiation_id' = $2",
      [adminId, neg]
    );
    return a.rows.length > 0;
  });
  assert.ok(audited, 'an admin override audit row should be written');
});

test('drip re-arm: future suppressed client_no_email touches flip to pending; past + other reasons stay', async () => {
  const id = await mkClient({ status: 'pending' });
  const neg = await mkLead(id, 'rearm');
  const proposalId = await mkProposal(id);
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  const sm1 = await mkSched(proposalId, id, { scheduledFor: future, errorMessage: 'client_no_email' }); // should flip
  const sm2 = await mkSched(proposalId, id, { scheduledFor: past, errorMessage: 'client_no_email' });   // past, stays
  const sm3 = await mkSched(proposalId, id, { scheduledFor: future, errorMessage: 'some_other' });       // other reason, stays

  const r = await postHarvested({ negotiation_id: neg, email: `rearm-${SUF}@example.test` }, { agentSecret: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'set');

  const flipped = await waitFor(async () => {
    const s = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [sm1]);
    return s.rows[0].status === 'pending';
  });
  assert.ok(flipped, 'the future client_no_email touch should be re-armed to pending');
  const s2 = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [sm2]);
  const s3 = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [sm3]);
  assert.equal(s2.rows[0].status, 'suppressed', 'a past-window touch is NOT resurrected');
  assert.equal(s3.rows[0].status, 'suppressed', 'a non-client_no_email suppression is left alone');
});
