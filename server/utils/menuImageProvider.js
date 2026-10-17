// The one place the menu art job asks for an image (spec 2026-10-01 sections
// 5.1 and 5.4, decision 11; plan Task E3b). It routes a piece to the wrapper
// of the provider stamped on it and returns the bytes the job stores:
//
// drawImage({ provider, model, kind, prompt, references })
//   provider 'openai' | 'gemini', model the piece's STAMPED model id (never
//   the env value at call time), kind 'background' | 'drink', references
//   [{ buffer, mimeType }] (style references, and for a drink the background).
//   Resolves to { buffer, contentType, model, size, requestId }:
//   - openai background: generateImage, or editImage with references, at
//     MENU_ART_BACKGROUND_SIZE (default 2560x3200), quality high, JPEG. Drinks use
//     quality medium (spec 13's per-drink estimate).
//   - openai drink: editImage with references (generateImage when there are
//     none, since editImage needs an input image), 1024x1024, background
//     transparent, PNG.
//   - gemini background: 4:5 at 4K (3712x4608), then resized with sharp to
//     2560x3200 JPEG, fit cover.
//   - gemini drink: 1:1 at 1K, then keyOutMagenta (which also resizes to
//     1024x1024 when needed), PNG with real alpha.
//   size is what the provider was asked for ('2560x3200', '4:5 4K').
//
// Errors fold into two shapes so the job handles one of each:
// - MenuArtRefusal (.reason, a fixed readable sentence, never provider text;
//   .descriptor, the sanitized descriptor for Sentry) for OpenAIRefusal,
//   GeminiRefusal and MenuKeyOutFailed;
// - MenuArtRateLimited (.retryAfterSec, at most 60, 20 when none was sent;
//   .descriptor) for both providers' rate limits.
// Anything else passes through. A failure after the provider answered (the
// image could not be processed) carries a descriptor with the request id.
// Gemini without GEMINI_API_KEY throws AppError 503
// MENU_ART_GEMINI_NOT_CONFIGURED before anything is sent.

const sharp = require('sharp');
const openaiClient = require('./openaiClient');
const geminiClient = require('./geminiClient');
const { keyOutMagenta, MenuKeyOutFailed } = require('./menuKeyOut');
const { decodedBytes, RESIZE_BYTE_LIMIT } = require('./r2Proxy');
const { AppError } = require('./errors');

const PROVIDERS = new Set(['openai', 'gemini']);
const KINDS = new Set(['background', 'drink']);
const BACKGROUND_SIZE_DEFAULT = '2560x3200';
const DRINK_SIZE = '1024x1024';
const DRINK_PX = 1024;
const GEMINI = Object.freeze({
  background: { aspectRatio: '4:5', imageSize: '4K', width: 2560, height: 3200 },
  drink: { aspectRatio: '1:1', imageSize: '1K' },
});
const REFERENCE_MAX_EDGE = 1536;
const JPEG_QUALITY = 92;
const SHARP_INPUT = { limitInputPixels: 50_000_000 };
const RETRY_DEFAULT_SEC = 20;
const RETRY_MAX_SEC = 60;
const MIME_EXT = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);
// OpenAI's image refusal carries the API's own message, which can quote the
// prompt; the piece stores this sentence instead.
const OPENAI_REFUSAL_REASON = 'OpenAI blocked this image for safety. Try a different note or art direction.';
const GEMINI_REFUSAL_FALLBACK = 'Gemini blocked this image.';

class MenuArtRefusal extends Error {
  constructor(reason, descriptor) {
    super(reason);
    Object.assign(this, { name: 'MenuArtRefusal', code: 'MENU_ART_REFUSED', reason, descriptor: descriptor || null });
  }
}

class MenuArtRateLimited extends Error {
  constructor(retryAfterSec, descriptor) {
    super('The image provider rate limit was reached.');
    Object.assign(this, { name: 'MenuArtRateLimited', retryAfterSec, descriptor: descriptor || null });
  }
}

const descriptor = (provider, errorClass, requestId = null, code = null) => ({ provider, errorClass, status: null, requestId, code });

