process.env.NODE_ENV = 'test';
// Pure suite: no DB and no network. OpenAI is never called. The real SDK is
// exercised only through a fake fetch passed to the client, and global fetch
// is replaced by a tripwire for the whole file, so a request that escaped the
// fake would fail the test instead of reaching api.openai.com.

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Count real client constructions: the wrapper reads OpenAI from this
// module's exports when it loads, so the counting subclass must be in place
// before ./openaiClient is required.
const sdkPath = require.resolve('openai');
const realSdk = require('openai');
const RealOpenAI = realSdk.OpenAI;
let constructed = 0;
class CountingOpenAI extends RealOpenAI {
  constructor(opts) {
    super(opts);
    constructed += 1;
  }
}
require.cache[sdkPath].exports = { ...realSdk, OpenAI: CountingOpenAI };

const {
  OPENAI_API_BASE_URL,
  SDK_ERROR_CLASSES,
  WORDS_REFUSAL_REASON,
  OpenAIRefusal,
  OpenAIRateLimited,
  isConfigured,
  clientOptions,
  draftMenuCopy,
  generateImage,
  editImage,
  describeError,
  formatError,
  __setTestStub,
  _getClientForTest,
  _resetForTest,
} = require('./openaiClient');
const { ExternalServiceError } = require('./errors');

const ENV_KEYS = [
  'NODE_ENV', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'OPENAI_LOG', 'OPENAI_ADMIN_KEY', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_CUSTOM_HEADERS', 'MENU_ART_IMAGE_TIMEOUT_MS',
];
let savedEnv;
let realGlobalFetch;
let tripwireHits;

before(() => {
  realGlobalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    tripwireHits += 1;
    throw new Error(`network tripwire: ${String(args[0])}`);
  };
});
after(() => {
  globalThis.fetch = realGlobalFetch;
});
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.NODE_ENV = 'test';
  delete process.env.MENU_ART_IMAGE_TIMEOUT_MS;
  delete process.env.OPENAI_CUSTOM_HEADERS;
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

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const B64 = PNG_BYTES.toString('base64');

function jsonResponse(status, body, headers = {}) {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test_1', ...headers },
  });
}

// A fake fetch that records every request and answers from a queue.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = answers.shift();
    if (!next) throw new Error('fake fetch: no answer queued');
    return typeof next === 'function' ? next(url, init) : next;
  };
  fn.Response = globalThis.Response; // lets the SDK's FormData probe skip its own fetch
  fn.calls = calls;
  return fn;
}

function sdkClientWith(fetchFn) {
  return new RealOpenAI({ ...clientOptions('sk-test-not-real'), fetch: fetchFn });
}

function headerOf(init, name) {
  return new globalThis.Headers(init.headers).get(name);
}

const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
};

function completedResponse(text) {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  };
}

// ---- configuration and refusal under test ----

test('isConfigured follows OPENAI_API_KEY; blank counts as unset', () => {
  delete process.env.OPENAI_API_KEY;
  assert.equal(isConfigured(), false);
  process.env.OPENAI_API_KEY = '   ';
  assert.equal(isConfigured(), false);
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  assert.equal(isConfigured(), true);
});

test('under NODE_ENV=test with no stub every call rejects and nothing is constructed', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  await assert.rejects(draftMenuCopy({ system: 's', user: 'u', schema: SCHEMA, model: 'm' }), /OpenAI disabled under test/);
  await assert.rejects(generateImage({ prompt: 'p', size: '1024x1024', model: 'm' }), /OpenAI disabled under test/);
  await assert.rejects(
    editImage({ prompt: 'p', images: [{ buffer: PNG_BYTES, filename: 'a.png', contentType: 'image/png' }], model: 'm' }),
    /OpenAI disabled under test/,
  );
  assert.throws(() => _getClientForTest(), /OpenAI disabled under test/);
  assert.equal(constructed, 0);
});

test('the client options pin the key, host, retries, timeout, log level and no admin key, webhook secret, org or project', () => {
  assert.deepEqual(clientOptions('sk-test-not-real'), {
    apiKey: 'sk-test-not-real',
    adminAPIKey: null,
    webhookSecret: null,
    organization: null,
    project: null,
    baseURL: 'https://api.openai.com/v1',
    maxRetries: 0,
    timeout: 60000,
    logLevel: 'off',
  });
  assert.equal(OPENAI_API_BASE_URL, 'https://api.openai.com/v1');
});

