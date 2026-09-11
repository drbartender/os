// Route tests for the request-alias append endpoint (lane custom-request-match):
// POST /api/cocktails/:id/request-aliases and its mocktails twin. An admin
// matches a client-typed custom drink request to an EXISTING drink by
// remembering the client's text as an alias on that drink, so the shopping-list
// matcher resolves the same text from then on instead of minting a duplicate
// recipe.
//
// Harness per potions.test.js: real routers + real auth on a fresh express()
// app over node http, against the dev DB, every created row cleaned up in
// after() by recorded id. Run ALONE (shared dev DB):
//   node --test server/routes/requestAliases.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { loadRecipeCandidates, matchCustomNames } = require('../utils/shoppingListGen');

let server;
let baseUrl;
let adminToken;
let adminId;

// Unique per run so a parallel window's run can never collide on ids or names.
const P = `rqa-${Date.now()}`;
const OLD_FASHIONED = { id: `${P}-old-fashioned`, name: `${P} Old Fashioned` };
const PALOMA = { id: `${P}-paloma`, name: `${P} Paloma`, alias: `${P} grapefruit tequila thing` };
const DRAFT = { id: `${P}-draft`, name: `${P} moscow mule` }; // Add-recipe leftover: no recipe, aliases itself
// Sorts BEFORE Old Fashioned in candidate order and carries Old Fashioned's
// NAME as an alias (only reachable via POST / or the documented race): the
// 409 must still name Old Fashioned, the drink the matcher would resolve to.
const ALIAS_HOLDER = { id: `${P}-alias-holder`, name: `${P} Alias Holder` };
const CAPPED = { id: `${P}-capped`, name: `${P} Capped` };
const NOJITO = { id: `${P}-nojito`, name: `${P} Nojito` };
const createdCocktailIds = [];
const createdMocktailIds = [];

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

const aliasesOf = async (table, id) => {
  const r = await pool.query(`SELECT request_aliases FROM ${table} WHERE id = $1`, [id]);
  return r.rows[0].request_aliases;
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cocktails', require('./cocktails'));
  app.use('/api/mocktails', require('./mocktails'));
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
    [`${P}@example.com`]
  );
  adminId = u.rows[0].id;
  adminToken = jwt.sign(
    { userId: adminId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET
  );

  // Off-menu drinks so the public planner never sees them. Old Fashioned
  // carries a recipe so it is a matcher candidate; the others do not need one.
  const capAliases = Array.from({ length: 20 }, (_, i) => `${P} cap alias ${i + 1}`);
  await pool.query(
    `INSERT INTO cocktails (id, name, is_active, ingredients, request_aliases) VALUES
       ($1, $2, false, '["2 oz bourbon"]'::jsonb, '{}'),
       ($3, $4, false, '["2 oz tequila"]'::jsonb, $5::text[]),
       ($6, $7, false, NULL, $8::text[]),
       ($9, $10, false, NULL, $11::text[]),
       ($12, $13, false, '["1 oz gin"]'::jsonb, $14::text[])`,
    [OLD_FASHIONED.id, OLD_FASHIONED.name,
      PALOMA.id, PALOMA.name, [PALOMA.alias],
      CAPPED.id, CAPPED.name, capAliases,
      DRAFT.id, DRAFT.name, [DRAFT.name],
      ALIAS_HOLDER.id, ALIAS_HOLDER.name, [OLD_FASHIONED.name]]
  );
  createdCocktailIds.push(OLD_FASHIONED.id, PALOMA.id, CAPPED.id, DRAFT.id, ALIAS_HOLDER.id);
  await pool.query(
    `INSERT INTO mocktails (id, name, is_active, request_aliases) VALUES ($1, $2, false, '{}')`,
    [NOJITO.id, NOJITO.name]
  );
  createdMocktailIds.push(NOJITO.id);
});

