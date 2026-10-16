// The ONLY module that requires the openai package (the stripeClient.js and
// anthropicClient.js precedents; spec 2026-10-01 section 5.1). Menu art asks
// OpenAI for words and images only through the functions below, so the
// options pinned here hold for every call.
//
// Under NODE_ENV=test every call rejects unless a test injected a stub
// (__setTestStub), so a missed mock can never spend money. Nothing here
// retries: the client and every call run with maxRetries 0, and the menu art
// job owns retries (an OpenAIRateLimited only, section 5.5).
//
// What may be stored or sent to Sentry about a failure is the sanitized
// descriptor (describeError): provider, error class, HTTP status, request id
// and the API's error code, never the SDK message, which can quote the
// request. Every error thrown here carries it as err.descriptor, and an
// ExternalServiceError's originalError is built from it, so the global error
// handler's Sentry capture stays clean too.

const { OpenAI, toFile } = require('openai');
const { AppError, ExternalServiceError } = require('./errors');
const { readEnvInt } = require('./envInt');

// Pinned, not read from OPENAI_BASE_URL: client images leave the OS only for
// OpenAI's own API, and an env var must not be able to redirect them.
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const TEXT_TIMEOUT_MS = 60000;
const IMAGE_TIMEOUT_DEFAULT_MS = 180000;
const RETRY_AFTER_DEFAULT_SEC = 20;
const RETRY_AFTER_MAX_SEC = 60;
const REASON_MAX_CHARS = 300;
const DEFAULT_REFUSAL_REASON = 'OpenAI blocked this request for safety.';
// Every refusal of the words call reads this one sentence. The model's own
// refusal text can paraphrase the client's brief, and section 5.1 keeps
// provider text out of words_error, so none of it is ever kept.
const WORDS_REFUSAL_REASON = 'OpenAI declined to write this menu. Try different art direction.';
// What the safety system answers with when it blocks an image
// (moderation_blocked on the GPT image models; the other two on older paths).
const REFUSAL_CODES = new Set(['moderation_blocked', 'content_policy_violation', 'image_content_policy_violation']);

class OpenAIRefusal extends Error {
  constructor(reason, descriptor) {
    super('OpenAI refused the request.');
    Object.assign(this, { name: 'OpenAIRefusal', reason, descriptor });
  }
}

class OpenAIRateLimited extends Error {
  constructor(retryAfterSec, descriptor) {
    super('OpenAI rate limit reached.');
    Object.assign(this, { name: 'OpenAIRateLimited', retryAfterSec, descriptor });
  }
}

function isConfigured() {
  return String(process.env.OPENAI_API_KEY || '').trim() !== '';
}

function imageTimeoutMs() {
  return readEnvInt('MENU_ART_IMAGE_TIMEOUT_MS', IMAGE_TIMEOUT_DEFAULT_MS);
}

// organization and project null: the SDK would otherwise read OPENAI_ORG_ID
// and OPENAI_PROJECT_ID and scope or bill the call to whatever they name.
// adminAPIKey and webhookSecret null: it would otherwise read OPENAI_ADMIN_KEY
// and OPENAI_WEBHOOK_SECRET into the client, and menu art needs neither.
// logLevel 'off': OPENAI_LOG=debug would print request bodies (the client's
// brief and images) into the Render log. Every call also passes its own
// timeout and maxRetries 0, so these are the floor, not the only guard.
function clientOptions(apiKey) {
  return {
    apiKey,
    adminAPIKey: null,
    webhookSecret: null,
    organization: null,
    project: null,
    baseURL: OPENAI_API_BASE_URL,
    maxRetries: 0,
    timeout: TEXT_TIMEOUT_MS,
    logLevel: 'off',
  };
}

function callOptions(timeout) {
  return { timeout, maxRetries: 0 };
}

let testStub = null;
let realClient = null;
let realClientKey = null;

function __setTestStub(stub) {
  if (process.env.NODE_ENV === 'production') throw new Error('openaiClient: __setTestStub is test-only');
  testStub = stub || null;
}

function getClient() {
  if (testStub) return testStub;
  if (process.env.NODE_ENV === 'test') {
    throw new Error('OpenAI disabled under test; inject a stub with __setTestStub');
  }
  if (!isConfigured()) throw new AppError('Menu art is not set up.', 503, 'MENU_ART_NOT_CONFIGURED');
  // The SDK merges OPENAI_CUSTOM_HEADERS after its own auth and organization
  // headers, so it could replace Authorization or OpenAI-Organization despite
  // the pinned options, and no client option turns it off. Refuse while it is
  // set at all, blank included.
  if (process.env.OPENAI_CUSTOM_HEADERS !== undefined) {
    throw externalError(descriptor('SdkCustomHeadersSet', { code: 'openai_custom_headers' }));
  }
  const key = String(process.env.OPENAI_API_KEY).trim();
  if (!realClient || realClientKey !== key) {
    realClient = new OpenAI(clientOptions(key));
    realClientKey = key;
  }
  return realClient;
}

