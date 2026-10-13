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

const { Anthropic } = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

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

function _resetClientForTest() {
  realClient = null;
  realClientKey = null;
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
  _resetClientForTest,
};
