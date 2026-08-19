require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { router, ASSETS } = require('./voiceAssets');

let _server = null;
let _baseUrl = null;

before(async () => {
  const app = express();
  app.use('/api/voice', router);
  await new Promise((resolve) => {
    _server = app.listen(0, () => { _baseUrl = `http://127.0.0.1:${_server.address().port}`; resolve(); });
  });
});
after(async () => { if (_server) await new Promise((r) => _server.close(r)); });

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${p}`, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('every allowlisted asset exists on disk and is a real mp3', async () => {
  // A missing file would 500 at Twilio mid-call, which sounds to the caller like
  // silence where a greeting should be. Catch it here, not on a live call.
  for (const [key, file] of Object.entries(ASSETS)) {
    const full = path.join(__dirname, '..', 'assets', file);
    assert.ok(fs.existsSync(full), `${key} -> ${file} must exist`);
    const head = fs.readFileSync(full).subarray(0, 3).toString('hex');
    assert.ok(head.startsWith('494433') || head.startsWith('fff'), `${file} must be mp3, got ${head}`);
  }
});

test('the legacy greeting path still serves, byte-for-byte', async () => {
  // VM_GREETING_URL defaults to this exact URL and production has fetched it
  // since 2026-07-24. Moving the route must not move the path.
  const res = await get('/api/voice/greeting.mp3');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /audio\/mpeg/);
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'assets', 'voicemail-greeting.mp3'));
  assert.ok(res.body.equals(onDisk), 'served bytes must equal the bundled file');
});

test('each new primary clip serves as audio/mpeg', async () => {
  for (const key of Object.keys(ASSETS)) {
    if (key === 'greeting.mp3') continue;
    const res = await get(`/api/voice/audio/${key}`);
    assert.equal(res.status, 200, `${key} should serve`);
    assert.match(res.headers['content-type'], /audio\/mpeg/);
    assert.ok(res.body.length > 1000, `${key} should have real audio bytes`);
  }
});

test('the name is a KEY, not a path: traversal is impossible', async () => {
  // The request never names a file. Anything not in the map is a 404, so no
  // value of :name can escape server/assets/ or reach an unpublished file.
  for (const probe of [
    '..%2F..%2F..%2Fetc%2Fpasswd',
    '..%2F..%2F.env',
    'voicemail-greeting.mp3', // the real filename is NOT a valid key
    'nope.mp3',
    // Inherited Object.prototype members. A bare ASSETS[key] returns truthy
    // NON-STRINGS for these, which sail past a falsy check and throw inside
    // path.join: an unauthenticated 500 that this app reports to Sentry, so one
    // request becomes one billed event. Not traversal, but not nothing.
    'constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty',
  ]) {
    const res = await get(`/api/voice/audio/${probe}`);
    assert.equal(res.status, 404, `${probe} must 404, never 500`);
    assert.doesNotMatch(res.body.toString('utf8').slice(0, 200), /root:|DATABASE_URL/);
  }
});