test('outside test mode the real client is built once per key and env overrides cannot move it (constructed, never called)', () => {
  process.env.NODE_ENV = 'development';
  process.env.OPENAI_API_KEY = ' sk-test-not-real ';
  process.env.OPENAI_BASE_URL = 'https://evil.example.com/v1';
  process.env.OPENAI_ORG_ID = 'org-someone-else';
  process.env.OPENAI_PROJECT_ID = 'proj-someone-else';
  process.env.OPENAI_LOG = 'debug';
  process.env.OPENAI_ADMIN_KEY = 'sk-admin-not-ours';
  process.env.OPENAI_WEBHOOK_SECRET = 'whsec-not-ours';
  const a = _getClientForTest();
  assert.ok(a instanceof RealOpenAI);
  assert.equal(constructed, 1);
  assert.equal(a.apiKey, 'sk-test-not-real');
  assert.equal(a.baseURL, 'https://api.openai.com/v1');
  assert.equal(a.adminAPIKey, null);
  assert.equal(a.webhookSecret, null);
  assert.equal(a.organization, null);
  assert.equal(a.project, null);
  assert.equal(a.maxRetries, 0);
  assert.equal(a.timeout, 60000);
  assert.equal(a.logLevel, 'off');
  assert.equal(_getClientForTest(), a);
  assert.equal(constructed, 1);
  process.env.OPENAI_API_KEY = 'sk-test-rotated';
  assert.notEqual(_getClientForTest(), a);
  assert.equal(constructed, 2);
});

test('outside test mode with no key a call throws the 503 not-set-up error and builds nothing', async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(generateImage({ prompt: 'p', model: 'm' }), (err) => {
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, 'MENU_ART_NOT_CONFIGURED');
    return true;
  });
  assert.equal(constructed, 0);
});

test('outside test mode OPENAI_CUSTOM_HEADERS (which could replace the auth header) refuses the call and builds nothing, blank included', async () => {
  process.env.NODE_ENV = 'development';
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  for (const value of ['Authorization: Bearer sk-someone-else', '   ', '']) {
    process.env.OPENAI_CUSTOM_HEADERS = value;
    await assert.rejects(generateImage({ prompt: 'p', model: 'm' }), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.equal(err.service, 'openai');
      assert.deepEqual(err.descriptor, { provider: 'openai', errorClass: 'SdkCustomHeadersSet', status: null, requestId: null, code: 'openai_custom_headers' });
      assert.doesNotMatch(`${err.message} ${err.originalError.message}`, /sk-someone-else/);
      return true;
    });
    await assert.rejects(draftMenuCopy({ system: 's', user: 'u', schema: SCHEMA, model: 'm' }), (err) => err.descriptor.code === 'openai_custom_headers');
  }
  assert.equal(constructed, 0);
  // A client built before the variable appeared is refused too.
  delete process.env.OPENAI_CUSTOM_HEADERS;
  _getClientForTest();
  assert.equal(constructed, 1);
  process.env.OPENAI_CUSTOM_HEADERS = 'OpenAI-Organization: org-someone-else';
  assert.throws(() => _getClientForTest(), (err) => err.descriptor.code === 'openai_custom_headers');
});

test('every SDK error class the describer checks exists in this SDK version', () => {
  for (const [name, cls] of SDK_ERROR_CLASSES) {
    assert.equal(typeof cls, 'function', `OpenAI.${name} is missing`);
  }
});

// ---- forwarding with a plain stub ----

