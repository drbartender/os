'use strict';
// dotenv BEFORE anything that reaches ../db. Without it DATABASE_URL is unset,
// pg falls back to a local socket, and every DB-touching test in this file dies
// on ECONNREFUSED 127.0.0.1:5432 -- which is how this whole suite sat silently
// red since it was written (found 2026-08-20).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');

// Silence real sends: stub the notify module BEFORE the router requires it.
const notify = require('../../utils/serviceExtensionNotify');
notify.notifyClientOfRequest = async () => ({ sms: 'sent', email: 'sent', reachable: true });
notify.alertAdminsRequestSent = async () => {};
notify.alertAdminsProblem = async () => {};

const { AppError } = require('../../utils/errors');
const router = require('./index');

const NONCE = `sxc-${Date.now()}`;
let app, server, baseUrl;
let clientId, pkgId, onStaffId, otherStaffId, proposalId, shiftId;
const tokens = {};
const cleanup = { proposals: [], shifts: [], users: [] };

// auth reads decoded.userId and compares decoded.tokenVersion to
// users.token_version. Signing { id, role } 401s every request.
function tokenFor(userId) {
  return tokens[userId];
}

async function post(body, userId) {
  return fetch(`${baseUrl}/api/service-extensions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  app = express();
  app.use(express.json());
  app.use('/api/service-extensions', router);
  // No server/middleware/errorHandler module exists; the global handler is
  // inline in server/index.js, so route suites hand-roll it. Precedent:
  // server/routes/invoices.extrasVoid.test.js:107-111.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const b = { error: err.message, code: err.code };
      if (err.fieldErrors) b.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(b);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  const c = await pool.query('INSERT INTO clients (name, email, phone) VALUES ($1,$2,$3) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`, '3125550100']);
  clientId = c.rows[0].id;
  const p = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  pkgId = p.rows[0].id;

  for (const key of ['on', 'other']) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1,'x','staff','approved',0) RETURNING id, token_version`,
      [`${NONCE}-${key}@example.test`]
    );
    const id = u.rows[0].id;
    cleanup.users.push(id);
    tokens[id] = jwt.sign(
      { userId: id, tokenVersion: u.rows[0].token_version },
      process.env.JWT_SECRET, { expiresIn: '1h' }
    );
    if (key === 'on') onStaffId = id; else otherStaffId = id;
  }
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
     VALUES ($1,'3125550111',$2,40)`,
    [onStaffId, `${NONCE} on`]
  );

  // Event happening RIGHT NOW so the request window is open: start 1 hour ago,
  // 4 hour duration. event_start_time is free text, as in production.
  const now = new Date();
  const startLocal = new Date(now.getTime() - 60 * 60 * 1000);
  const hh = startLocal.getHours();
  const startDisplay = `${hh % 12 === 0 ? 12 : hh % 12}:00 ${hh >= 12 ? 'PM' : 'AM'}`;
  // Local-frame date to match the local-frame hour above. toISOString() is the
  // UTC date: after 7pm CDT it rolls to tomorrow, storing a future event and
  // turning every in-window test into a too_early 409.
  const dateStr = `${startLocal.getFullYear()}-${String(startLocal.getMonth() + 1).padStart(2, '0')}-${String(startLocal.getDate()).padStart(2, '0')}`;

  const pr = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot, adjustments)
     VALUES ($1,$2,'balance_paid',100,4,1,350,350,$3,$4,'America/Chicago','{}','[]')
     RETURNING id`,
    [clientId, pkgId, dateStr, startDisplay]
  );
  proposalId = pr.rows[0].id;
  cleanup.proposals.push(proposalId);

  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id,
                         event_duration_hours, positions_needed, client_name)
     VALUES ($1,$2,'11:00 PM','open',$3,4,'["Bartender"]',$4) RETURNING id`,
    [dateStr, startDisplay, proposalId, `${NONCE} client`]
  );
  shiftId = sh.rows[0].id;
  cleanup.shifts.push(shiftId);

  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1,$2,'approved','Bartender')",
    [shiftId, onStaffId]
  );
});

after(async () => {
  await pool.query('DELETE FROM service_extensions WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [cleanup.proposals]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1)', [cleanup.shifts]);
  await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [cleanup.shifts]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  server.close();
  await pool.end();
});

test('rejects an unauthenticated request', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, null);
  assert.equal(res.status, 401);
});

