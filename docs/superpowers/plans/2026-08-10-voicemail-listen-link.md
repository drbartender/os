# Voicemail Listen Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a tappable link in the primary-line voicemail alert SMS that plays the recording, so the text carries the message instead of only announcing it.

**Architecture:** Every `voicemail_delivery` row is born with a UUID `listen_token` (column DEFAULT, no application code). A new small router streams the mp3 for a token by looking the RECORDING SID up from the row and fetching it server-side with the account credentials, so neither the Twilio URL nor the credentials ever reach the client. The alert body gains one line. No R2, no transcription, no HTML page: Phase 1a already retains the primary recording in Twilio, which is the only reason this is small.

**Tech Stack:** Node.js 26 / Express 4, Postgres (raw SQL via `pg`), Twilio REST (media fetch), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-10-voicemail-listen-link-design.md` (approved 2026-08-10)

## Global Constraints

- **No em dashes** in any copy, comment prose, or SMS text. Commas, periods, colons, parentheticals only.
- **The recording SID comes from the ROW, never from the request.** This is the property that separates a listen link from an open proxy into the Twilio account. No route may accept a recording SID, a media URL, or an account SID as input.
- The Twilio media URL and `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` never appear in a response body, a redirect, or a client-visible error.
- **All 404s on this route are byte-identical**, so an attacker cannot distinguish "no such token" from "that row is Zul's" from "the recording is gone." No response body detail, no differing status codes.
- All SQL parameterized (`$1`). Schema statements idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`).
- Logs use the existing last-4 redaction idiom (`String(x).slice(-4)`). No token, caller number, or media URL is ever logged in full.
- **Schema is applied by `initDb()`** in `server/db/index.js` on boot. There is no `applySchema.js`.
- **Server suites run ONE AT A TIME against the shared dev DB**, from the repo root: `node -r dotenv/config --test <file>`.
- **File-size discipline:** `server/routes/voice.js` is at exactly 700 lines, its soft cap. Nothing in this plan may be added to it. The new route gets its own file.
- Money is not touched. No pricing, invoice, or payout surface is in scope.

## Lane map

```yaml
lanes:
  - id: vm-listen-link
    footprint:
      - server/db/schema.sql
      - server/db/schema.vaCalling.test.js
      - server/routes/voicemailListen.js
      - server/routes/voicemailListen.test.js
      - server/utils/voicemail.js
      - server/utils/voicemail.test.js
      - server/routes/voice.js
      - server/routes/voice.test.js
      - server/utils/vaCallingScheduler.js
      - server/utils/vaCallingScheduler.test.js
      - server/index.js
      - scripts/sensitive-paths.txt
      - .env.example
      - .claude/CLAUDE.md
      - README.md
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [security-review, database-review, code-review, consistency-check]
```

**One lane.** Three tasks that are strictly sequential (the column must exist before the route reads it; the route must exist before the SMS links to it), and all three land in the same two files' orbit.

**Full review fleet regardless of size:** this adds a PUBLIC route that serves a client's recorded voice, and it touches `server/utils/voicemail.js`, already on `scripts/sensitive-paths.txt`. `/second-opinion` runs alongside the fleet at push.

**Task order:** 1 → 2 → 3. Strictly sequential.

---

## Task 1: The token column

**Files:**
- Modify: `server/db/schema.sql` (append after the `idx_voicemail_delivery_escalated_at` index at line 3740-3741, before the "Proposal option groups" divider)
- Modify: `server/db/schema.vaCalling.test.js`

**Interfaces:**
- Produces: `voicemail_delivery.listen_token` (UUID, NOT NULL, DEFAULT `gen_random_uuid()`, UNIQUE). Every row, including every row that already exists, carries one.

- [ ] **Step 1: Add the column to `server/db/schema.sql`**

Append directly after the `idx_voicemail_delivery_escalated_at` index:

