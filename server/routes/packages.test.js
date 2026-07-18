// Route tests for lane pp2-core: the admin package-model router (contents
// CRUD, slots, makeability, directional margin) plus the drink dossier
// fields on the cocktails router (enhancements / syrup_id / batchable /
// hosted_visible validation and clearing).
//
// Harness per server/routes/potions.test.js: real routers + real auth on a
// fresh express() app over node http, against the dev DB, every created row
// cleaned up in after(). Run ALONE (shared dev DB):
//   node -r dotenv/config --test server/routes/packages.test.js
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
let pkgId;
const createdParIds = [];
const createdCocktailIds = [];
const createdItemIds = [];

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
  app.use('/api/admin/packages', require('./packages'));
  app.use('/api/cocktails', require('./cocktails'));
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
    [`packages-test-${Date.now()}@example.com`]
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET
  );

  // Isolated test package (hosted per_guest, priced like Formula No. 5).
  const p = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        extra_hour_rate, min_total, min_billed_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'PP2 Test Package', 'hosted', 'per_guest', 33, 39, 9, 550, 25, 100, 'full_bar', '[]')
     RETURNING id`,
    [`pp2-test-${Date.now()}`]
  );
  pkgId = p.rows[0].id;

  // Two par rows with costs + aliases; one alias-only row without cost.
  const parSeed = [
    ['pp2t-tequila', 'PP2T Tequila', '1.75L', 4, 'liquorBeerWine', 'spirit', 'tequila', ['pp2t tequila'], 40],
    ['pp2t-lime', 'PP2T Lime Juice', 'qt', 2, 'everythingElse', 'mixer', null, ['pp2t lime juice', 'pp2t lime'], 5],
    ['pp2t-coffee', 'PP2T Coffee Liqueur', '750mL', 1, 'liquorBeerWine', 'spirit', null, ['pp2t coffee liqueur'], null],
  ];
  for (const [id, item, size, qty, section, role, spiritKey, aliases, cost] of parSeed) {
    await pool.query(
      `INSERT INTO par_items (id, item, size, qty_per_100, section, role, spirit_key, ingredient_aliases, in_full_bar, is_active, cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true, $9)`,
      [id, item, size, qty, section, role, spiritKey, aliases, cost]
    );
    createdParIds.push(id);
  }
});

after(async () => {
  if (createdItemIds.length) {
    await pool.query('DELETE FROM package_items WHERE id = ANY($1::int[])', [createdItemIds]);
  }
  if (pkgId) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkgId]);
  if (createdParIds.length) {
    await pool.query('DELETE FROM par_items WHERE id = ANY($1::text[])', [createdParIds]);
  }
  if (createdCocktailIds.length) {
    await pool.query('DELETE FROM cocktails WHERE id = ANY($1::text[])', [createdCocktailIds]);
  }
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('auth: no token is rejected', async () => {
  const res = await request('GET', '/api/admin/packages', undefined, null);
  assert.equal(res.status, 401);
});

test('contents CRUD: create, list on detail, update, split-par validation', async () => {
  const bad = await request('POST', `/api/admin/packages/${pkgId}/items`, {
    category: 'Tequila', par_per_100: 4, eligible_item_ids: ['nope-not-real'],
  });
  assert.equal(bad.status, 400);

  const created = await request('POST', `/api/admin/packages/${pkgId}/items`, {
    category: 'Tequila', par_per_100: 4, unit: 'btl', eligible_item_ids: ['pp2t-tequila'],
  });
  assert.equal(created.status, 201);
  createdItemIds.push(created.body.id);

  const lime = await request('POST', `/api/admin/packages/${pkgId}/items`, {
    category: 'Citrus', par_per_100: 2, unit: 'qt', eligible_item_ids: ['pp2t-lime'],
  });
  assert.equal(lime.status, 201);
  createdItemIds.push(lime.body.id);

  const detail = await request('GET', `/api/admin/packages/${pkgId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.items.length, 2);

  const updated = await request('PUT', `/api/admin/packages/${pkgId}/items/${created.body.id}`, {
    category: 'Tequila', par_per_100: 3, unit: 'btl', eligible_item_ids: ['pp2t-tequila'],
  });
  assert.equal(updated.status, 200);
  assert.equal(Number(updated.body.par_per_100), 3);
});

