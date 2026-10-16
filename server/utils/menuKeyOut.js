'use strict';
/* eslint-disable security/detect-object-injection -- every index here is a computed number into a typed array or pixel buffer, never a key from input */

/**
 * Magenta key-out for Gemini drink art (spec 5.4 "Drinks, Gemini", plan Review
 * Focus 6). Gemini cannot return alpha, so the drink prompt asks for a flat
 * #FF00FF background and this turns it into a 1024x1024 PNG with real alpha.
 * Pure: sharp decodes to raw RGBA, plain JS works the pixels, sharp encodes.
 *
 * 1. Key color: the median of the border pixels near #FF00FF, so a model that
 *    paints (240,20,200) still keys; too few such pixels keeps #FF00FF.
 * 2. Chroma distance: chroma divided by brightness, so a dark magenta shadow
 *    still keys. Brightness is floored at VALUE_FLOOR so near-black ink, a
 *    blackberry or a dark plum is not read as shadow. Hue error weighs
 *    HUE_WEIGHT times more than saturation loss: a raspberry, a hibiscus or the
 *    #e8509a pink differs from magenta mostly in hue, a drink edge blended into
 *    the key mostly in saturation.
 * 3. Border flood fill: only pixels within OUTER that connect to the image edge
 *    are keyed, so a pink body enclosed by its glass survives. Alpha 0 at or
 *    under INNER, scaled by distance between INNER and OUTER, and partial only
 *    within BAND_MAX px of the drink (deeper, it is JPEG noise and keys to 0).
 * 4. Despill: JPEG chroma subsampling smears the key into the drink, so the
 *    partial-alpha band and the opaque pixels within RING px of the key are
 *    cleaned against a reference color read REF_DEPTH px into the drink. A
 *    band pixel near the reference-to-key line takes the reference color; a
 *    ring pixel on that line is unmixed (a lime edge comes back lime, not
 *    mauve). Otherwise the key share beyond the reference's own is unmixed.
 *    Last, red and blue are clamped toward green by any magenta excess above
 *    the reference's, so no edge keeps a pink cast on dark art while a
 *    raspberry keeps its own red-blue balance.
 * 5. Too little key (the model ignored the instruction) throws
 *    MenuKeyOutFailed rather than storing a drink on a pink square.
 *
 * The server is one Node process, so the pixel work (about 100 ms in all)
 * never holds the event loop in one stretch: each heavy pass over the image
 * runs SLICE_ROWS rows at a time, yielding between slices and between phases.
 * Every input sharp opens is capped at PIXEL_LIMIT, so a huge or hostile image
 * is refused at its header instead of decoded; that refusal is a
 * MenuKeyOutFailed too, with its own code and reason.
 */

const sharp = require('sharp');

const SIZE = 1024;
const PIXEL_LIMIT = 40_000_000;
const SHARP_INPUT = { limitInputPixels: PIXEL_LIMIT };
// A quarter of the image per synchronous stretch: 5 to 10 ms for the heaviest
// pass here, where the whole key-out in one stretch was 70 to 140 ms.
const SLICE_ROWS = 256;
const SLICE = SLICE_ROWS * SIZE;
const NOMINAL_KEY = [255, 0, 255];
const VALUE_FLOOR = 128;
const HUE_WEIGHT = 2.5;
const INNER = 0.22;
const OUTER = 0.62;
const KEY_SAMPLE_GATE = 0.4; // plain distance to #FF00FF for a border sample
const KEY_SAMPLE_MIN = 200; // of the 4,092 border pixels
const BAND_MAX = 4;
const RING = 4;
const REF_DEPTH = 7; // past most JPEG ringing
const REF_STEPS = REF_DEPTH + BAND_MAX;
const RESIDUAL_MAX = 40; // RGB distance off the reference-to-key line, ring pixels
const BAND_RESIDUAL_MAX = 100; // band pixels, which JPEG pushes further off it
const MAX_KEY_SHARE = 0.85; // caps the unmix divisor at 1 / 0.15
const HUE_GATE_LO = 0.1; // a ring pixel with no reference despills fully under this hue error
const HUE_GATE_HI = 0.2; // and not at all over this one
const SIN60 = 0.8660254;

// Readable reason per failure code, the shape the provider router folds into
// its shared refusal alongside OpenAIRefusal and GeminiRefusal.
const FAILURE_REASONS = {
  key_out_failed: "Gemini didn't leave a clean background. Re-roll it.",
  image_too_large: 'Gemini sent an image too large to process. Re-roll it.',
};

