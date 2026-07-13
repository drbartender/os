// Route-level tests for GET /api/proposals/metrics-split (lane splitby-a,
// task A1.1/A1.2). The split endpoint groups the funnel's sent/accepted math by
// lead source or by event type, with query-time vocabulary normalization so the
// twin event-type vocabularies (native slug `wedding-reception` + Thumbtack
// human string "Wedding Reception") merge into ONE segment.
//
// HARNESS: mirrors crud.filters.test.js — no supertest/jest in this repo, so this
// stands up a minimal express() app mounting the real `metricsSplit` router +
// real `auth` + the same AppError-aware error handler as server/index.js, driven
// over node's built-in http against the dev DB (DATABASE_URL from .env).
//
// ISOLATION: every seed lives in a FAR-FUTURE window (year 2099) so real dev-DB
// rows can never pollute the exact per-segment counts (the endpoint has no
// client scope; it aggregates the whole proposals table for the range). Two
// distinct 2099 months keep the main-assertion seeds and the cap-test seeds from
// interfering. All rows are native (source/cc untouched), so the endpoint's
// native-only math reconciles 1:1 with qAccepted's native leg.
//
// RECONCILIATION CONTRACT (the point of the lane): the sum of every returned
// segment's won.count (INCLUDING the __other rollup) must equal qAccepted's
// native-leg count on the same range — the per-segment predicates mirror
// qSent/qAccepted/qWinRate exactly.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const metrics = require('../../utils/metricsQueries');
const splitRouter = require('./metricsSplit');

// ── Main window: isolated far-future month ────────────────────────────────
const FROM = '2099-06-01';
const TO = '2099-06-30';
const RANGE = `from=${FROM}&to=${TO}`;
// ── Cap window: a second isolated far-future month ────────────────────────
const CAP_FROM = '2099-07-01';
const CAP_TO = '2099-07-31';
const CAP_RANGE = `from=${CAP_FROM}&to=${CAP_TO}`;

let server;
let baseUrl;
let token;
let clientId;

const createdProposalIds = new Set();

function request(method, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { Authorization: `Bearer ${token}` },
      },
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

// Direct insert (no POST — pins sent_at/accepted_at/status/source/event_type).
async function seed({ status, sentAt = null, acceptedAt = null, eventDate = null,
  source = null, eventType = null, total = 0, paid = 0 }) {
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, status, sent_at, accepted_at, event_date, source,
        event_type, total_price, amount_paid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [clientId, status, sentAt, acceptedAt, eventDate, source, eventType, total, paid]
  );
  const id = r.rows[0].id;
  createdProposalIds.add(id);
  return id;
}

