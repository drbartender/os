// The ONLY module that requires @anthropic-ai/sdk (the stripeClient.js
// precedent). Every Anthropic call in the server goes through the client this
// file builds, so the options below hold everywhere, and the SDK's zod output
// helper is re-exported from here so no other file requires the SDK.
//
// Under NODE_ENV=test it refuses to build a real client unless a test injects
// a stub, so a missed mock can never send a message to Anthropic.
//
// TREAT null AS A REAL RETURN VALUE: with ANTHROPIC_API_KEY unset (the dev box,
// and any environment where the AI read is off) createAnthropicClient returns
// null and the caller does nothing.
//
// The menu words (spec 2026-10-19 section 16, lane menu-words-claude):
// draftMenuCopy is the menu art words step's call when its stamped model id
// starts with claude-. One messages.create with structured output
// (output_config.format, the words schema), the words step's own 60 s timeout
// and maxRetries 0, so the menu art job owns every retry, as it does on
// OpenAI. Under NODE_ENV=test it refuses unless a test set a stub with
// __setTestStub; with no key it is 503 MENU_ART_NOT_CONFIGURED. Its failures
// carry the sanitized descriptor (provider anthropic, class, status, request
// id, the API's error type or details code), never the API message, which can
// quote the request: a spent balance (a 402 billing_error, or the documented
// "Your credit balance is too low" answer) is AnthropicOutOfCredit kind
// balance; a spend limit (the 400 "You have reached your specified ... API
// usage limits", or the tier cap's 429 enforced_spend_limit_reached) is kind
// limit; neither is ever retried. Any other 429, and a 529 overloaded, is
// AnthropicRateLimited with the retry-after seconds; a refusal is
// AnthropicRefusal carrying WORDS_REFUSAL_REASON, a fixed sentence that sends
// the owner to the Brief tab and is never reported, as OpenAI's words refusal
// is; a cut-off answer, an empty answer or broken JSON is
// ExternalServiceError('anthropic') with a fixed code. The message is read
// only to tell those cases apart.

const { Anthropic } = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { AppError, ExternalServiceError } = require('./errors');

const AI_TIMEOUT_MS = 30000;
const AI_MAX_RETRIES = 2;
// Pinned, not read from ANTHROPIC_BASE_URL: message text leaves the OS only
// for Anthropic's own API, and an env var must not be able to redirect it.
const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

function isConfigured() {
  return String(process.env.ANTHROPIC_API_KEY || '').trim() !== '';
}

// authToken null: the SDK would otherwise also read ANTHROPIC_AUTH_TOKEN, and
// sending both credentials is a 401. logLevel 'warn': ANTHROPIC_LOG=debug
// would print request bodies (client message text) into the Render log.
function clientOptions(apiKey) {
  return {
    apiKey,
    authToken: null,
    baseURL: ANTHROPIC_API_BASE_URL,
    timeout: AI_TIMEOUT_MS,
    maxRetries: AI_MAX_RETRIES,
    logLevel: 'warn',
  };
}

let realClient = null;
let realClientKey = null;
let testStub = null;

function createAnthropicClient({ stub } = {}) {
  if (stub) return stub;
  if (process.env.NODE_ENV === 'test') {
    throw new Error('anthropicClient: refusing to build a real Anthropic client under NODE_ENV=test; inject a stub');
  }
  if (!isConfigured()) return null;
  const key = String(process.env.ANTHROPIC_API_KEY).trim();
  if (!realClient || realClientKey !== key) {
    realClient = new Anthropic(clientOptions(key));
    realClientKey = key;
  }
  return realClient;
}

// Most specific first (shared/error-codes.md in the claude-api skill): in the
// TypeScript SDK APIConnectionError and APIUserAbortError are subclasses of
// APIError, and APIConnectionTimeoutError of APIConnectionError.
const SDK_ERROR_CLASSES = [
  ['APIConnectionTimeoutError', Anthropic.APIConnectionTimeoutError],
  ['APIConnectionError', Anthropic.APIConnectionError],
  ['APIUserAbortError', Anthropic.APIUserAbortError],
  ['BadRequestError', Anthropic.BadRequestError],
  ['AuthenticationError', Anthropic.AuthenticationError],
  ['PermissionDeniedError', Anthropic.PermissionDeniedError],
  ['NotFoundError', Anthropic.NotFoundError],
  ['ConflictError', Anthropic.ConflictError],
  ['UnprocessableEntityError', Anthropic.UnprocessableEntityError],
  ['RateLimitError', Anthropic.RateLimitError],
  ['InternalServerError', Anthropic.InternalServerError],
  ['APIError', Anthropic.APIError],
  ['AnthropicError', Anthropic.AnthropicError],
];