class MenuKeyOutFailed extends Error {
  // keyedFraction: the share of the image the flood keyed, or null when the
  // image was refused before any keying (image_too_large).
  constructor(keyedFraction, code = 'key_out_failed') {
    if (!Object.hasOwn(FAILURE_REASONS, code)) throw new TypeError(`unknown MenuKeyOutFailed code ${code}`);
    const reason = FAILURE_REASONS[code];
    super(reason);
    Object.assign(this, { name: 'MenuKeyOutFailed', code, reason, keyedFraction });
  }
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// Calls body(start, end) over pixel indices 0..n one SLICE at a time, yielding
// to the event loop between slices.
async function forSlices(n, body) {
  for (let start = 0; start < n; start += SLICE) {
    if (start > 0) await yieldToLoop();
    body(start, Math.min(n, start + SLICE));
  }
}

// Brightness-normalized chroma of one RGB pixel, written into out[0..1].
function chromaInto(r, g, b, out) {
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const den = mx > VALUE_FLOOR ? mx : VALUE_FLOOR;
  out[0] = (r - (g + b) * 0.5) / den;
  out[1] = (SIN60 * (g - b)) / den;
}

function estimateKey(data) {
  const samples = [[], [], []];
  const c = [0, 0];
  for (let s = 0; s < SIZE; s++) {
    for (const i of [s, (SIZE - 1) * SIZE + s, s * SIZE, s * SIZE + SIZE - 1]) {
      const o = i * 4;
      chromaInto(data[o], data[o + 1], data[o + 2], c);
      if ((c[0] - 0.5) ** 2 + (c[1] + SIN60) ** 2 >= KEY_SAMPLE_GATE ** 2) continue;
      for (let ch = 0; ch < 3; ch++) samples[ch].push(data[o + ch]);
    }
  }
  if (samples[0].length < KEY_SAMPLE_MIN) return NOMINAL_KEY;
  const key = samples.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
  // The despill divides by these two spans; never let them get small.
  return key[0] - key[1] < 64 || key[2] - key[1] < 64 ? NOMINAL_KEY : key;
}

async function chromaDistances(data, key, n) {
  const c = [0, 0];
  chromaInto(key[0], key[1], key[2], c);
  const len = Math.hypot(c[0], c[1]);
  const kx = c[0] / len;
  const ky = c[1] / len;
  const ks = Math.min(1, len);
  const dist = new Float32Array(n);
  await forSlices(n, (start, end) => {
    for (let i = start, o = start * 4; i < end; i++, o += 4) {
      chromaInto(data[o], data[o + 1], data[o + 2], c);
      const perp = c[0] * ky - c[1] * kx;
      const radial = Math.max(0, ks - (c[0] * kx + c[1] * ky));
      dist[i] = Math.sqrt(radial * radial + HUE_WEIGHT * HUE_WEIGHT * perp * perp);
    }
  });
  return { dist, kx, ky };
}

// Breadth-first spread over 4-neighbors. visit(j, i) returns true to enqueue j.
function spread(queue, tail, n, visit) {
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % SIZE;
    if (x > 0 && visit(i - 1, i)) queue[tail++] = i - 1;
    if (x < SIZE - 1 && visit(i + 1, i)) queue[tail++] = i + 1;
    if (i >= SIZE && visit(i - SIZE, i)) queue[tail++] = i - SIZE;
    if (i < n - SIZE && visit(i + SIZE, i)) queue[tail++] = i + SIZE;
  }
  return tail;
}

// The hot loop (most of the image), so its neighbor checks are inline rather
// than through spread(), which costs about twice the time here. The queue is
// drained SLICE entries at a time with a yield between batches; the visit
// order, and so the result, is the same as one unbroken loop.
async function floodFromBorder(dist, queue, n) {
  const region = new Uint8Array(n);
  let tail = 0;
  for (let s = 0; s < SIZE; s++) {
    for (const i of [s, (SIZE - 1) * SIZE + s, s * SIZE, s * SIZE + SIZE - 1]) {
      if (!region[i] && dist[i] < OUTER) { region[i] = 1; queue[tail++] = i; }
    }
  }
  let head = 0;
  while (head < tail) {
    if (head > 0) await yieldToLoop();
    const stop = head + SLICE;
    for (; head < tail && head < stop; head++) {
      const i = queue[head];
      const x = i % SIZE;
      let j = i - 1;
      if (x > 0 && !region[j] && dist[j] < OUTER) { region[j] = 1; queue[tail++] = j; }
      j = i + 1;
      if (x < SIZE - 1 && !region[j] && dist[j] < OUTER) { region[j] = 1; queue[tail++] = j; }
      j = i - SIZE;
      if (j >= 0 && !region[j] && dist[j] < OUTER) { region[j] = 1; queue[tail++] = j; }
      j = i + SIZE;
      if (j < n && !region[j] && dist[j] < OUTER) { region[j] = 1; queue[tail++] = j; }
    }
  }
  return { region, count: tail };
}

