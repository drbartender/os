// Lab Notes publish date: a no-date publish stores today's Chicago date at UTC midnight, and same-day posts number by id.
require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `blogdate-${NONCE}@example.com`;
// 8pm Chicago on Nov 6 2026 (CST, UTC-6) is 02:00 UTC on Nov 7: the moment that
// used to land a no-date publish on the next day.
const CHICAGO_EVENING = Date.parse('2026-11-07T02:00:00.000Z');
const CHICAGO_DAY_AT_UTC_MIDNIGHT = '2026-11-06T00:00:00.000Z';
let server, baseUrl, token, userId;
const postIds = [];

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    }).on('error', reject);
  });
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function storedPublishedAt(id) {
  const r = await pool.query('SELECT published_at FROM blog_posts WHERE id = $1', [id]);
  return r.rows[0].published_at.toISOString();
}

before(async () => {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'admin', 'approved', 0) RETURNING id, token_version`,
    [EMAIL]
  );
  userId = u.rows[0].id;
  // Long-lived: the tests move the clock hours ahead of the signing moment.
  token = jwt.sign({ userId, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '30d' });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('./blog'));
  app.use('/api/blog', require('../blog'));
  app.use((err, _rq, res, _nx) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message });
  });
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => mock.timers.reset());

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (postIds.length) await pool.query('DELETE FROM blog_posts WHERE id = ANY($1::int[])', [postIds]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('create: a published post with no date gets the Chicago day at UTC midnight', async () => {
  mock.timers.enable({ apis: ['Date'], now: CHICAGO_EVENING });
  const res = await req('POST', '/api/admin/blog', {
    title: `Publish date create ${NONCE}`, body: '<p>x</p>', published: true,
  });
  assert.equal(res.status, 201);
  postIds.push(res.body.id);
  assert.equal(await storedPublishedAt(res.body.id), CHICAGO_DAY_AT_UTC_MIDNIGHT);
});

test('update: first publish with no date gets the Chicago day at UTC midnight', async () => {
  const draft = await req('POST', '/api/admin/blog', {
    title: `Publish date update ${NONCE}`, body: '<p>x</p>', published: false,
  });
  assert.equal(draft.status, 201);
  postIds.push(draft.body.id);
  assert.equal(draft.body.published_at, null);

  mock.timers.enable({ apis: ['Date'], now: CHICAGO_EVENING });
  const res = await req('PUT', `/api/admin/blog/${draft.body.id}`, {
    title: draft.body.title, slug: draft.body.slug, body: '<p>x</p>', published: true,
  });
  assert.equal(res.status, 200);
  assert.equal(await storedPublishedAt(draft.body.id), CHICAGO_DAY_AT_UTC_MIDNIGHT);
});

test('a typed date is stored as that day at UTC midnight, unchanged', async () => {
  const res = await req('POST', '/api/admin/blog', {
    title: `Publish date typed ${NONCE}`, body: '<p>x</p>', published: true, published_at: '2026-11-06',
  });
  assert.equal(res.status, 201);
  postIds.push(res.body.id);
  assert.equal(await storedPublishedAt(res.body.id), CHICAGO_DAY_AT_UTC_MIDNIGHT);
});

test('two posts on the same day get the same number on the index and their own page, lower id first', async () => {
  const day = '2099-01-02';
  const made = [];
  for (const n of [1, 2]) {
    const r = await req('POST', '/api/admin/blog', {
      title: `Same day ${n} ${NONCE}`, body: '<p>x</p>', published: true, published_at: day,
    });
    assert.equal(r.status, 201);
    postIds.push(r.body.id);
    made.push(r.body);
  }
  const list = await getJson('/api/blog?limit=100');
  assert.equal(list.status, 200);
  const numbers = {};
  for (const p of made) {
    const card = list.body.find((row) => row.id === p.id);
    assert.ok(card, 'post missing from the index');
    const page = await getJson(`/api/blog/${p.slug}`);
    assert.equal(page.status, 200);
    assert.equal(String(page.body.chapter_number), String(card.chapter_number), 'card and page disagree');
    numbers[p.id] = Number(card.chapter_number);
  }
  const [first, second] = made.map((p) => p.id).sort((a, b) => a - b);
  assert.equal(numbers[second], numbers[first] + 1);
  const order = list.body.map((row) => row.id);
  assert.ok(order.indexOf(second) < order.indexOf(first), 'newest-first list breaks the tie by id');
});