/**
 * What an Anthropic failure may say about itself: the error class, the HTTP
 * status and the request id. Never the message: an APIError message carries
 * the API's error body, and a structured-output parse failure can quote the
 * model's output. Sentry events and inbox_reads.error carry only this.
 */
function describeAiError(err) {
  let errorClass = 'UnknownError';
  for (const [name, cls] of SDK_ERROR_CLASSES) {
    if (typeof cls === 'function' && err instanceof cls) { errorClass = name; break; }
  }
  if (errorClass === 'UnknownError') {
    if (err instanceof TypeError) errorClass = 'TypeError';
    else if (err instanceof RangeError) errorClass = 'RangeError';
  }
  const status = err && Number.isInteger(err.status) ? err.status : null;
  const requestId = err && typeof err.requestID === 'string' && err.requestID ? err.requestID : null;
  return { errorClass, status, requestId };
}

function formatAiError({ errorClass, status, requestId }) {
  return [errorClass, status, requestId].filter((v) => v !== null && v !== undefined && v !== '').join(' ');
}

// ── The menu words call ───────────────────────────────────────────────────────

const WORDS_TIMEOUT_MS = 60000;
const WORDS_MAX_TOKENS = 16000;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
// The answers that mean the account cannot pay, as Anthropic's docs write
// them: the exhausted balance (API credits page) and a spend limit the owner
// set (Rate limits page, "Setting your own spend limit").
const BALANCE_MESSAGE = 'Your credit balance is too low';
const LIMIT_MESSAGES = ['You have reached your specified API usage limits', 'You have reached your specified workspace API usage limits'];
const SPEND_CAP_CODE = 'enforced_spend_limit_reached';
// The stored sentence for a refused menu: a new brief can cure it (spec
// 2026-10-19 section 28).
const WORDS_REFUSAL_REASON = 'Anthropic declined to write this menu. Try a different brief.';

// The account cannot pay for the call: waiting cannot help, so it carries no
// retryAfterSec and the job never retries it. kind is 'balance' (add credit)
// or 'limit' (raise a spend limit).
class AnthropicOutOfCredit extends Error {
  constructor(descriptor, kind = 'balance') {
    super('Anthropic is out of credit.');
    Object.assign(this, { name: 'AnthropicOutOfCredit', kind: kind === 'limit' ? 'limit' : 'balance', descriptor });
  }
}

// The model declined to write the menu; reason is the fixed sentence above.
class AnthropicRefusal extends Error {
  constructor(reason, descriptor) {
    super('Anthropic refused the request.');
    Object.assign(this, { name: 'AnthropicRefusal', reason, descriptor });
  }
}

class AnthropicRateLimited extends Error {
  constructor(retryAfterSec, descriptor) {
    super('Anthropic rate limit reached.');
    Object.assign(this, { name: 'AnthropicRateLimited', retryAfterSec, descriptor });
  }
}

function menuDescriptor(errorClass, { status = null, requestId = null, code = null } = {}) {
  return { provider: 'anthropic', errorClass, status, requestId, code: typeof code === 'string' && SAFE_CODE.test(code) ? code : null };
}

// The API's own error object inside an SDK error (APIError.error is the body).
function apiErrorBody(err) {
  const body = err && err.error && typeof err.error === 'object' ? err.error : null;
  return body && body.error && typeof body.error === 'object' ? body.error : {};
}

/** The sanitized descriptor of a menu words failure; errors thrown here carry it. */
function describeMenuError(err) {
  if (err && err.descriptor && err.descriptor.provider === 'anthropic') return err.descriptor;
  const { errorClass, status, requestId } = describeAiError(err);
  const inner = apiErrorBody(err);
  const details = inner.details && typeof inner.details === 'object' ? inner.details : {};
  const type = err && typeof err.type === 'string' ? err.type : inner.type;
  return menuDescriptor(errorClass, { status, requestId, code: typeof details.error_code === 'string' ? details.error_code : type });
}