let warnedSize = false;
// WxH, both sides multiples of 16 and at most 3840 (OpenAI's rule, spec 2).
// Anything else uses the default, with one warning per process.
function backgroundSize() {
  const raw = process.env.MENU_ART_BACKGROUND_SIZE;
  if (raw === undefined) return BACKGROUND_SIZE_DEFAULT;
  const m = /^(\d{1,4})x(\d{1,4})$/i.exec(String(raw).trim());
  const sides = m ? [Number(m[1]), Number(m[2])] : [];
  if (sides.length === 2 && sides.every((n) => n >= 16 && n <= 3840 && n % 16 === 0)) return `${sides[0]}x${sides[1]}`;
  if (!warnedSize) {
    warnedSize = true;
    console.warn(`[menuImageProvider] MENU_ART_BACKGROUND_SIZE is not a valid WxH; using ${BACKGROUND_SIZE_DEFAULT}`);
  }
  return BACKGROUND_SIZE_DEFAULT;
}

// A Retry-After in whole seconds: at most 60, 20 when none (or nonsense) was
// sent. The one helper for both the provider fold here and the job's 429 wait.
function retrySeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return RETRY_DEFAULT_SEC;
  return Math.min(RETRY_MAX_SEC, Math.ceil(n));
}

function normalizeError(err) {
  if (err instanceof openaiClient.OpenAIRefusal) return new MenuArtRefusal(OPENAI_REFUSAL_REASON, err.descriptor);
  if (err instanceof geminiClient.GeminiRefusal) {
    // The wrapper's reasons are its own fixed sentences (REFUSAL_RULES).
    const reason = typeof err.reason === 'string' && err.reason && err.reason.length <= 200 ? err.reason : GEMINI_REFUSAL_FALLBACK;
    return new MenuArtRefusal(reason, err.descriptor);
  }
  if (err instanceof openaiClient.OpenAIRateLimited || err instanceof geminiClient.GeminiRateLimited) {
    return new MenuArtRateLimited(retrySeconds(err.retryAfterSec), err.descriptor);
  }
  return err;
}

async function callProvider(fn) {
  try {
    return await fn();
  } catch (err) {
    throw normalizeError(err);
  }
}

// Work on bytes the provider already returned (and billed): a failure keeps
// only a descriptor naming the provider and request, never sharp's message.
async function afterCall(provider, requestId, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MenuKeyOutFailed) {
      throw new MenuArtRefusal(err.reason, descriptor(provider, 'MenuKeyOutFailed', requestId, err.code));
    }
    const failed = new Error('The drawn image could not be processed.');
    failed.name = 'MenuArtImageUnprocessable';
    failed.descriptor = descriptor(provider, 'ImageUnprocessable', requestId, 'image_unprocessable');
    throw failed;
  }
}

// One reference made safe to send, ALWAYS re-encoded, even when it is
// already small: sharp writes no metadata unless asked, so no EXIF, XMP or
// ICC text (a phone photo's GPS, an Artist or Owner name) ever reaches a
// provider, and autoOrient puts the EXIF rotation into the pixels first. PNG
// when it has alpha, JPEG otherwise; at most REFERENCE_MAX_EDGE on its long
// edge (so a large upload does not blow the Gemini request, which carries
// images as base64). r2Proxy's decoded-size budget is checked against the
// header before a pixel is decoded. Cached per buffer, the prepared output
// included, so the background and the reference passed to every drink of a
// run are read and re-encoded once.
const prepared = new WeakMap();

async function prepareOne(buffer) {
  const meta = await sharp(buffer, SHARP_INPUT).metadata();
  if (decodedBytes(meta) > RESIZE_BYTE_LIMIT) throw new Error('over the decoded-size budget');
  const img = sharp(buffer, SHARP_INPUT).autoOrient()
    .resize(REFERENCE_MAX_EDGE, REFERENCE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true });
  if (meta.format === 'png' || meta.hasAlpha) return { buffer: await img.png().toBuffer(), mimeType: 'image/png' };
  return { buffer: await img.jpeg({ quality: JPEG_QUALITY }).toBuffer(), mimeType: 'image/jpeg' };
}

