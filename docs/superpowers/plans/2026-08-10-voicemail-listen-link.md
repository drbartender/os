# Voicemail Listen Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a tappable link in the primary-line voicemail alert SMS that plays the recording, so the text carries the message instead of only announcing it.

**Architecture:** Every `voicemail_delivery` row is born with a UUID `listen_token` (column DEFAULT, no application code). A new small router streams the mp3 for a token by looking the RECORDING SID up from the row and fetching it server-side with the account credentials, so neither the Twilio URL nor the credentials ever reach the client. The alert body gains one line. No R2, no transcription, no HTML page: Phase 1a already retains the primary recording in Twilio, which is the only reason this is small.

**Tech Stack:** Node.js 26 / Express 4, Postgres 17 (raw SQL via `pg`), Twilio REST (media fetch), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-10-voicemail-listen-link-design.md` (approved 2026-08-10)

**Plan revision 2**, after the design-stage fleet blocked rev 1. What changed, because
three of these were real build-blockers and not polish:

1. **The kill switch was half-built.** All three reviewers caught it. `VM_LISTEN_LINK_ENABLED`
   gated only the route, while Task 4 documented it as also dropping the SMS line. Flipping it
   off would have left a dead link in every alert, the exact "a broken URL is worse than no URL"
   failure the plan's own comment argues against. `listenLinkEnabled()` now lives in
   `server/utils/voicemail.js`, is consumed by BOTH the delivery path and the route, and is tested
   on both sides.
2. **Task 1 reddened an existing assertion.** `schema.vaCalling.test.js:210-214` does an exact
   `assert.deepEqual` over the full column list; `listen_token` sorts between `line` and
   `recording_sid`. Rev 1 claimed "PASS, including every pre-existing assertion" and shipped no
   step to update it. Now Step 3 updates that array first.
3. **Task 3's headline test could not pass.** It asserted on a token it never passed in, against a
   parameter that defaults to null. It now goes through the real `claimDelivery` round trip, which
   is both passable and the seam actually worth testing.
4. The route's SELECT is exported as `LOOKUP_SQL` and exercised by a `dbTest` against the real
   column, closing the gap where no checkpoint ever ran that SQL before the post-deploy call.
5. `asyncHandler` added (CLAUDE.md requires it for async route handlers; the voice webhooks skip it
   only because they must always answer TwiML, which this route need not).
6. The byte-identical-404 constraint is reworded to what is actually true and testable.
7. Fixed: the `schema.sql` anchor (3789, not 3740), `psql` without `DATABASE_URL` in the shell,
   the "nothing may be added to voice.js" constraint contradicting Task 3, the "three tasks" count,
   and the file-size narrative (`voice.js` at exactly 700 is GREEN; `bucket()` warns at `> 700`).
8. Added mid-build review checkpoints, per the decomposition reviewer: `security-review` runs after
   Task 2 and BEFORE Task 3, so a rejection of the bare-UUID auth model costs one task of rework
   instead of three.

## Global Constraints

- **No em dashes** in any copy, comment prose, or SMS text. Commas, periods, colons, parentheticals only.
- **The recording SID comes from the ROW, never from the request.** This is the property that separates a listen link from an open proxy into the Twilio account. No route may accept a recording SID, a media URL, or an account SID as input.
- The Twilio media URL and `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` never appear in a response body, a redirect, or a client-visible error.
- **Every 404 the route itself emits is byte-identical** (unknown token, non-primary row, missing recording, kill switch off): same status, same `text/plain` body, no detail. A malformed (non-UUID) token is refused earlier by the shared `requireUuidToken` guard and surfaces as the app's standard JSON error shape, so malformed is distinguishable from unknown. That is deliberate: it keeps the house guard that prevents a 22P02 cast error, and it leaks nothing about which rows exist.
- **`VM_LISTEN_LINK_ENABLED` is a TWO-SIDED switch.** Off must both close the route and stop the SMS from carrying a link. One definition, consumed by both.
- All SQL parameterized (`$1`). Schema statements idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`).
- Logs use the existing last-4 redaction idiom (`String(x).slice(-4)`). No token, caller number, or media URL is ever logged in full.
- **Schema is applied by `initDb()`** in `server/db/index.js` on boot. There is no `applySchema.js`.
- **Server suites run ONE AT A TIME against the shared dev DB**, from the repo root: `node -r dotenv/config --test <file>`. `DATABASE_URL` lives in the gitignored `.env` and is NOT exported in the shell, so any DB check must go through `node -r dotenv/config`, never a bare `psql "$DATABASE_URL"`.
- **File-size discipline:** no new CONCERN may be added to `server/routes/voice.js` (the new route gets its own file). Task 3's in-place field threading on existing lines there is expected and fine. `check-file-size.js` warns at `> 700` and only blocks above 1000 when growing.
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

