// Tests GET /api/admin/thumbtack/pending-harvest (the work queue). Proves the filter
// (pending + email-null + past-cooldown + has a non-terminal lead), the terminal-only
// exclusion, the atomic lease (attempted_at stamped, attempts untouched), and the
// kill-switch. Mounts the REAL agent router against scratch dev-DB rows. Run ALONE.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const agentRouter = require('./thumbtackAgent');

if (process.env.NODE_ENV === 'production') {
  throw new Error('thumbtackAgent.queue.test.js refuses to run against production');
}

const SECRET = `queue-secret-${Date.now()}-abcdefghijklmnop`;
const ORIG_SECRET = process.env.THUMBTACK_AGENT_SECRET;
const SUF = `q${Date.now()}`;
let server, baseUrl, clientA;
const clientIds = [];
const negs = {}; // label -> negotiation_id

async function mkClient({ status, email = null, attemptedAt = null }) {
  const r = await pool.query(
    `INSERT INTO clients (name, phone, email, source, email_harvest_status, email_harvest_attempted_at, email_harvest_attempts)
     VALUES ($1,$2,$3,'thumbtack',$4,$5,0) RETURNING id`,
    [`Queue ${SUF} ${status}`, `+1555${String(Date.now()).slice(-7)}`, email, status, attemptedAt]
  );
  clientIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function mkLead(clientId, label, status) {
  const neg = `${SUF}-${label}`;
  negs[label] = neg;
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_name, status, raw_payload)
     VALUES ($1,$2,$3,$4,'{}'::jsonb)`,
    [neg, clientId, `Queue ${SUF} ${label}`, status]
  );
  return neg;
}

function getPending(limit) {
  return new Promise((resolve, reject) => {
    const path = `/api/admin/thumbtack/pending-harvest${limit ? `?limit=${limit}` : ''}`;
    const url = new URL(baseUrl + path);
    const r = http.request(
      { method: 'GET', hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'x-thumbtack-agent-secret': SECRET } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  process.env.THUMBTACK_AGENT_SECRET = SECRET;
  delete process.env.HARVESTER_ENABLED; // default-on for the main test

  clientA = await mkClient({ status: 'pending' });               await mkLead(clientA, 'A', 'new');   // eligible
  const b = await mkClient({ status: 'pending', attemptedAt: new Date().toISOString() }); await mkLead(b, 'B', 'new'); // cooldown
  const c = await mkClient({ status: 'pending', email: `queue-${SUF}@example.test` });     await mkLead(c, 'C', 'new'); // has email
  const d = await mkClient({ status: 'not_needed' });            await mkLead(d, 'D', 'new');   // wrong status
  const e = await mkClient({ status: 'pending' });               await mkLead(e, 'E', 'lost');  // terminal-only

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
  delete process.env.HARVESTER_ENABLED;
  if (server) await new Promise((r) => server.close(r));
  for (const neg of Object.values(negs)) await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('kill-switch: HARVESTER_ENABLED=false returns [] without querying', async () => {
  process.env.HARVESTER_ENABLED = 'false';
  try {
    const r = await getPending();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  } finally {
    delete process.env.HARVESTER_ENABLED;
  }
});

test('pending-harvest: returns the eligible lead, excludes the rest, and leases it', async () => {
  const r = await getPending(100);
  assert.equal(r.status, 200);
  const returned = new Set(r.body.map((x) => x.negotiation_id));
  assert.ok(returned.has(negs.A), 'eligible pending email-null lead must appear');
  assert.ok(!returned.has(negs.B), 'cooldown (recent attempted_at) must be excluded');
  assert.ok(!returned.has(negs.C), 'client with an email must be excluded');
  assert.ok(!returned.has(negs.D), 'not_needed status must be excluded');
  assert.ok(!returned.has(negs.E), 'terminal-only (lost) lead must be excluded');

  // Lease: A's attempted_at is now stamped; the failure counter is untouched.
  const a = await pool.query('SELECT email_harvest_attempted_at, email_harvest_attempts FROM clients WHERE id = $1', [clientA]);
  assert.ok(a.rows[0].email_harvest_attempted_at, 'A should be leased (attempted_at stamped)');
  assert.equal(a.rows[0].email_harvest_attempts, 0, 'the lease must NOT bump the failure counter');
});
