const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scrubUrl, scrubErrorEvent, scrubTransactionEvent, SPAN_URL_KEYS } = require('./sentryScrub');

const TOKEN = '11111111-2222-4333-8444-555555555555';
const URL_WITH_TOKEN = `https://api.drbartender.com/api/voice/vm/${TOKEN}`;

test('scrubUrl redacts every public token shape it knows', () => {
  assert.equal(scrubUrl(URL_WITH_TOKEN), 'https://api.drbartender.com/api/voice/vm/[redacted]');
  assert.equal(scrubUrl('/t/abc123'), '/t/[redacted]');
  assert.equal(scrubUrl('/tip/abc123'), '/tip/[redacted]');
  assert.equal(scrubUrl('/unsubscribe/abc'), '/unsubscribe/[redacted]');
  assert.equal(scrubUrl('/reset-password/abc'), '/reset-password/[redacted]');
  assert.equal(scrubUrl('/x?token=secret&a=1'), '/x?token=[redacted]&a=1');
  assert.equal(scrubUrl(''), '');
  assert.equal(scrubUrl(undefined), undefined);
});

test('an ERROR event is scrubbed on url, route tag, body, and headers', () => {
  const event = scrubErrorEvent({
    request: { url: URL_WITH_TOKEN, data: { secret: 1 }, headers: { authorization: 'x' }, query_string: 'token=abc' },
    tags: { route: `/api/voice/vm/${TOKEN}` },
  });
  assert.doesNotMatch(JSON.stringify(event), new RegExp(TOKEN));
  assert.equal(event.request.data, '[redacted]');
  assert.equal(event.request.headers, undefined);
});

test('a TRANSACTION event is scrubbed in span data, not just the request block', () => {
  // The leak that shipped: beforeSend is ERROR-only, and a transaction carries
  // the URL in OpenTelemetry span attributes that land in contexts.trace.data,
  // which the Sentry performance UI renders by default.
  const event = scrubTransactionEvent({
    transaction: `GET /api/voice/vm/${TOKEN}`,
    request: { url: URL_WITH_TOKEN, headers: { cookie: 'x' } },
    contexts: {
      trace: {
        data: {
          'http.url': URL_WITH_TOKEN,
          'http.target': `/api/voice/vm/${TOKEN}`,
          'url.full': URL_WITH_TOKEN,
          'http.method': 'GET',
        },
      },
    },
    spans: [{ data: { 'http.url': URL_WITH_TOKEN } }],
  });
  assert.doesNotMatch(JSON.stringify(event), new RegExp(TOKEN),
    'no field of a sampled transaction may carry a live listen token');
  // Non-URL attributes survive untouched.
  assert.equal(event.contexts.trace.data['http.method'], 'GET');
  assert.equal(event.request.headers, undefined);
});

test('the transaction NAME is scrubbed, because an unmatched route keeps the raw path', () => {
  // Express rewrites the span name to the :token pattern only once it resolves a
  // route; a 404 or a rate-limited request keeps the raw URL as the name.
  const event = scrubTransactionEvent({ transaction: `GET /api/voice/vm/${TOKEN}` });
  assert.equal(event.transaction, 'GET /api/voice/vm/[redacted]');
});

test('scrubbing tolerates the shapes Sentry actually sends, and RETURNS the event', () => {
  // The return value is load-bearing in a way that is easy to break: Sentry
  // treats an undefined return as "discard this event", so a refactor that
  // drops `return event` would silently throw away 100% of error AND
  // performance telemetry with the suite still green.
  assert.ok(scrubTransactionEvent({}));
  assert.ok(scrubErrorEvent({}));
  assert.ok(scrubTransactionEvent({ contexts: {} }));
  assert.ok(scrubTransactionEvent({ spans: [{}] }));
});

test('a TRANSACTION redacts the request body and cookies, same as an error', () => {
  // The Node SDK captures a body on every instrumented request, so with
  // transactions sampled this was shipping plaintext passwords to Sentry.
  const event = scrubTransactionEvent({
    request: { data: { email: 'a@b.c', password: 'hunter2' }, cookies: { session: 'abc' } },
  });
  assert.equal(event.request.data, '[redacted]');
  assert.equal(event.request.cookies, undefined);
  assert.doesNotMatch(JSON.stringify(event), /hunter2|session/);
});