// Most specific first: APIConnectionTimeoutError extends APIConnectionError,
// and both (with APIUserAbortError) extend APIError.
const SDK_ERROR_CLASSES = [
  'APIConnectionTimeoutError', 'APIConnectionError', 'APIUserAbortError', 'BadRequestError',
  'AuthenticationError', 'PermissionDeniedError', 'NotFoundError', 'ConflictError',
  'UnprocessableEntityError', 'RateLimitError', 'InternalServerError', 'APIError', 'OpenAIError',
].map((name) => [name, OpenAI[name]]);

// An API error code is an identifier ("moderation_blocked"); anything that
// does not look like one is dropped rather than stored.
function descriptor(errorClass, { status = null, requestId = null, code = null } = {}) {
  const safeCode = typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : null;
  return { provider: 'openai', errorClass, status, requestId, code: safeCode };
}

/** The sanitized descriptor of any failure; errors thrown here already carry it. */
function describeError(err) {
  if (err && err.descriptor && err.descriptor.provider === 'openai') return err.descriptor;
  const match = SDK_ERROR_CLASSES.find(([, cls]) => typeof cls === 'function' && err instanceof cls);
  let errorClass = match ? match[0] : 'UnknownError';
  if (!match && err instanceof TypeError) errorClass = 'TypeError';
  else if (!match && err instanceof RangeError) errorClass = 'RangeError';
  return descriptor(errorClass, {
    status: err && Number.isInteger(err.status) ? err.status : null,
    requestId: err && typeof err.requestID === 'string' && err.requestID ? err.requestID : null,
    code: err ? err.code : null,
  });
}

function formatError(d) {
  return [d.provider, d.errorClass, d.status, d.requestId, d.code]
    .filter((v) => v !== null && v !== undefined && v !== '').join(' ');
}

function externalError(d) {
  const original = Object.assign(new Error(formatError(d)), { name: d.errorClass });
  const err = new ExternalServiceError('openai', original, 'OpenAI is temporarily unavailable.');
  err.descriptor = d;
  return err;
}

function headerValue(headers, name) {
  const v = headers && typeof headers.get === 'function' ? headers.get(name) : null;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// retry-after-ms, else Retry-After in seconds or as an HTTP date, else 20;
// never above 60 and never below 1.
function retryAfterSeconds(headers) {
  const ms = headerValue(headers, 'retry-after-ms');
  const raw = headerValue(headers, 'retry-after');
  let sec = null;
  if (ms !== null && Number(ms) >= 0) sec = Number(ms) / 1000;
  else if (raw !== null && Number(raw) >= 0) sec = Number(raw);
  else if (raw !== null && Number.isFinite(Date.parse(raw))) sec = Math.max(0, (Date.parse(raw) - Date.now()) / 1000);
  if (sec === null || !Number.isFinite(sec)) return RETRY_AFTER_DEFAULT_SEC;
  return Math.min(RETRY_AFTER_MAX_SEC, Math.max(1, Math.ceil(sec)));
}

function readableReason(text) {
  if (typeof text !== 'string' || text.trim() === '') return DEFAULT_REFUSAL_REASON;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > REASON_MAX_CHARS ? `${oneLine.slice(0, REASON_MAX_CHARS - 3)}...` : oneLine;
}

// A thrown SDK error becomes OpenAIRateLimited (a 429 that is a rate limit,
// not an exhausted balance), OpenAIRefusal (a moderation block: on an image
// call the reason is the API's own message, on the words call the fixed
// WORDS_REFUSAL_REASON) or ExternalServiceError('openai').
function mapError(err, { words = false } = {}) {
  if (err instanceof OpenAIRefusal || err instanceof OpenAIRateLimited || err instanceof AppError) return err;
  const d = describeError(err);
  if (d.status === 429 && d.code !== 'insufficient_quota') return new OpenAIRateLimited(retryAfterSeconds(err.headers), d);
  if (d.code && REFUSAL_CODES.has(d.code)) {
    if (words) return new OpenAIRefusal(WORDS_REFUSAL_REASON, d);
    const body = err && err.error && typeof err.error === 'object' ? err.error : {};
    return new OpenAIRefusal(readableReason(body.message), d);
  }
  return externalError(d);
}

async function call(fn, mapOptions) {
  let result;
  try {
    result = await fn();
  } catch (err) {
    throw mapError(err, mapOptions);
  }
  const requestId = result && typeof result._request_id === 'string' && result._request_id ? result._request_id : null;
  return { result, requestId };
}

// The words come back as output_text; a refusal arrives as a refusal item,
// and a stopped response as status failed or incomplete. Every refusal here
// reads WORDS_REFUSAL_REASON; the refusal item's text and the error message
// are never read into the reason, the descriptor or the error.
function readMenuCopy(response, requestId) {
  const status = response && response.status;
  if (status === 'failed') {
    const e = response.error && typeof response.error === 'object' ? response.error : {};
    const d = descriptor('ResponseFailed', { requestId, code: e.code });
    throw d.code && REFUSAL_CODES.has(d.code) ? new OpenAIRefusal(WORDS_REFUSAL_REASON, d) : externalError(d);
  }
  if (status === 'incomplete') {
    const reason = response.incomplete_details && response.incomplete_details.reason;
    const d = descriptor('ResponseIncomplete', { requestId, code: reason });
    throw reason === 'content_filter' ? new OpenAIRefusal(WORDS_REFUSAL_REASON, d) : externalError(d);
  }
  if (status && status !== 'completed') throw externalError(descriptor('ResponseNotCompleted', { requestId, code: status }));
  let text = '';
  for (const item of Array.isArray(response && response.output) ? response.output : []) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && part.type === 'refusal') {
        throw new OpenAIRefusal(WORDS_REFUSAL_REASON, descriptor('ModelRefusal', { requestId, code: 'refusal' }));
      }
      if (part && part.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
  }
  if (text.trim() === '') throw externalError(descriptor('EmptyOutput', { requestId, code: 'no_output' }));
  try {
    return JSON.parse(text);
  } catch {
    throw externalError(descriptor('OutputParseError', { requestId, code: 'invalid_json' }));
  }
}

