require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { auth, adminOnly, requireAdminOrManager } = require('./auth');

if (process.env.NODE_ENV === 'production') {
  throw new Error('auth.envelope.test.js refuses to run against production');
}

// Audit con-errors: the auth/role-gate middleware hand-rolled `res.status().json({error})`
// without the `code` field the global error middleware attaches to every AppError, so
// client-side `data.code` branching broke for every auth-layer rejection. This proves the
// rejections now carry the canonical { error, code } envelope (routed via next(AppError)).

const PREFIX = 'auth-env-test-';
let server, baseUrl, adminId, adminToken, staffId, staffToken;
let staleToken;
let suspendedStaffId, suspendedStaffToken;
let deactivatedStaffId, deactivatedStaffToken;
let rejectedStaffId, rejectedStaffToken;
let suspendedAdminId, suspendedAdminToken;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','admin','approved') RETURNING id`,
    [`${PREFIX}admin@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','approved') RETURNING id`,
    [`${PREFIX}staff@example.com`]
  );
  staffId = s.rows[0].id;
  staffToken = jwt.sign({ userId: staffId, tokenVersion: 0 }, process.env.JWT_SECRET);
  // Same approved staff row (token_version 0), but a JWT minted at a stale version:
  // proves the token_version bump invalidates old sessions (auth.js:46).
  staleToken = jwt.sign({ userId: staffId, tokenVersion: 1 }, process.env.JWT_SECRET);

  const susStaff = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','suspended') RETURNING id`,
    [`${PREFIX}suspended-staff@example.com`]
  );
  suspendedStaffId = susStaff.rows[0].id;
  suspendedStaffToken = jwt.sign({ userId: suspendedStaffId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const deacStaff = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','deactivated') RETURNING id`,
    [`${PREFIX}deactivated-staff@example.com`]
  );
  deactivatedStaffId = deacStaff.rows[0].id;
  deactivatedStaffToken = jwt.sign({ userId: deactivatedStaffId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const rejStaff = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','rejected') RETURNING id`,
    [`${PREFIX}rejected-staff@example.com`]
  );
  rejectedStaffId = rejStaff.rows[0].id;
  rejectedStaffToken = jwt.sign({ userId: rejectedStaffId, tokenVersion: 0 }, process.env.JWT_SECRET);

  // Admin carrying a would-be-blocking status: proves the owner-lockout exemption
  // (auth.js:53 — the status gate never fires for role 'admin').
  const susAdmin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','admin','suspended') RETURNING id`,
    [`${PREFIX}suspended-admin@example.com`]
  );
  suspendedAdminId = susAdmin.rows[0].id;
  suspendedAdminToken = jwt.sign({ userId: suspendedAdminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.get('/protected', auth, (req, res) => res.json({ ok: true, role: req.user.role }));
  app.get('/admin-only', auth, adminOnly, (req, res) => res.json({ ok: true }));
  app.get('/mgr', auth, requireAdminOrManager, (req, res) => res.json({ ok: true }));
  // Mirror the real global error middleware (server/index.js): AppError → { error, code }.
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  const ids = [
    adminId,
    staffId,
    suspendedStaffId,
    deactivatedStaffId,
    rejectedStaffId,
    suspendedAdminId,
  ].filter(Boolean);
  if (ids.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  await pool.end();
});

function req(path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { method: 'GET', hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); });
      }
    );
    r.on('error', reject);
    r.end();
  });
}

test('auth: no token → 401 with code NO_TOKEN', async () => {
  const r = await req('/protected', null);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'NO_TOKEN');
});

test('auth: malformed token → 401 with code INVALID_TOKEN', async () => {
  const r = await req('/protected', 'not-a-real-jwt');
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'INVALID_TOKEN');
});

test('adminOnly: staff token → 403 with code PERMISSION_DENIED', async () => {
  const r = await req('/admin-only', staffToken);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PERMISSION_DENIED');
});

test('requireAdminOrManager: staff token → 403 with code PERMISSION_DENIED', async () => {
  const r = await req('/mgr', staffToken);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PERMISSION_DENIED');
});

test('auth: valid admin token still passes (200) — no regression to the happy path', async () => {
  const r = await req('/protected', adminToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.equal(r.body.role, 'admin');
});

test('auth: staff token with stale tokenVersion → 401 with code TOKEN_VERSION_MISMATCH', async () => {
  const r = await req('/protected', staleToken);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'TOKEN_VERSION_MISMATCH');
});

test('auth: suspended staff → 403 with code ACCOUNT_SUSPENDED', async () => {
  const r = await req('/protected', suspendedStaffToken);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'ACCOUNT_SUSPENDED');
});

test('auth: deactivated staff → 403 with code ACCOUNT_DEACTIVATED', async () => {
  const r = await req('/protected', deactivatedStaffToken);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'ACCOUNT_DEACTIVATED');
});

test('auth: rejected staff → 403 with code APPLICATION_REJECTED', async () => {
  const r = await req('/protected', rejectedStaffToken);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'APPLICATION_REJECTED');
});

test('auth: admin with suspended onboarding_status still passes (200) — owner-lockout exemption', async () => {
  const r = await req('/protected', suspendedAdminToken);
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.equal(r.body.role, 'admin');
});
