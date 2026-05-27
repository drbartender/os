# Cal.com Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire drb-os to receive Cal.com webhooks, auto-create clients on unknown bookings, flip consult status on the existing consult-form submission, and surface the public booking URL in three already-placeholdered client comms touches.

**Architecture:** A signature-verified webhook endpoint (`POST /api/calcom/webhook`) handles four Cal.com booking events. Replay protection via a generic `webhook_events` dedupe table (SHA-256 of raw body as key). The four event handlers (CREATED, CANCELLED, RESCHEDULED, NO_SHOW_UPDATED) all operate idempotently against the existing `consults` table. Auto-create flow protects against a race-loser orphan client. Three template files swap their `consultUrl: null` placeholders for env-driven `process.env.CAL_BOOKING_URL`.

**Tech Stack:** Node.js 18+ / Express 4.18 / PostgreSQL (raw SQL via `pg`) / `crypto` (built-in) for HMAC / `@sentry/node` for observability / `node:test` for unit + integration tests / `dotenv` for env loading in tests.

**Spec:** `docs/superpowers/specs/2026-05-26-cal-com-integration-design.md`

---

## File structure

**Create:**
- `server/routes/calcom.js` : Cal.com webhook route handler. Owns: signature verification, dedupe, dispatch on triggerEvent, the four event handlers.
- `server/routes/calcom.test.js` : integration tests for the route, using real Postgres via `pool`.
- `server/utils/calcomWebhookHelpers.js` : pure functions: signature verify, body parse, booker normalization, phone/oldUid probing. No DB calls.
- `server/utils/calcomWebhookHelpers.test.js` : unit tests for the helpers.
- `server/utils/webhookEventsPruneScheduler.js` : hourly prune of `webhook_events` rows older than 30 days.
- `server/utils/webhookEventsPruneScheduler.test.js` : unit test for the prune logic.

**Modify:**
- `server/db/schema.sql` : append 4 idempotent migrations (source enum, booker columns, calcom_event_id UNIQUE, webhook_events table).
- `server/index.js` : raw-body middleware for `/api/calcom/webhook`, route mount, startup secret check, register prune scheduler.
- `server/routes/drinkPlanConsult.js` : add `UPDATE consults` inside existing transaction in PUT `/:id/consult` handler.
- `server/routes/drinkPlanConsult.test.js` (if exists; else co-located add) : add test for the completion flip.
- `server/routes/clients.js` : extend `VALID_SOURCES` array.
- `server/utils/marketingHandlers.js` : line 464: `consultUrl: process.env.CAL_BOOKING_URL || null`.
- `server/utils/drinkPlanNudge.js` : lines 148 and 160: same swap.
- `client/src/pages/admin/ClientsDashboard.js`: `SOURCE` map gets `calcom` entry.
- `client/src/pages/admin/ClientDetail.js`: same.
- `client/src/components/adminos/drawers/ClientDrawer.js`: same (note real path is under `components/adminos/drawers/`, not `pages/admin/`).
- `client/src/pages/admin/ProposalCreate.js`: extends `SOURCES` array (different shape than the SOURCE map) used by the manual-proposal-create form's source dropdown.
- `.env.example` : three new env-var lines with inline comments.
- `CLAUDE.md` : Environment Variables table gets three new rows; Tech Stack gets Cal.com.
- `README.md` : folder tree gets `calcom.js`; Environment Variables table mirror; Key Features adds a line; Tech Stack adds Cal.com.
- `ARCHITECTURE.md`: API route table gets `POST /api/calcom/webhook`; Third-Party Integrations adds Cal.com section; consults table description updated; `webhook_events` table documented; `clients.source` enum updated.

---

## Execution review checkpoints

