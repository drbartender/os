process.env.NODE_ENV = 'test';
/* eslint-disable security/detect-object-injection -- every index here is a computed pixel offset into a raw buffer */
// server/utils/menuKeyOut.test.js
// PURE unit tests, no DB, no provider. Most fixtures are drawn with
// sharp({ create }) plus an SVG overlay, keyed, decoded back to raw RGBA, and
// checked pixel by pixel (spec 5.4 Drinks, plan Task F7, Review Focus 6). The
// byte-for-byte pin draws its fixture in plain integer JS instead, and the
// pixel-limit test hand-builds its PNG.
//   node --test server/utils/menuKeyOut.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const sharp = require('sharp');
const { keyOutMagenta, MenuKeyOutFailed } = require('./menuKeyOut');

const SIZE = 1024;
const MAGENTA = { r: 255, g: 0, b: 255 };
const NAVY = { r: 0x12, g: 0x1b, b: 0x35 }; // the dark-theme ground from the E7 smoke
const CREAM = '#f5ecd7';
// A tumbler with slanted sides and a curved foot, so its whole outline is
// anti-aliased and the key-out has a real partial-alpha band to work on.
const GLASS_PATH = 'M 352 290 L 672 290 L 628 740 Q 512 790 396 740 Z';
const GLASS = `<path d="${GLASS_PATH}" fill="${CREAM}"/>`;
const GLASS_CENTER = [512, 520];
// No edge pixel may keep more magenta excess, min(r, b) - g in 0..255 levels,
// than this: premultiplied by its alpha in the PNG, and absolute once the PNG
// is composited onto the navy ground. A clean PNG fixture must come out within
// 2 levels. The quality-80 JPEG gets 10 (about 4%), its own floor: interior
// pixels the key-out never touches already reach 9 there from JPEG ringing.
const CAST_TOLERANCE_PNG = 2;
const CAST_TOLERANCE_JPEG = 10;
const EDGE_RADIUS = 3; // "edge pixel": visible and within 3 px of a pixel that is not opaque