test('a stub receives each call with maxRetries 0 and its timeout, and store false on the words call', async () => {
  process.env.MENU_ART_IMAGE_TIMEOUT_MS = '123456';
  const seen = [];
  const stub = {
    responses: {
      create: async (body, opts) => {
        seen.push(['words', body, opts]);
        return Object.defineProperty(completedResponse('{"title":"Bar Menu"}'), '_request_id', { value: 'req_words' });
      },
    },
    images: {
      generate: async (body, opts) => {
        seen.push(['generate', body, opts]);
        return Object.defineProperty({ data: [{ b64_json: B64 }] }, '_request_id', { value: 'req_gen' });
      },
      edit: async (body, opts) => {
        seen.push(['edit', body, opts]);
        return Object.defineProperty({ data: [{ b64_json: B64 }] }, '_request_id', { value: 'req_edit' });
      },
    },
  };
  __setTestStub(stub);

  const words = await draftMenuCopy({ system: 'sys', user: 'usr', schema: SCHEMA, model: 'gpt-5.4-mini' });
  assert.deepEqual(words, { json: { title: 'Bar Menu' }, requestId: 'req_words' });

  const gen = await generateImage({ prompt: 'bg', size: '2560x3200', quality: 'high', outputFormat: 'jpeg', model: 'gpt-image-2.5-sunburst' });
  assert.ok(gen.buffer.equals(PNG_BYTES));
  assert.equal(gen.requestId, 'req_gen');

  const edit = await editImage({
    prompt: 'drink',
    images: [{ buffer: PNG_BYTES, filename: 'bg.png', contentType: 'image/png' }],
    size: '1024x1024',
    quality: 'high',
    outputFormat: 'png',
    background: 'transparent',
    model: 'gpt-image-2.5-sunburst',
  });
  assert.ok(edit.buffer.equals(PNG_BYTES));
  assert.equal(edit.requestId, 'req_edit');

  const [w, g, e] = seen;
  assert.deepEqual(w[2], { timeout: 60000, maxRetries: 0 });
  assert.equal(w[1].store, false);
  assert.equal(w[1].model, 'gpt-5.4-mini');
  assert.equal(w[1].instructions, 'sys');
  assert.equal(w[1].input, 'usr');
  assert.deepEqual(w[1].text, { format: { type: 'json_schema', name: 'menu_copy', schema: SCHEMA, strict: true } });

  assert.deepEqual(g[2], { timeout: 123456, maxRetries: 0 });
  assert.deepEqual(g[1], { model: 'gpt-image-2.5-sunburst', prompt: 'bg', n: 1, size: '2560x3200', quality: 'high', output_format: 'jpeg' });

  assert.deepEqual(e[2], { timeout: 123456, maxRetries: 0 });
  assert.equal(e[1].background, 'transparent');
  assert.equal(e[1].output_format, 'png');
  assert.ok(e[1].image instanceof globalThis.File);
  assert.equal(e[1].image.name, 'bg.png');
  assert.equal(e[1].image.type, 'image/png');
});

test('the image timeout falls back to 180000 when MENU_ART_IMAGE_TIMEOUT_MS is nonsense', async () => {
  process.env.MENU_ART_IMAGE_TIMEOUT_MS = '0';
  let opts;
  __setTestStub({ images: { generate: async (b, o) => { opts = o; return { data: [{ b64_json: B64 }] }; } } });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await generateImage({ prompt: 'p', model: 'm' });
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(opts, { timeout: 180000, maxRetries: 0 });
});

test('editImage sends several references as an array and refuses an empty list before any call', async () => {
  let body;
  __setTestStub({ images: { edit: async (b) => { body = b; return { data: [{ b64_json: B64 }] }; } } });
  await editImage({
    prompt: 'p',
    images: [
      { buffer: PNG_BYTES, filename: 'bg.png', contentType: 'image/png' },
      { buffer: PNG_BYTES, filename: 'ref.jpg', contentType: 'image/jpeg' },
    ],
    model: 'm',
  });
  assert.ok(Array.isArray(body.image));
  assert.deepEqual(body.image.map((f) => f.name), ['bg.png', 'ref.jpg']);
  await assert.rejects(editImage({ prompt: 'p', images: [], model: 'm' }), TypeError);
});

// ---- the real SDK against a fake fetch ----

test('real SDK: the words call goes to the pinned host with store false, the schema, the key and a 60 s timeout', async () => {
  const f = fakeFetch([jsonResponse(200, completedResponse('{"title":"Garden Party"}'), { 'x-request-id': 'req_words_1' })]);
  __setTestStub(sdkClientWith(f));
  const out = await draftMenuCopy({ system: 'sys', user: 'usr', schema: SCHEMA, model: 'gpt-5.4-mini' });
  assert.deepEqual(out, { json: { title: 'Garden Party' }, requestId: 'req_words_1' });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(headerOf(init, 'authorization'), 'Bearer sk-test-not-real');
  assert.equal(headerOf(init, 'openai-organization'), null);
  assert.equal(headerOf(init, 'openai-project'), null);
  assert.equal(headerOf(init, 'x-stainless-timeout'), '60');
  const body = JSON.parse(init.body);
  assert.equal(body.store, false);
  assert.equal(body.model, 'gpt-5.4-mini');
  assert.deepEqual(body.text.format, { type: 'json_schema', name: 'menu_copy', schema: SCHEMA, strict: true });
});