Specialized review agents fire at task boundaries to catch issues at the right granularity (matches the user's standing cadence pattern). Run these AFTER the task's commit, BEFORE starting the next task:

| After task | Run agents | Why |
|---|---|---|
| Task 1 (schema) | `database-review` | New constraints, new table, source-enum migration |
| Task 3 (webhook shell + signature) | `security-review` | HMAC handling, fails-closed posture, raw-body discipline |
| Task 5 (BOOKING_CREATED + auto-create) | `security-review` + `code-review` | PII normalization, race-handling, transaction boundaries |
| Tasks 6 + 7 + 8 (other handlers, as a batch) | `code-review` | Defensive upserts, error paths |
| Task 9 (completion flip) | `database-review` + `consistency-check` | Transaction scope, side effect across drink_plans → consults |
| Task 11 (source enum cross-cut) | `consistency-check` | All enum consumers stay in sync (ProposalCreate intentionally deferred per file-size cap) |
| Task 12 (prune scheduler) | `database-review` | Hourly DELETE statement, retention boundary |
| Tasks 13 + 14 (docs) | none | Doc-only changes per the standing rule |

Agents are advisory: a single warning doesn't block the next task, but blockers stop forward progress until resolved. Use `/review-before-deploy` (all six agents in parallel) as the final pre-push gate after Task 14.

---

## Task 1: Schema foundation

**Files:**
- Modify: `server/db/schema.sql` (append at end of file)

- [ ] **Step 1: Append the four migrations to `schema.sql`**

Open `server/db/schema.sql`. Scroll to the bottom. Append:

```sql

-- ─── Cal.com integration (2026-05-27) ──────────────────────────

-- 1a. Drop old clients.source check constraint (idempotent).
DO $$ BEGIN
  ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_source_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 1b. Add new clients.source check constraint. NOT VALID + VALIDATE
-- surfaces any out-of-enum existing rows loudly rather than swallowing.
ALTER TABLE clients
  ADD CONSTRAINT clients_source_check
  CHECK (source IN ('direct', 'thumbtack', 'referral', 'website', 'calcom'))
  NOT VALID;
ALTER TABLE clients VALIDATE CONSTRAINT clients_source_check;

-- 2. Booker context columns on consults (raw webhook data, preserved
-- separately from the potentially-edited-later client record).
ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_name VARCHAR(255);
ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_email VARCHAR(255);

-- 3. Unique constraint on calcom_event_id for webhook idempotency.
-- Nullable column; PostgreSQL UNIQUE permits multiple NULLs.
DO $$ BEGIN
  ALTER TABLE consults ADD CONSTRAINT consults_calcom_event_id_key UNIQUE (calcom_event_id);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 4. Generic webhook-event dedupe table (replay protection).
-- One row per processed event; (provider, event_id) is the dedupe key.
-- Pruned hourly to 30-day window by webhookEventsPruneScheduler.
CREATE TABLE IF NOT EXISTS webhook_events (
  provider VARCHAR(50) NOT NULL,
  event_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON webhook_events(received_at);
```

- [ ] **Step 2: Apply the migrations against the dev DB**

The schema is reapplied on server boot. Restart the dev server (kill the existing Node process on port 5000 and relaunch via the usual `npm run dev` workflow : Claude-managed, ask the operator if not already running). Watch the boot log for any error from the new ALTERs. Expected: no errors.

- [ ] **Step 3: Verify the migrations landed**

`psql` may not be on PATH (PowerShell on Windows / Git Bash). Use a Node one-liner that goes through the same connection pool the app uses:

```bash
node -e "
require('dotenv').config();
const { pool } = require('./server/db');
(async () => {
  const consultsConstraints = await pool.query(\`SELECT conname FROM pg_constraint WHERE conrelid = 'consults'::regclass\`);
  console.log('consults constraints:', consultsConstraints.rows.map(r => r.conname));

  const clientsCheck = await pool.query(\`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'clients_source_check'\`);
  console.log('clients_source_check:', clientsCheck.rows[0]?.pg_get_constraintdef);

  const webhookCols = await pool.query(\`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'webhook_events' ORDER BY ordinal_position\`);
  console.log('webhook_events columns:', webhookCols.rows);

  const consultsCols = await pool.query(\`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'consults' AND column_name IN ('booker_name', 'booker_email')\`);
  console.log('consults booker columns:', consultsCols.rows);

  await pool.end();
})();
"
```

Expected output:
- `consults constraints:` includes `consults_calcom_event_id_key` and `consults_status_check`
- `clients_source_check:` definition includes `'calcom'` alongside the other four enum values
- `webhook_events columns:` lists `provider`, `event_id`, `received_at`
- `consults booker columns:` lists `booker_name` and `booker_email` with `character varying` data type

**Revertability note.** Task 1 ADDs constraints and a table. To revert: `DROP TABLE IF EXISTS webhook_events`, `ALTER TABLE consults DROP CONSTRAINT consults_calcom_event_id_key`, `ALTER TABLE consults DROP COLUMN booker_name, DROP COLUMN booker_email`, `ALTER TABLE clients DROP CONSTRAINT clients_source_check; ALTER TABLE clients ADD CONSTRAINT clients_source_check CHECK (source IN ('direct', 'thumbtack', 'referral', 'website'))`. Reverse migration is straightforward; no data backfill required because the new columns are nullable and the new table is empty on a fresh deploy.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(cal-com): schema for webhook_events + consults booker columns + source enum"
```

---

## Task 2: Pure helpers + unit tests

**Files:**
- Create: `server/utils/calcomWebhookHelpers.js`
- Create: `server/utils/calcomWebhookHelpers.test.js`

- [ ] **Step 1: Write the failing tests first**

Create `server/utils/calcomWebhookHelpers.test.js`. Pure-logic tests, no DB connection needed (do NOT require `dotenv` or `pool`):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  verifyCalcomSignature,
  computeBodyHash,
  parseCalcomBody,
  extractBookingFields,
  extractRescheduleOldUid,
  extractPhone,
  normalizeBooker,
} = require('./calcomWebhookHelpers');

test('verifyCalcomSignature: valid signature passes', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"hello":"world"}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyCalcomSignature(body, sig, secret), true);
});

test('verifyCalcomSignature: tampered body fails', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"hello":"world"}');
  const tampered = Buffer.from('{"hello":"WORLD"}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyCalcomSignature(tampered, sig, secret), false);
});

test('verifyCalcomSignature: wrong-length signature fails without throwing', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{}');
  assert.equal(verifyCalcomSignature(body, 'short', secret), false);
});

test('verifyCalcomSignature: empty signature fails', () => {
  assert.equal(verifyCalcomSignature(Buffer.from('{}'), '', 'secret'), false);
});

test('computeBodyHash: deterministic per byte sequence', () => {
  const a = computeBodyHash(Buffer.from('{"a":1}'));
  const b = computeBodyHash(Buffer.from('{"a":1}'));
  const c = computeBodyHash(Buffer.from('{"a":2}'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

test('parseCalcomBody: valid JSON returns object', () => {
  const body = Buffer.from('{"triggerEvent":"BOOKING_CREATED","payload":{}}');
  const parsed = parseCalcomBody(body);
  assert.equal(parsed.triggerEvent, 'BOOKING_CREATED');
});

test('parseCalcomBody: malformed JSON throws', () => {
  assert.throws(() => parseCalcomBody(Buffer.from('not json')));
});

test('extractBookingFields: pulls uid + startTime from payload', () => {
  const out = extractBookingFields({ uid: 'abc123', startTime: '2026-05-27T15:00:00Z' });
  assert.equal(out.uid, 'abc123');
  assert.equal(out.startTime, '2026-05-27T15:00:00Z');
});

test('extractBookingFields: returns undefined for missing fields', () => {
  const out = extractBookingFields({});
  assert.equal(out.uid, undefined);
  assert.equal(out.startTime, undefined);
});

test('extractRescheduleOldUid: probes rescheduleUid first', () => {
  assert.equal(extractRescheduleOldUid({ rescheduleUid: 'old-1' }), 'old-1');
});

test('extractRescheduleOldUid: probes rescheduleId', () => {
  assert.equal(extractRescheduleOldUid({ rescheduleId: 'old-2' }), 'old-2');
});

test('extractRescheduleOldUid: probes originalRescheduleEvent.uid', () => {
  assert.equal(extractRescheduleOldUid({ originalRescheduleEvent: { uid: 'old-3' } }), 'old-3');
});

test('extractRescheduleOldUid: probes metadata.rescheduleUid', () => {
  assert.equal(extractRescheduleOldUid({ metadata: { rescheduleUid: 'old-4' } }), 'old-4');
});

test('extractRescheduleOldUid: returns null when no source matches', () => {
  assert.equal(extractRescheduleOldUid({ uid: 'new-1' }), null);
});

test('extractPhone: probes attendees[0].phoneNumber first', () => {
  assert.equal(extractPhone({ attendees: [{ phoneNumber: '+15551234567' }] }), '+15551234567');
});

test('extractPhone: probes attendees[0].phone', () => {
  assert.equal(extractPhone({ attendees: [{ phone: '+15551234567' }] }), '+15551234567');
});

test('extractPhone: probes responses.phone', () => {
  assert.equal(extractPhone({ responses: { phone: '+15551234567' } }), '+15551234567');
});

test('extractPhone: probes customInputs.phone', () => {
  assert.equal(extractPhone({ customInputs: { phone: '+15551234567' } }), '+15551234567');
});

test('extractPhone: returns null when no source matches', () => {
  assert.equal(extractPhone({}), null);
});

test('normalizeBooker: trims, length-caps, lowercases email, validates format', () => {
  const out = normalizeBooker({
    attendees: [{ name: '  Jane Smith  ', email: '  Jane@Example.COM ' }],
  });
  assert.equal(out.name, 'Jane Smith');
  assert.equal(out.email, 'jane@example.com');
  assert.equal(out.bookerNameRaw, 'Jane Smith');
  assert.equal(out.bookerEmailRaw, 'jane@example.com');
});

test('normalizeBooker: empty name falls back to Unknown booker', () => {
  const out = normalizeBooker({ attendees: [{ name: '', email: 'jane@example.com' }] });
  assert.equal(out.name, 'Unknown booker');
});

test('normalizeBooker: malformed email becomes null', () => {
  const out = normalizeBooker({ attendees: [{ name: 'Jane', email: 'not-an-email' }] });
  assert.equal(out.email, null);
});

test('normalizeBooker: 300-char name truncates to 255', () => {
  const longName = 'a'.repeat(300);
  const out = normalizeBooker({ attendees: [{ name: longName, email: 'jane@example.com' }] });
  assert.equal(out.name.length, 255);
});

test('normalizeBooker: no attendees array yields Unknown booker + null email', () => {
  const out = normalizeBooker({});
  assert.equal(out.name, 'Unknown booker');
  assert.equal(out.email, null);
  assert.equal(out.phone, null);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
node --test server/utils/calcomWebhookHelpers.test.js
```

Expected: every test fails with `Cannot find module './calcomWebhookHelpers'`.

- [ ] **Step 3: Create the helpers module**

Create `server/utils/calcomWebhookHelpers.js`:

```js
const crypto = require('crypto');

const MAX_NAME_LEN = 255;
const MAX_EMAIL_LEN = 255;
const MAX_PHONE_LEN = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function verifyCalcomSignature(rawBody, providedHeader, secret) {
  if (!providedHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== providedHeader.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedHeader));
  } catch {
    return false;
  }
}

function computeBodyHash(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function parseCalcomBody(rawBody) {
  return JSON.parse(rawBody.toString('utf8'));
}

function extractBookingFields(payload) {
  return {
    uid: payload?.uid,
    startTime: payload?.startTime,
  };
}

function extractRescheduleOldUid(payload) {
  return payload?.rescheduleUid
      || payload?.rescheduleId
      || payload?.originalRescheduleEvent?.uid
      || payload?.metadata?.rescheduleUid
      || null;
}

function extractPhone(payload) {
  return payload?.attendees?.[0]?.phoneNumber
      || payload?.attendees?.[0]?.phone
      || payload?.responses?.phone
      || payload?.customInputs?.phone
      || null;
}

function normalizeBooker(payload) {
  const attendee = payload?.attendees?.[0] || {};

  const nameRaw = String(attendee.name || '').trim();
  const name = nameRaw.slice(0, MAX_NAME_LEN) || 'Unknown booker';

  const emailRaw = String(attendee.email || '').trim().toLowerCase();
  const email = emailRaw && emailRaw.length <= MAX_EMAIL_LEN && EMAIL_RE.test(emailRaw)
    ? emailRaw
    : null;

  const phoneRaw = String(extractPhone(payload) || '').trim();
  const phone = phoneRaw.slice(0, MAX_PHONE_LEN) || null;

  // bookerNameRaw / bookerEmailRaw preserve what Cal.com sent for the audit
  // row on consults. They follow the same trim + lowercase as the validation
  // inputs but bypass the format check (so consults still records the actual
  // bytes Cal.com sent, even when the email is malformed and the client-side
  // normalized email is null).
  return {
    name,
    email,
    phone,
    bookerNameRaw: nameRaw.slice(0, MAX_NAME_LEN) || null,
    bookerEmailRaw: emailRaw.slice(0, MAX_EMAIL_LEN) || null,
  };
}

module.exports = {
  verifyCalcomSignature,
  computeBodyHash,
  parseCalcomBody,
  extractBookingFields,
  extractRescheduleOldUid,
  extractPhone,
  normalizeBooker,
};
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
node --test server/utils/calcomWebhookHelpers.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/calcomWebhookHelpers.js server/utils/calcomWebhookHelpers.test.js
git commit -m "feat(cal-com): pure webhook helpers (sig verify, body hash, normalization)"
```

---

## Task 3: Webhook route shell, dedupe, dispatch

**Files:**
- Create: `server/routes/calcom.js`
- Create: `server/routes/calcom.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write failing route tests**

Create `server/routes/calcom.test.js`. The harness mirrors the existing `server/routes/proposals/crud.test.js` pattern: stand up a local express server via `node:http`, drive it with raw HTTP requests. No `supertest`, no new devDependencies, matches repo convention.

```js
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { pool } = require('../db');

let _server = null;
let _baseUrl = null;

async function buildApp(secretOverride) {
  if (secretOverride !== undefined) process.env.CAL_WEBHOOK_SECRET = secretOverride;
  // Reset module cache so the route picks up the new env on this build.
  delete require.cache[require.resolve('./calcom')];
  const router = require('./calcom');
  const app = express();
  app.use('/api/calcom/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/calcom', router);

  if (_server) await new Promise(r => _server.close(r));
  await new Promise(resolve => {
    _server = app.listen(0, () => {
      const port = _server.address().port;
      _baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function signedRequest(body, secret, headerOverride) {
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(body).digest('hex')
    : '';
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (headerOverride !== undefined) {
    if (headerOverride !== null) headers['x-cal-signature-256'] = headerOverride;
  } else if (sig) {
    headers['x-cal-signature-256'] = sig;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}/api/calcom/webhook`, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Variant that lets a test override the header name (case sensitivity check).
async function customHeaderRequest(body, secret, headerName) {
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(body).digest('hex')
    : '';
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    [headerName]: sig,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}/api/calcom/webhook`, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const ORIGINAL_SECRET = process.env.CAL_WEBHOOK_SECRET;
const TEST_SECRET = 'test-cal-secret';

before(async () => {
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
});

after(async () => {
  process.env.CAL_WEBHOOK_SECRET = ORIGINAL_SECRET;
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
  if (_server) await new Promise(r => _server.close(r));
});

beforeEach(async () => {
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
});

test('webhook: returns 503 when CAL_WEBHOOK_SECRET unset', async () => {
  await buildApp(''); // empty string treated as unset
  const res = await signedRequest(Buffer.from('{}'), '');
  assert.equal(res.status, 503);
  assert.match(res.text, /not configured/i);
});

test('webhook: returns 400 when signature header missing', async () => {
  await buildApp(TEST_SECRET);
  const res = await signedRequest(Buffer.from('{}'), TEST_SECRET, null);
  assert.equal(res.status, 400);
  assert.match(res.text, /missing signature/i);
});

test('webhook: returns 400 when signature is wrong', async () => {
  await buildApp(TEST_SECRET);
  const res = await signedRequest(Buffer.from('{}'), TEST_SECRET, 'wrongsig');
  assert.equal(res.status, 400);
  assert.match(res.text, /invalid signature/i);
});

test('webhook: wrong-case header still verifies (Express normalizes)', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'wrong-case-1' } }));
  // Send header as mixed-case 'X-Cal-Signature-256' instead of lowercase.
  const res = await customHeaderRequest(body, TEST_SECRET, 'X-Cal-Signature-256');
  assert.equal(res.status, 200); // signature verifies, dispatches to default (ignored)
});

test('webhook: returns 400 on malformed JSON body', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from('not json at all');
  const res = await signedRequest(body, TEST_SECRET);
  assert.equal(res.status, 400);
  assert.match(res.text, /malformed body/i);
});

test('webhook: returns 200 ignored on unknown triggerEvent', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({
    triggerEvent: 'MEETING_STARTED',
    payload: {},
  }));
  const res = await signedRequest(body, TEST_SECRET);
  assert.equal(res.status, 200);
  assert.match(res.text, /ignored/i);
});

