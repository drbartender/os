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

// ── The menu words helper (spec 2026-10-19 section 16, lane menu-words-claude) ──
// draftMenuCopy is the words step's call on Claude. Every case runs on a stub
// set with __setTestStub; the SDK's own error classes are built, never thrown
// by a request.
const ac = require('./anthropicClient');
const { AppError, ExternalServiceError } = require('./errors');

const SECRET = 'SECRET-menu-words-7f3a';
const WORDS = {
  system: 'You write the words for a printed bar menu.',
  user: JSON.stringify({ event_type: 'Wedding', drinks: [{ key: 'custom:fizz', name: 'Fizz' }] }),
  schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } } },
  model: 'claude-haiku-5-5',
};
const answer = (blocks, over = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: blocks, _request_id: 'req_words_test', ...over,
});
const textBlock = (text) => ({ type: 'text', text });
function wordsStub(reply) {
  const sent = [];
  ac.__setTestStub({
    messages: {
      create: async (body, options) => {
        sent.push({ body, options });
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply(body) : reply;
      },
    },
  });
  return sent;
}
// An SDK error as the SDK builds it from an HTTP answer (APIError.generate).
const hdrs = (pairs) => ({ get: (name) => (Object.prototype.hasOwnProperty.call(pairs, name) ? pairs[name] : null) });
function apiError(status, type, message, { details, retryAfter } = {}) {
  const error = { type, message };
  if (details) error.details = details;
  const h = { 'request-id': `req_test_${status}` };
  if (retryAfter !== undefined) h['retry-after'] = String(retryAfter);
  return Anthropic.APIError.generate(status, { type: 'error', error, request_id: `req_test_${status}` }, undefined, hdrs(h));
}

test('draftMenuCopy refuses under NODE_ENV=test without a stub, and sends nothing', async () => {
  process.env.NODE_ENV = 'test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  await assert.rejects(ac.draftMenuCopy(WORDS), /NODE_ENV=test/);
});

test('draftMenuCopy sends the schema as structured output with the words timeout and no SDK retries', async () => {
  const sent = wordsStub(answer([{ type: 'thinking', thinking: '' }, textBlock('{"title":'), textBlock('"Bar Menu"}')]));
  const out = await ac.draftMenuCopy(WORDS);
  assert.deepEqual(out, { json: { title: 'Bar Menu' }, requestId: 'req_words_test' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {
    model: 'claude-haiku-5-5',
    max_tokens: 16000,
    system: WORDS.system,
    messages: [{ role: 'user', content: WORDS.user }],
    output_config: { format: { type: 'json_schema', schema: WORDS.schema } },
  });
  assert.deepEqual(sent[0].options, { timeout: 60000, maxRetries: 0 });
  assert.equal(ac.WORDS_TIMEOUT_MS, 60000);
});

test('draftMenuCopy with no key outside test mode is not set up (503 MENU_ART_NOT_CONFIGURED)', async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(ac.draftMenuCopy(WORDS), (err) => {
    assert.ok(err instanceof AppError);
    assert.deepEqual([err.statusCode, err.code], [503, 'MENU_ART_NOT_CONFIGURED']);
    return true;
  });
});

test('a spent balance and a spend limit are told apart, never retried as a rate limit, and keep no message', async () => {
  const cases = [
    // The 402 billing_error (Claude API errors page).
    [apiError(402, 'billing_error', `Billing problem. ${SECRET}`), 'balance', 'billing_error'],
    // The exhausted balance's documented message (API credits page).
    [apiError(400, 'invalid_request_error', `Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits. ${SECRET}`), 'balance', 'invalid_request_error'],
    // A spend limit the owner set: a 400 whose message starts so (Rate limits page).
    [apiError(400, 'invalid_request_error', `You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC. ${SECRET}`), 'limit', 'invalid_request_error'],
    [apiError(400, 'invalid_request_error', `You have reached your specified workspace API usage limits. ${SECRET}`), 'limit', 'invalid_request_error'],
    // The tier's monthly spend cap: a 429 with details.error_code and no retry-after.
    [apiError(429, 'rate_limit_error', `You have reached your API usage limits. ${SECRET}`, { details: { error_code: 'enforced_spend_limit_reached' } }), 'limit', 'enforced_spend_limit_reached'],
  ];
  for (const [sdkErr, kind, code] of cases) {
    wordsStub(sdkErr);
    await assert.rejects(ac.draftMenuCopy(WORDS), (err) => {
      assert.ok(err instanceof ac.AnthropicOutOfCredit, `${code}: ${err && err.name}`);
      assert.equal(err.kind, kind, code);
      assert.equal(err.retryAfterSec, undefined, 'nothing to wait for');
      assert.deepEqual(err.descriptor, { provider: 'anthropic', errorClass: sdkErr.constructor.name, status: sdkErr.status, requestId: sdkErr.requestID, code });
      assert.ok(!`${err.message} ${JSON.stringify(err.descriptor)}`.includes(SECRET), 'never the API message');
      return true;
    });
  }
});

