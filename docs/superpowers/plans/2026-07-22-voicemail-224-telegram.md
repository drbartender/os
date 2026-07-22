# Voicemail on the 224, Delivered to Telegram: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a client calls the 224 and Zul does not answer, ping her on Telegram with the caller's number, take a voicemail, deliver the audio to the same chat, and delete the Twilio copy once delivery is confirmed.

**Architecture:** `POST /api/voice/inbound` gains an `action` URL on its existing `<Dial>`, which routes a failed dial to a new missed-call handler. That handler inserts one `voicemail_delivery` row per `CallSid`, and that single row does three jobs: it is the ping's dedup claim (primary key on `call_sid`, so a Twilio redelivery loses the insert), the rolling-24h spend window for `VM_DAILY_CAP`, and the delivery ledger that outlives the deleted recording. A second handler receives the `recordingStatusCallback`, claims delivery with a conditional UPDATE, uploads the mp3 to the bot, and deletes the recording only on an affirmative `ok === true`. Nothing caller-supplied ever reaches an outbound request: the media URL is constructed from `TWILIO_ACCOUNT_SID` plus a shape-validated `RecordingSid`, and the body's `RecordingUrl` is ignored.

**Tech Stack:** Node.js 26 / Express 4, Postgres (raw SQL via `pg`), Twilio Programmable Voice (TwiML + REST), Telegram Bot API (raw fetch, no SDK), `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-22-voicemail-224-telegram-design.md` (commit `fa95cd9a`)

## Global Constraints

- **No em dashes** in any copy or comment prose. Commas, periods, colons, parentheticals only.
- **The greeting copy is fixed** and is not to be reworded: "Thanks for calling Dr. Bartender. This is Zul. I'm not available right now. Please leave your name, your number, and the date of your event, and I'll call you right back."
- **Both new endpoints fail closed on signature in EVERY environment.** Copy the `requireSignature` shape from `server/routes/voiceLeadCall.js:62-71`. Do NOT reuse `voice.js`'s `passesSignature`, which has a dev warn-and-allow skip. The existing three handlers keep `passesSignature` unchanged.
- **`RecordingUrl` from the webhook body is never used.** The media URL is built from `TWILIO_ACCOUNT_SID` and a `RecordingSid` that matches `^RE[0-9a-f]{32}$`. `TWILIO_AUTH_TOKEN` is the HMAC key for every Twilio webhook in this app, so handing it to a caller-named host is the worst outcome in this plan.
- **The recording delete fires only on `ok === true`.** `sendTelegramMessage` and `sendTelegramAudio` never throw. `{ok:false, skipped:true}` means gated off and is its own outcome (keep the recording, no Sentry). `{ok:false}` without `skipped` is a failure (keep the recording, send the text fallback, page Sentry). A try/catch is not a success test.
- **`VOICEMAIL_ENABLED` defaults OFF.** Ships dark. `process.env.VOICEMAIL_ENABLED === 'true'` is the only thing that enables it.
- **Never fall back to `VOICE_CALLER_ID` for the caller's number.** `voice.js:91` does that for caller ID on purpose; doing it here would tell Zul to call the business's own line back. A blocked caller stores NULL.
- Money stored as integer cents is not applicable; no pricing, invoice, or payout surface is touched.
- All SQL parameterized (`$1`, `$2`). Schema statements idempotent (`IF NOT EXISTS`).
- Webhook handlers return TwiML or a bare status code and never throw `AppError`, matching `voice.js` and `voiceLeadCall.js`.
- Log every branch with the existing last-4 redaction idiom (`String(x).slice(-4)`).
- Server suites run one at a time against the shared dev DB: `node -r dotenv/config --test <file>`.
- **There is no repo-root `CLAUDE.md`.** It lives at `.claude/CLAUDE.md`. A `git add CLAUDE.md` fails with "pathspec did not match any files", and editing the real file while the footprint declares the wrong path aborts the lane on footprint drift.
- **Schema is applied by `initDb()`**, not by a standalone script. `server/db/applySchema.js` does not exist.
- `FormData` and `Blob` are **not** in the server globals allowlist in `eslint.config.mjs`, and `no-undef` is an error enforced by `.husky/pre-commit`. Task 3 adds them; without that, the multipart upload cannot be committed.
- Line cites were verified 2026-07-22. Where a cite and the code disagree by a line or two, trust the described content, not the number.

## Lane map

```yaml
lanes:
  - id: voicemail-224
    footprint:
      - server/db/schema.sql
      - server/db/schema.vaCalling.test.js
      - server/utils/voicemail.js
      - server/utils/voicemail.test.js
      - server/utils/telegram.js
      - server/utils/telegram.test.js
      - server/routes/voice.js
      - server/routes/voice.test.js
      - server/utils/pendingCall.js
      - server/utils/pendingCall.test.js
      - server/utils/vaCallingScheduler.js
      - server/utils/vaCallingScheduler.test.js
      - server/index.js
      - eslint.config.mjs
      - scripts/sensitive-paths.txt
      - .env.example
      - .claude/CLAUDE.md
      - README.md
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [security-review, database-review, code-review, consistency-check]
```

**One lane, deliberately.** Splitting this does not buy parallelism and does buy merge pain. Every candidate split either lands in `server/routes/voice.js` twice (both new handlers live in one file) or is strictly sequential (routes cannot be built before the util they call). The docs task depends on the final shape of everything else. The honest decomposition is one lane with seven sequential tasks.

Full review fleet regardless of size: `server/routes/voice.js`, `server/routes/telegram.js`, `server/utils/sms.js`, and `server/utils/twilioSignature.js` are already on `scripts/sensitive-paths.txt:47-52`, and Task 7 adds `server/utils/telegram.js` and `server/utils/voicemail.js` to it. This is a billed-voice path, so `/second-opinion` runs alongside the fleet at push.

**Task order:** 1 → 2 → 3 → 4 → 5 → 6a → 6b → 7. Tasks 1 through 3 are leaf modules with no route wiring; 4 and 5 are the handlers; 6a and 6b are maintenance; 7 is documentation.

**Task 4 and Task 5 ship together or not at all.** Task 4 emits a `recordingStatusCallback` pointing at the route Task 5 creates, so Task 4 alone leaves a live `<Record>` aimed at a 404. `VOICEMAIL_ENABLED` defaulting off means that is harmless in production, but do not revert Task 5 without reverting Task 4.

**Per-task review checkpoints.** The lane-level fleet still runs at merge; these are the mid-build checks, scoped to what each batch actually changes rather than one fleet per task:

| After | Agent | Why |
|---|---|---|
| Task 1 | `database-review` | The CHECK enum against the six statuses actually written, the PK-as-dedup-claim, the index, and the prune interaction. |
| Task 2 | `security-review` | The SSRF gate and the `TWILIO_AUTH_TOKEN` basic-auth handling. Smallest, sharpest scope in the lane. |
| Task 5 | `security-review` + `code-review` | Both handlers together, not separately: they share `_deps` and one file. |
| Task 6b | `database-review` | The sweep and prune SQL. |
| Task 7 | `consistency-check` | Docs against the code that actually landed. |

---

## Lane: voicemail-224

### Task 1: The `voicemail_delivery` ledger and its DB helpers

The table plus the four DB functions the handlers need. Everything downstream imports these, so it lands first.

**Files:**
- Modify: `server/db/schema.sql` (append after the `telegram_update` block, which ends at line 3595; the "Proposal option groups" divider is at 3597)
- Modify: `server/db/schema.vaCalling.test.js`
- Modify: `scripts/sensitive-paths.txt`
- Create: `server/utils/voicemail.js`
- Create: `server/utils/voicemail.test.js`

**Interfaces:**
- Consumes: `pool` from `server/db`.
- Produces:
  - `claimMissedCall({ callSid, fromE164 }) => Promise<boolean>` (true iff this request won the insert)
  - `countVoicemailsSince(hours) => Promise<number>`
  - `claimDelivery({ callSid, recordingSid, durationSec }) => Promise<{ fromE164: string|null }|null>` (null means already claimed or unknown call)
  - `markDelivery({ callSid, status }) => Promise<void>` (sets `delivered_at` when status is `delivered`)
  - `__setVoicemailDeps(overrides) => void`

- [ ] **Step 1: Add the table to `server/db/schema.sql`**

Append directly after the `telegram_update` table block (before the "Proposal option groups" divider):

```sql
-- voicemail_delivery: 224-inbound voicemail ledger (spec 2026-07-22). One row
-- per MISSED inbound call, inserted by /api/voice/inbound/missed. It is three
-- things at once, which is why it is a table and not a cache:
--   1. the missed-call ping's dedup claim. PK on call_sid means a Twilio
--      <Dial action> redelivery loses the INSERT and cannot double-ping.
--   2. the VM_DAILY_CAP spend window (rows in the last 24h). The inbound side
--      had no daily cap because a missed call used to cost nothing after ring
--      timeout; it now costs greeting + up to VM_MAX_LENGTH_SEC of recording.
--   3. the delivery ledger. The Twilio recording is DELETED after a confirmed
--      Telegram upload, so this row is the only surviving business record that
--      a client called.
-- from_e164 is NULL for a blocked/anonymous caller. attempts bounds the
-- scheduler's redelivery sweep.
CREATE TABLE IF NOT EXISTS voicemail_delivery (
  call_sid      TEXT PRIMARY KEY,
  from_e164     TEXT,
  recording_sid TEXT,
  duration_sec  INTEGER,
  status        TEXT NOT NULL DEFAULT 'missed'
                  CHECK (status IN ('missed','recorded','delivered','skipped','failed','empty')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- created_at is both the VM_DAILY_CAP window filter and the prune key (mirrors
-- idx_call_audit_created_at above).
CREATE INDEX IF NOT EXISTS idx_voicemail_delivery_created_at
  ON voicemail_delivery (created_at);
```

- [ ] **Step 2: Apply the schema to the dev DB**