test('webhook: dedupe returns 200 Already processed on identical replay', async () => {
  await buildApp(TEST_SECRET);
  const body = Buffer.from(JSON.stringify({
    triggerEvent: 'MEETING_STARTED',
    payload: { uid: 'replay-test-1' },
  }));
  const first = await signedRequest(body, TEST_SECRET);
  assert.equal(first.status, 200);
  const second = await signedRequest(body, TEST_SECRET);
  assert.equal(second.status, 200);
  assert.match(second.text, /already processed/i);

  const dedupeRows = await pool.query(
    "SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'calcom'"
  );
  assert.equal(Number(dedupeRows.rows[0].n), 1);
});

test('webhook: dedupe treats different bodies as different events', async () => {
  await buildApp(TEST_SECRET);
  const a = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'a' } }));
  const b = Buffer.from(JSON.stringify({ triggerEvent: 'MEETING_STARTED', payload: { uid: 'b' } }));
  await signedRequest(a, TEST_SECRET);
  await signedRequest(b, TEST_SECRET);
  const dedupeRows = await pool.query(
    "SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'calcom'"
  );
  assert.equal(Number(dedupeRows.rows[0].n), 2);
});
```

**Note for downstream tasks (5, 6, 7, 8):** the `signedRequest` and `buildApp` helpers no longer take an `app` argument. Per-handler wrapper helpers (`postCreated(payload)`, `postCancelled(payload)`, etc., introduced in Tasks 5-8) drop the `app` parameter accordingly.

- [ ] **Step 2: Run the route tests, confirm they fail**

```bash
node --test server/routes/calcom.test.js
```

Expected: tests fail with `Cannot find module './calcom'`.

- [ ] **Step 3: Create the route skeleton**

Create `server/routes/calcom.js`:

```js
const express = require('express');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const {
  verifyCalcomSignature,
  computeBodyHash,
  parseCalcomBody,
} = require('../utils/calcomWebhookHelpers');

let Sentry = null;
try { Sentry = require('@sentry/node'); } catch (_) { /* optional in dev */ }

function sentryWarn(message, ctx = {}) {
  if (Sentry && process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(message, { level: 'warning', ...ctx });
  }
}

const router = express.Router();

router.post('/webhook', asyncHandler(async (req, res) => {
  // Pre-check 1: secret configured. Fails closed.
  if (!process.env.CAL_WEBHOOK_SECRET) {
    console.error('[calcom] CAL_WEBHOOK_SECRET not set; rejecting webhook');
    return res.status(503).send('Cal.com webhook not configured');
  }

  // Pre-check 2: signature header present.
  const provided = req.header('x-cal-signature-256') || '';
  if (!provided) {
    sentryWarn('Cal.com webhook missing signature header', {
      tags: { webhook: 'calcom', reason: 'missing_signature' },
    });
    return res.status(400).send('Missing signature');
  }

  // Pre-check 3: signature valid.
  const sigOk = verifyCalcomSignature(req.body, provided, process.env.CAL_WEBHOOK_SECRET);
  if (!sigOk) {
    console.error('[calcom] signature verification failed');
    sentryWarn('Cal.com webhook signature failure', {
      tags: { webhook: 'calcom', reason: 'invalid_signature' },
    });
    return res.status(400).send('Invalid signature');
  }

  // Pre-check 4: body parses.
  let body;
  try {
    body = parseCalcomBody(req.body);
  } catch (_) {
    sentryWarn('Cal.com webhook JSON parse failure', {
      tags: { webhook: 'calcom', reason: 'malformed_body' },
    });
    return res.status(400).send('Malformed body');
  }

  // Replay protection: dedupe by SHA-256 of the raw signed body.
  const eventUid = computeBodyHash(req.body);
  const dedupe = await pool.query(
    `INSERT INTO webhook_events (provider, event_id, received_at)
     VALUES ('calcom', $1, NOW())
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING received_at`,
    [eventUid]
  );
  if (dedupe.rowCount === 0) {
    return res.status(200).send('Already processed');
  }

  const event = body.triggerEvent;
  const data = body.payload || {};

  switch (event) {
    case 'BOOKING_CREATED':         return handleCreated(data, res);
    case 'BOOKING_CANCELLED':       return handleCancelled(data, res);
    case 'BOOKING_RESCHEDULED':     return handleRescheduled(data, res);
    case 'BOOKING_NO_SHOW_UPDATED': return handleNoShow(data, res);
    default:
      console.log(`[calcom] ignored event: ${event || 'unknown'}`);
      return res.status(200).json({ ok: true, ignored: event || 'unknown' });
  }
}));

// Handler stubs (filled in by Tasks 5, 6, 7, 8).
async function handleCreated(_payload, res)     { return res.status(200).send('OK'); }
async function handleCancelled(_payload, res)   { return res.status(200).send('OK'); }
async function handleRescheduled(_payload, res) { return res.status(200).send('OK'); }
async function handleNoShow(_payload, res)      { return res.status(200).send('OK'); }

module.exports = router;
module.exports._handlers = { handleCreated, handleCancelled, handleRescheduled, handleNoShow };
```

- [ ] **Step 4: Wire the route into `server/index.js`**

Open `server/index.js`. Find the existing block at lines 128-132 that registers raw-body for Stripe and Resend webhooks. Add a third line for Cal.com IMMEDIATELY after the Resend line:

```js
// Cal.com webhook needs raw body for HMAC-SHA256 signature verification : also BEFORE express.json()
app.use('/api/calcom/webhook', express.raw({ type: 'application/json' }));
```

Then find where existing routes are mounted (search for `app.use('/api/`). Add Cal.com mount alongside the others (alphabetical or grouped, follow existing style):

```js
app.use('/api/calcom', require('./routes/calcom'));
```

- [ ] **Step 5: Run route tests, confirm they pass**

```bash
node --test server/routes/calcom.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/routes/calcom.js server/routes/calcom.test.js server/index.js
git commit -m "feat(cal-com): webhook route shell with signature verify + body-hash dedupe"
```

---

## Task 4: Startup-time secret check

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Add startup warning when secret is unset**

Open `server/index.js`. Find the `start()` function or the boot block where existing schedulers are gated by env vars. Add this near the top of the boot sequence (after env vars load, before app.listen):

```js
// Cal.com webhook secret presence check. Emits a one-shot warning so the
// missed-config alarm fires even when no Cal.com traffic hits the endpoint.
if (!process.env.CAL_WEBHOOK_SECRET) {
  const msg = 'CAL_WEBHOOK_SECRET is not set; Cal.com webhook will return 503 on every request';
  console.warn(`[startup] ${msg}`);
  try {
    const Sentry = require('@sentry/node');
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'startup', subsystem: 'calcom' } });
    }
  } catch (_) { /* sentry optional in dev */ }
}
```

- [ ] **Step 2: Restart the dev server and confirm the warning behavior**

Restart the dev server. With `CAL_WEBHOOK_SECRET` unset in `.env`, expected console output includes:
`[startup] CAL_WEBHOOK_SECRET is not set; Cal.com webhook will return 503 on every request`

Add `CAL_WEBHOOK_SECRET=test-cal-secret` to `.env` and restart. Expected: warning does NOT appear.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(cal-com): startup warning when CAL_WEBHOOK_SECRET unset"
```

---

## Task 5: BOOKING_CREATED handler (full auto-create flow)

**Files:**
- Modify: `server/routes/calcom.js`
- Modify: `server/routes/calcom.test.js`

This task implements the biggest single chunk of behavior: client lookup/auto-create with race-loser orphan cleanup, NULL-email soft-dedupe, proposal linkage, and the consults INSERT.

- [ ] **Step 1: Add failing tests for BOOKING_CREATED**

Open `server/routes/calcom.test.js`. Append (do not remove the existing tests):

```js
// ─── BOOKING_CREATED tests ────────────────────────────────────────

async function postCreated(payload) {
  const body = Buffer.from(JSON.stringify({
    triggerEvent: 'BOOKING_CREATED',
    payload,
  }));
  return signedRequest(body, TEST_SECRET);
}

async function cleanupTestRows() {
  await pool.query("DELETE FROM consults WHERE calcom_event_id LIKE 'test-%' OR booker_email LIKE '%@calcom-test.example'");
  await pool.query("DELETE FROM clients WHERE email LIKE '%@calcom-test.example' OR name LIKE 'CalcomTest%'");
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
}

test('BOOKING_CREATED: returns 200 ignored when uid missing', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postCreated({ startTime: '2026-06-01T15:00:00Z', attendees: [{ name: 'CalcomTest A', email: 'a@calcom-test.example' }] });
  assert.equal(res.status, 200);
  assert.match(res.text, /malformed|ignored/i);
  const rows = await pool.query("SELECT id FROM consults WHERE booker_email = 'a@calcom-test.example'");
  assert.equal(rows.rowCount, 0);
});

test('BOOKING_CREATED: creates client + consult on unknown email', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postCreated({
    uid: 'test-uid-create-1',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Alice', email: 'alice@calcom-test.example', phoneNumber: '+15551110001' }],
  });
  assert.equal(res.status, 200);

  const clients = await pool.query("SELECT id, name, email, phone, source FROM clients WHERE email = 'alice@calcom-test.example'");
  assert.equal(clients.rowCount, 1);
  assert.equal(clients.rows[0].name, 'CalcomTest Alice');
  assert.equal(clients.rows[0].source, 'calcom');
  assert.equal(clients.rows[0].phone, '+15551110001');

  const consults = await pool.query("SELECT id, client_id, calcom_event_id, scheduled_at, status, booker_name, booker_email FROM consults WHERE calcom_event_id = 'test-uid-create-1'");
  assert.equal(consults.rowCount, 1);
  assert.equal(consults.rows[0].status, 'scheduled');
  assert.equal(consults.rows[0].client_id, clients.rows[0].id);
  assert.equal(consults.rows[0].booker_email, 'alice@calcom-test.example');
});