async function drawFixture(body, { size = SIZE, background = MAGENTA, jpeg = false } = {}) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${body}</svg>`);
  const png = await sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
  return jpeg ? sharp(png).jpeg({ quality: 80 }).toBuffer() : png;
}

const rawRGBA = (buffer) => sharp(buffer).ensureAlpha().raw().toBuffer();

// Draws, keys and decodes one fixture. `input` is the fixture as the key-out
// decodes it (after any JPEG loss), so "unchanged" means byte-identical.
async function keyFixture(body, opts) {
  const fixture = await drawFixture(body, opts);
  const png = await keyOutMagenta(fixture);
  return { fixture, png, input: await rawRGBA(fixture), out: await rawRGBA(png) };
}

const at = (data, x, y) => Array.from(data.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));
const alphaAt = (data, x, y) => data[(y * SIZE + x) * 4 + 3];
const cast = (r, g, b) => Math.min(r, b) - g;

// Pixels within `radius` (Chebyshev) of any pixel whose alpha passes `hit`:
// a dilation along x, then along y.
function nearMask(data, hit, radius) {
  let mask = Uint8Array.from({ length: SIZE * SIZE }, (_, i) => (hit(data[i * 4 + 3]) ? 1 : 0));
  for (const alongX of [true, false]) {
    const next = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const x = i % SIZE;
      const y = (i - x) / SIZE;
      for (let d = -radius; d <= radius && !next[i]; d++) {
        const [xx, yy] = alongX ? [x + d, y] : [x, y + d];
        if (xx >= 0 && xx < SIZE && yy >= 0 && yy < SIZE && mask[yy * SIZE + xx]) next[i] = 1;
      }
    }
    mask = next;
  }
  return mask;
}

function edgeIndices(out) {
  const nearSeeThrough = nearMask(out, (a) => a < 255, EDGE_RADIUS);
  const idx = [];
  for (let i = 0; i < SIZE * SIZE; i++) if (out[i * 4 + 3] > 0 && nearSeeThrough[i]) idx.push(i);
  return idx;
}

const onNavy = (png) => sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: NAVY } })
  .composite([{ input: png }]).ensureAlpha().raw().toBuffer();

function circleStats({ input, out }, cx, cy, r) {
  let [total, opaque, changed] = [0, 0, 0];
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      total++;
      const o = (y * SIZE + x) * 4;
      if (out[o + 3] === 255) opaque++;
      if (out[o] !== input[o] || out[o + 1] !== input[o + 1] || out[o + 2] !== input[o + 2] || out[o + 3] !== 255) changed++;
    }
  }
  return { total, opaqueShare: opaque / total, changed };
}

async function assertNoMagentaCast(png, out, label, tolerance) {
  const edge = edgeIndices(out);
  assert.ok(edge.length > 1000, `${label}: the edge zone was found (${edge.length} px)`);
  const navy = await onNavy(png);
  let [worstPremult, worstOnNavy] = [0, -255];
  for (const o of edge.map((i) => i * 4)) {
    worstPremult = Math.max(worstPremult, (out[o + 3] / 255) * cast(out[o], out[o + 1], out[o + 2]));
    worstOnNavy = Math.max(worstOnNavy, cast(navy[o], navy[o + 1], navy[o + 2]));
  }
  assert.ok(worstPremult <= tolerance, `${label}: worst premultiplied edge cast ${worstPremult.toFixed(1)} > ${tolerance}`);
  assert.ok(worstOnNavy <= tolerance, `${label}: pink fringe on navy, worst cast ${worstOnNavy} > ${tolerance}`);
}

test('a cream glass on flat magenta: transparent corners, opaque glass, a partial-alpha band that hugs it', async () => {
  const { png, input, out } = await keyFixture(GLASS);
  const { format, width, height, channels, hasAlpha } = await sharp(png).metadata();
  assert.deepEqual({ format, width, height, channels, hasAlpha }, { format: 'png', width: SIZE, height: SIZE, channels: 4, hasAlpha: true });

  for (const [x, y] of [[0, 0], [SIZE - 1, 0], [0, SIZE - 1], [SIZE - 1, SIZE - 1], [100, 512], [900, 900]]) {
    assert.equal(alphaAt(out, x, y), 0, `background at ${x},${y} is transparent`);
  }
  const [cx, cy] = GLASS_CENTER;
  assert.deepEqual(at(out, cx, cy), at(input, cx, cy), 'the glass center is untouched and opaque');
  assert.equal(alphaAt(out, cx, cy), 255);

  let partial = 0;
  const nearOpaque = nearMask(out, (a) => a === 255, 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = out[i * 4 + 3];
    if (a > 0 && a < 255) {
      partial++;
      assert.equal(nearOpaque[i], 1, `partial pixel ${i % SIZE},${Math.floor(i / SIZE)} sits on the glass edge`);
    }
  }
  assert.ok(partial > 300, `the anti-aliased outline keeps partial alpha (${partial} px)`);
});

test('no edge pixel keeps a magenta cast, before or after a JPEG round trip, including on a dark ground', async () => {
  for (const jpeg of [false, true]) {
    const { png, out } = await keyFixture(GLASS, { jpeg });
    await assertNoMagentaCast(png, out, jpeg ? 'JPEG q80' : 'PNG', jpeg ? CAST_TOLERANCE_JPEG : CAST_TOLERANCE_PNG);
  }
});

test('the JPEG round trip at quality 80 (the real Gemini case) still keys cleanly', async () => {
  const fixture = await drawFixture(GLASS, { jpeg: true });
  const meta = await sharp(fixture).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.chromaSubsampling, '4:2:0', 'the fixture carries the chroma smear the key-out must survive');

  const out = await rawRGBA(await keyOutMagenta(fixture));
  const clean = (await keyFixture(GLASS)).out;
  for (const [x, y] of [[0, 0], [SIZE - 1, 0], [0, SIZE - 1], [SIZE - 1, SIZE - 1]]) assert.equal(alphaAt(out, x, y), 0);
  assert.equal(alphaAt(out, ...GLASS_CENTER), 255);

  // Same silhouette as the clean PNG, give or take the smeared edge.
  let transparentJpeg = 0;
  let transparentPng = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (out[i * 4 + 3] === 0) transparentJpeg++;
    if (clean[i * 4 + 3] === 0) transparentPng++;
  }
  assert.ok(Math.abs(transparentJpeg - transparentPng) / transparentPng < 0.01, `${transparentJpeg} vs ${transparentPng}`);

  // No stray specks: everything visible sits on or next to the glass.
  const nearGlass = nearMask(clean, (a) => a === 255, 6);
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (out[i * 4 + 3] > 0) assert.equal(nearGlass[i], 1, `stray visible pixel at ${i % SIZE},${Math.floor(i / SIZE)}`);
  }
});

test('a green garnish touching the key keeps its color, with no mauve rim', async () => {
  const lime = `<circle cx="662" cy="300" r="70" fill="#7cb342"/>`;
  for (const jpeg of [false, true]) {
    const run = await keyFixture(GLASS + lime, { jpeg });
    const inner = circleStats(run, 662, 300, 64);
    assert.equal(inner.opaqueShare, 1, 'the lime body stays opaque');
    assert.equal(inner.changed, 0, 'the lime body keeps its exact color');
    const navy = await onNavy(run.png);
    for (let y = 228; y <= 372; y++) {
      for (let x = 590; x <= 734; x++) {
        const r2 = (x - 662) ** 2 + (y - 300) ** 2;
        if (r2 <= 64 * 64 || r2 > 72 * 72 || alphaAt(run.out, x, y) < 128) continue;
        if (y >= 290 && x <= 672) continue; // where the lime overlaps the cream glass
        const [r, g, b] = at(run.out, x, y);
        assert.ok(g > r && g > b, `rim pixel ${x},${y} stays green (${r},${g},${b}) ${jpeg ? 'JPEG' : 'PNG'}`);
        const o = (y * SIZE + x) * 4;
        const tolerance = jpeg ? CAST_TOLERANCE_JPEG : CAST_TOLERANCE_PNG;
        assert.ok(cast(navy[o], navy[o + 1], navy[o + 2]) <= tolerance, `no pink at ${x},${y} on navy`);
      }
    }
  }
});

test('a raspberry and a hibiscus beside the key keep at least 90% of their pixels opaque', async () => {
  const garnish = `<circle cx="362" cy="300" r="60" fill="#e30b5c"/><circle cx="340" cy="620" r="50" fill="#b6316c"/>`;
  for (const jpeg of [false, true]) {
    const run = await keyFixture(GLASS + garnish, { jpeg });
    for (const [name, cx, cy, r] of [['raspberry', 362, 300, 60], ['hibiscus', 340, 620, 50]]) {
      const whole = circleStats(run, cx, cy, r);
      assert.ok(whole.opaqueShare >= 0.9, `${name} ${jpeg ? 'JPEG' : 'PNG'}: ${(whole.opaqueShare * 100).toFixed(1)}% opaque`);
      const body = circleStats(run, cx, cy, r - 6);
      assert.equal(body.changed, 0, `${name} ${jpeg ? 'JPEG' : 'PNG'}: its body is untouched`);
    }
  }
});

test('a dark berry and dark ink beside the key are not read as a dark magenta shadow', async () => {
  // A blackberry, and a plum sitting right on the magenta hue axis: the
  // brightness floor is what keeps these from keying like a shadow.
  for (const fill of ['#280a32', '#3a0f3a']) {
    const art = `<path d="${GLASS_PATH}" fill="${CREAM}" stroke="${fill}" stroke-width="6"/><circle cx="662" cy="300" r="50" fill="${fill}"/>`;
    for (const jpeg of [false, true]) {
      const run = await keyFixture(art, { jpeg });
      const berry = circleStats(run, 662, 300, 50);
      assert.ok(berry.opaqueShare >= 0.9, `${fill} ${jpeg ? 'JPEG' : 'PNG'} berry: ${(berry.opaqueShare * 100).toFixed(1)}% opaque`);
      // JPEG noise on a color this dark can tip a few pixels past the
      // threshold, so only the lossless copy must come through byte for byte.
      if (!jpeg) assert.equal(circleStats(run, 662, 300, 44).changed, 0, `${fill} berry body untouched`);
      assert.equal(alphaAt(run.out, 374, 520), 255, `${fill} outline on the glass's left side survives`);
    }
  }
});