test('span data is scrubbed BY VALUE, so an unknown attribute key cannot leak', () => {
  // This is the regression that shipped twice. The hand-built fixtures above
  // were written from the same mental model as the code, so they only ever
  // contained the keys the code already knew. Sentry's OTel bridge
  // (getRequestSpanData) derives a BARE `url` key plus `http.query` and
  // `http.fragment` from url.full, and none were in the allowlist.
  const event = scrubTransactionEvent({
    contexts: { trace: { data: {
      url: URL_WITH_TOKEN,                       // bare `url`, the live leak
      'http.query': `token=${TOKEN}&x=1`,        // no leading '?' in some versions
      'http.fragment': `#/t/${TOKEN}`,
      'some.future.sdk.key': URL_WITH_TOKEN,     // a key nobody has invented yet
      'http.request.header.cookie': 'sid=abc',   // re-carries what scrubRequest deletes
      'http.method': 'GET',
      'db.system': 'postgresql',
      'http.status_code': 200,
    } } },
  });
  const data = event.contexts.trace.data;
  assert.doesNotMatch(JSON.stringify(event), new RegExp(TOKEN));
  assert.equal(data['http.query'], 'token=[redacted]&x=1');
  assert.equal(data['http.request.header.cookie'], undefined);
  // Unrelated attributes survive untouched, including non-strings.
  assert.equal(data['http.method'], 'GET');
  assert.equal(data['db.system'], 'postgresql');
  assert.equal(data['http.status_code'], 200);
});

test('SPAN_URL_KEYS is documentation and stays a subset of what is scrubbed', () => {
  // The list no longer gates anything, so its job is to name the keys a reader
  // should expect. Each one must still actually be scrubbed.
  for (const key of SPAN_URL_KEYS) {
    const event = scrubTransactionEvent({ contexts: { trace: { data: { [key]: URL_WITH_TOKEN } } } });
    assert.doesNotMatch(JSON.stringify(event), new RegExp(TOKEN), `${key} leaked`);
  }
});

test('the ERROR pipeline scrubs the transaction name too (symmetry with transactions)', () => {
  const event = scrubErrorEvent({ transaction: `GET /api/voice/vm/${TOKEN}` });
  assert.equal(event.transaction, 'GET /api/voice/vm/[redacted]');
});

test('an unscrubbable attributes container fails CLOSED, and the hook still returns', () => {
  // Reading every key means touching objects we did not author. A frozen one
  // used to fail SILENTLY (sloppy-mode assignment), shipping the token; a
  // throwing getter escapes the hook, and Sentry DISCARDS an event whose hook
  // throws. Both must end as "no attributes" rather than "token" or "nothing".
  const frozen = scrubTransactionEvent({
    contexts: { trace: { data: Object.freeze({ url: URL_WITH_TOKEN }) } },
  });
  assert.doesNotMatch(JSON.stringify(frozen), new RegExp(TOKEN));
  assert.deepEqual(frozen.contexts.trace.data, { 'sentry.scrub_failed': true });

  const hostile = {};
  Object.defineProperty(hostile, 'url', { enumerable: true, get() { throw new Error('boom'); } });
  const thrown = scrubTransactionEvent({ spans: [{ data: hostile }] });
  assert.ok(thrown, 'a hook returning undefined discards the event');
  assert.deepEqual(thrown.spans[0].data, { 'sentry.scrub_failed': true });
});

test('breadcrumbs are scrubbed on BOTH pipelines', () => {
  // Unreachable for the listen token today, which is exactly why it is pinned:
  // one console.log of a link would otherwise ship it with nothing to catch it.
  for (const scrub of [scrubErrorEvent, scrubTransactionEvent]) {
    const event = scrub({
      breadcrumbs: [
        { message: `fetching ${URL_WITH_TOKEN}` },
        { data: { url: URL_WITH_TOKEN } },
        { category: 'console' },
      ],
    });
    assert.doesNotMatch(JSON.stringify(event), new RegExp(TOKEN), `${scrub.name} leaked a breadcrumb`);
  }
});

test('a console breadcrumb hides the URL one container deep, in data.arguments', () => {
  // The console integration builds data.arguments as an ARRAY of the logged
  // values, so a typeof==='string' test cannot see it. This is the exact case
  // the breadcrumb sweep was added for, and the sweep originally missed it.
  const event = scrubErrorEvent({
    breadcrumbs: [{ category: 'console', message: `link: ${URL_WITH_TOKEN}`,
                    data: { arguments: [`link: ${URL_WITH_TOKEN}`, { u: URL_WITH_TOKEN }], logger: 'console' } }],
  });
  assert.doesNotMatch(JSON.stringify(event), new RegExp(TOKEN));
  assert.equal(event.breadcrumbs[0].data.logger, 'console', 'non-URL values survive');
});