```sql
-- Listen link (spec 2026-08-10). The alert SMS carries only the caller's number,
-- so the message CONTENT is unreachable without opening the Twilio console. This
-- token is the public handle for the retained recording: GET /api/voice/vm/:token
-- streams it. UUID (not a sequential id) because the token IS the auth, the same
-- model proposals and invoices use.
--
-- DEFAULT gen_random_uuid() is also the backfill: every existing row gets a token
-- the moment the column is added, so nothing generates one in application code and
-- no separate UPDATE is needed. Built into Postgres 13+; prod is 17.
ALTER TABLE voicemail_delivery
  ADD COLUMN IF NOT EXISTS listen_token UUID NOT NULL DEFAULT gen_random_uuid();
-- UNIQUE because the token is a lookup key on a public route: a duplicate would
-- make one URL ambiguous between two clients' recordings.
CREATE UNIQUE INDEX IF NOT EXISTS uq_voicemail_delivery_listen_token
  ON voicemail_delivery (listen_token);
```

- [ ] **Step 2: Apply the schema to the dev DB**

Run: `node -r dotenv/config -e "require('./server/db').initDb().then(() => process.exit(0))"`
Expected: exits 0. Statements are idempotent, so a re-run is safe.

Verify the column and the backfill:
Run: `psql "$DATABASE_URL" -c "SELECT COUNT(*) AS rows, COUNT(listen_token) AS tokens, COUNT(DISTINCT listen_token) AS distinct_tokens FROM voicemail_delivery"`
Expected: all three counts equal. Every pre-existing row got a token and no two share one.

- [ ] **Step 3: Extend `server/db/schema.vaCalling.test.js`**

That suite slices `schema.sql` from the `-- Zul VA Calling` marker to EOF via `vaCallingDdl()` and applies it in `before()`, so this DDL is inside its scope. Use `dbTest` (not bare `test`) for anything touching the DB: `pool` is only assigned when `DATABASE_URL` is set.

Add beside the other voicemail_delivery assertions:

```js
test('voicemail_delivery carries the listen_token idempotently', () => {
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS listen_token UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
  assert.match(schemaSql, /uq_voicemail_delivery_listen_token/);
});

dbTest('listen_token is NOT NULL, defaulted, and unique', async () => {
  const { rows } = await pool.query(
    `SELECT is_nullable, column_default, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'voicemail_delivery'
        AND column_name = 'listen_token'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_nullable, 'NO');
  assert.equal(rows[0].data_type, 'uuid');
  assert.match(rows[0].column_default, /gen_random_uuid/);

  const { rows: idx } = await pool.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'uq_voicemail_delivery_listen_token'`
  );
  assert.equal(idx.length, 1);
  assert.match(idx[0].indexdef, /UNIQUE/);
});

dbTest('a new row is born with a token nobody had to generate', async () => {
  await pool.query(
    `INSERT INTO voicemail_delivery (call_sid, line) VALUES ('TEST_VM_token1', 'primary')`
  );
  const { rows } = await pool.query(
    `SELECT listen_token FROM voicemail_delivery WHERE call_sid = 'TEST_VM_token1'`
  );
  assert.match(rows[0].listen_token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
```

The `TEST_VM_` prefix is deliberate: the suite's `after()` cleans on `call_sid LIKE 'TEST_VM_%'`, so this row cannot survive on the shared dev DB.

- [ ] **Step 4: Run the suite**

Run: `node -r dotenv/config --test server/db/schema.vaCalling.test.js`
Expected: PASS, including every pre-existing assertion.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql server/db/schema.vaCalling.test.js
git commit -m "feat(voicemail): listen_token column, defaulted and unique"
```

---

## Task 2: The streaming route

**Files:**
- Create: `server/routes/voicemailListen.js`
- Create: `server/routes/voicemailListen.test.js`
- Modify: `server/utils/voicemail.js` (add `fetchRecordingMp3Once`, export it)
- Modify: `server/utils/voicemail.test.js`
- Modify: `server/index.js:397-399` (mount)
- Modify: `scripts/sensitive-paths.txt`

**Interfaces:**
- Consumes: `requireUuidToken` from `server/utils/tokens.js`; `pool` from `server/db`.
- Produces: `GET /api/voice/vm/:token`; `voicemail.fetchRecordingMp3Once(recordingSid) => Promise<Buffer>`; `router.__setListenDeps(overrides)` for tests.

- [ ] **Step 1: Add a no-retry media fetch to `server/utils/voicemail.js`**

`fetchRecordingMp3` retries a 404 three times with backoff, which is right for the delivery pipeline (the recording is occasionally not fetchable for a beat after the callback) and wrong here: a human is waiting on this HTTP response, and a missing recording is an answer, not a transient. Add beside it:

```js
/**
 * Single-shot media fetch for the listen route. Same constructed URL and basic
 * auth as fetchRecordingMp3, but NO retry: a person is waiting on this response,
 * and "the recording is gone" is a final answer, not a transient. Throws with a
 * `.status` so the caller can map 404 to a clean 404 and everything else to 502.
 */
