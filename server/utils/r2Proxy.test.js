process.env.NODE_ENV = 'test';

// r2Proxy (menu art spec 7): assertKeyUnder, and sendR2Object served from a
// minimal express app over real HTTP so the headers, the 304 and the error path
// are what a browser sees. R2 never answers: the presign is stubbed on the
// storage exports (readFile signs through module.exports) and global fetch is
// swapped per test, so the REAL readFile runs (behind a counting wrapper).
// Images are built with sharp. Every call names its prefix, as the routes must.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const sharp = require('sharp');

const { Response } = globalThis;

const storage = require('./storage');
const signedCalls = [];
storage.getSignedUrl = async (key) => { signedCalls.push(key); return `https://r2.invalid/${key}`; };
// r2Proxy reads through the storage exports, so this wrapper sees every read.
const realReadFile = storage.readFile;
const readCalls = [];
storage.readFile = (key, opts) => { readCalls.push(key); return realReadFile(key, opts); };

const { sendR2Object, assertKeyUnder, RESIZE_PIXEL_LIMIT, RESIZE_BYTE_LIMIT } = require('./r2Proxy');
const { AppError, NotFoundError, ExternalServiceError } = require('./errors');

let server;
let base;
let current = { key: null, opts: {} };
let lastError = null;

before(async () => {
  const app = express();
  // Express's own weak ETag would land on the JSON error bodies; off, so any
  // ETag a test sees was set by sendR2Object.
  app.set('etag', false);
  app.get('/obj', (req, res, next) => {
    sendR2Object(res, current.key, current.opts).catch(next);
  });
  // Mirrors the global error middleware's contract: status from the AppError.
  // The error is kept so a test can check its class (only ExternalServiceError
  // and non-AppErrors page Sentry there).
  app.use((err, _req, res, _next) => {
    lastError = err;
    res.status(err.statusCode || 500).json({ code: err.code || 'INTERNAL' });
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function get(headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/obj`, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withFetch(impl, fn) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => { calls.push(url); return impl(url, opts); };
  try { return await fn(calls); } finally { global.fetch = real; }
}

const serveBytes = (bytes, type) => () => new Response(bytes, { status: 200, headers: { 'content-type': type } });
const mustNotFetch = () => { throw new Error('must not fetch'); };

const ART = 'menu-art/7/';
const LOGO = 'drink-plan-logos/5-';

// menuPrintFile.js's formula, restated so a drift in either is caught here.
const etagOf = (input) => `"${crypto.createHash('sha256').update(input).digest('hex').slice(0, 32)}"`;

// A 1024x1024 drink layer: transparent everywhere but an opaque cream disc.
function drinkPng() {
  const disc = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">'
    + '<circle cx="512" cy="512" r="300" fill="#f3e6c8"/></svg>'
  );
  return sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: disc }])
    .png()
    .toBuffer();
}

function backgroundJpeg() {
  return sharp({ create: { width: 1280, height: 1600, channels: 3, background: { r: 40, g: 90, b: 70 } } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function pixelAlpha(png, x, y) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3];
}

// ── assertKeyUnder ───────────────────────────────────────────────────────────

test('assertKeyUnder: a key under its prefix passes', () => {
  assert.doesNotThrow(() => assertKeyUnder('menu-art/7/run-1/background-abc.jpg', 'menu-art/7/'));
  assert.doesNotThrow(() => assertKeyUnder('menu-art/7/ref-abc.png', 'menu-art/7/ref-'));
  assert.doesNotThrow(() => assertKeyUnder('drink-plan-logos/5-1700000000000.png', 'drink-plan-logos/5-'));
});

test('assertKeyUnder: a wrong prefix is NotFoundError, including a neighbor id', () => {
  const cases = [
    ['menu-print/7/abc.jpg', 'menu-art/7/'],
    ['12_w9_abc.png', 'menu-art/7/'],                          // a W-9
    ['menu-art/12/run/background.jpg', 'menu-art/1/'],         // event 12 under event 1
    ['drink-plan-logos/55-1700000000000.png', 'drink-plan-logos/5-'],
    ['menu-art/7/run/background.jpg', 'menu-art/7/ref-'],      // art is not a reference
  ];
  for (const [key, prefix] of cases) {
    assert.throws(() => assertKeyUnder(key, prefix), NotFoundError, `${key} under ${prefix}`);
  }
});

test('assertKeyUnder: .. and // are refused even under the right prefix', () => {
  assert.throws(() => assertKeyUnder('menu-art/7/../8/background.jpg', 'menu-art/7/'), NotFoundError);
  assert.throws(() => assertKeyUnder('menu-art/7/..', 'menu-art/7/'), NotFoundError);
  assert.throws(() => assertKeyUnder('menu-art/7//background.jpg', 'menu-art/7/'), NotFoundError);
  assert.throws(() => assertKeyUnder('drink-plan-logos/5-//x.png', 'drink-plan-logos/5-'), NotFoundError);
});

test('assertKeyUnder: a missing key or an empty prefix never passes', () => {
  assert.throws(() => assertKeyUnder(null, 'menu-art/7/'), NotFoundError);
  assert.throws(() => assertKeyUnder(undefined, 'menu-art/7/'), NotFoundError);
  assert.throws(() => assertKeyUnder('menu-art/7/x.png', ''), NotFoundError);
  assert.throws(() => assertKeyUnder('menu-art/7/x.png', undefined), NotFoundError);
});

// ── sendR2Object ─────────────────────────────────────────────────────────────

test('full size: the stored bytes with the menuPrintFile headers', async () => {
  const png = await drinkPng();
  const key = 'menu-art/7/run-1/cocktail-12-aaaa.png';
  current = { key, opts: { prefix: ART, filename: 'drink.png' } };
  signedCalls.length = 0;
  await withFetch(serveBytes(png, 'image/png'), async (calls) => {
    const res = await get();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, png);
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.strictEqual(res.headers['content-disposition'], 'inline; filename="drink.png"');
    assert.strictEqual(res.headers['cache-control'], 'private, no-cache');
    assert.strictEqual(res.headers.etag, etagOf(key), 'full size: the digest of the key alone, as menuPrintFile');
    assert.strictEqual(Number(res.headers['content-length']), png.length);
    assert.deepStrictEqual(signedCalls, [key]);
    assert.deepStrictEqual(calls, [`https://r2.invalid/${key}`]);
  });
});

test('width 240: a 240-wide PNG with alpha intact and its own ETag', async () => {
  const png = await drinkPng();
  const key = 'menu-art/7/run-1/cocktail-12-aaaa.png';
  await withFetch(serveBytes(png, 'image/png'), async () => {
    current = { key, opts: { prefix: ART, filename: 'drink.png' } };
    const full = await get();
    current = { key, opts: { prefix: ART, filename: 'drink.png', width: 240 } };
    const small = await get();

    assert.strictEqual(small.status, 200);
    assert.strictEqual(small.headers['content-type'], 'image/png');
    const meta = await sharp(small.body).metadata();
    assert.strictEqual(meta.format, 'png');
    assert.strictEqual(meta.width, 240);
    assert.strictEqual(meta.height, 240);
    assert.strictEqual(meta.hasAlpha, true);
    assert.strictEqual(await pixelAlpha(small.body, 2, 2), 0, 'the corner stays transparent');
    assert.strictEqual(await pixelAlpha(small.body, 120, 120), 255, 'the drink stays opaque');
    assert.ok(small.body.length < png.length);

    assert.notStrictEqual(small.headers.etag, full.headers.etag);
    assert.strictEqual(small.headers.etag, etagOf(`${key}\nw=240`));
    assert.strictEqual(small.headers['cache-control'], 'private, no-cache');
  });
});

test('width 480 (and the query-string form "480"): a JPEG stays a JPEG', async () => {
  const jpg = await backgroundJpeg();
  const key = 'menu-art/7/run-1/background-bbbb.jpg';
  await withFetch(serveBytes(jpg, 'image/jpeg'), async () => {
    current = { key, opts: { prefix: ART, width: '480' } };
    const res = await get();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'image/jpeg');
    assert.strictEqual(res.headers['content-disposition'], 'inline');
    const meta = await sharp(res.body).metadata();
    assert.strictEqual(meta.format, 'jpeg');
    assert.strictEqual(meta.width, 480);
    assert.strictEqual(meta.height, 600);
    assert.strictEqual(res.headers.etag, etagOf(`${key}\nw=480`));
    assert.notStrictEqual(res.headers.etag, etagOf(`${key}\nw=240`));
  });
});