test('slots config: hard slots persist, bad kind rejected', async () => {
  const bad = await request('PUT', `/api/admin/packages/${pkgId}`, { slot_kind: 'loose' });
  assert.equal(bad.status, 400);
  const ok = await request('PUT', `/api/admin/packages/${pkgId}`, { slot_count: 2, slot_kind: 'hard' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.slot_count, 2);
  assert.equal(ok.body.slot_kind, 'hard');
});

test('partial PUT preserves slot config (fleet regression: is_active-only toggle must not wipe slots)', async () => {
  const toggled = await request('PUT', `/api/admin/packages/${pkgId}`, { is_active: true });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.slot_count, 2);
  assert.equal(toggled.body.slot_kind, 'hard');

  // Explicit null still clears.
  const cleared = await request('PUT', `/api/admin/packages/${pkgId}`, { slot_count: null, slot_kind: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.slot_count, null);
  assert.equal(cleared.body.slot_kind, null);

  // Restore for later tests.
  await request('PUT', `/api/admin/packages/${pkgId}`, { slot_count: 2, slot_kind: 'hard' });
});

test('makeability: covered vs unmakeable per package contents (the F5-citrus DoD case)', async () => {
  // A drink the package covers (tequila + lime are eligible via the items
  // created above) and one it cannot price (coffee liqueur has no class map).
  const marg = await request('POST', '/api/cocktails', {
    name: `PP2T Margarita ${Date.now()}`,
    ingredients: [
      { ingredient: 'pp2t tequila', amount: 2, unit: 'oz' },
      { ingredient: 'pp2t lime juice', amount: 1, unit: 'oz' },
    ],
  });
  assert.equal(marg.status, 201);
  createdCocktailIds.push(marg.body.id);

  const espresso = await request('POST', '/api/cocktails', {
    name: `PP2T Espresso ${Date.now()}`,
    ingredients: [{ ingredient: 'pp2t coffee liqueur', amount: 1, unit: 'oz' }],
  });
  assert.equal(espresso.status, 201);
  createdCocktailIds.push(espresso.body.id);

  const make = await request('GET', `/api/admin/packages/${pkgId}/makeability`);
  assert.equal(make.status, 200);
  const byId = Object.fromEntries(make.body.drinks.map((d) => [d.id, d]));
  assert.equal(byId[marg.body.id].status, 'covered');
  assert.equal(byId[espresso.body.id].status, 'unmakeable');

  // Delete the citrus row: the margarita falls out of tier (unpriced gap).
  const detail = await request('GET', `/api/admin/packages/${pkgId}`);
  const citrus = detail.body.items.find((i) => i.category === 'Citrus');
  const del = await request('DELETE', `/api/admin/packages/${pkgId}/items/${citrus.id}`);
  assert.equal(del.status, 200);
  const after1 = await request('GET', `/api/admin/packages/${pkgId}/makeability`);
  assert.equal(Object.fromEntries(after1.body.drinks.map((d) => [d.id, d]))[marg.body.id].status, 'unmakeable');
});

test('margin: directional math uses rates, pars, mean costs, and reports missing costs', async () => {
  const res = await request('GET', `/api/admin/packages/${pkgId}/margin?guests=100&hours=4&labor=35&supplies=1.25`);
  assert.equal(res.status, 200);
  assert.equal(res.body.directional, true);
  // 100 guests at the 50+ rate: 100 x $33 = $3300
  assert.equal(res.body.revenue, 3300);
  // Tequila row updated to par 3 x $40 = $120 (citrus row deleted above)
  assert.equal(res.body.liquor_cost, 120);
  // 1 bartender x (4 + 2)h x $35 = $210; supplies 100 x 1.25 = $125
  assert.equal(res.body.labor_cost, 210);
  assert.equal(res.body.supplies_cost, 125);
  assert.equal(res.body.margin, 3300 - 120 - 125 - 210);
});

test('margin: small-party rate and min_total floor apply', async () => {
  const res = await request('GET', `/api/admin/packages/${pkgId}/margin?guests=10&hours=4`);
  assert.equal(res.status, 200);
  // 10 guests bills at min_billed_guests 25 x small rate $39 = $975 > min_total 550
  assert.equal(res.body.revenue, 975);
});

test('dossier fields: enhancements + syrup round-trip, clear, and validation', async () => {
  const drink = await request('POST', '/api/cocktails', {
    name: `PP2T Dossier ${Date.now()}`,
    enhancements: [{ slug: 'smoke-bubble', pitch: 'Theater.', flavors: ['wood', 'lemon'] }],
    syrup_id: 'demerara',
    batchable: true,
    hosted_visible: false,
  });
  assert.equal(drink.status, 201);
  createdCocktailIds.push(drink.body.id);
  assert.equal(drink.body.enhancements.length, 1);
  assert.deepEqual(drink.body.enhancements[0].flavors, ['wood', 'lemon']);
  assert.equal(drink.body.syrup_id, 'demerara');
  assert.equal(drink.body.batchable, true);
  assert.equal(drink.body.hosted_visible, false);

  // Unrelated PUT leaves the dossier untouched (COALESCE / CASE guards).
  const rename = await request('PUT', `/api/cocktails/${drink.body.id}`, { description: 'renamed' });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.syrup_id, 'demerara');
  assert.equal(rename.body.enhancements.length, 1);

  // Explicit clears: [] empties enhancements, null clears syrup.
  const cleared = await request('PUT', `/api/cocktails/${drink.body.id}`, { enhancements: [], syrup_id: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.enhancements, []);
  assert.equal(cleared.body.syrup_id, null);

  // Validation: slug required, flavor caps enforced.
  const bad = await request('PUT', `/api/cocktails/${drink.body.id}`, { enhancements: [{ pitch: 'no slug' }] });
  assert.equal(bad.status, 400);
});
