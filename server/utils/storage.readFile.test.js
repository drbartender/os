process.env.NODE_ENV = 'test';

// storage.readFile (menu art spec 5.4): the presign plus a bounded fetch, read
// back into memory as { buffer, contentType }. Nothing leaves the box: the AWS
// presigner is stubbed through require.cache BEFORE storage.js loads, so the
// REAL getSignedUrl runs against the stub, and global fetch is swapped per test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Response, ReadableStream } = globalThis;

process.env.R2_BUCKET_NAME = 'readfile-test-bucket';

const presignerPath = require.resolve('@aws-sdk/s3-request-presigner');
const realPresigner = require('@aws-sdk/s3-request-presigner');
const presignCalls = [];
let presignThrows = null;
require.cache[presignerPath].exports = {
  ...realPresigner,
  getSignedUrl: async (_client, command, opts) => {
    presignCalls.push({ bucket: command.input.Bucket, key: command.input.Key, opts });
    if (presignThrows) throw presignThrows;
    return `https://r2.invalid/${command.input.Key}`;
  },
};

const storagePath = require.resolve('./storage');
const storage = require('./storage');
const { NotFoundError, ExternalServiceError } = require('./errors');

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function withFetch(impl, fn) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  try { return await fn(calls); } finally { global.fetch = real; }
}

function reset() {
  presignCalls.length = 0;
  presignThrows = null;
}

// A body that records being cancelled, so a non-OK answer is proven drained.
function trackedBody(text) {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(c) { c.enqueue(Buffer.from(text)); },
    cancel() { state.cancelled = true; },
  });
  return { body, state };
}

test('exports: uploadFile and getSignedUrl are still exported beside readFile', () => {
  assert.deepStrictEqual(Object.keys(storage).sort(), ['getSignedUrl', 'readFile', 'uploadFile']);
  for (const k of Object.keys(storage)) assert.strictEqual(typeof storage[k], 'function', k);
});

test('OK: returns the bytes and the stored content type, through the real presign', async () => {
  reset();
  await withFetch(
    () => new Response(BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    async (calls) => {
      const out = await storage.readFile('menu-art/7/run/background-abc.png');
      assert.ok(Buffer.isBuffer(out.buffer));
      assert.deepStrictEqual(out.buffer, BYTES);
      assert.strictEqual(out.contentType, 'image/png');
      assert.deepStrictEqual(presignCalls, [{
        bucket: 'readfile-test-bucket',
        key: 'menu-art/7/run/background-abc.png',
        opts: { expiresIn: 900 },
      }]);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, 'https://r2.invalid/menu-art/7/run/background-abc.png');
      assert.ok(calls[0].opts.signal, 'the fetch is bounded by an abort signal');
    }
  );
});

test('OK with no content-type header falls back to application/octet-stream', async () => {
  reset();
  await withFetch(() => new Response(BYTES, { status: 200 }), async () => {
    const out = await storage.readFile('menu-art/7/x.png');
    assert.strictEqual(out.contentType, 'application/octet-stream');
    assert.deepStrictEqual(out.buffer, BYTES);
  });
});

test('404: NotFoundError, and the error body is drained, never read', async () => {
  reset();
  const { body, state } = trackedBody('<Error><Code>NoSuchKey</Code></Error>');
  await withFetch(() => new Response(body, { status: 404 }), async () => {
    await assert.rejects(storage.readFile('menu-art/7/gone.png'), (err) => {
      assert.ok(err instanceof NotFoundError);
      assert.strictEqual(err.statusCode, 404);
      assert.ok(!err.message.includes('NoSuchKey'));
      return true;
    });
  });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(state.cancelled, true);
});

test('500: ExternalServiceError for r2 that leaks nothing from upstream', async () => {
  reset();
  const { body, state } = trackedBody('upstream detail https://r2.invalid/secret');
  await withFetch(() => new Response(body, { status: 500 }), async () => {
    await assert.rejects(storage.readFile('menu-art/7/x.png'), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.strictEqual(err.service, 'r2');
      assert.strictEqual(err.statusCode, 502);
      assert.ok(!err.message.includes('upstream detail'));
      assert.ok(!err.message.includes('r2.invalid'));
      assert.match(err.originalError.message, /500/);
      return true;
    });
  });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(state.cancelled, true);
});

