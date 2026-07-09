// Route tests for lane potions-c-api: the potions router (pars CRUD +
// reorder + preview), the regenerate endpoint, and the recipe validation /
// artifact-guard / review transitions on the cocktails router.
//
// Harness per server/routes/proposals/crud.test.js: real routers + real auth
// on a fresh express() app over node http, against the dev DB, every created
// row cleaned up in after(). Run ALONE (shared dev DB):
//   node -r dotenv/config --test server/routes/potions.test.js
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
const createdParIds = [];
const createdCocktailIds = [];
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
  app.use('/api/potions', require('./potions'));
  app.use('/api/drink-plans', require('./drinkPlans/regenerate'));
  app.use('/api/cocktails', require('./cocktails'));
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
    [`potions-test-${Date.now()}@example.com`]
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET
  );

  // A plan with planner selections, NULL shopping_list_source, no proposal.
  const p = await pool.query(
    `INSERT INTO drink_plans (client_name, client_email, status, selections)
     VALUES ('Potions Test Client', 'potions-test@example.com', 'submitted',
             '{"signatureDrinks":["margarita"],"customCocktails":["Margarita","Lavender Gin Fizz"]}'::jsonb)
     RETURNING id`
  );
  planId = p.rows[0].id;
});

after(async () => {
  if (createdParIds.length) {
    await pool.query('DELETE FROM par_items WHERE id = ANY($1::text[])', [createdParIds]);
  }
  if (createdCocktailIds.length) {
    await pool.query('DELETE FROM cocktails WHERE id = ANY($1::text[])', [createdCocktailIds]);
  }
  if (planId) await pool.query('DELETE FROM drink_plans WHERE id = $1', [planId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET /api/potions/pars returns the active catalog with used_by', async () => {
  const res = await request('GET', '/api/potions/pars');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.pars));
  assert.ok(res.body.pars.length >= 83, `expected >= 83 rows, got ${res.body.pars.length}`);
  const titos = res.body.pars.find((r) => r.id === 'titos-vodka');
  assert.ok(titos, 'titos-vodka present');
  assert.ok(Array.isArray(titos.used_by));
  assert.ok(titos.used_by.length >= 1, 'vodka recipes reference the Titos row');
  assert.ok(titos.used_by[0].id && titos.used_by[0].name && titos.used_by[0].table);
});

test('POST /pars server-slugs, collides to -2, then conflicts', async () => {
  const body = { item: 'Potions Test Cordial', size: '750mL', qty_per_100: 1, section: 'liquorBeerWine', role: 'spirit' };
  const first = await request('POST', '/api/potions/pars', body);
  assert.equal(first.status, 201);
  assert.equal(first.body.par.id, 'potions-test-cordial');
  createdParIds.push(first.body.par.id);
  const second = await request('POST', '/api/potions/pars', body);
  assert.equal(second.status, 201);
  assert.equal(second.body.par.id, 'potions-test-cordial-2');
  createdParIds.push(second.body.par.id);
  const third = await request('POST', '/api/potions/pars', body);
  assert.equal(third.status, 409);
});

test('POST /pars validates enums and qty', async () => {
  const bad = await request('POST', '/api/potions/pars', { item: 'X', qty_per_100: -1, section: 'pantry', role: 'elixir' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fieldErrors.section);
  assert.ok(bad.body.fieldErrors.role);
  assert.ok(bad.body.fieldErrors.qty_per_100);
});

test('PUT /pars/:id partial-updates without clobbering', async () => {
  const res = await request('PUT', '/api/potions/pars/potions-test-cordial', { qty_per_100: 3 });
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.par.qty_per_100), 3);
  assert.equal(res.body.par.item, 'Potions Test Cordial');
});

test('DELETE /pars/:id blocks while referenced, soft-deletes when free', async () => {
  // titos-vodka is referenced by seeded draft recipes -> blocked.
  const blocked = await request('DELETE', '/api/potions/pars/titos-vodka');
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Used by:/);
  // the fresh test row is unreferenced -> soft delete.
  const ok = await request('DELETE', '/api/potions/pars/potions-test-cordial-2');
  assert.equal(ok.status, 200);
  const check = await pool.query('SELECT is_active FROM par_items WHERE id = $1', ['potions-test-cordial-2']);
  assert.equal(check.rows[0].is_active, false);
});

test('POST /pars/reorder round-trips sort order', async () => {
  const res = await request('POST', '/api/potions/pars/reorder', {
    items: [{ id: 'potions-test-cordial', sort_order: 999 }],
  });
  assert.equal(res.status, 200);
  const check = await pool.query('SELECT sort_order FROM par_items WHERE id = $1', ['potions-test-cordial']);
  assert.equal(check.rows[0].sort_order, 999);
});