**One lane, four tasks, strictly sequential** (1 → 2 → 3 → 4): the column must exist before the route reads it, and the route must exist before the SMS links to it.

**Mid-build review checkpoints** (scoped to the batch; the lane fleet still runs at merge):

| After | Agent | Why |
|---|---|---|
| Task 1 | `database-review` | `NOT NULL DEFAULT gen_random_uuid()` is a VOLATILE default, so it does not take the PG11+ metadata-only fast path: it rewrites the table under ACCESS EXCLUSIVE, and it lands via `initDb()` on prod boot. Small table, but a reviewer should price it. |
| Task 2, before Task 3 starts | `security-review` | A public route serving a client's recorded voice, authenticated by a bare never-expiring UUID. If that model is going to be rejected, it must be rejected while only one task exists. |
| Task 4 | `consistency-check` | Docs against the code that landed, specifically the two-sided kill switch. |

Full fleet regardless of size at merge, plus `/second-opinion`: this adds a PUBLIC route serving client voice audio, and it touches `server/utils/voicemail.js`, already on `scripts/sensitive-paths.txt`.

---

## Task 1: The token column

**Files:**
- Modify: `server/db/schema.sql` (append after the `idx_voicemail_delivery_escalated_at` index at line 3789-3790, before the "Proposal option groups" divider at 3792)
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

Verify the column and its backfill (note: `DATABASE_URL` is not in the shell, so this goes through dotenv, not `psql`):

Run:
```bash
node -r dotenv/config -e "require('./server/db').pool.query('SELECT COUNT(*) AS rows, COUNT(listen_token) AS tokens, COUNT(DISTINCT listen_token) AS distinct_tokens FROM voicemail_delivery').then(r => { console.log(r.rows[0]); process.exit(0); })"
```
Expected: all three counts equal. Every pre-existing row got a token and no two share one.

- [ ] **Step 3: Update the EXISTING column-list assertion**

`server/db/schema.vaCalling.test.js:210-214` does an exact `assert.deepEqual` over every column of `voicemail_delivery`, ordered by name. `listen_token` sorts between `line` and `recording_sid`, so this test fails until the array is updated. Do this BEFORE running the suite or Step 5 will look like a regression:

```js
  assert.deepEqual(rows.map((r) => r.column_name), [
    'attempts', 'call_sid', 'created_at', 'delivered_at',
    'duration_sec', 'escalated_at', 'escalation_accepted_at', 'escalation_outcome',
    'from_e164', 'line', 'listen_token', 'recording_sid', 'status',
  ]);
```

- [ ] **Step 4: Add the new assertions**

Add beside the other `voicemail_delivery` tests. Use `dbTest` (not bare `test`) for anything touching the DB: `pool` is only assigned when `DATABASE_URL` is set.

```js
test('voicemail_delivery carries the listen_token idempotently', () => {
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS listen_token UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
  assert.match(schemaSql, /uq_voicemail_delivery_listen_token/);
});

test('the listen_token DDL is inside the slice the suite actually applies', () => {
  // Same guard as the `line` column above: a block appended BELOW the slice
  // boundary would make the catalog tests pass only because someone ran initDb
  // by hand.
  assert.match(vaCallingDdl(), /ADD COLUMN IF NOT EXISTS listen_token UUID NOT NULL/);
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

- [ ] **Step 5: Run the suite**

Run: `node -r dotenv/config --test server/db/schema.vaCalling.test.js`
Expected: PASS, including the column-list assertion updated in Step 3.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/db/schema.vaCalling.test.js
git commit -m "feat(voicemail): listen_token column, defaulted and unique"
```

**CHECKPOINT: run `database-review` on this commit before starting Task 2.**

---

## Task 2: The streaming route

**Files:**
- Create: `server/routes/voicemailListen.js`
- Create: `server/routes/voicemailListen.test.js`
- Modify: `server/utils/voicemail.js` (add `fetchRecordingMp3Once` and `listenLinkEnabled`, export both)
- Modify: `server/utils/voicemail.test.js`
- Modify: `server/index.js:397-399` (mount)
- Modify: `scripts/sensitive-paths.txt`

