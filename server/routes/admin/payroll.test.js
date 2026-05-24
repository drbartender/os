require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const payrollRouter = require('./payroll');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payroll.test.js refuses to run against production');
}

let adminId, adminToken, server, baseUrl;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('payroll-admin@example.com','x','admin') RETURNING id"
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminId, tokenVersion: 0 },
    process.env.JWT_SECRET
  );

  const app = express();
  app.use(express.json());
  app.use('/api/admin', payrollRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function req(method, path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const r = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('GET /payroll/healthcheck > 200 for an admin', async () => {
  const r = await req('GET', '/api/admin/payroll/healthcheck', adminToken);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('GET /payroll/healthcheck > 401 without a token', async () => {
  const r = await req('GET', '/api/admin/payroll/healthcheck', null);
  assert.equal(r.status, 401);
});
