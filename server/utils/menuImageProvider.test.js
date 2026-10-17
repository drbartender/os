process.env.NODE_ENV = 'test';
// server/utils/menuImageProvider.test.js
// PURE unit tests, no DB and no provider (plan Task E3b). Both wrappers are
// stubbed through their __setTestStub hooks at the SDK-client level, so the
// real wrapper code (options, error mapping) runs; the stub outputs are real
// sharp-made images, and global fetch is a tripwire for the whole file.
//   node --test server/utils/menuImageProvider.test.js
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const openaiClient = require('./openaiClient');
const geminiClient = require('./geminiClient');
const { AppError, ExternalServiceError } = require('./errors');
const {
  drawImage, prepareReferences, MenuArtRefusal, MenuArtRateLimited, OPENAI_REFUSAL_REASON, REFERENCE_MAX_EDGE,
} = require('./menuImageProvider');
const { RESIZE_BYTE_LIMIT } = require('./r2Proxy');

const ENV_KEYS = ['GEMINI_API_KEY', 'MENU_ART_BACKGROUND_SIZE', 'MENU_ART_IMAGE_MODEL', 'MENU_ART_GEMINI_IMAGE_MODEL'];
const MAGENTA = { r: 255, g: 0, b: 255 };
const TEAL = { r: 20, g: 110, b: 120 };
let savedEnv;
let realFetch;
let tripwire;
const img = {};

const canvas = (width, height, background, channels = 3) => sharp({ create: { width, height, channels, background } });
// A drink-like teal block on a solid background, as Gemini or OpenAI would draw it.
const drinkOn = (size, background, format) => {
  const block = canvas(Math.round(size * 0.4), Math.round(size * 0.5), TEAL).png().toBuffer();
  return block.then((input) => {
    const c = canvas(size, size, background, background.alpha === undefined ? 3 : 4)
      .composite([{ input, left: Math.round(size * 0.3), top: Math.round(size * 0.25) }]);
    return (format === 'png' ? c.png() : c.jpeg({ quality: 90 })).toBuffer();
  });
};

before(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (url) => { tripwire += 1; return Promise.reject(new Error(`network tripwire: ${String(url)}`)); };
  img.geminiBackground = await canvas(3712, 4608, { r: 240, g: 230, b: 210 }).jpeg().toBuffer();
  img.geminiDrink = await drinkOn(1024, MAGENTA, 'jpeg');
  img.geminiDrinkOdd = await drinkOn(1200, MAGENTA, 'jpeg');
  img.geminiNoKey = await canvas(1024, 1024, TEAL).jpeg().toBuffer();
  img.openaiBackground = await canvas(2560, 3200, { r: 30, g: 40, b: 70 }).jpeg().toBuffer();
  img.openaiDrink = await drinkOn(1024, { r: 0, g: 0, b: 0, alpha: 0 }, 'png');
  img.smallJpeg = await canvas(800, 600, { r: 200, g: 180, b: 160 }).jpeg().toBuffer();
  img.bigPng = await canvas(3000, 2000, { r: 90, g: 160, b: 90 }).png().toBuffer();
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.GEMINI_API_KEY = 'gem-test-not-real';
  process.env.MENU_ART_IMAGE_MODEL = 'env-openai-model';
  process.env.MENU_ART_GEMINI_IMAGE_MODEL = 'env-gemini-model';
  delete process.env.MENU_ART_BACKGROUND_SIZE;
  tripwire = 0;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  openaiClient._resetForTest();
  geminiClient._resetForTest();
  assert.equal(tripwire, 0, 'a request reached global fetch');
});

function stubOpenAI(answer, seen = []) {
  const reply = async (op, body, options) => {
    seen.push({ op, body, options });
    const out = typeof answer === 'function' ? await answer(op) : answer;
    return { data: [{ b64_json: out.toString('base64') }], _request_id: `req_${op}` };
  };
  openaiClient.__setTestStub({ images: { generate: (b, o) => reply('generate', b, o), edit: (b, o) => reply('edit', b, o) } });
  return seen;
}

function stubGemini(answer, seen = []) {
  geminiClient.__setTestStub({
    interactions: {
      create: async (params, options) => {
        seen.push({ params, options });
        if (typeof answer === 'function') return await answer();
        return { id: 'int_1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', data: answer.toString('base64'), mime_type: 'image/jpeg' }] }] };
      },
    },
  });
  return seen;
}

