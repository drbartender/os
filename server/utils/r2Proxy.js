// The menu-art image routes (spec 7) send their R2 objects through here: the
// background and drink layers, the uploaded reference and the planner image.
// It is deliberately a sibling of sendMenuPrintFile (menuPrintFile.js), not a
// refactor of it: the print downloads are a working money path that staff print
// from, so they stay untouched. The headers match that helper's. The body is
// buffered rather than streamed, because a thumbnail is resized in memory and
// these layers are bounded (a 2560x3200 JPEG background is the largest).
//
// The key guard runs inside sendR2Object: every call names the prefix its key
// must sit under (the art, reference and planner image prefixes differ), and
// assertKeyUnder checks it before anything else, the same check the job makes
// before any bytes go to a provider (spec 5.4). A call with no prefix is a
// programming error and throws, so a route can never skip the guard.
const crypto = require('crypto');
const sharp = require('sharp');
const storage = require('./storage');
const { AppError, NotFoundError, ValidationError } = require('./errors');

// The only downscales the routes offer: the card's thumbnail and the phone.
const RESIZE_WIDTHS = Object.freeze([240, 480]);
const DISPOSITIONS = new Set(['inline', 'attachment']);

// Decode ceiling for a resize, in pixels. sharp's default (268 MP) let a 783 KB
// interlaced 16000x16000 PNG, which a client can upload as the planner logo,
// take 6 s and about 900 MB per view. sharp checks this against the header, so
// an image over it is refused before a single pixel is decoded. 50 MP leaves
// room for a phone's full-resolution 48 MP photo used as a logo or reference.
const RESIZE_PIXEL_LIMIT = 50_000_000;

// The pixel limit alone still let a 0.38 MB interlaced 16-bit RGBA PNG under
// 50 MP decode to about 430 MB per view. So the decoded size is budgeted too,
// from the header: width x height x channels x bytes per sample. 200 MB covers
// a 50 MP 8-bit RGBA image and a 48 MP phone photo (about 144 MB) with room.
const RESIZE_BYTE_LIMIT = 200 * 1024 * 1024;
const BYTES_PER_SAMPLE = { uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, complex: 8, double: 8, dpcomplex: 16 };

// The decoded size, from a sharp metadata() header, that RESIZE_BYTE_LIMIT
// budgets. Also used by menuImageProvider for the references it re-encodes.
function decodedBytes({ width, height, channels, depth } = {}) {
  return (width || 0) * (height || 0) * (channels || 4) * (BYTES_PER_SAMPLE[depth] || 4);
}

// Re-encoders for a resized copy, chosen by the DECODED format, never the key's
// extension or R2's stored type. PNG stays PNG so a drink layer keeps its alpha;
// a format with no entry here also comes out as PNG (lossless, alpha-safe).
const ENCODERS = new Map([
  ['png', { contentType: 'image/png', encode: (img) => img.png() }],
  ['jpeg', { contentType: 'image/jpeg', encode: (img) => img.jpeg({ quality: 82 }) }],
  ['webp', { contentType: 'image/webp', encode: (img) => img.webp({ quality: 82 }) }],
]);

/**
 * Throws NotFoundError unless `key` starts with `prefix` and contains no `..`
 * and no `//`. A prefix check alone would accept `menu-art/1/../<anything>`.
 * The prefix carries its own terminator (`menu-art/<id>/`,
 * `drink-plan-logos/<planId>-`), so event 1 never matches event 12's keys.
 */
function assertKeyUnder(key, prefix) {
  if (
    typeof key !== 'string' || typeof prefix !== 'string' || !prefix
    || !key.startsWith(prefix) || key.includes('..') || key.includes('//')
  ) {
    throw new NotFoundError('File not found.');
  }
}

// undefined or null means full size. 240 and 480 (number, or the digits as a
// query string) mean a downscale; anything else is refused, never ignored, so
// an unexpected `w` cannot quietly pull the full-size layer.
function parseWidth(width) {
  if (width === undefined || width === null) return null;
  const n = typeof width === 'string' && /^\d+$/.test(width) ? Number(width) : width;
  if (!RESIZE_WIDTHS.includes(n)) {
    throw new ValidationError({ w: 'Width must be 240 or 480.' });
  }
  return n;
}

