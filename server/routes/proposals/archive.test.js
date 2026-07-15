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
const shiftIds = [];
const smIds = [];
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

async function makeBartender() {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', 'staff', 0) RETURNING id`,
    [`archivetest-bt+${NONCE}-${userIds.length}@example.test`]);
  userIds.push(u.id);
  return u.id;
}

async function makeShift(proposalId, { status = 'open' } = {}) {
  const { rows: [s] } = await pool.query(
    `INSERT INTO shifts (proposal_id, event_date, status)
     VALUES ($1, CURRENT_DATE + 7, $2) RETURNING id`,
    [proposalId, status]);
  shiftIds.push(s.id);
  return s.id;
}

async function makeShiftRequest(shiftId, userId, { position = 'bartender', status = 'approved' } = {}) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, $3, $4)`,
    [shiftId, userId, position, status]);
}

async function makeScheduledMessage({ entityType, entityId, messageType, recipientType, recipientId = null, channel = 'email' }) {
  const { rows: [m] } = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '5 days', 'pending') RETURNING id`,
    [entityId, entityType, messageType, recipientType, recipientId, channel]);
  smIds.push(m.id);
  return m.id;
}

function post(path, token) {
  const payload = JSON.stringify({});
  return reqBody('POST', path, token, payload);
}

function postBody(path, token, payload) {
  return reqBody('POST', path, token, payload);
}

function patchBody(path, token, payload) {
  return reqBody('PATCH', path, token, payload);
}

function reqBody(method, path, token, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = Buffer.from(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': buf.length };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.write(buf); r.end();
  });
}

const statusOf = async (id) => (await pool.query('SELECT status FROM proposals WHERE id = $1', [id])).rows[0].status;
const reasonOf = async (id) => (await pool.query('SELECT archive_reason FROM proposals WHERE id = $1', [id])).rows[0].archive_reason;

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
  if (smIds.length) await pool.query('DELETE FROM scheduled_messages WHERE id = ANY($1::int[])', [smIds]);
  if (shiftIds.length) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [shiftIds]);
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [shiftIds]);
  }
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

