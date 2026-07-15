// Route-level tests for GET /api/proposals sort params (?sort=&?dir=).
//
// HARNESS NOTES
// -------------
// Mirrors crud.test.js: stands up a minimal express() app mounting the real
// `list` router with the real `auth` middleware, drives it over node http, and
// runs against the dev DB (DATABASE_URL from .env). It seeds its OWN four
// proposals under a random client-name TAG and passes ?search=<TAG> so the list
// is scoped to exactly those rows regardless of what else the shared dev DB
// holds — no vacuous / order-of-other-rows false green. Every seeded row is
// purged in after().
//
// The four fixtures (distinct totals; one NULL event_date) let us pin:
//   ?sort=total&dir=asc  -> ascending totals
//   ?sort=total          -> dir defaults to descending
//   ?sort=bogus          -> falls back to created_at DESC (here: newest-insert first)
//   ?sort=event_date     -> the NULL-date row lands LAST in BOTH directions

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const listRouter = require('./list');

let server;
let baseUrl;
let token;
const TAG = `SORTTEST-${crypto.randomBytes(5).toString('hex')}`;
// Seeded proposal ids, in insert order (A oldest → D newest).
let A; let B; let C; let D;
const createdProposalIds = [];
const createdClientIds = [];

function request(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Insert one client + one 'sent' proposal (active bucket) with a known total and
// event_date. Separate awaited inserts give each row a strictly later created_at,
// so the created_at-DESC fallback order is deterministic (newest insert first).
async function seed(label, totalPrice, eventDate) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [`${TAG} Client ${label}`, `${TAG.toLowerCase()}+${label}@example.test`]
  );
  createdClientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, event_date, event_type)
     VALUES ($1, 'sent', $2, $3, 'sort-test') RETURNING id`,
    [c.rows[0].id, totalPrice, eventDate]
  );
  createdProposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

before(async () => {
  const users = await pool.query(
    `SELECT id, COALESCE(token_version, 0) AS token_version
       FROM users WHERE role IN ('admin', 'manager') ORDER BY id LIMIT 1`
  );
  assert.ok(users.rows[0], 'test harness needs an admin/manager user in the dev DB');
  token = jwt.sign(
    { userId: users.rows[0].id, tokenVersion: users.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Totals chosen out of insert order so a "sorted" result cannot accidentally
  // match "insert order". Event dates: one NULL (C) to test NULLS LAST.
  A = await seed('A', 100, '2026-01-01');
  B = await seed('B', 300, '2026-03-01');
  C = await seed('C', 200, null);
  D = await seed('D', 400, '2026-02-01');

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', listRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (createdProposalIds.length) {
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [createdProposalIds]);
  }
  if (createdClientIds.length) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('?sort=total&dir=asc → ascending total_price', async () => {
  const res = await request(`/api/proposals?search=${TAG}&sort=total&dir=asc`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const totals = res.body.map((r) => Number(r.total_price));
  assert.deepEqual(totals, [100, 200, 300, 400], `got ${JSON.stringify(totals)}`);
  // Guard against a false-green from an empty/mis-scoped result set.
  assert.equal(res.body.length, 4, 'the search TAG must scope to exactly the 4 seeded rows');
});

test('?sort=total with no dir → defaults to descending', async () => {
  const res = await request(`/api/proposals?search=${TAG}&sort=total`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const totals = res.body.map((r) => Number(r.total_price));
  assert.deepEqual(totals, [400, 300, 200, 100], `got ${JSON.stringify(totals)}`);
});

test('?sort=bogus → falls back to created_at DESC (newest insert first)', async () => {
  const res = await request(`/api/proposals?search=${TAG}&sort=bogus`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  const ids = res.body.map((r) => r.id);
  // Insert order A,B,C,D → created_at ascending → DESC returns D,C,B,A.
  assert.deepEqual(ids, [D, C, B, A], `bogus sort must not reorder off the default; got ${JSON.stringify(ids)}`);
});

test('?sort=<Object.prototype key> → graceful fallback, not a 500', async () => {
  // SORT_COLUMNS[sort] resolves inherited members for these keys; the route must
  // treat them as unknown (created_at DESC fallback), never stringify them into SQL.
  for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const res = await request(`/api/proposals?search=${TAG}&sort=${encodeURIComponent(key)}`);
    assert.equal(res.status, 200, `?sort=${key} must fall back with 200, got ${res.status}: ${res.raw}`);
    const ids = res.body.map((r) => r.id);
    assert.deepEqual(ids, [D, C, B, A], `?sort=${key} must fall back to created_at DESC; got ${JSON.stringify(ids)}`);
  }
});

test('?sort=event_date → NULL event_date sorts LAST in both directions', async () => {
  const asc = await request(`/api/proposals?search=${TAG}&sort=event_date&dir=asc`);
  assert.equal(asc.status, 200, `expected 200, got ${asc.status}: ${asc.raw}`);
  const ascIds = asc.body.map((r) => r.id);
  assert.equal(ascIds[ascIds.length - 1], C, `asc: null-date row (C) must be last; got ${JSON.stringify(ascIds)}`);
  assert.deepEqual(ascIds, [A, D, B, C], `asc order by date should be A,D,B,C; got ${JSON.stringify(ascIds)}`);

  const desc = await request(`/api/proposals?search=${TAG}&sort=event_date&dir=desc`);
  assert.equal(desc.status, 200, `expected 200, got ${desc.status}: ${desc.raw}`);
  const descIds = desc.body.map((r) => r.id);
  assert.equal(descIds[descIds.length - 1], C, `desc: null-date row (C) must still be last; got ${JSON.stringify(descIds)}`);
  assert.deepEqual(descIds, [B, D, A, C], `desc order by date should be B,D,A,C; got ${JSON.stringify(descIds)}`);
});
