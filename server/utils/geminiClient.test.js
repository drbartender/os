process.env.NODE_ENV = 'test';
// Pure suite: no DB and no network. Gemini is never called. The real SDK is
// exercised only through a fake fetch passed in httpOptions, and global fetch
// is replaced by a tripwire for the whole file (the SDK's default fetcher
// calls global fetch), so a request that escaped the fake would fail the test
// instead of reaching Google.

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Count real client constructions: the wrapper reads GoogleGenAI from this
// module's exports when it loads, so the counting subclass must be in place
// before ./geminiClient is required.
const sdkPath = require.resolve('@google/genai');
const realSdk = require('@google/genai');
const RealGoogleGenAI = realSdk.GoogleGenAI;
let constructed = 0;
class CountingGoogleGenAI extends RealGoogleGenAI {
  constructor(opts) {
    super(opts);
    constructed += 1;
  }
}
require.cache[sdkPath].exports = { ...realSdk, GoogleGenAI: CountingGoogleGenAI };

const {
  GEMINI_API_BASE_URL,
  GeminiRefusal,
  GeminiRateLimited,
  isConfigured,
  clientOptions,
  generateImage,
  describeError,
  formatError,
  __setTestStub,
  _getClientForTest,
  _resetForTest,
} = require('./geminiClient');
const { ExternalServiceError } = require('./errors');

const ENV_KEYS = [
  'NODE_ENV', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_DEBUG', 'GOOGLE_GENAI_USER_PROJECT', 'MENU_ART_IMAGE_TIMEOUT_MS',
];
let savedEnv;
let realGlobalFetch;
let tripwireHits;

before(() => {
  realGlobalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    tripwireHits += 1;
    throw new Error(`network tripwire: ${String(args[0] && args[0].url ? args[0].url : args[0])}`);
  };
});
after(() => {
  globalThis.fetch = realGlobalFetch;
});
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.NODE_ENV = 'test';
  delete process.env.MENU_ART_IMAGE_TIMEOUT_MS;
  delete process.env.GOOGLE_GENAI_DEBUG;
  delete process.env.GOOGLE_GENAI_USER_PROJECT;
  tripwireHits = 0;
  constructed = 0;
  _resetForTest();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetForTest();
  assert.equal(tripwireHits, 0, 'a request reached global fetch');
});

const JPEG_BYTES = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const BASE_ARGS = Object.freeze({
  prompt: 'a cocktail on flat magenta',
  images: [],
  aspectRatio: '1:1',
  imageSize: '1K',
  model: 'gemini-3-pro-image',
});

function completed(content, extra = {}) {
  return {
    id: 'int_ok_1',
    status: 'completed',
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'prompt' }] },
      { type: 'thought', content: [] },
      { type: 'model_output', content },
    ],
    usage: { total_tokens: 1290, total_output_tokens: 1120 },
    ...extra,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new globalThis.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// A fake fetch that records every request and answers from a queue. The SDK
// calls it with a Request object.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (req) => {
    calls.push({ url: req.url, headers: req.headers, body: await req.clone().text(), signal: req.signal });
    const next = answers.shift();
    if (!next) throw new Error('fake fetch: no answer queued');
    return typeof next === 'function' ? next(req) : next;
  };
  fn.calls = calls;
  return fn;
}

function sdkClientWith(fetchFn, key = 'gem-test-not-real') {
  const opts = clientOptions(key);
  return new RealGoogleGenAI({ ...opts, httpOptions: { ...opts.httpOptions, fetch: fetchFn } });
}

function stubReturning(interaction, seen = []) {
  return {
    interactions: {
      create: async (params, options) => {
        seen.push({ params, options });
        return typeof interaction === 'function' ? interaction() : interaction;
      },
    },
  };
}

// ---- configuration and refusal under test ----

test('isConfigured follows GEMINI_API_KEY only; blank counts as unset', () => {
  delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_API_KEY = 'google-key-not-ours';
  assert.equal(isConfigured(), false);
  process.env.GEMINI_API_KEY = '  ';
  assert.equal(isConfigured(), false);
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  assert.equal(isConfigured(), true);
});

test('under NODE_ENV=test with no stub every call rejects and nothing is constructed', async () => {
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  await assert.rejects(generateImage({ ...BASE_ARGS }), /Gemini disabled under test/);
  await assert.rejects(generateImage({ ...BASE_ARGS, images: [{ buffer: PNG_BYTES, mimeType: 'image/png' }] }), /Gemini disabled under test/);
  assert.throws(() => _getClientForTest(), /Gemini disabled under test/);
  assert.equal(constructed, 0);
});

