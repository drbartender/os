// Pure suite (no DB). Anthropic is never called from a test: the one real
// client built below is constructed only, and no method on it is ever invoked.
process.env.NODE_ENV = 'test';
require('dotenv').config();

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Anthropic } = require('@anthropic-ai/sdk');
const {
  SDK_ERROR_CLASSES,
  isConfigured,
  clientOptions,
  createAnthropicClient,
  describeAiError,
  formatAiError,
  zodOutputFormat,
  _resetClientForTest,
} = require('./anthropicClient');

let savedNodeEnv;
let savedKey;
beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  savedKey = process.env.ANTHROPIC_API_KEY;
  _resetClientForTest();
});
afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  _resetClientForTest();
});

// The SDK reads the request id off a Headers-like object; the server ESLint
// globals do not list Headers, so a plain { get } stands in.
const headers = (requestId) => ({ get: (name) => (name === 'request-id' ? requestId : null) });

test('createAnthropicClient refuses a real client under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  assert.throws(() => createAnthropicClient(), /NODE_ENV=test/);
  assert.throws(() => createAnthropicClient({}), /NODE_ENV=test/);
});

test('createAnthropicClient hands back an injected stub untouched, even under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  const stub = { beta: { messages: { parse: () => Promise.resolve({}) } } };
  assert.equal(createAnthropicClient({ stub }), stub);
});

test('createAnthropicClient returns null with no key; blank counts as no key', () => {
  process.env.NODE_ENV = 'development';
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(isConfigured(), false);
  assert.equal(createAnthropicClient(), null);
  process.env.ANTHROPIC_API_KEY = '   ';
  assert.equal(isConfigured(), false);
  assert.equal(createAnthropicClient(), null);
});

test('clientOptions pins the timeout, retries, host, credential and log level', () => {
  assert.deepEqual(clientOptions('sk-ant-test-not-real'), {
    apiKey: 'sk-ant-test-not-real',
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    timeout: 30000,
    maxRetries: 2,
    logLevel: 'warn',
  });
});

test('outside test mode the SDK accepts those options; one client per key (constructed, never called)', () => {
  process.env.NODE_ENV = 'development';
  process.env.ANTHROPIC_API_KEY = ' sk-ant-test-not-real ';
  assert.equal(isConfigured(), true);
  const a = createAnthropicClient();
  assert.ok(a instanceof Anthropic);
  assert.equal(a.apiKey, 'sk-ant-test-not-real');
  assert.equal(a.authToken, null);
  assert.equal(a.baseURL, 'https://api.anthropic.com');
  assert.equal(a.timeout, 30000);
  assert.equal(a.maxRetries, 2);
  assert.equal(typeof a.beta.messages.parse, 'function');
  assert.equal(createAnthropicClient(), a);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-rotated';
  assert.notEqual(createAnthropicClient(), a);
});

test('every SDK error class the describer checks exists in this SDK version, and the zod helper loads', () => {
  for (const [name, cls] of SDK_ERROR_CLASSES) {
    assert.equal(typeof cls, 'function', `Anthropic.${name} is missing`);
  }
  assert.equal(typeof zodOutputFormat, 'function');
});

test('describeAiError names the typed SDK class, the status and the request id', () => {
  const body = (type) => ({ type: 'error', error: { type, message: 'probe' } });
  const cases = [
    [new Anthropic.RateLimitError(429, body('rate_limit_error'), undefined, headers('req_test_429')), 'RateLimitError', 429, 'req_test_429'],
    [new Anthropic.InternalServerError(529, body('overloaded_error'), undefined, headers('req_test_529')), 'InternalServerError', 529, 'req_test_529'],
    [new Anthropic.BadRequestError(400, body('invalid_request_error'), undefined, headers('req_test_400')), 'BadRequestError', 400, 'req_test_400'],
    [new Anthropic.AuthenticationError(401, body('authentication_error'), undefined, headers(null)), 'AuthenticationError', 401, null],
    [new Anthropic.APIConnectionTimeoutError(), 'APIConnectionTimeoutError', null, null],
    [new Anthropic.APIConnectionError({ message: 'fetch failed' }), 'APIConnectionError', null, null],
    [new Anthropic.AnthropicError('Failed to parse structured output: x'), 'AnthropicError', null, null],
    [new TypeError('x is undefined'), 'TypeError', null, null],
    [{ weird: true }, 'UnknownError', null, null],
  ];
  for (const [err, errorClass, status, requestId] of cases) {
    assert.deepEqual(describeAiError(err), { errorClass, status, requestId });
  }
});

test('formatAiError carries the class, status and request id, never the message', () => {
  const leaky = new Anthropic.BadRequestError(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0: Can you do Oct 20 for the Testerton wedding?' } },
    undefined,
    headers('req_test_leak'),
  );
  assert.match(leaky.message, /Testerton/);
  const line = formatAiError(describeAiError(leaky));
  assert.equal(line, 'BadRequestError 400 req_test_leak');
  assert.doesNotMatch(line, /Testerton|Oct 20/);
  assert.equal(formatAiError(describeAiError(new Anthropic.APIConnectionError({ message: 'secret' }))), 'APIConnectionError');
});
