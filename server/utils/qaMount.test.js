require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { mountQa } = require('./qaMount');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('qaMount.test.js refuses to run against production');
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function buildApp() {
  const app = express();
  app.use(express.json());
  mountQa(app);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function get(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

let prod, dev;

before(async () => {
  // Build the PROD app while NODE_ENV=production so mountQa sees prod and
  // never even require()s labrat.
  process.env.NODE_ENV = 'production';
  prod = await listen(buildApp());

  // Then a non-production app (mountQa mounts labrat here).
  process.env.NODE_ENV = 'test';
  dev = await listen(buildApp());

  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

after(async () => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (prod) await new Promise((r) => prod.server.close(r));
  if (dev) await new Promise((r) => dev.server.close(r));
  // labrat's require chain instantiates the pg Pool singleton; close it so the
  // test process exits cleanly even though we never issued a query.
  try { await pool.end(); } catch { /* pool never checked out a client */ }
});

test('F3: /api/qa is NOT mounted when NODE_ENV=production (endpoint 404s)', async () => {
  const r = await get(prod.baseUrl, '/api/qa/missions');
  assert.equal(r.status, 404, `expected 404 in prod, got ${r.status}`);
});

test('F3: /api/qa IS mounted outside production', async () => {
  const r = await get(dev.baseUrl, '/api/qa/missions');
  assert.equal(r.status, 200, `expected 200 outside prod, got ${r.status}`);
});