test('a fetch error (connection refused, DNS) is ExternalServiceError for r2', async () => {
  reset();
  const boom = new TypeError('fetch failed');
  await withFetch(() => { throw boom; }, async () => {
    await assert.rejects(storage.readFile('menu-art/7/x.png'), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.strictEqual(err.service, 'r2');
      assert.strictEqual(err.originalError, boom);
      return true;
    });
  });
});

test('abort: a fetch that never answers is cut at timeoutMs', async () => {
  reset();
  const started = Date.now();
  // Real fetch rejects with an AbortError when its signal fires; mirror that.
  const hang = (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  await withFetch(hang, async () => {
    await assert.rejects(storage.readFile('menu-art/7/x.png', { timeoutMs: 30 }), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.strictEqual(err.service, 'r2');
      assert.strictEqual(err.originalError.name, 'AbortError');
      return true;
    });
  });
  assert.ok(Date.now() - started < 2000, 'cut at the timeout, not left hanging');
});

test('abort: the timer also bounds the body read, not only the headers', async () => {
  reset();
  // Headers arrive, then the body stalls; real fetch errors the body stream when
  // the signal fires, so wire the stub the same way.
  const stall = (_url, opts) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(Buffer.from('partial'));
        opts.signal.addEventListener('abort', () => {
          const e = new Error('This operation was aborted');
          e.name = 'AbortError';
          c.error(e);
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  await withFetch(stall, async () => {
    await assert.rejects(storage.readFile('menu-art/7/bg.jpg', { timeoutMs: 30 }), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.strictEqual(err.service, 'r2');
      return true;
    });
  });
});

// ── maxBytes ─────────────────────────────────────────────────────────────────

const MB25 = 25 * 1024 * 1024;

// A fetch stub whose 200 body never ends on its own but errors when the fetch
// signal fires, as real fetch does, so a readFile that reads it to the end
// fails at timeoutMs rather than hanging the suite. `state` records the cancel.
function openBodyFetch(text, headers) {
  const state = { cancelled: false };
  const impl = (_url, opts) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(text));
      opts.signal.addEventListener('abort', () => c.error(new Error('aborted')));
    },
    cancel() { state.cancelled = true; },
  }), { status: 200, headers });
  return { impl, state };
}

test('maxBytes: a Content-Length over the cap is refused unread, the body cancelled', async () => {
  reset();
  const { impl, state } = openBodyFetch('thirteen byte', { 'content-type': 'image/png', 'content-length': '13' });
  await withFetch(impl, async () => {
    await assert.rejects(storage.readFile('menu-art/7/x.png', { maxBytes: 12, timeoutMs: 500 }), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.strictEqual(err.service, 'r2');
      assert.strictEqual(err.statusCode, 502);
      assert.match(err.originalError.message, /13 bytes, over the 12 byte cap/);
      assert.ok(!err.message.includes('r2.invalid'));
      return true;
    });
  });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(state.cancelled, true);
});

test('maxBytes: the default cap is 25 MB, judged on Content-Length alone', async () => {
  reset();
  // The header claims the size; the body stays tiny, so no 25 MB is allocated.
  const claim = (n) => () => new Response(BYTES, { status: 200, headers: { 'content-length': String(n) } });
  await withFetch(claim(MB25 + 1), async () => {
    await assert.rejects(storage.readFile('menu-art/7/x.png'), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.strictEqual(err.service, 'r2');
      return true;
    });
  });
  await withFetch(claim(MB25), async () => {
    const out = await storage.readFile('menu-art/7/x.png');
    assert.deepStrictEqual(out.buffer, BYTES, 'exactly 25 MB is still allowed');
  });
});