There is no `applySchema.js`. Schema is applied by `initDb()` in `server/db/index.js`, which runs on server boot (README.md:666).

Run: `node -r dotenv/config -e "require('./server/db').initDb().then(() => process.exit(0))"`
Expected: exits 0. The statements are idempotent, so a re-run is safe.

Verify: `psql "$DATABASE_URL" -c "\d voicemail_delivery"` lists all nine columns (`call_sid`, `from_e164`, `recording_sid`, `duration_sec`, `status`, `attempts`, `delivered_at`, `created_at`) plus the index.

- [ ] **Step 2b: Extend `server/db/schema.vaCalling.test.js`**

This is not optional and it is easy to miss. That suite slices `schema.sql` from the `-- Zul VA Calling` marker (line 3526) to EOF and executes the slice in its `before()`, so the new DDL is already inside its scope the moment Step 1 lands. Add assertions in the file's existing style (a content assertion against the sliced SQL, plus an `information_schema` catalog assertion):

```js
test('voicemail_delivery is declared idempotently with the six statuses', () => {
  assert.match(vaCallingSql, /CREATE TABLE IF NOT EXISTS voicemail_delivery/);
  assert.match(vaCallingSql, /CHECK \(status IN \('missed','recorded','delivered','skipped','failed','empty'\)\)/);
  assert.match(vaCallingSql, /CREATE INDEX IF NOT EXISTS idx_voicemail_delivery_created_at/);
});

test('voicemail_delivery exists with the expected columns', async () => {
  const { rows } = await pool.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'voicemail_delivery' ORDER BY column_name`
  );
  const names = rows.map((r) => r.column_name);
  assert.deepEqual(names, [
    'attempts', 'call_sid', 'created_at', 'delivered_at',
    'duration_sec', 'from_e164', 'recording_sid', 'status',
  ]);
  assert.equal(rows.find((r) => r.column_name === 'attempts').is_nullable, 'NO');
});
```

Match the existing file's variable names for the sliced SQL and its pool handling rather than inventing new ones.

Run: `node -r dotenv/config --test server/db/schema.vaCalling.test.js`
Expected: PASS, including the pre-existing assertions.

- [ ] **Step 2c: Register the new files as sensitive**

This lands in Task 1, not at the end, so `voicemail.js` and `telegram.js` are sensitive-matched for the whole build rather than only at push. In `scripts/sensitive-paths.txt`, inside the billed-voice block (currently ending at `server/utils/sms.js`, line 52), add:

```
server/utils/telegram.js
server/utils/voicemail.js
```

`scripts/sensitive-match.js` anchors globs so they never cross `/`, and no existing `server/utils/*` glob matches either file.

Verify (this is a real red/green, the matcher is CLI-runnable and grep-style exit-coded):

Run: `node scripts/sensitive-match.js server/utils/voicemail.js server/utils/telegram.js`
Expected: before the edit, exit 1 and no output. After, exit 0 and both paths printed.

- [ ] **Step 3: Write the failing test**

Create `server/utils/voicemail.test.js`:

```js
require('dotenv').config();
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

const vm = require('./voicemail');

// Every row this suite writes uses a recognizable CallSid prefix so cleanup can
// never touch a real row in the shared dev DB.
const PREFIX = 'CAtestvm';
const sid = (n) => `${PREFIX}${String(n).padStart(24, '0')}`;

async function cleanup() {
  await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${PREFIX}%`]);
}

beforeEach(cleanup);
after(async () => { await cleanup(); await pool.end(); });

test('claimMissedCall wins once and loses on redelivery', async () => {
  const first = await vm.claimMissedCall({ callSid: sid(1), fromE164: '+13125550147' });
  const second = await vm.claimMissedCall({ callSid: sid(1), fromE164: '+13125550147' });
  assert.equal(first, true);
  assert.equal(second, false);
});

test('claimMissedCall stores NULL for a blocked caller', async () => {
  await vm.claimMissedCall({ callSid: sid(2), fromE164: null });
  const { rows } = await pool.query('SELECT from_e164, status FROM voicemail_delivery WHERE call_sid = $1', [sid(2)]);
  assert.equal(rows[0].from_e164, null);
  assert.equal(rows[0].status, 'missed');
});

test('claimDelivery returns the caller number once, then null', async () => {
  await vm.claimMissedCall({ callSid: sid(3), fromE164: '+13125550147' });
  const first = await vm.claimDelivery({ callSid: sid(3), recordingSid: 'RE' + 'a'.repeat(32), durationSec: 12 });
  const second = await vm.claimDelivery({ callSid: sid(3), recordingSid: 'RE' + 'a'.repeat(32), durationSec: 12 });
  assert.deepEqual(first, { fromE164: '+13125550147' });
  assert.equal(second, null);
});

test('claimDelivery returns null for a call that was never registered as missed', async () => {
  const result = await vm.claimDelivery({ callSid: sid(4), recordingSid: 'RE' + 'b'.repeat(32), durationSec: 5 });
  assert.equal(result, null);
});

test('markDelivery delivered stamps delivered_at; failed does not', async () => {
  await vm.claimMissedCall({ callSid: sid(5), fromE164: '+13125550147' });
  await vm.markDelivery({ callSid: sid(5), status: 'delivered' });
  let { rows } = await pool.query('SELECT status, delivered_at FROM voicemail_delivery WHERE call_sid = $1', [sid(5)]);
  assert.equal(rows[0].status, 'delivered');
  assert.ok(rows[0].delivered_at instanceof Date);

  await vm.claimMissedCall({ callSid: sid(6), fromE164: null });
  await vm.markDelivery({ callSid: sid(6), status: 'failed' });
  ({ rows } = await pool.query('SELECT status, delivered_at FROM voicemail_delivery WHERE call_sid = $1', [sid(6)]));
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].delivered_at, null);
});

test('countVoicemailsSince counts rows inside the window', async () => {
  const before = await vm.countVoicemailsSince(24);
  await vm.claimMissedCall({ callSid: sid(7), fromE164: '+13125550147' });
  const after = await vm.countVoicemailsSince(24);
  assert.equal(after, before + 1);
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: FAIL, `Cannot find module './voicemail'`.

- [ ] **Step 5: Write `server/utils/voicemail.js` (ledger half)**

```js
// server/utils/voicemail.js
//
// 224-inbound voicemail: the delivery ledger and the Twilio media calls. Split
// out of server/routes/voice.js so the route file stays a thin webhook layer
// (CLAUDE.md file-size discipline) and so every DB and network effect is
// injectable in tests.
//
// SECURITY NOTE (spec section 4): nothing caller-supplied ever reaches an
// outbound request. The media URL is CONSTRUCTED from TWILIO_ACCOUNT_SID plus a
// shape-validated RecordingSid; the RecordingUrl in the webhook body is ignored
// entirely. TWILIO_AUTH_TOKEN is the HMAC key for every Twilio webhook in this
// app, so a forged callback pointing our basic auth at an attacker host would
// compromise the whole billed-voice surface.

const { pool } = require('../db');

// Dependency seam for tests (mirror server/utils/sms.js __setSmsDeps).
let _deps = { pool };
function __setVoicemailDeps(d) { _deps = { ..._deps, ...d }; }

/**
 * Register a missed inbound call. The INSERT is also the missed-call ping's
 * dedup claim: Twilio delivers <Dial action> at least once, so only the request
 * that wins the PK may ping and offer a recording.
 * @returns {Promise<boolean>} true iff this caller won the claim.
 */
async function claimMissedCall({ callSid, fromE164 }) {
  const { rows } = await _deps.pool.query(
    `INSERT INTO voicemail_delivery (call_sid, from_e164)
     VALUES ($1, $2)
     ON CONFLICT (call_sid) DO NOTHING
     RETURNING call_sid`,
    [callSid, fromE164 ?? null]
  );
  return rows.length > 0;
}

/**
 * Rolling-window row count backing VM_DAILY_CAP. Counts every missed call in
 * the window regardless of outcome, because the cost being capped (greeting +
 * recording) is incurred at offer time, not at delivery time.
 */
async function countVoicemailsSince(hours) {
  const { rows } = await _deps.pool.query(
    `SELECT COUNT(*)::int AS n FROM voicemail_delivery
      WHERE created_at > NOW() - ($1 || ' hours')::interval`,
    [String(hours)]
  );
  return rows[0].n;
}

/**
 * Claim the right to deliver this recording, and read back the caller number in
 * the same round trip (the recording status callback does not carry `From`).
 * The status guard makes this idempotent under at-least-once redelivery and
 * under the scheduler's redelivery sweep.
 * @returns {Promise<{fromE164: string|null}|null>} null if already claimed past
 *   the retryable states, or if the call was never registered as missed.
 */
async function claimDelivery({ callSid, recordingSid, durationSec }) {
  const { rows } = await _deps.pool.query(
    `UPDATE voicemail_delivery
        SET status = 'recorded',
            recording_sid = $1,
            duration_sec = $2,
            attempts = attempts + 1
      WHERE call_sid = $3
        AND status IN ('missed', 'recorded')
      RETURNING from_e164`,
    [recordingSid, Number.isFinite(durationSec) ? durationSec : null, callSid]
  );
  return rows.length > 0 ? { fromE164: rows[0].from_e164 } : null;
}

/** Terminal (or resting) status write. `delivered` also stamps delivered_at. */
async function markDelivery({ callSid, status }) {
  await _deps.pool.query(
    `UPDATE voicemail_delivery
        SET status = $1,
            delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END
      WHERE call_sid = $2`,
    [status, callSid]
  );
}

