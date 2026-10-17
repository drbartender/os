// The ONLY module that requires @google/genai (spec 2026-10-01 section 5.1,
// decision 11). Menu art asks Gemini for images only through generateImage on
// the Interactions API, and every call holds: the key passed explicitly (no
// GOOGLE_API_KEY fallback), the Gemini host pinned and Vertex off
// (GOOGLE_GENAI_DEBUG and GOOGLE_GENAI_USER_PROJECT refuse the call), store
// false (Google keeps requests 55 days otherwise), no delivery key (the API
// rejects one; the image comes back inline), maxRetries 0 and an explicit
// timeout per call. The menu art job owns retries. Under NODE_ENV=test every
// call rejects unless a test injected a stub (__setTestStub).
// Only the sanitized descriptor (describeError) may be stored or sent to Sentry,
// never the SDK message, which can quote the request; prompts and images never.

const { GoogleGenAI } = require('@google/genai');
const { AppError, ExternalServiceError } = require('./errors');
const { readEnvInt } = require('./envInt');

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/';
const IMAGE_TIMEOUT_DEFAULT_MS = 180000;
const RETRY_AFTER_DEFAULT_SEC = 20;
const RETRY_AFTER_MAX_SEC = 60;
const IMAGE_SIZES = new Set(['512', '1K', '2K', '4K']); // uppercase K; the API rejects '1k'
const NO_SINGLE_IMAGE = 'Gemini answered without a single image.';

// The SDK's APIError family is not exported from its CommonJS entry, so the
// class is read from err.name, which the SDK sets to the constructor name.
const SDK_ERROR_NAMES = new Set([
  'APIError', 'APIUserAbortError', 'APIConnectionError', 'APIConnectionTimeoutError',
  'BadRequestError', 'AuthenticationError', 'PermissionDeniedError', 'NotFoundError',
  'ConflictError', 'UnprocessableEntityError', 'RateLimitError', 'InternalServerError',
]);

// Matched on the code's last path segment, lowercased, so IMAGE_SAFETY,
// image_safety and a URI ending in either read the same. First match wins.
const REFUSAL_RULES = [
  [/safety/, 'Gemini blocked this image for safety.'],
  [/prohibited/, 'Gemini blocked this image as prohibited content.'],
  [/blocklist/, 'Gemini blocked a word or phrase in the prompt.'],
  [/blocked/, 'Gemini blocked this content.'],
  [/recitation/, 'Gemini stopped because the image was too close to an existing work.'],
  [/^image_other$/, 'Gemini stopped drawing this image without saying why.'],
  [/^no_image$/, 'Gemini answered without an image.'],
];

class GeminiRefusal extends Error {
  constructor(reason, descriptor) {
    super('Gemini refused the request.');
    Object.assign(this, { name: 'GeminiRefusal', reason, descriptor });
  }
}

class GeminiRateLimited extends Error {
  constructor(retryAfterSec, descriptor) {
    super('Gemini rate limit reached.');
    Object.assign(this, { name: 'GeminiRateLimited', retryAfterSec, descriptor });
  }
}

function isConfigured() {
  return String(process.env.GEMINI_API_KEY || '').trim() !== '';
}

function clientOptions(apiKey) {
  return { apiKey, vertexai: false, httpOptions: { baseUrl: GEMINI_API_BASE_URL } };
}

function callOptions() {
  return { timeout: readEnvInt('MENU_ART_IMAGE_TIMEOUT_MS', IMAGE_TIMEOUT_DEFAULT_MS), maxRetries: 0 };
}

let testStub = null;
let realClient = null;
let realClientKey = null;

function __setTestStub(stub) {
  if (process.env.NODE_ENV === 'production') throw new Error('geminiClient: __setTestStub is test-only');
  testStub = stub || null;
}

function getClient() {
  if (testStub) return testStub;
  if (process.env.NODE_ENV === 'test') {
    throw new Error('Gemini disabled under test; inject a stub with __setTestStub');
  }
  if (!isConfigured()) throw new AppError('Gemini is not set up.', 503, 'MENU_ART_GEMINI_NOT_CONFIGURED');
  // Any value of GOOGLE_GENAI_DEBUG (even "false" or a lone space) makes the
  // SDK print every request, the API key header and base64 images included,
  // to the console, and no client option turns that off. The test mirrors the
  // SDK's own, plain truthiness of the raw value, so nothing it logs for gets
  // past. Refuse rather than log the key.
  if (process.env.GOOGLE_GENAI_DEBUG) {
    throw externalError(descriptor('SdkDebugLoggingOn', { code: 'google_genai_debug' }));
  }
  // GOOGLE_GENAI_USER_PROJECT (any value, even blank) makes the SDK send an
  // x-goog-user-project header, which bills and attributes the call to
  // whatever project it names. Refuse rather than let the environment move it.
  if (process.env.GOOGLE_GENAI_USER_PROJECT !== undefined) {
    throw externalError(descriptor('SdkUserProjectSet', { code: 'google_genai_user_project' }));
  }
  const key = String(process.env.GEMINI_API_KEY).trim();
  if (!realClient || realClientKey !== key) {
    realClient = new GoogleGenAI(clientOptions(key));
    realClientKey = key;
  }
  return realClient;
}