test('the Twilio Account SID is redacted; the Recording SID is not', () => {
  // The Account SID is the basic-auth USERNAME on our media fetch, so it is
  // half a credential pair riding in outgoing-request URLs (fix-list 16). The
  // Recording SID is useless without the pair and is what makes a trace
  // debuggable, so it deliberately stays.
  const url = `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${'b'.repeat(32)}.mp3`;
  const out = scrubUrl(url);
  assert.doesNotMatch(out, /AC[0-9a-f]{32}/i);
  assert.match(out, new RegExp(`RE${'b'.repeat(32)}`));
});

test('a fail-closed scrub tags the event so it is findable in Sentry', () => {
  const event = scrubTransactionEvent({ contexts: { trace: { data: Object.freeze({ url: URL_WITH_TOKEN }) } } });
  assert.equal(event.tags.scrub_failed, 'true');
  assert.doesNotMatch(JSON.stringify(event), new RegExp(TOKEN));
});

test('the value walk survives shapes it did not author, and stays cheap', () => {
  // These reach the walk through breadcrumbs (console.log of anything) and are
  // not ours to assume about. A cycle must terminate, a Buffer must not be
  // enumerated byte-by-byte, and Date/class instances must come out intact.
  const cyc = { a: 1 }; cyc.self = cyc;
  const started = process.hrtime.bigint();
  const event = scrubTransactionEvent({
    contexts: { trace: { data: {
      buf: Buffer.alloc(200_000),
      when: new Date(0),
      cyc,
      nested: { deep: { deeper: { deepest: URL_WITH_TOKEN } } },
    } } },
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const d = event.contexts.trace.data;
  assert.ok(Buffer.isBuffer(d.buf) && d.buf.length === 200_000, 'the Buffer must come out whole');
  assert.ok(d.when instanceof Date);
  assert.doesNotMatch(JSON.stringify(d.nested), new RegExp(TOKEN), 'depth must not shelter a string');
  assert.ok(ms < 25, `scrub took ${ms}ms; this hook runs on every event`);
});

test('a frozen bag with nothing to redact is KEPT, not discarded', () => {
  // Fail-closed must cost something only when there was something to redact.
  // Strict mode throws on any write to a non-writable property, even one
  // writing back an identical value, so without the no-op-write guard a frozen
  // sub-object of plain numbers destroyed the entire attribute bag.
  const clean = scrubTransactionEvent({
    contexts: { trace: { data: { keep: 'important', f: Object.freeze({ n: 42, plain: 'no url here' }) } } },
  });
  assert.equal(clean.contexts.trace.data.keep, 'important');
  assert.equal(clean.contexts.trace.data.f.n, 42);
  assert.equal(clean.tags?.scrub_failed, undefined, 'nothing failed, so nothing to flag');

  const dirty = scrubTransactionEvent({
    contexts: { trace: { data: { f: Object.freeze({ u: URL_WITH_TOKEN }) } } },
  });
  assert.doesNotMatch(JSON.stringify(dirty), new RegExp(TOKEN), 'still fails CLOSED when it matters');
  assert.equal(dirty.tags.scrub_failed, 'true');
});

test('the Account SID pattern cannot chew into a long hex digest', () => {
  // Unanchored, any internal `ac` with 32 hex chars after it starts a match and
  // eats 34 characters -- measured at 11.5% of random SHA-256 digests.
  const sha = 'ac' + 'b'.repeat(62);
  assert.equal(scrubUrl(`/x?h=${sha}`), `/x?h=${sha}`, 'a 64-char digest must survive intact');
  assert.equal(scrubUrl(`/Accounts/AC${'a'.repeat(32)}/x`), '/Accounts/[redacted-account-sid]/x');
});

test('a span description carrying a URL is scrubbed too', () => {
  const event = scrubTransactionEvent({
    spans: [{ description: `GET /api/voice/vm/${TOKEN}` }],
  });
  assert.equal(event.spans[0].description, 'GET /api/voice/vm/[redacted]');
});
