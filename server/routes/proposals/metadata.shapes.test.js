// LAW-shape guard (spec §12: "LAW endpoint shapes asserted unchanged"). The two
// metrics endpoints — GET /api/proposals/dashboard-stats and /financials — are
// contracts the Money Board reskin composes over WITHOUT changing. This suite
// freezes their exact top-level key sets (and the money-critical nested shapes)
// so any accidental add/remove of a response field fails loudly here.
//
// Harness mirrors crud.test.js: minimal express() app, real `metadata` router +
// real auth, driven over node http against the dev DB (DATABASE_URL from .env).
// No seeding — the endpoints return their aggregate shapes off whatever rows the
// dev DB holds; these tests assert SHAPE, not values.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const metadataRouter = require('./metadata');

let server;
let baseUrl;
let token;

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
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const keys = (o) => Object.keys(o).sort();

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

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', metadataRouter);
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
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ─── dashboard-stats LAW shape ───────────────────────────────────────────────
test('dashboard-stats top-level shape is frozen', async () => {
  const res = await request('GET', '/api/proposals/dashboard-stats');
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(
    keys(res.body),
    ['archivedCount', 'filters', 'funnel', 'money', 'paidCount', 'pipeline', 'revenue'],
    'dashboard-stats top-level keys must not drift'
  );
  assert.deepEqual(
    keys(res.body.money),
    ['basis', 'deltaPct', 'outstanding', 'outstandingDeltaPct', 'outstandingPrior', 'priorValue', 'value'],
    'money block shape must not drift'
  );
  assert.deepEqual(
    keys(res.body.funnel),
    ['accepted', 'lostValue', 'pipelineOutstanding', 'sent', 'timeToAcceptMedianDays', 'winRate'],
    'funnel block shape must not drift'
  );
});

// ─── financials LAW shape ────────────────────────────────────────────────────
test('financials top-level shape is frozen', async () => {
  const res = await request('GET', '/api/proposals/financials');
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(
    keys(res.body),
    ['filters', 'pagination', 'proposals', 'recentPayments', 'summary'],
    'financials top-level keys must not drift'
  );
  assert.deepEqual(
    keys(res.body.summary),
    ['avgEvent', 'booked', 'collected', 'leadSpend', 'outstanding', 'unlinkedRefundsCents'],
    'summary block shape must not drift'
  );
});
