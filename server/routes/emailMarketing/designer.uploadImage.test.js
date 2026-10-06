require('dotenv').config();
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const fileUpload = require('express-fileupload');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

// POST /api/email-marketing/upload-image re-encodes every designer image through
// sharp: width capped at 1088, EXIF orientation applied then stripped, the stored
// bytes and extension taken from the decoder, never the client. Nothing pinned it
// until the sharp 0.34 -> 0.35 major bump (2026-10-06), so these do. R2 is stubbed
// at the module boundary; the stored buffers are re-read with sharp.

const storagePath = require.resolve('../../utils/storage');
const realStorage = require('../../utils/storage');
const stored = [];
require.cache[storagePath].exports = {
  ...realStorage,
  uploadFile: async (buffer, filename) => { stored.push({ buffer, filename }); },
};
const router = require('./designer');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, adminToken, adminId, staffToken, staffId;

function upload(filename, bytes, token = adminToken) {
  const boundary = `----dsgimg${crypto.randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}/api/email-marketing/upload-image`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

const solid = (width, height) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } });

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1,'x','admin','approved') RETURNING id`, [`dsg-img-${NONCE}@mkt-test.example`]);
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  const s = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1,'x','staff','approved') RETURNING id`, [`dsg-img-staff-${NONCE}@mkt-test.example`]);
  staffId = s.rows[0].id;
  staffToken = jwt.sign({ userId: staffId, tokenVersion: 0 }, process.env.JWT_SECRET);
  const app = express();
  app.use(fileUpload());
  app.use('/api/email-marketing', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[adminId, staffId].filter(Boolean)]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('a wide PNG is stored as PNG, capped at 1088 px wide', async () => {
  const res = await upload('wide.png', await solid(2000, 400).png().toBuffer());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.url, /^\/api\/blog\/images\/email_[0-9a-f-]+\.png$/);
  const meta = await sharp(stored.at(-1).buffer).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 1088);
  assert.equal(meta.height, 218); // 400 * 1088/2000, aspect kept
});

test('a JPEG carrying EXIF orientation 6 is stored upright with the EXIF stripped', async () => {
  // 600x300 pixels tagged "rotate 90": the upright image is 300 wide, 600 tall.
  const tagged = await solid(600, 300).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  assert.equal((await sharp(tagged).metadata()).orientation, 6);
  const res = await upload('phone.jpg', tagged);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.url, /\.jpg$/);
  const meta = await sharp(stored.at(-1).buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 300);
  assert.equal(meta.height, 600);
  assert.equal(meta.orientation, undefined, 'orientation tag stripped');
  assert.equal(meta.exif, undefined, 'EXIF stripped');
});

test('a small WebP is stored as WebP and never enlarged', async () => {
  const res = await upload('small.webp', await solid(500, 500).webp().toBuffer());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.url, /\.webp$/);
  const meta = await sharp(stored.at(-1).buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 500);
});

test('the stored extension follows the decoder, not the client filename', async () => {
  const res = await upload('looks-like.jpg', await solid(100, 100).png().toBuffer());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.url, /\.png$/);
});

test('a PDF is refused before it reaches the decoder', async () => {
  const before = stored.length;
  const res = await upload('menu.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('not an image')]));
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.image);
  assert.equal(stored.length, before, 'nothing stored');
});

test('bytes that pass the magic check but do not decode are refused, nothing stored', async () => {
  const before = stored.length;
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(256)]);
  const res = await upload('broken.jpg', fakeJpeg);
  assert.equal(res.status, 400);
  assert.match(res.body.fieldErrors.image, /Could not process this image/);
  assert.equal(stored.length, before, 'nothing stored');
});

test('upload requires a login', async () => {
  const res = await upload('wide.png', await solid(10, 10).png().toBuffer(), null);
  assert.equal(res.status, 401);
});

test('a staff login is refused: upload is admin or manager only', async () => {
  const before = stored.length;
  const res = await upload('wide.png', await solid(10, 10).png().toBuffer(), staffToken);
  assert.equal(res.status, 403);
  assert.equal(stored.length, before, 'nothing stored');
});