test('a pink drink body enclosed by its glass outline stays fully opaque', async () => {
  // #e8509a is the spec's pink. #e61ed2 is close enough to the key that only
  // the enclosure saves it, which the open copy below proves.
  const body = (fill) => `<ellipse cx="512" cy="540" rx="200" ry="260" fill="${fill}" stroke="${CREAM}" stroke-width="10"/>`;
  for (const fill of ['#e8509a', '#e61ed2']) {
    for (const jpeg of [false, true]) {
      const run = await keyFixture(body(fill), { jpeg });
      let checked = 0;
      for (let y = 280; y <= 800; y++) {
        for (let x = 312; x <= 712; x++) {
          if (((x - 512) / 194) ** 2 + ((y - 540) / 254) ** 2 > 1) continue;
          checked++;
          const o = (y * SIZE + x) * 4;
          assert.equal(run.out[o + 3], 255, `${fill} ${jpeg ? 'JPEG' : 'PNG'} body pixel ${x},${y} is opaque`);
          assert.deepEqual(at(run.out, x, y), at(run.input, x, y), `${fill} body pixel ${x},${y} keeps its color`);
        }
      }
      assert.ok(checked > 150000);
    }
  }
  const open = await keyFixture(`<ellipse cx="512" cy="540" rx="200" ry="260" fill="#e61ed2"/>`);
  assert.equal(alphaAt(open.out, 512, 540), 0, 'the same fuchsia touching the background is keyed');
});