test('resize: the format comes from the bytes, not the stored type or extension', async () => {
  const png = await drinkPng();
  // A PNG stored under .jpg with an image/jpeg type (a planner logo's extension
  // is the client's filename): the thumbnail must still be a PNG and say so.
  await withFetch(serveBytes(png, 'image/jpeg'), async () => {
    current = { key: 'drink-plan-logos/5-1700000000000.jpg', opts: { prefix: LOGO, width: 240 } };
    const res = await get();
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.strictEqual((await sharp(res.body).metadata()).format, 'png');
  });
});

test('resize: EXIF orientation is applied, and a small image is never enlarged', async () => {
  // Stored 400x200 with orientation 6 (rotate 90): it displays as 200x400.
  const rotated = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#808080' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  await withFetch(serveBytes(rotated, 'image/jpeg'), async () => {
    current = { key: 'drink-plan-logos/5-1.jpg', opts: { prefix: LOGO, width: 240 } };
    const meta = await sharp((await get()).body).metadata();
    assert.strictEqual(meta.width, 200, 'upright 200 wide, so it is not enlarged to 240');
    assert.strictEqual(meta.height, 400);
    assert.ok(!meta.orientation || meta.orientation === 1);
  });
  const tiny = await sharp({ create: { width: 100, height: 50, channels: 4, background: '#ffffff' } }).png().toBuffer();
  await withFetch(serveBytes(tiny, 'image/png'), async () => {
    current = { key: 'drink-plan-logos/5-2.png', opts: { prefix: LOGO, width: 480 } };
    const meta = await sharp((await get()).body).metadata();
    assert.strictEqual(meta.width, 100);
  });
});