test('real SDK: OPENAI_ADMIN_KEY and OPENAI_WEBHOOK_SECRET in the environment are never read into the client or sent', async () => {
  process.env.OPENAI_ADMIN_KEY = 'sk-admin-not-ours';
  process.env.OPENAI_WEBHOOK_SECRET = 'whsec-not-ours';
  const f = fakeFetch([jsonResponse(200, completedResponse('{"title":"Bar Menu"}'))]);
  const client = sdkClientWith(f);
  assert.equal(client.adminAPIKey, null);
  assert.equal(client.webhookSecret, null);
  __setTestStub(client);
  await draftMenuCopy({ system: 's', user: 'u', schema: SCHEMA, model: 'm' });
  assert.equal(f.calls.length, 1);
  assert.equal(headerOf(f.calls[0].init, 'authorization'), 'Bearer sk-test-not-real');
  assert.doesNotMatch(JSON.stringify([...new globalThis.Headers(f.calls[0].init.headers)]), /sk-admin|whsec/);
});

test('real SDK: generate and edit reach the image endpoints with the image timeout and decode base64', async () => {
  const f = fakeFetch([
    jsonResponse(200, { created: 1, data: [{ b64_json: B64 }] }, { 'x-request-id': 'req_gen_1' }),
    jsonResponse(200, { created: 1, data: [{ b64_json: B64 }] }, { 'x-request-id': 'req_edit_1' }),
  ]);
  __setTestStub(sdkClientWith(f));
  const gen = await generateImage({ prompt: 'bg', size: '2560x3200', quality: 'high', outputFormat: 'jpeg', model: 'gpt-image-2.5-sunburst' });
  assert.ok(gen.buffer.equals(PNG_BYTES));
  assert.equal(gen.requestId, 'req_gen_1');
  const edit = await editImage({
    prompt: 'drink',
    images: [{ buffer: PNG_BYTES, filename: 'bg.png', contentType: 'image/png' }],
    size: '1024x1024',
    outputFormat: 'png',
    background: 'transparent',
    model: 'gpt-image-2.5-sunburst',
  });
  assert.ok(edit.buffer.equals(PNG_BYTES));
  assert.equal(edit.requestId, 'req_edit_1');

  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(headerOf(f.calls[0].init, 'x-stainless-timeout'), '180');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    model: 'gpt-image-2.5-sunburst', prompt: 'bg', n: 1, size: '2560x3200', quality: 'high', output_format: 'jpeg',
  });
  assert.equal(f.calls[1].url, 'https://api.openai.com/v1/images/edits');
  assert.equal(headerOf(f.calls[1].init, 'x-stainless-timeout'), '180');
  const form = f.calls[1].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('prompt'), 'drink');
  assert.equal(form.get('background'), 'transparent');
  assert.equal(form.get('output_format'), 'png');
  const file = form.get('image');
  assert.ok(file instanceof Blob);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG_BYTES));
});

test('real SDK: a 429 becomes OpenAIRateLimited with Retry-After (default 20, capped 60) and is not retried', async () => {
  const cases = [
    [{ 'retry-after': '7' }, 7],
    [{}, 20],
    [{ 'retry-after': '600' }, 60],
    [{ 'retry-after-ms': '2500' }, 3],
  ];
  for (const [headers, expected] of cases) {
    const f = fakeFetch([jsonResponse(429, { error: { message: 'Rate limit reached for images', type: 'requests', code: 'rate_limit_exceeded' } }, { 'x-request-id': 'req_429', ...headers })]);
    __setTestStub(sdkClientWith(f));
    await assert.rejects(generateImage({ prompt: 'p', model: 'm' }), (err) => {
      assert.ok(err instanceof OpenAIRateLimited);
      assert.equal(err.retryAfterSec, expected);
      assert.deepEqual(err.descriptor, { provider: 'openai', errorClass: 'RateLimitError', status: 429, requestId: 'req_429', code: 'rate_limit_exceeded' });
      return true;
    });
    assert.equal(f.calls.length, 1, 'maxRetries 0 means one request');
  }
});