test('a dark magenta shadow under the glass keys out with no specks', async () => {
  const shadow = `<ellipse cx="512" cy="780" rx="220" ry="40" fill="#7a007a"/>`;
  for (const jpeg of [false, true]) {
    const { out } = await keyFixture(shadow + GLASS, { jpeg });
    for (let y = 750; y <= 812; y++) {
      for (let x = 300; x <= 724; x++) {
        if (((x - 512) / 214) ** 2 + ((y - 780) / 34) ** 2 > 1) continue;
        if (y < 776 && x > 380 && x < 644) continue; // the glass foot overlaps here
        assert.equal(alphaAt(out, x, y), 0, `${jpeg ? 'JPEG' : 'PNG'} shadow pixel ${x},${y} is keyed`);
      }
    }
  }
});

test('a background that drifts off pure magenta still keys from its own color', async () => {
  const run = await keyFixture(GLASS, { background: { r: 240, g: 20, b: 200 }, jpeg: true });
  assert.equal(alphaAt(run.out, 0, 0), 0);
  assert.equal(alphaAt(run.out, 900, 900), 0);
  assert.equal(alphaAt(run.out, ...GLASS_CENTER), 255);
  await assertNoMagentaCast(run.png, run.out, 'off-key JPEG', CAST_TOLERANCE_JPEG);
});

test('an image with no magenta throws MenuKeyOutFailed', async () => {
  const white = await drawFixture(GLASS, { background: { r: 255, g: 255, b: 255 } });
  await assert.rejects(keyOutMagenta(white), (err) => {
    assert.ok(err instanceof MenuKeyOutFailed);
    assert.equal(err.name, 'MenuKeyOutFailed');
    assert.equal(err.message, "Gemini didn't leave a clean background. Re-roll it.");
    assert.equal(err.reason, err.message, 'the readable reason the provider router folds into its refusal');
    assert.equal(err.code, 'key_out_failed');
    assert.equal(err.keyedFraction, 0);
    return true;
  });
});

