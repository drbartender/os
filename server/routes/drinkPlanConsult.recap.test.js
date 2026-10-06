require('dotenv').config();

// GET /api/drink-plans/:id/consult carries the read-only recap the shopping
// list modal's answers panel renders (spec 2026-10-06, section 3.1). Same
// harness as eventDetails.test.js: a minimal express app over real HTTP with
// the real router; every row seeded here is removed in after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const consultRouter = require('./drinkPlanConsult');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const COCKTAIL_ID = `consult-recap-route-${NONCE}`;
let server;
let baseUrl;
let adminToken;
let adminUserId;
let withConsultId;
let withoutConsultId;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let body = null;
          try { body = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  const passwordHash = await bcrypt.hash('x', 4);
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`consult-recap-route-${NONCE}@example.com`, passwordHash]
  );
  adminUserId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminUserId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  await pool.query("INSERT INTO cocktails (id, name, is_active) VALUES ($1, 'Route Recap Sour', false)", [COCKTAIL_ID]);
  const a = await pool.query(
    "INSERT INTO drink_plans (client_name, consult_selections) VALUES ('Consult Recap Route', $1::jsonb) RETURNING id",
    [JSON.stringify({ barType: 'sig_beer_wine', signatureDrinks: [COCKTAIL_ID], mixers: 'matching', beer: true })]
  );
  withConsultId = a.rows[0].id;
  const b = await pool.query("INSERT INTO drink_plans (client_name) VALUES ('Consult Recap Route') RETURNING id");
  withoutConsultId = b.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', consultRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await pool.query('DELETE FROM drink_plans WHERE id = ANY($1::int[])', [[withConsultId, withoutConsultId].filter(Boolean)]);
  await pool.query('DELETE FROM cocktails WHERE id = $1', [COCKTAIL_ID]);
  await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('consult GET: recap lines carry drink names beside the unchanged raw blob', async () => {
  const res = await get(`/api/drink-plans/${withConsultId}/consult`, adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.consult_selections.signatureDrinks, [COCKTAIL_ID], 'the form still pre-populates from the raw blob');
  assert.ok(res.body.recap.includes('Signature cocktails: Route Recap Sour'));
  assert.ok(res.body.recap.includes('Mixers: Only those that match your spirits'));
  assert.ok(!res.body.recap.join(' ').includes(COCKTAIL_ID), 'never the raw id');
});

test('consult GET: recap is null when the plan has no consult', async () => {
  const res = await get(`/api/drink-plans/${withoutConsultId}/consult`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.consult_selections, null);
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'recap'), 'the key is always present');
  assert.equal(res.body.recap, null);
});
