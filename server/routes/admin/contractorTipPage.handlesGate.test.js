require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// No .env on a gate or audit box: the real auth middleware still has to verify
// a token, so the secret falls back to a fixed test value when none is set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'contractor-tip-page-handles-gate-test';

/**
 * PATCH /api/admin/contractors/:userId/tip-page: the payout destination is
 * admin-only and an admin change of it is audited (audit 2026-11-05, POUT-01).
 *
 * The four payout-destination fields (venmo_handle, cashapp_handle, paypal_url,
 * preferred_payment_method) are the columns the admin Pay panel builds the
 * Venmo / Cash App / PayPal deep link from (client PayPanel.js). The whole route
 * is adminOnly (lane staff-page-manager-view, on main since 2026-11-05), so a
 * manager gets 403 and nothing is written for any body, a preferred_name
 * included. An admin write of the payout fields leaves one admin_audit_log row
 * naming the fields changed and never a handle value.
 *
 * Harness: the real router and the real auth middleware over node:http, with
 * pool.query replaced by an in-memory stub keyed on the SQL text (the
 * stripePayoutSync.unconfigured.test.js pattern). No database: every write is
 * recorded instead of executed, so the "nothing is written" claims are exact.
 *
 * Run: node --test server/routes/admin/contractorTipPage.handlesGate.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const contractorTipPageRouter = require('./contractorTipPage');

if (process.env.NODE_ENV === 'production') {
  throw new Error('contractorTipPage.handlesGate.test.js refuses to run against production');
}

const ADMIN_ID = 101;
const MANAGER_ID = 102;
const CONTRACTOR_ID = 103;
const ROLES = { [ADMIN_ID]: 'admin', [MANAGER_ID]: 'manager', [CONTRACTOR_ID]: 'staff' };

// A handle value that must never appear in an audit row.
const HANDLE = 'audit-gate-venmo';

let server, baseUrl;
const realQuery = pool.query;
let writes = [];   // every INSERT/UPDATE/DELETE the route issued, except the audit row
let audits = [];   // INSERT INTO admin_audit_log rows

function stubQuery(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  // middleware/auth.js: the caller row.
  if (sql.startsWith('SELECT id, email, role, onboarding_status')) {
    const role = ROLES[params[0]];
    if (!role) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        id: params[0], email: `user${params[0]}@example.com`, role, onboarding_status: 'approved',
        can_hire: false, can_staff: false, token_version: 0, pre_hired: false, presence_lead_rank: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.startsWith('SELECT preferred_name FROM contractor_profiles')) {
    return { rows: [{ preferred_name: 'Old Name' }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO admin_audit_log')) {
    audits.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
  if (/^(INSERT|UPDATE|DELETE) /.test(sql)) {
    writes.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
  // refreshDisplayName's legal-name read and anything else: no row.
  return { rows: [], rowCount: 0 };
}

function tokenFor(id) {
  return jwt.sign({ userId: id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function patch(path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  pool.query = stubQuery;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', contractorTipPageRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { writes = []; audits = []; });

after(async () => {
  pool.query = realQuery;
  if (server) await new Promise((r) => server.close(r));
});

const PATH = `/api/admin/contractors/${CONTRACTOR_ID}/tip-page`;

const PAYOUT_FIELDS = {
  venmo_handle: HANDLE,
  cashapp_handle: 'auditgate',
  paypal_url: 'https://paypal.me/audit-gate',
  preferred_payment_method: 'venmo',
};

for (const [field, value] of Object.entries(PAYOUT_FIELDS)) {
  test(`manager PATCH with ${field} is 403 and writes nothing`, async () => {
    const r = await patch(PATH, tokenFor(MANAGER_ID), { [field]: value });
    assert.equal(r.status, 403, `expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'PERMISSION_DENIED');
    assert.deepEqual(writes, [], 'no row may change on a refused manager write');
    assert.deepEqual(audits, []);
  });
}

test('manager PATCH carrying preferred_name beside a handle is refused before the name write', async () => {
  const r = await patch(PATH, tokenFor(MANAGER_ID), { preferred_name: 'Sam', venmo_handle: HANDLE });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.deepEqual(writes, [], 'the refusal comes before every write, the name UPDATE included');
});

test('manager PATCH with preferred_name alone is refused too: the route is admin-only', async () => {
  const r = await patch(PATH, tokenFor(MANAGER_ID), { preferred_name: 'Sam' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.deepEqual(writes, [], 'no name write on a refused manager call');
  assert.deepEqual(audits, []);
});

test('admin PATCH writes the payout fields and logs the field names, never a handle', async () => {
  const r = await patch(PATH, tokenFor(ADMIN_ID), { venmo_handle: HANDLE, preferred_payment_method: 'venmo' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const upserts = writes.filter((w) => w.sql.startsWith('INSERT INTO payment_profiles'));
  assert.equal(upserts.length, 1, 'one payment_profiles upsert');
  assert.equal(upserts[0].params[0], CONTRACTOR_ID);
  assert.ok(upserts[0].params.includes(HANDLE), 'the handle reaches the column');

  assert.equal(audits.length, 1, 'exactly one admin_audit_log row');
  const [actorUserId, targetUserId, action, metadataJson] = audits[0].params;
  assert.equal(actorUserId, ADMIN_ID);
  assert.equal(targetUserId, CONTRACTOR_ID);
  assert.equal(action, 'tip_handles_change');
  const metadata = JSON.parse(metadataJson);
  assert.deepEqual(metadata.fields_changed, ['venmo_handle', 'preferred_payment_method']);
  assert.ok(!metadataJson.includes(HANDLE), 'a handle value never lands in the audit row');
});

test('admin PATCH is still refused for an invalid payroll method', async () => {
  const r = await patch(PATH, tokenFor(ADMIN_ID), { preferred_payment_method: 'vemno' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.deepEqual(writes, []);
  assert.deepEqual(audits, []);
});
