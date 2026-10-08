'use strict';

// The three client notices that passed no meta (Inbox spec 2026-10-06,
// sections 2 and 9): the cancel confirmation, the change-request decision
// (decline and approve) and the staffing-driven gratuity disclosure. Each must
// ledger its own message_type, the proposal it is about, the client, and the
// admin who clicked. Every fixture client also owns a NEWER decoy proposal, so
// a row that falls back to messageLog.js's "client's newest proposal" lands on
// the decoy and fails.
//
// sendEmail is replaced BEFORE any router loads (they destructure it at
// require time; cancel.test.js installs getStripe the same way) by a stand-in
// that writes the same ledger row sendEmail writes when Resend accepts a send
// (email.js:95), awaited so the row exists when the response returns. Nothing
// leaves the box. Runs ALONE against the shared dev DB:
//   node --test server/routes/proposals/noticeAttribution.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const emailModule = require('../../utils/email');
const { buildEmailLogEntry, logClientMessage } = require('../../utils/messageLog');

let providerSeq = 0;
emailModule.sendEmail = async ({ to, subject, meta }) => {
  providerSeq += 1;
  const result = { id: `lane-b-na-${Date.now()}-${providerSeq}` };
  await logClientMessage(buildEmailLogEntry({ to, subject, meta, result }));
  return result;
};
// This box talks to LIVE Stripe by design. None of these routes needs it; null
// is the "payments not configured" answer every caller already handles.
require('../../utils/stripeClient').getStripe = () => null;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const proposalsRouter = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('noticeAttribution.test.js refuses to run against production');
}

const TAG = 'lane-b-na';
const RUN = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server;
let baseUrl;
let seq = 0;
let hostedPkgId;

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// A fresh admin per request: the cancel route sits behind adminWriteLimiter
// (10 a minute per user). The id is what the ledger row must carry.
async function mintAdmin() {
  seq += 1;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`,
    [`${TAG}-admin-${RUN}-${seq}@example.test`]
  );
  return {
    id: u.rows[0].id,
    token: jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET),
  };
}

// A client plus a NEWER decoy proposal: the old "newest proposal" fallback
// would attach an untyped notice to the decoy.
async function seedClient(lastName) {
  seq += 1;
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`${TAG} Pat ${lastName}`, `${TAG}-${RUN}-${seq}@example.test`]
  );
  await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, created_at)
     VALUES ($1, 'sent', '2099-12-01', 500, NOW() + INTERVAL '1 day')`,
    [c.rows[0].id]
  );
  return c.rows[0].id;
}

async function ledgerFor(clientId) {
  const { rows } = await pool.query(
    `SELECT proposal_id, client_id, channel, message_type, sent_by
       FROM message_log WHERE client_id = $1 ORDER BY id`,
    [clientId]
  );
  return rows;
}