async function fetchRecordingMp3Once(recordingSid) {
  const url = recordingMediaUrl(recordingSid);
  const auth = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');
  const res = await _deps.fetch(url, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`recording fetch failed (${res.status}) sid=...${String(recordingSid).slice(-4)}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}
```

Add `fetchRecordingMp3Once` to the `module.exports` object.

- [ ] **Step 2: Write its failing test**

Add to `server/utils/voicemail.test.js`:

```js
test('fetchRecordingMp3Once does NOT retry and surfaces the status', async () => {
  let calls = 0;
  vm.__setVoicemailDeps({
    fetch: async () => { calls += 1; return { ok: false, status: 404 }; },
  });
  await assert.rejects(
    () => vm.fetchRecordingMp3Once(GOOD_SID),
    (err) => err.status === 404
  );
  assert.equal(calls, 1, 'a person is waiting; one attempt only');
});

test('fetchRecordingMp3Once returns the bytes on success', async () => {
  vm.__setVoicemailDeps({
    fetch: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('ID3listen') }),
  });
  const buf = await vm.fetchRecordingMp3Once(GOOD_SID);
  assert.equal(buf.toString(), 'ID3listen');
});
```

- [ ] **Step 3: Run to confirm it fails, then passes**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected FIRST: FAIL, `vm.fetchRecordingMp3Once is not a function`. After Step 1's code is in place: PASS.

- [ ] **Step 4: Write the failing route test**

Create `server/routes/voicemailListen.test.js`:

```js
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const router = require('./voicemailListen');

let _server = null;
let _baseUrl = null;

before(async () => {
  const app = express();
  app.use('/api/voice/vm', router);
  // Mirror the app's error middleware shape: AppError carries .statusCode.
  app.use((err, req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  await new Promise((resolve) => {
    _server = app.listen(0, () => {
      _baseUrl = `http://127.0.0.1:${_server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (_server) await new Promise((r) => _server.close(r)); });

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${path}`, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
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
          return { rows: [{ recording_sid: REC, line: 'primary', call_sid: 'CAlisten1' }] };
        }
        return { rows: [] };
      },
    },
    fetchRecordingMp3Once: async (sid) => { calls.fetched.push(sid); return Buffer.from('ID3audio'); },
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
  // must be the one the row returned.
  await get(`/api/voice/vm/${TOKEN}`);
  assert.deepEqual(calls.fetched, [REC]);
  // And the token reached the query as a bound parameter, not interpolated.
  assert.equal(calls.queries[0].params[0], TOKEN);
  assert.match(calls.queries[0].sql, /\$1/);
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

test('every 404 is byte-identical (no enumeration signal)', async () => {
  const unknown = await get(`/api/voice/vm/${OTHER}`);
  router.__setListenDeps({
    fetchRecordingMp3Once: async () => { const e = new Error('gone'); e.status = 404; throw e; },
  });
  const goneRec = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(unknown.status, goneRec.status);
  assert.equal(unknown.body.toString(), goneRec.body.toString());
});

test('the kill switch closes the route', async () => {
  process.env.VM_LISTEN_LINK_ENABLED = 'false';
  const res = await get(`/api/voice/vm/${TOKEN}`);
  assert.equal(res.status, 404);
  assert.equal(calls.fetched.length, 0);
});

test('the row query is scoped to primary rows carrying a recording', async () => {
  // Zul's rows keep a recording_sid whose audio was deleted after the Telegram
  // upload, so they must be excluded in SQL rather than left to fail at Twilio.
  await get(`/api/voice/vm/${TOKEN}`);
  assert.match(calls.queries[0].sql, /line = 'primary'/);
  assert.match(calls.queries[0].sql, /recording_sid IS NOT NULL/);
});
```

- [ ] **Step 5: Run to confirm it fails**

Run: `node -r dotenv/config --test server/routes/voicemailListen.test.js`
Expected: FAIL, `Cannot find module './voicemailListen'`.

- [ ] **Step 6: Write `server/routes/voicemailListen.js`**

```js
// server/routes/voicemailListen.js
//
// The voicemail listen link (spec 2026-08-10). The primary line's alert SMS
// carries only the caller's number, so without this the message CONTENT is
// unreachable without opening the Twilio console. GET /api/voice/vm/:token
// streams the retained recording so tapping the link in the text plays it.
//
// Its own router file, mounted at /api/voice/vm ahead of /api/voice, the shape
// voiceLeadCall.js and voiceEscalate.js already use. server/routes/voice.js sits
// at exactly its 700-line soft cap and this concern is separately reviewable.
//
// SECURITY: the token is the ONLY input. The recording SID is read from the row
// and never accepted from the request, which is the line between a listen link
// and an open proxy into our Twilio account. The media URL and the account
// credentials are used server-side and never appear in a response.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireUuidToken } = require('../utils/tokens');
const voicemail = require('../utils/voicemail');

const router = express.Router();

let _deps = {
  pool,
  fetchRecordingMp3Once: (...a) => voicemail.fetchRecordingMp3Once(...a),
};
function __setListenDeps(d) { _deps = { ..._deps, ...d }; }
router.__setListenDeps = __setListenDeps;

/** Kill switch. Default ON: this is the feature. Off closes the route without a
 *  redeploy, which is the house pattern for anything serving client PII. */
function listenLinkEnabled() {
  return process.env.VM_LISTEN_LINK_ENABLED !== 'false';
}

// Per-IP cap. Unlike the voice webhooks there is no live caller on this path, so
// a bare 429 is correct here. The real anti-enumeration control is the 122-bit
// token; this only blunts a scripted sweep.
const listenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: false,
  legacyHeaders: false,
});

/** One 404 for every miss: unknown token, wrong line, recording gone, switch off.
 *  Byte-identical so nothing distinguishes them to a prober. */
function notFound(res) {
  res.status(404).type('text/plain').send('Not found');
}

/**
 * GET /api/voice/vm/:token — stream the recording for this token.
 *
 * requireUuidToken runs FIRST so a non-UUID param 404s before touching the DB
 * (a UUID column casts-and-throws 22P02 on junk, which would surface as a 500).
 */
router.get('/:token', listenLimiter, requireUuidToken('token'), async (req, res) => {
  if (!listenLinkEnabled()) return notFound(res);

  let row;
  try {
    const { rows } = await _deps.pool.query(
      `SELECT call_sid, recording_sid, line
         FROM voicemail_delivery
        WHERE listen_token = $1
          AND line = 'primary'
          AND recording_sid IS NOT NULL`,
      [req.params.token]
    );
    row = rows[0];
  } catch (err) {
    console.error(`[vm-listen] lookup failed: ${err.message}`);
    return res.status(502).type('text/plain').send('Unavailable');
  }
  if (!row) return notFound(res);

  const tail = `sid=...${String(row.call_sid || '').slice(-4)}`;
  let audio;
  try {
    audio = await _deps.fetchRecordingMp3Once(row.recording_sid);
  } catch (err) {
    // 404 at Twilio means the audio is genuinely gone (deleted, or aged out).
    // Anything else is our problem, not the listener's, and must not masquerade
    // as "no such voicemail".
    if (err.status === 404) {
      console.warn(`[vm-listen] recording gone ${tail}`);
      return notFound(res);
    }
    console.error(`[vm-listen] media fetch failed ${tail}: ${err.message}`);
    return res.status(502).type('text/plain').send('Unavailable');
  }

  console.log(`[vm-listen] served ${tail} bytes=${audio.length}`);
  res.set({
    'Content-Type': 'audio/mpeg',
    'Content-Length': String(audio.length),
    'Content-Disposition': 'inline; filename="voicemail.mp3"',
    // Never cached by an intermediary, never crawled: this is a client's voice.
    'Cache-Control': 'no-store, private',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.send(audio);
});

module.exports = router;
```

- [ ] **Step 7: Run to confirm the route tests pass**

Run: `node -r dotenv/config --test server/routes/voicemailListen.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 8: Mount it in `server/index.js`**

Change the three voice mounts (`server/index.js:397-399`) to four. Order matters: the more specific mounts come first.

```js
app.use('/api/voice/lead', require('./routes/voiceLeadCall')); // more specific mount first
app.use('/api/voice/escalate', require('./routes/voiceEscalate')); // ditto, before /api/voice
app.use('/api/voice/vm', require('./routes/voicemailListen')); // ditto
app.use('/api/voice', require('./routes/voice'));
```

Run: `node -e "require('./server/routes/voicemailListen'); console.log('router loads')"`
Expected: prints `router loads`.

- [ ] **Step 9: Register the new file as sensitive**

In `scripts/sensitive-paths.txt`, add to the Phase 1a voice block:

```
server/routes/voicemailListen.js
```

Run: `node scripts/sensitive-match.js server/routes/voicemailListen.js`
Expected: before the edit, exit 1 and no output. After, exit 0 and the path printed.

- [ ] **Step 10: Commit**

```bash
git add server/routes/voicemailListen.js server/routes/voicemailListen.test.js \
        server/utils/voicemail.js server/utils/voicemail.test.js \
        server/index.js scripts/sensitive-paths.txt
git commit -m "feat(voicemail): token-gated listen route streaming the retained recording"
```

---

## Task 3: The link in the alert

**Files:**
- Modify: `server/utils/voicemail.js` (`primaryAlertText`, and its one call site)
- Modify: `server/utils/voicemail.test.js`

**Interfaces:**
- Consumes: `API_URL` from `server/utils/urls.js`; `listen_token` (Task 1); the route (Task 2).
- Produces: `primaryAlertText({ fromE164, durationSec, redelivered, listenToken })` — the token is optional, and an absent one omits the line rather than emitting a broken URL.

- [ ] **Step 1: Write the failing tests**

Add to `server/utils/voicemail.test.js`:

```js
test('primaryAlertText appends the listen link when a token is present', () => {
  const body = vm.primaryAlertText({
    fromE164: '+13125550147', durationSec: 9,
    listenToken: '11111111-2222-4333-8444-555555555555',
  });
  assert.match(body, /\/api\/voice\/vm\/11111111-2222-4333-8444-555555555555$/,
    'the link is the LAST line, so it stays tappable in a phone client');
  assert.match(body, /\+13125550147/);
});

test('primaryAlertText omits the link rather than emitting a broken one', () => {
  const body = vm.primaryAlertText({ fromE164: '+13125550147', durationSec: 9 });
  assert.doesNotMatch(body, /\/api\/voice\/vm/);
  assert.doesNotMatch(body, /undefined|null/);
});

test('the delivered alert carries the row\'s own token', async () => {
  const sent = { sms: [] };
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(60), fromE164: '+13125550147', line: 'primary' });
  const { rows } = await pool.query(
    'SELECT listen_token FROM voicemail_delivery WHERE call_sid = $1', [sid(60)]
  );
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: removeSpy().client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SM9' }; },
  });
  await vm.deliverVoicemail({
    callSid: sid(60), recordingSid: 'RE' + '9'.repeat(32), durationSec: 6,
    fromE164: '+13125550147', chatId: null, line: 'primary',
  });
  assert.equal(sent.sms.length, 1);
  assert.match(sent.sms[0].body, new RegExp(`/api/voice/vm/${rows[0].listen_token}$`),
    'the alert must link to THIS row, not a fresh or hardcoded token');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: FAIL. `primaryAlertText` ignores `listenToken`, so no link is emitted.