// Segment lookup helper.
const segOf = (body, key) => (body.segments || []).find((s) => s.key === key);
const wonCountSum = (body) => (body.segments || []).reduce((n, s) => n + s.won.count, 0);

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

  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Split Test Client', `split+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  clientId = c.rows[0].id;

  // ── Main-window seeds (2099-06) ──
  // A + B: twin vocabularies → merge into ONE `wedding-reception` segment.
  await seed({ status: 'accepted', sentAt: '2099-06-05', acceptedAt: '2099-06-10',
    eventType: 'wedding-reception', total: 1000 });                         // A
  await seed({ status: 'deposit_paid', sentAt: '2099-06-06', acceptedAt: '2099-06-11',
    eventType: 'Wedding Reception', total: 2000 });                         // B (human string)
  // C + D: NULL and whitespace-only → both bucket to `__untyped`, sent-only.
  await seed({ status: 'sent', sentAt: '2099-06-07', eventType: null, total: 500 });   // C
  await seed({ status: 'sent', sentAt: '2099-06-08', eventType: '   ', total: 300 });  // D
  // E: thumbtack-source accepted row (source split + a won segment).
  await seed({ status: 'accepted', sentAt: '2099-06-09', acceptedAt: '2099-06-12',
    source: 'thumbtack', eventType: 'birthday-party', total: 1500 });       // E
  // F: accepted-then-archived → won axis STILL counts it (no status filter),
  //    but it drops OUT of the qWinRate cohort (status <> 'archived').
  await seed({ status: 'archived', sentAt: '2099-06-04', acceptedAt: '2099-06-14',
    eventType: 'corporate-event', total: 4000 });                          // F

  // ── Cap-window seeds (2099-07): 14 distinct types. 12 "big" (2 sent rows
  //    each) + 2 "small" (1 sent row each). Order-by-sent-desc keeps the 12 big,
  //    rolls the 2 small into __other — deterministic despite in-tier ties. ──
  for (let i = 1; i <= 12; i += 1) {
    const t = `captype-${String(i).padStart(2, '0')}`;
    await seed({ status: 'sent', sentAt: '2099-07-05', eventType: t, total: 100 });
    await seed({ status: 'sent', sentAt: '2099-07-06', eventType: t, total: 100 });
  }
  for (let i = 13; i <= 14; i += 1) {
    const t = `captype-${String(i).padStart(2, '0')}`;
    await seed({ status: 'sent', sentAt: '2099-07-07', eventType: t, total: 100 });
  }

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', splitRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
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
  if (createdProposalIds.size > 0) {
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [[...createdProposalIds]]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── by=event_type: twin vocabularies merge ──────────────────────────────────
test('by=event_type merges native slug + human string into one segment', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=event_type&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.by, 'event_type');
  const wr = segOf(res.body, 'wedding-reception');
  assert.ok(wr, 'wedding-reception segment exists');
  assert.equal(wr.sent.count, 2, 'A + "Wedding Reception" B merged: sent.count');
  assert.equal(wr.sent.value, 3000, 'merged sent.value');
  assert.equal(wr.won.count, 2, 'merged won.count');
  assert.equal(wr.won.value, 3000, 'merged won.value');
  assert.equal(wr.closeRatePct, 100, 'merged close rate');
  assert.equal(wr.pending, 0, 'merged pending');
  // No separate human-string key survives normalization.
  assert.ok(!segOf(res.body, 'Wedding Reception'), 'no un-normalized twin key');
});

// ─── __untyped bucketing (NULL + whitespace) ─────────────────────────────────
test('by=event_type buckets NULL and whitespace-only into __untyped', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=event_type&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const u = segOf(res.body, '__untyped');
  assert.ok(u, '__untyped segment exists');
  assert.equal(u.sent.count, 2, 'NULL (C) + whitespace (D) both bucket to __untyped');
  assert.equal(u.sent.value, 800, '__untyped sent.value');
  assert.equal(u.won.count, 0, '__untyped has no wins');
  assert.equal(u.pending, 2, '__untyped pending (both sent, neither accepted, neither archived)');
  assert.equal(u.closeRatePct, 0, '__untyped close rate 0');
});

// ─── won uses accepted_at axis with NO status filter ─────────────────────────
test('won axis counts an accepted-then-archived row; close-rate cohort excludes it', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=event_type&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const ce = segOf(res.body, 'corporate-event');
  assert.ok(ce, 'corporate-event segment exists');
  assert.equal(ce.won.count, 1, 'archived-but-accepted row still counts as won (mirrors qAccepted)');
  assert.equal(ce.won.value, 4000, 'won value includes the archived win');
  assert.equal(ce.closeRatePct, 0, 'archived row drops out of the win-rate cohort (status <> archived)');
  assert.equal(ce.pending, 0, 'archived row is not pending either');
});

// ─── by=source keys + counts ─────────────────────────────────────────────────
test('by=source returns thumbtack + direct with correct counts/values', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=source&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.by, 'source');
  const tt = segOf(res.body, 'thumbtack');
  const dir = segOf(res.body, 'direct');
  assert.ok(tt, 'thumbtack segment exists');
  assert.ok(dir, 'direct segment exists (NULL source → direct)');
  assert.equal(tt.sent.count, 1, 'thumbtack sent.count');
  assert.equal(tt.won.count, 1, 'thumbtack won.count');
  assert.equal(dir.sent.count, 5, 'direct sent.count (A,B,C,D,F)');
  assert.equal(dir.sent.value, 7800, 'direct sent.value');
  assert.equal(dir.won.count, 3, 'direct won.count (A,B,F)');
  assert.equal(dir.won.value, 7000, 'direct won.value');
  assert.equal(dir.closeRatePct, 40, 'direct close rate = round(2/5*100)');
  assert.equal(dir.pending, 2, 'direct pending (C,D)');
});