test('the client options pin the explicit key, the Gemini API host and the Gemini backend', () => {
  assert.deepEqual(clientOptions('gem-test-not-real'), {
    apiKey: 'gem-test-not-real',
    vertexai: false,
    httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com/' },
  });
  assert.equal(GEMINI_API_BASE_URL, 'https://generativelanguage.googleapis.com/');
});

test('outside test mode the real client takes GEMINI_API_KEY, never GOOGLE_API_KEY, and env cannot move the host (constructed, never called)', () => {
  process.env.NODE_ENV = 'development';
  process.env.GEMINI_API_KEY = ' gem-test-not-real ';
  process.env.GOOGLE_API_KEY = 'google-key-not-ours';
  process.env.GOOGLE_GEMINI_BASE_URL = 'https://evil.example.com/';
  process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
  const a = _getClientForTest();
  assert.ok(a instanceof RealGoogleGenAI);
  assert.equal(constructed, 1);
  assert.equal(a.apiKey, 'gem-test-not-real');
  assert.equal(a.vertexai, false);
  assert.equal(a.apiClient.getBaseUrl(), 'https://generativelanguage.googleapis.com/');
  assert.equal(a.apiClient.getApiKey(), 'gem-test-not-real');
  assert.equal(typeof a.interactions.create, 'function');
  assert.equal(_getClientForTest(), a);
  assert.equal(constructed, 1);
  process.env.GEMINI_API_KEY = 'gem-test-rotated';
  assert.notEqual(_getClientForTest(), a);
  assert.equal(constructed, 2);
});

test('outside test mode with no key a call throws the 503 Gemini-not-set-up error and builds nothing', async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_API_KEY = 'google-key-not-ours';
  await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, 'MENU_ART_GEMINI_NOT_CONFIGURED');
    return true;
  });
  assert.equal(constructed, 0);
});

test('outside test mode GOOGLE_GENAI_DEBUG (which would log the key and images) refuses the call and builds nothing, a lone space included', async () => {
  process.env.NODE_ENV = 'development';
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  for (const value of ['false', ' ', '\t', '0']) {
    process.env.GOOGLE_GENAI_DEBUG = value;
    await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
      assert.ok(err instanceof ExternalServiceError, `expected a refusal for ${JSON.stringify(value)}`);
      assert.equal(err.descriptor.code, 'google_genai_debug');
      return true;
    });
  }
  assert.equal(constructed, 0);
  // An empty value is off for the SDK too (its test is truthiness), so it builds.
  process.env.GOOGLE_GENAI_DEBUG = '';
  _getClientForTest();
  assert.equal(constructed, 1);
});

test('outside test mode GOOGLE_GENAI_USER_PROJECT (which bills the call to another project) refuses the call and builds nothing, blank included', async () => {
  process.env.NODE_ENV = 'development';
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  for (const value of ['someone-elses-project', ' ', '']) {
    process.env.GOOGLE_GENAI_USER_PROJECT = value;
    await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
      assert.ok(err instanceof ExternalServiceError, `expected a refusal for ${JSON.stringify(value)}`);
      assert.equal(err.service, 'gemini');
      assert.deepEqual(err.descriptor, { provider: 'gemini', errorClass: 'SdkUserProjectSet', status: null, requestId: null, code: 'google_genai_user_project' });
      assert.doesNotMatch(`${err.message} ${err.originalError.message}`, /someone-elses-project/);
      return true;
    });
  }
  assert.equal(constructed, 0);
  // A client built before the variable appeared is refused too.
  delete process.env.GOOGLE_GENAI_USER_PROJECT;
  _getClientForTest();
  assert.equal(constructed, 1);
  process.env.GOOGLE_GENAI_USER_PROJECT = 'someone-elses-project';
  assert.throws(() => _getClientForTest(), (err) => err.descriptor.code === 'google_genai_user_project');
});

// ---- forwarding with a plain stub ----