- [ ] **Step 3: Add the link to `primaryAlertText`**

Replace the function:

```js
function primaryAlertText({ fromE164, durationSec, redelivered = false, listenToken = null }) {
  const who = fromE164 || 'a withheld number';
  const secs = Number.isFinite(durationSec) ? `${durationSec}s` : 'unknown length';
  const redo = redelivered ? ' (redelivered)' : '';
  // The link goes LAST so phone clients linkify it cleanly, and it is omitted
  // rather than half-built when a token is missing: a broken URL in an alert is
  // worse than no URL, because it reads as a bug in the voicemail itself.
  const listen = listenToken ? `\n${API_URL}/api/voice/vm/${listenToken}` : '';
  return `New voicemail on the business line (${secs})${redo}, ${chicagoStamp()}.\n${who}${listen}`;
}
```

Add `API_URL` to the requires at the top of `server/utils/voicemail.js`:

```js
const { API_URL } = require('./urls');
```

- [ ] **Step 4: Read the token back with the delivery claim**

`claimDelivery` already returns the row's `from_e164` and `line` in one round trip; the token rides along the same way. In `server/utils/voicemail.js`, extend its `RETURNING` clause and return value:

```js
      RETURNING from_e164, line, listen_token`,
```

```js
  return rows.length > 0
    ? { fromE164: rows[0].from_e164, line: rows[0].line, listenToken: rows[0].listen_token }
    : null;