async function purge() {
  const { rows } = await pool.query(
    'SELECT p.id FROM proposals p JOIN clients c ON c.id = p.client_id WHERE c.name LIKE $1',
    [`${TAG} %`]
  );
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await pool.query(
      'DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query(
      'DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1::int[])", [ids]);
    await pool.query(
      'DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM message_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query('DELETE FROM clients WHERE name LIKE $1', [`${TAG} %`]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${TAG}-admin-%`]);
}

before(async () => {
  await purge();
  const pkg = await pool.query(
    `SELECT id FROM service_packages
      WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class'
      ORDER BY id LIMIT 1`
  );
  assert.ok(pkg.rows[0], 'need an active hosted (per_guest) package in the dev DB');
  hostedPkgId = pkg.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', proposalsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    console.error('noticeAttribution harness 500:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await purge();
  await pool.end();
});

test('cancel confirmation: its own type, the cancelled proposal (not the newest), the client and the admin', async () => {
  const clientId = await seedClient('Quill');
  const t = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, event_date, event_timezone, total_price, amount_paid, created_at)
     VALUES ($1, 'deposit_paid', 'wedding', '2099-09-09', 'America/Chicago', 1000, 0, NOW() - INTERVAL '2 days')
     RETURNING id`,
    [clientId]
  );
  const admin = await mintAdmin();
  const res = await request('POST', `/api/proposals/${t.rows[0].id}/cancel`, admin.token,
    { mode: 'client', confirm_last_name: 'Quill', suppress_staff_notifications: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await ledgerFor(clientId), [{
    proposal_id: t.rows[0].id, client_id: clientId, channel: 'email',
    message_type: 'cancel_confirmation', sent_by: admin.id,
  }]);
});

test('change-request decline: change_request_decision on the requested proposal, with the deciding admin', async () => {
  const clientId = await seedClient('Rowan');
  const t = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, created_at)
     VALUES ($1, 'deposit_paid', '2099-09-09', 4800, 1000, NOW() - INTERVAL '2 days') RETURNING id`,
    [clientId]
  );
  const cr = await pool.query(
    `INSERT INTO proposal_change_requests (proposal_id, client_id, status, edit_window)
     VALUES ($1, $2, 'pending', 'before_t14') RETURNING id`,
    [t.rows[0].id, clientId]
  );
  const admin = await mintAdmin();
  const res = await request('POST', `/api/proposals/change-requests/${cr.rows[0].id}/decline`, admin.token,
    { decision_note: 'That date is already booked.' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await ledgerFor(clientId), [{
    proposal_id: t.rows[0].id, client_id: clientId, channel: 'email',
    message_type: 'change_request_decision', sent_by: admin.id,
  }]);
});

test('change-request approve (PATCH with change_request_id): the same type, proposal and admin', async () => {
  const clientId = await seedClient('Sage');
  const t = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars,
                            total_price, amount_paid, event_date, pricing_snapshot, created_at)
     VALUES ($1, 'deposit_paid', $2, 100, 4, 1, 4800, 1000, '2099-09-09', '{}', NOW() - INTERVAL '2 days')
     RETURNING id`,
    [clientId, hostedPkgId]
  );
  const cr = await pool.query(
    `INSERT INTO proposal_change_requests (proposal_id, client_id, status, edit_window)
     VALUES ($1, $2, 'pending', 'before_t14') RETURNING id`,
    [t.rows[0].id, clientId]
  );
  const admin = await mintAdmin();
  const res = await request('PATCH', `/api/proposals/${t.rows[0].id}`, admin.token,
    { guest_count: 120, change_request_id: cr.rows[0].id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const crRow = await pool.query('SELECT status FROM proposal_change_requests WHERE id = $1', [cr.rows[0].id]);
  assert.equal(crRow.rows[0].status, 'approved', 'fixture must take the approve path');
  assert.deepEqual(await ledgerFor(clientId), [{
    proposal_id: t.rows[0].id, client_id: clientId, channel: 'email',
    message_type: 'change_request_decision', sent_by: admin.id,
  }]);
});

test('gratuity disclosure on a staffing change: gratuity_disclosure on the edited proposal, with the editing admin', async () => {
  const clientId = await seedClient('Tamsin');
  // crud.test.js Case 22's fixture: a paid hosted proposal with a stored rate
  // and no gratuity in its snapshot, so the re-price raises the gratuity total
  // and the PATCH owes the client the disclosure.
  const t = await pool.query(
    `INSERT INTO proposals (client_id, package_id, guest_count, event_duration_hours, num_bars,
                            pricing_snapshot, total_price, payment_type, status, amount_paid,
                            gratuity_rate, tip_jar, event_type, created_at)
     VALUES ($1, $2, 120, 4, 1, $3, 2000, 'full', 'deposit_paid', 100, 25, true, 'Wedding',
             NOW() - INTERVAL '2 days')
     RETURNING id`,
    [clientId, hostedPkgId, JSON.stringify({ package: { name: 'Test Package', base_cost: 500 } })]
  );
  const admin = await mintAdmin();
  const res = await request('PATCH', `/api/proposals/${t.rows[0].id}`, admin.token, { guest_count: 250 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = await pool.query('SELECT gratuity_rate_change_origin FROM proposals WHERE id = $1', [t.rows[0].id]);
  assert.equal(row.rows[0].gratuity_rate_change_origin, 'staffing', 'fixture must take the staffing-notice path');
  assert.deepEqual(await ledgerFor(clientId), [{
    proposal_id: t.rows[0].id, client_id: clientId, channel: 'email',
    message_type: 'gratuity_disclosure', sent_by: admin.id,
  }]);
});