function contentDisposition(disposition, filename) {
  if (!DISPOSITIONS.has(disposition)) {
    throw new Error(`r2Proxy: disposition must be inline or attachment, got ${String(disposition)}`);
  }
  if (filename === undefined || filename === null || filename === '') return disposition;
  // Header-safe: quotes, CR/LF and anything else outside a plain filename
  // become hyphens, so a caller's string can never split or forge a header.
  const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${disposition}; filename="${safe}"`;
}

// A stored object sharp cannot resize is the uploader's image, not an outage:
// a typed 422 the client can show, never a 500 that pages Sentry. The pipeline
// options are constants, so the bytes are the only thing that can fail here.
function imageError(err) {
  if (/pixel limit/i.test(String(err && err.message))) {
    return new AppError('This image is too large to preview.', 422, 'IMAGE_TOO_LARGE');
  }
  return new AppError('This image could not be read.', 422, 'IMAGE_UNREADABLE');
}

async function resizeTo(buffer, width) {
  try {
    const img = sharp(buffer, { limitInputPixels: RESIZE_PIXEL_LIMIT });
    const meta = await img.metadata();
    const { format } = meta;
    if (decodedBytes(meta) > RESIZE_BYTE_LIMIT) {
      throw new Error('decoded size over the pixel limit budget');
    }
    const encoder = ENCODERS.get(format) || ENCODERS.get('png');
    // autoOrient first: the re-encode strips EXIF, so a phone photo's rotation
    // must be applied to the pixels or the thumbnail would come out sideways
    // while the full-size original (EXIF intact) displays upright.
    const out = await encoder
      .encode(img.autoOrient().resize({ width, withoutEnlargement: true }))
      .toBuffer();
    return { buffer: out, contentType: encoder.contentType };
  } catch (err) {
    throw imageError(err);
  }
}

// Same validator scheme as menuPrintFile.js: no-cache plus a digest of the key.
// Every key served here is minted fresh per write (art and references carry a
// uuid, planner images a timestamp), so a re-roll or a replaced image is a new
// key and a new ETag; the key itself stays server-side. The width joins the
// digest input, so the 240, 480 and full-size copies never share one.
function etagFor(key, w) {
  const digestInput = w ? `${key}\nw=${w}` : key;
  return `"${crypto.createHash('sha256').update(digestInput).digest('hex').slice(0, 32)}"`;
}

/**
 * Send R2 object `key` to `res`, optionally downscaled to `width` (240 or 480).
 * `prefix` is required: the key must sit under it (assertKeyUnder) or the
 * answer is a 404 before anything else runs. A request whose If-None-Match
 * already holds this copy gets a 304 before R2 is read. Every refusal and
 * failure (a key outside the prefix, a bad width, NotFoundError on a missing
 * object, ExternalServiceError when R2 is unreachable, a 422 for an image sharp
 * refuses) is thrown with none of the success headers on the response, so the
 * global error middleware can still answer cleanly.
 */
async function sendR2Object(res, key, { prefix, filename, disposition = 'inline', width } = {}) {
  if (typeof prefix !== 'string' || !prefix) {
    throw new Error('r2Proxy: sendR2Object needs the prefix its key must sit under');
  }
  assertKeyUnder(key, prefix);
  const w = parseWidth(width);
  const dispositionHeader = contentDisposition(disposition, filename);
  const etag = etagFor(key, w);

  // The ETag depends only on the key and the width, so a browser revalidating
  // a copy it already holds is answered here, before R2 is downloaded or sharp
  // runs. req.fresh is the same check res.send makes (GET or HEAD, W/ and list
  // forms match, a request no-cache never does); it reads the ETag off the
  // response, so the header goes on for the check and comes back off when the
  // copy is stale, keeping it off any error answer below.
  res.set('ETag', etag);
  if (res.req && res.req.fresh) {
    res.set('Cache-Control', 'private, no-cache');
    res.status(304).end();
    return;
  }
  res.removeHeader('ETag');

  const file = await storage.readFile(key);
  const body = w ? await resizeTo(file.buffer, w) : file;

  res.set('Content-Type', body.contentType || 'application/octet-stream');
  res.set('Content-Disposition', dispositionHeader);
  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', etag);
  // res.send sets Content-Length.
  res.send(body.buffer);
}

module.exports = { sendR2Object, assertKeyUnder, decodedBytes, RESIZE_WIDTHS, RESIZE_PIXEL_LIMIT, RESIZE_BYTE_LIMIT };
