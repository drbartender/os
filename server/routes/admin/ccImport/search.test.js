require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../../db');
const { AppError } = require('../../../utils/errors');
const ccImportRouter = require('./index');

if (process.env.NODE_ENV === 'production') {
  throw new Error('search.test.js refuses to run against production');
}

// ── fixtures ──────────────────────────────────────────────────────
let adminId, adminToken, managerId, managerToken;
let server, baseUrl;
let clientId, proposalId, ccProposalId;
let realUserId, stubUserId;
let legacyPayoutWithStubId, legacyPayoutNoStubId;
let shiftId, otherShiftId;
const PREFIX = 'cc-search-test-';

before(async () => {
  // Users.
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
    [`${PREFIX}admin@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const m = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'manager') RETURNING id`,
    [`${PREFIX}manager@example.com`]
  );
  managerId = m.rows[0].id;
  managerToken = jwt.sign({ userId: managerId, tokenVersion: 0 }, process.env.JWT_SECRET);

  // Real user with preferred_name 'Search Real Match' so q='search real' hits it.
  const ru = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
    [`${PREFIX}real-match@example.com`]
  );
  realUserId = ru.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, 'Search Real Match')`,
    [realUserId]
  );

  // Stub user (cc_id LIKE 'legacy_cc:%') with preferred_name 'Search Stub Match'.
  const su = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id, onboarding_status)
     VALUES ($1, 'x', 'staff', 'legacy_cc:searchstub:abc123', 'deactivated')
     RETURNING id`,
    [`legacy-cc-searchstub-abc123@drbartender.local`]
  );
  stubUserId = su.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, 'Search Stub Match')`,
    [stubUserId]
  );

  // Clients + proposals for /search/proposals.
  const c1 = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
    ['Search Test Client', `${PREFIX}client@example.com`]
  );
  clientId = c1.rows[0].id;
  const p1 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'confirmed', 'birthday-party', '6:00 PM', 4, 1500)
     RETURNING id`,
    [clientId]
  );
  proposalId = p1.rows[0].id;
  const p2 = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price, cc_id)
     VALUES ($1, CURRENT_DATE - INTERVAL '5 days', 'completed', 'wedding', '4:00 PM', 4, 2500, 'cc-search-test-1')
     RETURNING id`,
    [clientId]
  );
  ccProposalId = p2.rows[0].id;

  // Shifts for link-preview.
  const s1 = await pool.query(
    `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
     VALUES ($1, 'Search Test Client', CURRENT_DATE + INTERVAL '30 days', '6:00 PM', $2::jsonb, 'open', $3)
     RETURNING id`,
    [proposalId, JSON.stringify(['Bartender']), adminId]
  );
  shiftId = s1.rows[0].id;
  const s2 = await pool.query(
    `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
     VALUES ($1, 'Search Test Client', CURRENT_DATE - INTERVAL '5 days', '4:00 PM', $2::jsonb, 'completed', $3)
     RETURNING id`,
    [ccProposalId, JSON.stringify(['Bartender']), adminId]
  );
  otherShiftId = s2.rows[0].id;

  // Stub has approved shift_requests on both shifts so link-preview has rows
  // to count. Real user has nothing yet — shifts_reassigned should be 2.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`,
    [shiftId, stubUserId]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1, $2, 'approved', 'Bartender')`,
    [otherShiftId, stubUserId]
  );

  // legacy_cc_payouts rows.
  const rawA = await pool.query(
    `INSERT INTO legacy_cc_raw_imports (source_file, source_entity, source_row_number, source_row_hash, payload)
     VALUES ('search-test', 'payouts', 1, 'hash-stub-link-a', '{}'::jsonb)
     RETURNING id`
  );
  const lpA = await pool.query(
    `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
     VALUES ('Search Stub Match', 'search stub match', $1, CURRENT_DATE - INTERVAL '90 days', 25000, $2)
     RETURNING id`,
    [stubUserId, rawA.rows[0].id]
  );
  legacyPayoutWithStubId = lpA.rows[0].id;

  const rawB = await pool.query(
    `INSERT INTO legacy_cc_raw_imports (source_file, source_entity, source_row_number, source_row_hash, payload)
     VALUES ('search-test', 'payouts', 2, 'hash-stub-link-b', '{}'::jsonb)
     RETURNING id`
  );
  const lpB = await pool.query(
    `INSERT INTO legacy_cc_payouts (payee_name, payee_name_normalized, payee_user_id, paid_on, amount_cents, raw_import_id)
     VALUES ('Solo Payee', 'solo payee', NULL, CURRENT_DATE - INTERVAL '90 days', 15000, $1)
     RETURNING id`,
    [rawB.rows[0].id]
  );
  legacyPayoutNoStubId = lpB.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/admin/cc-import', ccImportRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.query(`DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])`, [[shiftId, otherShiftId].filter(Boolean)]);
  await pool.query(`DELETE FROM shifts WHERE id = ANY($1::int[])`, [[shiftId, otherShiftId].filter(Boolean)]);
  if (legacyPayoutWithStubId || legacyPayoutNoStubId) {
    await pool.query(
      `DELETE FROM legacy_cc_payouts WHERE id = ANY($1::int[])`,
      [[legacyPayoutWithStubId, legacyPayoutNoStubId].filter(Boolean)]
    );
  }
  await pool.query(`DELETE FROM legacy_cc_raw_imports WHERE source_file = 'search-test'`);
  await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`, [[proposalId, ccProposalId].filter(Boolean)]);
  await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [[proposalId, ccProposalId].filter(Boolean)]);
  if (clientId) await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])`, [[realUserId, stubUserId].filter(Boolean)]);
  for (const id of [adminId, managerId, realUserId, stubUserId]) {
    if (id) await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id = $1 OR target_user_id = $1`, [id]);
  }
  for (const id of [adminId, managerId, realUserId, stubUserId]) {
    if (id) await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }
  await pool.end();
});

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request(
      {
        method, hostname: url.hostname, port: url.port,
        path: url.pathname + (url.search || ''), headers,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── /search/proposals ─────────────────────────────────────────────

test('GET /search/proposals rejects q < 2 chars', async () => {
  const r = await req('GET', '/api/admin/cc-import/search/proposals?q=a', adminToken);
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /q must be 2-100/);
});

test('GET /search/proposals returns items + total for matching client name', async () => {
  const r = await req('GET', '/api/admin/cc-import/search/proposals?q=Search%20Test', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length >= 2, 'both proposals (native + cc) returned');
  assert.ok(Number.isInteger(body.total));
  const ids = body.items.map((i) => i.id);
  assert.ok(ids.includes(proposalId));
  assert.ok(ids.includes(ccProposalId));
});

test('GET /search/proposals matches by cc_id exact', async () => {
  const r = await req('GET', '/api/admin/cc-import/search/proposals?q=cc-search-test-1', adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.items.find((i) => i.id === ccProposalId), 'cc proposal returned by cc_id match');
});

// ── /search/users ─────────────────────────────────────────────────

test('GET /search/users rejects q < 2 chars', async () => {
  const r = await req('GET', '/api/admin/cc-import/search/users?q=x', adminToken);
  assert.equal(r.status, 400);
});

test('GET /search/users excludes stubs by default', async () => {
  const r = await req('GET', '/api/admin/cc-import/search/users?q=Search', adminToken);
  assert.equal(r.status, 200);
  const items = JSON.parse(r.body).items;
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes(realUserId), 'real-match user is returned');
  assert.ok(!ids.includes(stubUserId), 'stub user excluded by default');
});