function externalError(d) {
  const original = Object.assign(new Error(formatAiError(d)), { name: d.errorClass });
  const err = new ExternalServiceError('anthropic', original, 'Anthropic is temporarily unavailable.');
  err.descriptor = d;
  return err;
}

function retryAfterSeconds(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function mapMenuError(err) {
  if (err instanceof AnthropicOutOfCredit || err instanceof AnthropicRateLimited || err instanceof AnthropicRefusal
    || err instanceof AppError) return err;
  const d = describeMenuError(err);
  if (!(err instanceof Anthropic.APIError) || !Number.isInteger(err.status)) return externalError(d);
  const inner = apiErrorBody(err);
  const message = typeof inner.message === 'string' ? inner.message : '';
  if (err.type === 'billing_error' || message.startsWith(BALANCE_MESSAGE)) return new AnthropicOutOfCredit(d, 'balance');
  if (d.code === SPEND_CAP_CODE || LIMIT_MESSAGES.some((m) => message.startsWith(m))) return new AnthropicOutOfCredit(d, 'limit');
  if (err.status === 429 || err.status === 529 || err.type === 'overloaded_error') {
    return new AnthropicRateLimited(retryAfterSeconds(err.headers), d);
  }
  return externalError(d);
}

// The words arrive as text blocks (thinking blocks are skipped); anything but
// a finished turn, an empty answer or text that is not JSON is a provider
// error with a fixed code, and none of the text is ever kept.
function readMenuCopy(message, requestId) {
  const stop = message && message.stop_reason;
  if (stop === 'refusal') {
    throw new AnthropicRefusal(WORDS_REFUSAL_REASON, menuDescriptor('ModelRefusal', { requestId, code: 'refusal' }));
  }
  if (stop !== 'end_turn') {
    throw externalError(menuDescriptor('ResponseIncomplete', { requestId, code: stop }));
  }
  const text = (Array.isArray(message.content) ? message.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  if (text.trim() === '') throw externalError(menuDescriptor('EmptyOutput', { requestId, code: 'no_output' }));
  try {
    return JSON.parse(text);
  } catch {
    throw externalError(menuDescriptor('OutputParseError', { requestId, code: 'invalid_json' }));
  }
}

/**
 * The menu words on Claude: one structured-output messages.create. schema is
 * the strict words schema (menuArtPrompts.wordsRequest). Resolves to
 * { json, requestId }; the caller still validates json (parseWords).
 */
async function draftMenuCopy({ system, user, schema, model }) {
  const client = createAnthropicClient(testStub ? { stub: testStub } : {});
  if (!client) throw new AppError('Menu art is not set up.', 503, 'MENU_ART_NOT_CONFIGURED');
  let message;
  try {
    message = await client.messages.create({
      model,
      max_tokens: WORDS_MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    }, { timeout: WORDS_TIMEOUT_MS, maxRetries: 0 });
  } catch (err) {
    throw mapMenuError(err);
  }
  const requestId = message && typeof message._request_id === 'string' && message._request_id ? message._request_id : null;
  return { json: readMenuCopy(message, requestId), requestId };
}

function __setTestStub(stub) {
  if (process.env.NODE_ENV === 'production') throw new Error('anthropicClient: __setTestStub is test-only');
  testStub = stub || null;
}

function _resetClientForTest() {
  realClient = null;
  realClientKey = null;
  testStub = null;
}

module.exports = {
  AI_TIMEOUT_MS,
  AI_MAX_RETRIES,
  ANTHROPIC_API_BASE_URL,
  SDK_ERROR_CLASSES,
  isConfigured,
  clientOptions,
  createAnthropicClient,
  describeAiError,
  formatAiError,
  zodOutputFormat,
  WORDS_TIMEOUT_MS,
  AnthropicOutOfCredit,
  AnthropicRateLimited,
  AnthropicRefusal,
  WORDS_REFUSAL_REASON,
  describeMenuError,
  draftMenuCopy,
  __setTestStub,
  _resetClientForTest,
};
