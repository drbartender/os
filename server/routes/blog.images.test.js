'use strict';
// The public blog image proxy serves only the blog and email-designer images
// (audit 2026-11-05 AUTH-06).
//
// GET /api/blog/images/:filename took any basename to getSignedUrl and
// streamed whatever R2 held under it if the content type was an image, and
// the bucket root also holds the staff headshots (`<userId>_headshot_<uuid>`),
// so a leaked headshot key was an unauthenticated download. The route now
// refuses, before any signing, every key without one of the three public
// prefixes (`blog_`, `email_`, `manual-art-`); every private root object
// starts with its owner's user id. Nothing is moved: the live hand-uploaded
// covers (`blog_p8-cover.webp`, `blog_<uuid>-opt.webp`) keep working.
//
// R2 never answers: the presign is stubbed on the storage exports BEFORE the
// router loads (blog.js destructures getSignedUrl at require time) and global
// fetch is swapped, the pattern of r2Proxy.test.js.

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const storage = require('../utils/storage');
const signedCalls = [];
storage.getSignedUrl = (key) => { signedCalls.push(key); return Promise.resolve(`https://r2.invalid/${key}`); };
const blogRouter = require('./blog');
const { AppError } = require('../utils/errors');

const { Response } = globalThis;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const fetched = [];
const realFetch = globalThis.fetch;

let server;
let base;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  globalThis.fetch = (url) => {
    fetched.push(String(url));
    return Promise.resolve(new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } }));
  };
  const app = express();
  app.use('/api/blog', blogRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

const uuid = () => crypto.randomUUID();

test('a staff headshot key is refused before any signing or fetch', async () => {
  signedCalls.length = 0; fetched.length = 0;
  const res = await get(`/api/blog/images/12_headshot_${uuid()}.jpg`);
  assert.equal(res.status, 404);
  assert.deepEqual(signedCalls, [], 'nothing was presigned');
  assert.deepEqual(fetched, [], 'nothing was fetched');
});

test('every other root object is refused the same way', async () => {
  signedCalls.length = 0; fetched.length = 0;
  const keys = [
    `7_w9_${uuid()}.pdf`,
    `7_alcohol_${uuid()}.pdf`,
    `7_resume_${uuid()}.pdf`,
    `7_app_resume_${uuid()}.pdf`,
    `7_basset_${uuid()}.pdf`,
    `staff/headshot/12/${uuid()}.jpg`, // basename-stripped to a bare uuid
    'blog_', 'email_', 'manual-art-',
    `BLOG_${uuid()}.png`, // the uploaders write lowercase
    `blogx_${uuid()}.png`,
    `manual-artx_${uuid()}.png`,
    `${uuid()}.png`,
    `menu-art/1/${uuid()}.png`,
  ];
  for (const key of keys) {
    const res = await get(`/api/blog/images/${encodeURIComponent(key)}`);
    assert.equal(res.status, 404, `${key} must be refused, got ${res.status}`);
  }
  assert.deepEqual(signedCalls, []);
  assert.deepEqual(fetched, []);
});

test('the live hand-uploaded shapes pass: the prefix is the security, not a uuid', async () => {
  // The shapes the published Lab Notes posts and the /vibes manual reference
  // on 2026-11-11 (55 blog keys, all with the blog_ prefix, none of them
  // blog_<uuid><ext>; the manual's art under manual-art-).
  const keys = ['blog_p8-cover.webp', 'blog_p8-1-32rule.webp', 'blog_wxtest-gpt-image-2.webp', `blog_${uuid()}-opt.webp`, `blog_${uuid().toUpperCase()}.png`, 'manual-art-book1-test.webp'];
  for (const key of keys) {
    signedCalls.length = 0; fetched.length = 0;
    const res = await get(`/api/blog/images/${encodeURIComponent(key)}`);
    assert.equal(res.status, 200, `${key} must pass, got ${res.status}`);
    assert.deepEqual(signedCalls, [key]);
  }
});

test('a stored key with an exotic extension still passes', async () => {
  // admin/blog.js stored path.extname(file.name) unsanitized until the
  // writer fix, so a cover's basename may carry any extension shape.
  const keys = [`blog_${uuid()}.final-v2`, `blog_${uuid()}.`, `blog_${uuid()}.${'x'.repeat(27)}`, `blog_${uuid()}.${'y'.repeat(32)}`, `email_${uuid()}.PNG`];
  for (const key of keys) {
    signedCalls.length = 0; fetched.length = 0;
    const res = await get(`/api/blog/images/${encodeURIComponent(key)}`);
    assert.equal(res.status, 200, `${key} must pass, got ${res.status}`);
    assert.deepEqual(signedCalls, [key]);
  }
});

test('a key with a backslash, whitespace, a parent step or over 200 characters after its prefix is refused', async () => {
  signedCalls.length = 0; fetched.length = 0;
  const keys = [`blog_${uuid()}.jpg\\x`, `blog_${uuid()}.a\tb`, `blog_${uuid()}.jpg (1)`, `blog_${uuid()}.jpg\n`, `blog_${uuid()}..jpg`, `blog_${uuid()}.a..b`, `blog_${'z'.repeat(201)}`, 'manual-art-..webp'];
  for (const key of keys) {
    const res = await get(`/api/blog/images/${encodeURIComponent(key)}`);
    assert.equal(res.status, 404, `${JSON.stringify(key)} must be refused, got ${res.status}`);
  }
  assert.deepEqual(signedCalls, []);
  assert.deepEqual(fetched, []);
});

test('a blog image and an email-designer image pass through to the signed URL and are proxied', async () => {
  for (const key of [`blog_${uuid()}.png`, `email_${uuid()}.jpg`, `blog_${uuid()}.JPEG`, `blog_${uuid()}`]) {
    signedCalls.length = 0; fetched.length = 0;
    const res = await get(`/api/blog/images/${key}`);
    assert.equal(res.status, 200, `${key}: ${res.body.toString()}`);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.ok(res.body.equals(PNG), 'the proxied bytes');
    assert.deepEqual(signedCalls, [key]);
    assert.deepEqual(fetched, [`https://r2.invalid/${key}`]);
  }
});