const meta = (buffer) => sharp(buffer).metadata();
const refOf = (buffer, mimeType) => ({ buffer, mimeType });
const throwing = (err) => () => { throw err; };

// ---- OpenAI ----

test('openai background: generateImage at the env size, quality high, JPEG, the stamped model', async () => {
  const seen = stubOpenAI(img.openaiBackground);
  const out = await drawImage({ provider: 'openai', model: 'stamped-gpt-image', kind: 'background', prompt: 'a garden' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].op, 'generate');
  assert.equal(seen[0].body.size, '2560x3200');
  assert.equal(seen[0].body.quality, 'high');
  assert.equal(seen[0].body.output_format, 'jpeg');
  assert.equal(seen[0].body.model, 'stamped-gpt-image');
  assert.equal(seen[0].body.background, undefined);
  assert.deepEqual({ contentType: out.contentType, model: out.model, size: out.size, requestId: out.requestId },
    { contentType: 'image/jpeg', model: 'stamped-gpt-image', size: '2560x3200', requestId: 'req_generate' });
  const m = await meta(out.buffer);
  assert.deepEqual([m.format, m.width, m.height], ['jpeg', 2560, 3200]);
});

test('openai background with a reference goes through editImage under a fixed safe filename', async () => {
  const seen = stubOpenAI(img.openaiBackground);
  const out = await drawImage({ provider: 'openai', model: 'm1', kind: 'background', prompt: 'p', references: [refOf(img.smallJpeg, 'image/png')] });
  assert.equal(seen[0].op, 'edit');
  assert.equal(seen[0].body.image.name, 'reference-1.jpg', 'named by the sniffed type, never the upload name');
  assert.equal(seen[0].body.image.type, 'image/jpeg');
  assert.equal(seen[0].body.size, '2560x3200');
  assert.equal(seen[0].body.quality, 'high');
  assert.equal(out.requestId, 'req_edit');
});

test('MENU_ART_BACKGROUND_SIZE is used when it is a valid WxH and falls back to 2560x3200 otherwise', async () => {
  const sizes = [];
  stubOpenAI(img.openaiBackground, sizes);
  for (const value of ['1664x2080', 'huge', '1000x1000', '4096x4096', '']) {
    process.env.MENU_ART_BACKGROUND_SIZE = value;
    await drawImage({ provider: 'openai', model: 'm', kind: 'background', prompt: 'p' });
  }
  assert.deepEqual(sizes.map((s) => s.body.size), ['1664x2080', '2560x3200', '2560x3200', '2560x3200', '2560x3200']);
});

test('openai drink: editImage with the background and reference, 1024x1024, transparent, PNG with alpha', async () => {
  const seen = stubOpenAI(img.openaiDrink);
  const out = await drawImage({
    provider: 'openai', model: 'stamped-gpt-image', kind: 'drink', prompt: 'a coupe',
    references: [refOf(img.openaiBackground, 'image/jpeg'), refOf(img.bigPng, 'image/png')],
  });
  const { body } = seen[0];
  assert.equal(seen[0].op, 'edit');
  assert.deepEqual([body.size, body.background, body.output_format, body.model], ['1024x1024', 'transparent', 'png', 'stamped-gpt-image']);
  assert.deepEqual(body.image.map((f) => f.name), ['reference-1.jpg', 'reference-2.png']);
  assert.equal(out.contentType, 'image/png');
  const m = await meta(out.buffer);
  assert.deepEqual([m.format, m.width, m.height, m.hasAlpha], ['png', 1024, 1024, true]);
});

test('openai drink with no references uses generateImage with a transparent background', async () => {
  const seen = stubOpenAI(img.openaiDrink);
  await drawImage({ provider: 'openai', model: 'm', kind: 'drink', prompt: 'p' });
  assert.equal(seen[0].op, 'generate');
  assert.equal(seen[0].body.background, 'transparent');
  assert.equal(seen[0].body.size, '1024x1024');
});