test('a matching If-None-Match answers 304 before R2 is read or sharp runs', async () => {
  const key = 'menu-art/7/run-1/cocktail-12-aaaa.png';
  readCalls.length = 0;
  signedCalls.length = 0;
  await withFetch(mustNotFetch, async (calls) => {
    current = { key, opts: { prefix: ART, width: 240 } };
    const small = await get({ 'If-None-Match': etagOf(`${key}\nw=240`) });
    assert.strictEqual(small.status, 304);
    assert.strictEqual(small.body.length, 0);
    assert.strictEqual(small.headers.etag, etagOf(`${key}\nw=240`));
    assert.strictEqual(small.headers['cache-control'], 'private, no-cache');

    // Full size, and the W/ and list forms a browser or proxy may send.
    current = { key, opts: { prefix: ART } };
    const full = await get({ 'If-None-Match': `"stale", W/${etagOf(key)}` });
    assert.strictEqual(full.status, 304);

    assert.strictEqual(calls.length, 0, 'no R2 fetch');
    assert.strictEqual(readCalls.length, 0, 'no readFile');
    assert.strictEqual(signedCalls.length, 0, 'no presign');
  });
});

test('a stale If-None-Match, another width\'s ETag, or a reload still reads R2', async () => {
  const png = await drinkPng();
  const key = 'menu-art/7/run-1/cocktail-12-aaaa.png';
  await withFetch(serveBytes(png, 'image/png'), async (calls) => {
    current = { key, opts: { prefix: ART, width: 240 } };
    const stale = await get({ 'If-None-Match': '"0000"' });
    assert.strictEqual(stale.status, 200);
    assert.strictEqual(stale.headers.etag, etagOf(`${key}\nw=240`));

    // The full-size ETag never stands in for the 240 copy, nor the reverse.
    const crossed = await get({ 'If-None-Match': etagOf(key) });
    assert.strictEqual(crossed.status, 200);

    // A browser reload sends no-cache with its validator: always a fresh copy.
    const reload = await get({ 'If-None-Match': etagOf(`${key}\nw=240`), 'Cache-Control': 'no-cache' });
    assert.strictEqual(reload.status, 200);
    assert.strictEqual(calls.length, 3);
  });
});

test('the key guard runs before the 304: a matching ETag outside the prefix is still 404', async () => {
  const key = 'menu-art/12/run-1/background.jpg';
  readCalls.length = 0;
  await withFetch(mustNotFetch, async (calls) => {
    current = { key, opts: { prefix: 'menu-art/1/' } };
    const res = await get({ 'If-None-Match': etagOf(key) });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.etag, undefined);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(readCalls.length, 0);
  });
});