after(async () => {
  if (createdCocktailIds.length) {
    await pool.query('DELETE FROM cocktails WHERE id = ANY($1::text[])', [createdCocktailIds]);
  }
  if (createdMocktailIds.length) {
    await pool.query('DELETE FROM mocktails WHERE id = ANY($1::text[])', [createdMocktailIds]);
  }
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('appends a trimmed alias and returns the updated drink', async () => {
  const res = await request('POST', `/api/cocktails/${OLD_FASHIONED.id}/request-aliases`, { alias: `  ${P} old fashion  ` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, OLD_FASHIONED.id);
  assert.deepEqual(res.body.request_aliases, [`${P} old fashion`]);
  assert.deepEqual(await aliasesOf('cocktails', OLD_FASHIONED.id), [`${P} old fashion`]);
});

test('the same alias in another case or apostrophe spelling is a no-op, not a duplicate', async () => {
  const upper = await request('POST', `/api/cocktails/${OLD_FASHIONED.id}/request-aliases`, { alias: `${P} OLD Fashion` });
  assert.equal(upper.status, 200, JSON.stringify(upper.body));
  assert.deepEqual(upper.body.request_aliases, [`${P} old fashion`]);
  const apos = await request('POST', `/api/cocktails/${OLD_FASHIONED.id}/request-aliases`, { alias: `${P} old fashi'on` });
  assert.equal(apos.status, 200);
  assert.deepEqual(apos.body.request_aliases, [`${P} old fashion`]);
});

test("the drink's own name as an alias is a no-op", async () => {
  const res = await request('POST', `/api/cocktails/${OLD_FASHIONED.id}/request-aliases`, { alias: OLD_FASHIONED.name.toLowerCase() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.request_aliases, [`${P} old fashion`]);
});

test('an appended alias resolves through the shopping-list matcher on the next generation', async () => {
  const candidates = await loadRecipeCandidates(pool);
  const { matched, needsRecipe } = matchCustomNames([`${P} Old Fashion`], candidates);
  assert.deepEqual(needsRecipe, []);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, OLD_FASHIONED.name);
  assert.deepEqual(matched[0].ingredients, ['2 oz bourbon']);
});

test("refuses an alias that is another drink's NAME, across tables, naming the drink", async () => {
  const res = await request('POST', `/api/mocktails/${NOJITO.id}/request-aliases`, { alias: OLD_FASHIONED.name.toUpperCase() });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.ok(res.body.error.includes(OLD_FASHIONED.name), res.body.error);
  assert.deepEqual(await aliasesOf('mocktails', NOJITO.id), []);
});

test("refuses an alias that is already another drink's alias, naming the drink", async () => {
  const res = await request('POST', `/api/cocktails/${OLD_FASHIONED.id}/request-aliases`, { alias: PALOMA.alias.toUpperCase() });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.ok(res.body.error.includes(PALOMA.name), res.body.error);
  assert.deepEqual(await aliasesOf('cocktails', OLD_FASHIONED.id), [`${P} old fashion`]);
});

test('a recipe-less draft that carries the text does not block matching it to a real drink', async () => {
  // Add recipe on "moscow mule" minted a draft named + aliased with that text,
  // then the admin closed the drawer without a recipe. The matcher never
  // considers recipe-less rows, so the draft cannot be what the text
  // resolves to; refusing here would dead-end the admin on the duplicate the
  // action exists to prevent.
  const res = await request('POST', `/api/cocktails/${OLD_FASHIONED.id}/request-aliases`, { alias: `${P} Moscow Mule` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.request_aliases.includes(`${P} Moscow Mule`));
  const candidates = await loadRecipeCandidates(pool);
  const { matched } = matchCustomNames([DRAFT.name], candidates);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, OLD_FASHIONED.name);
});

test('a drink at the 20-alias cap refuses a 21st', async () => {
  const res = await request('POST', `/api/cocktails/${CAPPED.id}/request-aliases`, { alias: `${P} cap alias 21` });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.ok(res.body.fieldErrors.alias);
  assert.equal((await aliasesOf('cocktails', CAPPED.id)).length, 20);
  const again = await request('POST', `/api/cocktails/${CAPPED.id}/request-aliases`, { alias: `${P} CAP ALIAS 7` });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.request_aliases.length, 20);
});

test('validates the alias: missing, non-string, blank, over 200 chars', async () => {
  const before = await aliasesOf('cocktails', OLD_FASHIONED.id);
  for (const body of [{}, { alias: 42 }, { alias: '   ' }, { alias: 'x'.repeat(201) }]) {
    const res = await request('POST', `/api/cocktails/${OLD_FASHIONED.id}/request-aliases`, body);
    assert.equal(res.status, 400, JSON.stringify({ body, res: res.body }));
    assert.ok(res.body.fieldErrors.alias, JSON.stringify(res.body));
  }
  assert.deepEqual(await aliasesOf('cocktails', OLD_FASHIONED.id), before);
});

test('404 for a drink that does not exist', async () => {
  const res = await request('POST', `/api/cocktails/${P}-nope/request-aliases`, { alias: `${P} nothing` });
  assert.equal(res.status, 404, JSON.stringify(res.body));
});

test('the mocktails twin appends the same way', async () => {
  const res = await request('POST', `/api/mocktails/${NOJITO.id}/request-aliases`, { alias: `${P} virgin mojito` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, NOJITO.id);
  assert.deepEqual(res.body.request_aliases, [`${P} virgin mojito`]);
});

test('requires auth', async () => {
  const before = await aliasesOf('cocktails', OLD_FASHIONED.id);
  const res = await request('POST', `/api/cocktails/${OLD_FASHIONED.id}/request-aliases`, { alias: `${P} anon` }, null);
  assert.equal(res.status, 401);
  assert.deepEqual(await aliasesOf('cocktails', OLD_FASHIONED.id), before);
});