module.exports = {
  claimMissedCall,
  countVoicemailsSince,
  claimDelivery,
  markDelivery,
  __setVoicemailDeps,
};
```

The status guard is exactly `('missed','recorded')`. It deliberately does **not** include `'failed'`: Task 6b's sweep queries `voicemail_delivery` directly and never calls `claimDelivery`, so widening it would buy nothing and would let a late duplicate webhook re-enter delivery on a row the sweep already owns, double-uploading the audio. Everything else is terminal and returns null.

- [ ] **Step 6: Run the test to confirm it passes**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.sql server/db/schema.vaCalling.test.js \
        server/utils/voicemail.js server/utils/voicemail.test.js \
        scripts/sensitive-paths.txt
git commit -m "feat(voicemail): voicemail_delivery ledger + claim helpers"
```

---

### Task 2: Twilio media helpers (construct, fetch, delete)

The half of `voicemail.js` that talks to Twilio. Kept separate from Task 1 because a reviewer could reasonably approve the ledger and reject the media handling, and because this is where the SSRF defense lives.

**Files:**
- Modify: `server/utils/voicemail.js`
- Modify: `server/utils/voicemail.test.js`

**Interfaces:**
- Consumes: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` from env; the `twilio` SDK.
- Produces:
  - `isRecordingSid(value) => boolean`
  - `recordingMediaUrl(recordingSid) => string` (throws on a bad sid or missing account sid)
  - `fetchRecordingMp3(recordingSid) => Promise<Buffer>` (throws on permanent or exhausted failure)
  - `deleteRecording(recordingSid) => Promise<boolean>` (never throws)

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/voicemail.test.js`:

```js
const GOOD_SID = 'RE' + 'a1b2c3d4'.repeat(4);

test('isRecordingSid accepts the Twilio shape and rejects everything else', () => {
  assert.equal(vm.isRecordingSid(GOOD_SID), true);
  assert.equal(vm.isRecordingSid('RE' + 'A1B2C3D4'.repeat(4)), false, 'uppercase hex is not Twilio shape');
  assert.equal(vm.isRecordingSid('CA' + 'a1b2c3d4'.repeat(4)), false, 'wrong prefix');
  assert.equal(vm.isRecordingSid(GOOD_SID + 'a'), false, 'too long');
  assert.equal(vm.isRecordingSid('../../Accounts/AC1/Recordings/RE1'), false);
  assert.equal(vm.isRecordingSid(''), false);
  assert.equal(vm.isRecordingSid(undefined), false);
});

test('recordingMediaUrl is built from env, never from caller input', () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  const url = vm.recordingMediaUrl(GOOD_SID);
  assert.equal(
    url,
    `https://api.twilio.com/2010-04-01/Accounts/ACtest0000000000000000000000000000/Recordings/${GOOD_SID}.mp3`
  );
});

test('recordingMediaUrl refuses a malformed sid', () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  assert.throws(() => vm.recordingMediaUrl('https://evil.example/x'), /RecordingSid/);
});

test('fetchRecordingMp3 retries a 404 then succeeds', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  let n = 0;
  vm.__setVoicemailDeps({
    fetch: async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('ID3audio').buffer };
    },
    sleep: async () => {},
  });
  const buf = await vm.fetchRecordingMp3(GOOD_SID);
  assert.equal(n, 2);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'ID3audio');
  vm.__setVoicemailDeps({ fetch: (...a) => globalThis.fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
});

test('fetchRecordingMp3 does not retry a 401', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  let n = 0;
  vm.__setVoicemailDeps({
    fetch: async () => { n += 1; return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) }; },
    sleep: async () => {},
  });
  await assert.rejects(() => vm.fetchRecordingMp3(GOOD_SID), /401/);
  assert.equal(n, 1, 'a credential failure must not be retried');
  vm.__setVoicemailDeps({ fetch: (...a) => globalThis.fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
});

test('deleteRecording never throws and reports failure', async () => {
  vm.__setVoicemailDeps({
    client: { recordings: () => ({ remove: async () => { throw new Error('boom'); } }) },
  });
  assert.equal(await vm.deleteRecording(GOOD_SID), false);
  vm.__setVoicemailDeps({
    client: { recordings: () => ({ remove: async () => true }) },
  });
  assert.equal(await vm.deleteRecording(GOOD_SID), true);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: FAIL, `vm.isRecordingSid is not a function`.

- [ ] **Step 3: Add the media half to `server/utils/voicemail.js`**

Add near the top, after the `pool` require:

```js
const twilio = require('twilio');

// Twilio recording SIDs are 'RE' + 32 lowercase hex. Anchored, so nothing with a
// path separator, a scheme, or a traversal segment can pass.
const RECORDING_SID_RE = /^RE[0-9a-f]{32}$/;

// A recording is occasionally not fetchable for a beat after its status
// callback fires. Bounded retry on 404 only.
const MEDIA_FETCH_TIMEOUT_MS = 10000;
const MEDIA_FETCH_ATTEMPTS = 3;
const MEDIA_RETRY_BACKOFF_MS = 1500;

const client = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
```

**Replace** the existing `let _deps = { pool };` declaration from Task 1 (do not paste a second `let _deps`, which is a duplicate-declaration `SyntaxError`):

```js
let _deps = {
  pool,
  client,
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
```

The media fetch is a plain authenticated GET, not an SDK call. `client.recordings(sid).fetch()` returns the recording's metadata, not its audio bytes, so there is no SDK path to the mp3. The SDK client is used for the delete below, where it is the right tool. (Spec revision 3 corrects this; revision 2 said to use the SDK for both.)

Then add the functions before `module.exports`:

```js
/** Anchored shape check. The ONLY gate between a webhook body and a URL. */
function isRecordingSid(value) {
  return typeof value === 'string' && RECORDING_SID_RE.test(value);
}

/**
 * Build the media URL ourselves. The webhook body's RecordingUrl is deliberately
 * never consulted: see the SECURITY NOTE at the top of this file.
 */
function recordingMediaUrl(recordingSid) {
  if (!isRecordingSid(recordingSid)) throw new Error('invalid RecordingSid');
  const account = process.env.TWILIO_ACCOUNT_SID;
  if (!account) throw new Error('TWILIO_ACCOUNT_SID not set');
  return `https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${recordingSid}.mp3`;
}

/**
 * Fetch the recording as a Buffer using the account's basic auth against the
 * URL we constructed. 404 is the known just-after-callback race and is retried;
 * 401/403 are credential problems and are not. Throws on permanent or exhausted
 * failure so the caller can take the failure path (keep the recording, alert).
 */
async function fetchRecordingMp3(recordingSid) {
  const url = recordingMediaUrl(recordingSid);
  const auth = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  let lastStatus = 0;
  for (let attempt = 1; attempt <= MEDIA_FETCH_ATTEMPTS; attempt += 1) {
    const res = await _deps.fetch(url, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    lastStatus = res.status;
    if (res.status !== 404) break;
    if (attempt < MEDIA_FETCH_ATTEMPTS) await _deps.sleep(MEDIA_RETRY_BACKOFF_MS * attempt);
  }
  throw new Error(`recording fetch failed (${lastStatus}) sid=...${String(recordingSid).slice(-4)}`);
}

/**
 * Delete the recording from Twilio. Called ONLY after a confirmed delivery, so
 * a failure here is cosmetic (the ledger already records delivery and nothing
 * re-sends). Never throws.
 * @returns {Promise<boolean>} true iff Twilio accepted the delete.
 */
async function deleteRecording(recordingSid) {
  if (!isRecordingSid(recordingSid)) return false;
  if (!_deps.client) {
    console.log(`[voicemail] delete skipped (Twilio creds not set) sid=...${String(recordingSid).slice(-4)}`);
    return false;
  }
  try {
    await _deps.client.recordings(recordingSid).remove();
    console.log(`[voicemail] recording deleted sid=...${String(recordingSid).slice(-4)}`);
    return true;
  } catch (err) {
    console.error(`[voicemail] recording delete failed sid=...${String(recordingSid).slice(-4)}: ${err.message}`);
    return false;
  }
}
```

Add all four to `module.exports`.

- [ ] **Step 4: Run to confirm pass**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/voicemail.js server/utils/voicemail.test.js
git commit -m "feat(voicemail): Twilio media fetch/delete with constructed URLs"
```

---

### Task 3: `sendTelegramAudio`, and a timeout on every Bot API call

**Files:**
- Modify: `eslint.config.mjs`
- Modify: `server/utils/telegram.js`
- Modify: `server/utils/telegram.test.js`

**Interfaces:**
- Produces: `sendTelegramAudio(chatId, audioBuffer, { filename, caption }) => Promise<object>` returning the same three-outcome contract as `sendTelegramMessage`: `{ok:true,...}` on success, `{ok:false, skipped:true}` when gated or tokenless, `{ok:false, ...}` on any error.

The timeout matters beyond this feature: `sendTelegramMessage` currently uses a bare `fetch` with no timeout, and Task 4 calls it on a path where a hung Bot API would otherwise hold a live caller in dead air. Adding it here also bounds the existing VA-calling sends, which is a behavior change the review fleet should see.

- [ ] **Step 1a: Unblock the lint first**

`eslint.config.mjs` lists `fetch`, `AbortSignal`, `TextEncoder`, and `URL` in the `server/**/*.js` globals, but **not** `FormData` or `Blob`. `no-undef` is `"error"` and `.husky/pre-commit` runs `npx lint-staged` into eslint, so the upload code below cannot be committed until both are added. Add them alongside the existing entries.

Verify: `npx eslint server/utils/telegram.js`
Expected: 0 problems. Before the config edit, the same command reports `'FormData' is not defined` and `'Blob' is not defined`.

- [ ] **Step 1b: Write the failing tests**

`server/utils/telegram.test.js:4-10` destructures named exports and has **no** `telegram` binding, so `telegram.sendTelegramAudio(...)` would throw `ReferenceError`. Add `sendTelegramAudio` to that destructure and call the functions bare. The file's convention is `try { ... } finally { __setTelegramDeps({ fetch: globalThis.fetch }); restoreEnv(); }` (see `telegram.test.js:71-78`, `:125-126`, `:146-147`); match it so injected deps and `TELEGRAM_BOT_TOKEN` do not leak into later tests.

Append to `server/utils/telegram.test.js`, in that style:

```js
test('sendTelegramAudio returns skipped when notifications are gated off', async () => {
  const restoreEnv = setEnv({ TELEGRAM_BOT_TOKEN: 'tok' });
  try {
    __setTelegramDeps({
      notificationsEnabled: () => false,
      fetch: async () => { throw new Error('must not be called'); },
    });
    const result = await sendTelegramAudio(123, Buffer.from('x'), { caption: 'c' });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a), notificationsEnabled });
    restoreEnv();
  }
});