test('prefix is required: missing or empty throws (500) before R2 is read', async () => {
  readCalls.length = 0;
  await withFetch(mustNotFetch, async (calls) => {
    for (const opts of [{}, { prefix: '' }, { prefix: null }, { prefix: 7 }, { width: 240 }]) {
      current = { key: 'menu-art/7/run-1/background.jpg', opts };
      lastError = null;
      const res = await get();
      assert.strictEqual(res.status, 500, `opts ${JSON.stringify(opts)}`);
      assert.match(lastError.message, /needs the prefix/);
      assert.strictEqual(res.headers.etag, undefined);
    }
    // No options object at all.
    current = { key: 'menu-art/7/run-1/background.jpg', opts: undefined };
    assert.strictEqual((await get()).status, 500);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(readCalls.length, 0);
  });
});

test('a key outside its prefix (or with .. or //) is 404 with no fetch', async () => {
  readCalls.length = 0;
  await withFetch(mustNotFetch, async (calls) => {
    const cases = [
      ['12_w9_abc.png', ART],
      ['menu-art/12/run/background.jpg', 'menu-art/1/'],
      ['drink-plan-logos/55-1700000000000.png', LOGO],
      ['menu-art/7/../8/background.jpg', ART],
      ['menu-art/7//background.jpg', ART],
    ];
    for (const [key, prefix] of cases) {
      current = { key, opts: { prefix, width: 240 } };
      const res = await get();
      assert.strictEqual(res.status, 404, `${key} under ${prefix}`);
      assert.strictEqual(res.headers.etag, undefined);
      assert.strictEqual(res.headers['content-disposition'], undefined);
    }
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(readCalls.length, 0);
  });
});

test('resize: a 16-bit image under the pixel limit but over the decoded-size budget is a 422 IMAGE_TOO_LARGE', async () => {
  // 6000x6000 = 36 MP, under the 50 MP pixel limit, but 16-bit RGBA decodes to
  // 36M x 4 x 2 = 288 MB, over the 200 MB budget, so the header alone refuses it.
  const side = 6000;
  assert.ok(side * side < RESIZE_PIXEL_LIMIT && side * side * 4 * 2 > RESIZE_BYTE_LIMIT);
  const deep = await sharp({ create: { width: side, height: side, channels: 4, background: { r: 40, g: 90, b: 70, alpha: 1 } } })
    .toColourspace('rgb16').png({ compressionLevel: 9 }).toBuffer();
  const meta = await sharp(deep).metadata();
  assert.equal(meta.depth, 'ushort', 'the fixture really is 16-bit');
  await withFetch(serveBytes(deep, 'image/png'), async () => {
    current = { key: 'drink-plan-logos/5-1700000000002.png', opts: { prefix: LOGO, width: 240 } };
    lastError = null;
    const res = await get();
    assert.strictEqual(res.status, 422);
    assert.strictEqual(JSON.parse(res.body).code, 'IMAGE_TOO_LARGE');
    assert.ok(lastError instanceof AppError && !(lastError instanceof ExternalServiceError));
  });
});

test('resize: an image over the pixel limit is a 422 IMAGE_TOO_LARGE that does not page Sentry', async () => {
  // 7200x7200 = 51.84 MP: just over the 50 MP limit, far under sharp's default
  // 268 MP, so only the explicit limit refuses it. One flat color stays small.
  const side = 7200;
  assert.ok(side * side > RESIZE_PIXEL_LIMIT && side * side < 268402689);
  const big = await sharp({ create: { width: side, height: side, channels: 3, background: '#2a5a46' } })
    .png().toBuffer();
  const key = 'drink-plan-logos/5-1700000000001.png';
  await withFetch(serveBytes(big, 'image/png'), async () => {
    current = { key, opts: { prefix: LOGO, width: 240 } };
    lastError = null;
    const res = await get();
    assert.strictEqual(res.status, 422);
    assert.strictEqual(JSON.parse(res.body).code, 'IMAGE_TOO_LARGE');
    assert.ok(lastError instanceof AppError);
    assert.ok(!(lastError instanceof ExternalServiceError), 'not an ExternalServiceError, so no Sentry page');
    assert.strictEqual(lastError.message, 'This image is too large to preview.');
    assert.strictEqual(res.headers.etag, undefined);
    assert.strictEqual(res.headers['content-disposition'], undefined);

    // Full size never decodes, so the same object still downloads as stored.
    current = { key, opts: { prefix: LOGO } };
    const full = await get();
    assert.strictEqual(full.status, 200);
    assert.strictEqual(full.body.length, big.length);
  });
});