// No delivery key: the live API answers any image delivery value ('inline'
// or 'uri') with 400 invalid_request "Image delivery mode is not supported."
// (2026-10-16 smoke), and without it the image comes back inline as base64.
test('a stub receives store false, no delivery, the explicit ratio and size, maxRetries 0 and the timeout', async () => {
  process.env.MENU_ART_IMAGE_TIMEOUT_MS = '99000';
  const seen = [];
  __setTestStub(stubReturning(completed([{ type: 'image', data: JPEG_BYTES.toString('base64'), mime_type: 'image/jpeg' }]), seen));
  const out = await generateImage({
    prompt: 'background',
    images: [{ buffer: PNG_BYTES, mimeType: 'image/png' }],
    aspectRatio: '4:5',
    imageSize: '4k',
    model: 'gemini-3-pro-image',
  });
  assert.ok(out.buffer.equals(JPEG_BYTES));
  assert.equal(out.mimeType, 'image/jpeg');
  assert.equal(out.responseId, 'int_ok_1');
  assert.deepEqual(out.usage, { total_tokens: 1290, total_output_tokens: 1120 });

  assert.equal(seen.length, 1);
  const { params, options } = seen[0];
  assert.deepEqual(options, { timeout: 99000, maxRetries: 0 });
  assert.deepEqual(params, {
    model: 'gemini-3-pro-image',
    input: [
      { type: 'text', text: 'background' },
      { type: 'image', data: PNG_BYTES.toString('base64'), mime_type: 'image/png' },
    ],
    store: false,
    response_format: { type: 'image', aspect_ratio: '4:5', image_size: '4K' },
  });
});

test('bad arguments are refused before any client is touched', async () => {
  const seen = [];
  __setTestStub(stubReturning(completed([]), seen));
  await assert.rejects(generateImage({ ...BASE_ARGS, imageSize: '3K' }), TypeError);
  await assert.rejects(generateImage({ ...BASE_ARGS, imageSize: undefined }), TypeError);
  await assert.rejects(generateImage({ ...BASE_ARGS, aspectRatio: 'square' }), TypeError);
  await assert.rejects(generateImage({ ...BASE_ARGS, prompt: ' ' }), TypeError);
  await assert.rejects(generateImage({ ...BASE_ARGS, images: [{ buffer: 'nope', mimeType: 'image/png' }] }), TypeError);
  assert.equal(seen.length, 0);
});

test('exactly one output image is accepted: none, two, an empty one or text only is a refusal', async () => {
  const img = (b) => ({ type: 'image', data: b.toString('base64'), mime_type: 'image/jpeg' });
  const cases = [
    [completed([{ type: 'text', text: 'Here is a description instead.' }]), 'no_image'],
    [completed([img(JPEG_BYTES), img(JPEG_BYTES)]), 'multiple_images'],
    [{ id: 'int_2', status: 'completed', steps: [
      { type: 'model_output', content: [img(JPEG_BYTES)] },
      { type: 'model_output', content: [img(JPEG_BYTES)] },
    ] }, 'multiple_images'],
    [completed([{ type: 'image', data: '', mime_type: 'image/jpeg', uri: 'https://example.com/x' }]), 'empty_image'],
    [{ id: 'int_3', status: 'completed', steps: [] }, 'no_image'],
  ];
  for (const [interaction, code] of cases) {
    __setTestStub(stubReturning(interaction));
    await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
      assert.ok(err instanceof GeminiRefusal, `expected a refusal for ${code}`);
      assert.equal(err.reason, 'Gemini answered without a single image.');
      assert.equal(err.descriptor.code, code);
      return true;
    });
  }
});

test('an image from an earlier turn (before the last user_input) does not count', async () => {
  const old = { type: 'image', data: PNG_BYTES.toString('base64'), mime_type: 'image/png' };
  __setTestStub(stubReturning({
    id: 'int_4',
    status: 'completed',
    steps: [
      { type: 'model_output', content: [old] },
      { type: 'user_input', content: [{ type: 'text', text: 'again' }] },
      { type: 'model_output', content: [{ type: 'image', data: JPEG_BYTES.toString('base64'), mime_type: 'image/jpeg' }] },
    ],
  }));
  const out = await generateImage({ ...BASE_ARGS });
  assert.ok(out.buffer.equals(JPEG_BYTES));
});