test('an openai drink that comes back the wrong size or type is stored as a 1024 PNG with alpha', async () => {
  stubOpenAI(await canvas(512, 512, TEAL).jpeg().toBuffer());
  const out = await drawImage({ provider: 'openai', model: 'm', kind: 'drink', prompt: 'p' });
  const m = await meta(out.buffer);
  assert.deepEqual([m.format, m.width, m.height, m.hasAlpha], ['png', 1024, 1024, true]);
});

// ---- Gemini ----

test('gemini background: 4:5 at 4K with the reference, resized to a 2560x3200 JPEG', async () => {
  const seen = stubGemini(img.geminiBackground);
  const out = await drawImage({
    provider: 'gemini', model: 'stamped-gemini', kind: 'background', prompt: 'a garden', references: [refOf(img.smallJpeg, 'image/jpeg')],
  });
  const { params, options } = seen[0];
  assert.equal(params.model, 'stamped-gemini');
  assert.deepEqual([params.response_format.aspect_ratio, params.response_format.image_size], ['4:5', '4K']);
  assert.equal(params.store, false);
  assert.equal(options.maxRetries, 0);
  const images = params.input.filter((b) => b.type === 'image');
  assert.equal(images.length, 1, 'the reference is passed');
  assert.equal(images[0].mime_type, 'image/jpeg');
  const sentRef = Buffer.from(images[0].data, 'base64');
  assert.ok(!sentRef.equals(img.smallJpeg), 'even a small reference is re-encoded, never sent as uploaded');
  assert.deepEqual(await meta(sentRef).then((m) => [m.format, m.width, m.height]), ['jpeg', 800, 600]);
  assert.deepEqual({ contentType: out.contentType, model: out.model, size: out.size, requestId: out.requestId },
    { contentType: 'image/jpeg', model: 'stamped-gemini', size: '4:5 4K', requestId: 'int_1' });
  const m = await meta(out.buffer);
  assert.deepEqual([m.format, m.width, m.height], ['jpeg', 2560, 3200]);
});

test('a large reference is downscaled before it is base64-ed for Gemini, once per buffer', async () => {
  const seen = stubGemini(img.geminiBackground);
  await drawImage({ provider: 'gemini', model: 'g', kind: 'background', prompt: 'p', references: [refOf(img.bigPng, 'image/png')] });
  const sent = seen[0].params.input.find((b) => b.type === 'image');
  const m = await meta(Buffer.from(sent.data, 'base64'));
  assert.equal(Math.max(m.width, m.height), REFERENCE_MAX_EDGE);
  assert.equal(sent.mime_type, 'image/png');
  const [a] = await prepareReferences([refOf(img.bigPng, 'image/png')]);
  const [b] = await prepareReferences([refOf(img.bigPng, 'image/png')]);
  assert.equal(a, b, 'the same buffer is prepared once');
  const [again] = await prepareReferences([a]);
  assert.equal(again, a, 'a prepared reference passed back in is not encoded a second time');
});