test('real SDK: a 429 for an exhausted balance is not a rate limit; it rethrows as ExternalServiceError', async () => {
  const f = fakeFetch([jsonResponse(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } })]);
  __setTestStub(sdkClientWith(f));
  await assert.rejects(generateImage({ prompt: 'p', model: 'm' }), (err) => {
    assert.ok(err instanceof ExternalServiceError);
    assert.equal(err.descriptor.code, 'insufficient_quota');
    return true;
  });
});

test('real SDK: a moderation block becomes OpenAIRefusal with the moderation text as its reason', async () => {
  const message = 'Your request was rejected by the safety system. safety_violations=[violence].';
  const f = fakeFetch([jsonResponse(400, { error: { message, type: 'image_generation_user_error', param: null, code: 'moderation_blocked' } }, { 'x-request-id': 'req_mod' })]);
  __setTestStub(sdkClientWith(f));
  await assert.rejects(
    editImage({ prompt: 'p', images: [{ buffer: PNG_BYTES, filename: 'a.png', contentType: 'image/png' }], model: 'm' }),
    (err) => {
      assert.ok(err instanceof OpenAIRefusal);
      assert.equal(err.reason, message);
      assert.deepEqual(err.descriptor, { provider: 'openai', errorClass: 'BadRequestError', status: 400, requestId: 'req_mod', code: 'moderation_blocked' });
      assert.doesNotMatch(err.message, /safety_violations/);
      return true;
    },
  );
  assert.equal(f.calls.length, 1);
});

test('real SDK: any other error rethrows as ExternalServiceError(openai) whose Sentry payload is the descriptor only', async () => {
  const leaky = 'Invalid prompt: Testerton wedding at 123 Main St';
  const f = fakeFetch([jsonResponse(500, { error: { message: leaky, type: 'server_error', code: null } }, { 'x-request-id': 'req_500' })]);
  __setTestStub(sdkClientWith(f));
  await assert.rejects(generateImage({ prompt: 'p', model: 'm' }), (err) => {
    assert.ok(err instanceof ExternalServiceError);
    assert.equal(err.service, 'openai');
    assert.equal(err.statusCode, 502);
    assert.deepEqual(err.descriptor, { provider: 'openai', errorClass: 'InternalServerError', status: 500, requestId: 'req_500', code: null });
    assert.equal(err.originalError.message, 'openai InternalServerError 500 req_500');
    assert.equal(err.originalError.name, 'InternalServerError');
    assert.doesNotMatch(`${err.message} ${err.originalError.message} ${err.originalError.stack}`, /Testerton|Main St/);
    return true;
  });
  assert.equal(f.calls.length, 1, 'a 5xx is not retried');
});

test('real SDK: the image timeout is enforced and a timeout is not retried', async () => {
  process.env.MENU_ART_IMAGE_TIMEOUT_MS = '40';
  const f = fakeFetch([(url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    });
  })]);
  __setTestStub(sdkClientWith(f));
  await assert.rejects(generateImage({ prompt: 'p', model: 'm' }), (err) => {
    assert.ok(err instanceof ExternalServiceError);
    assert.equal(err.descriptor.errorClass, 'APIConnectionTimeoutError');
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('real SDK: a words refusal, a filtered stop, a failed response and bad JSON all fail the words call', async () => {
  const refusal = { id: 'r', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }] };
  const filtered = { id: 'r', object: 'response', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] };
  const tooLong = { id: 'r', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] };
  const failed = { id: 'r', object: 'response', status: 'failed', error: { code: 'server_error', message: 'boom' }, output: [] };
  const f = fakeFetch([
    jsonResponse(200, refusal),
    jsonResponse(200, filtered),
    jsonResponse(200, tooLong),
    jsonResponse(200, failed),
    jsonResponse(200, completedResponse('{"title": not json')),
  ]);
  __setTestStub(sdkClientWith(f));
  const call = () => draftMenuCopy({ system: 's', user: 'u', schema: SCHEMA, model: 'm' });
  await assert.rejects(call(), (err) => err instanceof OpenAIRefusal && err.reason === WORDS_REFUSAL_REASON);
  await assert.rejects(call(), (err) => err instanceof OpenAIRefusal && err.reason === WORDS_REFUSAL_REASON
    && err.descriptor.code === 'content_filter');
  await assert.rejects(call(), (err) => err instanceof ExternalServiceError && err.descriptor.code === 'max_output_tokens');
  await assert.rejects(call(), (err) => err instanceof ExternalServiceError && err.descriptor.code === 'server_error');
  await assert.rejects(call(), (err) => err instanceof ExternalServiceError && err.descriptor.code === 'invalid_json'
    && err.descriptor.requestId === 'req_test_1');
});

