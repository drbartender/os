require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { pool } = require('../db');

const router = require('./voicemailListen');

const HAS_DB = !!process.env.DATABASE_URL;
const dbTest = HAS_DB ? test : test.skip;

let _server = null;
let _baseUrl = null;

before(async () => {
  const app = express();
  app.use('/api/voice/vm', router);
  // Mirrors the real global handler (server/index.js): statusCode + code.
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'INTERNAL' });
  });
  await new Promise((resolve) => {
    _server = app.listen(0, () => {
      _baseUrl = `http://127.0.0.1:${_server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (_server) await new Promise((r) => _server.close(r));
  // Guarded like schema.vaCalling.test.js: without DATABASE_URL the dbTest is
  // skipped, so the teardown must not touch the pool either.
  if (!HAS_DB) return;
  await pool.query("DELETE FROM voicemail_delivery WHERE call_sid LIKE 'TEST_VM_listen%'");
  await pool.end();
});

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${path}`, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

const TOKEN = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const REC = 'RE' + 'a'.repeat(32);

let calls;
beforeEach(() => {
  calls = { queries: [], fetched: [] };
  delete process.env.VM_LISTEN_LINK_ENABLED;
  router.__setListenDeps({
    pool: {
      query: async (sql, params) => {
        calls.queries.push({ sql, params });
        if (params[0] === TOKEN) {
          return { rows: [{ recording_sid: REC, call_sid: 'CAlisten1' }] };
        }
        return { rows: [] };
      },
    },
    fetchRecordingMp3Once: async (sid) => { calls.fetched.push(sid); return Buffer.from('ID3audio'); },
    // listenLinkEnabled is deliberately NOT stubbed: the route must go through
    // the one definition in utils/voicemail.js, which is the whole point of the
    // two-sided switch. Stubbing it here would re-implement the thing under test.
  });
});

test('a valid token streams the recording as audio/mpeg', async () => {
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /audio\/mpeg/);
  assert.equal(res.body.toString(), 'ID3audio');
});

test('the recording SID comes from the ROW, never from the request', async () => {
  // THE security property. The URL carries only a token; the SID the fetch uses
  // must be the one the row returned, and the token must reach SQL as a bound
  // parameter rather than interpolated text.
  await get(`/api/voice/vm/${TOKEN}`);
  assert.deepEqual(calls.fetched, [REC]);
  assert.equal(calls.queries[0].params[0], TOKEN);
  assert.match(calls.queries[0].sql, /\$1/);
  assert.equal(calls.queries[0].params[1], '30 days', 'the age bound the route actually binds');
  assert.doesNotMatch(calls.queries[0].sql, new RegExp(TOKEN));
});

test('the response is uncacheable and unindexable', async () => {
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.match(res.headers['x-robots-tag'], /noindex/);
});

test('an unknown token 404s and fetches nothing', async () => {
  const res = await get(`/api/voice/vm/${OTHER}`);
  assert.equal(res.status, 404);
  assert.equal(calls.fetched.length, 0);
});

test('a non-UUID token 404s BEFORE any DB work', async () => {
  const res = await get('/api/voice/vm/not-a-uuid');
  assert.equal(res.status, 404);
  assert.equal(calls.queries.length, 0, 'requireUuidToken must run first (no 22P02)');
});

test('a row whose recording is gone at Twilio 404s, never 500s', async () => {
  router.__setListenDeps({
    fetchRecordingMp3Once: async () => { const e = new Error('gone'); e.status = 404; throw e; },
  });
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(res.status, 404);
});

test('a Twilio outage is a 502, not a 404 and not a crash', async () => {
  router.__setListenDeps({
    fetchRecordingMp3Once: async () => { const e = new Error('boom'); e.status = 503; throw e; },
  });
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(res.status, 502);
});

test('a DB failure is a 502, not a 404', async () => {
  router.__setListenDeps({ pool: { query: async () => { throw new Error('db down'); } } });
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(res.status, 502);
});

test('every 404 the route emits is byte-identical (no enumeration signal)', async () => {
  const unknown = await get(`/api/voice/vm/${OTHER}`);
  router.__setListenDeps({
    fetchRecordingMp3Once: async () => { const e = new Error('gone'); e.status = 404; throw e; },
  });
  const goneRec = await get(`/api/voice/vm/${TOKEN}`);
  process.env.VM_LISTEN_LINK_ENABLED = 'false';
  const switched = await get(`/api/voice/vm/${TOKEN}`);
  for (const other of [goneRec, switched]) {
    assert.equal(other.status, unknown.status);
    assert.equal(other.body.toString(), unknown.body.toString());
    assert.equal(other.headers['content-type'], unknown.headers['content-type']);
  }
});

test('the kill switch closes the route', async () => {
  process.env.VM_LISTEN_LINK_ENABLED = 'false';
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(res.status, 404);
  assert.equal(calls.fetched.length, 0);
});

test('the ETag is STRONG and covers the FULL body, on both the 200 and the 206', async () => {
  // Weak (`W/`) can never satisfy If-Range, which mandates strong comparison,
  // so iOS would discard its partial and refetch -- a second authenticated
  // Twilio media GET per playback. And a tag derived from the SLICE would
  // identify the wrong representation on a 206.
  const full = await get(`/api/voice/vm/${TOKEN}`);
  const part = await get(`/api/voice/vm/${TOKEN}`, { Range: 'bytes=0-1' });
  assert.doesNotMatch(full.headers.etag, /^W\//);
  assert.equal(full.headers.etag, '"vm-8-aaaaaaaa"', 'length + SID tail of the whole body');
  assert.equal(part.headers.etag, full.headers.etag, 'the 206 must carry the FULL body\'s validator');
});

test('a conditional Range request returns bytes, never a 304 carrying Content-Range', async () => {
  // res.send runs Express's freshness check and downgrades a 2xx to 304 when
  // If-None-Match matches. iOS sends If-None-Match alongside Range on the
  // second request of a playback, so this is the normal path, not a corner.
  const res = await get(`/api/voice/vm/${TOKEN}`, { Range: 'bytes=0-1', 'If-None-Match': '"vm-8-aaaaaaaa"' });
  assert.equal(res.status, 206);
  assert.equal(res.body.toString(), 'ID');
  assert.equal(res.headers['content-range'], 'bytes 0-1/8');
});

test('a Range probe gets a 206 slice, which is what iOS needs to play at all', async () => {
  const res = await get(`/api/voice/vm/${TOKEN}`, { Range: 'bytes=0-1' });
  assert.equal(res.status, 206);
  assert.equal(res.body.toString(), 'ID'); // first two bytes of 'ID3audio'
  assert.equal(res.headers['content-range'], 'bytes 0-1/8');
  assert.equal(res.headers['content-length'], '2');
  assert.match(res.headers['accept-ranges'], /bytes/);
});

test('an open-ended and a suffix Range both resolve correctly', async () => {
  const open = await get(`/api/voice/vm/${TOKEN}`, { Range: 'bytes=3-' });
  assert.equal(open.status, 206);
  assert.equal(open.body.toString(), 'audio');
  const suffix = await get(`/api/voice/vm/${TOKEN}`, { Range: 'bytes=-5' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.body.toString(), 'audio');
});

test('an unsatisfiable Range is a 416, not a crash or a full body', async () => {
  const res = await get(`/api/voice/vm/${TOKEN}`, { Range: 'bytes=999-' });
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], 'bytes */8');
});

test('a request with no Range still gets the whole body', async () => {
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'ID3audio');
  assert.equal(res.headers['content-length'], '8');
});

test('another origin cannot embed a client voice as a subresource', async () => {
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
});

// ── the SELECT itself, against the real column ──────────────────────────────
// The tests above stub `pool`, so they prove the handler's behavior but never
// that the SQL filters. Run the route's EXPORTED statement against real rows so
// the predicates cannot drift from what the route actually executes.

dbTest('LOOKUP_SQL finds a primary row and rejects zul, NULL-recording, and unknown', async () => {
  await pool.query(
    `INSERT INTO voicemail_delivery (call_sid, line, recording_sid, status)
     VALUES ('TEST_VM_listen_p', 'primary', $1, 'delivered'),
            ('TEST_VM_listen_z', 'zul',     $1, 'delivered'),
            ('TEST_VM_listen_n', 'primary', NULL, 'missed')
     ON CONFLICT (call_sid) DO NOTHING`,
    [REC]
  );
  const tokens = {};
  for (const cs of ['TEST_VM_listen_p', 'TEST_VM_listen_z', 'TEST_VM_listen_n']) {
    const { rows } = await pool.query('SELECT listen_token FROM voicemail_delivery WHERE call_sid = $1', [cs]);
    tokens[cs] = rows[0].listen_token;
  }
  const run = async (t) => (await pool.query(router.LOOKUP_SQL, [t, router.LISTEN_LINK_MAX_AGE])).rows;

  assert.equal((await run(tokens.TEST_VM_listen_p)).length, 1, 'primary row with audio is found');
  assert.equal((await run(tokens.TEST_VM_listen_z)).length, 0, "zul's audio was deleted after the Telegram upload");
  assert.equal((await run(tokens.TEST_VM_listen_n)).length, 0, 'no recording, nothing to stream');
  assert.equal((await run(OTHER)).length, 0, 'unknown token');
});

dbTest('LOOKUP_SQL expires a link older than the max age, independent of the row prune', async () => {
  // The prune RETAINS 'recorded'/'failed' rows past retention, so a token on one
  // would never expire if the route borrowed the prune's bound instead of owning one.
  await pool.query(
    `INSERT INTO voicemail_delivery (call_sid, line, recording_sid, status)
     VALUES ('TEST_VM_listen_old', 'primary', $1, 'recorded')
     ON CONFLICT (call_sid) DO NOTHING`,
    [REC]
  );
  const { rows } = await pool.query(
    `UPDATE voicemail_delivery SET created_at = NOW() - INTERVAL '31 days'
      WHERE call_sid = 'TEST_VM_listen_old' RETURNING listen_token`
  );
  const found = await pool.query(router.LOOKUP_SQL, [rows[0].listen_token, router.LISTEN_LINK_MAX_AGE]);
  assert.equal(found.rows.length, 0, 'a 31-day-old link is dead even though its row survives the prune');
});