test('a reference is always re-encoded: no EXIF or XMP (GPS, an owner name) reaches a provider, and its rotation is applied', async () => {
  const tagged = await canvas(300, 200, { r: 200, g: 180, b: 160 })
    .withExif({ IFD0: { Artist: 'Jane Client Owner', Copyright: 'Jane Client' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 52/1 0/1' } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
      + '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Jane Client Owner</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>')
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const before = await meta(tagged);
  assert.ok(before.exif && before.xmp && before.orientation === 6 && tagged.includes('Jane Client'), 'the fixture carries the metadata');
  const seen = stubGemini(img.geminiBackground);
  await drawImage({ provider: 'gemini', model: 'g', kind: 'background', prompt: 'p', references: [refOf(tagged, 'image/jpeg')] });
  const sent = Buffer.from(seen[0].params.input.find((b) => b.type === 'image').data, 'base64');
  const m = await meta(sent);
  assert.equal(m.exif, undefined, 'no EXIF');
  assert.equal(m.xmp, undefined, 'no XMP');
  assert.ok(!sent.includes('Jane Client'), 'no owner name anywhere in the bytes');
  assert.deepEqual([m.format, m.width, m.height, m.orientation], ['jpeg', 200, 300, undefined], 'the rotation is in the pixels');
  const alpha = await canvas(64, 64, { r: 10, g: 20, b: 30, alpha: 0.5 }, 4).webp().toBuffer();
  const [p] = await prepareReferences([refOf(alpha, 'image/webp')]);
  assert.equal(p.mimeType, 'image/png', 'alpha keeps a lossless, alpha-safe encoding');
  assert.equal((await meta(p.buffer)).hasAlpha, true);
});

test('a reference over the decoded-size budget is refused from its header, before it is decoded', async () => {
  // 6000x6000 = 36 MP, under the 50 MP pixel limit, but 16-bit RGBA decodes to
  // about 288 MB, over r2Proxy's 200 MB budget, so the header alone refuses it.
  const side = 6000;
  assert.ok(side * side < 50_000_000 && side * side * 4 * 2 > RESIZE_BYTE_LIMIT);
  const deep = await canvas(side, side, { r: 40, g: 90, b: 70, alpha: 1 }, 4)
    .toColourspace('rgb16').png({ compressionLevel: 9 }).toBuffer();
  assert.equal((await meta(deep)).depth, 'ushort', 'the fixture really is 16-bit');
  const seen = stubGemini(img.geminiBackground);
  await assert.rejects(
    drawImage({ provider: 'gemini', model: 'g', kind: 'background', prompt: 'p', references: [refOf(deep, 'image/png')] }),
    (err) => err instanceof AppError && err.code === 'MENU_ART_REFERENCE_UNREADABLE' && err.statusCode === 422);
  assert.equal(seen.length, 0, 'nothing is sent');
});

test('gemini drink: 1:1 at 1K, keyed out to a 1024 PNG with real alpha', async () => {
  const seen = stubGemini(img.geminiDrink);
  const out = await drawImage({
    provider: 'gemini', model: 'stamped-gemini', kind: 'drink', prompt: 'a coupe', references: [refOf(img.smallJpeg, 'image/jpeg')],
  });
  assert.deepEqual([seen[0].params.response_format.aspect_ratio, seen[0].params.response_format.image_size], ['1:1', '1K']);
  assert.deepEqual([out.contentType, out.size, out.model], ['image/png', '1:1 1K', 'stamped-gemini']);
  const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [1024, 1024, 4]);
  assert.equal(data[3], 0, 'the magenta corner is keyed out');
  assert.equal(data[(512 * 1024 + 512) * 4 + 3], 255, 'the drink stays opaque');
});

test('a gemini drink that is not 1024 square comes out 1024x1024', async () => {
  stubGemini(img.geminiDrinkOdd);
  const m = await meta((await drawImage({ provider: 'gemini', model: 'g', kind: 'drink', prompt: 'p' })).buffer);
  assert.deepEqual([m.format, m.width, m.height, m.hasAlpha], ['png', 1024, 1024, true]);
});

test('a gemini drink with no magenta fails the key-out as a MenuArtRefusal with the readable reason', async () => {
  stubGemini(img.geminiNoKey);
  await assert.rejects(drawImage({ provider: 'gemini', model: 'g', kind: 'drink', prompt: 'p' }), (err) => {
    assert.ok(err instanceof MenuArtRefusal);
    assert.equal(err.reason, "Gemini didn't leave a clean background. Re-roll it.");
    assert.deepEqual(err.descriptor, { provider: 'gemini', errorClass: 'MenuKeyOutFailed', status: null, requestId: 'int_1', code: 'key_out_failed' });
    return true;
  });
});

test('gemini without its key refuses with MENU_ART_GEMINI_NOT_CONFIGURED and sends nothing', async () => {
  const seen = stubGemini(img.geminiBackground);
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(drawImage({ provider: 'gemini', model: 'g', kind: 'background', prompt: 'p' }), (err) => {
    assert.ok(err instanceof AppError);
    assert.deepEqual([err.statusCode, err.code, err.message], [503, 'MENU_ART_GEMINI_NOT_CONFIGURED', 'Gemini is not set up.']);
    return true;
  });
  assert.equal(seen.length, 0);
});

// ---- errors ----

test('refusals from both providers normalize to MenuArtRefusal with a fixed reason', async () => {
  const quoted = 'Your request was rejected: it mentions Marisol at Larkspur Hall';
  stubOpenAI(throwing(Object.assign(new Error(quoted), { status: 400, code: 'moderation_blocked', error: { message: quoted } })));
  await assert.rejects(drawImage({ provider: 'openai', model: 'm', kind: 'background', prompt: 'p' }), (err) => {
    assert.ok(err instanceof MenuArtRefusal);
    assert.equal(err.reason, OPENAI_REFUSAL_REASON);
    assert.ok(!err.reason.includes('Marisol') && !err.message.includes('Marisol'));
    assert.equal(err.descriptor.provider, 'openai');
    assert.equal(err.descriptor.code, 'moderation_blocked');
    return true;
  });
  stubGemini(() => ({ id: 'int_safe', status: 'failed', errors: [{ code: 'IMAGE_SAFETY', message: 'blocked: Marisol' }], steps: [] }));
  await assert.rejects(drawImage({ provider: 'gemini', model: 'g', kind: 'drink', prompt: 'p' }), (err) => {
    assert.ok(err instanceof MenuArtRefusal);
    assert.equal(err.reason, 'Gemini blocked this image for safety.');
    assert.equal(err.descriptor.requestId, 'int_safe');
    return true;
  });
});

test('rate limits from both providers normalize to MenuArtRateLimited, capped at 60 and 20 when unsent', async () => {
  const limited = (retryAfter) => Object.assign(new Error('slow down'), {
    status: 429, headers: new globalThis.Headers(retryAfter ? { 'retry-after': retryAfter } : {}),
  });
  for (const [retryAfter, expected] of [['7', 7], ['300', 60], [null, 20]]) {
    stubOpenAI(throwing(limited(retryAfter)));
    await assert.rejects(drawImage({ provider: 'openai', model: 'm', kind: 'drink', prompt: 'p' }), (err) => {
      assert.ok(err instanceof MenuArtRateLimited);
      assert.equal(err.retryAfterSec, expected);
      assert.equal(err.descriptor.status, 429);
      return true;
    });
  }
  stubGemini(throwing(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 })));
  await assert.rejects(drawImage({ provider: 'gemini', model: 'g', kind: 'background', prompt: 'p' }), (err) => {
    assert.ok(err instanceof MenuArtRateLimited);
    assert.equal(err.retryAfterSec, 20);
    assert.equal(err.descriptor.provider, 'gemini');
    return true;
  });
});