test('a rate limit, a ramp limit and an overload are AnthropicRateLimited with the retry-after seconds', async () => {
  const cases = [
    [apiError(429, 'rate_limit_error', `Too many requests. ${SECRET}`, { retryAfter: 7 }), 7, 'rate_limit_error'],
    [apiError(429, 'rate_limit_error', `Ramp. ${SECRET}`, { retryAfter: 3, details: { error_code: 'ramp_limit_exceeded' } }), 3, 'ramp_limit_exceeded'],
    [apiError(529, 'overloaded_error', `Overloaded. ${SECRET}`), null, 'overloaded_error'],
  ];
  for (const [sdkErr, seconds, code] of cases) {
    wordsStub(sdkErr);
    await assert.rejects(ac.draftMenuCopy(WORDS), (err) => {
      assert.ok(err instanceof ac.AnthropicRateLimited, `${code}: ${err && err.name}`);
      assert.equal(err.retryAfterSec, seconds, code);
      assert.equal(err.descriptor.provider, 'anthropic');
      assert.equal(err.descriptor.code, code);
      assert.ok(!`${err.message} ${JSON.stringify(err.descriptor)}`.includes(SECRET));
      return true;
    });
  }
});

test('any other failure is ExternalServiceError(anthropic) carrying the descriptor only', async () => {
  const cases = [
    [apiError(400, 'invalid_request_error', `messages.0: ${SECRET}`), 'BadRequestError', 400, 'invalid_request_error'],
    [apiError(401, 'authentication_error', `invalid x-api-key ${SECRET}`), 'AuthenticationError', 401, 'authentication_error'],
    [apiError(500, 'api_error', `boom ${SECRET}`), 'InternalServerError', 500, 'api_error'],
    [new Anthropic.APIConnectionTimeoutError(), 'APIConnectionTimeoutError', null, null],
  ];
  for (const [sdkErr, errorClass, status, code] of cases) {
    wordsStub(sdkErr);
    await assert.rejects(ac.draftMenuCopy(WORDS), (err) => {
      assert.ok(err instanceof ExternalServiceError, errorClass);
      assert.equal(err.service, 'anthropic');
      assert.deepEqual([err.descriptor.provider, err.descriptor.errorClass, err.descriptor.status, err.descriptor.code],
        ['anthropic', errorClass, status, code]);
      assert.ok(!`${err.message} ${err.originalError.message} ${JSON.stringify(err.descriptor)}`.includes(SECRET));
      return true;
    });
  }
});

test('a refusal is AnthropicRefusal with its fixed Brief-tab reason, never the model text', async () => {
  wordsStub(answer([textBlock(`I won't. ${SECRET}`)], { stop_reason: 'refusal' }));
  await assert.rejects(ac.draftMenuCopy(WORDS), (err) => {
    assert.ok(err instanceof ac.AnthropicRefusal, err && err.name);
    assert.equal(err.reason, 'Anthropic declined to write this menu. Try a different brief.');
    assert.deepEqual([err.descriptor.provider, err.descriptor.errorClass, err.descriptor.code, err.descriptor.requestId],
      ['anthropic', 'ModelRefusal', 'refusal', 'req_words_test']);
    assert.ok(!`${err.message} ${err.reason} ${JSON.stringify(err.descriptor)}`.includes(SECRET));
    return true;
  });
});

test('a cut-off answer, an empty answer and broken JSON fail with fixed codes, never the model text', async () => {
  const cases = [
    [answer([textBlock(`{"title":"${SECRET}`)], { stop_reason: 'max_tokens' }), 'max_tokens'],
    [answer([]), 'no_output'],
    [answer([textBlock(`not json ${SECRET}`)]), 'invalid_json'],
  ];
  for (const [reply, code] of cases) {
    wordsStub(reply);
    await assert.rejects(ac.draftMenuCopy(WORDS), (err) => {
      assert.ok(err instanceof ExternalServiceError, code);
      assert.equal(err.service, 'anthropic');
      assert.deepEqual([err.descriptor.code, err.descriptor.requestId], [code, 'req_words_test']);
      assert.ok(!`${err.message} ${err.originalError.message} ${JSON.stringify(err.descriptor)}`.includes(SECRET));
      return true;
    });
  }
});

test('__setTestStub refuses under NODE_ENV=production', () => {
  process.env.NODE_ENV = 'production';
  assert.throws(() => ac.__setTestStub({}), /test-only/);
});