test('real SDK: a words refusal never carries the provider text; a client name in it stays out of the reason, message and descriptor', async () => {
  const leaky = 'I cannot write a menu for the Testerton wedding at 123 Main St.';
  const refusalItem = { id: 'r', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: leaky }] }] };
  const filtered = { id: 'r', object: 'response', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] };
  const failed = { id: 'r', object: 'response', status: 'failed', error: { code: 'moderation_blocked', message: leaky }, output: [] };
  const f = fakeFetch([
    jsonResponse(200, refusalItem, { 'x-request-id': 'req_refusal' }),
    jsonResponse(200, filtered, { 'x-request-id': 'req_filtered' }),
    jsonResponse(200, failed, { 'x-request-id': 'req_failed' }),
    jsonResponse(400, { error: { message: leaky, type: 'invalid_request_error', param: null, code: 'moderation_blocked' } }, { 'x-request-id': 'req_thrown' }),
  ]);
  __setTestStub(sdkClientWith(f));
  const expected = [
    { provider: 'openai', errorClass: 'ModelRefusal', status: null, requestId: 'req_refusal', code: 'refusal' },
    { provider: 'openai', errorClass: 'ResponseIncomplete', status: null, requestId: 'req_filtered', code: 'content_filter' },
    { provider: 'openai', errorClass: 'ResponseFailed', status: null, requestId: 'req_failed', code: 'moderation_blocked' },
    { provider: 'openai', errorClass: 'BadRequestError', status: 400, requestId: 'req_thrown', code: 'moderation_blocked' },
  ];
  for (const d of expected) {
    await assert.rejects(draftMenuCopy({ system: 's', user: 'u', schema: SCHEMA, model: 'm' }), (err) => {
      assert.ok(err instanceof OpenAIRefusal, `expected a refusal for ${d.errorClass}`);
      assert.equal(err.reason, 'OpenAI declined to write this menu. Try different art direction.');
      assert.deepEqual(err.descriptor, d);
      assert.doesNotMatch(`${err.reason} ${err.message} ${err.stack} ${JSON.stringify(err.descriptor)} ${formatError(err.descriptor)}`, /Testerton|Main St/);
      return true;
    });
  }
  assert.equal(f.calls.length, 4);
});

test('an image answer with no data rethrows as ExternalServiceError', async () => {
  __setTestStub({ images: { generate: async () => ({ data: [] }) } });
  await assert.rejects(generateImage({ prompt: 'p', model: 'm' }), (err) => err instanceof ExternalServiceError && err.descriptor.code === 'no_image');
});

test('describeError and formatError carry class, status, request id and code, never the message', () => {
  const leaky = new RealOpenAI.BadRequestError(
    400,
    { message: 'prompt: Can you do Oct 20 for the Testerton wedding?', code: 'invalid_value' },
    undefined,
    new globalThis.Headers({ 'x-request-id': 'req_leak' }),
  );
  assert.match(leaky.message, /Testerton/);
  const d = describeError(leaky);
  assert.deepEqual(d, { provider: 'openai', errorClass: 'BadRequestError', status: 400, requestId: 'req_leak', code: 'invalid_value' });
  assert.equal(formatError(d), 'openai BadRequestError 400 req_leak invalid_value');
  assert.deepEqual(describeError(new TypeError('x')), { provider: 'openai', errorClass: 'TypeError', status: null, requestId: null, code: null });
  const odd = new RealOpenAI.BadRequestError(400, { message: 'm', code: 'has spaces and a name' }, undefined, new globalThis.Headers());
  assert.equal(describeError(odd).code, null);
});