test('a 200 with status failed or incomplete is a refusal read from errors[0]', async () => {
  const cases = [
    ['failed', { code: 'IMAGE_SAFETY', message: 'raw text that is never shown' }, 'Gemini blocked this image for safety.', 'image_safety'],
    ['incomplete', { code: 'https://ai.google.dev/gemini-api/docs/errors/prohibited_content' }, 'Gemini blocked this image as prohibited content.', 'prohibited_content'],
    ['failed', { code: 'something_new' }, 'Gemini could not finish this image.', 'something_new'],
    ['failed', undefined, 'Gemini could not finish this image.', null],
  ];
  for (const [status, error, reason, code] of cases) {
    __setTestStub(stubReturning({ id: 'int_f', status, errors: error ? [error] : [], steps: [] }));
    await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
      assert.ok(err instanceof GeminiRefusal);
      assert.equal(err.reason, reason);
      assert.equal(err.descriptor.code, code);
      assert.equal(err.descriptor.requestId, 'int_f');
      assert.doesNotMatch(JSON.stringify(err.descriptor) + err.message, /raw text/);
      return true;
    });
  }
});

test('a 200 with another unfinished status rethrows as ExternalServiceError', async () => {
  __setTestStub(stubReturning({ id: 'int_b', status: 'budget_exceeded', steps: [] }));
  await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
    assert.ok(err instanceof ExternalServiceError);
    assert.equal(err.service, 'gemini');
    assert.equal(err.descriptor.code, 'budget_exceeded');
    return true;
  });
});

test('refusal codes match case-insensitively on the last path segment, at either nesting level', async () => {
  const thrown = (error) => Object.assign(new Error('400 leaky message about the Testerton wedding'), { name: 'BadRequestError', status: 400, headers: new globalThis.Headers(), error });
  const cases = [
    [thrown({ code: 'IMAGE_SAFETY' }), 'Gemini blocked this image for safety.'],
    [thrown({ code: 'image_safety' }), 'Gemini blocked this image for safety.'],
    [thrown({ error: { code: 'https://example.googleapis.com/errors/IMAGE_SAFETY' } }), 'Gemini blocked this image for safety.'],
    [thrown({ error: { code: 'PROHIBITED_CONTENT' } }), 'Gemini blocked this image as prohibited content.'],
    [thrown({ code: 'blocklist' }), 'Gemini blocked a word or phrase in the prompt.'],
    [thrown({ code: 'content-blocked' }), 'Gemini blocked this content.'],
    [thrown({ code: 'IMAGE_RECITATION' }), 'Gemini stopped because the image was too close to an existing work.'],
    [thrown({ code: 'IMAGE_OTHER' }), 'Gemini stopped drawing this image without saying why.'],
    [thrown({ error: { code: 'NO_IMAGE' } }), 'Gemini answered without an image.'],
  ];
  for (const [err, reason] of cases) {
    __setTestStub({ interactions: { create: async () => { throw err; } } });
    await assert.rejects(generateImage({ ...BASE_ARGS }), (mapped) => {
      assert.ok(mapped instanceof GeminiRefusal, `expected a refusal for ${JSON.stringify(err.error)}`);
      assert.equal(mapped.reason, reason);
      assert.equal(mapped.descriptor.errorClass, 'BadRequestError');
      assert.equal(mapped.descriptor.status, 400);
      assert.doesNotMatch(`${mapped.message} ${formatError(mapped.descriptor)}`, /Testerton/);
      return true;
    });
  }
});

// ---- the real SDK against a fake fetch ----

test('real SDK: the request goes to the pinned host with the explicit key, store false and the image format', async () => {
  process.env.GOOGLE_API_KEY = 'google-key-not-ours';
  const f = fakeFetch([jsonResponse(200, completed([{ type: 'image', data: JPEG_BYTES.toString('base64'), mime_type: 'image/jpeg' }]))]);
  __setTestStub(sdkClientWith(f));
  const out = await generateImage({ ...BASE_ARGS, images: [{ buffer: PNG_BYTES, mimeType: 'image/png' }] });
  assert.ok(out.buffer.equals(JPEG_BYTES));
  assert.equal(out.mimeType, 'image/jpeg');
  assert.equal(out.responseId, 'int_ok_1');
  assert.equal(out.usage.total_tokens, 1290);

  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(new URL(call.url).origin, 'https://generativelanguage.googleapis.com');
  assert.match(new URL(call.url).pathname, /\/interactions$/);
  assert.equal(call.headers.get('x-goog-api-key'), 'gem-test-not-real');
  const body = JSON.parse(call.body);
  assert.equal(body.store, false);
  assert.equal(body.model, 'gemini-3-pro-image');
  assert.deepEqual(body.response_format, { type: 'image', aspect_ratio: '1:1', image_size: '1K' });
  assert.equal('delivery' in body.response_format, false, 'the live API 400s on any image delivery value');
  assert.deepEqual(body.input[1], { type: 'image', data: PNG_BYTES.toString('base64'), mime_type: 'image/png' });
});