test('resize: bytes sharp cannot decode are a 422 IMAGE_UNREADABLE that does not page Sentry', async () => {
  const jpg = await backgroundJpeg();
  const cases = [
    ['garbage under a .png name', Buffer.from('this is not an image, whatever the extension says')],
    ['an empty object', Buffer.alloc(0)],
    ['a corrupt header', jpg.subarray(0, 3)],
    // The header parses, so this one fails mid-decode rather than up front.
    ['a truncated JPEG', jpg.subarray(0, Math.floor(jpg.length / 2))],
  ];
  for (const [label, bytes] of cases) {
    await withFetch(serveBytes(bytes, 'image/png'), async () => {
      current = { key: 'drink-plan-logos/5-1700000000002.png', opts: { prefix: LOGO, width: 480 } };
      lastError = null;
      const res = await get();
      assert.strictEqual(res.status, 422, label);
      assert.strictEqual(JSON.parse(res.body).code, 'IMAGE_UNREADABLE', label);
      assert.ok(lastError instanceof AppError, label);
      assert.ok(!(lastError instanceof ExternalServiceError), label);
      assert.strictEqual(lastError.message, 'This image could not be read.', label);
      assert.strictEqual(res.headers.etag, undefined, label);
    });
  }
});

test('any other width is refused with 400 before R2 is read', async () => {
  await withFetch(mustNotFetch, async (calls) => {
    for (const w of [999, 1024, 0, -240, 240.5, '', 'abc', '240px', ' 240', [240], {}]) {
      current = { key: 'menu-art/7/run-1/background.jpg', opts: { prefix: ART, width: w } };
      const res = await get();
      assert.strictEqual(res.status, 400, `w=${JSON.stringify(w)} refused`);
      assert.strictEqual(res.headers.etag, undefined);
    }
    assert.strictEqual(calls.length, 0);
  });
});

test('attachment disposition, and a hostile filename cannot break the header', async () => {
  const png = await drinkPng();
  await withFetch(serveBytes(png, 'image/png'), async () => {
    current = { key: 'menu-art/7/ref-cccc.png', opts: { prefix: 'menu-art/7/ref-', disposition: 'attachment', filename: 'a"b\r\nSet-Cookie: x.png' } };
    const res = await get();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-disposition'], 'attachment; filename="a-b--Set-Cookie--x.png"');
    assert.strictEqual(res.headers['set-cookie'], undefined);
  });
});

test('an unknown disposition throws before R2 is read', async () => {
  await withFetch(mustNotFetch, async (calls) => {
    current = { key: 'menu-art/7/ref-cccc.png', opts: { prefix: 'menu-art/7/ref-', disposition: 'inline; evil' } };
    const res = await get();
    assert.strictEqual(res.status, 500);
    assert.strictEqual(calls.length, 0);
  });
});

test('R2 404 is a clean 404 with none of the success headers', async () => {
  await withFetch(() => new Response('<Error>NoSuchKey</Error>', { status: 404 }), async () => {
    current = { key: 'menu-art/7/run-1/background.jpg', opts: { prefix: ART, width: 240 } };
    const res = await get();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.etag, undefined);
    assert.strictEqual(res.headers['content-disposition'], undefined);
    assert.ok(!res.body.toString().includes('NoSuchKey'));
  });
});

test('an R2 failure is a clean 502 that leaks nothing', async () => {
  await withFetch(() => new Response('upstream detail', { status: 500 }), async () => {
    current = { key: 'menu-art/7/run-1/background.jpg', opts: { prefix: ART } };
    const res = await get();
    assert.strictEqual(res.status, 502);
    assert.ok(!res.body.toString().includes('upstream detail'));
    assert.ok(!res.body.toString().includes('r2.invalid'));
    assert.strictEqual(res.headers.etag, undefined);
  });
});
