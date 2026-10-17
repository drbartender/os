process.env.NODE_ENV = 'test';
// server/utils/menuBackgroundTone.test.js
// PURE unit tests, no DB and no provider (plan Task E3). Fixtures are made
// with sharp({ create }) in memory.
//   node --test server/utils/menuBackgroundTone.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { readTone, relativeLuminance, DARK_BELOW } = require('./menuBackgroundTone');

const NAVY = { r: 27, g: 42, b: 74 };
const CREAM = { r: 245, g: 239, b: 224 };

function solid(width, height, color, format = 'png') {
  const img = sharp({ create: { width, height, channels: 3, background: color } });
  return (format === 'jpeg' ? img.jpeg() : img.png()).toBuffer();
}

test('navy reads dark, with its mean color as ground_rgb', async () => {
  assert.deepEqual(await readTone(await solid(400, 500, NAVY)), { tone: 'dark', ground_rgb: '27,42,74' });
});

test('cream reads light', async () => {
  assert.deepEqual(await readTone(await solid(400, 500, CREAM)), { tone: 'light', ground_rgb: '245,239,224' });
});

test('a JPEG background reads the same way', async () => {
  const result = await readTone(await solid(800, 1000, NAVY, 'jpeg'));
  assert.equal(result.tone, 'dark');
  assert.match(result.ground_rgb, /^\d{1,3},\d{1,3},\d{1,3}$/);
});

test('garbage bytes, an empty buffer and a non-buffer give nulls', async () => {
  const nulls = { tone: null, ground_rgb: null };
  assert.deepEqual(await readTone(Buffer.from('this is not an image at all')), nulls);
  assert.deepEqual(await readTone(Buffer.alloc(0)), nulls);
  assert.deepEqual(await readTone(null), nulls);
});

test('a cream center inside a thick navy border reads light (it fails if the crop is ignored)', async () => {
  // The central 60% of 1000x1250 is the 600x750 box at (200, 250); the cream
  // panel covers it with room to spare, and the navy border is most of the page.
  const panel = await solid(640, 790, CREAM);
  const bordered = await sharp({ create: { width: 1000, height: 1250, channels: 3, background: NAVY } })
    .composite([{ input: panel, left: 180, top: 230 }])
    .png()
    .toBuffer();
  // Measured whole, this image is dark, so a reader that measured the
  // original instead of the crop would answer dark.
  const whole = (await sharp(bordered).stats()).channels.slice(0, 3).map((c) => c.mean);
  assert.ok(relativeLuminance(whole) < DARK_BELOW, 'the fixture must read dark when the crop is ignored');
  assert.deepEqual(await readTone(bordered), { tone: 'light', ground_rgb: '245,239,224' });
});

test('the threshold is sRGB relative luminance 0.4', () => {
  assert.equal(DARK_BELOW, 0.4);
  assert.ok(relativeLuminance([255, 255, 255]) > 0.99);
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  // Mid grey is well under 0.4 (about 0.22), so it reads dark.
  assert.ok(relativeLuminance([128, 128, 128]) < 0.4);
  assert.ok(relativeLuminance([180, 180, 180]) > 0.4);
});

test('an image with alpha is measured on its color channels', async () => {
  const rgba = await sharp({ create: { width: 300, height: 300, channels: 4, background: { ...CREAM, alpha: 1 } } }).png().toBuffer();
  assert.deepEqual(await readTone(rgba), { tone: 'light', ground_rgb: '245,239,224' });
});