// The last path segment of an error code, lowercased, dashes as underscores;
// anything that does not look like an identifier is dropped.
function codeSegment(code) {
  if (typeof code !== 'string') return null;
  const parts = code.trim().split(/[/#]/).filter(Boolean);
  const seg = (parts.length ? parts[parts.length - 1] : '').toLowerCase().replace(/-/g, '_');
  return /^[a-z0-9_.]{1,64}$/.test(seg) ? seg : null;
}

function refusalReason(seg) {
  const rule = seg ? REFUSAL_RULES.find(([pattern]) => pattern.test(seg)) : null;
  return rule ? rule[1] : null;
}

function descriptor(errorClass, { status = null, requestId = null, code = null } = {}) {
  return { provider: 'gemini', errorClass, status, requestId, code };
}

// The parsed error body is either { code, ... } or the whole { error: { ... } }
// envelope, so the code sits at err.error.code or err.error.error.code. Only
// a string code is read: the envelope's numeric code is the HTTP status.
function errorEnvelope(err) {
  const body = err && err.error && typeof err.error === 'object' ? err.error : null;
  if (!body) return null;
  return body.error && typeof body.error === 'object' ? body.error : body;
}

function errorCode(err) {
  const body = err && err.error && typeof err.error === 'object' ? err.error : null;
  if (body && typeof body.code === 'string') return body.code;
  const env = errorEnvelope(err);
  return env && typeof env.code === 'string' ? env.code : null;
}

/** The sanitized descriptor of any failure; errors thrown here already carry it. */
function describeError(err) {
  if (err && err.descriptor && err.descriptor.provider === 'gemini') return err.descriptor;
  let errorClass = 'UnknownError';
  if (err instanceof Error && SDK_ERROR_NAMES.has(err.name)) errorClass = err.name;
  else if (err instanceof TypeError) errorClass = 'TypeError';
  else if (err instanceof RangeError) errorClass = 'RangeError';
  return descriptor(errorClass, {
    status: err && Number.isInteger(err.status) ? err.status : null,
    code: codeSegment(errorCode(err)),
  });
}

function formatError(d) {
  return [d.provider, d.errorClass, d.status, d.requestId, d.code]
    .filter((v) => v !== null && v !== undefined && v !== '').join(' ');
}

function externalError(d) {
  const original = Object.assign(new Error(formatError(d)), { name: d.errorClass });
  const err = new ExternalServiceError('gemini', original, 'Gemini is temporarily unavailable.');
  err.descriptor = d;
  return err;
}

function headerValue(headers, name) {
  const v = headers && typeof headers.get === 'function' ? headers.get(name) : null;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// retry-after-ms, else Retry-After (seconds or an HTTP date), else the body's
// google.rpc.RetryInfo retryDelay ("37s"), else 20; never above 60 or below 1.
function retryAfterSeconds(err) {
  const ms = headerValue(err.headers, 'retry-after-ms');
  const raw = headerValue(err.headers, 'retry-after');
  let sec = null;
  if (ms !== null && Number(ms) >= 0) sec = Number(ms) / 1000;
  else if (raw !== null && Number(raw) >= 0) sec = Number(raw);
  else if (raw !== null && Number.isFinite(Date.parse(raw))) sec = Math.max(0, (Date.parse(raw) - Date.now()) / 1000);
  else if (raw === null) {
    const env = errorEnvelope(err);
    for (const d of env && Array.isArray(env.details) ? env.details : []) {
      const delay = d && typeof d.retryDelay === 'string' ? d.retryDelay.trim() : '';
      const n = delay.length > 1 && delay.endsWith('s') ? Number(delay.slice(0, -1)) : NaN;
      if (Number.isFinite(n) && n >= 0) { sec = n; break; }
    }
  }
  if (sec === null || !Number.isFinite(sec)) return RETRY_AFTER_DEFAULT_SEC;
  return Math.min(RETRY_AFTER_MAX_SEC, Math.max(1, Math.ceil(sec)));
}

// A thrown SDK error becomes GeminiRateLimited (a 429 or RESOURCE_EXHAUSTED),
// GeminiRefusal (a code REFUSAL_RULES reads) or ExternalServiceError('gemini').
function mapError(err) {
  if (err instanceof GeminiRefusal || err instanceof GeminiRateLimited || err instanceof AppError) return err;
  const d = describeError(err);
  const env = errorEnvelope(err);
  const rpcStatus = env && typeof env.status === 'string' ? env.status.toUpperCase() : null;
  if (d.status === 429 || rpcStatus === 'RESOURCE_EXHAUSTED') return new GeminiRateLimited(retryAfterSeconds(err), d);
  const reason = refusalReason(d.code);
  return reason ? new GeminiRefusal(reason, d) : externalError(d);
}

// The image blocks of the model's answer to this request: every image in a
// model_output step after the last user_input step (the scan the SDK runs to
// set output_image, which keeps only the last one). output_image alone is
// read only when the answer has no steps at all.
function answerImages(interaction) {
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  const images = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step && step.type === 'user_input') break;
    if (step && step.type === 'model_output' && Array.isArray(step.content)) {
      images.push(...step.content.filter((c) => c && c.type === 'image'));
    }
  }
  if (steps.length === 0 && interaction.output_image) images.push(interaction.output_image);
  return images;
}

function readImage(interaction) {
  const responseId = interaction && typeof interaction.id === 'string' && interaction.id ? interaction.id : null;
  const status = interaction && interaction.status;
  if (status === 'failed' || status === 'incomplete') {
    const first = Array.isArray(interaction.errors) && interaction.errors[0] ? interaction.errors[0] : null;
    const code = codeSegment(first && first.code);
    const errorClass = status === 'failed' ? 'InteractionFailed' : 'InteractionIncomplete';
    throw new GeminiRefusal(refusalReason(code) || 'Gemini could not finish this image.', descriptor(errorClass, { requestId: responseId, code }));
  }
  if (status && status !== 'completed') {
    throw externalError(descriptor('InteractionNotCompleted', { requestId: responseId, code: codeSegment(String(status)) }));
  }
  const images = interaction ? answerImages(interaction) : [];
  const image = images.length === 1 ? images[0] : null;
  const buffer = Buffer.from(image && typeof image.data === 'string' ? image.data : '', 'base64');
  if (buffer.length === 0) {
    const code = images.length === 0 ? 'no_image' : images.length > 1 ? 'multiple_images' : 'empty_image';
    throw new GeminiRefusal(NO_SINGLE_IMAGE, descriptor('NoSingleImage', { requestId: responseId, code }));
  }
  return {
    buffer,
    mimeType: typeof image.mime_type === 'string' && image.mime_type ? image.mime_type : 'image/jpeg',
    responseId,
    usage: interaction.usage && typeof interaction.usage === 'object' ? interaction.usage : null,
  };
}

/**
 * One image from a prompt plus optional input images (style references, the
 * background) at an explicit aspect ratio ('4:5', '1:1') and size ('1K',
 * '4K'). images: [{ buffer, mimeType }]. Resolves to
 * { buffer, mimeType, responseId, usage }.
 */
async function generateImage({ prompt, images = [], aspectRatio, imageSize, model }) {
  const size = typeof imageSize === 'string' ? imageSize.trim().toUpperCase() : '';
  if (!IMAGE_SIZES.has(size)) throw new TypeError('geminiClient.generateImage: imageSize must be 512, 1K, 2K or 4K');
  if (typeof aspectRatio !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
    throw new TypeError('geminiClient.generateImage: aspectRatio must look like 4:5');
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError('geminiClient.generateImage: prompt is required');
  if (typeof model !== 'string' || model.trim() === '') throw new TypeError('geminiClient.generateImage: model is required');
  if (!Array.isArray(images) || images.some((i) => !i || !Buffer.isBuffer(i.buffer) || typeof i.mimeType !== 'string')) {
    throw new TypeError('geminiClient.generateImage: images must be [{ buffer, mimeType }]');
  }
  const client = getClient();
  let interaction;
  try {
    interaction = await client.interactions.create({
      model,
      input: [
        { type: 'text', text: prompt },
        ...images.map((i) => ({ type: 'image', data: i.buffer.toString('base64'), mime_type: i.mimeType })),
      ],
      store: false,
      // No delivery key, though the SDK types one: the API answers any image
      // delivery value with 400 "Image delivery mode is not supported." and
      // returns the image inline (base64 data) when it is left out.
      response_format: { type: 'image', aspect_ratio: aspectRatio, image_size: size },
    }, callOptions());
  } catch (err) {
    throw mapError(err);
  }
  return readImage(interaction);
}

function _getClientForTest() { return getClient(); }

function _resetForTest() {
  testStub = null;
  realClient = null;
  realClientKey = null;
}

module.exports = {
  GEMINI_API_BASE_URL, IMAGE_TIMEOUT_DEFAULT_MS, SDK_ERROR_NAMES,
  GeminiRefusal, GeminiRateLimited,
  isConfigured, clientOptions, generateImage, describeError, formatError,
  __setTestStub, _getClientForTest, _resetForTest,
};
