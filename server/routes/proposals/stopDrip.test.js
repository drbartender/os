require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// POST /api/proposals/:id/stop-drip — admin "Stop follow-ups". One-way. Kills the
// in-flight unsigned-proposal drip for the EVENT (every open proposal of the
// client with the same event_date, since a second option joins the first one's
// drip), stamps drip_stopped_at on each, logs once on the target. Everything
// that is not a drip touch is untouched; a different event's drip is untouched.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const proposalsRouter = require('./index');

if (process.env.NODE_ENV === 'production') throw new Error('stopDrip.test.js refuses to run against production');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, staffToken, adminUserId;
const userIds = [];
const clientIds = [];
const proposalIds = [];

async function makeUser(role) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', $2, 0) RETURNING id, token_version`,
    [`stopdrip-${role}+${NONCE}-${userIds.length}@example.test`, role]);
  userIds.push(u.id);
  return { id: u.id, token: jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

async function makeClient() {
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Stop Drip Test', $1, '5550001111') RETURNING id`,
    [`stopdrip-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.id);
  return c.id;
}

async function makeProposal(clientId, { status = 'sent', eventDateSql = "CURRENT_DATE + 40" } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, pricing_snapshot, total_price)
     VALUES ($1, $2, ${eventDateSql}, 'birthday-party', '{}'::jsonb, 500) RETURNING id`,
    [clientId, status]);
  proposalIds.push(p.id);
  return p.id;
}

async function addRow(proposalId, clientId, messageType, { channel = 'sms', status = 'pending' } = {}) {
  const { rows: [m] } = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, sent_at)
     VALUES ($1, 'proposal', $2, 'client', $3, $4, NOW() + INTERVAL '5 days', $5,
             CASE WHEN $5 = 'sent' THEN NOW() ELSE NULL END) RETURNING id`,
    [proposalId, messageType, clientId, channel, status]);
  return m.id;
}

async function rowsOf(proposalId) {
  const { rows } = await pool.query(
    `SELECT message_type, status, error_message FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 ORDER BY message_type`, [proposalId]);
  return rows;
}
async function stoppedAt(proposalId) {
  return (await pool.query('SELECT drip_stopped_at FROM proposals WHERE id = $1', [proposalId])).rows[0].drip_stopped_at;
}

function post(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = Buffer.from('{}');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': buf.length };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.write(buf); r.end();
  });
}

before(async () => {
  const admin = await makeUser('admin');
  adminToken = admin.token; adminUserId = admin.id;
  staffToken = (await makeUser('staff')).token;
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', proposalsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode || 400).json({ error: err.message, code: err.code });
    console.error(err); return res.status(500).json({ error: 'server error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', proposalIds]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  await pool.end();
});

test('stop-drip > 401 without a token, 403 for staff', async () => {
  const clientId = await makeClient();
  const pid = await makeProposal(clientId);
  assert.equal((await post(`/api/proposals/${pid}/stop-drip`, null)).status, 401);
  assert.equal((await post(`/api/proposals/${pid}/stop-drip`, staffToken)).status, 403);
});

test('stop-drip > 404 for an unknown proposal', async () => {
  const r = await post('/api/proposals/999999999/stop-drip', adminToken);
  assert.equal(r.status, 404);
});

test('stop-drip > kills the in-flight drip for the whole event, leaves everything else alone, logs once', async () => {
  const clientId = await makeClient();
  // A owns the drip: touch 1 delivered, touch 2 parked by the cooldown, rest pending.
  const a = await makeProposal(clientId);
  await addRow(a, clientId, 'drip_touch_1', { status: 'sent' });
  await addRow(a, clientId, 'drip_touch_2', { channel: 'email', status: 'deferred' });
  await addRow(a, clientId, 'drip_touch_3');
  await addRow(a, clientId, 'drip_touch_4', { channel: 'email' });
  await addRow(a, clientId, 'drip_touch_5_email', { channel: 'email' });
  await addRow(a, clientId, 'drip_touch_5_sms');
  // A also has an operational touch that must survive.
  await addRow(a, clientId, 'event_eve', { channel: 'sms' });
  // B: second option for the SAME event, joined A's drip (no rows of its own).
  const b = await makeProposal(clientId, { status: 'viewed' });
  // C: a different event for the same client, with its own live drip.
  const c = await makeProposal(clientId, { eventDateSql: 'CURRENT_DATE + 90' });
  await addRow(c, clientId, 'drip_touch_1');

  const r = await post(`/api/proposals/${b}/stop-drip`, adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.suppressed, 5);
  assert.deepEqual([...r.body.proposal_ids].sort((x, y) => x - y), [a, b]);

  const aRows = await rowsOf(a);
  const byType = Object.fromEntries(aRows.map((x) => [x.message_type, x]));
  assert.equal(byType.drip_touch_1.status, 'sent', 'delivered history untouched');
  for (const t of ['drip_touch_2', 'drip_touch_3', 'drip_touch_4', 'drip_touch_5_email', 'drip_touch_5_sms']) {
    assert.equal(byType[t].status, 'suppressed', t);
    assert.equal(byType[t].error_message, 'stopped by admin', t);
  }
  assert.equal(byType.event_eve.status, 'pending', 'operational touch untouched');
  assert.equal((await rowsOf(c))[0].status, 'pending', 'a different event\'s drip untouched');

  assert.ok(await stoppedAt(a), 'owner stamped');
  assert.ok(await stoppedAt(b), 'target stamped');
  assert.equal(await stoppedAt(c), null, 'other event not stamped');

  const { rows: log } = await pool.query(
    `SELECT proposal_id, actor_type, actor_id, details FROM proposal_activity_log
      WHERE proposal_id = ANY($1::int[]) AND action = 'drip_stopped'`, [[a, b, c]]);
  assert.equal(log.length, 1, 'one log entry, on the target');
  assert.equal(log[0].proposal_id, b);
  assert.equal(log[0].actor_type, 'admin');
  assert.equal(log[0].actor_id, adminUserId);
  assert.equal(log[0].details.suppressed, 5);
  assert.deepEqual([...log[0].details.proposal_ids].sort((x, y) => x - y), [a, b]);
});

test('stop-drip > second click: already_stopped, first stamp kept, no second log entry when nothing was left to kill', async () => {
  const clientId = await makeClient();
  const a = await makeProposal(clientId);
  await addRow(a, clientId, 'drip_touch_2', { channel: 'email' });
  const first = await post(`/api/proposals/${a}/stop-drip`, adminToken);
  assert.equal(first.status, 200);
  assert.equal(first.body.suppressed, 1);
  assert.equal(first.body.already_stopped, false);
  const stamp = await stoppedAt(a);
  const second = await post(`/api/proposals/${a}/stop-drip`, adminToken);
  assert.equal(second.status, 200);
  assert.equal(second.body.suppressed, 0);
  assert.equal(second.body.already_stopped, true);
  assert.equal(new Date(await stoppedAt(a)).getTime(), new Date(stamp).getTime());
  const { rows: log } = await pool.query(
    `SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'drip_stopped'`, [a]);
  assert.equal(log.length, 1);
});

test('stop-drip > a repeat click still kills a stray in-flight touch on a stamped proposal (and logs that)', async () => {
  // Review finding: the old already_stopped branch rolled back before the
  // suppress, so a stamped proposal with a live row was unkillable from the UI.
  const clientId = await makeClient();
  const a = await makeProposal(clientId);
  await pool.query('UPDATE proposals SET drip_stopped_at = NOW() - INTERVAL \'1 day\' WHERE id = $1', [a]);
  await addRow(a, clientId, 'drip_touch_3');
  const r = await post(`/api/proposals/${a}/stop-drip`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.already_stopped, true);
  assert.equal(r.body.suppressed, 1);
  assert.equal((await rowsOf(a))[0].status, 'suppressed');
  const { rows: log } = await pool.query(
    `SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'drip_stopped'`, [a]);
  assert.equal(log.length, 1);
  assert.equal(log[0].details.suppressed, 1);
});

test('stop-drip > only OPEN siblings join the stop: a draft alternative and a booked sibling are left alone', async () => {
  const clientId = await makeClient();
  const a = await makeProposal(clientId);
  await addRow(a, clientId, 'drip_touch_2', { channel: 'email' });
  const draft = await makeProposal(clientId, { status: 'draft' });
  const booked = await makeProposal(clientId, { status: 'deposit_paid' });
  const r = await post(`/api/proposals/${a}/stop-drip`, adminToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.proposal_ids, [a]);
  assert.equal(await stoppedAt(draft), null, 'a draft is not in the conversation yet; sent later it starts fresh');
  assert.equal(await stoppedAt(booked), null, 'a booked sibling has no drip to stop');
});

test('stop-drip > 409 when the target is not an open unsigned proposal', async () => {
  const clientId = await makeClient();
  const draft = await makeProposal(clientId, { status: 'draft' });
  const r = await post(`/api/proposals/${draft}/stop-drip`, adminToken);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'DRIP_NOT_ACTIVE');
  assert.equal(await stoppedAt(draft), null);
});

test('stop-drip > a proposal with no event date only stops its own drip', async () => {
  const clientId = await makeClient();
  const a = await makeProposal(clientId, { eventDateSql: 'NULL' });
  await addRow(a, clientId, 'drip_touch_2', { channel: 'email' });
  const other = await makeProposal(clientId, { eventDateSql: 'NULL' });
  await addRow(other, clientId, 'drip_touch_2', { channel: 'email' });
  const r = await post(`/api/proposals/${a}/stop-drip`, adminToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.proposal_ids, [a]);
  assert.equal((await rowsOf(other))[0].status, 'pending');
  assert.equal(await stoppedAt(other), null);
});
