// Route-level tests for POST /api/proposals/calculate — the admin pricing
// preview. No suite covered this endpoint before election-at-payment (spec
// 2026-08-03), which is why the gratuity_total derivation could sit here
// unexercised.
//
// Harness mirrors metadata.shapes.test.js: minimal express() app, the real
// `metadata` router + real auth middleware, driven over node http against the
// dev DB (DATABASE_URL from .env). No seeding — /calculate is a pure preview.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const metadataRouter = require('./metadata');

if (process.env.NODE_ENV === 'production') {
  throw new Error('metadata.calculate.test.js refuses to run against production');
}

let server;
let baseUrl;
let token;
let pkgId;

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = (body === null || body === undefined) ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
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
    if (payload) req.write(payload);
    req.end();
  });
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

  // A REAL active package, resolved not hardcoded. Deterministically ordered and
  // class packages excluded: a class booking can price with no bartender crew,
  // which zeroes the gratuity basis and would make the stored-rate preview
  // assertion below fail for the wrong reason. Dev also carries stray test
  // packages at sort_order 0, so order by id (stable, catalog-seeded first).
  const pkg = await pool.query(
    `SELECT id FROM service_packages
      WHERE is_active = true AND bar_type <> 'class'
      ORDER BY id LIMIT 1`
  );
  assert.ok(pkg.rows[0], 'test harness needs an active non-class service package');
  pkgId = pkg.rows[0].id;

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

test('POST /calculate ignores gratuity_total (election-at-payment)', async () => {
  const res = await request('POST', '/api/proposals/calculate', {
    body: { package_id: pkgId, guest_count: 50, duration_hours: 5,
            tip_jar: false, gratuity_total: 250 },
  });
  assert.equal(res.status, 200, res.raw);
  const snap = JSON.parse(res.raw);
  assert.ok(!snap.breakdown.some(l => l.label === 'Gratuity'),
    'an entered dollar total can no longer conjure a preview gratuity line');
});

test('POST /calculate previews the stored rate', async () => {
  const res = await request('POST', '/api/proposals/calculate', {
    body: { package_id: pkgId, guest_count: 50, duration_hours: 5,
            tip_jar: false, gratuity_rate: 50 },
  });
  assert.equal(res.status, 200, res.raw);
  const snap = JSON.parse(res.raw);
  const line = snap.breakdown.find(l => l.label === 'Gratuity');
  assert.ok(line, 'stored-rate preview keeps the Gratuity line');
  assert.ok(line.amount > 0);
});

// ─── Admin gratuity mandate preview (spec 2026-08-10) ────────────────────────

test('POST /calculate previews a draft mandate (rate derived, floor stamped)', async () => {
  const res = await request('POST', '/api/proposals/calculate', {
    body: { package_id: pkgId, guest_count: 50, duration_hours: 2,
            num_bartenders: 1, gratuity_mandate_total: 100 },
  });
  assert.equal(res.status, 200, res.raw);
  const snap = JSON.parse(res.raw);
  assert.equal(snap.gratuity.rate, 50, 'rate = 100 / (1 staff x 2h)');
  assert.equal(snap.gratuity.floor_rate, 50, 'floor stamped for the checkout seed');
  assert.equal(snap.gratuity.total, 100);
  assert.ok(snap.breakdown.some(l => l.label === 'Gratuity' && l.amount === 100));
});

test('POST /calculate with mandate null previews cleared', async () => {
  const res = await request('POST', '/api/proposals/calculate', {
    body: { package_id: pkgId, guest_count: 50, duration_hours: 2,
            num_bartenders: 1, gratuity_rate: 50, gratuity_mandate_total: null },
  });
  assert.equal(res.status, 200, res.raw);
  const snap = JSON.parse(res.raw);
  assert.equal(snap.gratuity.rate, 0, 'null mandate wins over the stored rate in preview');
  assert.equal(snap.gratuity.floor_rate, null);
  assert.ok(!snap.breakdown.some(l => l.label === 'Gratuity'));
});

test('POST /calculate absent mandate key keeps the legacy stored-rate path', async () => {
  const res = await request('POST', '/api/proposals/calculate', {
    body: { package_id: pkgId, guest_count: 50, duration_hours: 5,
            tip_jar: false, gratuity_rate: 60 },
  });
  assert.equal(res.status, 200, res.raw);
  const snap = JSON.parse(res.raw);
  assert.equal(snap.gratuity.rate, 60);
  assert.equal(snap.gratuity.floor_rate, null, 'no mandate = null floor');
});

test('POST /calculate rejects non-positive mandate dollars (parity with PATCH)', async () => {
  for (const bad of [0, -5]) {
    const res = await request('POST', '/api/proposals/calculate', {
      body: { package_id: pkgId, guest_count: 50, duration_hours: 2,
              num_bartenders: 1, gratuity_mandate_total: bad },
    });
    assert.equal(res.status, 400, `mandate ${bad} must 400, got ${res.status}: ${res.raw}`);
  }
});