// ── B1: archive reaps a demoted (fully-refunded) booking ──────────────────
test('archive reaps a demoted booking: cancels shift, denies request, suppresses shift comms, deletes proposal comms (B1)', async () => {
  const clientId = await makeClient();
  // Post-full-refund demoted state: a booked proposal refunded to $0 lands in
  // 'accepted' with amount_paid 0 (proposalStatus.js) — an ARCHIVABLE status.
  const pid = await makeProposal(clientId, { status: 'accepted', amount_paid: 0 });
  const bartenderId = await makeBartender();
  const shiftId = await makeShift(pid, { status: 'open' });
  await makeShiftRequest(shiftId, bartenderId, { position: 'bartender', status: 'approved' });
  const propSm = await makeScheduledMessage({ entityType: 'proposal', entityId: pid, messageType: 'balance_due_today', recipientType: 'client', recipientId: clientId });
  const shiftSm = await makeScheduledMessage({ entityType: 'shift', entityId: shiftId, messageType: 'shift_reminder', recipientType: 'staff', recipientId: bartenderId });
  const invId = await makeInvoice(pid); // 'sent', amount_paid 0

  const r = await postBody(`/api/proposals/${pid}/archive`, adminToken, JSON.stringify({ scope: 'one', archive_reason: 'client_cancelled' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // (a) shift soft-cancelled [RED at HEAD: stays 'open']
  assert.equal((await pool.query('SELECT status FROM shifts WHERE id = $1', [shiftId])).rows[0].status, 'cancelled', 'shift soft-cancelled');
  // (b) approved request denied [RED at HEAD]
  assert.equal((await pool.query('SELECT status FROM shift_requests WHERE shift_id = $1', [shiftId])).rows[0].status, 'denied', 'approved request denied');
  // (c) shift-level pending comm suppressed [RED at HEAD]
  assert.equal((await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [shiftSm])).rows[0].status, 'suppressed', 'shift-level pending comm suppressed');
  // (d) proposal-level pending comm deleted [RED at HEAD]
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE id = $1', [propSm])).rows[0].n, 0, 'proposal-level pending comm deleted');
  // (e) pins that stay green today: proposal archived + unpaid invoice voided
  assert.equal(await statusOf(pid), 'archived', 'proposal archived');
  assert.equal((await pool.query('SELECT status FROM invoices WHERE id = $1', [invId])).rows[0].status, 'void', 'unpaid invoice voided');
});

test('archive of a shiftless proposal reaps nothing and still archives (scope set no-op) (B1)', async () => {
  const clientId = await makeClient();
  const target = await makeProposal(clientId, { status: 'sent' });
  const sibling = await makeProposal(clientId, { status: 'viewed' });
  const r = await postBody(`/api/proposals/${target}/archive`, adminToken, JSON.stringify({ scope: 'set', archive_reason: 'no_hire' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await statusOf(target), 'archived');
  assert.equal(await statusOf(sibling), 'archived');
});

// ── B2: archive_reason picker ─────────────────────────────────────────────
test("archive persists the admin-picked archive_reason (B2)", async () => {
  const clientId = await makeClient();
  const target = await makeProposal(clientId, { status: 'sent' });
  const r = await postBody(`/api/proposals/${target}/archive`, adminToken, JSON.stringify({ scope: 'one', archive_reason: 'no_hire' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await reasonOf(target), 'no_hire'); // RED at HEAD: column left NULL
});

test("archive defaults archive_reason to 'no_hire', never NULL (B2)", async () => {
  const clientId = await makeClient();
  const target = await makeProposal(clientId, { status: 'sent' });
  const r = await postBody(`/api/proposals/${target}/archive`, adminToken, JSON.stringify({ scope: 'one' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await reasonOf(target), 'no_hire'); // RED at HEAD: NULL
});

test('archive rejects a semantically-invalid reason (auto-sweep-only marker + garbage) with 400 (B2)', async () => {
  const clientId = await makeClient();
  const target = await makeProposal(clientId, { status: 'sent' });
  // 'option_not_chosen' is a DB-CHECK value but excluded from the manual route
  // allowlist (it is the payment-settle auto-sweep marker).
  const r = await postBody(`/api/proposals/${target}/archive`, adminToken, JSON.stringify({ scope: 'one', archive_reason: 'option_not_chosen' }));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'VALIDATION_ERROR');
  assert.equal(await statusOf(target), 'sent', 'not archived on a rejected reason'); // RED at HEAD: archives to 'archived'
  assert.equal(await reasonOf(target), null, 'reason stays NULL when rejected');
  const r2 = await postBody(`/api/proposals/${target}/archive`, adminToken, JSON.stringify({ scope: 'one', archive_reason: 'garbage' }));
  assert.equal(r2.status, 400, JSON.stringify(r2.body));
  assert.equal(await statusOf(target), 'sent');
});

test("scope 'set' propagates the SAME admin reason across the set, never 'option_not_chosen' (B2)", async () => {
  const clientId = await makeClient();
  const target = await makeProposal(clientId, { status: 'viewed' });
  const openSibling = await makeProposal(clientId, { status: 'sent' });
  const paidSibling = await makeProposal(clientId, { status: 'deposit_paid', amount_paid: 100 });
  const r = await postBody(`/api/proposals/${target}/archive`, adminToken, JSON.stringify({ scope: 'set', archive_reason: 'client_cancelled' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await reasonOf(target), 'client_cancelled');
  assert.equal(await reasonOf(openSibling), 'client_cancelled');
  assert.equal(await statusOf(paidSibling), 'deposit_paid', 'paid sibling untouched');
  assert.equal(await reasonOf(paidSibling), null, 'paid sibling reason untouched');
});

// ── B5 delta: archived -> draft restore clears the cancel snapshot ────────
test('archived -> draft restore clears cancelled_at/by/note/archive_reason (B5 delta)', async () => {
  const clientId = await makeClient();
  const pid = await makeProposal(clientId, { status: 'sent' });
  await pool.query(
    `UPDATE proposals SET status = 'archived', archive_reason = 'client_cancelled',
        cancelled_at = NOW(), cancelled_by = 'client', cancellation_note = 'client asked to cancel'
      WHERE id = $1`, [pid]);
  const r = await patchBody(`/api/proposals/${pid}/status`, adminToken, JSON.stringify({ status: 'draft' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await pool.query(
    'SELECT status, cancelled_at, cancelled_by, cancellation_note, archive_reason FROM proposals WHERE id = $1', [pid])).rows[0];
  assert.equal(row.status, 'draft');
  assert.equal(row.cancelled_at, null, 'cancelled_at cleared'); // RED at HEAD: stays set
  assert.equal(row.cancelled_by, null, 'cancelled_by cleared');
  assert.equal(row.cancellation_note, null, 'cancellation_note cleared');
  assert.equal(row.archive_reason, null, 'archive_reason cleared');
});
