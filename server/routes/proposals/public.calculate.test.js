// Route-level test for POST /api/proposals/public/calculate (P4, fix #8).
// The public preview response IS the calculateProposal snapshot, so the new
// billed_guests / floor_reason / floor_applied fields must flow through the HTTP
// boundary untouched (P8's compare matrix consumes them). Mirrors the harness in
// publicToken.test.js: a fresh express() app mounts the real public router + the
// AppError-aware error handler, driven over real HTTP. Runs against the dev DB
// (DATABASE_URL from .env); seeds one temp hosted package and purges it in after().

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicRouter = require('./public');

let server;
let baseUrl;
let pkgId;
const testSlug = `p4-calc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
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
  // Guarantee the P4 column exists regardless of whether the shared dev DB has
  // rebooted with the new schema.sql. Idempotent, mirrors the schema.sql ALTER.
  await pool.query('ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS min_billed_guests INTEGER');

  // Base Compound-like hosted package: standard $18/g, small $23/g, min_billed 25,
  // $550 floor. A 10-guest event bills as 25 heads -> 25 x $23 = $575 (guest_min).
  const pkg = await pool.query(
    `INSERT INTO service_packages
       (slug, name, category, pricing_type, bar_type,
        base_rate_4hr, base_rate_4hr_small, extra_hour_rate, extra_hour_rate_small,
        min_guests, min_billed_guests, min_total, is_active)
     VALUES ($1, 'P4 Calc Test', 'hosted', 'per_guest', 'full_bar',
        18, 23, 5, 5, 50, 25, 550, true)
     RETURNING id`,
    [testSlug]
  );
  pkgId = pkg.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicRouter);
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
  if (pkgId) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkgId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('calculate exposes billed_guests / floor_reason / floor_applied for a 10-guest hosted event', async () => {
  const res = await request('POST', '/api/proposals/public/calculate', {
    body: { package_id: pkgId, guest_count: 10, duration_hours: 4, num_bars: 0 },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.billed_guests, 25);
  assert.equal(res.body.floor_reason, 'guest_min');
  assert.equal(res.body.floor_applied, true);
  assert.equal(res.body.package.base_cost, 575); // 25 heads x $23 small rate
  // Staffing stays keyed on ACTUAL guests (1 bartender for 10), not billed 25.
  assert.equal(res.body.inputs.guestCount, 10);
  assert.equal(res.body.staffing.required, 1);
});

test('calculate reports no floor for a 60-guest hosted event above both minimums', async () => {
  // 60 >= min_guests (50) -> standard $18 rate; 60 x $18 = $1080, above both floors.
  const res = await request('POST', '/api/proposals/public/calculate', {
    body: { package_id: pkgId, guest_count: 60, duration_hours: 4, num_bars: 0 },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
  assert.equal(res.body.billed_guests, 60);
  assert.equal(res.body.floor_reason, null);
  assert.equal(res.body.floor_applied, false);
  assert.equal(res.body.package.base_cost, 1080); // 60 x $18 standard rate
});