```

Update its JSDoc `@returns` to `Promise<{fromE164: string|null, line: 'primary'|'zul', listenToken: string}|null>`.

- [ ] **Step 5: Thread the token to the alert**

`deliverVoicemail` gains `listenToken` in its destructure, defaulting to null so an
older caller omits the line rather than crashing:

```js
async function deliverVoicemail({ callSid, recordingSid, durationSec, fromE164, chatId, line = 'zul', listenToken = null, redelivered = false }) {
```

and passes it at the one call site inside the primary branch:

```js
        body: primaryAlertText({ fromE164, durationSec, redelivered, listenToken }),
```

- [ ] **Step 6: Thread it through the two callers**

`server/routes/voice.js` — `claimVoicemail`'s return (it already carries `fromE164` and `line`; add the token beside them) and `deliverClaimedVoicemail`'s destructure and job literal:

```js
  return { callSid, recordingSid, durationSec, fromE164: claim.fromE164, line: claim.line, listenToken: claim.listenToken, tail };
```

```js
async function deliverClaimedVoicemail({ callSid, recordingSid, durationSec, fromE164, line, listenToken, tail }) {
```

```js
  const outcome = await _deps.deliverVoicemail({
    callSid, recordingSid, durationSec, fromE164, line, listenToken, chatId: allowed,
  });
```

`server/utils/vaCallingScheduler.js` — the sweep's SELECT already reads `line`; add `listen_token` beside it and pass it in the job:

```js
    `SELECT call_sid, from_e164, recording_sid, duration_sec, attempts, line, listen_token
       FROM voicemail_delivery
```

```js
        listenToken: row.listen_token,
```

Both files are already declared in the lane map's footprint, along with their suites.

- [ ] **Step 7: Run every touched suite, one at a time**

```bash
node -r dotenv/config --test server/utils/voicemail.test.js
node -r dotenv/config --test server/routes/voice.test.js
node -r dotenv/config --test server/routes/voicemailListen.test.js
node -r dotenv/config --test server/utils/vaCallingScheduler.test.js
node -r dotenv/config --test server/db/schema.vaCalling.test.js
```
Expected: PASS on all five. `voice.test.js` and `vaCallingScheduler.test.js` both stub `claimDelivery` / the sweep row; update those stubs to carry a `listenToken` / `listen_token` so the shapes match the new contract.

- [ ] **Step 8: Confirm the file-size budget**

Run: `npm run check:filesize`
Expected: `server/routes/voice.js` is NOT in the RED list. It gains 3 tokens-worth of threading (about 3 lines) from 700, so it will cross into YELLOW. That is allowed (YELLOW only warns; the ratchet blocks above 1000), but if you would rather stay at the cap, the `deliverClaimedVoicemail` alert tail is the extraction the Phase 1b work will want anyway.

- [ ] **Step 9: Commit**

```bash
git add server/utils/voicemail.js server/utils/voicemail.test.js \
        server/routes/voice.js server/routes/voice.test.js \
        server/utils/vaCallingScheduler.js server/utils/vaCallingScheduler.test.js
git commit -m "feat(voicemail): alert SMS carries the listen link"
```

---

## Task 4: Env registration and documentation

**Files:**
- Modify: `.env.example`
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Add the var to `.env.example`**

Add to the voicemail block, after `VM_TEXT_DESTINATION`:

```bash
# Listen-link kill switch (spec 2026-08-10), default ON. Set to 'false' to close
# GET /api/voice/vm/:token (it 404s) and drop the link line from the alert SMS,
# without a redeploy. The route serves a client's recorded voice to anyone
# holding the token, so it gets the same redeploy-free off switch as the other
# PII surfaces.
VM_LISTEN_LINK_ENABLED=true
```

- [ ] **Step 2: Add the row to the `.claude/CLAUDE.md` env table**

Insert after the `VM_TEXT_DESTINATION` row:

```
| `VM_LISTEN_LINK_ENABLED` | Listen-link kill switch, **default ON** (only `'false'` disables). Off → `GET /api/voice/vm/:token` 404s and the primary alert SMS omits the link line. The token IS the auth (UUID, same model as proposals/invoices), so anyone holding the URL can hear that voicemail; this is the redeploy-free way to shut it. |
```

- [ ] **Step 3: Update `README.md`**

- Environment Variables table: the same row as step 2.
- Folder tree: add `server/routes/voicemailListen.js` with a one-line description.

- [ ] **Step 4: Update `ARCHITECTURE.md`**

- API route table: a new `/api/voice/vm` section with `GET /:token` (public, token-gated, streams `audio/mpeg`, 404 on anything missing).
- Database Schema: add `listen_token` to the `voicemail_delivery` entry, noting it is NOT NULL with a `gen_random_uuid()` default and that the default IS the backfill.
- The inbound-flow prose: the primary alert now carries a listen link, and state plainly that the link works while the row and the Twilio recording both live, roughly 30 days.

- [ ] **Step 5: Verify the docs against the code that landed**

```bash
grep -n "VM_LISTEN_LINK_ENABLED" .claude/CLAUDE.md README.md .env.example
grep -n "api/voice/vm" ARCHITECTURE.md README.md
grep -n "listen_token" ARCHITECTURE.md
```
Expected: every command prints hits in every named file.

- [ ] **Step 6: Commit**

```bash
git add .env.example .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs(voicemail): register the listen link, its route, and its kill switch"
```

---

## Before the lane merges

- [ ] Run every touched suite one at a time (they share the dev DB):
  `server/db/schema.vaCalling.test.js`, `server/utils/voicemail.test.js`,
  `server/routes/voicemailListen.test.js`, `server/routes/voice.test.js`,
  `server/utils/vaCallingScheduler.test.js`.
- [ ] `npx eslint server/` clean (0 errors).
- [ ] `npm run check:filesize` shows nothing in RED.
- [ ] Full review fleet (`security-review`, `database-review`, `code-review`, `consistency-check`) plus `/second-opinion`: this adds a PUBLIC route serving client voice audio.
- [ ] Prod DDL is NOT needed ahead of the push: the column is additive with a DEFAULT and old code never reads it. `initDb()` applies it on boot. Confirm after deploy that `listen_token` exists and is unique.

## Ops and live verification (owner, after deploy)

- [ ] Call the 1922, let it ring out, leave a message, and tap the link in the text. It should play.
- [ ] Confirm the link is dead for a made-up token (paste a random UUID into the same URL shape and expect a 404).
- [ ] Decide whether the two-segment alert is worth trimming the copy for. Fractions of a cent, so probably not.

## Deferred (still Phase 1b)

R2 storage with R2 as the redelivery source, transcription, the AI summary and
tag, the rich listen PAGE (transcript, soft delete), the 14-day audio purge, and
the prune's retained-audio orphan gap. This design neither creates nor deletes
audio, so it does not move any of those.
