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

// Stub getStripe BEFORE the router require chain loads invoiceVoid, which
// captures it by destructuring at module load. Returning null makes
// cancelOpenInvoiceIntents an immediate no-op (invoiceVoid.js:61), so no
// Stripe traffic can leave the test.
require('../../utils/stripeClient').getStripe = () => null;

// Silence real sends: stub the notify module BEFORE the router requires it,
// recording calls so the tests can assert the right outcome went out.
const notify = require('../../utils/serviceExtensionNotify');
const staffOutcomeCalls = [];
notify.notifyStaffOfOutcome = async (args) => {
  staffOutcomeCalls.push(args);
  return { notified: args.staffUserIds || [], unreachable: [] };
};
const problemCalls = [];
notify.alertAdminsProblem = async (args) => { problemCalls.push(args); };

const { AppError } = require('../../utils/errors');
const router = require('./index');

const NONCE = `sxa-${Date.now()}`;
let app, server, baseUrl;
let clientId, pkgId, adminId, staffId, proposalId, shiftId;
let ext1Id, inv1Id, ext2Id, inv2Id;
const tokens = {};
const cleanup = { proposals: [], shifts: [], users: [] };

async function post(path, body, userId) {
  return fetch(`${baseUrl}/api/service-extensions${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { Authorization: `Bearer ${tokens[userId]}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
}

async function get(path, userId) {
  return fetch(`${baseUrl}/api/service-extensions${path}`, {
    headers: userId ? { Authorization: `Bearer ${tokens[userId]}` } : {},
  });
}

/** Pending extension + its sent invoice. One pending per proposal at a time
 * (idx_service_extensions_one_pending), so the cancel-path row is minted only
 * after the override test settles the first. */
async function mkExtension({ contracted, requested, invoiceNumber }) {
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, status)
     VALUES ($1, $2, 'Service Extension', 5000, 'sent') RETURNING id`,
    [proposalId, invoiceNumber]
  );
  const ext = await pool.query(
    `INSERT INTO service_extensions
       (proposal_id, shift_id, requested_by_user_id, invoice_id,
        contracted_end_time, requested_end_time,
        contracted_duration_hours, requested_duration_hours,
        amount_cents, gratuity_cents, terms_version, status, expires_at)
     VALUES ($1, $2, $3, $4, '11:00 PM', '11:30 PM', $5, $6, 5000, 0, 'v1',
             'pending', NOW() + INTERVAL '10 minutes')
     RETURNING id`,
    [proposalId, shiftId, staffId, inv.rows[0].id, contracted, requested]
  );
  return { extId: ext.rows[0].id, invId: inv.rows[0].id };
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

  // users has NO name column and password_hash is NOT NULL; JWTs are signed
  // { userId, tokenVersion } (auth reads decoded.userId, compares tokenVersion).
  for (const [key, role] of [['admin', 'admin'], ['staff', 'staff']]) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
       VALUES ($1,'x',$2,'approved',0) RETURNING id, token_version`,
      [`${NONCE}-${key}@example.test`, role]
    );
    const id = u.rows[0].id;
    cleanup.users.push(id);
    tokens[id] = jwt.sign(
      { userId: id, tokenVersion: u.rows[0].token_version },
      process.env.JWT_SECRET, { expiresIn: '1h' }
    );
    if (key === 'admin') adminId = id; else staffId = id;
  }
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone, preferred_name, hourly_rate)
     VALUES ($1,'3125550111',$2,40)`,
    [staffId, `${NONCE} staff`]
  );

  // Local-frame date string: toISOString() is the UTC date and rolls to
  // tomorrow after 7pm Chicago (bit Task 7). settleExtension parses
  // event_date + event_start_time, so both must be coherent local values.
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const pr = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot, adjustments)
     VALUES ($1,$2,'balance_paid',100,4,1,350,350,$3,'7:00 PM','America/Chicago','{}','[]')
     RETURNING id`,
    [clientId, pkgId, dateStr]
  );
  proposalId = pr.rows[0].id;
  cleanup.proposals.push(proposalId);

  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id,
                         event_duration_hours, positions_needed, client_name)
     VALUES ($1,'7:00 PM','11:00 PM','open',$2,4,'["Bartender"]',$3) RETURNING id`,
    [dateStr, proposalId, `${NONCE} client`]
  );
  shiftId = sh.rows[0].id;
  cleanup.shifts.push(shiftId);

  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1,$2,'approved','Bartender')",
    [shiftId, staffId]
  );

  ({ extId: ext1Id, invId: inv1Id } = await mkExtension({
    contracted: 4, requested: 4.5, invoiceNumber: `${NONCE}-1`,
  }));
});

after(async () => {
  await pool.query('DELETE FROM admin_audit_log WHERE actor_user_id = ANY($1)', [cleanup.users]);
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

test('a staff-role token gets 403 on override, cancel, and the read', async () => {
  assert.equal((await post(`/${ext1Id}/override`, { reason: 'client asked nicely' }, staffId)).status, 403);
  assert.equal((await post(`/${ext1Id}/cancel`, {}, staffId)).status, 403);
  assert.equal((await get(`/proposal/${proposalId}`, staffId)).status, 403);
  const se = await pool.query('SELECT status FROM service_extensions WHERE id = $1', [ext1Id]);
  assert.equal(se.rows[0].status, 'pending', 'a denied caller must not move the row');
});

test('override with a reason under 3 characters returns 400', async () => {
  const res = await post(`/${ext1Id}/override`, { reason: 'ok' }, adminId);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.fieldErrors && body.fieldErrors.reason, 'field error keyed by reason');
  const se = await pool.query('SELECT status FROM service_extensions WHERE id = $1', [ext1Id]);
  assert.equal(se.rows[0].status, 'pending');
});

test('override on a pending request grants the time and voids the invoice', async () => {
  const res = await post(`/${ext1Id}/override`, { reason: 'comped, repeat client' }, adminId);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'overridden');
  assert.equal(body.newEndTime, '11:30 PM');
  assert.equal(Number(body.newDurationHours), 4.5);

  const se = await pool.query(
    'SELECT status, override_reason, override_by_user_id, finalized_at FROM service_extensions WHERE id = $1',
    [ext1Id]
  );
  assert.equal(se.rows[0].status, 'overridden');
  assert.equal(se.rows[0].override_reason, 'comped, repeat client');
  assert.equal(se.rows[0].override_by_user_id, adminId);
  assert.ok(se.rows[0].finalized_at, 'every settle path ends with finalizeExtension');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5, 'the contract duration bumped');

  const sh = await pool.query('SELECT end_time FROM shifts WHERE id = $1', [shiftId]);
  assert.equal(sh.rows[0].end_time, '11:30 PM', 'the shift end_time follows the new duration');

  // Decision 14: no open invoice survives an override.
  const inv = await pool.query('SELECT status FROM invoices WHERE id = $1', [inv1Id]);
  assert.equal(inv.rows[0].status, 'void');

  const call = staffOutcomeCalls[staffOutcomeCalls.length - 1];
  assert.equal(call.outcome, 'approved');
  assert.ok(call.staffUserIds.includes(staffId), 'the assigned staffer is greenlit');
});

test('side money: total_price, amount_paid, and status are untouched by the override', async () => {
  const prop = await pool.query('SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(prop.rows[0].total_price), 350);
  assert.equal(Number(prop.rows[0].amount_paid), 350);
  assert.equal(prop.rows[0].status, 'balance_paid');
});

test('the override wrote an admin_audit_log row', async () => {
  const { rows } = await pool.query(
    `SELECT actor_user_id, metadata FROM admin_audit_log
      WHERE action = 'service_extension_override' AND (metadata->>'extension_id')::int = $1`,
    [ext1Id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_user_id, adminId);
  assert.equal(Number(rows[0].metadata.proposal_id), proposalId);
  assert.equal(rows[0].metadata.reason, 'comped, repeat client');
  assert.equal(Number(rows[0].metadata.amount_cents_waived), 5000);
});

test('a second override on the same row returns 409', async () => {
  const res = await post(`/${ext1Id}/override`, { reason: 'double tap' }, adminId);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'EXTENSION_NOT_PENDING');
  assert.match(body.error, /already/i);
});

test('cancel voids the invoice and bumps nothing', async () => {
  ({ extId: ext2Id, invId: inv2Id } = await mkExtension({
    contracted: 4.5, requested: 5, invoiceNumber: `${NONCE}-2`,
  }));
  const res = await post(`/${ext2Id}/cancel`, {}, adminId);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'cancelled');

  const se = await pool.query('SELECT status FROM service_extensions WHERE id = $1', [ext2Id]);
  assert.equal(se.rows[0].status, 'cancelled');
  const inv = await pool.query('SELECT status FROM invoices WHERE id = $1', [inv2Id]);
  assert.equal(inv.rows[0].status, 'void');
  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5, 'cancel must not move the duration');

  const audit = await pool.query(
    `SELECT id FROM admin_audit_log
      WHERE action = 'service_extension_cancel' AND (metadata->>'extension_id')::int = $1`,
    [ext2Id]
  );
  assert.equal(audit.rows.length, 1);
  const call = staffOutcomeCalls[staffOutcomeCalls.length - 1];
  assert.equal(call.outcome, 'declined');
});

test('the admin read returns money fields', async () => {
  const res = await get(`/proposal/${proposalId}`, adminId);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.extensions.length, 2);
  assert.equal(body.extensions[0].id, ext2Id, 'newest first');
  for (const ext of body.extensions) {
    // Admin surface: amount_cents is expected here, unlike the staff endpoints.
    assert.equal(Number(ext.amount_cents), 5000);
    assert.equal(ext.invoice_status, 'void');
    assert.ok(ext.invoice_token);
    assert.equal(ext.requested_by_name, `${NONCE} staff`);
  }
  const overridden = body.extensions.find((e) => e.id === ext1Id);
  assert.equal(overridden.status, 'overridden');
  assert.equal(overridden.override_reason, 'comped, repeat client');
  assert.equal(body.payrollWarning, null, 'no payout lines exist for this event');
});