test('GET /preview validates and generates from the live catalog', async () => {
  assert.equal((await request('GET', '/api/potions/preview?guests=0')).status, 400);
  assert.equal((await request('GET', '/api/potions/preview?guests=2000')).status, 400);
  assert.equal((await request('GET', '/api/potions/preview?guests=abc')).status, 400);
  assert.equal((await request('GET', '/api/potions/preview?guests=100&mode=weird')).status, 400);
  const full = await request('GET', '/api/potions/preview?guests=175&mode=full_bar');
  assert.equal(full.status, 200);
  assert.ok(full.body.list.liquorBeerWine.length >= 13);
  const spirit = await request('GET', '/api/potions/preview?guests=120&mode=spirit_driven');
  assert.equal(spirit.status, 200);
  assert.ok(spirit.body.list.liquorBeerWine.some((i) => i.item === "Tito's Vodka"));
});

test('regenerate: NULL source uses planner inputs, needsRecipe surfaces, nothing saved', async () => {
  const noGuests = await request('POST', `/api/drink-plans/${planId}/shopping-list/regenerate`, {});
  assert.equal(noGuests.status, 400, 'no guest count anywhere -> 400');
  const badOverride = await request('POST', `/api/drink-plans/${planId}/shopping-list/regenerate`, { guest_count_override: 5000 });
  assert.equal(badOverride.status, 400);
  const ok = await request('POST', `/api/drink-plans/${planId}/shopping-list/regenerate`, { guest_count_override: 150 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.list.guestCount, 150);
  // 'Margarita' custom matches the seeded recipe (dedup with the selected id
  // keeps it single); 'Lavender Gin Fizz' has no recipe -> needsRecipe.
  assert.deepEqual(ok.body.list.needsRecipe, [{ name: 'Lavender Gin Fizz' }]);
  assert.equal(
    ok.body.list.signatureCocktailNames.filter((n) => n === 'Margarita').length, 1,
    'custom duplicate of a selected drink is deduped'
  );
  const saved = await pool.query('SELECT shopping_list FROM drink_plans WHERE id = $1', [planId]);
  assert.equal(saved.rows[0].shopping_list, null, 'regenerate never writes');
});

test('cocktails POST: server slug, is_active false honored, recipe -> draft', async () => {
  const res = await request('POST', '/api/cocktails', {
    name: 'Potions Test Fizz',
    is_active: false,
    ingredients: [{ ingredient: 'Gin', amount: 1.5, unit: 'oz' }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'potions-test-fizz');
  assert.equal(res.body.is_active, false);
  assert.equal(res.body.recipe_review, 'draft');
  createdCocktailIds.push(res.body.id);
});

test('cocktails PUT: unit/amount/override validation', async () => {
  const badUnit = await request('PUT', '/api/cocktails/potions-test-fizz', {
    ingredients: [{ ingredient: 'Gin', amount: 1, unit: 'liters' }],
  });
  assert.equal(badUnit.status, 400);
  const badAmount = await request('PUT', '/api/cocktails/potions-test-fizz', {
    ingredients: [{ ingredient: 'Gin', amount: 0, unit: 'oz' }],
  });
  assert.equal(badAmount.status, 400);
  const badOverride = await request('PUT', '/api/cocktails/potions-test-fizz', {
    ingredients: [{ ingredient: 'Gin', amount: 1, unit: 'oz', override_item_id: 'no-such-par' }],
  });
  assert.equal(badOverride.status, 400);
  assert.match(badOverride.body.fieldErrors.ingredients, /no-such-par/);
});

test('cocktails PUT: Menu-tab artifact strings never destroy a recipe', async () => {
  const res = await request('PUT', '/api/cocktails/potions-test-fizz', {
    name: 'Potions Test Fizz Renamed',
    ingredients: ['[object Object]', '[object Object]'],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Potions Test Fizz Renamed');
  assert.equal(res.body.ingredients.length, 1, 'structured recipe preserved');
  assert.equal(res.body.ingredients[0].ingredient, 'Gin');
  assert.equal(res.body.recipe_review, 'draft');
});

test('cocktails PUT: explicit reviewed sticks; later edits do not demote', async () => {
  const reviewed = await request('PUT', '/api/cocktails/potions-test-fizz', { recipe_review: 'reviewed' });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.recipe_review, 'reviewed');
  const edited = await request('PUT', '/api/cocktails/potions-test-fizz', {
    ingredients: [{ ingredient: 'Gin', amount: 2, unit: 'oz' }],
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.recipe_review, 'reviewed', 'editing a reviewed recipe never demotes');
  const badReview = await request('PUT', '/api/cocktails/potions-test-fizz', { recipe_review: 'perfect' });
  assert.equal(badReview.status, 400);
});

test('public GET /api/cocktails excludes recipe_review, keeps ingredients', async () => {
  const res = await request('GET', '/api/cocktails', undefined, null);
  assert.equal(res.status, 200);
  const sample = res.body.cocktails[0];
  assert.ok(sample, 'public list non-empty');
  assert.ok(!('recipe_review' in sample), 'recipe_review trimmed from public payload');
  assert.ok('ingredients' in sample, 'ingredients stay public (accepted spec decision)');
});

test('unauthenticated potions requests are rejected', async () => {
  const res = await request('GET', '/api/potions/pars', undefined, null);
  assert.equal(res.status, 401);
});
