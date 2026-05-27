require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const usersRouter = require('./users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.stubCoParticipated.test.js refuses to run against production');
}

const PREFIX = 'cc-stubco-test-';

// Fixture handles
let server, baseUrl;
let adminId, adminToken;

let userEmptyId;       // subject with no shift_requests at all
let userNoStubId;      // subject participating only with non-stub co-participants
let coParticipantRealId; // a non-stub co-participant for userNoStubId
let userWithStubId;    // subject participating on a proposal that also has a stub
let stubUserId;        // the stub user (cc_id LIKE 'legacy_cc:%')
let userDedupId;       // subject approved on TWO shifts of the same proposal w/ stub

let clientId;
let proposalNoStubId;  // proposal whose only other participants are non-stub
let proposalWithStubId; // proposal with a stub co-participant
let proposalDedupId;   // proposal with TWO shifts both stub-co-participated

let shiftNoStubId;
let shiftWithStubId;
let shiftDedup1Id, shiftDedup2Id;

before(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const a = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
      [`${PREFIX}admin@example.com`]
    );
    adminId = a.rows[0].id;
    adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

    const ue = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${PREFIX}empty@example.com`]
    );
    userEmptyId = ue.rows[0].id;

    const uns = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${PREFIX}nostub@example.com`]
    );
    userNoStubId = uns.rows[0].id;

    const cp = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${PREFIX}coreal@example.com`]
    );
    coParticipantRealId = cp.rows[0].id;

    const uws = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${PREFIX}withstub@example.com`]
    );
    userWithStubId = uws.rows[0].id;

    const stub = await c.query(
      `INSERT INTO users (email, password_hash, role, cc_id, onboarding_status)
       VALUES ($1, 'x', 'staff', $2, 'deactivated') RETURNING id`,
      [`legacy-cc-stubco-${Date.now()}@drbartender.local`, `legacy_cc:stubco-fixture:${Date.now()}`]
    );
    stubUserId = stub.rows[0].id;

    const ud = await c.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${PREFIX}dedup@example.com`]
    );
    userDedupId = ud.rows[0].id;

    // Client + proposals.
    const cl = await c.query(
      `INSERT INTO clients (name, email, email_status) VALUES ($1, $2, 'ok') RETURNING id`,
      ['Stub Co Test Client', `${PREFIX}client@example.com`]
    );
    clientId = cl.rows[0].id;

    // proposal 1: real subject + real co-participant; no stub
    const p1 = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price)
       VALUES ($1, CURRENT_DATE - INTERVAL '10 days', 'completed', 'wedding', '5:00 PM', 4, 2500)
       RETURNING id`,
      [clientId]
    );
    proposalNoStubId = p1.rows[0].id;

    // proposal 2: real subject + stub co-participant
    const p2 = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price)
       VALUES ($1, CURRENT_DATE - INTERVAL '11 days', 'completed', 'wedding', '5:00 PM', 4, 2500)
       RETURNING id`,
      [clientId]
    );
    proposalWithStubId = p2.rows[0].id;

    // proposal 3: dedup — TWO shifts, subject on both, both stub-co-participated
    const p3 = await c.query(
      `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                              event_duration_hours, total_price)
       VALUES ($1, CURRENT_DATE - INTERVAL '12 days', 'completed', 'wedding', '5:00 PM', 4, 2500)
       RETURNING id`,
      [clientId]
    );
    proposalDedupId = p3.rows[0].id;

    // Shifts.
    const s1 = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Stub Co Test Client', CURRENT_DATE - INTERVAL '10 days', '5:00 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalNoStubId, JSON.stringify(['Bartender']), adminId]
    );
    shiftNoStubId = s1.rows[0].id;
    const s2 = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Stub Co Test Client', CURRENT_DATE - INTERVAL '11 days', '5:00 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalWithStubId, JSON.stringify(['Bartender']), adminId]
    );
    shiftWithStubId = s2.rows[0].id;
    const s3a = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Stub Co Test Client', CURRENT_DATE - INTERVAL '12 days', '5:00 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalDedupId, JSON.stringify(['Bartender']), adminId]
    );
    shiftDedup1Id = s3a.rows[0].id;
    const s3b = await c.query(
      `INSERT INTO shifts (proposal_id, client_name, event_date, start_time, positions_needed, status, created_by)
       VALUES ($1, 'Stub Co Test Client', CURRENT_DATE - INTERVAL '12 days', '6:30 PM', $2::jsonb, 'completed', $3)
       RETURNING id`,
      [proposalDedupId, JSON.stringify(['Bartender']), adminId]
    );
    shiftDedup2Id = s3b.rows[0].id;

    // Shift requests:
    //   proposal 1: userNoStub approved + coParticipantReal approved (neither is stub)
    //   proposal 2: userWithStub approved + stub approved
    //   proposal 3: userDedup approved on shift_a AND shift_b; stub approved on both
    await c.query(
      `INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES
         ($1, $2, 'approved', 'Bartender'),
         ($1, $3, 'approved', 'Bartender'),
         ($4, $5, 'approved', 'Bartender'),
         ($4, $6, 'approved', 'Bartender'),
         ($7, $8, 'approved', 'Bartender'),
         ($7, $6, 'approved', 'Bartender'),
         ($9, $8, 'approved', 'Bartender'),
         ($9, $6, 'approved', 'Bartender')`,
      [
        shiftNoStubId, userNoStubId, coParticipantRealId,    // $1 $2 $3
        shiftWithStubId, userWithStubId, stubUserId,         // $4 $5 $6
        shiftDedup1Id, userDedupId,                           // $7 $8
        shiftDedup2Id,                                        // $9
      ]
    );

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }

  const app = express();
  app.use(express.json());
  app.use('/api/admin', usersRouter);
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
  if (server) await new Promise((r) => server.close(r));

  const shiftIds = [shiftNoStubId, shiftWithStubId, shiftDedup1Id, shiftDedup2Id].filter(Boolean);
  if (shiftIds.length) {
    await pool.query(`DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])`, [shiftIds]);
    await pool.query(`DELETE FROM shifts WHERE id = ANY($1::int[])`, [shiftIds]);
  }
  const propIds = [proposalNoStubId, proposalWithStubId, proposalDedupId].filter(Boolean);
  if (propIds.length) {
    await pool.query(`DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])`, [propIds]);
    await pool.query(`DELETE FROM proposals WHERE id = ANY($1::int[])`, [propIds]);
  }
  if (clientId) await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);

  const userIds = [
    adminId, userEmptyId, userNoStubId, coParticipantRealId,
    userWithStubId, stubUserId, userDedupId,
  ].filter(Boolean);
  for (const id of userIds) {
    await pool.query(`DELETE FROM admin_audit_log WHERE actor_user_id = $1 OR target_user_id = $1`, [id]);
  }
  for (const id of userIds) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
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

// ── /users/:id/stub-co-participated-proposals ────────────────────────

test('GET /users/:id/stub-co-participated-proposals rejects non-integer id', async () => {
  const r = await req('GET', '/api/admin/users/abc/stub-co-participated-proposals', adminToken);
  assert.equal(r.status, 400);
});

test('GET /users/:id/stub-co-participated-proposals 401 without token', async () => {
  const r = await req('GET', `/api/admin/users/${userWithStubId}/stub-co-participated-proposals`, null);
  assert.equal(r.status, 401);
});

test('GET /users/:id/stub-co-participated-proposals 404 on unknown user', async () => {
  const r = await req('GET', '/api/admin/users/999999999/stub-co-participated-proposals', adminToken);
  assert.equal(r.status, 404);
});

test('GET /users/:id/stub-co-participated-proposals returns [] when user has no shift_requests', async () => {
  const r = await req('GET', `/api/admin/users/${userEmptyId}/stub-co-participated-proposals`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.proposal_ids, []);
});

test('GET /users/:id/stub-co-participated-proposals returns [] when no stub co-participates', async () => {
  const r = await req('GET', `/api/admin/users/${userNoStubId}/stub-co-participated-proposals`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.proposal_ids, []);
});

test('GET /users/:id/stub-co-participated-proposals returns proposal id when stub co-participates', async () => {
  const r = await req('GET', `/api/admin/users/${userWithStubId}/stub-co-participated-proposals`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.proposal_ids, [proposalWithStubId]);
});

test('GET /users/:id/stub-co-participated-proposals dedups when user is on multiple shifts of same proposal', async () => {
  const r = await req('GET', `/api/admin/users/${userDedupId}/stub-co-participated-proposals`, adminToken);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.proposal_ids.length, 1, 'one entry per proposal even when user is on multiple shifts');
  assert.equal(body.proposal_ids[0], proposalDedupId);
});