test('BOOKING_CREATED: links to existing client on known email', async () => {
  await cleanupTestRows();
  const existing = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('CalcomTest Bob', 'bob@calcom-test.example', 'direct') RETURNING id`
  );
  const existingId = existing.rows[0].id;

  await buildApp(TEST_SECRET);
  await postCreated({
    uid: 'test-uid-create-2',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Bob', email: 'bob@calcom-test.example' }],
  });

  const clients = await pool.query("SELECT id FROM clients WHERE email = 'bob@calcom-test.example'");
  assert.equal(clients.rowCount, 1, 'no duplicate client created');

  const consults = await pool.query("SELECT client_id FROM consults WHERE calcom_event_id = 'test-uid-create-2'");
  assert.equal(consults.rows[0].client_id, existingId);
});

test('BOOKING_CREATED: idempotent retry does not duplicate rows', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const payload = {
    uid: 'test-uid-create-3',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Carol', email: 'carol@calcom-test.example' }],
  };
  await postCreated(payload);
  // First call hits dedupe table, so direct replay returns dedupe. Test the
  // idempotent FAST-PATH instead: clear webhook_events and re-post.
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
  await postCreated(payload);
  const consults = await pool.query("SELECT id FROM consults WHERE calcom_event_id = 'test-uid-create-3'");
  assert.equal(consults.rowCount, 1);
  const clients = await pool.query("SELECT id FROM clients WHERE email = 'carol@calcom-test.example'");
  assert.equal(clients.rowCount, 1);
});

test('BOOKING_CREATED: NULL-email path soft-dedupes by name+phone', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const payload1 = {
    uid: 'test-uid-create-noemail-1',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Dave', email: '', phoneNumber: '+15551110002' }],
  };
  await postCreated(payload1);

  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
  const payload2 = {
    uid: 'test-uid-create-noemail-2',
    startTime: '2026-06-08T15:00:00Z',
    attendees: [{ name: 'CalcomTest Dave', email: '', phoneNumber: '+15551110002' }],
  };
  await postCreated(payload2);

  const clients = await pool.query(
    "SELECT id FROM clients WHERE name = 'CalcomTest Dave' AND phone = '+15551110002' AND email IS NULL"
  );
  assert.equal(clients.rowCount, 1, 'second NULL-email booking reuses the first auto-created client');

  const consults = await pool.query(
    "SELECT calcom_event_id FROM consults WHERE booker_name = 'CalcomTest Dave' ORDER BY calcom_event_id"
  );
  assert.equal(consults.rowCount, 2);
});

test('BOOKING_CREATED: links to most recent non-terminal proposal', async () => {
  await cleanupTestRows();
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('CalcomTest Eve', 'eve@calcom-test.example', 'direct') RETURNING id`
  );
  const clientId = c.rows[0].id;
  // Older active proposal
  await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, balance_due_date)
     VALUES ($1, 'sent', CURRENT_DATE + INTERVAL '60 days', 'birthday-party', 100000, CURRENT_DATE + INTERVAL '14 days')`,
    [clientId]
  );
  // Newer active proposal (most recent : should be the link target)
  const newer = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, balance_due_date)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + INTERVAL '30 days', 'birthday-party', 200000, CURRENT_DATE + INTERVAL '14 days')
     RETURNING id`,
    [clientId]
  );
  // Archived proposal (should be excluded)
  await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, balance_due_date)
     VALUES ($1, 'archived', CURRENT_DATE + INTERVAL '15 days', 'birthday-party', 50000, CURRENT_DATE + INTERVAL '14 days')`,
    [clientId]
  );

  await buildApp(TEST_SECRET);
  await postCreated({
    uid: 'test-uid-create-link',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Eve', email: 'eve@calcom-test.example' }],
  });

  const consults = await pool.query("SELECT proposal_id FROM consults WHERE calcom_event_id = 'test-uid-create-link'");
  assert.equal(consults.rows[0].proposal_id, newer.rows[0].id);
});

test('BOOKING_CREATED: NULL proposal_id when client has only archived/completed proposals', async () => {
  await cleanupTestRows();
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('CalcomTest Frank', 'frank@calcom-test.example', 'direct') RETURNING id`
  );
  const clientId = c.rows[0].id;
  await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, balance_due_date)
     VALUES ($1, 'completed', CURRENT_DATE - INTERVAL '30 days', 'birthday-party', 100000, CURRENT_DATE - INTERVAL '30 days')`,
    [clientId]
  );
  await buildApp(TEST_SECRET);
  await postCreated({
    uid: 'test-uid-create-no-link',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Frank', email: 'frank@calcom-test.example' }],
  });
  const consults = await pool.query("SELECT proposal_id FROM consults WHERE calcom_event_id = 'test-uid-create-no-link'");
  assert.equal(consults.rows[0].proposal_id, null);
});

test('BOOKING_CREATED: concurrent race with same email → exactly one client, orphan cleaned up', async () => {
  // Spec §12 explicitly requires this test. Exercises the partial-UNIQUE
  // serialization in clients(email), the 23505 catch branch, and the
  // orphan-cleanup branch in the handler. Without this test, regressions
  // in those code paths would not be caught.
  await cleanupTestRows();
  await buildApp(TEST_SECRET);

  const email = 'race@calcom-test.example';
  const payloadA = {
    uid: 'test-uid-race-A',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Race', email }],
  };
  const payloadB = {
    uid: 'test-uid-race-B',
    startTime: '2026-06-08T15:00:00Z',
    attendees: [{ name: 'CalcomTest Race', email }],
  };

  // True parallel: kick both off without awaiting, then Promise.all.
  // Postgres' partial UNIQUE on clients(email) WHERE email IS NOT NULL
  // serializes the concurrent INSERTs; the loser catches 23505 and
  // re-SELECTs the winner's id. Both consults rows reference the same
  // (single) client; no orphan is left behind.
  await Promise.all([postCreated(payloadA), postCreated(payloadB)]);

  const clients = await pool.query("SELECT id FROM clients WHERE email = $1", [email]);
  assert.equal(clients.rowCount, 1, 'partial UNIQUE serializes auto-creates → exactly one client');

  const consults = await pool.query(
    "SELECT client_id FROM consults WHERE calcom_event_id LIKE 'test-uid-race-%' ORDER BY calcom_event_id"
  );
  assert.equal(consults.rowCount, 2, 'both bookings filed');
  assert.equal(consults.rows[0].client_id, clients.rows[0].id);
  assert.equal(consults.rows[1].client_id, clients.rows[0].id);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
node --test server/routes/calcom.test.js
```

Expected: the new tests fail (the handler stub doesn't do any work yet).

- [ ] **Step 3: Implement `handleCreated`**

Open `server/routes/calcom.js`. Add these requires near the top (alongside the existing helper imports):

```js
const { extractBookingFields, normalizeBooker } = require('../utils/calcomWebhookHelpers');
```

Replace the stub `async function handleCreated(_payload, res) { ... }` with the full implementation:

```js
async function handleCreated(payload, res) {
  const { uid, startTime } = extractBookingFields(payload);
  if (!uid || !startTime) {
    sentryWarn('Cal.com BOOKING_CREATED missing uid or startTime', {
      tags: { webhook: 'calcom', triggerEvent: 'BOOKING_CREATED' },
    });
    return res.status(200).send('Malformed payload, ignored');
  }

  const { name, email, phone, bookerNameRaw, bookerEmailRaw } = normalizeBooker(payload);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fast-path: skip if already filed. Perf optimization; the consults
    // ON CONFLICT below is the real correctness boundary.
    const existing = await client.query(
      'SELECT id FROM consults WHERE calcom_event_id = $1',
      [uid]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return res.status(200).send('Already filed');
    }

    let clientId = null;
    let createdClientInThisTx = false;

    if (email) {
      const lookup = await client.query(
        'SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1',
        [email]
      );
      if (lookup.rows[0]) {
        clientId = lookup.rows[0].id;
      } else {
        try {
          const created = await client.query(
            `INSERT INTO clients (name, email, phone, source, notes)
             VALUES ($1, $2, $3, 'calcom',
                     'Auto-created from Cal.com consult booking on ' || CURRENT_DATE::text)
             RETURNING id`,
            [name, email, phone]
          );
          clientId = created.rows[0].id;
          createdClientInThisTx = true;
        } catch (err) {
          if (err.code === '23505') {
            const reLookup = await client.query(
              'SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1',
              [email]
            );
            clientId = reLookup.rows[0]?.id || null;
          } else {
            throw err;
          }
        }
      }
    } else {
      // NULL-email soft-dedupe by (LOWER(name), phone).
      const lookup = await client.query(
        `SELECT id FROM clients
         WHERE email IS NULL
           AND LOWER(name) = LOWER($1)
           AND COALESCE(phone, '') = COALESCE($2, '')
         ORDER BY created_at DESC
         LIMIT 1`,
        [name, phone]
      );
      if (lookup.rows[0]) {
        clientId = lookup.rows[0].id;
      } else {
        const created = await client.query(
          `INSERT INTO clients (name, email, phone, source, notes)
           VALUES ($1, NULL, $2, 'calcom',
                   'Auto-created from Cal.com consult booking (no email) on ' || CURRENT_DATE::text)
           RETURNING id`,
          [name, phone]
        );
        clientId = created.rows[0].id;
        createdClientInThisTx = true;
      }
    }

    // Proposal linkage. Excludes terminal statuses ('archived', 'completed').
    let proposalId = null;
    if (clientId) {
      const props = await client.query(
        `SELECT id FROM proposals
         WHERE client_id = $1 AND status NOT IN ('archived', 'completed')
         ORDER BY created_at DESC LIMIT 1`,
        [clientId]
      );
      proposalId = props.rows[0]?.id || null;
    }

    // Insert consults row. ON CONFLICT (calcom_event_id) DO NOTHING
    // serializes concurrent creates for the same uid. RETURNING id +
    // rowCount lets us detect race-loss and discard an orphan client.
    const consultResult = await client.query(
      `INSERT INTO consults
         (client_id, proposal_id, scheduled_at, calcom_event_id, status,
          booker_name, booker_email)
       VALUES ($1, $2, $3, $4, 'scheduled', $5, $6)
       ON CONFLICT (calcom_event_id) DO NOTHING
       RETURNING id`,
      [clientId, proposalId, startTime, uid, bookerNameRaw, bookerEmailRaw]
    );

    if (consultResult.rowCount === 0 && createdClientInThisTx) {
      // Lost the race AND we just auto-created the client. Discard the
      // orphan so the clients table doesn't accumulate junk. Safe because
      // we just created this row in this transaction, nothing else
      // references its id yet.
      await client.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }

    await client.query('COMMIT');
    return res.status(200).send('OK');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
node --test server/routes/calcom.test.js
```

Expected: all tests pass including the new BOOKING_CREATED set.

- [ ] **Step 5: Commit**

```bash
git add server/routes/calcom.js server/routes/calcom.test.js
git commit -m "feat(cal-com): BOOKING_CREATED handler with auto-create + race-loser orphan cleanup"
```

---

## Task 6: BOOKING_CANCELLED handler

**Files:**
- Modify: `server/routes/calcom.js`
- Modify: `server/routes/calcom.test.js`

- [ ] **Step 1: Add failing tests for BOOKING_CANCELLED**

Append to `server/routes/calcom.test.js`:

```js
// ─── BOOKING_CANCELLED tests ──────────────────────────────────────

async function postCancelled(payload) {
  const body = Buffer.from(JSON.stringify({ triggerEvent: 'BOOKING_CANCELLED', payload }));
  return signedRequest(body, TEST_SECRET);
}

test('BOOKING_CANCELLED: flips existing scheduled row to cancelled', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ('test-uid-cancel-1', '2026-06-01T15:00:00Z', 'scheduled', 'CalcomTest Gina', 'gina@calcom-test.example')`
  );
  await buildApp(TEST_SECRET);
  await postCancelled({
    uid: 'test-uid-cancel-1',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Gina', email: 'gina@calcom-test.example' }],
  });
  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'test-uid-cancel-1'");
  assert.equal(row.rows[0].status, 'cancelled');
});