/** [{ buffer, mimeType }] -> the same, prepared; the job may call it once per run. */
async function prepareReferences(references = []) {
  if (!Array.isArray(references) || references.some((r) => !r || !Buffer.isBuffer(r.buffer) || r.buffer.length === 0)) {
    throw new TypeError('menuImageProvider: references must be [{ buffer, mimeType }]');
  }
  const out = await Promise.all(references.map((r) => {
    let pending = prepared.get(r.buffer);
    if (!pending) {
      pending = prepareOne(r.buffer).then((out) => {
        // A prepared reference handed back in (the job keeps only these) is final.
        prepared.set(out.buffer, Promise.resolve(out));
        return out;
      }, () => {
        prepared.delete(r.buffer);
        const err = new AppError('A style reference image could not be read.', 422, 'MENU_ART_REFERENCE_UNREADABLE');
        err.descriptor = descriptor(null, 'ReferenceUnreadable', null, 'reference_unreadable');
        throw err;
      });
      prepared.set(r.buffer, pending);
    }
    return pending;
  }));
  return out;
}

// Fixed safe filenames (never a client's original name) for the edit upload.
const openaiImages = (refs) => refs.map((r, i) => ({
  buffer: r.buffer, filename: `reference-${i + 1}.${MIME_EXT.get(r.mimeType)}`, contentType: r.mimeType,
}));

async function asJpeg(buffer) {
  const { format } = await sharp(buffer, SHARP_INPUT).metadata();
  return format === 'jpeg' ? buffer : sharp(buffer, SHARP_INPUT).jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

async function asDrinkPng(buffer) {
  const { format, width, height, hasAlpha } = await sharp(buffer, SHARP_INPUT).metadata();
  if (format === 'png' && width === DRINK_PX && height === DRINK_PX && hasAlpha) return buffer;
  return sharp(buffer, SHARP_INPUT)
    .resize(DRINK_PX, DRINK_PX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function drawOpenAI({ model, kind, prompt, refs }) {
  const size = kind === 'background' ? backgroundSize() : DRINK_SIZE;
  const opts = kind === 'background'
    ? { prompt, size, quality: 'high', outputFormat: 'jpeg', model }
    : { prompt, size, quality: 'medium', outputFormat: 'png', background: 'transparent', model };
  const { buffer, requestId } = await callProvider(() => (refs.length
    ? openaiClient.editImage({ ...opts, images: openaiImages(refs) })
    : openaiClient.generateImage(opts)));
  const out = await afterCall('openai', requestId, () => (kind === 'background' ? asJpeg(buffer) : asDrinkPng(buffer)));
  return { buffer: out, contentType: kind === 'background' ? 'image/jpeg' : 'image/png', model, size, requestId };
}

async function drawGemini({ model, kind, prompt, refs }) {
  const spec = kind === 'background' ? GEMINI.background : GEMINI.drink;
  const { buffer, responseId } = await callProvider(() => geminiClient.generateImage({
    prompt, images: refs, aspectRatio: spec.aspectRatio, imageSize: spec.imageSize, model,
  }));
  const size = `${spec.aspectRatio} ${spec.imageSize}`;
  if (kind === 'background') {
    const out = await afterCall('gemini', responseId, () => sharp(buffer, SHARP_INPUT)
      .resize(spec.width, spec.height, { fit: 'cover' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer());
    return { buffer: out, contentType: 'image/jpeg', model, size, requestId: responseId };
  }
  const out = await afterCall('gemini', responseId, () => keyOutMagenta(buffer));
  return { buffer: out, contentType: 'image/png', model, size, requestId: responseId };
}

async function drawImage({ provider, model, kind, prompt, references = [] } = {}) {
  if (!PROVIDERS.has(provider)) throw new TypeError('menuImageProvider.drawImage: provider must be openai or gemini');
  if (!KINDS.has(kind)) throw new TypeError('menuImageProvider.drawImage: kind must be background or drink');
  if (typeof model !== 'string' || model.trim() === '') throw new TypeError('menuImageProvider.drawImage: the stamped model is required');
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError('menuImageProvider.drawImage: prompt is required');
  if (provider === 'gemini' && !geminiClient.isConfigured()) {
    throw new AppError('Gemini is not set up.', 503, 'MENU_ART_GEMINI_NOT_CONFIGURED');
  }
  const refs = await prepareReferences(references);
  return provider === 'openai'
    ? drawOpenAI({ model, kind, prompt, refs })
    : drawGemini({ model, kind, prompt, refs });
}

module.exports = {
  drawImage, prepareReferences, retrySeconds, MenuArtRefusal, MenuArtRateLimited,
  BACKGROUND_SIZE_DEFAULT, OPENAI_REFUSAL_REASON, REFERENCE_MAX_EDGE,
};