test('sendTelegramAudio posts multipart and returns the Bot API envelope', async () => {
  const restoreEnv = setEnv({ TELEGRAM_BOT_TOKEN: 'tok' });
  let seen = null;
  try {
    __setTelegramDeps({
      notificationsEnabled: () => true,
      fetch: async (url, opts) => {
        seen = { url, body: opts.body, hasSignal: Boolean(opts.signal) };
        return { json: async () => ({ ok: true, result: { message_id: 9 } }) };
      },
    });
    const result = await sendTelegramAudio(123, Buffer.from('ID3'), { caption: 'from +13125550147' });
    assert.equal(result.ok, true);
    assert.match(seen.url, /\/bottok\/sendAudio$/);
    assert.ok(seen.body instanceof FormData);
    assert.equal(seen.body.get('chat_id'), '123');
    assert.equal(seen.body.get('caption'), 'from +13125550147');
    assert.ok(seen.hasSignal, 'the Bot API call must be bounded by a timeout');
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a), notificationsEnabled });
    restoreEnv();
  }
});

test('sendTelegramAudio never throws on a network error', async () => {
  const restoreEnv = setEnv({ TELEGRAM_BOT_TOKEN: 'tok' });
  try {
    __setTelegramDeps({
      notificationsEnabled: () => true,
      fetch: async () => { throw new Error('socket hang up'); },
    });
    const result = await sendTelegramAudio(123, Buffer.from('x'), {});
    assert.equal(result.ok, false);
    assert.match(result.error, /socket hang up/);
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a), notificationsEnabled });
    restoreEnv();
  }
});

test('sendTelegramMessage passes an abort signal', async () => {
  const restoreEnv = setEnv({ TELEGRAM_BOT_TOKEN: 'tok' });
  let hasSignal = false;
  try {
    __setTelegramDeps({
      notificationsEnabled: () => true,
      fetch: async (url, opts) => { hasSignal = Boolean(opts.signal); return { json: async () => ({ ok: true }) }; },
    });
    await sendTelegramMessage(123, 'hi');
    assert.ok(hasSignal);
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a), notificationsEnabled });
    restoreEnv();
  }
});
```

`setEnv` / `restoreEnv` and the deps-restore idiom above are whatever the existing file already uses (`telegram.test.js:71-78`). Match the real helper names in that file rather than introducing these if they differ.

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/utils/telegram.test.js`
Expected: FAIL, `telegram.sendTelegramAudio is not a function`.

- [ ] **Step 3: Implement**

In `server/utils/telegram.js`, add the constant near `TELEGRAM_API`:

```js
// Bot API calls are bounded: sendTelegramMessage is called from a live Twilio
// webhook (server/routes/voice.js missed-call ping), where an unbounded fetch
// against a hung Bot API would hold a real caller in dead air until Twilio's
// webhook deadline and they would get no greeting at all.
const TELEGRAM_TIMEOUT_MS = 8000;
```

Add `signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)` to the existing `fetch` options inside `sendTelegramMessage` (currently `telegram.js:36-40`). Leave `setTelegramWebhook` and `getTelegramWebhookInfo` alone; they run on a scheduler with nobody waiting.

Then add:

```js
/**
 * Send an audio file (a voicemail mp3) to a chat. Same three-outcome contract as
 * sendTelegramMessage, and the same gating: no token or gated notifications
 * means log and skip, never a network call. Never throws.
 *
 * sendAudio (not sendVoice) because Twilio hands us mp3 and sendVoice wants
 * OGG/OPUS; sendAudio plays inline in the chat with no transcoding on our side.
 *
 * @param {number|string} chatId
 * @param {Buffer} audioBuffer
 * @param {{filename?: string, caption?: string}} [opts]
 * @returns {Promise<object>} Bot API JSON, or { ok:false, skipped:true } when gated.
 */
async function sendTelegramAudio(chatId, audioBuffer, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !_deps.notificationsEnabled()) {
    const why = !token ? 'TELEGRAM_BOT_TOKEN not set' : 'notifications gated off';
    console.log(`[DEV] Telegram audio skipped (${why}) → chat ${last4(chatId)} | ${audioBuffer ? audioBuffer.length : 0} bytes`);
    return { ok: false, skipped: true };
  }
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (opts.caption) form.append('caption', opts.caption);
    form.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), opts.filename || 'voicemail.mp3');
    const res = await _deps.fetch(`${TELEGRAM_API}/bot${token}/sendAudio`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      console.error(`[telegram] sendAudio failed → chat ${last4(chatId)}: ${data.description || res.status}`);
    }
    return data;
  } catch (err) {
    console.error(`[telegram] sendAudio error → chat ${last4(chatId)}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
```

Add `sendTelegramAudio` to `module.exports`.

- [ ] **Step 4: Run to confirm pass**

Run: `node -r dotenv/config --test server/utils/telegram.test.js`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs server/utils/telegram.js server/utils/telegram.test.js
git commit -m "feat(telegram): sendTelegramAudio + bounded Bot API sends"
```

This commit deliberately carries two things: the new function, and an `AbortSignal` timeout on the already-shipped `sendTelegramMessage`. They are one revert unit on purpose. The timeout exists *because* Task 4 calls `sendTelegramMessage` from a live caller's webhook, so reverting it independently would silently reintroduce the dead-air failure mode.

---

### Task 4: The missed-call handler and the `<Dial>` action URL

**Files:**
- Modify: `server/routes/voice.js`
- Modify: `server/routes/voice.test.js`

**Interfaces:**
- Consumes: `claimMissedCall`, `countVoicemailsSince` (Task 1); `sendTelegramMessage` (existing); `API_URL` from `server/utils/urls.js`.
- Produces: `POST /api/voice/inbound/missed`, and the `action` attribute on the existing `<Dial>`.

- [ ] **Step 1: Write the failing tests**

Add to `server/routes/voice.test.js`. Extend the `beforeEach` dep injection with the new deps and env:

```js
  process.env.VOICEMAIL_ENABLED = 'true';
  process.env.VM_MAX_LENGTH_SEC = '120';
  process.env.VM_DAILY_CAP = '50';
  router.__setVoiceDeps({
    claimMissedCall: async (args) => { calls.claims.push(args); return true; },
    countVoicemailsSince: async () => 0,
  });
```

(add `claims: []` to the `calls` reset object), then:

```js
test('inbound Dial carries the missed-call action URL', async () => {
  const res = await post('/api/voice/inbound', { From: '+13125550147', CallSid: 'CA1' });
  assert.match(res.text, /action="[^"]*\/api\/voice\/inbound\/missed"/);
  assert.match(res.text, /method="POST"/);
});

test('an answered call pings nobody and returns no Record', async () => {
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'completed', CallSid: 'CA2', From: '+13125550147' });
  assert.match(res.text, /<Hangup\/>/);
  assert.doesNotMatch(res.text, /<Record/);
  assert.equal(calls.telegram.length, 0);
});

test('an unrecognized DialCallStatus takes the cheap branch', async () => {
  for (const DialCallStatus of ['', 'in-progress', 'banana', undefined]) {
    calls.telegram.length = 0;
    const res = await post('/api/voice/inbound/missed', { DialCallStatus: DialCallStatus ?? '', CallSid: 'CA3', From: '+13125550147' });
    assert.doesNotMatch(res.text, /<Record/, `status ${DialCallStatus} must not record`);
    assert.equal(calls.telegram.length, 0);
  }
});

test('a missed call returns the greeting and Record, and pings twice', async () => {
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: 'CA4', From: '+13125550147' });
  assert.match(res.text, /This is Zul/);
  assert.match(res.text, /<Record[^>]*maxLength="120"/);
  assert.match(res.text, /recordingStatusCallback="[^"]*\/api\/voice\/inbound\/voicemail"/);
  assert.doesNotMatch(res.text, /action="[^"]*inbound\/voicemail"/, 'Record must NOT carry an action attribute');
  await new Promise((r) => setTimeout(r, 20)); // ping fires after the response
  assert.equal(calls.telegram.length, 2);
  assert.equal(calls.telegram[1].text, '+13125550147', 'the number must be alone in its own message');
  assert.doesNotMatch(calls.telegram[0].text, /\+13125550147/);
});

test('a blocked caller records, stores NULL, and sends only the prose message', async () => {
  for (const From of ['', '+266696687']) {
    calls.telegram.length = 0; calls.claims.length = 0;
    const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: `CA5${From}`, From });
    assert.match(res.text, /<Record/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.claims[0].fromE164, null, 'a blocked caller must be stored as NULL');
    assert.equal(calls.telegram.length, 1);
    assert.doesNotMatch(calls.telegram[0].text, /\+12242220082/, 'never fall back to VOICE_CALLER_ID');
  }
});

test('a non-NANP caller is named in the prose and gets no bare-number message', async () => {
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: 'CA5b', From: '+442071838750' });
  assert.match(res.text, /<Record/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.telegram.length, 1, 'the bridge cannot dial it, so no copy-paste message');
  assert.match(calls.telegram[0].text, /\+442071838750/, 'she must still learn who called');
  assert.doesNotMatch(calls.telegram[0].text, /Number follows/);
});

test('a lost claim (Twilio redelivery) pings nobody', async () => {
  router.__setVoiceDeps({ claimMissedCall: async () => false });
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: 'CA6', From: '+13125550147' });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(res.text, /<Hangup\/>/);
  assert.doesNotMatch(res.text, /<Record/);
  assert.equal(calls.telegram.length, 0);
});

test('VOICEMAIL_ENABLED=false restores the pre-feature behavior', async () => {
  process.env.VOICEMAIL_ENABLED = 'false';
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: 'CA7', From: '+13125550147' });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(res.text, /<Hangup\/>/);
  assert.doesNotMatch(res.text, /<Record/);
  assert.equal(calls.telegram.length, 0);
});

test('VM_DAILY_CAP exceeded records nothing and pings nobody', async () => {
  router.__setVoiceDeps({ countVoicemailsSince: async () => 51 });
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: 'CA8', From: '+13125550147' });
  await new Promise((r) => setTimeout(r, 20));
  assert.doesNotMatch(res.text, /<Record/);
  assert.equal(calls.telegram.length, 0);
});

test('the missed handler fails closed on a bad signature with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  const res = await post('/api/voice/inbound/missed', { DialCallStatus: 'no-answer', CallSid: 'CA9', From: '+13125550147' });
  assert.equal(res.status, 403);
  if (saved !== undefined) process.env.NODE_ENV = saved;
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: FAIL, the action-URL assertion and 404s on the new path.

- [ ] **Step 3: Implement in `server/routes/voice.js`**

Add near the top:

```js
const { API_URL } = require('../utils/urls');
const voicemail = require('../utils/voicemail');