test('minKeyFraction sets the refusal line', async () => {
  const glass = await drawFixture(GLASS);
  await assert.rejects(keyOutMagenta(glass, { minKeyFraction: 0.95 }), MenuKeyOutFailed);
  // A drink filling 77% of the frame leaves 23% key: under the default 25%.
  const big = await drawFixture(`<rect x="64" y="64" width="896" height="896" fill="${CREAM}"/>`);
  await assert.rejects(keyOutMagenta(big), MenuKeyOutFailed);
  const out = await rawRGBA(await keyOutMagenta(big, { minKeyFraction: 0.2 }));
  assert.equal(alphaAt(out, 10, 10), 0);
  assert.equal(alphaAt(out, 512, 512), 255);
  await assert.rejects(keyOutMagenta(glass, { minKeyFraction: 'x' }), TypeError);
});

// E7 regression: a real Gemini 1:1 1K drink on magenta, captured in the live
// smoke (an old fashioned with an orange twist, JPEG straight from the API).
test('a real Gemini drink keys out: transparent corners, an opaque drink, no magenta fringe on its edge', async () => {
  const raw = fs.readFileSync(path.join(__dirname, '__fixtures__', 'gemini-drink-raw.jpg'));
  const meta = await sharp(raw).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', SIZE, SIZE], 'the fixture is what Gemini returns');
  const png = await keyOutMagenta(raw);
  const { format, width, height, hasAlpha } = await sharp(png).metadata();
  assert.deepEqual({ format, width, height, hasAlpha }, { format: 'png', width: SIZE, height: SIZE, hasAlpha: true });
  const out = await rawRGBA(png);
  for (const [x, y] of [[0, 0], [SIZE - 1, 0], [0, SIZE - 1], [SIZE - 1, SIZE - 1], [60, 512], [960, 512]]) {
    assert.equal(alphaAt(out, x, y), 0, `background at ${x},${y} is transparent`);
  }
  for (const [x, y] of [[512, 512], [512, 600], [400, 500]]) assert.equal(alphaAt(out, x, y), 255, `the drink at ${x},${y} is opaque`);
  let partial = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = out[i * 4 + 3];
    if (a > 0 && a < 255) partial++;
  }
  assert.ok(partial > 300, `the outline keeps a partial-alpha band (${partial} px)`);
  await assertNoMagentaCast(png, out, 'real Gemini JPEG', CAST_TOLERANCE_JPEG);
});

test('a 1000x1000 input comes out 1024x1024 with alpha', async () => {
  const small = await drawFixture(GLASS, { size: 1000, jpeg: true });
  assert.equal((await sharp(small).metadata()).width, 1000);
  const png = await keyOutMagenta(small);
  const { format, width, height, hasAlpha } = await sharp(png).metadata();
  assert.deepEqual({ format, width, height, hasAlpha }, { format: 'png', width: SIZE, height: SIZE, hasAlpha: true });
  const out = await rawRGBA(png);
  assert.equal(alphaAt(out, 0, 0), 0);
  assert.equal(alphaAt(out, 512, 520), 255);
});

// A valid width x height one-bit grayscale PNG built by hand: 64 megapixels in
// about 8 KB, since every row is blank and deflates to almost nothing.
function blankPng(width, height) {
  const chunk = (type, body) => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const out = Buffer.alloc(typed.length + 8);
    out.writeUInt32BE(body.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(typed), typed.length + 4);
    return out;
  };
  const header = Buffer.alloc(13); // bit depth 1, color type 0 (grayscale), the rest 0
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  const rows = Buffer.alloc((1 + Math.ceil(width / 8)) * height); // filter byte 0, then blank pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('an image over 40 megapixels is refused at its header as image_too_large', async () => {
  const huge = blankPng(8000, 8000);
  // A real image, not a broken file: sharp's own default limit reads it.
  const meta = await sharp(huge).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 8000, 8000]);
  await assert.rejects(keyOutMagenta(huge), (err) => {
    assert.ok(err instanceof MenuKeyOutFailed);
    assert.equal(err.name, 'MenuKeyOutFailed');
    assert.equal(err.code, 'image_too_large');
    assert.equal(err.reason, 'Gemini sent an image too large to process. Re-roll it.');
    assert.equal(err.message, err.reason);
    assert.equal(err.keyedFraction, null, 'nothing was keyed');
    return true;
  });
});

