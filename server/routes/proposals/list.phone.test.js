// Route-level tests for the phone mode of GET /api/proposals (lane ma-f1,
// spec 2026-08-13-mobile-admin section 5): the created_at sort key, the
// server-side ?unviewed=1 predicate and the ?envelope=1 body. The first test
// pins the LEGACY shape (bare array + X-Total-Count) so the desktop keeps
// working untouched.
//
// Harness mirrors list.sort.test.js: a minimal express() app mounting the real
// list router, driven over node http against the dev DB, fixtures tagged by a
// random TAG and scoped with ?search=<TAG>, every row purged in after().
//
// Fixtures (insert order A..G, so created_at ascends A -> G):
//   A draft,        event 2026-06-01, never sent
//   B sent,         event 2026-03-01, last_viewed_at NULL   (unviewed)
//   C viewed,       event 2026-01-01, last_viewed_at set, 3 views
//   D sent,         event NULL,       last_viewed_at NULL   (unviewed, no date)
//   E deposit_paid  (NOT in the active bucket)
//   F archived      (NOT in the active bucket)
//   G sent,         event 2026-04-01, last_viewed_at set, 1 view
//                   (NOT unviewed: status still 'sent' but opened, so it pins
//                   the never-opened half of the predicate)

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') throw new Error('refusing to run route tests against production');

const { pool } = require('../../db');
const listRouter = require('./list');

let server;
let baseUrl;
let token;
const TAG = `PHONELIST-${crypto.randomBytes(5).toString('hex')}`;
const ids = {};
const createdProposalIds = [];
const createdClientIds = [];