// Steps from the keyed region out into the drink (1..REF_DEPTH) and from the
// drink into the region (1..BAND_MAX); 0 everywhere else.
async function edgeSteps(region, queue, n) {
  const out = new Uint8Array(n);
  const into = new Uint8Array(n);
  await forSlices(n, (start, end) => {
    for (let i = start; i < end; i++) {
      const x = i % SIZE;
      const own = region[i];
      if ((x > 0 && region[i - 1] !== own) || (x < SIZE - 1 && region[i + 1] !== own)
        || (i >= SIZE && region[i - SIZE] !== own) || (i < n - SIZE && region[i + SIZE] !== own)) {
        if (own) into[i] = 1;
        else out[i] = 1;
      }
    }
  });
  await yieldToLoop();
  let tail = 0;
  for (let i = 0; i < n; i++) if (out[i]) queue[tail++] = i;
  spread(queue, tail, n, (j, i) => {
    if (region[j] || out[j] || out[i] >= REF_DEPTH) return false;
    out[j] = out[i] + 1;
    return true;
  });
  tail = 0;
  for (let i = 0; i < n; i++) if (into[i]) queue[tail++] = i;
  spread(queue, tail, n, (j, i) => {
    if (!region[j] || into[j] || into[i] >= BAND_MAX) return false;
    into[j] = into[i] + 1;
    return true;
  });
  return { out, into };
}

// The nearest drink pixel REF_DEPTH steps in, for every pixel on the way there
// (and the band) within REF_STEPS of one; -1 where none is in reach.
function nearestReference(onPath, out, queue, n) {
  const ref = new Int32Array(n).fill(-1);
  const steps = new Uint8Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) if (out[i] === REF_DEPTH) { ref[i] = i; queue[tail++] = i; }
  spread(queue, tail, n, (j, i) => {
    if (ref[j] >= 0 || !onPath(j) || steps[i] >= REF_STEPS) return false;
    ref[j] = ref[i];
    steps[j] = steps[i] + 1;
    return true;
  });
  return ref;
}

function keyContext([r, g, b], kx, ky) {
  const spanR = r - g;
  const spanB = b - g;
  // Share of the key in a pixel, read off its magenta excess over green.
  const share = (pr, pg, pb) => Math.min((pr - pg) / spanR, (pb - pg) / spanB);
  return { r, g, b, spanR, spanB, kx, ky, share, c: [0, 0] };
}