// Same four values as DEAD_STATUSES at voice.js:11, kept as a separate constant
// on purpose: that one reads Twilio's CallStatus on an outbound leg, this one
// reads DialCallStatus on an inbound dial. Merging them would couple two
// unrelated webhooks to one list.
const MISSED_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);
// Twilio's anonymous-caller sentinel, plus the string forms some carriers send.
const ANONYMOUS_FROM = new Set(['+266696687', 'anonymous', 'restricted', 'unavailable']);
const HANGUP_TWIML = '<Response><Hangup/></Response>';

// Own limiter: the /inbound flood cap above is route-level middleware on
// /inbound only, and server/index.js mounts no global /api limiter, so these
// endpoints would otherwise be unthrottled.
//
// Keyed by CallSid, NOT globally. These two endpoints are only reachable as a
// consequence of an inbound call that already passed the global 30/min cap at
// /inbound, and the real spend controls are that cap plus VM_DAILY_CAP. A
// global key here would instead make one busy minute starve the delivery
// webhook of a DIFFERENT call, dropping a voicemail that was already paid for.
// Per-CallSid bounds webhook redelivery storms, which is the actual threat.
const voicemailWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => String((req.body && req.body.CallSid) || 'unknown'),
  handler: (req, res) => res.status(429).end(),
});

function voicemailEnabled() { return process.env.VOICEMAIL_ENABLED === 'true'; }
function vmMaxLengthSec() {
  const n = parseInt(process.env.VM_MAX_LENGTH_SEC, 10);
  return Math.min(300, Math.max(30, Number.isFinite(n) ? n : 120));
}
function vmDailyCap() {
  const n = parseInt(process.env.VM_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

/**
 * Fail-closed signature gate for the voicemail webhooks. Copied from
 * server/routes/voiceLeadCall.js:62-71 rather than reusing passesSignature
 * above: these endpoints record client voice, incur per-minute spend, and make
 * a DESTRUCTIVE Twilio API call, so there is no dev warn-and-allow path.
 */
function requireSignature(req, res, tag) {
  if (_deps.isValidTwilioRequest(req)) return true;
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('Twilio voicemail webhook signature failure', {
      level: 'warning', tags: { webhook: 'twilio-voice', route: tag, reason: 'invalid_signature' },
    });
  }
  res.status(403).send('Invalid signature');
  return false;
}

/** Strict E.164, minus the anonymous sentinels. NULL means caller ID withheld. */
function callerE164(raw) {
  const v = String(raw || '').trim();
  if (!v || ANONYMOUS_FROM.has(v)) return null;
  return /^\+[1-9]\d{6,14}$/.test(v) ? v : null;
}

function chicagoTime(d = new Date()) {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
```

**Replace** the existing `let _deps = { ... }` at `server/routes/voice.js:41` with the version below (pasting a second `let _deps` is a duplicate-declaration `SyntaxError`). Note `router.__setVoiceDeps` merges rather than replaces (`{ ..._deps, ...d }`), so per-test overrides layer over the `beforeEach` baseline:

```js
let _deps = {
  isValidTwilioRequest, lookupTargetByCallSid, claimDeadLegAudit, releaseDeadLegAudit, sendTelegramMessage,
  sendTelegramAudio: require('../utils/telegram').sendTelegramAudio,
  claimMissedCall: voicemail.claimMissedCall,
  countVoicemailsSince: voicemail.countVoicemailsSince,
  claimDelivery: voicemail.claimDelivery,
  markDelivery: voicemail.markDelivery,
  fetchRecordingMp3: voicemail.fetchRecordingMp3,
  deleteRecording: voicemail.deleteRecording,
  isRecordingSid: voicemail.isRecordingSid,
};
```

Add `action` to the existing `/inbound` `<Dial>` (currently `voice.js:93-96`):

```js
  sendTwiml(
    res,
    `<Response><Dial timeout="20" action="${API_URL}/api/voice/inbound/missed" method="POST" callerId="${xmlEscape(caller)}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(vaCell)}</Number></Dial></Response>`
  );
```

Then the handler:

```js
/**
 * POST /api/voice/inbound/missed — the <Dial> action callback. Twilio requests
 * this when the dialed leg ends, whatever the outcome.
 *
 * Ordering is load-bearing: the TwiML response is sent BEFORE the Telegram ping.
 * The ping is a network call to a third party, and awaiting it inline would hold
 * a live client in dead air until Twilio's webhook deadline, after which they
 * would get no greeting at all. A notification outage must never become a
 * caller-facing outage.
 */
router.post('/inbound/missed', voicemailWebhookLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'inbound/missed')) return;

  const status = req.body.DialCallStatus;
  const callSid = req.body.CallSid || null;

  // Cheap branch is the default: only an explicitly recognized miss costs money.
  if (!voicemailEnabled() || !MISSED_STATUSES.has(status) || !callSid) {
    sendTwiml(res, HANGUP_TWIML);
    return;
  }

  const fromE164 = callerE164(req.body.From);

  // The INSERT is the ping's dedup claim: Twilio delivers this callback at least
  // once, so only the winner may ping and offer a recording.
  let claimed = false;
  try {
    claimed = await _deps.claimMissedCall({ callSid, fromE164 });
  } catch (err) {
    // No ledger means no dedup and no spend cap. Refuse to record (the money
    // decision) but still alert best-effort (the lead decision).
    console.error(`[voice/missed] claim failed sid=...${String(callSid).slice(-4)}: ${err.message}`);
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { webhook: 'twilio-voice', route: 'inbound/missed' } });
    sendTwiml(res, HANGUP_TWIML);
    pingMissed(fromE164);
    return;
  }
  if (!claimed) {
    console.log(`[voice/missed] duplicate callback sid=...${String(callSid).slice(-4)}`);
    sendTwiml(res, HANGUP_TWIML);
    return;
  }

  // Daily spend cap. Fails CLOSED: if the count cannot be read we do not record.
  let recent = Infinity;
  try {
    recent = await _deps.countVoicemailsSince(24);
  } catch (err) {
    console.error(`[voice/missed] daily cap read failed: ${err.message}`);
  }
  if (recent > vmDailyCap()) {
    console.warn(`[voice/missed] VM_DAILY_CAP tripped (${recent}) sid=...${String(callSid).slice(-4)}`);
    sendTwiml(res, HANGUP_TWIML);
    return;
  }

  const greeting = "Thanks for calling Dr. Bartender. This is Zul. I'm not available right now. Please leave your name, your number, and the date of your event, and I'll call you right back.";
  sendTwiml(
    res,
    `<Response>`
    + `<Say voice="Polly.Joanna-Neural">${xmlEscape(greeting)}</Say>`
    + `<Record maxLength="${vmMaxLengthSec()}" playBeep="true" trim="trim-silence" finishOnKey="#"`
    + ` recordingStatusCallback="${API_URL}/api/voice/inbound/voicemail"`
    + ` recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>`
    + `<Hangup/>`
    + `</Response>`
  );

  pingMissed(fromE164);
});

/**
 * Two messages on purpose. server/routes/telegram.js:205 runs toUsE164 over the
 * WHOLE message text and normalizePhone strips non-digits, so any stray digit in
 * the prose would break Zul's copy-paste-then-y callback. The number therefore
 * gets a message to itself, and only for NANP numbers, which are the only ones
 * the bridge can dial.
 */