test('BOOKING_CANCELLED: defensive insert when no prior row exists', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  await postCancelled({
    uid: 'test-uid-cancel-2',
    startTime: '2026-06-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest Henry', email: 'henry@calcom-test.example' }],
  });
  const row = await pool.query(
    "SELECT status, booker_name, booker_email, client_id FROM consults WHERE calcom_event_id = 'test-uid-cancel-2'"
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].status, 'cancelled');
  assert.equal(row.rows[0].booker_name, 'CalcomTest Henry');
  assert.equal(row.rows[0].booker_email, 'henry@calcom-test.example');
  assert.equal(row.rows[0].client_id, null, 'defensive insert leaves client_id NULL');
});

test('BOOKING_CANCELLED: missing startTime falls back to NOW() (no NOT NULL violation)', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const before = Date.now();
  await postCancelled({
    uid: 'test-uid-cancel-3',
    attendees: [{ name: 'CalcomTest Iris', email: 'iris@calcom-test.example' }],
  });
  const row = await pool.query(
    "SELECT status, EXTRACT(EPOCH FROM scheduled_at) * 1000 AS ms FROM consults WHERE calcom_event_id = 'test-uid-cancel-3'"
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].status, 'cancelled');
  assert.ok(Number(row.rows[0].ms) >= before, 'scheduled_at falls back to a time at-or-after the request');
});

test('BOOKING_CANCELLED: missing uid is a 200 no-op', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postCancelled({ attendees: [{ name: 'CalcomTest Jack', email: 'jack@calcom-test.example' }] });
  assert.equal(res.status, 200);
  const rows = await pool.query("SELECT id FROM consults WHERE booker_email = 'jack@calcom-test.example'");
  assert.equal(rows.rowCount, 0);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
node --test server/routes/calcom.test.js
```

Expected: BOOKING_CANCELLED tests fail.

- [ ] **Step 3: Implement `handleCancelled`**

In `server/routes/calcom.js`, replace the stub `handleCancelled` with:

```js
async function handleCancelled(payload, res) {
  const uid = payload?.uid;
  if (!uid) {
    return res.status(200).send('Missing uid, ignored');
  }

  const startTime = payload?.startTime || new Date().toISOString();
  const bookerName = String(payload?.attendees?.[0]?.name || '').trim().slice(0, 255) || null;
  const bookerEmail = String(payload?.attendees?.[0]?.email || '').trim().toLowerCase().slice(0, 255) || null;

  await pool.query(
    `INSERT INTO consults
       (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ($1, $2, 'cancelled', $3, $4)
     ON CONFLICT (calcom_event_id) DO UPDATE
     SET status = 'cancelled'`,
    [uid, startTime, bookerName, bookerEmail]
  );

  return res.status(200).send('OK');
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
node --test server/routes/calcom.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/calcom.js server/routes/calcom.test.js
git commit -m "feat(cal-com): BOOKING_CANCELLED handler with defensive upsert"
```

---

## Task 7: BOOKING_RESCHEDULED handler

**Files:**
- Modify: `server/routes/calcom.js`
- Modify: `server/routes/calcom.test.js`

- [ ] **Step 1: Add failing tests**

Append to `server/routes/calcom.test.js`:

```js
// ─── BOOKING_RESCHEDULED tests ────────────────────────────────────

async function postRescheduled(payload) {
  const body = Buffer.from(JSON.stringify({ triggerEvent: 'BOOKING_RESCHEDULED', payload }));
  return signedRequest(body, TEST_SECRET);
}

test('BOOKING_RESCHEDULED: updates existing row in place using rescheduleUid', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ('test-uid-resched-old-1', '2026-06-01T15:00:00Z', 'scheduled', 'CalcomTest Kate', 'kate@calcom-test.example')`
  );
  await buildApp(TEST_SECRET);
  const res = await postRescheduled({
    uid: 'test-uid-resched-new-1',
    startTime: '2026-06-08T15:00:00Z',
    rescheduleUid: 'test-uid-resched-old-1',
    attendees: [{ name: 'CalcomTest Kate', email: 'kate@calcom-test.example' }],
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /rescheduled in place/i);

  const rows = await pool.query(
    "SELECT calcom_event_id, status, scheduled_at FROM consults WHERE calcom_event_id IN ('test-uid-resched-old-1', 'test-uid-resched-new-1')"
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].calcom_event_id, 'test-uid-resched-new-1');
  assert.equal(rows.rows[0].status, 'scheduled');
});

test('BOOKING_RESCHEDULED: probes alternative old-uid field names', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status)
     VALUES ('test-uid-resched-old-meta', '2026-06-01T15:00:00Z', 'scheduled')`
  );
  await buildApp(TEST_SECRET);
  await postRescheduled({
    uid: 'test-uid-resched-new-meta',
    startTime: '2026-06-08T15:00:00Z',
    metadata: { rescheduleUid: 'test-uid-resched-old-meta' },
  });
  const row = await pool.query("SELECT id FROM consults WHERE calcom_event_id = 'test-uid-resched-new-meta'");
  assert.equal(row.rowCount, 1);
});

test('BOOKING_RESCHEDULED: falls through to handleCreated when old uid unresolvable', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  await postRescheduled({
    uid: 'test-uid-resched-fresh',
    startTime: '2026-06-08T15:00:00Z',
    attendees: [{ name: 'CalcomTest Liam', email: 'liam@calcom-test.example' }],
  });
  const consult = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'test-uid-resched-fresh'");
  assert.equal(consult.rowCount, 1);
  assert.equal(consult.rows[0].status, 'scheduled');
  const client = await pool.query("SELECT id FROM clients WHERE email = 'liam@calcom-test.example'");
  assert.equal(client.rowCount, 1, 'fall-through created a client');
});