// Step 4 for one edge pixel, written to pixels[o..o + 2]. fo is its reference
// pixel's offset (negative when none was in reach). band: in the keyed region
// with partial alpha; otherwise an opaque ring pixel.
function cleanEdgePixel(data, pixels, o, fo, band, k) {
  const r = data[o];
  const g = data[o + 1];
  const b = data[o + 2];
  const share0 = k.share(r, g, b);
  let share = share0;
  let allowed = 0;
  let fr = 0;
  let fg = 0;
  let fb = 0;
  if (fo >= 0) {
    [fr, fg, fb] = [data[fo], data[fo + 1], data[fo + 2]];
    allowed = Math.max(0, k.share(fr, fg, fb));
    share = share0 - allowed;
    const [dr, dg, db] = [k.r - fr, k.g - fg, k.b - fb];
    const span2 = dr * dr + dg * dg + db * db;
    if (span2 > 900) { // a reference within 30 levels of the key defines no line
      const t = Math.max(0, Math.min(1, ((r - fr) * dr + (g - fg) * dg + (b - fb) * db) / span2));
      const residual2 = (r - fr - t * dr) ** 2 + (g - fg - t * dg) ** 2 + (b - fb - t * db) ** 2;
      // A band pixel is mostly key, and unmixing it would divide JPEG noise
      // by a small number; near the line its color simply is the reference's.
      if (band && residual2 <= BAND_RESIDUAL_MAX ** 2) {
        pixels[o] = fr;
        pixels[o + 1] = fg;
        pixels[o + 2] = fb;
        return;
      }
      if (!band && residual2 <= RESIDUAL_MAX ** 2 && t > share) share = t;
    }
  } else if (!band) {
    chromaInto(r, g, b, k.c);
    const hueErr = Math.abs(k.c[0] * k.ky - k.c[1] * k.kx);
    const gate = Math.max(0, Math.min(1, (HUE_GATE_HI - hueErr) / (HUE_GATE_HI - HUE_GATE_LO)));
    share = share0 * gate;
    allowed = Math.max(0, share0) * (1 - gate);
  }
  let [nr, ng, nb] = [r, g, b];
  if (share > 0) {
    const s = Math.min(share, MAX_KEY_SHARE);
    const unmix = (v, kv) => Math.max(0, Math.min(255, (v - s * kv) / (1 - s)));
    [nr, ng, nb] = [unmix(r, k.r), unmix(g, k.g), unmix(b, k.b)];
  }
  const excess = k.share(nr, ng, nb) - allowed;
  if (excess > 0) {
    nr -= excess * k.spanR;
    nb -= excess * k.spanB;
  }
  // A band pixel JPEG pushed off the line may still not end up redder or
  // bluer, against green, than its reference: a rose edge over a navy ground
  // reads as pink.
  if (band && fo >= 0) {
    nr = Math.min(nr, ng + Math.max(0, fr - fg));
    nb = Math.min(nb, ng + Math.max(0, fb - fg));
  }
  pixels[o] = Math.round(nr);
  pixels[o + 1] = Math.round(ng);
  pixels[o + 2] = Math.round(nb);
}

// Decodes any input to SIZE x SIZE raw RGBA. sharp refuses an input over
// PIXEL_LIMIT at its header (metadata() included), surfaced as image_too_large.
async function decodeRgba(buffer) {
  try {
    const { width, height } = await sharp(buffer, SHARP_INPUT).metadata();
    let pipeline = sharp(buffer, SHARP_INPUT);
    if (width !== SIZE || height !== SIZE) pipeline = pipeline.resize(SIZE, SIZE, { fit: 'cover' });
    const data = await pipeline.toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer();
    return data;
  } catch (err) {
    if (/exceeds pixel limit/i.test(String(err && err.message))) throw new MenuKeyOutFailed(null, 'image_too_large');
    throw err;
  }
}

async function keyOutMagenta(buffer, { minKeyFraction = 0.25 } = {}) {
  if (typeof minKeyFraction !== 'number' || !(minKeyFraction >= 0 && minKeyFraction <= 1)) {
    throw new TypeError('minKeyFraction must be a number from 0 to 1');
  }
  const data = await decodeRgba(buffer);
  const n = SIZE * SIZE;
  await yieldToLoop();

  const key = estimateKey(data);
  const { dist, kx, ky } = await chromaDistances(data, key, n);
  await yieldToLoop();
  const queue = new Int32Array(n);
  const { region, count } = await floodFromBorder(dist, queue, n);
  if (count / n < minKeyFraction) throw new MenuKeyOutFailed(count / n);
  await yieldToLoop();

  const { out: ringStep, into: bandStep } = await edgeSteps(region, queue, n);
  await yieldToLoop();
  const alpha = new Uint8Array(n).fill(255);
  await forSlices(n, (start, end) => {
    for (let i = start; i < end; i++) {
      if (!region[i]) continue;
      const d = dist[i];
      alpha[i] = d <= INNER || !bandStep[i] ? 0 : Math.min(254, Math.round((255 * (d - INNER)) / (OUTER - INNER)));
    }
  });
  await yieldToLoop();
  const band = (i) => region[i] === 1 && alpha[i] > 0;
  const ref = nearestReference((i) => (ringStep[i] >= 1 && ringStep[i] < REF_DEPTH) || band(i), ringStep, queue, n);
  await yieldToLoop();

  const pixels = Buffer.from(data);
  const k = keyContext(key, kx, ky);
  await forSlices(n, (start, end) => {
    for (let i = start, o = start * 4; i < end; i++, o += 4) {
      if ((ringStep[i] >= 1 && ringStep[i] <= RING) || band(i)) cleanEdgePixel(data, pixels, o, ref[i] * 4, region[i] === 1, k);
      pixels[o + 3] = Math.round((alpha[i] * data[o + 3]) / 255);
    }
  });
  await yieldToLoop();
  return sharp(pixels, { ...SHARP_INPUT, raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer();
}

module.exports = { keyOutMagenta, MenuKeyOutFailed };