// ─── reconciliation: Σ won.count === qAccepted native-leg count ──────────────
test('reconciliation: segment won.count sum === qAccepted native-leg count (event_type)', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=event_type&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const q = metrics.qAccepted({ from: FROM, to: TO, basis: 'booked', includeCc: 'exclude' });
  const r = await pool.query(q.sql, q.params);
  assert.equal(wonCountSum(res.body), r.rows[0].count,
    'Σ segment won.count (incl __other) === qAccepted native count');
});

test('reconciliation: segment won.count sum === qAccepted native-leg count (source)', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=source&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const q = metrics.qAccepted({ from: FROM, to: TO, basis: 'booked', includeCc: 'exclude' });
  const r = await pool.query(q.sql, q.params);
  assert.equal(wonCountSum(res.body), r.rows[0].count,
    'Σ segment won.count (incl __other) === qAccepted native count');
});

// ─── cap + rollup ────────────────────────────────────────────────────────────
test('by=event_type caps at 12 segments and rolls the remainder into __other', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=event_type&${CAP_RANGE}`);
  assert.equal(res.status, 200, res.raw);
  const real = res.body.segments.filter((s) => s.key !== '__other');
  const other = segOf(res.body, '__other');
  assert.equal(real.length, 12, 'exactly 12 real segments kept');
  assert.ok(other, '__other rollup row present');
  assert.equal(res.body.segments.length, 13, '12 kept + 1 __other');
  assert.ok(res.body.truncated, 'truncated populated');
  assert.equal(res.body.truncated.segments, 2, 'two segments rolled up');
  assert.equal(res.body.truncated.sent, 2, 'rolled-up sent count (2 small types × 1 sent each)');
  assert.equal(other.sent.count, 2, '__other aggregates the rolled-up sent count');
});

test('by=source never truncates (few keys)', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=source&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.truncated, null, 'source split never hits the cap');
});

// ─── param validation ────────────────────────────────────────────────────────
test('by=bogus is a 400 ValidationError', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=bogus&${RANGE}`);
  assert.equal(res.status, 400, res.raw);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('missing by is a 400 ValidationError', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?${RANGE}`);
  assert.equal(res.status, 400, res.raw);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

// ─── malformed dates ignored (no 500) ────────────────────────────────────────
test('malformed from/to ignored, no 500', async () => {
  const res = await request('GET', '/api/proposals/metrics-split?by=event_type&from=2099-13-99&to=notadate');
  assert.equal(res.status, 200, `malformed range must not 500: ${res.raw}`);
  assert.ok(Array.isArray(res.body.segments), 'segments is an array');
  assert.equal(res.body.filters.from, null, 'malformed from becomes null');
  assert.equal(res.body.filters.to, null, 'malformed to becomes null');
});

// ─── response shape ──────────────────────────────────────────────────────────
test('response shape: by, filters, segments, truncated', async () => {
  const res = await request('GET', `/api/proposals/metrics-split?by=event_type&${RANGE}`);
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(Object.keys(res.body).sort(), ['by', 'filters', 'segments', 'truncated']);
  assert.deepEqual(res.body.filters, { from: FROM, to: TO });
  const seg = res.body.segments[0];
  assert.deepEqual(Object.keys(seg).sort(), ['closeRatePct', 'key', 'pending', 'sent', 'won']);
  assert.deepEqual(Object.keys(seg.sent).sort(), ['count', 'value']);
  assert.deepEqual(Object.keys(seg.won).sort(), ['count', 'value']);
});