function pingMissed(fromE164) {
  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!allowed) return;
  const when = chicagoTime();

  // Three branches, not two. The bridge can only dial NANP numbers, so only a
  // NANP caller gets the bare-number second message. A non-NANP caller still
  // has to be NAMED somewhere, otherwise the prose promises a number that never
  // arrives and she never learns who called.
  const isNanp = Boolean(fromE164) && /^\+1[2-9]\d{9}$/.test(fromE164);
  let prose;
  if (isNanp) {
    prose = `Missed call on the business line, ${when}. Number follows, send it back to me to call them.`;
  } else if (fromE164) {
    prose = `Missed call on the business line, ${when}, from ${fromE164}. That is not a US number, so I cannot dial it for you.`;
  } else {
    prose = `Missed call on the business line, ${when}. Caller ID was withheld.`;
  }

  Promise.resolve()
    .then(async () => {
      await _deps.sendTelegramMessage(allowed, prose);
      if (isNanp) await _deps.sendTelegramMessage(allowed, fromE164);
    })
    .catch((err) => console.error(`[voice/missed] ping failed: ${err.message}`));
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/voice.js server/routes/voice.test.js
git commit -m "feat(voicemail): missed-call handler, ping, and Dial action URL"
```

---

### Task 5: The recording-delivery handler

**Files:**
- Modify: `server/routes/voice.js`
- Modify: `server/routes/voice.test.js`

**Interfaces:**
- Consumes: `claimDelivery`, `markDelivery`, `fetchRecordingMp3`, `deleteRecording`, `isRecordingSid` (Tasks 1 and 2); `sendTelegramAudio`, `sendTelegramMessage` (Task 3).
- Produces: `POST /api/voice/inbound/voicemail`.

- [ ] **Step 1: Write the failing tests**

Extend the `beforeEach` deps:

```js
    claimDelivery: async (args) => { calls.deliveryClaims.push(args); return { fromE164: '+13125550147' }; },
    markDelivery: async (args) => { calls.marks.push(args); },
    fetchRecordingMp3: async (sid) => { calls.fetches.push(sid); return Buffer.from('ID3'); },
    deleteRecording: async (sid) => { calls.deletes.push(sid); return true; },
    sendTelegramAudio: async (chatId, buf, opts) => { calls.audio.push({ chatId, len: buf.length, opts }); return { ok: true }; },
```

(add `deliveryClaims: [], marks: [], fetches: [], deletes: [], audio: [], sentry: []` to the reset object).

The skipped-versus-failed distinction is the whole point of the three-outcome contract, and the only observable difference between them is whether Sentry is paged. So Sentry must be injectable too. Add to the module's `_deps` a `captureMessage: (...a) => Sentry.captureMessage(...a)` and a `captureException: (...a) => Sentry.captureException(...a)`, route the two new handlers' Sentry calls through them, and stub both in `beforeEach` with `(msg) => { calls.sentry.push(msg); }`. Leave the pre-existing handlers' direct `Sentry` calls alone.

Then:

```js
const GOOD_RE = 'RE' + 'a1b2c3d4'.repeat(4);
const settle = () => new Promise((r) => setTimeout(r, 30));

test('a delivered voicemail uploads then deletes the recording', async () => {
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB1', RecordingDuration: '14',
  });
  assert.equal(res.status, 204);
  await settle();
  assert.equal(calls.audio.length, 1);
  assert.match(calls.audio[0].opts.caption, /\+13125550147/);
  assert.deepEqual(calls.deletes, [GOOD_RE]);
  assert.equal(calls.marks.at(-1).status, 'delivered');
});

test('a duplicate callback delivers exactly once', async () => {
  router.__setVoiceDeps({ claimDelivery: async () => null });
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB2', RecordingDuration: '14',
  });
  assert.equal(res.status, 204);
  await settle();
  assert.equal(calls.audio.length, 0);
  assert.equal(calls.deletes.length, 0);
});

test('a non-completed RecordingStatus never fetches', async () => {
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'failed', RecordingSid: GOOD_RE, CallSid: 'CB3', RecordingDuration: '14',
  });
  assert.equal(res.status, 204);
  await settle();
  assert.equal(calls.fetches.length, 0);
});

test('a malformed or foreign RecordingSid never fetches', async () => {
  for (const RecordingSid of ['', 'RE-nope', '../../Accounts/AC1/Recordings/RE1', 'RE' + 'A'.repeat(32)]) {
    calls.fetches.length = 0;
    const res = await post('/api/voice/inbound/voicemail', {
      RecordingStatus: 'completed', RecordingSid, CallSid: 'CB4', RecordingDuration: '14',
    });
    assert.equal(res.status, 204);
    await settle();
    assert.equal(calls.fetches.length, 0, `sid ${RecordingSid} must not be fetched`);
  }
});

test('a body-supplied RecordingUrl is ignored entirely', async () => {
  const res = await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB5', RecordingDuration: '14',
    RecordingUrl: 'https://evil.example/steal',
  });
  assert.equal(res.status, 204);
  await settle();
  assert.deepEqual(calls.fetches, [GOOD_RE], 'fetch takes a SID, never a URL');
});

test('a short or unparseable recording is dropped and deleted, never uploaded', async () => {
  for (const RecordingDuration of ['1', '0', '', 'banana']) {
    calls.audio.length = 0; calls.deletes.length = 0; calls.marks.length = 0;
    await post('/api/voice/inbound/voicemail', {
      RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB6', RecordingDuration,
    });
    await settle();
    assert.equal(calls.audio.length, 0, `duration ${RecordingDuration} must not upload`);
    assert.deepEqual(calls.deletes, [GOOD_RE]);
    assert.equal(calls.marks.at(-1).status, 'empty');
  }
});

test('a gated (skipped) send keeps the recording and never pages Sentry', async () => {
  router.__setVoiceDeps({ sendTelegramAudio: async () => ({ ok: false, skipped: true }) });
  await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB7', RecordingDuration: '14',
  });
  await settle();
  assert.equal(calls.deletes.length, 0, 'a skipped send must never delete the only copy');
  assert.equal(calls.marks.at(-1).status, 'skipped');
  assert.equal(calls.sentry.length, 0, 'SEND_NOTIFICATIONS=false is a config, not an incident');
});

test('a failed send keeps the recording, sends the fallback, and pages Sentry', async () => {
  router.__setVoiceDeps({ sendTelegramAudio: async () => ({ ok: false, description: 'Bad Request' }) });
  await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB8', RecordingDuration: '14',
  });
  await settle();
  assert.equal(calls.deletes.length, 0);
  assert.equal(calls.marks.at(-1).status, 'failed');
  assert.ok(calls.telegram.some((m) => /\+13125550147/.test(m.text)), 'she still learns who called');
  assert.equal(calls.sentry.length, 1, 'this one IS an incident');
});

test('a media fetch failure keeps the recording and sends the text fallback', async () => {
  router.__setVoiceDeps({ fetchRecordingMp3: async () => { throw new Error('recording fetch failed (404)'); } });
  await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB9', RecordingDuration: '14',
  });
  await settle();
  assert.equal(calls.audio.length, 0);
  assert.equal(calls.deletes.length, 0);
  assert.equal(calls.marks.at(-1).status, 'failed');
});

test('bootstrap mode (no allowlisted user) never deletes', async () => {
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  await post('/api/voice/inbound/voicemail', {
    RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB10', RecordingDuration: '14',
  });
  await settle();
  assert.equal(calls.audio.length, 0);
  assert.equal(calls.deletes.length, 0);
  assert.equal(calls.marks.at(-1).status, 'skipped');
});