test('rejects an authenticated staffer who is NOT assigned to this shift', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, otherStaffId);
  assert.equal(res.status, 403);
  const rows = await pool.query('SELECT COUNT(*)::int n FROM service_extensions WHERE proposal_id = $1', [proposalId]);
  assert.equal(rows.rows[0].n, 0, 'no row may be created for a non-assigned caller');
});

test('an assigned staffer creates a pending request, and the response carries NO price', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, onStaffId);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.status, 'pending');
  const serialized = JSON.stringify(body);
  for (const leak of ['amount', 'cents', 'price', 'gratuity', 'total']) {
    assert.ok(!serialized.toLowerCase().includes(leak), `response leaked "${leak}": ${serialized}`);
  }

  const ext = await pool.query(
    'SELECT status, amount_cents, gratuity_cents, invoice_id, terms_version, expires_at FROM service_extensions WHERE proposal_id = $1',
    [proposalId]
  );
  assert.equal(ext.rowCount, 1);
  assert.equal(ext.rows[0].status, 'pending');
  assert.equal(ext.rows[0].amount_cents, 5000);
  assert.ok(ext.rows[0].invoice_id, 'an invoice must be minted');
  assert.ok(ext.rows[0].terms_version, 'terms version must be stamped');

  const inv = await pool.query('SELECT label, status, amount_due, token FROM invoices WHERE id = $1', [ext.rows[0].invoice_id]);
  assert.equal(inv.rows[0].label, 'Service Extension');
  assert.equal(inv.rows[0].status, 'sent', 'a draft invoice is not payable');
  assert.equal(inv.rows[0].amount_due, 5000);
  assert.ok(inv.rows[0].token);

  const li = await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1', [ext.rows[0].invoice_id]);
  assert.equal(li.rowCount, 1);
  assert.match(li.rows[0].description, /Additional bar service/);
  assert.equal(li.rows[0].line_total, 5000);

  // Side money: the contract did not move.
  const prop = await pool.query('SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4);
  assert.equal(Number(prop.rows[0].total_price), 350);
  assert.equal(Number(prop.rows[0].amount_paid), 350);
  assert.equal(prop.rows[0].status, 'balance_paid');
});

test('a second concurrent request collides instead of double-charging', async () => {
  const res = await post({ shiftId, requestedEndHours: 5 }, onStaffId);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(JSON.stringify(body), /already/i);
  const rows = await pool.query("SELECT COUNT(*)::int n FROM service_extensions WHERE proposal_id = $1 AND status = 'pending'", [proposalId]);
  assert.equal(rows.rows[0].n, 1);
});

test('rejects over the cap and non-30-minute increments', async () => {
  await pool.query("UPDATE service_extensions SET status = 'expired' WHERE proposal_id = $1", [proposalId]);
  assert.equal((await post({ shiftId, requestedEndHours: 8 }, onStaffId)).status, 400);
  assert.equal((await post({ shiftId, requestedEndHours: 4.25 }, onStaffId)).status, 400);
  assert.equal((await post({ shiftId, requestedEndHours: 3.5 }, onStaffId)).status, 400);
});

test('eligibility read carries the end times and no price', async () => {
  const res = await fetch(`${baseUrl}/api/service-extensions/eligibility/${shiftId}`, {
    headers: { Authorization: `Bearer ${tokenFor(onStaffId)}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.contractedEndDisplay);
  assert.ok(body.maxEndDisplay);
  const serialized = JSON.stringify(body).toLowerCase();
  for (const leak of ['amount', 'cents', 'price']) {
    assert.ok(!serialized.includes(leak), `eligibility leaked "${leak}"`);
  }
});

test('eligibility is refused for a non-assigned staffer', async () => {
  const res = await fetch(`${baseUrl}/api/service-extensions/eligibility/${shiftId}`, {
    headers: { Authorization: `Bearer ${tokenFor(otherStaffId)}` },
  });
  assert.equal(res.status, 403);
});

test('the router does NOT apply auth to sibling public paths', async () => {
  // Regression guard for the auth-ordering defect authored in this task: a
  // pathless router.use(auth) in create.js would 401 the public accept route
  // that Task 8 mounts on the same router, breaking client payment entirely.
  // The stub returns 404 today; the ONLY unacceptable answer is 401.
  const res = await fetch(
    `${baseUrl}/api/service-extensions/t/11111111-1111-1111-1111-111111111111/accept`,
    { method: 'POST' }
  );
  assert.notEqual(res.status, 401, 'auth leaked onto the public accept path');
});
