// Underscore-key hygiene on the shopping-list blob (potion custom-recipe
// flow, spec §4): PUT /:id/shopping-list strips every generation-run
// diagnostic (_unresolvedIngredients, _signatureCocktails, _syrupSelfProvided)
// before persisting, and the public token GET never serves them (the stored
// auto-gen blob keeps them so the admin modal's first open still warns).
//
// Harness on the drinkPlans.beo.test.js app-bootstrap pattern (fresh express
// app, real router + real auth, dev DB, cleanup in after()); the request()
// helper is copied from potions.test.js (positional body/token signature).
// Run ALONE (shared dev DB):
//   node -r dotenv/config --test server/routes/drinkPlans.shoppingListStrip.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

let server;
let baseUrl;
let adminToken;
let adminId;
let planId;

function request(method, path, body, token = adminToken) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', require('./drinkPlans'));
  // Same AppError envelope as server/index.js
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    console.error('unexpected test-harness error:', err);
    return res.status(500).json({ error: 'unexpected' });
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`,
    [`sl-strip-test-${Date.now()}@example.com`]
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET
  );

  const p = await pool.query(
    `INSERT INTO drink_plans (client_name, client_email, status)
     VALUES ('SL Strip Test Client', 'sl-strip-test@example.com', 'submitted')
     RETURNING id`
  );
  planId = p.rows[0].id;
});

after(async () => {
  // Deleting the plan row also disposes of the mutated shopping_list /
  // shopping_list_status state the tests wrote.
  if (planId) await pool.query('DELETE FROM drink_plans WHERE id = $1', [planId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('PUT shopping-list strips every underscore-prefixed key before persisting', async () => {
  const res = await request('PUT', `/api/drink-plans/${planId}/shopping-list`, {
    shopping_list: {
      guestCount: 50, liquorBeerWine: [], everythingElse: [],
      _unresolvedIngredients: [{ drink: 'X', ingredient: 'y' }],
      _signatureCocktails: [{ name: 'X' }],
      _syrupSelfProvided: ['lavender'],
    },
  });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('SELECT shopping_list FROM drink_plans WHERE id = $1', [planId]);
  const savedKeys = Object.keys(rows[0].shopping_list).filter((k) => k.startsWith('_'));
  assert.deepEqual(savedKeys, []);
  assert.equal(rows[0].shopping_list.guestCount, 50);
});

test('public token GET never serves underscore-prefixed keys', async () => {
  await pool.query(
    `UPDATE drink_plans
       SET shopping_list = $1::jsonb, shopping_list_status = 'approved'
     WHERE id = $2`,
    [JSON.stringify({
      guestCount: 50, liquorBeerWine: [], everythingElse: [],
      _unresolvedIngredients: [{ drink: 'X', ingredient: 'y' }],
    }), planId]
  );
  const { rows } = await pool.query('SELECT token FROM drink_plans WHERE id = $1', [planId]);
  const res = await request('GET', `/api/drink-plans/t/${rows[0].token}/shopping-list`, undefined, null);
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
  const servedKeys = Object.keys(res.body.shopping_list).filter((k) => k.startsWith('_'));
  assert.deepEqual(servedKeys, []);
});