test('the voicemail handler fails closed on a bad signature with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  const res = await post('/api/voice/inbound/voicemail', { RecordingStatus: 'completed', RecordingSid: GOOD_RE, CallSid: 'CB11' });
  assert.equal(res.status, 403);
  if (saved !== undefined) process.env.NODE_ENV = saved;
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: FAIL, 404 on `/api/voice/inbound/voicemail`.

- [ ] **Step 3: Implement in `server/routes/voice.js`**

```js
/**
 * POST /api/voice/inbound/voicemail — the <Record> recordingStatusCallback.
 *
 * This is the delivery hook, NOT <Record action>: when a caller ends a voicemail
 * by hanging up, which is the normal case, Twilio does not request the record
 * verb's action URL.
 *
 * Responds 204 immediately and processes detached. The call is already over, so
 * nobody is waiting on the line, and a fast 2xx keeps Twilio from retrying while
 * we are still uploading.
 */
router.post('/inbound/voicemail', voicemailWebhookLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'inbound/voicemail')) return;
  const body = req.body || {};
  res.status(204).end();
  processVoicemail(body).catch((err) => {
    console.error(`[voice/voicemail] unhandled: ${err.message}`);
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' } });
  });
});

async function processVoicemail(body) {
  const recordingSid = body.RecordingSid;
  const callSid = body.CallSid;
  const tail = `sid=...${String(callSid || '').slice(-4)}`;

  // Shape gates BEFORE anything reaches an outbound request. body.RecordingUrl
  // is deliberately never read: see server/utils/voicemail.js SECURITY NOTE.
  if (body.RecordingStatus !== 'completed') {
    console.log(`[voice/voicemail] ignoring RecordingStatus=${body.RecordingStatus} ${tail}`);
    return;
  }
  if (!callSid || !_deps.isRecordingSid(recordingSid)) {
    console.warn(`[voice/voicemail] rejected malformed callback ${tail}`);
    return;
  }

  const parsed = parseInt(body.RecordingDuration, 10);
  const durationSec = Number.isFinite(parsed) ? parsed : null;

  const claim = await _deps.claimDelivery({ callSid, recordingSid, durationSec });
  if (!claim) {
    console.log(`[voice/voicemail] delivery already claimed or unknown call ${tail}`);
    return;
  }

  // A robocall or a hangup on the beep. She already has the ping with the number.
  if (durationSec === null || durationSec < 2) {
    await _deps.markDelivery({ callSid, status: 'empty' });
    await _deps.deleteRecording(recordingSid);
    console.log(`[voice/voicemail] empty recording dropped ${tail}`);
    return;
  }

  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!allowed) {
    // Documented bootstrap mode. Keep the recording; there is nobody to send to.
    await _deps.markDelivery({ callSid, status: 'skipped' });
    console.warn(`[voice/voicemail] TELEGRAM_ALLOWED_USER_ID unset, recording retained ${tail}`);
    return;
  }

  const who = claim.fromE164 || 'a withheld number';
  let audio;
  try {
    audio = await _deps.fetchRecordingMp3(recordingSid);
  } catch (err) {
    await _deps.markDelivery({ callSid, status: 'failed' });
    console.error(`[voice/voicemail] media fetch failed ${tail}: ${err.message}`);
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' } });
    await _deps.sendTelegramMessage(allowed, `Voicemail from ${who} could not be retrieved. It is still in the Twilio console.`);
    return;
  }

  const mmss = `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`;
  const caption = `Voicemail from ${who}, ${chicagoTime()}, ${mmss}`;
  const result = await _deps.sendTelegramAudio(allowed, audio, { filename: 'voicemail.mp3', caption });

  // Three outcomes, deliberately not collapsed. sendTelegramAudio never throws,
  // so a try/catch would treat every one of them as success and delete the only
  // copy of a client communication.
  if (result && result.ok === true) {
    await _deps.markDelivery({ callSid, status: 'delivered' });
    await _deps.deleteRecording(recordingSid);
    console.log(`[voice/voicemail] delivered ${tail} duration=${durationSec}s`);
    return;
  }
  if (result && result.skipped === true) {
    // SEND_NOTIFICATIONS=false is a documented prod configuration. Not a failure,
    // not a success: keep the recording and do not page Sentry.
    await _deps.markDelivery({ callSid, status: 'skipped' });
    console.log(`[voice/voicemail] send gated off, recording retained ${tail}`);
    return;
  }
  await _deps.markDelivery({ callSid, status: 'failed' });
  console.error(`[voice/voicemail] upload failed ${tail}: ${(result && result.description) || 'unknown'}`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('Voicemail Telegram upload failed', {
      level: 'warning', tags: { webhook: 'twilio-voice', route: 'inbound/voicemail' },
    });
  }
  await _deps.sendTelegramMessage(allowed, `Voicemail from ${who} did not come through. It is still in the Twilio console.`);
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: PASS.

- [ ] **Step 5: Check file size**

Run: `npm run check:filesize`

Do **not** run `node scripts/check-file-size.js` with no arguments: that invokes `runStaged()` (`scripts/check-file-size.js:181-184`) and at this point nothing is staged, so it reports nothing and looks like a pass.

Expected: `server/routes/voice.js` appears in neither the RED nor the YELLOW list. The report only prints problems, so "green" means absent from both, not an affirmative line. It starts at 192 lines and lands near 460, comfortably under the 700 soft cap.

- [ ] **Step 6: Commit**

```bash
git add server/routes/voice.js server/routes/voice.test.js
git commit -m "feat(voicemail): recording delivery handler with explicit success contract"
```

---

### Task 6a: Prune the ledger

Retention only. Split from the sweep because they are two logical features with two different revert stories, and because `pendingCall.test.js` already covers `pruneVaCallingRows` and gives this half a real red/green of its own.

**Files:**
- Modify: `server/utils/pendingCall.js`
- Modify: `server/utils/pendingCall.test.js`

- [ ] **Step 1: Extend the prune in `server/utils/pendingCall.js`**

Add a fourth `batchedDelete` inside `pruneVaCallingRows`, after the `telegram_update` block:

```js
  // Only terminal rows are pruned. A 'failed' or stuck 'recorded' row stays
  // visible past retention on purpose: it is the record that a voicemail exists
  // in the Twilio console and was never delivered.
  total += await batchedDelete(
    `DELETE FROM voicemail_delivery
      WHERE ctid IN (
        SELECT ctid FROM voicemail_delivery
        WHERE created_at < NOW() - ($1 || ' days')::interval
          AND status IN ('delivered', 'skipped', 'empty')
        LIMIT $2
      )`,
    [String(RETENTION_DAYS), PRUNE_BATCH_SIZE]
  );
```

- [ ] **Step 2: Cover it in `server/utils/pendingCall.test.js`**

That file already has two `pruneVaCallingRows` tests (around `:138` and `:147`). Add a third in the same style, using the same test-row conventions the file already uses:

```js
test('pruneVaCallingRows removes terminal voicemail rows and keeps failed ones', async () => {
  const old = `CApruneold${'0'.repeat(22)}`;
  const stuck = `CAprunestuck${'0'.repeat(20)}`;
  await pool.query(
    `INSERT INTO voicemail_delivery (call_sid, status, created_at)
     VALUES ($1, 'delivered', NOW() - INTERVAL '400 days'),
            ($2, 'failed',    NOW() - INTERVAL '400 days')`,
    [old, stuck]
  );
  await pendingCall.pruneVaCallingRows();
  const { rows } = await pool.query(
    'SELECT call_sid FROM voicemail_delivery WHERE call_sid IN ($1, $2)', [old, stuck]
  );
  assert.deepEqual(rows.map((r) => r.call_sid), [stuck], 'a failed row survives retention on purpose');
  await pool.query('DELETE FROM voicemail_delivery WHERE call_sid IN ($1, $2)', [old, stuck]);
});
```

Adjust the interval so it exceeds whatever `RETENTION_DAYS` currently is.

- [ ] **Step 3: Run it**

Run: `node -r dotenv/config --test server/utils/pendingCall.test.js`
Expected: PASS, including the two pre-existing prune tests.

- [ ] **Step 4: Commit**

```bash
git add server/utils/pendingCall.js server/utils/pendingCall.test.js
git commit -m "feat(voicemail): prune terminal ledger rows on the VA-calling sweep"
```

---

### Task 6b: Sweep undelivered voicemails

**Files:**
- Modify: `server/utils/vaCallingScheduler.js`
- Modify: `server/utils/vaCallingScheduler.test.js`
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `markDelivery`, `fetchRecordingMp3`, `deleteRecording` (Tasks 1 and 2); `sendTelegramAudio`, `sendTelegramMessage` (Task 3).
- Produces: `reapUndeliveredVoicemails() => Promise<number>` exported from `vaCallingScheduler`.

This is what covers a process death between the delivery claim and the upload. Twilio does not redeliver a recording callback it already answered with a 2xx, so without this a crashed delivery is a silent permanent loss.

- [ ] **Step 1: Extend the test file's `afterEach` reset first**

`server/utils/vaCallingScheduler.test.js:29-36` restores only `getTelegramWebhookInfo`, `setTelegramWebhook`, `pruneVaCallingRows`, and `notifyAdminCategory`. `__setDeps` merges, so the stub `pool` and the five new stubs below would leak into every later test in the file. Add `pool` and the five voicemail deps to that reset object before writing any new test. This is the exact leak the existing `afterEach` comment exists to prevent.

- [ ] **Step 2: Write the failing sweep test**

Add to `server/utils/vaCallingScheduler.test.js`:

```js
test('reapUndeliveredVoicemails retries a stuck row and deletes on success', async () => {
  const seen = { fetched: [], audio: [], marked: [], deleted: [] };
  scheduler.__setDeps({
    pool: { query: async (sql) => {
      if (/SELECT/i.test(sql)) {
        return { rows: [{ call_sid: 'CC1', from_e164: '+13125550147', recording_sid: 'RE' + 'a'.repeat(32), duration_sec: 9, attempts: 1 }] };
      }
      return { rows: [], rowCount: 1 };
    } },
    fetchRecordingMp3: async (sid) => { seen.fetched.push(sid); return Buffer.from('ID3'); },
    sendTelegramAudio: async (_c, _b, o) => { seen.audio.push(o); return { ok: true }; },
    markDelivery: async (a) => { seen.marked.push(a); },
    deleteRecording: async (s) => { seen.deleted.push(s); return true; },
  });
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  const n = await scheduler.reapUndeliveredVoicemails();
  assert.equal(n, 1);
  assert.equal(seen.fetched.length, 1);
  assert.equal(seen.marked.at(-1).status, 'delivered');
  assert.equal(seen.deleted.length, 1);
});

test('reapUndeliveredVoicemails alerts once at the attempt ceiling and stops retrying', async () => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001'; // must be set per-test, never inherited
  const seen = { audio: [], marked: [], deleted: [], messages: [] };
  scheduler.__setDeps({
    pool: { query: async (sql) => {
      if (/SELECT/i.test(sql)) {
        return { rows: [{ call_sid: 'CC2', from_e164: '+13125550147', recording_sid: 'RE' + 'b'.repeat(32), duration_sec: 9, attempts: 3 }] };
      }
      return { rows: [], rowCount: 1 };
    } },
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendTelegramAudio: async (_c, _b, o) => { seen.audio.push(o); return { ok: false, description: 'nope' }; },
    sendTelegramMessage: async (_c, t) => { seen.messages.push(t); return { ok: true }; },
    markDelivery: async (a) => { seen.marked.push(a); },
    deleteRecording: async (s) => { seen.deleted.push(s); return true; },
  });
  await scheduler.reapUndeliveredVoicemails();
  assert.equal(seen.deleted.length, 0, 'never delete an undelivered recording');
  assert.equal(seen.messages.length, 1, 'exactly one manual-retrieval alert');
  assert.match(seen.messages[0], /Twilio console/);
});
```

Match the existing file's harness for requiring the module and resetting deps.

- [ ] **Step 3: Run to confirm failure**


Run: `node -r dotenv/config --test server/utils/vaCallingScheduler.test.js`
Expected: FAIL, `scheduler.reapUndeliveredVoicemails is not a function`.

- [ ] **Step 4: Implement the sweep in `server/utils/vaCallingScheduler.js`**

Add to the deps object:

```js
  fetchRecordingMp3: (...a) => voicemail.fetchRecordingMp3(...a),
  deleteRecording: (...a) => voicemail.deleteRecording(...a),
  markDelivery: (...a) => voicemail.markDelivery(...a),
  sendTelegramAudio: (...a) => telegram.sendTelegramAudio(...a),
  sendTelegramMessage: (...a) => telegram.sendTelegramMessage(...a),
```

with `const voicemail = require('./voicemail');` at the top, then:

```js
// A voicemail whose delivery was claimed but never finished (a crash or a
// redeploy between the claim and the upload) has nothing else to rescue it:
// Twilio does not redeliver a recording status callback it already answered
// with a 2xx. This sweep is that retry. Bounded by attempts so a permanently
// broken row alerts once and then rests.
const VM_SWEEP_MIN_AGE = '5 minutes';
const VM_SWEEP_MAX_AGE = '2 days';
const VM_MAX_ATTEMPTS = 3;
const VM_SWEEP_BATCH = 10;

