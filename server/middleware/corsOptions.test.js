// The browser-facing CORS policy. Regression for the staff-portal bar-menu
// download (2026-08-25): the API lives on a different origin from the portal
// (Render vs Vercel), and Content-Disposition is not a CORS-safelisted
// response header, so without an explicit expose the client could never read
// the server's filename and saved a PNG menu as bar-menu.pdf.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { corsDelegate } = require('./corsOptions');

const ALLOWED = 'https://staff.drbartender.com';
let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(cors(corsDelegate((origin) => origin === ALLOWED)));
  app.get('/file', (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="bar-menu-1.png"');
    res.send('x');
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => server.close(resolve)));

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + path, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

test('an allowed browser origin can read Content-Disposition', async () => {
  const res = await get('/file', { Origin: ALLOWED });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], ALLOWED);
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
  const exposed = (res.headers['access-control-expose-headers'] || '').toLowerCase();
  assert.ok(exposed.split(/\s*,\s*/).includes('content-disposition'),
    `expected Content-Disposition in Access-Control-Expose-Headers, got "${exposed}"`);
});

test('an origin-less caller (webhooks, health probes) gets no CORS headers at all', async () => {
  const res = await get('/file');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers['access-control-expose-headers'], undefined);
});

test('a disallowed origin is refused', async () => {
  const res = await get('/file', { Origin: 'https://evil.example' });
  assert.equal(res.status, 500);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