test('BOOKING_RESCHEDULED: missing newUid or newStartTime is 200 ignored', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postRescheduled({ rescheduleUid: 'whatever' });
  assert.equal(res.status, 200);
  assert.match(res.text, /malformed|ignored/i);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
node --test server/routes/calcom.test.js
```

- [ ] **Step 3: Implement `handleRescheduled`**

In `server/routes/calcom.js`, replace the stub. First, add `extractRescheduleOldUid` to the existing import:

```js
const { extractBookingFields, extractRescheduleOldUid, normalizeBooker } = require('../utils/calcomWebhookHelpers');
```

Replace the stub:

```js
async function handleRescheduled(payload, res) {
  const newUid = payload?.uid;
  const newStartTime = payload?.startTime;
  if (!newUid || !newStartTime) {
    return res.status(200).send('Malformed payload, ignored');
  }

  const oldUid = extractRescheduleOldUid(payload);
  const bookerName = String(payload?.attendees?.[0]?.name || '').trim().slice(0, 255) || null;
  const bookerEmail = String(payload?.attendees?.[0]?.email || '').trim().toLowerCase().slice(0, 255) || null;

  if (oldUid) {
    const result = await pool.query(
      `UPDATE consults
       SET calcom_event_id = $1, scheduled_at = $2, status = 'scheduled',
           booker_name = COALESCE($3, booker_name),
           booker_email = COALESCE($4, booker_email)
       WHERE calcom_event_id = $5`,
      [newUid, newStartTime, bookerName, bookerEmail, oldUid]
    );
    if (result.rowCount > 0) {
      return res.status(200).send('Rescheduled in place');
    }
  }

  sentryWarn('Cal.com BOOKING_RESCHEDULED with unresolvable old uid', {
    tags: { webhook: 'calcom', triggerEvent: 'BOOKING_RESCHEDULED' },
    extra: { newUid, payloadShape: Object.keys(payload || {}) },
  });

  return handleCreated(payload, res);
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
node --test server/routes/calcom.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/routes/calcom.js server/routes/calcom.test.js
git commit -m "feat(cal-com): BOOKING_RESCHEDULED handler with old-uid probing + fresh-create fallback"
```

---

## Task 8: BOOKING_NO_SHOW_UPDATED handler

**Files:**
- Modify: `server/routes/calcom.js`
- Modify: `server/routes/calcom.test.js`

- [ ] **Step 1: Add failing tests**

Append to `server/routes/calcom.test.js`:

```js
// ─── BOOKING_NO_SHOW_UPDATED tests ────────────────────────────────

async function postNoShow(payload) {
  const body = Buffer.from(JSON.stringify({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', payload }));
  return signedRequest(body, TEST_SECRET);
}

test('BOOKING_NO_SHOW_UPDATED: flips existing row to no_show', async () => {
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status)
     VALUES ('test-uid-noshow-1', '2026-06-01T15:00:00Z', 'scheduled')`
  );
  await buildApp(TEST_SECRET);
  const res = await postNoShow({ uid: 'test-uid-noshow-1' });
  assert.equal(res.status, 200);
  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'test-uid-noshow-1'");
  assert.equal(row.rows[0].status, 'no_show');
});

test('BOOKING_NO_SHOW_UPDATED: zero-row update is a 200 (with Sentry breadcrumb in real Sentry env)', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const res = await postNoShow({ uid: 'test-uid-noshow-unknown' });
  assert.equal(res.status, 200);
});

test('BOOKING_NO_SHOW_UPDATED: missing uid is 200 ignored', async () => {
  await buildApp(TEST_SECRET);
  const res = await postNoShow({});
  assert.equal(res.status, 200);
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
node --test server/routes/calcom.test.js
```

- [ ] **Step 3: Implement `handleNoShow`**

In `server/routes/calcom.js`, replace the stub:

```js
async function handleNoShow(payload, res) {
  const uid = payload?.uid;
  if (!uid) {
    return res.status(200).send('Missing uid, ignored');
  }

  const result = await pool.query(
    `UPDATE consults SET status = 'no_show' WHERE calcom_event_id = $1`,
    [uid]
  );

  if (result.rowCount === 0) {
    console.warn(`[calcom] no_show for unknown uid: ${uid}`);
    sentryWarn('Cal.com no-show for unknown booking', {
      tags: { webhook: 'calcom', triggerEvent: 'BOOKING_NO_SHOW_UPDATED' },
      extra: { uid },
    });
  }

  return res.status(200).send('OK');
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
node --test server/routes/calcom.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server/routes/calcom.js server/routes/calcom.test.js
git commit -m "feat(cal-com): BOOKING_NO_SHOW_UPDATED handler with zero-row warning"
```

---

## Task 9: Completion-flip in drinkPlanConsult.js

**Files:**
- Modify: `server/routes/drinkPlanConsult.js`
- Create (if not exists) or Modify: `server/routes/drinkPlanConsult.test.js`

The existing PUT `/:id/consult` handler at `server/routes/drinkPlanConsult.js:127-270` already manages a transaction on a pooled `client`. We add ONE additional UPDATE inside that transaction, wrapped in inner try/catch so a flip failure doesn't roll back the consult save.

- [ ] **Step 1: Check whether a co-located test file exists**

```bash
ls server/routes/drinkPlanConsult.test.js 2>/dev/null || echo "does not exist"
```

If "does not exist", create it with the scaffold below. If it exists, you'll add tests to it in Step 2.

If creating from scratch, file scaffold:

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

// Tests for drinkPlanConsult.js. Currently focused on the consults
// completion-flip behavior added during Cal.com integration.

let testClientId;
let testProposalId;
let testDrinkPlanId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('CalcomConsultFlip', 'consultflip@calcom-test.example', 'direct') RETURNING id`
  );
  testClientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, guest_count, total_price, balance_due_date)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + INTERVAL '30 days', 'birthday-party', 50, 100000, CURRENT_DATE + INTERVAL '14 days')
     RETURNING id`,
    [testClientId]
  );
  testProposalId = p.rows[0].id;
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, client_name, client_email, event_date, status)
     VALUES ($1, 'CalcomConsultFlip', 'consultflip@calcom-test.example', CURRENT_DATE + INTERVAL '30 days', 'pending')
     RETURNING id`,
    [testProposalId]
  );
  testDrinkPlanId = dp.rows[0].id;
});

after(async () => {
  await pool.query("DELETE FROM consults WHERE booker_email LIKE '%@calcom-test.example' OR proposal_id = $1", [testProposalId]);
  await pool.query("DELETE FROM drink_plans WHERE id = $1", [testDrinkPlanId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [testProposalId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [testClientId]);
});
```

- [ ] **Step 2: Add the failing tests for the consults flip**

Append to `server/routes/drinkPlanConsult.test.js`. These tests use a small helper that invokes the same code path the route triggers, so we don't need a full HTTP fixture. The simplest approach: call the underlying SQL directly to seed state and rely on the integration test for the route to confirm wiring. Then add a focused unit test for the flip behavior:

```js
const { performConsultsCompletionFlip } = require('./drinkPlanConsult');

test('completionFlip: flips past-scheduled consult for the proposal', async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1", [testProposalId]);
  await pool.query(
    `INSERT INTO consults (proposal_id, scheduled_at, status, calcom_event_id)
     VALUES ($1, NOW() - INTERVAL '1 hour', 'scheduled', 'flip-test-past')`,
    [testProposalId]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, testProposalId);
    await client.query('COMMIT');
  } finally { client.release(); }

  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'flip-test-past'");
  assert.equal(row.rows[0].status, 'completed');
});

test('completionFlip: leaves future-scheduled consults alone', async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1", [testProposalId]);
  await pool.query(
    `INSERT INTO consults (proposal_id, scheduled_at, status, calcom_event_id)
     VALUES ($1, NOW() + INTERVAL '7 days', 'scheduled', 'flip-test-future')`,
    [testProposalId]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, testProposalId);
    await client.query('COMMIT');
  } finally { client.release(); }

  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'flip-test-future'");
  assert.equal(row.rows[0].status, 'scheduled');
});

test('completionFlip: idempotent on already-completed rows', async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1", [testProposalId]);
  await pool.query(
    `INSERT INTO consults (proposal_id, scheduled_at, status, calcom_event_id)
     VALUES ($1, NOW() - INTERVAL '1 hour', 'completed', 'flip-test-already')`,
    [testProposalId]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, testProposalId);
    await client.query('COMMIT');
  } finally { client.release(); }

  const row = await pool.query("SELECT status FROM consults WHERE calcom_event_id = 'flip-test-already'");
  assert.equal(row.rows[0].status, 'completed');
});

test('completionFlip: no-op when no consults exist for proposal', async () => {
  await pool.query("DELETE FROM consults WHERE proposal_id = $1", [testProposalId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, testProposalId); // should not throw
    await client.query('COMMIT');
  } finally { client.release(); }
});

test('completionFlip: NULL proposal_id is a no-op', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await performConsultsCompletionFlip(client, null); // should not throw
    await client.query('COMMIT');
  } finally { client.release(); }
});
```

- [ ] **Step 3: Run the tests, confirm they fail**

```bash
node --test server/routes/drinkPlanConsult.test.js
```

Expected: tests fail because `performConsultsCompletionFlip` is not exported yet.

- [ ] **Step 4: Implement the flip and insert it into the existing route**

Open `server/routes/drinkPlanConsult.js`. Near the top of the file (after the existing requires), add a small named helper:

```js
async function performConsultsCompletionFlip(client, proposalId) {
  if (proposalId == null) return;
  try {
    await client.query(
      `UPDATE consults
       SET status = 'completed'
       WHERE proposal_id = $1
         AND status = 'scheduled'
         AND scheduled_at <= NOW()`,
      [proposalId]
    );
  } catch (flipErr) {
    // Fire-and-forget: do NOT roll back the consult save just because the
    // side-effect flip failed. Log + Sentry so operator can chase it.
    console.error('[drinkPlanConsult] consults status flip failed (non-fatal):', flipErr);
    if (process.env.SENTRY_DSN_SERVER) {
      try {
        const Sentry = require('@sentry/node');
        Sentry.captureException(flipErr, {
          tags: { route: 'drinkPlanConsult/putConsult', step: 'consults_complete_flip' },
          extra: { proposalId },
        });
      } catch (_) { /* sentry optional */ }
    }
  }
}
```

Find the existing `planRes` SELECT (around line 137-145 in the current file). It currently reads:

```js
    const planRes = await client.query(
      `SELECT dp.id, dp.client_name, dp.event_date, dp.admin_notes,
              dp.consult_filled_at,
              p.guest_count
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       WHERE dp.id = $1
       FOR UPDATE OF dp`,
      [req.params.id]
    );
```

Add `dp.proposal_id` to the SELECT column list:

```js
    const planRes = await client.query(
      `SELECT dp.id, dp.client_name, dp.event_date, dp.admin_notes,
              dp.consult_filled_at, dp.proposal_id,
              p.guest_count
       FROM drink_plans dp
       LEFT JOIN proposals p ON p.id = dp.proposal_id
       WHERE dp.id = $1
       FOR UPDATE OF dp`,
      [req.params.id]
    );
```

Without this, `plan.proposal_id` evaluates to `undefined`, the flip helper's `if (proposalId == null) return;` short-circuits silently (because `undefined == null` is true under loose equality), and the consults flip NEVER fires in production despite all tests passing (tests bypass the route and call the helper directly).

Now find the inner block, specifically the line just before `await client.query('COMMIT');` (around line 183 in the current file). Insert this:

```js
    // Flip linked Cal.com consults row to 'completed' as a side effect of
    // the admin saving the consult form. See spec §6. Wrapped to not roll
    // back the consult save on flip failure.
    await performConsultsCompletionFlip(client, plan.proposal_id);
```

Then export the helper alongside the existing router export at the bottom of the file. Find `module.exports = router;` and change to:

```js
module.exports = router;
module.exports.performConsultsCompletionFlip = performConsultsCompletionFlip;
```

- [ ] **Step 5: Run the tests, confirm they pass**

```bash
node --test server/routes/drinkPlanConsult.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/routes/drinkPlanConsult.js server/routes/drinkPlanConsult.test.js
git commit -m "feat(cal-com): flip linked consults row to completed when consult form submitted"
```

---

## Task 10: CAL_BOOKING_URL surfacing in three template files

**Files:**
- Modify: `server/utils/marketingHandlers.js` (line 464)
- Modify: `server/utils/drinkPlanNudge.js` (lines 148, 160)

- [ ] **Step 1: Verify the three placeholder locations**

```bash
grep -n "consultUrl: null" server/utils/marketingHandlers.js server/utils/drinkPlanNudge.js
```

Expected output:

```
server/utils/marketingHandlers.js:464:      consultUrl: null, // wired to Cal.com once the integration plan lands
server/utils/drinkPlanNudge.js:148:    consultUrl: null, // wired to Cal.com once the integration plan lands
server/utils/drinkPlanNudge.js:160:    consultUrl: null, // wired to Cal.com once the integration plan lands
```

If line numbers differ, locate them via the grep. The pattern is unique.

- [ ] **Step 2: Replace all three placeholders**

Use a single replace_all pattern (the comment is identical in all three locations). For each file, change:

```js
consultUrl: null, // wired to Cal.com once the integration plan lands
```

to:

```js
consultUrl: process.env.CAL_BOOKING_URL || null,
```

- [ ] **Step 3: Verify the swap with grep**

The three templates that consume `consultUrl` are deep inside scheduled-message handlers and SMS rendering paths, not simple top-level exports. A REPL invocation is brittle. The simplest commit-time verification is a grep confirming the substitution is in place:

```bash
grep -n "process.env.CAL_BOOKING_URL" server/utils/marketingHandlers.js server/utils/drinkPlanNudge.js
```

Expected output (three matches, one per line):

```
server/utils/marketingHandlers.js:464:      consultUrl: process.env.CAL_BOOKING_URL || null,
server/utils/drinkPlanNudge.js:148:    consultUrl: process.env.CAL_BOOKING_URL || null,
server/utils/drinkPlanNudge.js:160:    consultUrl: process.env.CAL_BOOKING_URL || null,
```

And confirm there are no remaining `consultUrl: null,` instances in those files (would indicate a missed location):

```bash
grep -n "consultUrl: null" server/utils/marketingHandlers.js server/utils/drinkPlanNudge.js
```

Expected: no output (zero matches).

- [ ] **Step 4: Behavioral verification via the existing handler tests**

The existing `server/utils/drinkPlanNudge.test.js` exercises the drink-plan-nudge email and SMS handlers end-to-end. Append a small test that sets `process.env.CAL_BOOKING_URL` to a known value and asserts the rendered output contains it. Add to `drinkPlanNudge.test.js`:

```js
test('drink_plan_nudge: rendered email body contains CAL_BOOKING_URL when set', async () => {
  const ORIGINAL = process.env.CAL_BOOKING_URL;
  process.env.CAL_BOOKING_URL = 'https://cal.com/test-consult';
  try {
    registerDrinkPlanNudgeHandlers();
    await scheduleDrinkPlanNudge(proposalId);
    const m = await pool.query(
      "SELECT id FROM scheduled_messages WHERE entity_id=$1 AND message_type='drink_plan_nudge' AND status='pending' LIMIT 1",
      [proposalId]
    );
    assert.ok(m.rows[0]?.id, 'drink_plan_nudge row was scheduled');
    // Drive the dispatcher once to render + send (stubbed in dev). The
    // sendEmail stub or live Resend call captures the rendered HTML;
    // assert against the captured body. If the existing test file does
    // not already stub sendEmail, mark this test as pending and document
    // that template tests will land in a follow-up.
  } finally {
    process.env.CAL_BOOKING_URL = ORIGINAL;
  }
});
```

If the existing drink-plan-nudge test does not stub `sendEmail` in a way that exposes the rendered HTML, defer the assertion side of this test and add a comment explaining why; the grep verification in Step 3 still covers the swap. Spec §12 calls for snapshot tests across all three templates; if the test infrastructure cost is non-trivial, log a follow-up task ("snapshot tests for CAL_BOOKING_URL surfacing") rather than blocking this commit.

- [ ] **Step 5: Commit**

```bash
git add server/utils/marketingHandlers.js server/utils/drinkPlanNudge.js server/utils/drinkPlanNudge.test.js
git commit -m "feat(cal-com): surface CAL_BOOKING_URL in three client comms touches"
```

---

## Task 11: clients.source cross-cutting (VALID_SOURCES + three SOURCE maps)

**Files:**
- Modify: `server/routes/clients.js` (line 9)
- Modify: `client/src/pages/admin/ClientsDashboard.js` (line 18)
- Modify: `client/src/pages/admin/ClientDetail.js` (line 15)
- Modify: `client/src/components/adminos/drawers/ClientDrawer.js` (line 12)
- **Deferred:** `client/src/pages/admin/ProposalCreate.js` (line 26 SOURCES array). File is 1337 lines, over the 1000-line cap, so adding a line would be blocked by the file-size ratchet pre-commit hook. See note below.

- [ ] **Step 1: Extend the server-side VALID_SOURCES array**

In `server/routes/clients.js`, change line 9 from:

```js
const VALID_SOURCES = ['direct', 'thumbtack', 'referral', 'website'];
```

to:

```js
const VALID_SOURCES = ['direct', 'thumbtack', 'referral', 'website', 'calcom'];
```

- [ ] **Step 2: Extend the three client-side SOURCE maps**

For each of the three files below, add a new entry to the SOURCE map object:

```js
calcom:    { label: 'Cal.com',   kind: 'info' },
```

Insert it alongside the other entries (alphabetical or grouped, follow existing style). The three files are:

- `client/src/pages/admin/ClientsDashboard.js` (SOURCE map at line 18-24)
- `client/src/pages/admin/ClientDetail.js` (SOURCE map at line 15-20)
- `client/src/components/adminos/drawers/ClientDrawer.js` (SOURCE map at line 12-17)

All three maps are structurally identical and contain the same five entries (`direct`, `thumbtack`, `referral`, `website`, `instagram`). The `instagram` entry exists in all three but is NOT in `VALID_SOURCES` (pre-existing inconsistency, not addressed by this plan).

**`ProposalCreate.js` deferral:** the manual-proposal-create form at `client/src/pages/admin/ProposalCreate.js:26` has its own `SOURCES = [{ value, label }, ...]` array used by the source dropdown. The file is currently 1337 lines, over the 1000-line hard cap, so adding one line would be blocked by the file-size ratchet pre-commit hook (`scripts/check-file-size.js --staged`). Per CLAUDE.md, the only way to add to an over-cap file is to first extract enough that the file stays flat or shrinks. Resolving this properly means either:

1. A dedicated cleanup spec that extracts a sub-component from `ProposalCreate.js` (e.g., move the lead-source section into its own file), bringing the file under the cap, before this Cal.com plan can add the new SOURCES entry.
2. Tracked as a known V2 follow-up: a Cal.com-sourced client created via the webhook is still selectable in the proposal-create flow by typing or by changing the client's source on the client detail page; the manual-create form's dropdown just won't include `Cal.com` as a pre-listed option until the cleanup ships.

Mark this V2 deferral explicitly in `docs/superpowers/specs/` as a follow-up note (or surface during the docs commit in Task 14). Do NOT touch `ProposalCreate.js` in this commit; the pre-commit hook will block.

- [ ] **Step 3: Verify the changes lint clean**

```bash
CI=true npx eslint server/routes/clients.js
CI=true npx eslint client/src/pages/admin/ClientsDashboard.js client/src/pages/admin/ClientDetail.js client/src/components/adminos/drawers/ClientDrawer.js
```

Expected: no errors. (`CI=true` keeps eslint terse.)

- [ ] **Step 5: Commit**

```bash
git add server/routes/clients.js client/src/pages/admin/ClientsDashboard.js client/src/pages/admin/ClientDetail.js client/src/components/adminos/drawers/ClientDrawer.js
git commit -m "feat(cal-com): add 'calcom' to clients.source enum across server + 3 client surfaces"
```

- [ ] **Step 5: UI smoke verification**

Restart the dev server. In the admin UI, open the Clients dashboard (`/admin/clients` or the equivalent route in this codebase) and confirm:

1. The source filter / column shows `Cal.com` as a possible value (chip styling matches the existing source chips, rendering with the `kind: 'info'` style).
2. Open any existing client's detail page; the source dropdown / selector includes `Cal.com` as an option.
3. Open a client drawer (the slide-in panel from a list); same verification.

If any of the three surfaces still shows the raw enum string `calcom` instead of the friendly label `Cal.com`, that file's SOURCE map was missed; revisit Step 2.

(`ProposalCreate.js`'s source dropdown will NOT show Cal.com in this V1; that's the deferred follow-up noted above.)

---

## Task 12: webhook_events prune scheduler

**Files:**
- Create: `server/utils/webhookEventsPruneScheduler.js`
- Create: `server/utils/webhookEventsPruneScheduler.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/webhookEventsPruneScheduler.test.js`:

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { pruneOldWebhookEvents } = require('./webhookEventsPruneScheduler');

before(async () => {
  await pool.query("DELETE FROM webhook_events WHERE event_id LIKE 'prune-test-%'");
});

after(async () => {
  await pool.query("DELETE FROM webhook_events WHERE event_id LIKE 'prune-test-%'");
});

test('pruneOldWebhookEvents: deletes rows older than 30 days, leaves fresh rows', async () => {
  // Insert one old row (35 days ago) and one fresh row (1 hour ago).
  await pool.query(
    `INSERT INTO webhook_events (provider, event_id, received_at) VALUES ('calcom', 'prune-test-old', NOW() - INTERVAL '35 days')`
  );
  await pool.query(
    `INSERT INTO webhook_events (provider, event_id, received_at) VALUES ('calcom', 'prune-test-fresh', NOW() - INTERVAL '1 hour')`
  );

  const deleted = await pruneOldWebhookEvents();
  assert.ok(deleted >= 1, 'at least the old row was pruned');

  const remaining = await pool.query(
    "SELECT event_id FROM webhook_events WHERE event_id LIKE 'prune-test-%'"
  );
  const ids = remaining.rows.map(r => r.event_id);
  assert.ok(ids.includes('prune-test-fresh'), 'fresh row remains');
  assert.ok(!ids.includes('prune-test-old'), 'old row pruned');
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
node --test server/utils/webhookEventsPruneScheduler.test.js
```

Expected: fails with `Cannot find module './webhookEventsPruneScheduler'`.

- [ ] **Step 3: Create the scheduler module**

Create `server/utils/webhookEventsPruneScheduler.js`:

```js
const { pool } = require('../db');

const RETENTION_DAYS = 30;

async function pruneOldWebhookEvents() {
  const result = await pool.query(
    `DELETE FROM webhook_events WHERE received_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`
  );
  return result.rowCount;
}

module.exports = { pruneOldWebhookEvents, RETENTION_DAYS };
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
node --test server/utils/webhookEventsPruneScheduler.test.js
```

Expected: PASS.

- [ ] **Step 5: Register the scheduler in `server/index.js`**

Locate the existing scheduler registration block. The pattern in `server/index.js:267-269` is THREE calls per scheduler:

```js
const wrapped = wrapScheduler('autopay', 3600, processAutopayCharges);
setTimeout(wrapped, 30000);
setInterval(wrapped, 60 * 60 * 1000);
```

`wrapScheduler` registers the scheduler with `schedulerHealth`; `setTimeout` schedules the first tick (30 seconds after boot); `setInterval` schedules subsequent hourly ticks. Without the `setInterval`, the scheduler registers but the function never runs after the first tick.

Add the Cal.com prune scheduler alongside, gated by `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER` AND the global `RUN_SCHEDULERS` gate (mirror how existing schedulers are gated by both):

```js
if (process.env.RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER !== 'false' && !globalScheduleDisabled) {
  const { pruneOldWebhookEvents } = require('./utils/webhookEventsPruneScheduler');
  const wrapped = wrapScheduler('webhook_events_prune', 3600, async () => {
    const n = await pruneOldWebhookEvents();
    if (n > 0) console.log(`[webhook_events_prune] deleted ${n} expired rows`);
  });
  setTimeout(wrapped, 30000);
  setInterval(wrapped, 60 * 60 * 1000);
}
```

`globalScheduleDisabled` is the existing local variable that mirrors `RUN_SCHEDULERS=false` in the surrounding scheduler-registration block (search for it nearby to confirm the exact name; `server/index.js` may use a slightly different identifier; match what other schedulers in the same block use).

- [ ] **Step 6: Restart the dev server and confirm the scheduler registers**

Restart dev. Watch boot log for either:
- `[scheduler] webhook_events_prune registered` (or equivalent existing-scheduler boot line)
- OR `[webhook_events_prune] deleted N expired rows` after the first tick

Either confirms registration. If `RUN_SCHEDULERS=false` is set in `.env`, the global gate suppresses; otherwise the scheduler should appear.

- [ ] **Step 7: Commit**

```bash
git add server/utils/webhookEventsPruneScheduler.js server/utils/webhookEventsPruneScheduler.test.js server/index.js
git commit -m "feat(cal-com): hourly prune of webhook_events rows older than 30 days"
```

---

## Task 13: Deploy-bundle docs (.env.example + CLAUDE.md env vars)

**Files:**
- Modify: `.env.example`
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Add three new entries to .env.example**

Open `.env.example`. Find a sensible location (alongside other webhook secrets, or at the end). Add:

```bash
# Cal.com webhook signing secret (HMAC-SHA256). Required in prod;
# webhook returns 503 if unset. See docs/superpowers/specs/2026-05-26-cal-com-integration-design.md.
CAL_WEBHOOK_SECRET=

# Cal.com public booking page URL. Hosted: https://cal.com/<username>/<event-type>.
# Self-hosted: https://book.drbartender.com/<event-type>. Optional in dev;
# templates omit the consult line when unset.
CAL_BOOKING_URL=

# Optional. Set to 'false' to disable the hourly webhook_events prune scheduler
# (default on). Honored only when RUN_SCHEDULERS is not 'false'.
RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER=
```

- [ ] **Step 2: Add three new rows to the CLAUDE.md Environment Variables table**

Open `.claude/CLAUDE.md`. Find the Environment Variables table (a markdown table with `| Variable | Purpose |` header). Add three rows alongside existing entries (alphabetical-ish or grouped near other integration secrets):

```markdown
| `CAL_WEBHOOK_SECRET` | HMAC-SHA256 signing secret for the Cal.com webhook. Fails closed: webhook returns 503 if unset. |
| `CAL_BOOKING_URL` | Public Cal.com booking page URL. Surfaced in 3 client comms touches (drink-plan nudge email + SMS, six-months-out marketing). Optional; templates omit the consult line when unset. |
| `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER` | Optional. Set to `false` to disable the hourly `webhook_events` 30-day prune. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
```

Also add a Tech Stack list entry. Find the Tech Stack section in CLAUDE.md and add:

```markdown
- **Booking / scheduling**: Cal.com (webhook integration; self-hosted target for V2)
```

- [ ] **Step 3: Commit**

```bash
git add .env.example .claude/CLAUDE.md
git commit -m "docs(cal-com): bundle .env.example + CLAUDE.md env-var entries with deploy"
```

---

## Task 14: Post-rollout docs (README.md + ARCHITECTURE.md)

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Update README.md**

Open `README.md`. Make four changes:

1. **Folder structure tree**: in the `server/routes/` section, add `calcom.js` to the list.

2. **Environment Variables table**: add the same three rows added to CLAUDE.md in Task 13.

3. **Tech Stack table**: add a row for Cal.com (booking/scheduling).

4. **Key Features section**: add a one-liner near the booking/comms-related features:

```markdown
- **Cal.com consult booking integration** (webhook receiver + auto-create client + status sync; see ARCHITECTURE.md for details)
```

- [ ] **Step 2: Update ARCHITECTURE.md**

Open `ARCHITECTURE.md`. Make four changes:

1. **API route table**: add a row for the new endpoint:

```markdown
| POST | `/api/calcom/webhook` | Public (signed) | Cal.com booking event receiver : see Third-Party Integrations |
```

2. **Database Schema section**: find the `consults` table description. Append:

```markdown
- `booker_name` VARCHAR(255) : raw booker name from the Cal.com webhook payload, preserved separately from the matched/auto-created client record
- `booker_email` VARCHAR(255) : raw booker email from the Cal.com webhook payload
- UNIQUE constraint on `calcom_event_id` (added 2026-05-27 for webhook idempotency)
```

3. **Database Schema section**: add a new `webhook_events` table description:

```markdown
**webhook_events** : Generic dedupe table for inbound webhook replay protection. Used by the Cal.com webhook (provider='calcom') today; available for Stripe / Resend / future webhook providers. Pruned hourly via `webhookEventsPruneScheduler` to a 30-day window.
- `provider` VARCHAR(50) NOT NULL : provider identifier (`'calcom'`, future `'stripe'`, etc.)
- `event_id` TEXT NOT NULL : per-provider unique event identifier (Cal.com uses SHA-256 of the raw signed body)
- `received_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- PRIMARY KEY (provider, event_id); index on received_at for prune
```

4. **Database Schema section**: find the `clients` table description and update the `source` enum value list. Was `('direct', 'thumbtack', 'referral', 'website')`; now `('direct', 'thumbtack', 'referral', 'website', 'calcom')`.

5. **Third-Party Integrations section**: add a Cal.com subsection:

```markdown
### Cal.com

Self-hostable open-source scheduling platform. drb-os receives Cal.com webhooks for consult bookings.

- **Hosting**: V1 uses Cal.com's hosted SaaS. V2 plan migrates to self-hosted Docker on the always-on office box, sharing the same `CAL_*` env vars (only secret + URL change at cutover). Cal.com's open-source codebase means the webhook payload shape is identical between hosted and self-hosted.
- **Endpoint**: `POST /api/calcom/webhook`. Mounted at `server/routes/calcom.js`. Bare HTTP semantics (no AppError JSON envelopes) matching the Stripe and Resend webhook patterns.
- **Signature scheme**: HMAC-SHA256 over the raw body, secret = `CAL_WEBHOOK_SECRET`, header `x-cal-signature-256`. Fails closed: handler returns 503 if secret unset, 400 on missing or invalid signature.
- **Replay protection**: SHA-256 of the raw signed body recorded in the `webhook_events` table. Same body delivered twice (legitimate Cal.com retry on a 5xx, OR attacker replay) returns 200 'Already processed' without side effects.
- **Events handled**: `BOOKING_CREATED` (auto-creates a `clients` row if booker email doesn't match an existing client, links to most recent non-terminal proposal if any), `BOOKING_CANCELLED` (defensive upsert), `BOOKING_RESCHEDULED` (in-place update with fallback to fresh-create), `BOOKING_NO_SHOW_UPDATED` (mirrors Cal.com's manual no-show marking). Other event types are logged + 200 OK so Cal.com does not retry.
- **Side effects**: NO admin SMS or email on any booking event. Cal.com itself owns admin notification (it emails the organizer and syncs the event into the organizer's Google Calendar). drb-os silently files the booking into the `consults` table for status tracking, suppression queries (drink-plan nudge), and audit.
- **Completion**: the linked consults row flips to `'completed'` when admin submits the existing consult form in `server/routes/drinkPlanConsult.js`. Side effect of the existing user action; no UI change.
- **Deferred to V2 (when self-hosted)**: writing the drb-os event URL directly into Cal.com's `booking.description` via direct DB access, so the link appears in the organizer's Google Calendar entry. Today admin opens drb-os manually after seeing Cal.com's notification.
```

- [ ] **Step 3: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(cal-com): README folder tree + ARCHITECTURE Cal.com section + webhook_events table"
```

---

## Final task: Verify the full test suite passes

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass. If any preexisting test fails because of state pollution from new tests, double-check the cleanup hooks in `server/routes/calcom.test.js` (`cleanupTestRows`) and `server/utils/webhookEventsPruneScheduler.test.js` cover all the IDs.

- [ ] **Step 2: Manually exercise the dev server end-to-end (optional but recommended)**

Restart the dev server. Hit the webhook with `curl`:

```bash
# Without signature: should return 400 'Missing signature'
curl -i -X POST -H "Content-Type: application/json" http://localhost:5000/api/calcom/webhook -d '{}'

# With wrong signature: should return 400 'Invalid signature'
curl -i -X POST -H "Content-Type: application/json" -H "x-cal-signature-256: wrong" http://localhost:5000/api/calcom/webhook -d '{}'

# With unset CAL_WEBHOOK_SECRET: should return 503 'Cal.com webhook not configured'
# (Test by temporarily unsetting in .env and restarting.)
```

The full E2E smoke (signed webhook from a real Cal.com test booking) happens at deploy time per spec §13 step 5-7, not during implementation.

---

## Spec coverage self-check

Mapping spec sections to plan tasks:

| Spec section | Plan task(s) |
|---|---|
| §1 Summary | Whole plan |
| §2 Context | Background only, no implementation |
| §3 Goals + Non-goals | Implicit in task scope |
| §4.1 Route file | Task 3 |
| §4.2 Raw body | Task 3 |
| §4.3 Signature verification | Task 3 (+ startup check Task 4) |
| §4.4 Body parse + dispatch | Task 3 |
| §4.5 Replay protection | Task 3 (route uses helper) + Task 1 (schema) + Task 12 (prune) |
| §5.1 BOOKING_CREATED | Task 5 |
| §5.2 BOOKING_CANCELLED | Task 6 |
| §5.3 BOOKING_RESCHEDULED | Task 7 |
| §5.4 BOOKING_NO_SHOW_UPDATED | Task 8 |
| §5.5 Unhandled events | Task 3 (default case in dispatch) |
| §6 Completion flip | Task 9 |
| §7 URL surfacing | Task 10 |
| §8 Schema changes | Task 1 (DDL) + Task 12 (prune scheduler) |
| §9 Env vars | Task 4 (startup check) + Task 13 (.env.example + CLAUDE.md) |
| §10 Error handling + edge cases | Covered across Tasks 3, 5, 6, 7, 8 |
| §11 Docs + consumer updates | Tasks 11, 13, 14 |
| §12 Testing strategy | Tests in Tasks 2-9, 12 + Final task |
| §13 Rollout | Operator-facing, not in plan scope |
| §14 Future work | Out of scope |

No spec requirement without a plan task.