test('real SDK: a safety 400 becomes GeminiRefusal and is not retried; the descriptor drops the message', async () => {
  const f = fakeFetch([jsonResponse(400, { error: { code: 'IMAGE_SAFETY', message: 'Blocked: Testerton wedding' } })]);
  __setTestStub(sdkClientWith(f));
  await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
    assert.ok(err instanceof GeminiRefusal);
    assert.equal(err.reason, 'Gemini blocked this image for safety.');
    assert.deepEqual(err.descriptor, { provider: 'gemini', errorClass: 'BadRequestError', status: 400, requestId: null, code: 'image_safety' });
    assert.doesNotMatch(`${err.message} ${err.reason} ${formatError(err.descriptor)}`, /Testerton/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('real SDK: a 429 RESOURCE_EXHAUSTED becomes GeminiRateLimited (20 s with no Retry-After, header honored, capped 60) and is not retried', async () => {
  const exhausted = { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } };
  const cases = [
    [jsonResponse(429, exhausted), 20],
    [jsonResponse(429, exhausted, { 'retry-after': '9' }), 9],
    [jsonResponse(429, exhausted, { 'retry-after': '300' }), 60],
    [jsonResponse(429, { error: { ...exhausted.error, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } }), 37],
  ];
  for (const [response, expected] of cases) {
    const f = fakeFetch([response]);
    __setTestStub(sdkClientWith(f));
    await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
      assert.ok(err instanceof GeminiRateLimited);
      assert.equal(err.retryAfterSec, expected);
      assert.equal(err.descriptor.errorClass, 'RateLimitError');
      assert.equal(err.descriptor.status, 429);
      return true;
    });
    assert.equal(f.calls.length, 1, 'maxRetries 0 means one request');
  }
});

test('real SDK: any other error rethrows as ExternalServiceError(gemini) whose Sentry payload is the descriptor only', async () => {
  const f = fakeFetch([new globalThis.Response('<html>bad gateway for the Testerton wedding</html>', { status: 502, headers: { 'content-type': 'text/html' } })]);
  __setTestStub(sdkClientWith(f));
  await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
    assert.ok(err instanceof ExternalServiceError);
    assert.equal(err.service, 'gemini');
    assert.equal(err.statusCode, 502);
    assert.deepEqual(err.descriptor, { provider: 'gemini', errorClass: 'InternalServerError', status: 502, requestId: null, code: null });
    assert.equal(err.originalError.message, 'gemini InternalServerError 502');
    assert.doesNotMatch(`${err.message} ${err.originalError.message} ${err.originalError.stack}`, /Testerton/);
    return true;
  });
  assert.equal(f.calls.length, 1, 'a 5xx is not retried');
});

test('real SDK: the image timeout is enforced and a timeout is not retried', async () => {
  process.env.MENU_ART_IMAGE_TIMEOUT_MS = '40';
  const f = fakeFetch([(req) => new Promise((resolve, reject) => {
    // A ref'd timer keeps the loop alive; the SDK's own timeout signal is unref'd.
    const keepAlive = setTimeout(() => reject(new Error('the timeout never fired')), 3000);
    req.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(req.signal.reason);
    });
  })]);
  __setTestStub(sdkClientWith(f));
  await assert.rejects(generateImage({ ...BASE_ARGS }), (err) => {
    assert.ok(err instanceof ExternalServiceError);
    assert.equal(err.descriptor.errorClass, 'APIConnectionTimeoutError');
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('describeError keeps class, status and code only; formatError joins them', () => {
  const err = Object.assign(new Error('400 the Testerton wedding'), { name: 'BadRequestError', status: 400, error: { error: { code: 'IMAGE_SAFETY' } } });
  const d = describeError(err);
  assert.deepEqual(d, { provider: 'gemini', errorClass: 'BadRequestError', status: 400, requestId: null, code: 'image_safety' });
  assert.equal(formatError(d), 'gemini BadRequestError 400 image_safety');
  assert.deepEqual(describeError(new TypeError('x')), { provider: 'gemini', errorClass: 'TypeError', status: null, requestId: null, code: null });
  const named = Object.assign(new Error('x'), { name: 'NotAnSdkClass', error: { code: 'has spaces in it' } });
  assert.deepEqual(describeError(named), { provider: 'gemini', errorClass: 'UnknownError', status: null, requestId: null, code: null });
});