**Interfaces:**
- Consumes: `requireUuidToken` from `server/utils/tokens.js`; `asyncHandler` from `server/middleware/asyncHandler.js`; `pool` from `server/db`.
- Produces: `GET /api/voice/vm/:token`; `voicemail.fetchRecordingMp3Once(recordingSid) => Promise<Buffer>` (throws with `.status`); `voicemail.listenLinkEnabled() => boolean`; `router.LOOKUP_SQL` (the exact SELECT, exported so a dbTest can run it against the real column with no drift); `router.__setListenDeps(overrides)`.

- [ ] **Step 1: Add the shared single-attempt fetch and the kill switch to `server/utils/voicemail.js`**

`fetchRecordingMp3` retries a 404 three times with backoff, which is right for the delivery pipeline (the recording is occasionally not fetchable for a beat after the callback) and wrong for a route where a person is waiting. Extract the single attempt so the credentials are assembled in exactly ONE place (this file is on `sensitive-paths.txt` precisely for that construction), and let the retrying version wrap it.

Replace the body of `fetchRecordingMp3` and add its single-shot sibling:

```js
/**
 * ONE authenticated GET for a recording's mp3. The single place the account
 * credentials are assembled into a media request. Throws with `.status` set so
 * callers can distinguish "gone" (404) from "our problem" (anything else).
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

/**
 * Bounded-retry fetch for the DELIVERY pipeline: a recording is occasionally
 * not fetchable for a beat after its status callback, and nobody is waiting.
 * 404 is the known race and is retried; 401/403 are credential problems and are
 * not. The listen route deliberately uses fetchRecordingMp3Once instead.
 */
async function fetchRecordingMp3(recordingSid) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MEDIA_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await _deps.fetchRecordingMp3Once(recordingSid);
    } catch (err) {
      // No `.status` means the request never got a response at all: a network
      // failure or the AbortSignal timeout. Propagate THAT error rather than
      // flattening it into "failed (0)", or a DNS outage and a timeout become
      // indistinguishable in the logs. Only an HTTP status reaches the retry
      // policy below.
      if (!err.status) throw err;
      lastStatus = err.status;
      if (lastStatus !== 404) break;
      if (attempt < MEDIA_FETCH_ATTEMPTS) await _deps.sleep(MEDIA_RETRY_BACKOFF_MS * attempt);
    }
  }
  throw new Error(`recording fetch failed (${lastStatus}) sid=...${String(recordingSid).slice(-4)}`);
}

/**
 * Listen-link master switch, default ON. TWO-SIDED by contract: off must both
 * close GET /api/voice/vm/:token AND stop the alert SMS from carrying a link.
 * Defined here, beside the delivery path, and imported by the route, so the two
 * sides cannot drift apart and leave a dead URL in a client-facing alert.
 */
function listenLinkEnabled() {
  return process.env.VM_LISTEN_LINK_ENABLED !== 'false';
}
```

Add `fetchRecordingMp3Once: (...a) => fetchRecordingMp3Once(...a)` to the `_deps` object (so the retry wrapper and the tests both go through the seam), and add `fetchRecordingMp3Once` and `listenLinkEnabled` to `module.exports`.

- [ ] **Step 2: Write the failing tests for both**

Add to `server/utils/voicemail.test.js`. Both stubs restore in a `finally`, matching the neighboring `fetchRecordingMp3` tests, and both set the account SID explicitly rather than relying on an earlier test in the file having set it:

```js
test('fetchRecordingMp3Once does NOT retry and surfaces the status', async () => {
  const savedSid = process.env.TWILIO_ACCOUNT_SID;
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  let calls = 0;
  try {
    vm.__setVoicemailDeps({
      fetch: async () => { calls += 1; return { ok: false, status: 404 }; },
    });
    await assert.rejects(
      () => vm.fetchRecordingMp3Once(GOOD_SID),
      (err) => err.status === 404
    );
    assert.equal(calls, 1, 'a person is waiting; one attempt only');
  } finally {
    if (savedSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = savedSid;
    vm.__setVoicemailDeps({ fetch: (...a) => globalThis.fetch(...a) });
  }
});

test('fetchRecordingMp3Once returns the bytes on success', async () => {
  const savedSid = process.env.TWILIO_ACCOUNT_SID;
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  try {
    vm.__setVoicemailDeps({
      fetch: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('ID3listen') }),
    });
    const buf = await vm.fetchRecordingMp3Once(GOOD_SID);
    assert.equal(buf.toString(), 'ID3listen');
  } finally {
    if (savedSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = savedSid;
    vm.__setVoicemailDeps({ fetch: (...a) => globalThis.fetch(...a) });
  }
});

test('fetchRecordingMp3 propagates a network failure instead of flattening it', async () => {
  // The extraction must not turn "DNS failed" or "timed out" into "failed (0)".
  try {
    vm.__setVoicemailDeps({
      fetchRecordingMp3Once: async () => { throw new Error('ETIMEDOUT reaching api.twilio.com'); },
      sleep: async () => {},
    });
    await assert.rejects(() => vm.fetchRecordingMp3(GOOD_SID), /ETIMEDOUT/);
  } finally {
    vm.__setVoicemailDeps({
      fetchRecordingMp3Once: (...a) => vm.fetchRecordingMp3Once(...a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  }
});

test('fetchRecordingMp3 still retries a 404 three times through the shared fetch', async () => {
  // The delivery pipeline's contract is unchanged by the extraction.
  let calls = 0;
  try {
    vm.__setVoicemailDeps({
      fetchRecordingMp3Once: async () => { calls += 1; const e = new Error('404'); e.status = 404; throw e; },
      sleep: async () => {},
    });
    await assert.rejects(() => vm.fetchRecordingMp3(GOOD_SID));
    assert.equal(calls, 3);
  } finally {
    vm.__setVoicemailDeps({
      fetchRecordingMp3Once: (...a) => vm.fetchRecordingMp3Once(...a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  }
});

test('listenLinkEnabled defaults ON and only the literal false disables it', () => {
  delete process.env.VM_LISTEN_LINK_ENABLED;
  assert.equal(vm.listenLinkEnabled(), true);
  process.env.VM_LISTEN_LINK_ENABLED = 'true';
  assert.equal(vm.listenLinkEnabled(), true);
  process.env.VM_LISTEN_LINK_ENABLED = 'no';
  assert.equal(vm.listenLinkEnabled(), true, 'only the exact string false disables it');
  process.env.VM_LISTEN_LINK_ENABLED = 'false';
  assert.equal(vm.listenLinkEnabled(), false);
  delete process.env.VM_LISTEN_LINK_ENABLED;
});
```

- [ ] **Step 3: Run, red then green**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected FIRST: FAIL, `vm.fetchRecordingMp3Once is not a function`. After Step 1's code is in: PASS, including every pre-existing test in the file (the `fetchRecordingMp3` retry tests still pass because the wrapper preserves the contract).

- [ ] **Step 4: Write the failing route test**

Create `server/routes/voicemailListen.test.js`:

```js
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { pool } = require('../db');

const router = require('./voicemailListen');

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
  await pool.query("DELETE FROM voicemail_delivery WHERE call_sid LIKE 'TEST_VM_listen%'");
  await pool.end();
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${path}`, { method: 'GET' }, (res) => {
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

const HAS_DB = !!process.env.DATABASE_URL;
const dbTest = HAS_DB ? test : test.skip;

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

// ── the SELECT itself, against the real column ──────────────────────────────
// The tests above stub `pool`, so they prove the handler's behavior but never
// that the SQL filters. Run the route's EXPORTED statement against real rows so
// the predicates cannot drift from what the route actually executes.

dbTest('LOOKUP_SQL finds a primary row and rejects zul, NULL-recording, and unknown', async () => {
  await pool.query(
    `INSERT INTO voicemail_delivery (call_sid, line, recording_sid, status)
     VALUES ('TEST_VM_listen_p', 'primary', $1, 'delivered'),
            ('TEST_VM_listen_z', 'zul',     $1, 'delivered'),
            ('TEST_VM_listen_n', 'primary', NULL, 'missed')`,
    [REC]
  );
  const tokens = {};
  for (const cs of ['TEST_VM_listen_p', 'TEST_VM_listen_z', 'TEST_VM_listen_n']) {
    const { rows } = await pool.query('SELECT listen_token FROM voicemail_delivery WHERE call_sid = $1', [cs]);
    tokens[cs] = rows[0].listen_token;
  }
  const run = async (t) => (await pool.query(router.LOOKUP_SQL, [t])).rows;

  assert.equal((await run(tokens.TEST_VM_listen_p)).length, 1, 'primary row with audio is found');
  assert.equal((await run(tokens.TEST_VM_listen_z)).length, 0, "zul's audio was deleted after the Telegram upload");
  assert.equal((await run(tokens.TEST_VM_listen_n)).length, 0, 'no recording, nothing to stream');
  assert.equal((await run(OTHER)).length, 0, 'unknown token');
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
// at its 700-line soft cap and this concern is separately reviewable.
//
// SECURITY: the token is the ONLY input. The recording SID is read from the row
// and never accepted from the request, which is the line between a listen link
// and an open proxy into our Twilio account. The media URL and the account
// credentials are used server-side and never appear in a response.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireUuidToken } = require('../utils/tokens');
const asyncHandler = require('../middleware/asyncHandler');
const voicemail = require('../utils/voicemail');

const router = express.Router();

// Exported so a dbTest can execute the EXACT statement the route runs. The
// stubbed-pool tests prove the handler; this proves the predicates.
const LOOKUP_SQL = `SELECT call_sid, recording_sid
                      FROM voicemail_delivery
                     WHERE listen_token = $1
                       AND line = 'primary'
                       AND recording_sid IS NOT NULL`;
router.LOOKUP_SQL = LOOKUP_SQL;

let _deps = {
  pool,
  fetchRecordingMp3Once: (...a) => voicemail.fetchRecordingMp3Once(...a),
  listenLinkEnabled: (...a) => voicemail.listenLinkEnabled(...a),
};
function __setListenDeps(d) { _deps = { ..._deps, ...d }; }
router.__setListenDeps = __setListenDeps;

// Per-IP cap. Unlike the voice webhooks there is no live caller on this path, so
// a bare 429 is correct here. The real anti-enumeration control is the 122-bit
// token; this only blunts a scripted sweep.
const listenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
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
router.get('/:token', listenLimiter, requireUuidToken('token'), asyncHandler(async (req, res) => {
  if (!_deps.listenLinkEnabled()) return notFound(res);

  let row;
  try {
    const { rows } = await _deps.pool.query(LOOKUP_SQL, [req.params.token]);
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
}));

module.exports = router;
```

Confirm the `asyncHandler` import path and shape against an existing route before writing it (`grep -rn "require.*asyncHandler" server/routes | head -3`); use whatever that file uses, default-export or destructured.

- [ ] **Step 7: Run to confirm the route tests pass**

Run: `node -r dotenv/config --test server/routes/voicemailListen.test.js`
Expected: PASS, 12 tests (11 plus the `dbTest`).

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

**CHECKPOINT: run `security-review` on this commit BEFORE starting Task 3.** The bare-UUID, never-expiring, never-revocable token as sole auth on a public route serving a client's recorded voice is the decision worth a second opinion while only one task exists.

---

## Task 3: The link in the alert

**Files:**
- Modify: `server/utils/voicemail.js` (`primaryAlertText`, `claimDelivery`, `deliverVoicemail`)
- Modify: `server/utils/voicemail.test.js`
- Modify: `server/routes/voice.js` (three in-place field additions)
- Modify: `server/routes/voice.test.js`
- Modify: `server/utils/vaCallingScheduler.js` (sweep SELECT + job)
- Modify: `server/utils/vaCallingScheduler.test.js`

**Interfaces:**
- Consumes: `API_URL` from `server/utils/urls.js` (NOT currently imported in `voicemail.js`; add it); `listenLinkEnabled` (Task 2); `listen_token` (Task 1).
- Produces: `primaryAlertText({ fromE164, durationSec, redelivered, listenToken })`; `claimDelivery` returns `{fromE164, line, listenToken}`; `deliverVoicemail` accepts `listenToken`.

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
  const hits = body.match(/11111111-2222-4333-8444-555555555555/g) || [];
  assert.equal(hits.length, 1, 'the token appears exactly once');
});

test('primaryAlertText omits the link rather than emitting a broken one', () => {
  const body = vm.primaryAlertText({ fromE164: '+13125550147', durationSec: 9 });
  assert.doesNotMatch(body, /\/api\/voice\/vm/);
  assert.doesNotMatch(body, /undefined|null/);
  // And the rest of the body is byte-identical to the pre-link alert.
  assert.match(body, /^New voicemail on the business line \(9s\), .+\.\n\+13125550147$/);
});

test('the kill switch drops the link line, not just the route', async () => {
  // A dead link in an alert reads as a bug in the voicemail itself, so OFF must
  // mean the SMS stops carrying one.
  const sent = { sms: [] };
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  process.env.VM_LISTEN_LINK_ENABLED = 'false';
  try {
    await vm.claimMissedCall({ callSid: sid(61), fromE164: '+13125550147', line: 'primary' });
    vm.__setVoicemailDeps({
      notificationsEnabled: () => true,
      client: removeSpy().client,
      fetchRecordingMp3: async () => Buffer.from('ID3'),
      sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SM8' }; },
    });
    await vm.deliverVoicemail({
      callSid: sid(61), recordingSid: 'RE' + '8'.repeat(32), durationSec: 6,
      fromE164: '+13125550147', chatId: null, line: 'primary',
      listenToken: '11111111-2222-4333-8444-555555555555',
    });
    assert.equal(sent.sms.length, 1);
    assert.doesNotMatch(sent.sms[0].body, /\/api\/voice\/vm/);
  } finally {
    delete process.env.VM_LISTEN_LINK_ENABLED;
  }
});

test('the delivered alert carries the row\'s own token, read back with the claim', async () => {
  // Goes through the REAL claimDelivery round trip, which is the seam the
  // feature actually uses: the token must come off the row, not from the caller.
  const sent = { sms: [] };
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(60), fromE164: '+13125550147', line: 'primary' });
  const claim = await vm.claimDelivery({
    callSid: sid(60), recordingSid: 'RE' + '9'.repeat(32), durationSec: 6,
  });
  assert.match(claim.listenToken, /^[0-9a-f-]{36}$/, 'claimDelivery reads the token back');
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: removeSpy().client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SM9' }; },
  });
  await vm.deliverVoicemail({
    callSid: sid(60), recordingSid: 'RE' + '9'.repeat(32), durationSec: 6,
    fromE164: claim.fromE164, chatId: null, line: claim.line, listenToken: claim.listenToken,
  });
  assert.equal(sent.sms.length, 1);
  assert.match(sent.sms[0].body, new RegExp(`/api/voice/vm/${claim.listenToken}$`));
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: FAIL. `primaryAlertText` ignores `listenToken`, and `claimDelivery` returns no `listenToken`.

- [ ] **Step 3: Add the link to `primaryAlertText`**

Add `API_URL` to the requires at the top of `server/utils/voicemail.js` (it is NOT imported there today):

```js
const { API_URL } = require('./urls');
```

Replace the function:

```js
function primaryAlertText({ fromE164, durationSec, redelivered = false, listenToken = null }) {
  const who = fromE164 || 'a withheld number';
  const secs = Number.isFinite(durationSec) ? `${durationSec}s` : 'unknown length';
  const redo = redelivered ? ' (redelivered)' : '';
  // The link goes LAST so phone clients linkify it cleanly. It is omitted when
  // there is no token OR when the switch is off: a broken or dead URL in an
  // alert is worse than no URL, because it reads as a bug in the voicemail.
  const listen = (listenToken && listenLinkEnabled())
    ? `\n${API_URL}/api/voice/vm/${listenToken}`
    : '';
  return `New voicemail on the business line (${secs})${redo}, ${chicagoStamp()}.\n${who}${listen}`;
}
```

- [ ] **Step 4: Read the token back with the delivery claim**

`claimDelivery` already returns the row's `from_e164` and `line` in one round trip; the token rides along the same way. Extend its `RETURNING` clause and return value:

```js
      RETURNING from_e164, line, listen_token`,
```

```js
  return rows.length > 0
    ? { fromE164: rows[0].from_e164, line: rows[0].line, listenToken: rows[0].listen_token }
    : null;
```

Update its JSDoc `@returns` to `Promise<{fromE164: string|null, line: 'primary'|'zul', listenToken: string}|null>`.

- [ ] **Step 4b: Update the EXISTING exact-shape assertions on `claimDelivery`**

Widening that return value reddens two `assert.deepEqual` checks (`node:assert/strict`,
so an extra property fails). This is the same class as Task 1 Step 3: do it in the same
edit as Step 4, or Step 8's red looks like a regression instead of an expected shape change.

`server/utils/voicemail.test.js:59`:

```js
  assert.equal(first.fromE164, '+13125550147');
  assert.equal(first.line, 'zul');
  assert.match(first.listenToken, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
```

`server/utils/voicemail.test.js:299`:

```js
  assert.equal(claim.fromE164, '+13125550147');
  assert.equal(claim.line, 'primary');
  assert.match(claim.listenToken, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
```

Field-by-field rather than a `deepEqual` against a hardcoded token: the token is
generated by the DB per row, so no literal can be asserted, and this shape keeps
the two stable fields pinned.

Then re-grep for any other exact-shape assertion on this return value before moving on:

Run: `grep -rn "deepEqual(.*fromE164" server --include=*.test.js`
Expected: only the two lines above, both now updated.

- [ ] **Step 5: Thread the token to the alert**

`deliverVoicemail` gains `listenToken` in its destructure, defaulting to null:

```js
async function deliverVoicemail({ callSid, recordingSid, durationSec, fromE164, chatId, line = 'zul', listenToken = null, redelivered = false }) {
```

and passes it at the one call site inside the primary branch:

```js
        body: primaryAlertText({ fromE164, durationSec, redelivered, listenToken }),
```

- [ ] **Step 6: Thread it through the two callers**

`server/routes/voice.js` — `claimVoicemail`'s return (`:642`), `deliverClaimedVoicemail`'s destructure (`:645`), and the job literal (`:673-675`). All three are in-place field additions on existing lines:

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

`server/utils/vaCallingScheduler.js` — the sweep's SELECT (`:199`) already reads `line`; add `listen_token` beside it, and add the field to the `deliverVoicemail` job (`:249-257`):

```js
    `SELECT call_sid, from_e164, recording_sid, duration_sec, attempts, line, listen_token
       FROM voicemail_delivery
```

```js
        listenToken: row.listen_token,
```

- [ ] **Step 7: Update the two stubs the new field flows through**

Neither existing stub asserts a whole object, so nothing breaks, but both should carry the field so the suites exercise the real shape.

`server/routes/voice.test.js`, the baseline `claimDelivery` stub in `beforeEach`:

```js
    claimDelivery: async (args) => { calls.deliveryClaims.push(args); return { fromE164: '+13125550147', line: 'zul', listenToken: '11111111-2222-4333-8444-555555555555' }; },
```

and add a route-level assertion beside the existing per-line delivery tests:

```js
test('/inbound/voicemail passes the row listen token into the delivery job', async () => {
  const jobs = [];
  router.__setVoiceDeps({
    claimDelivery: async () => ({ fromE164: '+13125550147', line: 'primary', listenToken: '11111111-2222-4333-8444-555555555555' }),
    deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
  });
  await post('/api/voice/inbound/voicemail', {
    CallSid: cs('CAdel5'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
  });
  await settle();
  assert.equal(jobs[0].listenToken, '11111111-2222-4333-8444-555555555555');
});
```

`server/utils/vaCallingScheduler.test.js`, the `vmRow()` helper:

```js
    listen_token: '11111111-2222-4333-8444-555555555555',
```

and add to the existing sweep test file:

```js
test('reapUndeliveredVoicemails carries the row listen token into the job', async () => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  const jobs = [];
  __setDeps({
    notificationsEnabled: () => true,
    pool: sweepPool(vmRow({ line: 'primary' })),
    deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
  });
  await reapUndeliveredVoicemails();
  assert.equal(jobs[0].listenToken, '11111111-2222-4333-8444-555555555555',
    'a redelivered alert links to the same recording, not a fresh token');
});
```

- [ ] **Step 8: Run every touched suite, one at a time**

```bash
node -r dotenv/config --test server/utils/voicemail.test.js
node -r dotenv/config --test server/routes/voice.test.js
node -r dotenv/config --test server/routes/voicemailListen.test.js
node -r dotenv/config --test server/utils/vaCallingScheduler.test.js
node -r dotenv/config --test server/db/schema.vaCalling.test.js
```
Expected: PASS on all five.

- [ ] **Step 9: Confirm the file-size budget**

Run: `npm run check:filesize`
Expected: nothing in RED. `server/routes/voice.js` is at exactly 700 and `bucket()` warns at `> 700`, so it is GREEN today; Step 6's three edits are in-place additions to existing lines and should leave it there. YELLOW would be acceptable anyway (it never blocks), but if it crosses and you would rather it did not, the `deliverClaimedVoicemail` alert tail is the extraction Phase 1b will want regardless.

- [ ] **Step 10: Commit**

```bash
git add server/utils/voicemail.js server/utils/voicemail.test.js \
        server/routes/voice.js server/routes/voice.test.js \
        server/utils/vaCallingScheduler.js server/utils/vaCallingScheduler.test.js
git commit -m "feat(voicemail): alert SMS carries the listen link, switch-gated on both sides"
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
# Listen-link kill switch (spec 2026-08-10), default ON (only the literal
# 'false' disables). TWO-SIDED: off both closes GET /api/voice/vm/:token (it
# 404s) and drops the link line from the alert SMS, so flipping it never leaves
# a dead URL in a client-facing alert. The route serves a client's recorded
# voice to anyone holding the token, so it gets the same redeploy-free off
# switch as the other PII surfaces.
VM_LISTEN_LINK_ENABLED=true
```

- [ ] **Step 2: Add the row to the `.claude/CLAUDE.md` env table**

Insert after the `VM_TEXT_DESTINATION` row:

```
| `VM_LISTEN_LINK_ENABLED` | Listen-link kill switch, **default ON** (only `'false'` disables). TWO-SIDED: off → `GET /api/voice/vm/:token` 404s AND the primary alert SMS omits the link line (one `listenLinkEnabled()` in `utils/voicemail.js` feeds both, so they cannot drift and strand a dead URL in an alert). The token IS the auth (UUID, same model as proposals/invoices), so anyone holding the URL can hear that voicemail; this is the redeploy-free way to shut it. |
```

- [ ] **Step 3: Update `README.md`**

- Environment Variables table: the same row as step 2.
- Folder tree: add `server/routes/voicemailListen.js` with a one-line description naming the token-gated stream and the row-sourced recording SID.

- [ ] **Step 4: Update `ARCHITECTURE.md`**

- API route table: a new `/api/voice/vm` section with `GET /:token` (public, token-gated, streams `audio/mpeg`, one identical 404 for every miss).
- Database Schema: add `listen_token` to the `voicemail_delivery` entry, noting NOT NULL with a `gen_random_uuid()` default and that the default IS the backfill.
- The inbound-flow prose: the primary alert now carries a listen link; state plainly that it works while the row and the Twilio recording both live, roughly 30 days, and that the switch is two-sided.

- [ ] **Step 5: Verify the docs against the code that landed**

`git diff --stat` proves files were touched, not that content is right. Grep for the specific facts:

```bash
grep -n "VM_LISTEN_LINK_ENABLED" .claude/CLAUDE.md README.md .env.example
grep -n "api/voice/vm" ARCHITECTURE.md README.md
grep -n "listen_token" ARCHITECTURE.md
grep -rn "listenLinkEnabled" server/utils/voicemail.js server/routes/voicemailListen.js
```
Expected: every command prints hits in every named file, and the last one shows ONE definition with the route consuming it.

- [ ] **Step 6: Commit**

```bash
git add .env.example .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs(voicemail): register the listen link, its route, and its two-sided kill switch"
```

**CHECKPOINT: run `consistency-check` on this commit.**

---

## Before the lane merges

- [ ] Run every touched suite one at a time (they share the dev DB):
  `server/db/schema.vaCalling.test.js`, `server/utils/voicemail.test.js`,
  `server/routes/voicemailListen.test.js`, `server/routes/voice.test.js`,
  `server/utils/vaCallingScheduler.test.js`.
- [ ] `npx eslint server/` clean (0 errors).
- [ ] `npm run check:filesize` shows nothing in RED.
- [ ] Full review fleet (`security-review`, `database-review`, `code-review`, `consistency-check`) plus `/second-opinion`: this adds a PUBLIC route serving client voice audio.
- [ ] Prod DDL is NOT needed ahead of the push: the column is additive with a DEFAULT and old code never reads it, so `initDb()` applies it on boot. Confirm after deploy that `listen_token` exists and is unique.

## Ops and live verification (owner, after deploy)

- [ ] Call the 1922, let it ring out, leave a message, and tap the link in the text. It should play.
  - If it does NOT play but the URL is right, suspect HTTP Range: the route returns the whole body with `Content-Length` and no `Accept-Ranges`, and some mobile clients issue a Range request for `audio/mpeg`. That is a known deferral, not a broken token; diagnose it before assuming the link is wrong.
- [ ] Paste a made-up UUID into the same URL shape and confirm a plain 404.
- [ ] Flip `VM_LISTEN_LINK_ENABLED=false` in Render, leave one more voicemail, and confirm the alert arrives with NO link and the old link 404s. Flip it back.

## Deferred (still Phase 1b)

R2 storage with R2 as the redelivery source, transcription, the AI summary and
tag, the rich listen PAGE (transcript, soft delete), the 14-day audio purge, and
the prune's retained-audio orphan gap. Also deferred, from this spec: HTTP Range
support, and any link expiry shorter than the row prune. This design neither
creates nor deletes audio, so it moves none of them.
