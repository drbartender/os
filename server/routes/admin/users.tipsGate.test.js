require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
// Tips/tip-feedback routes live in contractorTipPage.js (split from users.js
// 2026-07-14). Mounted at the REAL prefix: their URLs are /api/admin/tips etc.
const contractorTipPageRouter = require('./contractorTipPage');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.tipsGate.test.js refuses to run against production');
}

// Audit sec-admin (manager-PII -> admin-only DECISION): the tip activity + feedback views
// expose customer/submitter emails and tip amounts. GET /tips, GET /tip-feedback, and
// POST /tip-feedback/:id/review must be adminOnly so managers can't read tipper PII. (The
// tip-page MANAGEMENT routes stay manager-accessible — a separate concern.)

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminId, adminToken, managerId, managerToken;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`tipsgate-admin-${NONCE}@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const m = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'manager', 'approved') RETURNING id`,
    [`tipsgate-mgr-${NONCE}@example.com`]
  );
  managerId = m.rows[0].id;
  managerToken = jwt.sign({ userId: managerId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', contractorTipPageRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  const ids = [adminId, managerId].filter(Boolean);
  if (ids.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  await pool.end();
});

function req(method, path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

for (const path of ['/api/admin/tips', '/api/admin/tip-feedback']) {
  test(`GET ${path}: manager forbidden (403 PERMISSION_DENIED)`, async () => {
    const r = await req('GET', path, managerToken);
    assert.equal(r.status, 403, `manager should be 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'PERMISSION_DENIED');
  });
  test(`GET ${path}: admin allowed (200)`, async () => {
    const r = await req('GET', path, adminToken);
    assert.equal(r.status, 200, `admin should be 200, got ${r.status} ${JSON.stringify(r.body)}`);
  });
}

test('POST /tip-feedback/:id/review: manager forbidden (403 PERMISSION_DENIED)', async () => {
  const r = await req('POST', '/api/admin/tip-feedback/999999/review', managerToken);
  assert.equal(r.status, 403, `manager should be 403, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'PERMISSION_DENIED');
});