function request(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function seed(label, { status, eventDate, lastViewedAt = null, viewCount = 0, sentAt = null }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [`${TAG} Client ${label}`, `${TAG.toLowerCase()}+${label}@example.test`]
  );
  createdClientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, event_date, event_type, last_viewed_at, view_count, sent_at)
     VALUES ($1, $2, 1000, $3, 'phone-list-test', $4, $5, $6) RETURNING id`,
    [c.rows[0].id, status, eventDate, lastViewedAt, viewCount, sentAt]
  );
  createdProposalIds.push(p.rows[0].id);
  ids[label] = p.rows[0].id;
  return p.rows[0].id;
}

before(async () => {
  const users = await pool.query(
    `SELECT id, COALESCE(token_version, 0) AS token_version FROM users WHERE role IN ('admin', 'manager') ORDER BY id LIMIT 1`
  );
  assert.ok(users.rows[0], 'test harness needs an admin/manager user in the dev DB');
  token = jwt.sign({ userId: users.rows[0].id, tokenVersion: users.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const now = new Date().toISOString();
  await seed('A', { status: 'draft', eventDate: '2026-06-01' });
  await seed('B', { status: 'sent', eventDate: '2026-03-01', sentAt: now });
  await seed('C', { status: 'viewed', eventDate: '2026-01-01', lastViewedAt: now, viewCount: 3, sentAt: now });
  await seed('D', { status: 'sent', eventDate: null, sentAt: now });
  await seed('E', { status: 'deposit_paid', eventDate: '2026-02-01', sentAt: now });
  await seed('F', { status: 'archived', eventDate: '2026-02-02', sentAt: now });
  await seed('G', { status: 'sent', eventDate: '2026-04-01', lastViewedAt: now, viewCount: 1, sentAt: now });

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', listRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (createdProposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [createdProposalIds]);
  if (createdClientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const idsOf = (rows) => rows.map((r) => r.id);

test('legacy shape is untouched: no envelope = bare array, X-Total-Count, created_at DESC, active bucket', async () => {
  const res = await request(`/api/proposals?search=${TAG}`);
  assert.equal(res.status, 200, res.raw);
  assert.ok(Array.isArray(res.body), 'body must stay a bare array');
  assert.equal(res.headers['x-total-count'], '5');
  assert.deepEqual(idsOf(res.body), [ids.G, ids.D, ids.C, ids.B, ids.A], 'active bucket, newest insert first; E and F excluded');
  assert.equal(res.headers['access-control-expose-headers'], 'X-Total-Count');
});

test('?envelope=1 answers the phone body with the bucket totals', async () => {
  const res = await request(`/api/proposals?search=${TAG}&envelope=1`);
  assert.equal(res.status, 200, res.raw);
  assert.ok(!Array.isArray(res.body), 'envelope is an object');
  assert.deepEqual(idsOf(res.body.rows), [ids.G, ids.D, ids.C, ids.B, ids.A]);
  assert.deepEqual(
    { total: res.body.total, bucket_total: res.body.bucket_total, unviewed_total: res.body.unviewed_total, page: res.body.page, limit: res.body.limit, has_more: res.body.has_more },
    { total: 5, bucket_total: 5, unviewed_total: 2, page: 1, limit: 50, has_more: false }
  );
  assert.equal(res.headers['x-total-count'], '5', 'the header still rides the envelope');
});

test('?unviewed=1 keeps only sent-and-never-opened rows; the bucket totals do not move', async () => {
  const res = await request(`/api/proposals?search=${TAG}&envelope=1&unviewed=1`);
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(idsOf(res.body.rows), [ids.D, ids.B], 'C is viewed, A is a draft, G is sent but opened');
  assert.equal(res.body.total, 2);
  assert.equal(res.body.bucket_total, 5, 'bucket_total ignores the predicate');
  assert.equal(res.body.unviewed_total, 2);
  const bare = await request(`/api/proposals?search=${TAG}&unviewed=1`);
  assert.ok(Array.isArray(bare.body), 'the predicate works on the bare shape too');
  assert.deepEqual(idsOf(bare.body), [ids.D, ids.B]);
  assert.equal(bare.headers['x-total-count'], '2');
});

test('?sort=created_at is the fallback order made addressable, in both directions', async () => {
  const desc = await request(`/api/proposals?search=${TAG}&sort=created_at&dir=desc`);
  assert.equal(desc.status, 200, desc.raw);
  assert.deepEqual(idsOf(desc.body), [ids.G, ids.D, ids.C, ids.B, ids.A]);
  const asc = await request(`/api/proposals?search=${TAG}&sort=created_at&dir=asc`);
  assert.equal(asc.status, 200, asc.raw);
  assert.deepEqual(idsOf(asc.body), [ids.A, ids.B, ids.C, ids.D, ids.G]);
});

test('Event date order: soonest first, a blank date last', async () => {
  const res = await request(`/api/proposals?search=${TAG}&envelope=1&sort=event_date&dir=asc`);
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(idsOf(res.body.rows), [ids.C, ids.B, ids.G, ids.A, ids.D], 'D has no event_date and sorts last');
});

test('paging: has_more follows page * limit against total', async () => {
  const p1 = await request(`/api/proposals?search=${TAG}&envelope=1&limit=2&page=1`);
  assert.equal(p1.status, 200, p1.raw);
  assert.deepEqual(idsOf(p1.body.rows), [ids.G, ids.D]);
  assert.deepEqual({ has_more: p1.body.has_more, page: p1.body.page, limit: p1.body.limit, total: p1.body.total }, { has_more: true, page: 1, limit: 2, total: 5 });
  const p2 = await request(`/api/proposals?search=${TAG}&envelope=1&limit=2&page=2`);
  assert.equal(p2.status, 200, p2.raw);
  assert.deepEqual(idsOf(p2.body.rows), [ids.C, ids.B]);
  assert.equal(p2.body.has_more, true);
  const p3 = await request(`/api/proposals?search=${TAG}&envelope=1&limit=2&page=3`);
  assert.equal(p3.status, 200, p3.raw);
  assert.deepEqual(idsOf(p3.body.rows), [ids.A]);
  assert.equal(p3.body.has_more, false);
});

test('an envelope with an empty bucket reports zeros, not nulls', async () => {
  const res = await request(`/api/proposals?search=${TAG}-nothing-matches&envelope=1`);
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.body, { rows: [], total: 0, bucket_total: 0, unviewed_total: 0, page: 1, limit: 50, has_more: false });
});