test('maxBytes: a body with no Content-Length is cut off once it passes the cap', async () => {
  reset();
  // An endless body: it only stops if readFile stops pulling and cancels it.
  // Past 64 KB it errors, so a readFile with no cap fails here, never hangs.
  const state = { pulled: 0, cancelled: false };
  const endless = new ReadableStream({
    pull(c) {
      if (state.pulled >= 64 * 1024) { c.error(new Error('test bound: readFile never stopped')); return; }
      state.pulled += 256;
      c.enqueue(Buffer.alloc(256, 7));
    },
    cancel() { state.cancelled = true; },
  });
  await withFetch(() => new Response(endless, { status: 200 }), async () => {
    await assert.rejects(storage.readFile('menu-art/7/x.png', { maxBytes: 1024 }), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.strictEqual(err.service, 'r2');
      assert.match(err.originalError.message, /passed the 1024 byte cap/);
      return true;
    });
  });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(state.cancelled, true);
  assert.ok(state.pulled <= 1024 + 256 * 2, `stopped near the cap, pulled ${state.pulled}`);
});

test('maxBytes: a Content-Length that understates the body is caught by the count', async () => {
  reset();
  const { impl, state } = openBodyFetch('twenty bytes of body', { 'content-length': '4' });
  await withFetch(impl, async () => {
    await assert.rejects(storage.readFile('menu-art/7/x.png', { maxBytes: 8, timeoutMs: 500 }), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.match(err.originalError.message, /passed the 8 byte cap/);
      return true;
    });
  });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(state.cancelled, true);
});

test('maxBytes: a body of exactly the cap is returned whole, across chunks', async () => {
  reset();
  const chunked = new ReadableStream({
    start(c) {
      c.enqueue(BYTES.subarray(0, 5));
      c.enqueue(BYTES.subarray(5));
      c.close();
    },
  });
  await withFetch(() => new Response(chunked, { status: 200, headers: { 'content-type': 'image/png' } }), async () => {
    const out = await storage.readFile('menu-art/7/x.png', { maxBytes: BYTES.length });
    assert.ok(Buffer.isBuffer(out.buffer));
    assert.deepStrictEqual(out.buffer, BYTES);
    assert.strictEqual(out.contentType, 'image/png');
  });
});

test('an empty 200 body is an empty buffer, not an error', async () => {
  reset();
  await withFetch(() => new Response(null, { status: 200 }), async () => {
    const out = await storage.readFile('menu-art/7/x.png');
    assert.ok(Buffer.isBuffer(out.buffer));
    assert.strictEqual(out.buffer.length, 0);
  });
});

test('no key: NotFoundError before any presign or fetch', async () => {
  reset();
  await withFetch(() => { throw new Error('must not fetch'); }, async (calls) => {
    for (const bad of [undefined, null, '', 42]) {
      await assert.rejects(storage.readFile(bad), NotFoundError);
    }
    assert.strictEqual(calls.length, 0);
  });
  assert.strictEqual(presignCalls.length, 0);
});

test('a presign failure surfaces as ExternalServiceError and never fetches', async () => {
  reset();
  presignThrows = new Error('credentials missing');
  await withFetch(() => { throw new Error('must not fetch'); }, async (calls) => {
    await assert.rejects(storage.readFile('menu-art/7/x.png'), (err) => {
      assert.ok(err instanceof ExternalServiceError);
      assert.strictEqual(err.service, 'r2');
      return true;
    });
    assert.strictEqual(calls.length, 0);
  });
  presignThrows = null;
});

test('the require.cache swap route tests use (menuPrint.test.js) also reaches readFile', async () => {
  reset();
  const realExports = require.cache[storagePath].exports;
  const stubSigned = [];
  require.cache[storagePath].exports = {
    ...realExports,
    getSignedUrl: async (key) => { stubSigned.push(key); return `https://stub.invalid/${key}`; },
  };
  try {
    await withFetch(() => new Response(BYTES, { status: 200 }), async (calls) => {
      // Called the way a module required after the swap would see it.
      const out = await require('./storage').readFile('menu-art/7/x.png');
      assert.deepStrictEqual(out.buffer, BYTES);
      assert.deepStrictEqual(stubSigned, ['menu-art/7/x.png']);
      assert.strictEqual(calls[0].url, 'https://stub.invalid/menu-art/7/x.png');
    });
    assert.strictEqual(presignCalls.length, 0, 'the real presign was never reached');
  } finally {
    require.cache[storagePath].exports = realExports;
  }
});