/**
 * One structured-output call on the Responses API, store false. schema is a
 * strict JSON schema object (additionalProperties false, every property
 * required). Resolves to { json, requestId }; the caller still validates json.
 */
async function draftMenuCopy({ system, user, schema, model }) {
  const client = getClient();
  const { result, requestId } = await call(() => client.responses.create({
    model,
    instructions: system,
    input: user,
    store: false,
    text: { format: { type: 'json_schema', name: 'menu_copy', schema, strict: true } },
  }, callOptions(TEXT_TIMEOUT_MS)), { words: true });
  return { json: readMenuCopy(result, requestId), requestId };
}

function imageResult({ result, requestId }) {
  const first = result && Array.isArray(result.data) ? result.data[0] : null;
  const buffer = Buffer.from(first && typeof first.b64_json === 'string' ? first.b64_json : '', 'base64');
  if (buffer.length === 0) throw externalError(descriptor('EmptyImage', { requestId, code: 'no_image' }));
  return { buffer, requestId };
}

// null and undefined fields are left out: the multipart encoder throws on null.
function imageBody(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
}

/** A new image from a prompt; size like '2560x3200'. Resolves to { buffer, requestId }. */
async function generateImage({ prompt, size, quality, outputFormat, background, model }) {
  const client = getClient();
  return imageResult(await call(() => client.images.generate(
    imageBody({ model, prompt, n: 1, size, quality, output_format: outputFormat, background }),
    callOptions(imageTimeoutMs()),
  )));
}

/**
 * An image from a prompt plus input images (style references, the
 * background): images [{ buffer, filename, contentType }], at least one.
 * Resolves to { buffer, requestId }.
 */
async function editImage({ prompt, images, size, quality, outputFormat, background, model }) {
  if (!Array.isArray(images) || images.length === 0) throw new TypeError('openaiClient.editImage needs at least one image');
  const client = getClient();
  return imageResult(await call(async () => {
    const files = await Promise.all(images.map((img, i) => toFile(
      img.buffer, img.filename || `reference-${i + 1}.png`, img.contentType ? { type: img.contentType } : undefined,
    )));
    return client.images.edit(
      imageBody({ model, prompt, image: files.length === 1 ? files[0] : files, n: 1, size, quality, output_format: outputFormat, background }),
      callOptions(imageTimeoutMs()),
    );
  }));
}

function _getClientForTest() { return getClient(); }

function _resetForTest() {
  testStub = null;
  realClient = null;
  realClientKey = null;
}

module.exports = {
  OPENAI_API_BASE_URL, TEXT_TIMEOUT_MS, IMAGE_TIMEOUT_DEFAULT_MS, SDK_ERROR_CLASSES, WORDS_REFUSAL_REASON,
  OpenAIRefusal, OpenAIRateLimited,
  isConfigured, clientOptions, draftMenuCopy, generateImage, editImage, describeError, formatError,
  __setTestStub, _getClientForTest, _resetForTest,
};