test('other errors pass through with their descriptor', async () => {
  stubOpenAI(throwing(Object.assign(new Error('upstream exploded'), { status: 500 })));
  await assert.rejects(drawImage({ provider: 'openai', model: 'm', kind: 'background', prompt: 'p' }), (err) => {
    assert.ok(err instanceof ExternalServiceError);
    assert.ok(!(err instanceof MenuArtRefusal) && !(err instanceof MenuArtRateLimited));
    assert.equal(err.descriptor.status, 500);
    return true;
  });
  stubGemini(Buffer.from('not an image'));
  await assert.rejects(drawImage({ provider: 'gemini', model: 'g', kind: 'background', prompt: 'p' }), (err) => {
    assert.equal(err.name, 'MenuArtImageUnprocessable');
    assert.deepEqual(err.descriptor, { provider: 'gemini', errorClass: 'ImageUnprocessable', status: null, requestId: 'int_1', code: 'image_unprocessable' });
    return true;
  });
});

test('a missing or unknown provider or kind, or no model, throws and calls nothing', async () => {
  const openaiSeen = stubOpenAI(img.openaiDrink);
  const geminiSeen = stubGemini(img.geminiDrink);
  const base = { provider: 'openai', model: 'm', kind: 'drink', prompt: 'p' };
  for (const bad of [{ provider: undefined }, { provider: 'dalle' }, { kind: undefined }, { kind: 'logo' }, { model: '' }, { model: undefined }, { prompt: ' ' }]) {
    await assert.rejects(drawImage({ ...base, ...bad }), TypeError, JSON.stringify(bad));
  }
  await assert.rejects(drawImage(), TypeError);
  await assert.rejects(drawImage({ ...base, references: [{ buffer: 'x', mimeType: 'image/png' }] }), TypeError);
  await assert.rejects(drawImage({ ...base, references: [refOf(Buffer.from('nope'), 'image/png')] }), (err) => err.code === 'MENU_ART_REFERENCE_UNREADABLE');
  assert.equal(openaiSeen.length + geminiSeen.length, 0);
});