// A noisy, smeared stand-in for a Gemini JPEG, drawn in plain integer JS and
// handed over as a lossless PNG, so the key-out sees exactly these bytes and
// no sharp, librsvg or mozjpeg upgrade can move them: flat shapes over
// #FF00FF, a 3x3 box blur that smears every edge into the key, then seeded
// noise of up to 6 levels per channel.
function syntheticFixture() {
  const ellipse = (cx, cy, rx, ry) => (x, y) => (x - cx) * (x - cx) * ry * ry + (y - cy) * (y - cy) * rx * rx <= rx * rx * ry * ry;
  const shapes = [ // painted in this order
    [[245, 236, 215], ellipse(512, 540, 180, 250)], // cream glass
    [[230, 30, 210], ellipse(512, 600, 120, 150)], // a near-key fuchsia body the glass encloses
    [[124, 179, 66], ellipse(690, 300, 70, 70)], // lime garnish on the key
    [[227, 11, 92], ellipse(330, 330, 60, 60)], // raspberry
    [[122, 0, 122], ellipse(512, 830, 220, 40)], // dark magenta shadow under the foot
  ];
  const flat = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0, o = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++, o += 3) {
      let color = [255, 0, 255];
      for (const [c, inside] of shapes) if (inside(x, y)) color = c;
      flat.set(color, o);
    }
  }
  const out = Buffer.alloc(SIZE * SIZE * 3);
  let seed = 7;
  for (let y = 0, o = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++, o += 3) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = Math.min(SIZE - 1, Math.max(0, y + dy));
            const xx = Math.min(SIZE - 1, Math.max(0, x + dx));
            sum += flat[(yy * SIZE + xx) * 3 + ch];
          }
        }
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        out[o + ch] = Math.min(255, Math.max(0, Math.round(sum / 9) + ((seed >>> 24) % 13) - 6));
      }
    }
  }
  return sharp(out, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
}

// sha256 of the keyed synthetic fixture as raw RGBA, taken from the key-out as
// it stood before its pixel loops were sliced across event-loop turns.
const SYNTHETIC_KEYED_SHA256 = '657d1cb3ddf2053c5875dc64784c3625dabfe15ced24fb75bb432f2b372ee3a4';

test('slicing the work across event-loop turns changes no output byte', async () => {
  const fixture = await syntheticFixture();
  const input = await rawRGBA(fixture);
  const out = await rawRGBA(await keyOutMagenta(fixture));
  // The pin covers the edge passes, not just a 0-or-255 cutout.
  let [partial, recolored] = [0, 0];
  for (let o = 0; o < out.length; o += 4) {
    if (out[o + 3] > 0 && out[o + 3] < 255) partial++;
    else if (out[o + 3] === 255 && (out[o] !== input[o] || out[o + 1] !== input[o + 1] || out[o + 2] !== input[o + 2])) recolored++;
  }
  assert.ok(partial > 1000, `partial-alpha band (${partial} px)`);
  assert.ok(recolored > 1000, `despilled opaque ring (${recolored} px)`);
  assert.equal(alphaAt(out, 512, 600), 255, 'the enclosed fuchsia body survives');
  assert.equal(crypto.createHash('sha256').update(out).digest('hex'), SYNTHETIC_KEYED_SHA256);
});

// The whole key-out held the loop for 70 to 140 ms in one stretch; sliced, its
// longest stretch here is about 10 ms. The bound leaves room for a busy box.
const LONGEST_GAP_MS = 60;

test('the key-out never holds the event loop for long (one Node process serves everything)', async () => {
  const fixture = await drawFixture(GLASS, { jpeg: true });
  await keyOutMagenta(fixture); // warm, like a server that has keyed before
  let last = performance.now();
  let longest = 0;
  let ticks = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    ticks++;
  }, 1);
  try {
    await keyOutMagenta(fixture);
  } finally {
    clearInterval(ticker);
  }
  longest = Math.max(longest, performance.now() - last);
  assert.ok(ticks >= 10, `the ticker ran during the key-out (${ticks} ticks)`);
  assert.ok(longest < LONGEST_GAP_MS, `longest event-loop gap ${longest.toFixed(1)} ms, over ${LONGEST_GAP_MS} ms`);
});
