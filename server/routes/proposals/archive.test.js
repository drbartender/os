require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// POST /api/proposals/:id/archive — admin archive with scope 'one' | 'set'.
// 'one' archives only the target; 'set' also archives the client's other open,
// unpaid proposals (loose alternatives / formal group members alike). Unpaid
// invoices are voided; paid/converted proposals are never touched (409 on the
// target, silently excluded as siblings).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const proposalsRouter = require('./index');

if (process.env.NODE_ENV === 'production') throw new Error('archive.test.js refuses to run against production');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, staffToken;
const userIds = [];
const clientIds = [];
const proposalIds = [];
const invoiceIds = [];
let invSeq = 0;

async function makeUser(role) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', $2, 0) RETURNING id, token_version`,
    [`archivetest-${role}+${NONCE}-${userIds.length}@example.test`, role]);
  userIds.push(u.id);
  return jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function makeClient() {
  const { rows: [c] } = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Archive Test', $1) RETURNING id`,
    [`arch-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.id);
  return c.id;
}

async function makeProposal(clientId, { status = 'sent', amount_paid = 0 } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO proposals (client_id, status, amount_paid, pricing_snapshot, total_price)
     VALUES ($1, $2, $3, '{}'::jsonb, 500) RETURNING id`,
    [clientId, status, amount_paid]);
  proposalIds.push(p.id);
  return p.id;
}

async function makeInvoice(proposalId) {
  invSeq += 1;
  const { rows: [i] } = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, amount_due, amount_paid, status)
     VALUES ($1, $2, 10000, 0, 'sent') RETURNING id`,
    [proposalId, `TAR${crypto.randomBytes(5).toString('hex')}`]); // invoice_number is VARCHAR(20)
  invoiceIds.push(i.id);
  return i.id;
}

function post(path, token) {
  const payload = JSON.stringify({});
  return postBody(path, token, payload);
}

function postBody(path, token, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = Buffer.from(payload);
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

const statusOf = async (id) => (await pool.query('SELECT status FROM proposals WHERE id = $1', [id])).rows[0].status;

before(async () => {
  adminToken = await makeUser('admin');
  staffToken = await makeUser('staff');
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
  if (invoiceIds.length) await pool.query('DELETE FROM invoices WHERE id = ANY($1::int[])', [invoiceIds]);
  if (proposalIds.length) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  await pool.end();
});

test("scope 'one' archives only the target and voids its unpaid invoice", async () => {
  const clientId = await makeClient();
  const target = await makeProposal(clientId, { status: 'sent' });
  const sibling = await makeProposal(clientId, { status: 'draft' });
  const invId = await makeInvoice(target);

  const r = await postBody(`/api/proposals/${target}/archive`, adminToken, JSON.stringify({ scope: 'one' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.archived_ids, [target]);
  assert.equal(await statusOf(target), 'archived');
  assert.equal(await statusOf(sibling), 'draft', "scope 'one' leaves the sibling alone");
  const { rows: [inv] } = await pool.query('SELECT status FROM invoices WHERE id = $1', [invId]);
  assert.equal(inv.status, 'void', "target's unpaid invoice is voided");
});

test("scope 'set' archives the client's open set but never a paid sibling", async () => {
  const clientId = await makeClient();
  const target = await makeProposal(clientId, { status: 'viewed' });
  const openSibling = await makeProposal(clientId, { status: 'sent' });
  const paidSibling = await makeProposal(clientId, { status: 'deposit_paid', amount_paid: 100 });

  const r = await postBody(`/api/proposals/${target}/archive`, adminToken, JSON.stringify({ scope: 'set' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([...r.body.archived_ids].sort((a, b) => a - b), [target, openSibling].sort((a, b) => a - b));
  assert.equal(await statusOf(target), 'archived');
  assert.equal(await statusOf(openSibling), 'archived');
  assert.equal(await statusOf(paidSibling), 'deposit_paid', 'a paid sibling is never archived');
});

test('a paid target is refused (409 NOT_ARCHIVABLE)', async () => {
  const clientId = await makeClient();
  const paid = await makeProposal(clientId, { status: 'deposit_paid', amount_paid: 100 });
  const r = await post(`/api/proposals/${paid}/archive`, adminToken);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'NOT_ARCHIVABLE');
  assert.equal(await statusOf(paid), 'deposit_paid');
});

test('requires an admin/manager (401 anonymous, 403 staff)', async () => {
  const clientId = await makeClient();
  const p = await makeProposal(clientId, { status: 'sent' });
  const anon = await post(`/api/proposals/${p}/archive`, null);
  assert.ok(anon.status === 401 || anon.status === 403, `anonymous blocked, got ${anon.status}`);
  const staff = await post(`/api/proposals/${p}/archive`, staffToken);
  assert.equal(staff.status, 403, `staff role blocked, got ${staff.status}`);
  assert.equal(await statusOf(p), 'sent');
});