async function reapUndeliveredVoicemails() {
  const { rows } = await deps.pool.query(
    `SELECT call_sid, from_e164, recording_sid, duration_sec, attempts
       FROM voicemail_delivery
      WHERE status IN ('recorded', 'failed')
        AND recording_sid IS NOT NULL
        AND created_at < NOW() - $1::interval
        AND created_at > NOW() - $2::interval
        AND attempts <= $3
      ORDER BY created_at
      LIMIT $4`,
    [VM_SWEEP_MIN_AGE, VM_SWEEP_MAX_AGE, VM_MAX_ATTEMPTS, VM_SWEEP_BATCH]
  );

  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!allowed || rows.length === 0) return 0;

  let recovered = 0;
  for (const row of rows) {
    const tail = `sid=...${String(row.call_sid).slice(-4)}`;
    const who = row.from_e164 || 'a withheld number';
    // Bump BEFORE the attempt so a retry that crashes still counts against the
    // ceiling. row.attempts below is the pre-bump value, so the give-up alert
    // fires exactly once, on the pass that reaches VM_MAX_ATTEMPTS.
    await deps.pool.query(
      'UPDATE voicemail_delivery SET attempts = attempts + 1 WHERE call_sid = $1',
      [row.call_sid]
    );
    try {
      const audio = await deps.fetchRecordingMp3(row.recording_sid);
      const secs = row.duration_sec || 0;
      const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const result = await deps.sendTelegramAudio(allowed, audio, {
        filename: 'voicemail.mp3',
        caption: `Voicemail from ${who}, ${mmss} (redelivered)`,
      });
      if (result && result.ok === true) {
        await deps.markDelivery({ callSid: row.call_sid, status: 'delivered' });
        await deps.deleteRecording(row.recording_sid);
        recovered += 1;
        console.log(`[vm-sweep] recovered ${tail}`);
        continue;
      }
    } catch (err) {
      console.error(`[vm-sweep] retry failed ${tail}: ${err.message}`);
    }
    await deps.markDelivery({ callSid: row.call_sid, status: 'failed' });
    if (row.attempts >= VM_MAX_ATTEMPTS) {
      // Last word on this row. The recording is NEVER deleted undelivered.
      await deps.sendTelegramMessage(
        allowed,
        `A voicemail from ${who} could not be delivered after several tries. It is still in the Twilio console and needs to be pulled by hand.`
      );
      console.warn(`[vm-sweep] giving up ${tail}`);
    }
  }
  return recovered;
}
```

Export `reapUndeliveredVoicemails`.

The attempt bump is a standalone UPDATE rather than a side effect of `claimDelivery`, because `claimDelivery` only runs on the webhook path and this sweep must count its own tries. Bumping before the attempt (not after) means a retry that crashes mid-upload still burns an attempt, so a row that reliably kills the process cannot loop forever.

- [ ] **Step 5: Wire it into `server/index.js`**

The cited precedent needs care: `reapStaleLeadCallAttempts` is guarded *inside* `vaCallingScheduler.pruneVaCallingRows()`, not in `index.js`. Follow that same shape rather than adding a new scheduler entry, because `server/index.js:495-518` wraps each job in `wrapScheduler(<name>, <sec>, fn)` and the disable branch at `:515-518` calls `clearHealthRow` per name, so a new `wrapScheduler` name would also need a matching `clearHealthRow(...)` in the `else` or it silently leaves a stale health row.

Concretely: call `reapUndeliveredVoicemails()` from inside the existing VA-calling wrapped job, in its own `try/catch`, so a sweep failure cannot mask the prune and vice versa. No new `wrapScheduler` name, no `clearHealthRow` change, no `index.js` structural edit beyond that one call site.

- [ ] **Step 6: Verify the wiring actually runs**

Neither unit suite loads `index.js`, so the wiring is untested by Steps 3 and 7. Prove it by hand:

Run: `RUN_SCHEDULERS=true NODE_ENV=development node -r dotenv/config server/index.js` and watch startup.
Expected: the VA-calling scheduler line appears in the boot log and no unhandled rejection follows it. Stop the process once you see it.

This matters more than the usual wiring check: this sweep is the only rescue for a crash between the delivery claim and the upload, so a silently unwired sweep means a class of voicemail is lost with every test still green.

- [ ] **Step 7: Run both suites**

Run, one at a time:
```
node -r dotenv/config --test server/utils/vaCallingScheduler.test.js
node -r dotenv/config --test server/utils/voicemail.test.js
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/utils/vaCallingScheduler.js server/utils/vaCallingScheduler.test.js server/index.js
git commit -m "feat(voicemail): redelivery sweep for undelivered voicemails"
```

---

### Task 7: Env registration and documentation

`scripts/sensitive-paths.txt` moved to Task 1 so the two new files are sensitive-matched for the whole build rather than only at push.

**Files:**
- Modify: `.env.example`
- Modify: `.claude/CLAUDE.md` (there is **no** repo-root `CLAUDE.md`; `git add CLAUDE.md` fails)
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Add the env vars to `.env.example`**

Near the existing `VOICE_CALLER_ID` / `VA_CELL` block (lines 217-222):

```
# 224-inbound voicemail (spec 2026-07-22). Ships dark: only 'true' enables it.
VOICEMAIL_ENABLED=false
# Max recording length in seconds (default 120, clamped 30..300).
VM_MAX_LENGTH_SEC=120
# Max voicemail-path calls per rolling 24h (default 50). On trip the missed
# handler hangs up and sends no ping.
VM_DAILY_CAP=50
# Global inbound-call flood cap per minute (default 30). Also caps both
# voicemail webhooks.
VA_INBOUND_PER_MIN_CAP=30
```

`VA_INBOUND_PER_MIN_CAP` is not new; `server/routes/voice.js:22` claims it is "registered in the env docs" and it never was, and this lane promotes it to a primary spend guardrail.

- [ ] **Step 2: Update `.claude/CLAUDE.md`**

Add three rows to the Environment Variables table with the wording from the spec's env table, plus a `VA_INBOUND_PER_MIN_CAP` row. Then correct the `RUN_VA_CALLING_SCHEDULER` row (`.claude/CLAUDE.md:306`), which describes the job as an "hourly prune of `pending_call`/`call_audit`/`telegram_update` + Telegram webhook heartbeat": it now also prunes `voicemail_delivery` and runs the undelivered-voicemail sweep.

- [ ] **Step 3: Update `README.md`**

Environment Variables table gets all four rows, `VA_INBOUND_PER_MIN_CAP` included (it already carries `VOICE_CALLER_ID:117` and `VA_CELL:118`). Folder tree gets `server/utils/voicemail.js`. The `voice.js` tree entry near `README.md:252` enumerates the route's endpoints and needs the two new ones.

- [ ] **Step 4: Update `ARCHITECTURE.md`**

Six targets, not five. The VA-calling Database Schema block is easy to miss because the generic "add the new table" instruction does not point at it.

- API route table: `POST /api/voice/inbound/missed` and `POST /api/voice/inbound/voicemail`.
- Database Schema section: `voicemail_delivery`.
- **The VA-calling block at `:1106-1112`**, which enumerates `pending_call` / `call_audit` / `telegram_update` as the tables "Pruned by vaCallingScheduler". That enumeration goes stale the moment Task 6a adds a fourth table.
- **Correct the stale inbound-flow line (`:1555`)**, which reads "unanswered → PH-carrier voicemail (missed-inbound capture deferred to v2)". Carrier voicemail is off on `VA_CELL` (owner-confirmed 2026-07-22), and missed-inbound capture is this feature. Replace with the real flow: unanswered dial routes to `/api/voice/inbound/missed`, which pings Zul and records a voicemail delivered to the same Telegram chat.
- Toll-fraud guards list (`:1557`, not 1556, which is "Status feedback"): add the `VM_DAILY_CAP` recording cap and the fail-closed signature policy on the two new webhooks.
- Helper modules (`:1558`) add `server/utils/voicemail.js`; Tables (`:1559`) add `voicemail_delivery`.

- [ ] **Step 5: Verify docs consistency**

`git diff --stat` proves files were touched, not that content is right, so grep for the specific facts instead:

```bash
grep -n "voicemail_delivery" ARCHITECTURE.md | head
grep -n "VM_DAILY_CAP\|VOICEMAIL_ENABLED\|VM_MAX_LENGTH_SEC\|VA_INBOUND_PER_MIN_CAP" .claude/CLAUDE.md README.md .env.example
grep -n "PH-carrier voicemail" ARCHITECTURE.md
```

Expected: the first two print hits in every named file; the third prints **nothing**, which is how you know the stale line is gone.

- [ ] **Step 6: Commit**

```bash
git add .env.example .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs(voicemail): env registration + architecture correction"
```

---

## Before the lane merges

- [ ] Run every touched suite one at a time (they share the dev DB): `server/db/schema.vaCalling.test.js`, `server/utils/voicemail.test.js`, `server/utils/telegram.test.js`, `server/routes/voice.test.js`, `server/utils/pendingCall.test.js`, `server/utils/vaCallingScheduler.test.js`.
- [ ] `npx eslint server/` clean, and `npm run check:filesize` shows `server/routes/voice.js` in neither the RED nor YELLOW list.
- [ ] **Resolve the open item.** Confirm against current Twilio documentation whether a `<Dial action>` URL is requested when the *caller* hangs up mid-ring. The "ping on every missed call" decision depends on it. If it is not, bring it back for a decision rather than papering over it.
- [ ] Listen to `Polly.Joanna-Neural` reading the greeting and confirm it is acceptable, or swap the voice name.
- [ ] Full review fleet (`security-review`, `database-review`, `code-review`, `consistency-check`) plus `/second-opinion`, since this is a billed-voice path.
- [ ] Confirm `VOICEMAIL_ENABLED` is set to `false` in Render **before** the deploy that carries this code.
- [ ] After deploy, run the seven-step live test in the spec's Rollout section with Zul in the loop.