test('GET /search/users include_stubs=true requires admin (manager 403)', async () => {
  const r = await req('GET', '/api/admin/cc-import/search/users?q=Search&include_stubs=true', managerToken);
  assert.equal(r.status, 403);
  assert.match(JSON.parse(r.body).error, /include_stubs requires admin/);
});

test('GET /search/users include_stubs=true returns stubs for admin', async () => {
  const r = await req('GET', '/api/admin/cc-import/search/users?q=Search&include_stubs=true', adminToken);
  assert.equal(r.status, 200);
  const items = JSON.parse(r.body).items;
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes(stubUserId), 'stub user returned with include_stubs=true for admin');
});

// ── /review/.../link-preview ──────────────────────────────────────

test('GET link-preview returns counts for stub with shift_requests', async () => {
  const r = await req(
    'GET',
    `/api/admin/cc-import/review/unmatched-payee/${legacyPayoutWithStubId}/link-preview?user_id=${realUserId}`,
    adminToken
  );
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  // Real user has NO shift_requests on either shift → both are reassignable.
  assert.equal(body.shifts_reassigned, 2);
  assert.equal(body.shifts_merged, 0);
  assert.equal(body.shifts_real_user_status_cleared, 0);
  assert.equal(body.proposals, 2, 'two distinct proposals via two distinct shifts');
});

test('GET link-preview returns zeros when payout has no stub', async () => {
  const r = await req(
    'GET',
    `/api/admin/cc-import/review/unmatched-payee/${legacyPayoutNoStubId}/link-preview?user_id=${realUserId}`,
    adminToken
  );
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body, {
    shifts_reassigned: 0,
    shifts_merged: 0,
    shifts_real_user_status_cleared: 0,
    proposals: 0,
  });
});

test('GET link-preview rejects non-integer ids', async () => {
  const r = await req(
    'GET',
    `/api/admin/cc-import/review/unmatched-payee/abc/link-preview?user_id=${realUserId}`,
    adminToken
  );
  assert.equal(r.status, 400);
});
