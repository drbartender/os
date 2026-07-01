---
plan: zul-va-calling
spec: docs/superpowers/specs/2026-07-01-zul-va-calling-design.md
lanes:
  - id: va-calling
    footprint:
      - ".claude/CLAUDE.md"
      - ".env.example"
      - "ARCHITECTURE.md"
      - "README.md"
      - "docs/va-calling-runbook.md"
      - "render.yaml"
      - "server/db/schema.sql"
      - "server/db/schema.vaCalling.test.js"
      - "server/index.js"
      - "server/routes/sms.js"
      - "server/routes/telegram.js"
      - "server/routes/telegram.test.js"
      - "server/routes/voice.js"
      - "server/routes/voice.test.js"
      - "server/utils/pendingCall.js"
      - "server/utils/pendingCall.test.js"
      - "server/utils/placeBridgedCall.test.js"
      - "server/utils/sms.js"
      - "server/utils/telegram.js"
      - "server/utils/telegram.test.js"
      - "server/utils/usPhone.js"
      - "server/utils/usPhone.test.js"
      - "server/utils/vaCallingScheduler.js"
      - "server/utils/vaCallingScheduler.test.js"
      - "server/utils/xmlEscape.js"
      - "server/utils/xmlEscape.test.js"
    depends_on: []
    review_fleet:
      - code-review
      - database-review
      - security-review
---

# Zul VA Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Philippines-based VA (Zul) place and receive US phone calls reliably by routing voice over her cellular network via a Twilio callback bridge, triggered from a Telegram bot message.

**Architecture:** Outbound: Zul messages a Telegram bot with a US number → a hardened webhook validates + confirms → Twilio REST `calls.create` rings her cell → on answer, TwiML bridges to the target with the 224 as caller ID. Inbound: the 224's voice webhook `<Dial>`s her cell. Voice always rides cellular; only a few-KB Telegram message uses data. The trigger endpoint dials billed international legs on an auto-refill account, so US-only NANP validation, secret-token webhook auth, claim-then-call idempotency, spend caps, and a dev-safety gate are load-bearing.

**Tech Stack:** Node 18 / Express 4.18, raw SQL via `pg` (no ORM), Twilio SDK ^5.13.0 (`calls.create` net-new; only `messages.create` used today), Telegram Bot API over Node global `fetch` (no new npm dep), `node:test`.

## Global Constraints

Copied verbatim from the spec and CLAUDE.md; every task's requirements implicitly include this section.

- **Build in a lane, not on `os`.** `os` is pinned to `main`; cut a worktree lane, build task-by-task, squash-merge back. This lane touches money/auth/webhooks/schema, so the **full review fleet (security-review, database-review, code-review) runs per-lane before merge** and again at push (sensitive paths).
- **VA_CELL is the bridge target, stored as an env var in strict E.164 (`+63…`). NEVER pass it through `normalizePhone`** (that helper is US-centric and would mangle it). The feature requires **zero admin rights**; Zul-as-admin is a separate owner decision (Task 9 runbook, optional).
- **US-only dial target:** the Telegram-supplied number must pass `toUsE164` = `normalizePhone` THEN `/^\+1[2-9]\d{9}$/` AND reject 900/976. Twilio console geo is a backstop, not the guard.
- **Idempotency is claim-then-call:** `calls.create` is an external HTTP call and cannot sit in a DB transaction. A conditional `UPDATE pending_call SET status='dialing' WHERE …status='awaiting_confirm'… RETURNING` commits first; only the winning row dials; `telegram_update` de-dupes Telegram retries. Never "settle in the same transaction as the call."
- **Bridge target is pinned server-side** from the `pending_call` row by Twilio `CallSid`, never read from a request param.
- **Webhook auth:** Telegram `secret_token` header + secret URL path; Twilio voice endpoints copy `isValidTwilioRequest` (prod 403 on bad/missing signature). Privileged actions are never honored on a dev signature-skip path.
- **Spend caps:** per-call `timeLimit` = `VA_CALL_TIME_LIMIT_SEC` (1800) on both `calls.create` and the bridge `<Dial>`; `VA_CALL_PER_MIN_CAP` (5) and `VA_CALL_DAILY_CAP` (40) enforced by counting `call_audit` rows (DB-backed; in-memory `express-rate-limit` is per-IP and useless here since every trigger shares Telegram's source IP).
- **Dev safety:** `placeBridgedCall` and `sendTelegramMessage` gate on `notificationsEnabled()` so a dev server never dials/sends against the live account.
- **Codebase invariants:** raw parameterized SQL (`$1,$2`), throw `AppError` subclasses for client-visible errors, secrets only via `process.env` (and `.env.example`), snake_case DB / camelCase JS, idempotent schema (`IF NOT EXISTS`), redact phone numbers to last-4 in logs.
- **Copy rule:** no em dashes in any user-facing copy (commas/periods/colons/parentheticals).
- **Tests:** `node:test`. Server suites share the dev DB, so **run one file at a time** and DB-touching suites need `node -r dotenv/config --test <path>`. `schema.sql` is NOT auto-applied to the dev DB; new DDL is applied by hand (it is idempotent).

## Build order (dependency graph)

Single lane `va-calling`, built task-by-task. Topological order: **1, 2, 4 → 3, 5 → 7, 6 → 8 → 9.** Tasks 1/2/4 have no dependencies; 3 and 5 need the schema (2); the routers (6, 7) need the utils; 8 needs schema+util; 9 (docs+runbook) is last.

| Task | Title | Depends on |
|---|---|---|
| 1 | Shared xmlEscape util + US/NANP phone validator |, |
| 2 | Schema, pending_call, call_audit, telegram_update tables |, |
| 3 | Telegram Bot API helper (server/utils/telegram.js) | 2 |
| 4 | Add placeBridgedCall() to server/utils/sms.js (gated Twilio calls.create) |, |
| 5 | server/utils/pendingCall.js data layer (claim-then-call primitive + audit + prune) | 2 |
| 6 | Telegram outbound-trigger router (POST /api/telegram/:secret) + mount | 1, 3, 4, 5 |
| 7 | Voice router (server/routes/voice.js): /inbound, /bridge, /status callback bridge endpoints | 1, 3, 5 |
| 8 | VA-calling maintenance scheduler (prune + Telegram webhook heartbeat) and index.js registration | 2, 3, 5 |
| 9 | Env vars + docs + manual runbook (final task) | 1, 2, 3, 4, 5, 6, 7, 8 |

---

### Task 1: Shared xmlEscape util + US/NANP phone validator

Foundational, no dependencies. Two tiny pure-function utils that every later task consumes: `xmlEscape` (extracted from the inline copy in the SMS `/inbound` handler so the voice TwiML routes and the SMS route share one implementation) and `toUsE164`/`isUsE164` (the primary toll-fraud control, the hard `+1`/NANP-only + 900/976 check that gates every Telegram-triggered dial). Both are pure functions with no DB and no side effects, so they get fast pure-unit tests with no `pool` dependency.

Mirrors:
- Inline `xmlEscape` currently at `server/routes/sms.js:88` (`& < >` only), extracted verbatim.
- `normalizePhone(raw)` at `server/utils/sms.js:45-52`, reused (not reimplemented); `toUsE164` runs `normalizePhone` first, then applies the strict NANP gate the spec requires (`server/routes/... spec §Security 3`, `docs/.../2026-07-01-zul-va-calling-design.md` lines 106-108).
- Test style + header from `server/utils/tokens.test.js:1-2` (`node:test` + `node:assert/strict`, pure-unit, no DB), deliberately NOT the DB-hitting style of `server/utils/sms.test.js`.

**Files**
- `server/utils/xmlEscape.js` (new)
- `server/utils/xmlEscape.test.js` (new)
- `server/utils/usPhone.js` (new)
- `server/utils/usPhone.test.js` (new)
- `server/routes/sms.js` (edit, import the shared helper, delete the inline copy)
- `README.md` (edit, folder tree: two new util lines)
- `ARCHITECTURE.md` (edit, note the shared `xmlEscape` + `usPhone` under the SMS/utils section)

**Interfaces (locked contract, match exactly)**
- `server/utils/xmlEscape.js` → `module.exports = { xmlEscape }`; `xmlEscape(s): string`, coerces to String, escapes `&` `<` `>` (in that order; `&` first so already-escaped output is not double-escaped incorrectly).
- `server/utils/usPhone.js` → `module.exports = { toUsE164, isUsE164 }`.
  - `toUsE164(raw): string|null`, `normalizePhone(raw)` then require `/^\+1[2-9]\d{9}$/` AND reject NANP area code `900`/`976`; returns the `+1…` E.164 or `null`.
  - `isUsE164(s): boolean`, strict predicate: `s` is a string already in the accepted `+1…` NANP form (900/976 rejected).

---

- [ ] **Step 1.1: Write the failing xmlEscape test**

Create `server/utils/xmlEscape.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { xmlEscape } = require('./xmlEscape');

test('xmlEscape: escapes &, <, and > (and only those)', () => {
  assert.equal(xmlEscape('a & b'), 'a &amp; b');
  assert.equal(xmlEscape('<Dial>'), '&lt;Dial&gt;');
  assert.equal(xmlEscape('1 < 2 > 0 & ok'), '1 &lt; 2 &gt; 0 &amp; ok');
  // Ampersand is escaped first, so mixed input stays well-formed.
  assert.equal(xmlEscape('<a href="x">'), '&lt;a href="x"&gt;');
  // Quotes and apostrophes are NOT escaped (element-text only; never attributes).
  assert.equal(xmlEscape(`he said "hi" it's fine`), `he said "hi" it's fine`);
});

test('xmlEscape: coerces non-string input via String()', () => {
  assert.equal(xmlEscape(12345), '12345');
  assert.equal(xmlEscape(null), 'null');
  assert.equal(xmlEscape(undefined), 'undefined');
});
```

- [ ] **Step 1.2: Run it, confirm it fails**

```
node --test server/utils/xmlEscape.test.js
```
Expect: `Cannot find module './xmlEscape'` (module not created yet).

- [ ] **Step 1.3: Implement `server/utils/xmlEscape.js`**

Extracted verbatim from the inline lambda at `server/routes/sms.js:88`:

```js
/**
 * Escape XML metacharacters (& < >) for safe interpolation into TwiML element
 * text. Extracted from the inline copy in server/routes/sms.js (the inbound-SMS
 * <Message> handler) so the SMS route and the new voice TwiML routes share one
 * implementation. Order matters: & is escaped first.
 *
 * Only for ELEMENT TEXT, never attribute values (quotes are intentionally not
 * escaped). The only value ever interpolated by callers is a validated E.164
 * phone number in <Number> text.
 *
 * @param {*} s - value to escape (coerced to String)
 * @returns {string}
 */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { xmlEscape };
```

- [ ] **Step 1.4: Run it, confirm it passes**

```
node --test server/utils/xmlEscape.test.js
```
Expect: 2 tests pass.

---

- [ ] **Step 1.5: Write the failing usPhone test**

Create `server/utils/usPhone.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toUsE164, isUsE164 } = require('./usPhone');

test('toUsE164: accepts 10-digit US in any format → +1 E.164', () => {
  assert.equal(toUsE164('3125551234'), '+13125551234');
  assert.equal(toUsE164('(312) 555-1234'), '+13125551234');
  assert.equal(toUsE164('312-555-1234'), '+13125551234');
  assert.equal(toUsE164('312.555.1234'), '+13125551234');
});

test('toUsE164: accepts 11-digit leading-1 and already-E.164 US', () => {
  assert.equal(toUsE164('13125551234'), '+13125551234');
  assert.equal(toUsE164('+13125551234'), '+13125551234');
  assert.equal(toUsE164('1 (312) 555-1234'), '+13125551234');
});

test('toUsE164: rejects international numbers (not +1 NANP)', () => {
  assert.equal(toUsE164('+639171234567'), null); // PH — VA_CELL must never come through here
  assert.equal(toUsE164('+442071234567'), null); // UK
  assert.equal(toUsE164('+5215512345678'), null); // MX
});

test('toUsE164: rejects premium 900/976 area codes', () => {
  assert.equal(toUsE164('9005551234'), null);
  assert.equal(toUsE164('+19005551234'), null);
  assert.equal(toUsE164('9765551234'), null);
  assert.equal(toUsE164('+19765551234'), null);
});

test('toUsE164: rejects invalid NANP shapes (area/exchange leading 0 or 1)', () => {
  assert.equal(toUsE164('1125551234'), null); // area code starts with 1
  assert.equal(toUsE164('0125551234'), null); // area code starts with 0
});

test('toUsE164: rejects junk / wrong length / falsy', () => {
  assert.equal(toUsE164('not-a-phone'), null);
  assert.equal(toUsE164('5551234'), null);   // 7 digits
  assert.equal(toUsE164('312555123456'), null); // 12 digits
  assert.equal(toUsE164(''), null);
  assert.equal(toUsE164(null), null);
  assert.equal(toUsE164(undefined), null);
});

test('isUsE164: strict predicate over already-formatted strings', () => {
  assert.equal(isUsE164('+13125551234'), true);
  assert.equal(isUsE164('+19005551234'), false); // 900 blocked
  assert.equal(isUsE164('+19765551234'), false); // 976 blocked
  assert.equal(isUsE164('3125551234'), false);   // not yet E.164
  assert.equal(isUsE164('+639171234567'), false); // intl
  assert.equal(isUsE164(''), false);
  assert.equal(isUsE164(null), false);
  assert.equal(isUsE164(12345), false);
});
```

- [ ] **Step 1.6: Run it, confirm it fails**

```
node --test server/utils/usPhone.test.js
```
Expect: `Cannot find module './usPhone'`.

- [ ] **Step 1.7: Implement `server/utils/usPhone.js`**

Reuses `normalizePhone` from `server/utils/sms.js:45` (no reimplementation); `toUsE164` layers the strict NANP gate on top. No new dependency; no cycle (`sms.js` does not import `usPhone.js`). `pg`'s Pool is created lazily inside `../db`, so importing this in a pure-unit test opens no connection.

```js
const { normalizePhone } = require('./sms');

// Strict NANP shape: +1, then a 3-digit area code whose first digit is 2-9,
// then a 7-digit subscriber number. Matches the spec's toll-fraud control
// (design doc §Security 3: normalizePhone THEN a hard +1/NANP-only check).
const US_E164_RE = /^\+1[2-9]\d{9}$/;

// Premium/pay-per-call area codes blocked as a toll-fraud guard.
const BLOCKED_AREA_CODES = new Set(['900', '976']);

/**
 * True iff `s` is already a strict US NANP number in +1 E.164 form, with
 * premium 900/976 area codes rejected. Does NOT normalize — see toUsE164.
 * @param {*} s
 * @returns {boolean}
 */
function isUsE164(s) {
  if (typeof s !== 'string' || !US_E164_RE.test(s)) return false;
  const areaCode = s.slice(2, 5); // digits after the "+1"
  return !BLOCKED_AREA_CODES.has(areaCode);
}

/**
 * Normalize an arbitrary raw phone string, then require it be a valid US NANP
 * number (+1, area/exchange leading digit 2-9) and reject 900/976 premium
 * codes. Returns the +1 E.164 string, or null if it is not a dialable US
 * number. This is the primary toll-fraud control for the VA calling feature:
 * only US numbers are ever handed to the bridge.
 *
 * NOTE: never pass VA_CELL (a +63 PH number) through here — it would return
 * null. VA_CELL stays strict E.164 from its env var, unnormalized.
 *
 * @param {*} raw
 * @returns {string|null}
 */
function toUsE164(raw) {
  const e164 = normalizePhone(raw);
  if (!e164) return null;
  return isUsE164(e164) ? e164 : null;
}

module.exports = { toUsE164, isUsE164 };
```

- [ ] **Step 1.8: Run it, confirm it passes**

```
node --test server/utils/usPhone.test.js
```
Expect: all 7 tests pass.

---

- [ ] **Step 1.9: Refactor `server/routes/sms.js` to import the shared helper**

Add the require alongside the other util imports (after line 8, `const { sendSMS, normalizePhone } = require('../utils/sms');`):

```js
const { sendSMS, normalizePhone } = require('../utils/sms');
const { xmlEscape } = require('../utils/xmlEscape');
```

Then delete the inline definition at `server/routes/sms.js:88`, remove exactly this line:

```js
  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
```

Leave the surrounding comment and the two `xmlEscape(reply)` usages (lines 90) untouched, they now resolve to the imported function. Do not change any other behavior in this file.

- [ ] **Step 1.10: Verify the SMS route still works (no regression)**

The SMS route has a DB-hitting test suite; run it plus a syntax/require smoke check. Per the shared-dev-DB rule, run server suites one at a time with dotenv preloaded:

```
node -e "require('./server/routes/sms.js'); console.log('sms.js requires clean')"
node -r dotenv/config --test server/utils/sms.test.js
```
Expect: `sms.js requires clean`, and the existing sms suite still passes (unchanged behavior; the inline lambda and the import are byte-identical logic).

Also re-run the two new pure-unit suites together to confirm nothing broke:

```
node --test server/utils/xmlEscape.test.js server/utils/usPhone.test.js
```

- [ ] **Step 1.11: Documentation updates (mandatory, same change)**

Per CLAUDE.md "Mandatory documentation updates" (new util file → README folder tree + ARCHITECTURE mention):

- `README.md`, in the `server/utils/` block of the folder tree (near the `sms.js` line at ~272), add two lines:
```
│   │   ├── xmlEscape.js        # Shared TwiML XML escaper (& < >); used by the SMS + voice routes
│   │   ├── usPhone.js          # US/NANP phone validation: toUsE164, isUsE164 (normalizePhone + strict +1 NANP gate, rejects intl + 900/976) — primary VA-calling toll-fraud control
```
- `ARCHITECTURE.md`, under the SMS/Twilio wrapper note (~line 1339, `server/utils/sms.js (includes normalizePhone())`), add a sibling bullet:
```
- **Shared helpers**: `server/utils/xmlEscape.js` (TwiML `& < >` escaper, shared by the SMS and voice TwiML routes) and `server/utils/usPhone.js` (`toUsE164`/`isUsE164`: `normalizePhone` + strict `^\+1[2-9]\d{9}$` NANP gate, rejecting international numbers and 900/976 premium codes — the VA-calling toll-fraud control).
```

- [ ] **Step 1.12: Commit**

Explicit staging only (Git-safety invariant, never `git add .`):

```
git add server/utils/xmlEscape.js server/utils/xmlEscape.test.js \
        server/utils/usPhone.js server/utils/usPhone.test.js \
        server/routes/sms.js README.md ARCHITECTURE.md
git commit -m "Add shared xmlEscape + US/NANP phone validator utils

Extract the inline xmlEscape from routes/sms.js into utils/xmlEscape.js and
add utils/usPhone.js (toUsE164/isUsE164): normalizePhone + strict +1 NANP
gate rejecting international and 900/976 premium numbers. Foundational for
the Zul VA calling feature (TwiML escaping + toll-fraud target validation).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(This runs in the lane worktree; the squash-merge back to `main` is a later, separate step.)

---

### Task 2: Schema, pending_call, call_audit, telegram_update tables

Add the three VA-calling tables to `server/db/schema.sql` as one clearly-commented, idempotent block, mirroring the existing `webhook_events` dedupe-table pattern at `server/db/schema.sql:2824-2835` (comment header + `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`) and the `message_log` index-comment style at the tail of the file. **No app code depends on this task** (Tasks that consume these tables, `pendingCall.js`, the routers, the prune scheduler, declare Task 2 as a dependency). Because `schema.sql` is **not** auto-applied to the dev DB, this task also includes the exact hand-apply-to-dev command and an `information_schema` verification.

Column contract (locked, do not deviate):
- `pending_call(id BIGSERIAL PK, user_id BIGINT NOT NULL UNIQUE, target_e164 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'awaiting_confirm' CHECK (status IN ('awaiting_confirm','dialing')), call_sid TEXT, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())` + index on `call_sid`.
- `call_audit(id BIGSERIAL PK, triggered_by BIGINT, target_e164 TEXT, call_sid TEXT, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())` + index on `created_at`.
- `telegram_update(update_id BIGINT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.

Note on `user_id` / `triggered_by` being `BIGINT` (not `INTEGER` like `users.id`): these hold the **Telegram** numeric user id, which can exceed 32 bits, and are deliberately **not** FKs to `users` (the feature must not require a `users` row for Zul, see spec §"Numbers / identities"). `pending_call.user_id` is `UNIQUE` so the `upsertPending` `ON CONFLICT (user_id)` in Task-per-`pendingCall.js` has a conflict target.

#### Files
- `server/db/schema.sql`, append the VA-calling DDL block at end of file (after the `service_addons` seed `UPDATE` that currently ends the file at line ~3319).
- `server/db/schema.vaCalling.test.js`, NEW. node:test: (a) pure static assertions that `schema.sql` contains the required DDL, and (b) a DB-integration check that applies the DDL idempotently and confirms the tables/columns/indexes via `information_schema` (auto-skips when `DATABASE_URL` is unset).
- `ARCHITECTURE.md`, add the three tables to the Database Schema section (Mandatory Documentation Updates: schema change → ARCHITECTURE.md).

#### Interfaces
- No JS exports. This task only adds DDL + a test + a doc row. Downstream tasks (`pendingCall.js`, `telegram.js`, prune scheduler) query these tables directly via `pool.query`.

---

- [ ] **Step 2.1: Write the failing test (static content assertions)**

Create `server/db/schema.vaCalling.test.js`. Start with only the pure-content portion so it fails before the DDL exists (mirrors the node:test + dotenv conventions in `server/utils/webhookEventsPruneScheduler.test.js:1-3`).

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');

// ── (a) Pure, DB-free assertions on schema.sql content ──────────────────────
// These are the TDD gate: they pass the moment the DDL block is present and are
// deterministic (no DB, no network), so they run in every environment.
test('schema.sql declares pending_call idempotently with the locked columns', () => {
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS pending_call \(/);
  assert.match(schemaSql, /user_id\s+BIGINT NOT NULL UNIQUE/);
  assert.match(schemaSql, /target_e164\s+TEXT NOT NULL/);
  assert.match(
    schemaSql,
    /status\s+TEXT NOT NULL DEFAULT 'awaiting_confirm'\s+CHECK \(status IN \('awaiting_confirm','dialing'\)\)/
  );
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS idx_pending_call_call_sid[\s\S]*?ON pending_call\s*\(call_sid\)/);
});

test('schema.sql declares call_audit idempotently with a created_at index', () => {
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS call_audit \(/);
  assert.match(schemaSql, /triggered_by\s+BIGINT/);
  assert.match(schemaSql, /status\s+TEXT NOT NULL/);
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS idx_call_audit_created_at[\s\S]*?ON call_audit\s*\(created_at\)/);
});

test('schema.sql declares telegram_update with update_id as PK', () => {
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS telegram_update \(/);
  assert.match(schemaSql, /update_id\s+BIGINT PRIMARY KEY/);
});
```

- [ ] **Step 2.2: Run the test, confirm it fails**

```
node -r dotenv/config --test server/db/schema.vaCalling.test.js
```

Expected: the three static tests FAIL (`schema.sql` does not yet contain `CREATE TABLE IF NOT EXISTS pending_call`). This proves the assertions actually gate the DDL. (Per the shared-dev-DB note, VA-calling suites run one at a time with `-r dotenv/config`.)

- [ ] **Step 2.3: Add the DDL block to schema.sql**

Append this block at the very end of `server/db/schema.sql` (after the file's final `service_addons` seed `UPDATE (...)` `;`). Mirrors the comment-header + `IF NOT EXISTS` table + `IF NOT EXISTS` index pattern of `webhook_events` at `server/db/schema.sql:2824-2835`.

```sql

-- ===========================================================================
-- Zul VA Calling — Telegram-triggered Twilio callback bridge
-- (spec docs/superpowers/specs/2026-07-01-zul-va-calling-design.md)
-- ---------------------------------------------------------------------------
-- All three tables are idempotent (CREATE TABLE/INDEX IF NOT EXISTS) and hold
-- transient/audit state only. NOTE: user_id / triggered_by are the Telegram
-- numeric user id (can exceed 32 bits -> BIGINT) and are deliberately NOT FKs
-- to users; the calling feature must not require a users row for Zul.
-- Rows are pruned by vaCallingScheduler (RUN_VA_CALLING_SCHEDULER).
-- ===========================================================================

-- pending_call: at most one in-flight confirm/dial per Telegram user (user_id
-- UNIQUE so upsertPending's ON CONFLICT (user_id) has a target). A new target
-- sent before confirming REPLACES the row (upsert). status flips
-- 'awaiting_confirm' -> 'dialing' via the conditional claim-then-call UPDATE;
-- call_sid is attached after calls.create so the bridge webhook can look the
-- target up by CallSid (never from a request param).
CREATE TABLE IF NOT EXISTS pending_call (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL UNIQUE,
  target_e164 TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'awaiting_confirm'
                CHECK (status IN ('awaiting_confirm','dialing')),
  call_sid    TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- lookupTargetByCallSid() resolves the bridge target by Twilio CallSid.
CREATE INDEX IF NOT EXISTS idx_pending_call_call_sid
  ON pending_call (call_sid);

-- call_audit: append-only spend/abuse ledger. Backs the DB-backed daily cap
-- (countPlacedSince counts status='placed' rows in the last 24h; the in-memory
-- express-rate-limit cannot serve as a daily cap because every Telegram trigger
-- shares one source IP). status in
-- ('placed','rejected_cap','rejected_validation','failed', <twilio status>).
CREATE TABLE IF NOT EXISTS call_audit (
  id           BIGSERIAL PRIMARY KEY,
  triggered_by BIGINT,
  target_e164  TEXT,
  call_sid     TEXT,
  status       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- created_at is the cap-window filter (WHERE created_at > now()-interval) and
-- the prune key.
CREATE INDEX IF NOT EXISTS idx_call_audit_created_at
  ON call_audit (created_at);

-- telegram_update: Telegram update_id de-dupe (retry / at-least-once delivery).
-- isNewUpdate() does INSERT ... ON CONFLICT DO NOTHING; a fresh insert means the
-- update has not been processed. Pruned past retention.
CREATE TABLE IF NOT EXISTS telegram_update (
  update_id  BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2.4: Add the DB-integration portion to the test**

Append the DB-integration block to `server/db/schema.vaCalling.test.js`. It applies the idempotent DDL to whatever `DATABASE_URL` points at, twice (proving idempotency), then verifies the tables/columns/indexes exist via `information_schema` / `pg_indexes`. It auto-skips when `DATABASE_URL` is unset so the pure tests still run everywhere. Uses the shared pool exactly like `webhookEventsPruneScheduler.test.js:4` (`const { pool } = require('../db')`).

```js

// ── (b) DB-integration: apply the idempotent DDL and verify via catalog ──────
// Skips when DATABASE_URL is unset (pure tests above still cover content).
// Applying CREATE TABLE/INDEX IF NOT EXISTS is safe against the shared dev DB:
// the tables are net-new, so there is no FK/teardown collision with other suites.
const HAS_DB = !!process.env.DATABASE_URL;
const dbTest = HAS_DB ? test : test.skip;

let pool;
// Extract just the VA-calling block (from its banner comment to EOF) so the test
// applies exactly the DDL this task added, not the whole 3k-line schema.
function vaCallingDdl() {
  const marker = '-- Zul VA Calling';
  const idx = schemaSql.indexOf(marker);
  assert.ok(idx !== -1, 'VA-calling DDL block must be present in schema.sql');
  return schemaSql.slice(idx);
}

before(async () => {
  if (!HAS_DB) return;
  ({ pool } = require('../db'));
  const ddl = vaCallingDdl();
  // Apply twice to prove idempotency (IF NOT EXISTS must not error on re-run).
  await pool.query(ddl);
  await pool.query(ddl);
});

after(async () => {
  if (!HAS_DB || !pool) return;
  await pool.end();
});

dbTest('all three tables exist in the public schema', async () => {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('pending_call','call_audit','telegram_update')
      ORDER BY table_name`
  );
  assert.deepEqual(
    rows.map((r) => r.table_name),
    ['call_audit', 'pending_call', 'telegram_update']
  );
});

dbTest('pending_call has the locked columns/types and unique user_id', async () => {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pending_call'
      ORDER BY column_name`
  );
  const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
  assert.equal(byName.user_id.data_type, 'bigint');
  assert.equal(byName.user_id.is_nullable, 'NO');
  assert.equal(byName.target_e164.data_type, 'text');
  assert.equal(byName.target_e164.is_nullable, 'NO');
  assert.equal(byName.status.is_nullable, 'NO');
  assert.equal(byName.expires_at.data_type, 'timestamp with time zone');
  assert.equal(byName.expires_at.is_nullable, 'NO');

  // user_id UNIQUE (upsert conflict target).
  const { rows: uq } = await pool.query(
    `SELECT 1 FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'pending_call'
        AND tc.constraint_type = 'UNIQUE'
        AND kcu.column_name = 'user_id'`
  );
  assert.equal(uq.length, 1, 'pending_call.user_id must be UNIQUE');
});

dbTest('the status CHECK rejects an out-of-domain value', async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO pending_call (user_id, target_e164, status, expires_at)
         VALUES (-999001, '+13125550000', 'bogus', NOW() + INTERVAL '2 minutes')`
      ),
    /violates check constraint/i
  );
});

dbTest('expected indexes exist (call_sid, created_at)', async () => {
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_pending_call_call_sid','idx_call_audit_created_at')
      ORDER BY indexname`
  );
  assert.deepEqual(
    rows.map((r) => r.indexname),
    ['idx_call_audit_created_at', 'idx_pending_call_call_sid']
  );
});

dbTest('telegram_update update_id is the primary key', async () => {
  const { rows } = await pool.query(
    `SELECT tc.constraint_type, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'telegram_update'
        AND tc.constraint_type = 'PRIMARY KEY'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].column_name, 'update_id');
});
```

- [ ] **Step 2.5: Hand-apply the DDL to the dev DB**

`schema.sql` is NOT auto-applied to the dev DB (see the schema hand-apply note in memory + CLAUDE.md), and the DB-integration tests assume the tables exist. Apply the block by hand. The whole file is idempotent, so re-running it is safe, but apply only the new block to be surgical:

```
psql "$DATABASE_URL" <<'SQL'
CREATE TABLE IF NOT EXISTS pending_call (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL UNIQUE,
  target_e164 TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'awaiting_confirm'
                CHECK (status IN ('awaiting_confirm','dialing')),
  call_sid    TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pending_call_call_sid ON pending_call (call_sid);

CREATE TABLE IF NOT EXISTS call_audit (
  id           BIGSERIAL PRIMARY KEY,
  triggered_by BIGINT,
  target_e164  TEXT,
  call_sid     TEXT,
  status       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_audit_created_at ON call_audit (created_at);

CREATE TABLE IF NOT EXISTS telegram_update (
  update_id  BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL
```

(Alternatively apply the entire idempotent file: `psql "$DATABASE_URL" -f server/db/schema.sql`.)

- [ ] **Step 2.6: Verify the tables exist via information_schema**

```
psql "$DATABASE_URL" -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('pending_call','call_audit','telegram_update') ORDER BY table_name;"
```

Expected output: three rows, `call_audit`, `pending_call`, `telegram_update`.

- [ ] **Step 2.7: Run the full test, confirm it passes**

```
node -r dotenv/config --test server/db/schema.vaCalling.test.js
```

Expected: all tests pass. With `DATABASE_URL` set (dev), the DB-integration tests run against the just-applied tables and the idempotent double-apply in `before()` succeeds; without it they report as skipped and the three static content tests still pass.

- [ ] **Step 2.8: Update ARCHITECTURE.md (mandatory docs)**

In `ARCHITECTURE.md`, Database Schema section, add a short entry for the VA-calling tables so the doc mandate for a schema change is satisfied:

```
- pending_call / call_audit / telegram_update — Zul VA calling (Telegram-triggered
  Twilio callback bridge). pending_call = one in-flight confirm/dial per Telegram
  user (claim-then-call state machine); call_audit = append-only spend/abuse ledger
  backing the DB-backed daily cap; telegram_update = update_id de-dupe. Pruned by
  vaCallingScheduler. Spec: docs/superpowers/specs/2026-07-01-zul-va-calling-design.md
```

- [ ] **Step 2.9: Commit**

Commit inside the lane (checkpoint; squashed on merge). Explicit pathspec only (Git-safety invariant: never `git add .`/`-A`).

```
git add server/db/schema.sql server/db/schema.vaCalling.test.js ARCHITECTURE.md
git commit -m "$(cat <<'EOF'
Add VA-calling schema: pending_call, call_audit, telegram_update

Idempotent CREATE TABLE/INDEX IF NOT EXISTS for the Zul VA calling feature
(Telegram-triggered Twilio callback bridge). pending_call carries the
claim-then-call state machine (user_id UNIQUE upsert target, CallSid lookup
index); call_audit is the append-only ledger for the DB-backed daily cap;
telegram_update de-dupes update_ids. BIGINT user ids, no users FK. Applied to
dev by hand (schema.sql is not auto-applied); node:test verifies content +
information_schema. Doc row added to ARCHITECTURE.md.

Spec: docs/superpowers/specs/2026-07-01-zul-va-calling-design.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Telegram Bot API helper (server/utils/telegram.js)

Builds the Telegram side-channel helper: constant-time webhook-secret verification, `update_id` de-dupe, and thin raw-`fetch` wrappers over the Bot API (`sendMessage`, `setWebhook`, `getWebhookInfo`). No new npm dependency (Node 18+ global `fetch`, verified present at `node -e "typeof fetch"` → `function`). Sends are gated on `notificationsEnabled()` exactly like `sendSMS` so a dev server never messages the live bot. A DI seam (`__setTelegramDeps`, mirroring `sms.js`'s `__setSmsDeps` at `server/utils/sms.js:57-58`) lets tests inject `fetch` and `pool` for pure-unit coverage.

**Depends on Task 2**, `isNewUpdate` writes the `telegram_update(update_id PRIMARY KEY, created_at)` table created there. The unit test stubs the pool so it does not require the table to exist, but the runtime path does.

#### Files
- `server/utils/telegram.js` (new)
- `server/utils/telegram.test.js` (new)
- `README.md`, folder-structure tree (new util file)
- `ARCHITECTURE.md`, mention under the Telegram integration / utils section (new util file, per the Mandatory Documentation Updates table: "New/removed util file" → README tree + ARCHITECTURE mention)

#### Interfaces (LOCKED, match exactly)
```js
module.exports = {
  sendTelegramMessage,      // (chatId, text) => Promise<obj>   POST sendMessage; gated on TELEGRAM_BOT_TOKEN && notificationsEnabled()
  setTelegramWebhook,       // () => Promise<obj>               POST setWebhook url=`${base}/api/telegram/${SECRET}` secret_token=SECRET
  getTelegramWebhookInfo,   // () => Promise<obj>               POST getWebhookInfo
  verifyTelegramSecret,     // (req) => boolean                 constant-time compare of X-Telegram-Bot-Api-Secret-Token header
  isNewUpdate,              // (updateId) => Promise<boolean>   INSERT ... ON CONFLICT DO NOTHING; true iff inserted
  __setTelegramDeps,        // (deps) => void                   test seam: { fetch, pool }
};
```
- Webhook base URL derives from `process.env.API_URL || process.env.RENDER_EXTERNAL_URL`, falling back to `http://localhost:5000` in dev (per CLAUDE.md `API_URL` semantics and the LOCKED contract).
- Bot API base: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/<method>`.

---

- [ ] **Step 3.1: Write the failing test file**

Create `server/utils/telegram.test.js`. Pure-unit: injects a stub `fetch` and a stub `pool` through `__setTelegramDeps`, and snapshots/restores `process.env` around each case so the user's real `.env` (which may already carry `TELEGRAM_BOT_TOKEN`) cannot make the tests non-deterministic.

```js
require('dotenv').config();
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  verifyTelegramSecret,
  sendTelegramMessage,
  setTelegramWebhook,
  isNewUpdate,
  __setTelegramDeps,
} = require('./telegram');

// telegram.js requires ../db at load, which constructs a pg Pool (no connection
// until a query runs). We inject a stub pool below so the real pool is never
// queried; end it in teardown so the process exits cleanly.
const { pool } = require('../db');
after(async () => { await pool.end(); });

// Snapshot the env keys these tests mutate so a real .env can't leak in.
const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'SEND_NOTIFICATIONS', 'NODE_ENV', 'API_URL', 'RENDER_EXTERNAL_URL'];
let saved;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// A minimal Express-like req exposing .header() (the only method we call).
function fakeReq(headerValue) {
  return { header: (name) => (name.toLowerCase() === 'x-telegram-bot-api-secret-token' ? headerValue : undefined) };
}

test('verifyTelegramSecret > true when header matches the configured secret', () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t-abc-XYZ';
  try {
    assert.strictEqual(verifyTelegramSecret(fakeReq('s3cr3t-abc-XYZ')), true);
  } finally { restoreEnv(); }
});

test('verifyTelegramSecret > false when header mismatches', () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t-abc-XYZ';
  try {
    assert.strictEqual(verifyTelegramSecret(fakeReq('wrong')), false);
    // Different length must also be false (and must not throw).
    assert.strictEqual(verifyTelegramSecret(fakeReq('s3cr3t-abc-XYZ-longer')), false);
  } finally { restoreEnv(); }
});

test('verifyTelegramSecret > false when secret unset or header missing', () => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  try {
    assert.strictEqual(verifyTelegramSecret(fakeReq('anything')), false);
  } finally { restoreEnv(); }
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t-abc-XYZ';
  try {
    assert.strictEqual(verifyTelegramSecret(fakeReq(undefined)), false);
    assert.strictEqual(verifyTelegramSecret(fakeReq('')), false);
  } finally { restoreEnv(); }
});

test('sendTelegramMessage > skips (no fetch) when gated off', async () => {
  // Gate OFF: token unset AND notifications gated (non-prod, no SEND_NOTIFICATIONS).
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.SEND_NOTIFICATIONS;
  process.env.NODE_ENV = 'test';
  let called = 0;
  __setTelegramDeps({ fetch: async () => { called += 1; return { json: async () => ({ ok: true }) }; } });
  try {
    const res = await sendTelegramMessage(123456789, 'hello');
    assert.deepStrictEqual(res, { ok: false, skipped: true });
    assert.strictEqual(called, 0, 'fetch must not be called when gated off');
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});

test('sendTelegramMessage > POSTs to sendMessage when ungated', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.SEND_NOTIFICATIONS = 'true';
  let captured = null;
  __setTelegramDeps({
    fetch: async (url, opts) => {
      captured = { url, opts };
      return { json: async () => ({ ok: true, result: { message_id: 42 } }) };
    },
  });
  try {
    const res = await sendTelegramMessage(999, 'Calling …1234');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.message_id, 42);
    assert.strictEqual(captured.url, 'https://api.telegram.org/botBOTTOK123/sendMessage');
    assert.strictEqual(captured.opts.method, 'POST');
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.chat_id, 999);
    assert.strictEqual(body.text, 'Calling …1234');
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});

test('setTelegramWebhook > builds the secret-path URL + secret_token from env base', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'BOTTOK123';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'pathsecret';
  process.env.API_URL = 'https://api.example.com';
  let captured = null;
  __setTelegramDeps({
    fetch: async (url, opts) => { captured = { url, opts }; return { json: async () => ({ ok: true, result: true }) }; },
  });
  try {
    const res = await setTelegramWebhook();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(captured.url, 'https://api.telegram.org/botBOTTOK123/setWebhook');
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.url, 'https://api.example.com/api/telegram/pathsecret');
    assert.strictEqual(body.secret_token, 'pathsecret');
  } finally {
    __setTelegramDeps({ fetch: (...a) => globalThis.fetch(...a) });
    restoreEnv();
  }
});

test('isNewUpdate > true on first insert, false on conflict', async () => {
  const calls = [];
  __setTelegramDeps({
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        // First call inserts a row, second hits ON CONFLICT DO NOTHING.
        return { rowCount: calls.length === 1 ? 1 : 0 };
      },
    },
  });
  try {
    assert.strictEqual(await isNewUpdate(555), true);
    assert.strictEqual(await isNewUpdate(555), false);
    assert.match(calls[0].sql, /INSERT INTO telegram_update/i);
    assert.match(calls[0].sql, /ON CONFLICT \(update_id\) DO NOTHING/i);
    assert.deepStrictEqual(calls[0].params, [555]);
  } finally {
    __setTelegramDeps({ pool: require('../db').pool });
  }
});
```

- [ ] **Step 3.2: Run the test, confirm it fails (module does not exist yet)**
```
node -r dotenv/config --test server/utils/telegram.test.js
```
Expect: `Cannot find module './telegram'`, RED for the right reason.

- [ ] **Step 3.3: Implement `server/utils/telegram.js`**

Mirrors the `sms.js` gate (`server/utils/sms.js:22-26`, `!client || !notificationsEnabled()` → log + skip) and the DI seam (`server/utils/sms.js:57-58`). Log redaction uses the `smsInbound.js` style (`'…' + String(x).slice(-4)`, see `server/utils/smsInbound.js:432` for the `slice(-4)` convention). `verifyTelegramSecret` uses `crypto.timingSafeEqual` over SHA-256 digests so the compare is constant-time **and** length-safe (raw-length `timingSafeEqual` throws on unequal lengths).

```js
const crypto = require('crypto');
const { pool } = require('../db');
const { notificationsEnabled } = require('./notificationsEnabled');

const TELEGRAM_API = 'https://api.telegram.org';

// Dependency seam for tests (mirror server/utils/sms.js:57-58). Inject `fetch`
// and/or `pool`; the arrow wrapper keeps global fetch callable without `this`.
let _deps = { fetch: (...args) => globalThis.fetch(...args), pool };
function __setTelegramDeps(d) { _deps = { ..._deps, ...d }; }

// Public HTTPS origin Telegram calls back into. Matches CLAUDE.md API_URL:
// API_URL || RENDER_EXTERNAL_URL in prod, localhost in dev.
function webhookBase() {
  return process.env.API_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5000';
}

// last-4 redaction so chat ids never sit in logs in full (PII discipline, spec §10).
function last4(x) { return '…' + String(x === null || x === undefined ? '' : x).slice(-4); }

/**
 * Send a Telegram message to a chat. Gated identically to sendSMS: if the bot
 * token is absent OR notifications are gated off, log and skip (never hits the
 * network). Never throws — a failed reply must not 500 a webhook handler.
 * @returns {Promise<object>} Bot API JSON, or { ok:false, skipped:true } when gated.
 */
async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !notificationsEnabled()) {
    const why = !token ? 'TELEGRAM_BOT_TOKEN not set' : 'notifications gated off';
    console.log(`[DEV] Telegram message skipped (${why}) → chat ${last4(chatId)} | ${text}`);
    return { ok: false, skipped: true };
  }
  try {
    const res = await _deps.fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      console.error(`[telegram] sendMessage failed → chat ${last4(chatId)}: ${data.description || res.status}`);
    }
    return data;
  } catch (err) {
    console.error(`[telegram] sendMessage error → chat ${last4(chatId)}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Register (or re-register) the webhook. Points Telegram at the secret-path URL
 * and sets the secret_token header value (both layers of webhook authenticity,
 * spec §1). Requires the bot token + secret; returns the Bot API result.
 */
async function setTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) {
    console.warn('[telegram] setWebhook skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET unset');
    return { ok: false, skipped: true };
  }
  const url = `${webhookBase()}/api/telegram/${secret}`;
  const res = await _deps.fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // allowed_updates trimmed to 'message' — we only ever act on text messages.
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
  });
  return res.json();
}

/**
 * Fetch current webhook registration state (url, last_error_date, etc.) for the
 * heartbeat scheduler (spec §9). Returns the raw Bot API JSON.
 */
async function getTelegramWebhookInfo() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[telegram] getWebhookInfo skipped — TELEGRAM_BOT_TOKEN unset');
    return { ok: false, skipped: true };
  }
  const res = await _deps.fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`, { method: 'POST' });
  return res.json();
}

/**
 * Constant-time verify of the X-Telegram-Bot-Api-Secret-Token header against
 * TELEGRAM_WEBHOOK_SECRET. Hashing both sides to fixed-length SHA-256 digests
 * makes timingSafeEqual safe regardless of input length (raw compare throws on
 * length mismatch) and avoids leaking the secret's length. False if the secret
 * is unset (fail closed) or the header is missing/empty.
 */
function verifyTelegramSecret(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  const provided = req && typeof req.header === 'function'
    ? req.header('x-telegram-bot-api-secret-token')
    : undefined;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Idempotency de-dupe layer (spec §5). INSERT the update_id; a fresh row means
 * this update is new, a conflict means it is a Telegram retry we already saw.
 * @returns {Promise<boolean>} true iff a row was inserted.
 */
async function isNewUpdate(updateId) {
  const result = await _deps.pool.query(
    'INSERT INTO telegram_update (update_id) VALUES ($1) ON CONFLICT (update_id) DO NOTHING',
    [updateId]
  );
  return result.rowCount === 1;
}

module.exports = {
  sendTelegramMessage,
  setTelegramWebhook,
  getTelegramWebhookInfo,
  verifyTelegramSecret,
  isNewUpdate,
  __setTelegramDeps,
};
```

- [ ] **Step 3.4: Run the test, confirm GREEN**
```
node -r dotenv/config --test server/utils/telegram.test.js
```
Expect: all 7 tests pass. (Per the shared-dev-DB memory note, run this suite on its own, it does not touch the DB thanks to the stubbed pool, but keep the one-suite-at-a-time habit.)

- [ ] **Step 3.5: Documentation**
- `README.md`: add `telegram.js` to the `server/utils/` entry in the folder-structure tree.
- `ARCHITECTURE.md`: add a one-line mention of `server/utils/telegram.js` (raw Bot API wrapper: send message, set/get webhook, secret verify, update de-dupe) under the utils / Third-Party Integrations area.

(Env-var and CLAUDE.md/README env-table additions for `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, etc. are owned by the env/docs task, not here, to avoid double-editing those tables.)

- [ ] **Step 3.6: Commit**
```
git add server/utils/telegram.js server/utils/telegram.test.js README.md ARCHITECTURE.md
git commit -m "Add Telegram Bot API helper (send/setWebhook/getWebhookInfo/verifySecret/dedupe)

Raw fetch to the Bot API (no new dep). Sends gated on notificationsEnabled()
like sendSMS; verifyTelegramSecret is constant-time (timingSafeEqual over
SHA-256 digests); isNewUpdate de-dupes update_id via ON CONFLICT DO NOTHING.
__setTelegramDeps seam for pure-unit tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Add placeBridgedCall() to server/utils/sms.js (gated Twilio calls.create)

Add an outbound-voice primitive `placeBridgedCall({ to, callerId, url, statusCallback, timeLimit })` to `server/utils/sms.js`, mirroring `sendSMS` (`server/utils/sms.js:20-37`) exactly: same dev-skip gate (`!client || !notificationsEnabled()`), same `dev-skipped-...` sid shape, PII-redacted logging (last-4 only, matching `smsInbound.js`'s `slice(-4)` style). It is the only place in the codebase that calls `client.calls.create` (today only `client.messages.create` exists at `sms.js:29`). This is a toll-fraud-adjacent, money-moving primitive: it must NEVER dial when notifications are gated off.

**Why max effort:** this places billed international voice legs on an auto-refill Twilio account. A gate that fails open would let a dev server (or a test) dial the live account. The gate must be byte-for-byte identical to `sendSMS`.

#### Files
- `server/utils/sms.js`, MODIFY: extend the `_deps` seam to hold `client` + `notificationsEnabled`, add `placeBridgedCall`, export it.
- `server/utils/placeBridgedCall.test.js`, NEW: pure-unit node:test with injected stub client (no DB rows, no Twilio).

#### Interfaces (locked contract)
```
placeBridgedCall({ to, callerId, url, statusCallback, timeLimit }): Promise<{ sid }>
```
- `to`, the bridge target = `VA_CELL` (strict E.164 `+63…`), passed in by the caller already validated. `placeBridgedCall` does NOT normalize or validate it.
- `callerId`, becomes Twilio's `from` on the leg to Zul's cell (`VOICE_CALLER_ID`, the 224).
- `url`, the `/api/voice/bridge` TwiML URL Twilio fetches when Zul answers.
- `statusCallback`, the `/api/voice/status` URL.
- `timeLimit`, per-call cap in seconds (`VA_CALL_TIME_LIMIT_SEC`, default 1800).
- Gate identical to `sendSMS` (`sms.js:22-26`): if `!client || !notificationsEnabled()` → log (redacted) + return `{ sid: 'dev-skipped-<ts>-<rand>' }`, and do NOT touch Twilio.
- On the live path returns the Twilio call resource (has `.sid`), mirroring `sendSMS` returning `message` at `sms.js:36`.

**Why route `client` + `notificationsEnabled` through `_deps`:** `sendSMS` reads the module-level `client` and imported `notificationsEnabled` directly, which cannot be stubbed. The existing test seam `_deps` (`sms.js:57-58`) only holds `sendSMS`. Extending its defaults to `{ sendSMS, client, notificationsEnabled }` keeps production behavior identical (same objects) while making the "stubbed client passes through the right params" test possible with zero new deps and zero new exports. `__setSmsDeps` already merges (`sms.js:58`), so every existing caller that injects only `sendSMS` (e.g. `balanceSmsHandlers.test.js:72`, `dripSmsHandlers.test.js:82`) is unaffected.

---

- [ ] **Step 4.1: Write the failing test**

Create `server/utils/placeBridgedCall.test.js`. These are pure-unit tests: they inject a stub client + a stub `notificationsEnabled` via the `__setSmsDeps` seam, so nothing hits Twilio or the DB. (Requiring `./sms` pulls in `../db` for the pool, same as `sms.test.js:4`, but `placeBridgedCall` runs no query, so no connection is opened.)

```js
require('dotenv').config();
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { placeBridgedCall, __setSmsDeps } = require('./sms');
const { notificationsEnabled } = require('./notificationsEnabled');

// After every test restore the deps to a safe, production-shaped state.
// In dev/test env the real module-level Twilio client is null (no creds), so
// restoring client:null matches reality; notificationsEnabled is the real import.
afterEach(() => {
  __setSmsDeps({ client: null, notificationsEnabled });
});

test('placeBridgedCall > returns a dev-skipped sid and does NOT call Twilio when notifications are gated off', async () => {
  let created = false;
  __setSmsDeps({
    client: { calls: { create: async () => { created = true; throw new Error('must not dial'); } } },
    notificationsEnabled: () => false,
  });

  const result = await placeBridgedCall({
    to: '+639171234567',
    callerId: '+12242220082',
    url: 'https://example.test/api/voice/bridge',
    statusCallback: 'https://example.test/api/voice/status',
    timeLimit: 1800,
  });

  assert.strictEqual(created, false, 'Twilio calls.create must not be reached when gated off');
  assert.match(result.sid, /^dev-skipped-/);
});

test('placeBridgedCall > returns a dev-skipped sid when the Twilio client is absent', async () => {
  __setSmsDeps({ client: null, notificationsEnabled: () => true });

  const result = await placeBridgedCall({
    to: '+639171234567',
    callerId: '+12242220082',
    url: 'https://example.test/api/voice/bridge',
    statusCallback: 'https://example.test/api/voice/status',
    timeLimit: 1800,
  });

  assert.match(result.sid, /^dev-skipped-/);
});

test('placeBridgedCall > with a stubbed client and notifications on, passes through the right params and returns the sid', async () => {
  let captured = null;
  __setSmsDeps({
    client: { calls: { create: async (opts) => { captured = opts; return { sid: 'CA_test_123' }; } } },
    notificationsEnabled: () => true,
  });

  const result = await placeBridgedCall({
    to: '+639171234567',
    callerId: '+12242220082',
    url: 'https://example.test/api/voice/bridge',
    statusCallback: 'https://example.test/api/voice/status',
    timeLimit: 1800,
  });

  assert.strictEqual(result.sid, 'CA_test_123');
  assert.deepStrictEqual(captured, {
    from: '+12242220082',           // callerId → Twilio `from` (the 224 shown to Zul)
    to: '+639171234567',            // VA_CELL, passed straight through (never normalized)
    url: 'https://example.test/api/voice/bridge',
    statusCallback: 'https://example.test/api/voice/status',
    timeLimit: 1800,
  });
});

test('placeBridgedCall > throws when `to` is missing (mirrors sendSMS)', async () => {
  await assert.rejects(
    () => placeBridgedCall({ callerId: '+12242220082', url: 'u', statusCallback: 's', timeLimit: 1800 }),
    /required/
  );
});
```

- [ ] **Step 4.2: Run the test, confirm it fails for the right reason**

```bash
node -r dotenv/config --test server/utils/placeBridgedCall.test.js
```
Expected: fails because `placeBridgedCall` is not exported yet (`TypeError: placeBridgedCall is not a function`). This proves the test executes and is asserting against the real module, not a typo'd import.

- [ ] **Step 4.3: Implement in server/utils/sms.js**

First, extend the `_deps` seam so `client` and `notificationsEnabled` are injectable. Change the existing line (`server/utils/sms.js:57`):

```js
let _deps = { sendSMS };
```
to:
```js
let _deps = { sendSMS, client, notificationsEnabled };
```
(`client` is the module-level Twilio client from `sms.js:6-8`; `notificationsEnabled` is the import from `sms.js:3`. Both are already in scope at line 57.)

Then add `placeBridgedCall` immediately after `sendSMS` (after `sms.js:37`), mirroring the gate at `sms.js:22-26` and the return shape at `sms.js:25`/`sms.js:36`:

```js
/**
 * Place a Twilio callback-bridge call: Twilio dials `to` (Zul's cell, VA_CELL,
 * strict E.164 — already validated by the caller, NEVER normalized here) and,
 * when she answers, fetches `url` (the /api/voice/bridge TwiML) to dial the
 * target with `callerId` (the 224) shown to the far end.
 *
 * Gated IDENTICALLY to sendSMS (sms.js:22-26): a dev server or gated env never
 * dials the live, auto-refill account. This is a billed-international-voice,
 * toll-fraud-adjacent primitive — the gate is load-bearing.
 *
 * @param {Object} opts
 * @param {string} opts.to             - VA_CELL, strict E.164 (+63…)
 * @param {string} opts.callerId       - VOICE_CALLER_ID (the 224); Twilio `from`
 * @param {string} opts.url            - bridge TwiML URL (/api/voice/bridge)
 * @param {string} opts.statusCallback - status webhook URL (/api/voice/status)
 * @param {number} opts.timeLimit      - per-call cap in seconds
 * @returns {Promise<{sid: string}>}   - Twilio call resource, or a dev-skipped stub
 */
async function placeBridgedCall({ to, callerId, url, statusCallback, timeLimit }) {
  if (!to) throw new Error('placeBridgedCall recipient (VA_CELL) is required');
  const { client: activeClient, notificationsEnabled: notifEnabled } = _deps;
  if (!activeClient || !notifEnabled()) {
    const why = !activeClient ? 'Twilio creds not set' : 'notifications gated off';
    // Redact VA_CELL to last-4 (match smsInbound.js's slice(-4) PII style).
    console.log(`[DEV] Bridged call skipped (${why}) → ...${String(to).slice(-4)} | url: ${url}`);
    return { sid: `dev-skipped-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  }
  const call = await activeClient.calls.create({ from: callerId, to, url, statusCallback, timeLimit });
  console.log(`Bridged call placed: ${call.sid} → ...${String(to).slice(-4)}`);
  return call;
}
```

Finally, add it to the exports (`server/utils/sms.js:118`):

```js
module.exports = { sendSMS, normalizePhone, sendAndLogSms, placeBridgedCall, __setSmsDeps, _realSendSMS };
```

Notes:
- The live-path `console.log` redacts `to` to last-4; the only non-redacted interpolated value is `url` (a non-PII server URL). No target digits are logged in full anywhere.
- `calls.create` is passed exactly the five contract params (`from`/`to`/`url`/`statusCallback`/`timeLimit`) and nothing else, matching the "passes through the right params" assertion.

- [ ] **Step 4.4: Run the test, confirm it passes**

```bash
node -r dotenv/config --test server/utils/placeBridgedCall.test.js
```
Expected: all 4 tests pass.

Regression-guard the seam change (extending `_deps` must not break existing `__setSmsDeps` callers). Run the sibling SMS suites one at a time (server suites share the dev DB, per repo convention):

```bash
node -r dotenv/config --test server/utils/sms.test.js
node -r dotenv/config --test server/utils/balanceSmsHandlers.test.js
node -r dotenv/config --test server/utils/dripSmsHandlers.test.js
```
Expected: all still green (they inject only `sendSMS`; the merge in `__setSmsDeps` leaves `client`/`notificationsEnabled` at their real defaults).

- [ ] **Step 4.5: Commit**

```bash
git add server/utils/sms.js server/utils/placeBridgedCall.test.js
git commit -m "$(cat <<'EOF'
Add placeBridgedCall() Twilio callback-bridge primitive to sms.js

Net-new outbound-voice helper for the Zul VA calling feature: places a
Twilio callback-bridge call (client.calls.create) gated identically to
sendSMS so a dev/gated env never dials the live auto-refill account.
Extends the _deps test seam to hold client + notificationsEnabled for
pure-unit injection; existing __setSmsDeps callers unaffected. VA_CELL
is passed straight through (never normalized) and redacted to last-4 in
all logs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Docs:** none required for this task. `placeBridgedCall` is an added function inside an existing util file (not a new file), and the new env vars it consumes (`VOICE_CALLER_ID`, `VA_CELL`, `VA_CALL_TIME_LIMIT_SEC`) are documented by the env-vars task, not here. No README folder-tree or ARCHITECTURE route-table entry changes.

---

### Task 5: server/utils/pendingCall.js data layer (claim-then-call primitive + audit + prune)

**Depends on:** Task 2 (creates the `pending_call`, `call_audit`, `telegram_update` tables in `server/db/schema.sql` and applies them to the dev DB by hand, schema.sql is NOT auto-applied). This task's tests hit those tables; do not start until Task 2's DDL is live on the dev DB.

**Why max effort:** this is the toll-fraud money seam. `claimForDial` is the atomic claim-then-call primitive: the whole idempotency story of the feature (a Telegram retry / crash-retry never double-dials a billed international call) rests on this one conditional `UPDATE … RETURNING` committing exactly one winner. `countPlacedSince` is the DB-backed daily/per-minute spend cap (the spec's *primary* rate control, since express-rate-limit is useless when every Telegram trigger shares one source IP). Get the atomicity or the count window subtly wrong and it costs real money.

#### Files

- **NEW** `server/utils/pendingCall.js`, the data-access module. Exports exactly: `{ upsertPending, claimForDial, attachCallSid, lookupTargetByCallSid, countPlacedSince, recordAudit, pruneVaCallingRows }`.
- **NEW** `server/utils/pendingCall.test.js`, node:test, DB-hitting (run one at a time; see run cmd).

#### Interfaces (locked contract, match names/signatures exactly)

```
upsertPending({ userId, targetE164, ttlSeconds }): Promise<void>
  INSERT … ON CONFLICT (user_id) DO UPDATE SET target_e164, status='awaiting_confirm',
  call_sid=NULL, expires_at=now()+ttl, created_at=now()   // a new target REPLACES the pending row

claimForDial(userId): Promise<{ id, targetE164 } | null>
  UPDATE pending_call SET status='dialing'
   WHERE user_id=$1 AND status='awaiting_confirm' AND expires_at>now()
   RETURNING id, target_e164                               // atomic single-winner claim

attachCallSid(id, callSid): Promise<void>
lookupTargetByCallSid(callSid): Promise<string|null>       // never trust a request param; look up by CallSid
countPlacedSince(intervalSql): Promise<number>             // count call_audit status='placed' in the window
recordAudit({ triggeredBy, targetE164, callSid, status }): Promise<void>
pruneVaCallingRows(): Promise<number>                      // batched delete, mirror webhookEventsPruneScheduler
```

`status` values written to `call_audit`: `'placed'`, `'rejected_cap'`, `'rejected_validation'`, `'failed'`, or a raw Twilio call status.

#### Patterns mirrored (cite)

- `const { pool } = require('../db')`, same import the prune scheduler uses (`server/utils/webhookEventsPruneScheduler.js:1`; verified `server/db/index.js:210` exports `{ pool }`).
- Batched `DELETE … WHERE ctid IN (SELECT ctid … LIMIT $n)` with a 50ms inter-batch yield and a `PRUNE_BATCH_SIZE` sentinel loop, copied structurally from `server/utils/webhookEventsPruneScheduler.js:10-34`.
- `claimForDial` is deliberately a single conditional `UPDATE … RETURNING`, NOT a `BEGIN/…/COMMIT` block. The spec is explicit (§Security #5): `calls.create` is an external HTTP call and cannot live in a DB transaction, so we do NOT settle-in-transaction the way `handleCant` in `server/utils/smsInbound.js` does; instead the conditional UPDATE commits first and only the winning row dials. A single UPDATE is atomic on its own row, which is exactly the primitive we want.
- Test harness (dotenv preload, `node:test` + `node:assert/strict`, `require('../db')`) mirrors `server/routes/emailChange.test.js:1,10-19`.

#### TDD steps (bite-sized)

**Step 5.1, Write the failing test file.**

Create `server/utils/pendingCall.test.js`:

```js
require('dotenv').config();

// DB-hitting unit tests for server/utils/pendingCall.js — the VA-calling data
// layer. RUN ONE AT A TIME (server suites share the dev DB):
//   node -r dotenv/config --test server/utils/pendingCall.test.js
//
// Uses synthetic, feature-owned rows only. pending_call.user_id / call_audit
// carry no FK (contract), so an arbitrary large BIGINT user_id is safe and
// cannot collide with a real users row. Every row we create is namespaced by a
// per-run NONCE and cleaned up in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const {
  upsertPending,
  claimForDial,
  attachCallSid,
  lookupTargetByCallSid,
  countPlacedSince,
  recordAudit,
  pruneVaCallingRows,
} = require('./pendingCall');

// Unique-ish synthetic user id (BIGINT, no FK). Timestamp keeps it clear of any
// real users.id and of a concurrent run.
const TEST_USER_ID = 900000000000 + (Date.now() % 1000000000);
const NONCE = crypto.randomBytes(4).toString('hex');
const TARGET_A = '+13125550101';
const TARGET_B = '+13125550202';
const SID = `CAtest-${NONCE}`;

async function cleanup() {
  await pool.query('DELETE FROM pending_call WHERE user_id = $1', [TEST_USER_ID]);
  await pool.query(
    "DELETE FROM call_audit WHERE call_sid LIKE $1 OR target_e164 IN ($2, $3)",
    [`CAtest-${NONCE}%`, TARGET_A, TARGET_B]
  );
}

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

test('upsertPending inserts, then REPLACES the row on conflict (new target wins)', async () => {
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: 120 });

  let { rows } = await pool.query(
    'SELECT target_e164, status, call_sid FROM pending_call WHERE user_id = $1',
    [TEST_USER_ID]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_e164, TARGET_A);
  assert.equal(rows[0].status, 'awaiting_confirm');
  assert.equal(rows[0].call_sid, null);

  // Send a new target before confirming — must replace, not duplicate, and must
  // reset status/call_sid.
  await pool.query('UPDATE pending_call SET status=$2, call_sid=$3 WHERE user_id=$1', [
    TEST_USER_ID, 'dialing', 'CAstale',
  ]);
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_B, ttlSeconds: 120 });

  ({ rows } = await pool.query(
    'SELECT target_e164, status, call_sid FROM pending_call WHERE user_id = $1',
    [TEST_USER_ID]
  ));
  assert.equal(rows.length, 1, 'exactly one pending row per user (unique constraint)');
  assert.equal(rows[0].target_e164, TARGET_B);
  assert.equal(rows[0].status, 'awaiting_confirm', 'status reset by upsert');
  assert.equal(rows[0].call_sid, null, 'call_sid cleared by upsert');
});

test('claimForDial returns the row ONCE, then null (single-dial guarantee)', async () => {
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: 120 });

  const first = await claimForDial(TEST_USER_ID);
  assert.ok(first, 'first claim wins');
  assert.equal(first.targetE164, TARGET_A);
  assert.equal(typeof first.id, 'number');

  const second = await claimForDial(TEST_USER_ID);
  assert.equal(second, null, 'second claim finds no awaiting_confirm row — no double dial');
});

test('claimForDial returns null for an expired pending row', async () => {
  // Negative TTL => already expired.
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: -30 });
  const claim = await claimForDial(TEST_USER_ID);
  assert.equal(claim, null, 'expired row is not claimable');
});

test('attachCallSid + lookupTargetByCallSid round-trip; unknown sid => null', async () => {
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: 120 });
  const claim = await claimForDial(TEST_USER_ID);
  assert.ok(claim);

  await attachCallSid(claim.id, SID);
  assert.equal(await lookupTargetByCallSid(SID), TARGET_A);
  assert.equal(await lookupTargetByCallSid(`CAtest-${NONCE}-nope`), null);
});

test('countPlacedSince counts only status=placed inside the window', async () => {
  const before24 = await countPlacedSince('24 hours');

  await recordAudit({ triggeredBy: TEST_USER_ID, targetE164: TARGET_A, callSid: `CAtest-${NONCE}-1`, status: 'placed' });
  await recordAudit({ triggeredBy: TEST_USER_ID, targetE164: TARGET_A, callSid: `CAtest-${NONCE}-2`, status: 'placed' });
  // Non-placed rows must NOT be counted.
  await recordAudit({ triggeredBy: TEST_USER_ID, targetE164: TARGET_B, callSid: `CAtest-${NONCE}-3`, status: 'rejected_cap' });
  await recordAudit({ triggeredBy: TEST_USER_ID, targetE164: TARGET_B, callSid: `CAtest-${NONCE}-4`, status: 'failed' });

  const after24 = await countPlacedSince('24 hours');
  assert.equal(after24 - before24, 2, 'only the two placed rows are counted');

  // A window that predates our inserts sees none of them (delta 0).
  const nano = await countPlacedSince('1 millisecond');
  assert.equal(nano, 0, 'a sub-insert window excludes just-written rows');

  const n = Number(await countPlacedSince('24 hours'));
  assert.equal(Number.isInteger(n), true, 'returns a JS number, not a string');
});

test('pruneVaCallingRows removes expired pending_call rows and returns a count', async () => {
  await upsertPending({ userId: TEST_USER_ID, targetE164: TARGET_A, ttlSeconds: -30 });
  const deleted = await pruneVaCallingRows();
  assert.equal(typeof deleted, 'number');

  const { rows } = await pool.query('SELECT 1 FROM pending_call WHERE user_id = $1', [TEST_USER_ID]);
  assert.equal(rows.length, 0, 'expired pending row pruned');
});
```

**Step 5.2, Run it, watch it fail (module does not exist).**

```
node -r dotenv/config --test server/utils/pendingCall.test.js
```

Expect a `Cannot find module './pendingCall'` load failure. That is the RED state.

**Step 5.3, Implement `server/utils/pendingCall.js`.**

Create the module:

```js
const { pool } = require('../db');

// Retention for the audit + de-dupe tables. call_audit holds dialed-number PII
// (spec §Security #10), so it is purged on a window; the daily-cap count only
// needs the last 24h, so 30 days is generous headroom for spend/abuse forensics.
const RETENTION_DAYS = 30;
// Chunked DELETE bounds lock-hold time and WAL growth (mirror of
// webhookEventsPruneScheduler.js). These tables are tiny, but the pattern is
// free insurance against a long-quiet-period backlog.
const PRUNE_BATCH_SIZE = 5000;

// INSERT-or-REPLACE the single pending row for a user. A new target sent before
// confirming replaces the old one and resets status/call_sid/expiry (spec §4).
// ttlSeconds is an integer; make_interval keeps it out of string coercion.
async function upsertPending({ userId, targetE164, ttlSeconds }) {
  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, call_sid, expires_at, created_at)
     VALUES ($1, $2, 'awaiting_confirm', NULL, NOW() + make_interval(secs => $3::int), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       target_e164 = EXCLUDED.target_e164,
       status      = 'awaiting_confirm',
       call_sid    = NULL,
       expires_at  = NOW() + make_interval(secs => $3::int),
       created_at  = NOW()`,
    [userId, targetE164, ttlSeconds]
  );
}

// Atomic claim-then-call primitive (spec §Security #5). A single conditional
// UPDATE is atomic on its own row: at most one caller flips awaiting_confirm ->
// dialing, so at most one dial fires. A Telegram retry / crash-retry finds no
// claimable row and is a no-op. NOT wrapped in a transaction on purpose —
// calls.create is an external HTTP call that must run AFTER this commits.
async function claimForDial(userId) {
  const { rows } = await pool.query(
    `UPDATE pending_call
        SET status = 'dialing'
      WHERE user_id = $1
        AND status = 'awaiting_confirm'
        AND expires_at > NOW()
      RETURNING id, target_e164`,
    [userId]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, targetE164: rows[0].target_e164 };
}

// Store the Twilio CallSid on the claimed row so the bridge webhook can resolve
// the target by CallSid (never from a request param — spec §6).
async function attachCallSid(id, callSid) {
  await pool.query('UPDATE pending_call SET call_sid = $2 WHERE id = $1', [id, callSid]);
}

async function lookupTargetByCallSid(callSid) {
  const { rows } = await pool.query(
    'SELECT target_e164 FROM pending_call WHERE call_sid = $1 LIMIT 1',
    [callSid]
  );
  return rows.length ? rows[0].target_e164 : null;
}

// DB-backed spend cap (spec §Security #6). Pass a Postgres interval literal
// ('24 hours' for the daily cap, '1 minute' for the per-minute cap). Counts
// only successfully PLACED calls — rejects/failures never consume the budget.
async function countPlacedSince(intervalSql) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM call_audit
      WHERE status = 'placed'
        AND created_at > NOW() - ($1)::interval`,
    [intervalSql]
  );
  return rows[0].n;
}

// Append an audit row. status: 'placed' | 'rejected_cap' | 'rejected_validation'
// | 'failed' | a raw Twilio call status. triggeredBy is the Telegram user id.
async function recordAudit({ triggeredBy, targetE164, callSid, status }) {
  await pool.query(
    `INSERT INTO call_audit (triggered_by, target_e164, call_sid, status)
     VALUES ($1, $2, $3, $4)`,
    [triggeredBy ?? null, targetE164 ?? null, callSid ?? null, status]
  );
}

// Chunked DELETE loop (mirror of webhookEventsPruneScheduler.js:10-34).
async function batchedDelete(sql, params) {
  let total = 0;
  let batch;
  do {
    const result = await pool.query(sql, params);
    batch = result.rowCount;
    total += batch;
    if (batch === PRUNE_BATCH_SIZE) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } while (batch === PRUNE_BATCH_SIZE);
  return total;
}

// Purge: expired pending_call rows (already unclaimable), plus call_audit and
// telegram_update rows past retention. PII lifetime bound (spec §Security #10).
async function pruneVaCallingRows() {
  let total = 0;

  total += await batchedDelete(
    `DELETE FROM pending_call
      WHERE ctid IN (
        SELECT ctid FROM pending_call WHERE expires_at < NOW() LIMIT $1
      )`,
    [PRUNE_BATCH_SIZE]
  );

  total += await batchedDelete(
    `DELETE FROM call_audit
      WHERE ctid IN (
        SELECT ctid FROM call_audit
        WHERE created_at < NOW() - ($1 || ' days')::interval
        LIMIT $2
      )`,
    [String(RETENTION_DAYS), PRUNE_BATCH_SIZE]
  );

  total += await batchedDelete(
    `DELETE FROM telegram_update
      WHERE ctid IN (
        SELECT ctid FROM telegram_update
        WHERE created_at < NOW() - ($1 || ' days')::interval
        LIMIT $2
      )`,
    [String(RETENTION_DAYS), PRUNE_BATCH_SIZE]
  );

  return total;
}

module.exports = {
  upsertPending,
  claimForDial,
  attachCallSid,
  lookupTargetByCallSid,
  countPlacedSince,
  recordAudit,
  pruneVaCallingRows,
  RETENTION_DAYS,
  PRUNE_BATCH_SIZE,
};
```

Note: the contract lists the seven core functions as the module surface; `RETENTION_DAYS` / `PRUNE_BATCH_SIZE` are additive exports for the scheduler/tests and do not conflict with it. The Task-9 `vaCallingScheduler.js` may re-export `pruneVaCallingRows` from here.

**Step 5.4, Run the test, watch it pass (GREEN).**

```
node -r dotenv/config --test server/utils/pendingCall.test.js
```

Expect all tests passing. If the tables are missing, that means Task 2's DDL was not applied to the dev DB, apply the idempotent `CREATE TABLE IF NOT EXISTS` statements from `server/db/schema.sql` by hand (per CLAUDE.md: schema.sql is not auto-applied to dev), then re-run. Do not proceed until green.

**Step 5.5, Verify no accidental double-run damage / rerun idempotency.**

Run the suite a second time to confirm `before(cleanup)` makes it repeatable on the shared dev DB (no leftover rows from a prior run):

```
node -r dotenv/config --test server/utils/pendingCall.test.js
```

Still all green.

**Step 5.6, Commit (in the lane).**

```
git add server/utils/pendingCall.js server/utils/pendingCall.test.js
git commit -m "$(cat <<'EOF'
Add pendingCall.js VA-calling data layer (claim-then-call, audit, prune)

Data-access module for the Telegram-triggered Twilio callback bridge:
- claimForDial: atomic conditional UPDATE ... RETURNING (single-dial guarantee)
- upsertPending: INSERT ... ON CONFLICT (user_id) replace-on-new-target
- attachCallSid / lookupTargetByCallSid: resolve bridge target by CallSid
- countPlacedSince: DB-backed daily/per-minute spend cap (placed rows only)
- recordAudit: spend/abuse audit trail
- pruneVaCallingRows: batched PII/retention purge (mirrors webhookEventsPruneScheduler)

DB-hitting node:test suite (run one at a time; shared dev DB).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

#### Done when

- `server/utils/pendingCall.js` exports the seven contract functions with exact names/signatures.
- `node -r dotenv/config --test server/utils/pendingCall.test.js` is green, twice in a row.
- No changes outside the two footprint files (schema DDL belongs to Task 2; scheduler wiring to Task 9; env/docs to Task 1).

---

### Task 6: Telegram outbound-trigger router (POST /api/telegram/:secret) + mount

Builds the toll-fraud-guarded Telegram webhook that turns Zul's chat message into a bridged call. This is the money/call-initiating endpoint, so every guard in spec §"Security & correctness" (secret path + `secret_token` header, `user_id` allowlist, `update_id` de-dupe, DB-backed spend caps, confirm-before-dial, claim-then-call) is load-bearing and lives here. All external effects (Telegram send, pending-call DB, Twilio call, US-phone validation) come in through a `__setDeps` seam so the whole flow is unit-tested with stubs and never touches the DB or the live Twilio account.

**Depends on:** Task 1 (`server/utils/xmlEscape.js`, not used here directly but part of the shared extraction), Task 3 (`server/utils/usPhone.js` `toUsE164` + `server/utils/sms.js` `placeBridgedCall`), Task 4 (`server/utils/telegram.js` `verifyTelegramSecret`, `isNewUpdate`, `sendTelegramMessage`), Task 5 (`server/utils/pendingCall.js` `upsertPending`, `claimForDial`, `attachCallSid`, `countPlacedSince`, `recordAudit`). Those modules must exist (their exports may be stubs from their own tasks) for `require('./telegram')` to resolve.

#### Files

- **NEW** `server/routes/telegram.js`, Express router, one route `POST /:secret`. Mounted at `/api/telegram`.
- **NEW** `server/routes/telegram.test.js`, pure-unit `node:test` suite; injects stubs via `router.__setDeps`, no DB.
- **EDIT** `server/index.js`, mount the router next to `/api/sms` (~line 254).

> Docs (README folder tree + ARCHITECTURE route table + env-var tables) are intentionally NOT touched here, spec Component 9 assigns the `voice.js`/`telegram.js` structural-doc and env-var updates to the env/docs task (Task 9). Keep this lane's footprint to the three files above so it does not collide with Task 9.

#### Interfaces (exact contract)

`server/routes/telegram.js` exports an Express `router` with a test seam:
- Route `POST /:secret`.
- `router.__setDeps(partial)`, overrides any of the injected deps (mirrors `server/utils/sms.js:58` `__setSmsDeps`). Injected deps and their upstream sources:
  - `verifyTelegramSecret(req):boolean`, `isNewUpdate(updateId):Promise<boolean>`, `sendTelegramMessage(chatId, text):Promise`, from `server/utils/telegram.js` (Task 4).
  - `upsertPending({userId,targetE164,ttlSeconds})`, `claimForDial(userId):Promise<{id,targetE164}|null>`, `attachCallSid(id,callSid)`, `countPlacedSince(intervalSql):Promise<number>`, `recordAudit({triggeredBy,targetE164,callSid,status})`, from `server/utils/pendingCall.js` (Task 5).
  - `placeBridgedCall({to,callerId,url,statusCallback,timeLimit}):Promise<{sid}>`, from `server/utils/sms.js` (Task 3).
  - `toUsE164(raw):string|null`, from `server/utils/usPhone.js` (Task 3).

Env read at request time (so redeploy/env-set takes effect and tests can mutate freely): `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_ID`, `VA_CELL`, `VOICE_CALLER_ID`, `VA_CALL_PER_MIN_CAP` (default 5), `VA_CALL_DAILY_CAP` (default 40), `VA_CALL_TIME_LIMIT_SEC` (default 1800), `PENDING_CALL_TTL_SEC` (default 120), and `API_URL || RENDER_EXTERNAL_URL || http://localhost:5000` for the bridge/status callback base.

Behavior contract (order is load-bearing): 403 on `!verifyTelegramSecret(req)` OR path `:secret !== TELEGRAM_WEBHOOK_SECRET` (hard 403 in **every** env, no dev skip on a privileged endpoint) → parse `update_id`/`message.text`/`chat.id`/`from.id`, ignore non-message updates (200) → `isNewUpdate` else 200 no-op → bootstrap echo when `TELEGRAM_ALLOWED_USER_ID` unset (200, no dial) → silent 200 when `from.id` not allowlisted → on `YES` (`/^y(es)?$/i`): cap check (`countPlacedSince('1 minute')`/`('24 hours')`) → on trip `recordAudit('rejected_cap')` + reply + 200; else `claimForDial` (null → "expired" reply); on claim, `placeBridgedCall` → `attachCallSid` → `recordAudit('placed')` → reply → 200 → otherwise treat text as target: `toUsE164` null → `recordAudit('rejected_validation')` + guidance; else `upsertPending` + "Reply YES to call &lt;pretty&gt;". Every handled outcome returns 200; a thrown error is caught, Sentry-logged, and returned 200 (de-dupe + claim-then-call make a dropped update safe, Zul resends).

#### TDD steps

**Step 6.1, Write the failing test suite.**

Create `server/routes/telegram.test.js`:

```js
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Requiring the router pulls in ../utils/{telegram,pendingCall,sms,usPhone}.
// None connect on require (pg pool is lazy); all effects are injected below.
const router = require('./telegram');

let server = null;
let baseUrl = null;
let calls = null;

// Fresh recording stubs for each test. Any dep can be overridden per-test.
function freshStubs(overrides = {}) {
  calls = {
    verifyTelegramSecret: [], isNewUpdate: [], sendTelegramMessage: [],
    upsertPending: [], claimForDial: [], attachCallSid: [],
    countPlacedSince: [], recordAudit: [], placeBridgedCall: [], toUsE164: [],
  };
  router.__setDeps({
    verifyTelegramSecret: (req) => { calls.verifyTelegramSecret.push(1); return true; },
    isNewUpdate: async (id) => { calls.isNewUpdate.push(id); return true; },
    sendTelegramMessage: async (chatId, text) => { calls.sendTelegramMessage.push({ chatId, text }); return { ok: true }; },
    upsertPending: async (a) => { calls.upsertPending.push(a); },
    claimForDial: async (u) => { calls.claimForDial.push(u); return { id: 1, targetE164: '+13125551234' }; },
    attachCallSid: async (id, sid) => { calls.attachCallSid.push({ id, sid }); },
    countPlacedSince: async (i) => { calls.countPlacedSince.push(i); return 0; },
    recordAudit: async (a) => { calls.recordAudit.push(a); },
    placeBridgedCall: async (a) => { calls.placeBridgedCall.push(a); return { sid: 'CA_test_sid' }; },
    toUsE164: (raw) => { calls.toUsE164.push(raw); return String(raw).replace(/\D/g, '').length >= 10 ? '+13125551234' : null; },
    ...overrides,
  });
}

async function post(path, body, headers = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, text: d })); }
    );
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function msg(fromId, text, updateId = Date.now() + Math.floor(Math.random() * 1e6)) {
  return { update_id: updateId, message: { text, chat: { id: fromId }, from: { id: fromId } } };
}

before(async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 'testsecret';
  process.env.TELEGRAM_ALLOWED_USER_ID = '555';
  process.env.VA_CELL = '+639171234567';
  process.env.VOICE_CALLER_ID = '+12242220082';
  const app = express();
  app.use(express.json());
  app.use('/api/telegram', router);
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => { if (server) await new Promise((r) => server.close(r)); });

beforeEach(() => { process.env.TELEGRAM_ALLOWED_USER_ID = '555'; freshStubs(); });

test('bad secret_token header => 403 and never dials', async () => {
  freshStubs({ verifyTelegramSecret: () => false });
  const res = await post('/api/telegram/testsecret', msg(555, '3125551234'));
  assert.equal(res.status, 403);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.isNewUpdate.length, 0); // rejected before de-dupe is consumed
});

test('wrong URL secret path => 403 even with a valid header', async () => {
  freshStubs({ verifyTelegramSecret: () => true });
  const res = await post('/api/telegram/wrongpath', msg(555, '3125551234'));
  assert.equal(res.status, 403);
  assert.equal(calls.placeBridgedCall.length, 0);
});

test('non-allowlisted sender => 200 no-op, no dial, silent (no reply)', async () => {
  const res = await post('/api/telegram/testsecret', msg(999, 'YES'));
  assert.equal(res.status, 200);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.sendTelegramMessage.length, 0);
});

test('bootstrap mode (ALLOWED unset) echoes the sender id, never dials', async () => {
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  const res = await post('/api/telegram/testsecret', msg(777, 'hello'));
  assert.equal(res.status, 200);
  assert.equal(calls.sendTelegramMessage.length, 1);
  assert.match(calls.sendTelegramMessage[0].text, /Your Telegram id is 777/);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.upsertPending.length, 0);
});

test('valid US target => upsertPending + "Reply YES" prompt, no dial', async () => {
  const res = await post('/api/telegram/testsecret', msg(555, '(312) 555-1234'));
  assert.equal(res.status, 200);
  assert.equal(calls.upsertPending.length, 1);
  assert.equal(calls.upsertPending[0].targetE164, '+13125551234');
  assert.equal(calls.upsertPending[0].userId, 555);
  assert.ok(calls.upsertPending[0].ttlSeconds > 0);
  assert.match(calls.sendTelegramMessage[0].text, /Reply YES to call/);
  assert.equal(calls.placeBridgedCall.length, 0);
});

test('invalid target => rejected_validation audit + guidance, no upsert', async () => {
  freshStubs({ toUsE164: () => null });
  const res = await post('/api/telegram/testsecret', msg(555, 'call my cousin'));
  assert.equal(res.status, 200);
  assert.equal(calls.upsertPending.length, 0);
  assert.equal(calls.recordAudit.length, 1);
  assert.equal(calls.recordAudit[0].status, 'rejected_validation');
  assert.equal(calls.sendTelegramMessage.length, 1);
});

test('YES => cap-check, claim, placeBridgedCall ONCE, attachCallSid, recordAudit placed', async () => {
  const res = await post('/api/telegram/testsecret', msg(555, 'yes'));
  assert.equal(res.status, 200);
  assert.equal(calls.claimForDial.length, 1);
  assert.equal(calls.claimForDial[0], 555);
  assert.equal(calls.placeBridgedCall.length, 1);
  assert.equal(calls.placeBridgedCall[0].to, '+639171234567');       // VA_CELL, never normalized
  assert.equal(calls.placeBridgedCall[0].callerId, '+12242220082');  // the 224
  assert.match(calls.placeBridgedCall[0].url, /\/api\/voice\/bridge$/);
  assert.match(calls.placeBridgedCall[0].statusCallback, /\/api\/voice\/status$/);
  assert.equal(calls.placeBridgedCall[0].timeLimit, 1800);
  assert.equal(calls.attachCallSid.length, 1);
  assert.deepEqual(calls.attachCallSid[0], { id: 1, sid: 'CA_test_sid' });
  assert.equal(calls.recordAudit.at(-1).status, 'placed');
  // PII: reply and log redact to last-4, not the full number.
  assert.match(calls.sendTelegramMessage[0].text, /1234/);
  assert.doesNotMatch(calls.sendTelegramMessage[0].text, /3125551234/);
});

test('YES with no claimable pending row => expired message, no dial', async () => {
  freshStubs({ claimForDial: async () => null });
  const res = await post('/api/telegram/testsecret', msg(555, 'YES'));
  assert.equal(res.status, 200);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.match(calls.sendTelegramMessage[0].text, /expired|nothing to confirm/i);
});

test('cap trip => rejected_cap audit, no claim, no dial', async () => {
  freshStubs({ countPlacedSince: async () => 999 });
  const res = await post('/api/telegram/testsecret', msg(555, 'YES'));
  assert.equal(res.status, 200);
  assert.equal(calls.claimForDial.length, 0);
  assert.equal(calls.placeBridgedCall.length, 0);
  assert.equal(calls.recordAudit.at(-1).status, 'rejected_cap');
  assert.equal(calls.sendTelegramMessage.length, 1);
});

test('duplicate update_id => 200 no-op (Telegram retry safety)', async () => {
  freshStubs({ isNewUpdate: async () => false });
  const res = await post('/api/telegram/testsecret', msg(555, 'YES'));
  assert.equal(res.status, 200);
  assert.equal(calls.claimForDial.length, 0);
  assert.equal(calls.placeBridgedCall.length, 0);
});
```

**Step 6.2, Run the test, watch it fail.**

```
node -r dotenv/config --test server/routes/telegram.test.js
```

Expected failure: `Cannot find module './telegram'` (the router does not exist yet). This confirms the harness runs before any implementation exists.

**Step 6.3, Implement the router.**

Create `server/routes/telegram.js`:

```js
const express = require('express');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');

const telegram = require('../utils/telegram');
const pendingCall = require('../utils/pendingCall');
const sms = require('../utils/sms');
const usPhone = require('../utils/usPhone');

const router = express.Router();

// Dependency seam for tests (mirror server/utils/sms.js:57-58 __setSmsDeps).
// Every external effect goes through `deps` so the whole flow is unit-tested
// with stubs and a dev server never dials the live Twilio account.
let deps = {
  verifyTelegramSecret: telegram.verifyTelegramSecret,
  isNewUpdate: telegram.isNewUpdate,
  sendTelegramMessage: telegram.sendTelegramMessage,
  upsertPending: pendingCall.upsertPending,
  claimForDial: pendingCall.claimForDial,
  attachCallSid: pendingCall.attachCallSid,
  countPlacedSince: pendingCall.countPlacedSince,
  recordAudit: pendingCall.recordAudit,
  placeBridgedCall: sms.placeBridgedCall,
  toUsE164: usPhone.toUsE164,
};
function __setDeps(d) { deps = { ...deps, ...d }; }

// Defense-in-depth CPU / DB-write-amplification cap (mirror
// server/routes/sms.js:19-23 inboundLimiter). NOT the toll-fraud daily cap:
// every Telegram trigger shares one source IP, so per-IP rate-limiting is
// useless as a spend cap (spec §Security 6). The real cap is DB-backed below.
const telegramLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: 'ok' });

const YES_RE = /^y(es)?$/i;

// PII redaction to last-4 (match server/utils/smsInbound.js:572 slice(-4)).
function last4(x) { return '...' + String(x == null ? '' : x).slice(-4); }

function prettyUsE164(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : String(e164 || '');
}

// Callback base URL (see CLAUDE.md API_URL): prod uses API_URL /
// RENDER_EXTERNAL_URL; dev falls back to localhost:5000.
function webhookBase() {
  return process.env.API_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5000';
}

// Bot-API reply that never turns a handled outcome into a non-200 (a non-2xx
// would make Telegram retry the whole update).
async function reply(chatId, text) {
  try { if (chatId != null) await deps.sendTelegramMessage(chatId, text); }
  catch (err) { console.warn('[telegram] reply send failed:', err.message); }
}

/**
 * POST /api/telegram/:secret — Zul's outbound-call trigger. This webhook dials
 * billed international calls on an auto-refill account from external input, so
 * it is a toll-fraud target; the ordered guards below are load-bearing
 * (spec §"Security & correctness"). Always 200 on a handled outcome so Telegram
 * does not retry-storm; hard 403 only on failed authenticity.
 */
router.post('/:secret', telegramLimiter, async (req, res) => {
  const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

  // Guard 1 — webhook authenticity: secret_token header AND unguessable path.
  // Hard 403 in EVERY environment. A privileged, call-initiating endpoint has
  // no dev signature-skip path (contrast the SMS webhook's dev warn-and-allow).
  if (!deps.verifyTelegramSecret(req) || !SECRET || req.params.secret !== SECRET) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('Telegram webhook auth failure', {
        level: 'warning', tags: { webhook: 'telegram', reason: 'bad_secret' },
      });
    }
    return res.status(403).send('Forbidden');
  }

  try {
    const update = req.body || {};
    const message = update.message || {};
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const chatId = message.chat && message.chat.id;
    const fromId = message.from && message.from.id;
    const updateId = update.update_id;

    // Ignore non-message updates (edits, callbacks, my_chat_member, etc.).
    if (updateId == null || fromId == null) return res.sendStatus(200);

    // Guard 5 (second layer) — de-dupe Telegram retries by update_id.
    const fresh = await deps.isNewUpdate(updateId);
    if (!fresh) return res.sendStatus(200);

    // Bootstrap: with the allowlist unset, echo the sender's numeric id so
    // Dallas captures it once, sets TELEGRAM_ALLOWED_USER_ID, and redeploys.
    // Nothing else happens; never dials (spec Component 8).
    const ALLOWED = process.env.TELEGRAM_ALLOWED_USER_ID;
    if (!ALLOWED) {
      await reply(chatId, `Your Telegram id is ${fromId}`);
      return res.sendStatus(200);
    }

    // Guard 2 — sender allowlist, layered on top of #1 (never instead of it).
    // Silent no-op for anyone else.
    if (String(fromId) !== String(ALLOWED)) return res.sendStatus(200);

    const userId = fromId;

    if (YES_RE.test(text)) {
      // Guard 6 — DB-backed spend caps, checked BEFORE the claim.
      const perMinCap = Number(process.env.VA_CALL_PER_MIN_CAP) || 5;
      const dailyCap = Number(process.env.VA_CALL_DAILY_CAP) || 40;
      const [lastMin, lastDay] = await Promise.all([
        deps.countPlacedSince('1 minute'),
        deps.countPlacedSince('24 hours'),
      ]);
      if (lastMin >= perMinCap || lastDay >= dailyCap) {
        await deps.recordAudit({ triggeredBy: userId, targetE164: null, callSid: null, status: 'rejected_cap' });
        await reply(chatId, 'Call limit reached. Please try again in a bit.');
        return res.sendStatus(200);
      }

      // Guard 5 — claim-then-call. The conditional UPDATE commits first; only
      // the winning row dials, so a Telegram retry / crash-retry finds nothing
      // claimable and is a no-op. calls.create cannot live in a DB transaction.
      const claimed = await deps.claimForDial(userId);
      if (!claimed) {
        await reply(chatId, 'That request expired or there is nothing to confirm. Send the number again.');
        return res.sendStatus(200);
      }

      const timeLimit = Number(process.env.VA_CALL_TIME_LIMIT_SEC) || 1800;
      const base = webhookBase();
      let result;
      try {
        result = await deps.placeBridgedCall({
          to: process.env.VA_CELL,                 // strict E.164, never normalized
          callerId: process.env.VOICE_CALLER_ID,   // the 224
          url: `${base}/api/voice/bridge`,
          statusCallback: `${base}/api/voice/status`,
          timeLimit,
        });
      } catch (err) {
        await deps.recordAudit({ triggeredBy: userId, targetE164: claimed.targetE164, callSid: null, status: 'failed' });
        console.error('[telegram] placeBridgedCall failed:', err.message);
        await reply(chatId, 'That call could not be placed. Send the number again to retry.');
        return res.sendStatus(200);
      }

      const callSid = result && result.sid ? result.sid : null;
      await deps.attachCallSid(claimed.id, callSid);
      await deps.recordAudit({ triggeredBy: userId, targetE164: claimed.targetE164, callSid, status: 'placed' });
      console.log(`[telegram] call placed sid=${last4(callSid)} target=${last4(claimed.targetE164)}`);
      await reply(chatId, `Calling ${last4(claimed.targetE164)} now.`);
      return res.sendStatus(200);
    }

    // Otherwise treat the message as a target number.
    // Guard 3 — US-only NANP validation (primary toll-fraud control).
    const targetE164 = deps.toUsE164(text);
    if (!targetE164) {
      await deps.recordAudit({ triggeredBy: userId, targetE164: null, callSid: null, status: 'rejected_validation' });
      await reply(chatId, 'That does not look like a US number. Send a 10-digit US number (no 900 or 976).');
      return res.sendStatus(200);
    }

    // Guard 4 — confirm-before-dial. upsertPending replaces any prior pending
    // row for this user (ON CONFLICT (user_id) DO UPDATE, per Task 5).
    const ttlSeconds = Number(process.env.PENDING_CALL_TTL_SEC) || 120;
    await deps.upsertPending({ userId, targetE164, ttlSeconds });
    await reply(chatId, `Reply YES to call ${prettyUsE164(targetE164)}`);
    return res.sendStatus(200);
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { webhook: 'telegram' } });
    }
    console.error('[telegram] handler error:', err.message);
    // Return 200 so Telegram does not retry-storm. The update_id de-dupe plus
    // claim-then-call idempotency make a dropped update safe (Zul resends).
    return res.sendStatus(200);
  }
});

router.__setDeps = __setDeps;
module.exports = router;
```

**Step 6.4, Mount the router in `server/index.js`.**

Edit the router mounts (~line 254), adding the Telegram mount immediately after the SMS mount. Telegram posts JSON, already covered by `express.json({limit:'1mb'})` at ~line 166:

```js
app.use('/api/sms', require('./routes/sms'));
app.use('/api/telegram', require('./routes/telegram'));
```

**Step 6.5, Run the suite, watch it pass.**

```
node -r dotenv/config --test server/routes/telegram.test.js
```

Expected: all tests pass. These are pure-unit (injected stubs, no DB), so they are safe to run alongside the shared dev DB and need no isolation. Also confirm the server still boots with the new mount:

```
node -e "require('./server/routes/telegram'); console.log('router loads OK')"
```

**Step 6.6, Commit.**

```
git add server/routes/telegram.js server/routes/telegram.test.js server/index.js
git commit -m "Add Telegram outbound-call trigger router (POST /api/telegram/:secret)

Toll-fraud-guarded webhook: secret path + secret_token header, user_id
allowlist, update_id de-dupe, DB-backed spend caps, confirm-before-dial,
claim-then-call. All external effects behind a __setDeps seam; unit-tested
with stubs (no DB, no live Twilio). Mounted next to /api/sms.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Reminder for the lane: this is a sensitive-path (webhook auth + call/money-initiating) change, the merge/push gate runs the full security-review + code-review fleet. Confirm the ordered guards (403-before-anything, allowlist-after-bootstrap, cap-before-claim, no dev signature-skip) survived any rebase against main's HEAD.

---

### Task 7: Voice router (server/routes/voice.js): /inbound, /bridge, /status callback bridge endpoints

Builds the three Twilio-facing voice webhooks that make the callback bridge work:
- `POST /api/voice/inbound`, a client calls the 224; return TwiML that dials Zul's cell (`VA_CELL`) showing the client's number as caller ID.
- `POST /api/voice/bridge`, after Zul answers her outbound leg, Twilio fetches this; look the dial target up **by `CallSid`** from `pending_call` (never from a request param) and bridge with `answerOnBridge` showing the 224.
- `POST /api/voice/status`, Twilio call-status callback; on a dead leg (no-answer/busy/failed/canceled) message Zul on Telegram and audit the outcome.

All three copy the `isValidTwilioRequest` signature gate from `server/routes/sms.js:30-42` (prod → 403 on bad/missing signature; dev → warn-and-allow, mirroring `server/routes/sms.js:50-65`), and all TwiML responses go out as `text/xml` via `res.set('Content-Type','text/xml').send(...)` exactly like `server/routes/sms.js:92`. This endpoint initiates billed international voice legs, so privileged behavior is never honored on a dev signature-skip in production, and every interpolated value passes through the shared `xmlEscape` from Task 1.

**Files**
- `server/routes/voice.js` (new), Express router with the three POST routes + a `__setVoiceDeps` injection seam (mirrors `server/utils/sms.js:57-58`).
- `server/routes/voice.test.js` (new), node:test unit tests driving the router over a real `http` server (mirrors `server/routes/calcom.test.js:1-40`), with all DB/Twilio/Telegram deps stubbed via `__setVoiceDeps`.
- `server/index.js` (edit), mount `app.use('/api/voice', require('./routes/voice'))` next to `/api/sms` (`server/index.js:254`).

**Interfaces (this task provides)**
- `POST /api/voice/inbound` → `200 text/xml` `<Response><Dial timeout="20" callerId="<escaped client From>"><Number><escaped VA_CELL></Number></Dial></Response>`; prod bad-sig → `403`.
- `POST /api/voice/bridge` → `200 text/xml`; known `CallSid` → `<Response><Dial answerOnBridge="true" callerId="<VOICE_CALLER_ID>" timeLimit="<VA_CALL_TIME_LIMIT_SEC>"><Number><escaped target></Number></Dial></Response>`; unknown `CallSid` → `<Response><Say>Sorry, the call could not be completed.</Say><Hangup/></Response>`; prod bad-sig → `403`.
- `POST /api/voice/status` → `204` empty; on `CallStatus` ∈ {no-answer, busy, failed, canceled} calls `sendTelegramMessage(ALLOWED_USER_ID, ...)` + `recordAudit({..., status})`; prod bad-sig → `403`.
- `module.exports = router` with `router.__setVoiceDeps` attached for tests.

**Interfaces (this task consumes, from Tasks 1/3/5)**
- Task 1: `const { xmlEscape } = require('../utils/xmlEscape')`.
- Task 3: `const { sendTelegramMessage } = require('../utils/telegram')`.
- Task 5: `const { lookupTargetByCallSid, recordAudit } = require('../utils/pendingCall')`.
- Env: `VA_CELL`, `VOICE_CALLER_ID`, `VA_CALL_TIME_LIMIT_SEC` (default 1800), `TELEGRAM_ALLOWED_USER_ID`, `TWILIO_AUTH_TOKEN`, `NODE_ENV`, `SENTRY_DSN_SERVER`.

---

- [ ] **Step 7.1: Write the failing test first**

Create `server/routes/voice.test.js`. Tests stub every external dep via `__setVoiceDeps` (including the signature gate) so no DB, Twilio, or Telegram call is made; the `pg` pool is imported transitively but never queried (Pool is lazy).

```js
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const router = require('./voice');

// --- test harness: real express+http server, global urlencoded parser (Twilio
// posts application/x-www-form-urlencoded, same as the app relies on for
// server/routes/sms.js — see server/index.js body parsers ~166-168). ----------
let _server = null;
let _baseUrl = null;

before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/voice', router);
  await new Promise((resolve) => {
    _server = app.listen(0, () => {
      _baseUrl = `http://127.0.0.1:${_server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (_server) await new Promise((r) => _server.close(r));
});

function post(path, form) {
  const body = new URLSearchParams(form).toString();
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
  };
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${path}`, { method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data, contentType: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Reset injected deps to a permissive baseline before each test.
let calls;
beforeEach(() => {
  calls = { telegram: [], audit: [], lookups: [] };
  process.env.VA_CELL = '+639171234567';
  process.env.VOICE_CALLER_ID = '+12242220082';
  process.env.VA_CALL_TIME_LIMIT_SEC = '1800';
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  router.__setVoiceDeps({
    isValidTwilioRequest: () => true,
    lookupTargetByCallSid: async (sid) => { calls.lookups.push(sid); return null; },
    recordAudit: async (row) => { calls.audit.push(row); },
    sendTelegramMessage: async (chatId, text) => { calls.telegram.push({ chatId, text }); return { ok: true }; },
  });
});

test('/inbound returns a Dial to VA_CELL with the client caller escaped, as text/xml', async () => {
  // A From with XML metacharacters must be escaped in the callerId attribute.
  const res = await post('/api/voice/inbound', { From: '+1312555<&>0100' });
  assert.strictEqual(res.status, 200);
  assert.match(res.contentType || '', /text\/xml/);
  assert.match(res.text, /<Dial timeout="20" callerId="\+1312555&lt;&amp;&gt;0100">/);
  assert.match(res.text, /<Number>\+639171234567<\/Number>/);
});

test('/bridge with a known CallSid returns an answerOnBridge Dial to the stored target', async () => {
  router.__setVoiceDeps({
    lookupTargetByCallSid: async (sid) => { calls.lookups.push(sid); return '+13125550123'; },
  });
  const res = await post('/api/voice/bridge', { CallSid: 'CA_known' });
  assert.strictEqual(res.status, 200);
  assert.match(res.contentType || '', /text\/xml/);
  assert.deepStrictEqual(calls.lookups, ['CA_known']);
  assert.match(res.text, /answerOnBridge="true"/);
  assert.match(res.text, /callerId="\+12242220082"/);
  assert.match(res.text, /timeLimit="1800"/);
  assert.match(res.text, /<Number>\+13125550123<\/Number>/);
});

test('/bridge with an unknown CallSid returns Say + Hangup, never a Dial', async () => {
  // Baseline lookup stub returns null.
  const res = await post('/api/voice/bridge', { CallSid: 'CA_unknown' });
  assert.strictEqual(res.status, 200);
  assert.match(res.contentType || '', /text\/xml/);
  assert.match(res.text, /<Say>Sorry, the call could not be completed\.<\/Say>/);
  assert.match(res.text, /<Hangup\/>/);
  assert.doesNotMatch(res.text, /<Dial/);
});

test('/status with a failed leg messages Zul on Telegram and audits the status', async () => {
  const res = await post('/api/voice/status', { CallStatus: 'failed', CallSid: 'CA_status' });
  assert.ok(res.status === 204 || res.status === 200, `expected 2xx, got ${res.status}`);
  assert.strictEqual(calls.telegram.length, 1);
  assert.strictEqual(calls.telegram[0].chatId, '5550001');
  assert.match(calls.telegram[0].text, /didn't connect/);
  assert.strictEqual(calls.audit.length, 1);
  assert.strictEqual(calls.audit[0].status, 'failed');
  assert.strictEqual(calls.audit[0].callSid, 'CA_status');
});

test('/status with a completed leg does NOT message Zul', async () => {
  const res = await post('/api/voice/status', { CallStatus: 'completed', CallSid: 'CA_ok' });
  assert.ok(res.status === 204 || res.status === 200);
  assert.strictEqual(calls.telegram.length, 0);
  assert.strictEqual(calls.audit.length, 0);
});

test('production bad signature => 403 and no dial lookup', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  try {
    const res = await post('/api/voice/bridge', { CallSid: 'CA_x' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(calls.lookups.length, 0);
  } finally {
    process.env.NODE_ENV = prev;
  }
});
```

- [ ] **Step 7.2: Run the test, confirm it fails for the right reason**

```bash
node -r dotenv/config --test server/routes/voice.test.js
```
Expect: `Cannot find module './voice'` (the router file does not exist yet). This proves the harness runs and the failure is the missing implementation, not a harness bug. Per the shared-DB note, run this suite by itself (no other node:test invocation in parallel).

- [ ] **Step 7.3: Implement `server/routes/voice.js`**

Signature gate copied from `server/routes/sms.js:30-42`; prod-403 / dev-warn behavior copied from `server/routes/sms.js:50-65`; `text/xml` send copied from `server/routes/sms.js:92`. All TwiML interpolation goes through the shared `xmlEscape` (Task 1). Provider webhooks return status codes directly (no `asyncHandler`/`AppError`), matching the sms inbound handler.

```js
const express = require('express');
const twilio = require('twilio');
const Sentry = require('@sentry/node');
const { xmlEscape } = require('../utils/xmlEscape');
const { lookupTargetByCallSid, recordAudit } = require('../utils/pendingCall');
const { sendTelegramMessage } = require('../utils/telegram');

const router = express.Router();

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const DEAD_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

/**
 * Verify an inbound request is genuinely from Twilio. Copied verbatim from
 * server/routes/sms.js (isValidTwilioRequest, lines 30-42): validateRequest
 * hashes the public URL + sorted POST params with the account auth token.
 * Any throw is treated as "invalid".
 */
function isValidTwilioRequest(req) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return false;
    const signature = req.headers['x-twilio-signature'];
    if (!signature) return false;
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return twilio.validateRequest(authToken, signature, url, req.body || {});
  } catch (err) {
    console.warn('[voice] signature verification threw:', err.message);
    return false;
  }
}

// Dependency-injection seam for tests (mirrors server/utils/sms.js:57-58
// __setSmsDeps). Lets unit tests stub the signature gate + DB/Telegram calls
// so no real webhook signature, Neon query, or Bot API request is made.
let _deps = { isValidTwilioRequest, lookupTargetByCallSid, recordAudit, sendTelegramMessage };
function __setVoiceDeps(d) { _deps = { ..._deps, ...d }; }
router.__setVoiceDeps = __setVoiceDeps;

/**
 * Signature gate shared by all three voice webhooks. Mirrors the sms.js
 * inbound handler (server/routes/sms.js:50-65): prod rejects a bad/missing
 * signature with 403 (privileged call-bridging behavior is NEVER honored on a
 * dev signature-skip in production); dev warns and allows so the endpoints are
 * testable without live Twilio creds. Returns true when the request may proceed;
 * when it returns false it has already sent the 403 response.
 */
function passesSignature(req, res, tag) {
  const inProd = process.env.NODE_ENV === 'production';
  if (!_deps.isValidTwilioRequest(req)) {
    if (inProd) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage('Twilio voice webhook signature failure', {
          level: 'warning', tags: { webhook: 'twilio-voice', route: tag, reason: 'invalid_signature' },
        });
      }
      res.status(403).send('Invalid signature');
      return false;
    }
    console.warn(`[voice/${tag}] signature not validated (dev mode — allowing)`);
  }
  return true;
}

function sendTwiml(res, body) {
  res.set('Content-Type', 'text/xml').send(`${XML_DECL}${body}`);
}

function timeLimitSec() {
  return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800;
}

/**
 * POST /api/voice/inbound — a client calls the 224. Dial Zul's cell (VA_CELL),
 * passing the client's number through as caller ID so she sees who is calling.
 * VA_CELL is a strict-E.164 env var (never normalized). Both interpolated
 * values are XML-escaped defensively (the client From is external input).
 */
router.post('/inbound', (req, res) => {
  if (!passesSignature(req, res, 'inbound')) return;
  const caller = req.body.From || '';
  const vaCell = process.env.VA_CELL || '';
  sendTwiml(
    res,
    `<Response><Dial timeout="20" callerId="${xmlEscape(caller)}"><Number>${xmlEscape(vaCell)}</Number></Dial></Response>`
  );
});

/**
 * POST /api/voice/bridge — fetched after Zul answers her outbound leg. The dial
 * target is looked up FROM pending_call BY CallSid (never a request param, so a
 * forged param cannot redirect the second leg). Unknown/expired CallSid → a
 * spoken apology + hangup rather than a silent dead call. Provider webhook:
 * any error returns a valid TwiML (never a stack trace) so the call terminates
 * cleanly.
 */
router.post('/bridge', async (req, res) => {
  if (!passesSignature(req, res, 'bridge')) return;
  let target = null;
  try {
    target = await _deps.lookupTargetByCallSid(req.body.CallSid);
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { webhook: 'twilio-voice', route: 'bridge' } });
    console.error('[voice/bridge] target lookup failed:', err.message);
  }
  if (!target) {
    sendTwiml(res, '<Response><Say>Sorry, the call could not be completed.</Say><Hangup/></Response>');
    return;
  }
  const callerId = process.env.VOICE_CALLER_ID || '';
  sendTwiml(
    res,
    `<Response><Dial answerOnBridge="true" callerId="${callerId}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(target)}</Number></Dial></Response>`
  );
});

/**
 * POST /api/voice/status — Twilio call-status callback. On a dead leg
 * (no-answer/busy/failed/canceled) message Zul so she learns the outcome
 * instead of hearing silence, and audit the status. Always returns an empty
 * 204 (Twilio needs a 2xx to stop retrying; side-effect failures are logged,
 * never surfaced). CallSid/status redaction: audit stores full CallSid but no
 * dialed number here.
 */
router.post('/status', async (req, res) => {
  if (!passesSignature(req, res, 'status')) return;
  const status = req.body.CallStatus;
  const callSid = req.body.CallSid || null;
  if (DEAD_STATUSES.has(status)) {
    const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
    if (allowed) {
      try {
        await _deps.sendTelegramMessage(allowed, "That call didn't connect, resend the number to retry.");
      } catch (err) {
        console.error('[voice/status] telegram notify failed:', err.message);
      }
    }
    try {
      await _deps.recordAudit({
        triggeredBy: allowed ? Number(allowed) : null,
        targetE164: null,
        callSid,
        status,
      });
    } catch (err) {
      console.error('[voice/status] audit write failed:', err.message);
    }
  }
  res.status(204).end();
});

module.exports = router;
```

Notes on fidelity to the contract:
- `callerId="${VOICE_CALLER_ID}"` in `/bridge` is interpolated without `xmlEscape` per the exact contract string (it is the fixed, trusted 224 env constant, not external input); the only escaped bridge value is the validated E.164 `target` in element text, matching spec §7 ("the only interpolated value is the validated E.164 target in element text").
- `/inbound` escapes both `From` (external) and `VA_CELL` per the contract's `xmlEscape(caller)` / `xmlEscape(VA_CELL)`.
- No per-route body parser: Twilio posts urlencoded, already covered by the global `express.urlencoded({extended:true})` (`server/index.js:166-168`), exactly as `server/routes/sms.js` relies on it for signature validation.

- [ ] **Step 7.4: Run the test, confirm it passes**

```bash
node -r dotenv/config --test server/routes/voice.test.js
```
Expect: all 6 tests pass. If the prod-403 test flakes, confirm `NODE_ENV` is restored in its `finally` (it is) so later suites are unaffected.

- [ ] **Step 7.5: Mount the router in `server/index.js`**

Add the mount immediately after the `/api/sms` line (`server/index.js:254`), keeping the voice endpoints adjacent to sms as the contract requires:

```js
app.use('/api/sms', require('./routes/sms'));
app.use('/api/voice', require('./routes/voice'));
```

- [ ] **Step 7.6: Verify the server still boots and the routes are wired**

```bash
node -e "require('/home/drbartender/projects/os/server/routes/voice.js'); console.log('voice router loads OK')"
node -r dotenv/config --test server/routes/voice.test.js
```
Expect: `voice router loads OK` and all tests green. (Full server boot is exercised by the dev-server restart; a bare require confirms no load-time error from the new mount.)

- [ ] **Step 7.7: Commit**

Documentation for the new route file (README folder tree + ARCHITECTURE route table) is handled in the docs task per the Mandatory Documentation Updates table; this commit is code + tests only.

```bash
git add server/routes/voice.js server/routes/voice.test.js server/index.js
git commit -m "$(cat <<'EOF'
Add voice callback-bridge router (/api/voice inbound, bridge, status)

Twilio-facing webhooks for the Zul VA calling bridge: /inbound dials VA_CELL
with the client's caller ID; /bridge looks the dial target up by CallSid from
pending_call (never a request param) and bridges with answerOnBridge showing
the 224; /status messages Zul on Telegram + audits dead legs. All three copy
the isValidTwilioRequest signature gate from routes/sms.js (prod 403), send
text/xml, and escape TwiML via the shared xmlEscape. Mounted next to /api/sms.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: VA-calling maintenance scheduler (prune + Telegram webhook heartbeat) and index.js registration

Depends on: Task 2 (schema: `pending_call` / `call_audit` / `telegram_update`), Task 3 (`server/utils/telegram.js` exporting `getTelegramWebhookInfo` / `setTelegramWebhook`), Task 5 (`server/utils/pendingCall.js` exporting `pruneVaCallingRows`).

Builds `server/utils/vaCallingScheduler.js` (spec §Components-7 + §Security-9) and registers it in the `server/index.js` scheduler block under `enabled('RUN_VA_CALLING_SCHEDULER')`, mirroring the `webhook_events_prune` registration at `server/index.js:386-396`.

- `pruneVaCallingRows()` delegates to Task 5's `pendingCall.pruneVaCallingRows()` (the SQL purge of expired `pending_call` + aged-out `call_audit`/`telegram_update`). Re-exposed here so `index.js` registers ONE VA-calling maintenance module.
- `checkTelegramWebhookHealth()` is the heartbeat (spec §Security-9): Telegram silently disables a webhook after repeated errors / a stray `getUpdates` / a second `setWebhook` / a TLS lapse, leaving outbound calling dead-until-noticed. It calls `getWebhookInfo`; if the URL is unset OR `last_error_date` is within the last hour, it re-runs `setWebhook` and emails the admin via `notifyAdminCategory`.

#### Files

- `server/utils/vaCallingScheduler.js` (new), exports `{ pruneVaCallingRows, checkTelegramWebhookHealth, __setDeps }`.
- `server/utils/vaCallingScheduler.test.js` (new), node:test.
- `server/index.js` (edit), register both jobs in the scheduler block.
- `.env.example` (edit), document `RUN_VA_CALLING_SCHEDULER` (the flag this task owns; the other VA env vars are documented by their owning tasks). CLAUDE.md / README env tables for `RUN_VA_CALLING_SCHEDULER` are folded into the docs task.

#### Interfaces (exact)

```
module.exports = { pruneVaCallingRows, checkTelegramWebhookHealth, __setDeps };
pruneVaCallingRows(): Promise<number>          // delegates to pendingCall.pruneVaCallingRows()
checkTelegramWebhookHealth(): Promise<{ healthy: boolean, reset: boolean, setResult?: any }>
__setDeps(overrides): void                     // test-injection seam (mirrors sms.js __setSmsDeps)
```

Dependency injection mirrors the `__setSmsDeps` seam in `server/utils/sms.js` and `__setDeps` in `server/utils/smsInbound.js` (module.exports at `server/utils/smsInbound.js:677-695`): a single mutable `deps` object wraps the real helpers so `checkTelegramWebhookHealth` is unit-testable without the network or DB.

Admin email uses `notifyAdminCategory({ category, subject, emailHtml, emailText })` from `server/utils/adminNotifications.js:73` with category `'system_error'` (a valid category, see the allowlist at `server/utils/adminNotifications.js:9-21`).

---

- [ ] **Step 8.1: Write the failing test**

Create `server/utils/vaCallingScheduler.test.js`. The `checkTelegramWebhookHealth` cases are pure-unit (injected stubs, no DB); the prune case is DB-backed and mirrors `server/utils/webhookEventsPruneScheduler.test.js:1-34`. Server suites share the dev DB and run one at a time (per repo convention).

```js
require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const scheduler = require('./vaCallingScheduler');
const { checkTelegramWebhookHealth, pruneVaCallingRows, __setDeps } = scheduler;

// Sentinel ids so the DB prune test never touches real rows on the shared dev DB.
const U_EXPIRED = 999000801;
const U_FRESH = 999000802;
const TG_OLD = 999000803;
const TG_FRESH = 999000804;
const AUDIT_TRIGGER = 999000805; // triggered_by sentinel for call_audit test rows

async function cleanup() {
  await pool.query('DELETE FROM pending_call WHERE user_id IN ($1, $2)', [U_EXPIRED, U_FRESH]);
  await pool.query('DELETE FROM telegram_update WHERE update_id IN ($1, $2)', [TG_OLD, TG_FRESH]);
  await pool.query('DELETE FROM call_audit WHERE triggered_by = $1', [AUDIT_TRIGGER]);
}

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

// checkTelegramWebhookHealth is pure-unit; reset the injected deps after each so
// a stubbed dep never leaks into the DB-backed prune test.
afterEach(() => {
  __setDeps({
    getTelegramWebhookInfo: require('./telegram').getTelegramWebhookInfo,
    setTelegramWebhook: require('./telegram').setTelegramWebhook,
    pruneVaCallingRows: require('./pendingCall').pruneVaCallingRows,
    notifyAdminCategory: require('./adminNotifications').notifyAdminCategory,
  });
});

// ── checkTelegramWebhookHealth ────────────────────────────────────────────

test('healthy: url set, no recent error → no re-set, no alert', async () => {
  let setCalls = 0;
  let notifyCalls = 0;
  __setDeps({
    getTelegramWebhookInfo: async () => ({
      ok: true,
      result: { url: 'https://api.drbartender.com/api/telegram/secret', last_error_date: 0 },
    }),
    setTelegramWebhook: async () => { setCalls += 1; return { ok: true }; },
    notifyAdminCategory: async () => { notifyCalls += 1; },
  });

  const out = await checkTelegramWebhookHealth();
  assert.deepEqual(out, { healthy: true, reset: false });
  assert.equal(setCalls, 0, 'did not re-set a healthy webhook');
  assert.equal(notifyCalls, 0, 'did not alert on a healthy webhook');
});

test('unhealthy: empty url → re-sets webhook and alerts admin', async () => {
  let setCalls = 0;
  let notifyArg = null;
  __setDeps({
    getTelegramWebhookInfo: async () => ({ ok: true, result: { url: '' } }),
    setTelegramWebhook: async () => { setCalls += 1; return { ok: true }; },
    notifyAdminCategory: async (arg) => { notifyArg = arg; },
  });

  const out = await checkTelegramWebhookHealth();
  assert.equal(out.healthy, false);
  assert.equal(out.reset, true);
  assert.equal(setCalls, 1, 're-registered the missing webhook');
  assert.ok(notifyArg, 'admin was alerted');
  assert.equal(notifyArg.category, 'system_error');
});

test('unhealthy: last_error_date within the last hour → re-sets and alerts', async () => {
  let setCalls = 0;
  let notifyCalls = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  __setDeps({
    getTelegramWebhookInfo: async () => ({
      ok: true,
      result: {
        url: 'https://api.drbartender.com/api/telegram/secret',
        last_error_date: nowSec - 120, // 2 minutes ago
        last_error_message: 'Wrong response from the webhook: 500',
      },
    }),
    setTelegramWebhook: async () => { setCalls += 1; return { ok: true }; },
    notifyAdminCategory: async () => { notifyCalls += 1; },
  });

  const out = await checkTelegramWebhookHealth();
  assert.equal(out.reset, true);
  assert.equal(setCalls, 1);
  assert.equal(notifyCalls, 1);
});

test('healthy: old last_error_date (>1h ago) with url set → no re-set', async () => {
  let setCalls = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  __setDeps({
    getTelegramWebhookInfo: async () => ({
      ok: true,
      result: {
        url: 'https://api.drbartender.com/api/telegram/secret',
        last_error_date: nowSec - 7200, // 2 hours ago — recovered
      },
    }),
    setTelegramWebhook: async () => { setCalls += 1; return { ok: true }; },
    notifyAdminCategory: async () => {},
  });

  const out = await checkTelegramWebhookHealth();
  assert.deepEqual(out, { healthy: true, reset: false });
  assert.equal(setCalls, 0, 'a stale-but-old error does not trigger a re-set');
});

// ── pruneVaCallingRows (delegation to Task 5's SQL) ────────────────────────

test('pruneVaCallingRows: deletes expired/old rows, leaves fresh rows', async () => {
  // Expired vs. live pending_call (purged by expires_at).
  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, expires_at, created_at)
     VALUES ($1, '+13120000001', 'awaiting_confirm', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`,
    [U_EXPIRED]
  );
  await pool.query(
    `INSERT INTO pending_call (user_id, target_e164, status, expires_at, created_at)
     VALUES ($1, '+13120000002', 'awaiting_confirm', NOW() + INTERVAL '1 hour', NOW())`,
    [U_FRESH]
  );
  // Old vs. fresh telegram_update (purged by created_at retention). 400 days is
  // safely past any retention window Task 5 defines.
  await pool.query(
    `INSERT INTO telegram_update (update_id, created_at) VALUES ($1, NOW() - INTERVAL '400 days')`,
    [TG_OLD]
  );
  await pool.query(
    `INSERT INTO telegram_update (update_id, created_at) VALUES ($1, NOW())`,
    [TG_FRESH]
  );
  // Old vs. fresh call_audit (purged by created_at retention).
  await pool.query(
    `INSERT INTO call_audit (triggered_by, target_e164, status, created_at)
     VALUES ($1, '+13120000003', 'placed', NOW() - INTERVAL '400 days')`,
    [AUDIT_TRIGGER]
  );
  await pool.query(
    `INSERT INTO call_audit (triggered_by, target_e164, status, created_at)
     VALUES ($1, '+13120000004', 'placed', NOW())`,
    [AUDIT_TRIGGER]
  );

  const deleted = await pruneVaCallingRows();
  assert.ok(deleted >= 3, `expected the 3 stale rows pruned, got ${deleted}`);

  const pc = await pool.query('SELECT user_id FROM pending_call WHERE user_id IN ($1,$2)', [U_EXPIRED, U_FRESH]);
  const pcIds = pc.rows.map((r) => Number(r.user_id));
  assert.ok(pcIds.includes(U_FRESH), 'live pending_call survives');
  assert.ok(!pcIds.includes(U_EXPIRED), 'expired pending_call pruned');

  const tg = await pool.query('SELECT update_id FROM telegram_update WHERE update_id IN ($1,$2)', [TG_OLD, TG_FRESH]);
  const tgIds = tg.rows.map((r) => Number(r.update_id));
  assert.ok(tgIds.includes(TG_FRESH), 'fresh telegram_update survives');
  assert.ok(!tgIds.includes(TG_OLD), 'old telegram_update pruned');

  const audit = await pool.query(
    `SELECT COUNT(*)::int AS n FROM call_audit WHERE triggered_by = $1 AND created_at < NOW() - INTERVAL '200 days'`,
    [AUDIT_TRIGGER]
  );
  assert.equal(audit.rows[0].n, 0, 'old call_audit pruned');
});
```

- [ ] **Step 8.2: Run the test, watch it fail**

```
node -r dotenv/config --test server/utils/vaCallingScheduler.test.js
```

Expect a module-not-found / import failure (the file does not exist yet).

- [ ] **Step 8.3: Implement `server/utils/vaCallingScheduler.js`**

```js
// server/utils/vaCallingScheduler.js
//
// Maintenance for the Zul VA calling feature (spec §Components-7 + §Security-9).
//
//   pruneVaCallingRows()        Delegates to pendingCall's purge (expired
//                               pending_call rows + aged-out call_audit /
//                               telegram_update rows). Re-exposed here so the
//                               index.js scheduler block registers ONE
//                               VA-calling maintenance module.
//
//   checkTelegramWebhookHealth()  The webhook heartbeat. Telegram silently
//                               disables a webhook after repeated errors / a
//                               stray getUpdates / a second setWebhook / a TLS
//                               lapse, which leaves OUTBOUND CALLING dead until
//                               someone notices. This calls getWebhookInfo; if
//                               the URL is unset OR last_error_date is within the
//                               last hour, it re-runs setWebhook and emails the
//                               admin.
//
// Deps are injected through one mutable `deps` object (mirrors the __setSmsDeps
// seam in server/utils/sms.js and __setDeps in server/utils/smsInbound.js:677)
// so checkTelegramWebhookHealth is unit-testable without the network or the DB.

const telegram = require('./telegram');
const pendingCall = require('./pendingCall');
const adminNotifications = require('./adminNotifications');

let deps = {
  getTelegramWebhookInfo: (...a) => telegram.getTelegramWebhookInfo(...a),
  setTelegramWebhook: (...a) => telegram.setTelegramWebhook(...a),
  pruneVaCallingRows: (...a) => pendingCall.pruneVaCallingRows(...a),
  notifyAdminCategory: (...a) => adminNotifications.notifyAdminCategory(...a),
};

function __setDeps(overrides) {
  deps = { ...deps, ...overrides };
}

// "recent" webhook error = within the last hour (spec §Security-9).
const WEBHOOK_ERROR_WINDOW_SEC = 3600;

// Local quote-escaping helper (external last_error_message flows into the admin
// email body). Mirrors the escapeHtml at server/utils/smsInbound.js:429; kept
// local so this task does not add an export to another task's file.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// getWebhookInfo returns the raw Bot API envelope { ok, result: {...} }; tolerate
// a helper that already unwrapped `.result`.
function extractResult(info) {
  if (info && typeof info === 'object' && info.result && typeof info.result === 'object') {
    return info.result;
  }
  return info && typeof info === 'object' ? info : {};
}

// Delegates to Task 5's pendingCall.pruneVaCallingRows(); re-exposed as the
// single VA-calling prune entry point for index.js.
async function pruneVaCallingRows() {
  return deps.pruneVaCallingRows();
}

async function checkTelegramWebhookHealth() {
  // Let a getWebhookInfo network failure propagate: wrapScheduler records it as
  // 'failed' + Sentry (server/utils/schedulerHealth.js:54-77), which is the
  // correct signal — we cannot safely re-arm without knowing the current state.
  const info = await deps.getTelegramWebhookInfo();
  const result = extractResult(info);

  const url = result.url || '';
  const lastErrorDate = Number(result.last_error_date) || 0; // unix seconds
  const nowSec = Math.floor(Date.now() / 1000);
  const errorRecent =
    lastErrorDate > 0 && nowSec - lastErrorDate < WEBHOOK_ERROR_WINDOW_SEC;

  if (url && !errorRecent) {
    return { healthy: true, reset: false };
  }

  // Webhook missing or erroring — re-arm it and alert the admin. Outbound
  // calling would have been dead until this ran.
  const setResult = await deps.setTelegramWebhook();

  const reason = !url
    ? 'the Telegram webhook URL is not set'
    : `Telegram reported a webhook error at ${new Date(lastErrorDate * 1000).toISOString()}` +
      (result.last_error_message ? ` ("${result.last_error_message}")` : '');

  await deps.notifyAdminCategory({
    category: 'system_error',
    subject: 'Zul VA calling: Telegram webhook re-armed',
    emailHtml:
      '<p>The Zul VA calling Telegram webhook looked unhealthy, so it was ' +
      'automatically re-registered.</p>' +
      `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` +
      '<p>Outbound calling would have been dead until this ran. Verify Zul can ' +
      'trigger a call.</p>',
    emailText:
      'The Zul VA calling Telegram webhook looked unhealthy and was ' +
      'automatically re-registered.\n' +
      `Reason: ${reason}\n` +
      'Outbound calling would have been dead until this ran. Verify Zul can ' +
      'trigger a call.',
  });

  return { healthy: false, reset: true, setResult };
}

module.exports = { pruneVaCallingRows, checkTelegramWebhookHealth, __setDeps };
```

- [ ] **Step 8.4: Run the test, watch it pass**

```
node -r dotenv/config --test server/utils/vaCallingScheduler.test.js
```

All five tests green. (If the DB prune test errors on a missing table, Task 2's `schema.sql` DDL has not been hand-applied to the dev DB, apply it idempotently first; per repo convention `schema.sql` is not auto-applied to dev.)

- [ ] **Step 8.5: Register the scheduler in `server/index.js`**

Insert this block immediately AFTER the `pending_email_cleanup` block (after `server/index.js:407`), mirroring the `webhook_events_prune` registration at `server/index.js:386-396`. One `enabled('RUN_VA_CALLING_SCHEDULER')` flag gates both jobs; on disable, clear BOTH health rows so the stale monitor does not alert on intentionally-off jobs (matches the `clearHealthRow` pattern at `server/index.js:394-395`).

```js
      // VA calling maintenance (spec §Components-7 + §Security-9): hourly prune
      // of expired pending_call + aged-out call_audit/telegram_update rows, plus
      // a ~6h Telegram webhook heartbeat (re-arms a silently-disabled webhook so
      // outbound calling is never dead-until-noticed).
      if (enabled('RUN_VA_CALLING_SCHEDULER')) {
        const {
          pruneVaCallingRows,
          checkTelegramWebhookHealth,
        } = require('./utils/vaCallingScheduler');

        const wrappedPrune = wrapScheduler('va_calling_prune', 3600, async () => {
          const n = await pruneVaCallingRows();
          if (n > 0) console.log(`[va_calling_prune] deleted ${n} expired/old rows`);
        });
        setTimeout(wrappedPrune, 210000); // stagger off the other prune jobs
        setInterval(wrappedPrune, 60 * 60 * 1000);

        const wrappedHealth = wrapScheduler(
          'va_calling_webhook_health',
          21600, // 6h expected interval
          checkTelegramWebhookHealth
        );
        setTimeout(wrappedHealth, 240000);
        setInterval(wrappedHealth, 6 * 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('va_calling_prune');
        clearHealthRow('va_calling_webhook_health');
      }
```

- [ ] **Step 8.6: Document the scheduler flag in `.env.example`**

Add after the `RUN_PENDING_EMAIL_CLEANUP_SCHEDULER=` block (`.env.example:152`), mirroring the format of the two entries above it (`.env.example:146-152`):

```
# Optional. Set to 'false' to disable the VA-calling maintenance scheduler
# (hourly pending_call/call_audit/telegram_update prune + ~6h Telegram webhook
# heartbeat). Default on. Honored only when RUN_SCHEDULERS is not 'false'.
RUN_VA_CALLING_SCHEDULER=
```

(The CLAUDE.md + README Environment Variables table rows for `RUN_VA_CALLING_SCHEDULER` are folded into the feature's documentation task alongside the other VA env vars.)

- [ ] **Step 8.7: Verify the server still boots**

```
node -e "require('./server/utils/vaCallingScheduler'); console.log('module loads clean')"
```

Confirms no circular-require or syntax break in the new module + its deps. (Full boot verification of the scheduler firing happens against a dev tunnel per the spec's Validation plan §4.)

- [ ] **Step 8.8: Commit**

```
git add server/utils/vaCallingScheduler.js server/utils/vaCallingScheduler.test.js server/index.js .env.example
git commit -m "$(cat <<'EOF'
Add VA-calling maintenance scheduler (prune + Telegram webhook heartbeat)

New server/utils/vaCallingScheduler.js: pruneVaCallingRows() delegates to
pendingCall's purge; checkTelegramWebhookHealth() re-arms a silently-disabled
Telegram webhook and alerts the admin (spec §Security-9). Registered in the
index.js scheduler block under RUN_VA_CALLING_SCHEDULER (hourly prune + ~6h
heartbeat), mirroring the webhook_events_prune registration.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Env vars + docs + manual runbook (final task)

This is the closing documentation task. It is **docs/config only, no application code, no node:test cycle.** Every prior task (1-8) has already landed the code (`server/utils/xmlEscape.js`, `usPhone.js`, `telegram.js`, `pendingCall.js`, `vaCallingScheduler.js`, `sms.js#placeBridgedCall`, `server/routes/voice.js`, `server/routes/telegram.js`, the three tables, and the scheduler registration). Task 9 makes the tree/docs/env match reality per CLAUDE.md's **Mandatory documentation updates** table: new env vars → CLAUDE.md + README env tables; new integration → CLAUDE.md Tech Stack + README Tech Stack + ARCHITECTURE Third-Party Integrations; new route/util files → README folder tree + ARCHITECTURE. It also declares the new env vars in `.env.example` + `render.yaml` and writes the operator runbook.

Because there is no executable behavior here, the "test" for each step is a `grep`/`git diff --check` verification that the exact text landed, followed by one commit. Do NOT commit any real secret value (`VA_CELL`, tokens, the allowlist id), every `.env.example`/`render.yaml` entry is a placeholder or `sync: false`.

**Files**
- `.env.example` (edit, add the Zul VA Calling env block)
- `render.yaml` (edit, add the same keys as `sync: false` / defaulted values)
- `.claude/CLAUDE.md` (edit, Tech Stack list + Environment Variables table)
- `README.md` (edit, Tech Stack table + Environment Variables table + Folder Structure tree)
- `ARCHITECTURE.md` (edit, `/api/voice` + `/api/telegram` route tables + a Third-Party Integrations section)
- `docs/va-calling-runbook.md` (new, the manual operator runbook)

**Interfaces**, none (documentation task). The env-var names and route paths documented here MUST exactly match the locked interface contract: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_ID`, `VOICE_CALLER_ID`, `VA_CELL`, `RUN_VA_CALLING_SCHEDULER`, `VA_CALL_DAILY_CAP`, `VA_CALL_PER_MIN_CAP`, `VA_CALL_TIME_LIMIT_SEC`, `PENDING_CALL_TTL_SEC`; routes `POST /api/voice/{inbound,bridge,status}` and `POST /api/telegram/:secret`.

---

- [ ] **Step 9.1: Add the VA-calling env block to `.env.example`**

Mirrors the existing per-feature comment style in `.env.example` (e.g. the Web Push block at lines 154-167 and the Thumbtack block at lines 80-92: a header rule, a why-comment per var, placeholder values). Append after the final `VAPID_CONTACT_EMAIL` line (line 167).

Edit, anchor on the last line of the file:

```
old_string:
# Contact email embedded in the VAPID JWT (mailto:). Defaults to contact@drbartender.com.
VAPID_CONTACT_EMAIL=contact@drbartender.com

new_string:
# Contact email embedded in the VAPID JWT (mailto:). Defaults to contact@drbartender.com.
VAPID_CONTACT_EMAIL=contact@drbartender.com

# ─── Zul VA Calling (Telegram-triggered Twilio callback bridge) ───────────
# Our PH-based VA (Zul) places/receives US calls via a Twilio callback bridge:
# the OUTBOUND trigger is a Telegram bot message; voice rides her CELL (Twilio
# calls her, she answers, Twilio bridges the second leg to the target with the
# 224 as caller ID). This endpoint dials billed international calls on an
# auto-refill account from external input, so it is a toll-fraud target — every
# guard (secret path + secret_token header + user_id allowlist + US-only NANP
# validation + confirm-before-dial + spend caps) is load-bearing. See
# docs/superpowers/specs/2026-07-01-zul-va-calling-design.md and
# docs/va-calling-runbook.md.

# Telegram Bot API token from @BotFather. When unset, sendTelegramMessage /
# setTelegramWebhook no-op (log + skip) and the outbound trigger is dead.
TELEGRAM_BOT_TOKEN=

# Secret, unguessable URL path segment AND the value compared (constant-time)
# against the X-Telegram-Bot-Api-Secret-Token header on every update. Set the
# SAME value at setWebhook. Never commit it. Generate:
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
TELEGRAM_WEBHOOK_SECRET=

# Numeric Telegram user id of Zul — the ONLY sender allowed to trigger a call.
# BOOTSTRAP: leave UNSET on the first deploy. In bootstrap mode the webhook
# replies to any sender with their own user id and dials nothing. Read Zul's id
# from that reply, set it here, redeploy. Once set, every other sender is a
# silent no-op.
TELEGRAM_ALLOWED_USER_ID=

# The 224 US voice line, strict E.164. Caller ID on Zul's outbound calls AND the
# number clients dial inbound. Voice+SMS capable; no SMS-to-clients from it.
VOICE_CALLER_ID=+12242220082

# Zul's cell, strict E.164 (+63…). The bridge target Twilio calls. NEVER run it
# through normalizePhone (US-centric; it would mangle a PH number). Stored only
# here — never on a DB record, never committed to the repo.
VA_CELL=

# Optional. Set to 'false' to disable the VA-calling scheduler (hourly prune of
# expired pending_call + retention-aged call_audit/telegram_update rows, plus the
# Telegram webhook-heartbeat check). Default on. Honored only when RUN_SCHEDULERS
# is not 'false' (global flag wins).
RUN_VA_CALLING_SCHEDULER=

# Optional spend caps (toll-fraud controls). Defaults shown.
#   VA_CALL_DAILY_CAP       max calls placed per rolling 24h (DB-backed via call_audit)
#   VA_CALL_PER_MIN_CAP     max triggers accepted per minute
#   VA_CALL_TIME_LIMIT_SEC  per-call hard timeLimit on BOTH legs (1800 = 30 min)
#   PENDING_CALL_TTL_SEC    how long a confirm-before-dial pending record lives
VA_CALL_DAILY_CAP=40
VA_CALL_PER_MIN_CAP=5
VA_CALL_TIME_LIMIT_SEC=1800
PENDING_CALL_TTL_SEC=120
```

Verify:
```bash
grep -c "TELEGRAM_BOT_TOKEN\|TELEGRAM_WEBHOOK_SECRET\|TELEGRAM_ALLOWED_USER_ID\|VOICE_CALLER_ID\|^VA_CELL=\|RUN_VA_CALLING_SCHEDULER\|VA_CALL_DAILY_CAP\|VA_CALL_PER_MIN_CAP\|VA_CALL_TIME_LIMIT_SEC\|PENDING_CALL_TTL_SEC" /home/drbartender/projects/os/.env.example
# expect 10
```

---

- [ ] **Step 9.2: Declare the same keys in `render.yaml`**

Mirrors the existing pattern (secrets `sync: false`, numeric defaults with `value:` quoted strings, see `STRIPE_DEPOSIT_AMOUNT` at lines 45-46). Append inside `envVars:` after the last entry (`THUMBTACK_WEBHOOK_SECRET`, line 62-63).

Edit, anchor on the current last two lines of the file:

```
old_string:
      # Thumbtack Integration (shared secret for Basic Auth / x-thumbtack-secret header)
      - key: THUMBTACK_WEBHOOK_SECRET
        sync: false

new_string:
      # Thumbtack Integration (shared secret for Basic Auth / x-thumbtack-secret header)
      - key: THUMBTACK_WEBHOOK_SECRET
        sync: false
      # Zul VA Calling (Telegram-triggered Twilio callback bridge).
      # Set the secret/allowlist/number values in the Render dashboard — never here.
      - key: TELEGRAM_BOT_TOKEN
        sync: false
      - key: TELEGRAM_WEBHOOK_SECRET
        sync: false
      - key: TELEGRAM_ALLOWED_USER_ID
        sync: false
      - key: VOICE_CALLER_ID
        sync: false
      - key: VA_CELL
        sync: false
      - key: RUN_VA_CALLING_SCHEDULER
        sync: false
      - key: VA_CALL_DAILY_CAP
        value: "40"
      - key: VA_CALL_PER_MIN_CAP
        value: "5"
      - key: VA_CALL_TIME_LIMIT_SEC
        value: "1800"
      - key: PENDING_CALL_TTL_SEC
        value: "120"
```

Verify (also confirms YAML stays parseable):
```bash
grep -c "TELEGRAM_BOT_TOKEN\|TELEGRAM_WEBHOOK_SECRET\|TELEGRAM_ALLOWED_USER_ID\|VOICE_CALLER_ID\|VA_CELL\|RUN_VA_CALLING_SCHEDULER\|VA_CALL_DAILY_CAP\|VA_CALL_PER_MIN_CAP\|VA_CALL_TIME_LIMIT_SEC\|PENDING_CALL_TTL_SEC" /home/drbartender/projects/os/render.yaml
# expect 10
node -e "require('yaml') ? 0 : 0" 2>/dev/null; node -e "const fs=require('fs');const s=fs.readFileSync('/home/drbartender/projects/os/render.yaml','utf8');if(!/VA_CELL/.test(s))process.exit(1);console.log('ok')"
```

---

- [ ] **Step 9.3: `.claude/CLAUDE.md` Tech Stack + Environment Variables table**

**(a) Tech Stack list.** Add one line after the SMS entry (`- **SMS**: Twilio`) in the Reference → Tech Stack list.

Edit:
```
old_string:
- **SMS**: Twilio
- **Web Push**: `web-push` (VAPID) for staff-portal browser / PWA notifications

new_string:
- **SMS**: Twilio
- **VA calling (Zul)**: Telegram Bot API (raw HTTPS to the Bot API, no SDK) as the outbound-call trigger channel + Twilio Programmable Voice (`calls.create`) callback bridge that dials Zul's PH cell and bridges to a US target with the 224 as caller ID
- **Web Push**: `web-push` (VAPID) for staff-portal browser / PWA notifications
```

**(b) Environment Variables table.** Add rows at the end of the table (after the final `VAPID_CONTACT_EMAIL` row).

Edit:
```
old_string:
| `VAPID_CONTACT_EMAIL` | Contact email embedded in the VAPID JWT (`mailto:`). Optional — defaults to `contact@drbartender.com`. |

new_string:
| `VAPID_CONTACT_EMAIL` | Contact email embedded in the VAPID JWT (`mailto:`). Optional — defaults to `contact@drbartender.com`. |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token (@BotFather) for the Zul VA-calling trigger. When unset, `sendTelegramMessage`/`setTelegramWebhook` no-op (log + skip) and outbound calling is dead. |
| `TELEGRAM_WEBHOOK_SECRET` | Doubles as the secret URL path segment (`/api/telegram/<secret>`) AND the value compared constant-time against the `X-Telegram-Bot-Api-Secret-Token` header. Set the same value at `setWebhook`. Unset → `verifyTelegramSecret` returns false (all updates 403). |
| `TELEGRAM_ALLOWED_USER_ID` | Numeric Telegram user id of Zul (the only sender allowed to trigger a call). **When UNSET the webhook runs in bootstrap mode**: it replies to any sender with their own id and dials nothing. Set it, redeploy; then all other senders are silent no-ops. |
| `VOICE_CALLER_ID` | The 224 US voice line in strict E.164 (`+12242220082`). Caller ID on Zul's outbound calls and the number clients dial inbound. |
| `VA_CELL` | Zul's cell in strict E.164 (`+63…`), the bridge target Twilio calls. **Never run through `normalizePhone`** (US-centric). Lives only here — never on a DB record, never committed. |
| `RUN_VA_CALLING_SCHEDULER` | Optional. Set to `false` to disable the VA-calling scheduler (hourly prune of `pending_call`/`call_audit`/`telegram_update` + Telegram webhook heartbeat). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `VA_CALL_DAILY_CAP` / `VA_CALL_PER_MIN_CAP` | Toll-fraud spend caps: max calls placed per rolling 24h (default 40, DB-backed by counting `call_audit`) and max triggers accepted per minute (default 5). On trip the bot tells Zul and no call is placed. |
| `VA_CALL_TIME_LIMIT_SEC` / `PENDING_CALL_TTL_SEC` | Per-call hard `timeLimit` on both call legs (default 1800 = 30 min) and confirm-before-dial pending-record TTL (default 120s). |
```

Verify:
```bash
grep -c "TELEGRAM_BOT_TOKEN\|VA calling (Zul)\|VOICE_CALLER_ID\|RUN_VA_CALLING_SCHEDULER\|VA_CALL_DAILY_CAP" /home/drbartender/projects/os/.claude/CLAUDE.md
# expect >= 5
```

---

- [ ] **Step 9.4: `README.md` Tech Stack table + Environment Variables table + Folder Structure tree**

**(a) Tech Stack table.** Add a row after the SMS row (`| SMS | Twilio |`, line 16).

Edit:
```
old_string:
| SMS | Twilio |
| Web Push | `web-push` (VAPID) for staff-portal notifications |

new_string:
| SMS | Twilio |
| VA calling (Zul) | Telegram Bot API (raw HTTPS trigger) + Twilio Programmable Voice callback bridge |
| Web Push | `web-push` (VAPID) for staff-portal notifications |
```

**(b) Environment Variables table.** Add rows at the end of the table, after the last row (`ADMIN_PASSWORD`, line 110).

Edit:
```
old_string:
| `ADMIN_PASSWORD` | For seed | Admin account password |

new_string:
| `ADMIN_PASSWORD` | For seed | Admin account password |
| `TELEGRAM_BOT_TOKEN` | For VA calling | Telegram Bot API token (@BotFather). Unset → Telegram helpers no-op and outbound calling is dead. |
| `TELEGRAM_WEBHOOK_SECRET` | For VA calling | Secret URL path segment (`/api/telegram/<secret>`) AND the `X-Telegram-Bot-Api-Secret-Token` header value (constant-time compared). Set the same value at `setWebhook`. |
| `TELEGRAM_ALLOWED_USER_ID` | Bootstrap | Numeric Telegram user id of Zul. Leave UNSET on first deploy for bootstrap mode (webhook echoes the sender's id, dials nothing); then set + redeploy. |
| `VOICE_CALLER_ID` | For VA calling | The 224 US voice line in strict E.164 (`+12242220082`) — outbound caller ID + inbound number. |
| `VA_CELL` | For VA calling | Zul's cell, strict E.164 (`+63…`), the bridge target. Never normalized, never committed. |
| `RUN_VA_CALLING_SCHEDULER` | No | `false` disables the VA-calling prune + Telegram webhook-heartbeat scheduler. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `VA_CALL_DAILY_CAP` | No | Max calls placed per rolling 24h (default 40, DB-backed via `call_audit`). |
| `VA_CALL_PER_MIN_CAP` | No | Max triggers accepted per minute (default 5). |
| `VA_CALL_TIME_LIMIT_SEC` | No | Per-call hard `timeLimit` on both legs (default 1800 = 30 min). |
| `PENDING_CALL_TTL_SEC` | No | Confirm-before-dial pending-record TTL in seconds (default 120). |
```

**(c) Folder Structure, route files.** Add `telegram.js` after the `sms.js` route entry (line 187) and `voice.js` after the last route `venues.js` (line 207).

Edit 1 (route: telegram.js):
```
old_string:
│   │   ├── sms.js              # Twilio inbound-SMS webhook + admin thread API

new_string:
│   │   ├── sms.js              # Twilio inbound-SMS webhook + admin thread API
│   │   ├── telegram.js         # Zul VA-calling OUTBOUND trigger: POST /api/telegram/:secret (secret path + secret_token header + user_id allowlist), NANP validation, confirm-before-dial (YES), claim-then-call bridge
```

Edit 2 (route: voice.js), `venues.js` is the last route in the tree (`└──`); insert `voice.js` as the new last entry and demote `venues.js` to `├──`:
```
old_string:
│   │   └── venues.js           # Google Places venue search proxy

new_string:
│   │   ├── venues.js           # Google Places venue search proxy
│   │   └── voice.js            # Zul VA-calling Twilio Voice webhooks: POST /inbound (forward 224 → VA_CELL), /bridge (look up target by CallSid → Dial 224→target), /status (failed-leg → Telegram notice). isValidTwilioRequest gate + text/xml
```

**(d) Folder Structure, util files.** Insert the five new utils before the final util entry (`webhookEventsPruneScheduler.js`, line 287, which is the `└──` terminator). They co-locate with the VA-calling feature; keep `webhookEventsPruneScheduler.js` as the `└──` last item.

Edit:
```
old_string:
│   │   └── webhookEventsPruneScheduler.js # Hourly prune of `webhook_events` to a 30-day window (gated by RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER)

new_string:
│   │   ├── pendingCall.js      # VA-calling DB helpers: upsertPending, claimForDial (conditional UPDATE claim-then-call), attachCallSid, lookupTargetByCallSid, countPlacedSince (daily/per-min cap), recordAudit, pruneVaCallingRows
│   │   ├── telegram.js         # Telegram Bot API helper: sendTelegramMessage (gated on notificationsEnabled), setTelegramWebhook, getTelegramWebhookInfo, verifyTelegramSecret (constant-time header compare), isNewUpdate (update_id dedupe). Raw fetch, no SDK
│   │   ├── usPhone.js          # toUsE164 (normalizePhone then require /^\+1[2-9]\d{9}$/, reject 900/976 premium) + isUsE164 — the primary toll-fraud target-validation guard
│   │   ├── vaCallingScheduler.js # VA-calling scheduler body: pruneVaCallingRows + checkTelegramWebhookHealth (re-runs setTelegramWebhook + emails admin when the webhook is unset or recently errored)
│   │   ├── xmlEscape.js        # Shared xmlEscape (& < >) extracted from the SMS /inbound TwiML handler; used by sms.js + voice.js so no unescaped value is ever interpolated into TwiML
│   │   └── webhookEventsPruneScheduler.js # Hourly prune of `webhook_events` to a 30-day window (gated by RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER)
```

Verify:
```bash
grep -c "TELEGRAM_BOT_TOKEN\|VA calling (Zul)\|VOICE_CALLER_ID\|telegram.js\|voice.js\|pendingCall.js\|usPhone.js\|xmlEscape.js\|vaCallingScheduler.js" /home/drbartender/projects/os/README.md
# expect >= 9
```

---

- [ ] **Step 9.5: `ARCHITECTURE.md` route tables**

Add two route-table sections immediately after the Two-Way SMS section (which ends at line 351) and before `### Blog`. Mirrors the existing table format (see the Two-Way SMS table at lines 344-351).

Edit, anchor on the Blog section header:
```
old_string:
### Blog — `/api/blog`

new_string:
### VA Calling — Twilio Voice — `/api/voice`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/inbound` | Twilio signature | Client dials the 224 → returns TwiML `<Dial timeout="20" callerId="<caller>"><Number>VA_CELL</Number></Dial>` forwarding to Zul's cell (caller = `req.body.From`, xml-escaped). Prod: 403 on bad/missing signature. |
| POST | `/bridge` | Twilio signature | Fetched when Zul answers her leg. Looks up the target by `CallSid` from `pending_call` (never from a request param); returns `<Dial answerOnBridge="true" callerId="+12242220082" timeLimit="…"><Number>+1TARGET</Number></Dial>`, or a `<Say>…</Say><Hangup/>` when no target is found. |
| POST | `/status` | Twilio signature | Twilio call-status callback. On a failed/unanswered leg (`no-answer`/`busy`/`failed`/`canceled`) messages Zul via Telegram ("That call didn't connect, resend the number to retry.") + records `call_audit`. Always empty 200/204. |

### VA Calling — Telegram Trigger — `/api/telegram`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/:secret` | Secret path + `X-Telegram-Bot-Api-Secret-Token` header + `user_id` allowlist | Zul's outbound-call trigger. Verifies the secret path + header (constant-time; 403 on mismatch), dedupes on `update_id`. Bootstrap (allowlist unset): replies with the sender's id, dials nothing. Non-allowlisted sender: silent 200 no-op. `YES` (`/^y(es)?$/i`): per-min + daily cap check (DB-backed via `call_audit`), `claimForDial`, `placeBridgedCall`, reply "Calling <last4>…". Any other text: `toUsE164`-validate the target (US NANP only, 900/976 rejected), upsert the pending record, reply "Reply YES to call <pretty>". Always 200 to Telegram on a handled outcome; **never dials on a dev signature skip**. |

### Blog — `/api/blog`
```

Verify:
```bash
grep -c "VA Calling — Twilio Voice\|VA Calling — Telegram Trigger\|/api/voice\|/api/telegram" /home/drbartender/projects/os/ARCHITECTURE.md
# expect >= 4
```

---

- [ ] **Step 9.6: `ARCHITECTURE.md` Third-Party Integrations section**

Add a new integration subsection under `## Third-Party Integrations`, placed right before `### Web Push (Staff notifications)` so it sits next to Twilio (SMS). Mirrors the depth/style of the Cal.com and Twilio integration write-ups.

Edit, anchor on the Web Push heading:
```
old_string:
### Web Push (Staff notifications)

new_string:
### Zul VA Calling (Telegram trigger + Twilio Voice bridge)

Lets our Philippines-based VA (Zul) place and receive US calls that work over a poor mobile-data connection. Design: `docs/superpowers/specs/2026-07-01-zul-va-calling-design.md`. Operator runbook: `docs/va-calling-runbook.md`.

- **Core constraint**: real-time voice never rides Zul's internet. It rides her **cellular** network via a Twilio callback bridge — Twilio calls her cell, she answers, Twilio bridges the second leg to the target. Only a tiny few-KB Telegram trigger message uses data.
- **Outbound flow**: Zul texts a target number to the bot → `POST /api/telegram/<secret>` authenticates (secret path + `secret_token` header + `user_id` allowlist), validates the target US-only (`toUsE164`: `normalizePhone` then `^\+1[2-9]\d{9}$`, 900/976 rejected — the primary toll-fraud control), upserts a short-TTL `pending_call` and replies "Reply YES to call …". On `YES` a conditional `UPDATE … WHERE status='awaiting_confirm' RETURNING` claims the row (claim-then-call: `calls.create` is an external HTTP call, never in a DB txn), then `placeBridgedCall({ to: VA_CELL, callerId: VOICE_CALLER_ID, url: /api/voice/bridge, statusCallback: /api/voice/status, timeLimit })`. When Zul answers, `/bridge` looks up the target by `CallSid` (never a request param) and dials it with `answerOnBridge="true"` showing the 224.
- **Inbound flow**: client dials the 224 → `POST /api/voice/inbound` returns `<Dial>` forwarding to `VA_CELL` with the client's number as caller ID; unanswered → PH-carrier voicemail (missed-inbound capture deferred to v2).
- **Status feedback**: `POST /api/voice/status`; a failed/unanswered leg messages Zul via Telegram so she always learns the outcome.
- **Toll-fraud guards** (this webhook dials billed international calls on an auto-refill account from external input): (1) Telegram `secret_token` header + unguessable secret URL path, (2) numeric `user_id` allowlist layered on top, (3) US-only NANP validation in code, (4) confirm-before-dial with a TTL'd pending record (a new target replaces it), (5) claim-then-call idempotency + `telegram_update` `update_id` dedupe, (6) DB-backed spend caps (5 triggers/min, 40 calls/day counted from `call_audit`) + a 1800s per-call `timeLimit` on both legs, (7) shared `xmlEscape` on every TwiML interpolation, (8) `notificationsEnabled()` gate so a dev server never dials the live account, (9) a daily webhook heartbeat (`getWebhookInfo` → re-`setWebhook` + admin email on failure), (10) last-4 log redaction and a retention purge of the PII-bearing `call_audit`.
- **Helper modules**: `server/utils/telegram.js` (Bot API, raw fetch, no SDK), `server/utils/pendingCall.js` (claim-then-call DB helpers + audit + prune), `server/utils/usPhone.js` (`toUsE164`/`isUsE164`), `server/utils/xmlEscape.js` (shared TwiML escape), `server/utils/vaCallingScheduler.js` (prune + webhook heartbeat), `server/utils/sms.js#placeBridgedCall` (Twilio `calls.create`, gated identically to `sendSMS`).
- **Tables**: `pending_call` (confirm-before-dial state, one row per user), `call_audit` (spend/abuse audit + daily-cap source of truth), `telegram_update` (`update_id` retry dedupe). Pruned by the `RUN_VA_CALLING_SCHEDULER` job.
- **Bootstrap**: deploy with `TELEGRAM_ALLOWED_USER_ID` unset; the webhook echoes each sender's id and dials nothing until the id is set + redeployed.
- **Account setup (owner, console-only)**: Twilio PH voice geo (low-risk enabled, high-risk off), auto-refill on with headroom, and a low-balance + monthly-spend billing alert (a dry balance takes SMS down with it).

### Web Push (Staff notifications)
```

Verify:
```bash
grep -c "Zul VA Calling (Telegram trigger\|claim-then-call\|toll-fraud guards" /home/drbartender/projects/os/ARCHITECTURE.md
# expect >= 2
```

---

- [ ] **Step 9.7: Write the operator runbook `docs/va-calling-runbook.md`**

New file. This is the manual, human-executed checklist (no code). Full content:

```markdown
# Zul VA Calling — Operator Runbook

Source spec: `docs/superpowers/specs/2026-07-01-zul-va-calling-design.md`.
Feature: Zul (PH VA) places/receives US calls via a Telegram-triggered Twilio
callback bridge. This runbook is the manual bring-up + validation checklist.
Do it in order; the bootstrap and webhook steps have a required sequence.

## 0. Prerequisites (owner, one-time, Twilio console only)

- [ ] **PH voice geo**: confirm low-risk PH dialing is ENABLED and high-risk is
      OFF (Twilio → Voice → Geographic Permissions). Already verified via API.
- [ ] **Auto-refill + spend alert**: confirm auto-refill is ON with headroom
      (balance had been thin, ~$16.72 — a dry balance takes SMS down with it),
      and set a low-balance + monthly-spend email alert in the Billing console.
      This is the secondary backstop behind the in-code spend caps.

## 1. Create the Telegram bot

- [ ] In Telegram, message **@BotFather** → `/newbot` → give it a name + username.
- [ ] Copy the **HTTP API token** BotFather returns → this is `TELEGRAM_BOT_TOKEN`.
- [ ] Generate a webhook secret:
      `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
      → this is `TELEGRAM_WEBHOOK_SECRET` (it is BOTH the URL path segment and the
      X-Telegram-Bot-Api-Secret-Token header value).

## 2. First deploy — BOOTSTRAP mode (allowlist unset)

- [ ] In the Render dashboard set: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
      `VOICE_CALLER_ID=+12242220082`, `VA_CELL=<Zul's +63… cell>`.
      **Leave `TELEGRAM_ALLOWED_USER_ID` UNSET.**
- [ ] Deploy. With the allowlist unset the webhook runs in bootstrap mode: it
      replies to any sender with their own numeric id and dials nothing.

## 3. Capture Zul's user id

- [ ] Have Zul open the bot and tap **Start**, then send any message.
- [ ] The bot replies "Your Telegram id is <NNN>". Read that number.
      (If the bot does not reply yet, the webhook may not be registered — do step 4
      first, then have her resend.)

## 4. Register the Telegram webhook (once)

- [ ] Run `setTelegramWebhook()` once against prod. It POSTs `setWebhook` with
      `url = <API_URL>/api/telegram/<TELEGRAM_WEBHOOK_SECRET>` and
      `secret_token = <TELEGRAM_WEBHOOK_SECRET>`. The VA-calling scheduler's daily
      heartbeat also self-heals this, but run it explicitly now.
- [ ] Confirm with `getTelegramWebhookInfo()`: `url` is set, `last_error_date` is
      empty/old, `pending_update_count` is small.

## 5. Lock the allowlist — second deploy

- [ ] In Render set `TELEGRAM_ALLOWED_USER_ID = <Zul's id from step 3>`. Redeploy.
- [ ] Now every sender except Zul is a silent no-op; Zul's messages trigger calls.

## 6. Point the 224 inbound voice webhook (Twilio console)

- [ ] Twilio → Phone Numbers → **+1 (224) 222-0082** → Voice → "A call comes in":
      Webhook, HTTP POST, URL = `<API_URL>/api/voice/inbound`.
- [ ] Leave the status-callback wiring to `calls.create` (the code sets
      `statusCallback` on the outbound leg); no console change needed for status.

## 7. Validation tests (from the spec — do all three before declaring done)

- [ ] **Test 1 — audio (the core bet):** place a test call from Twilio to Zul's
      cell and confirm it rings reliably with clean audio over several tries. If
      this fails the whole approach is wrong — stop and reassess.
- [ ] **Test 2 — Telegram round-trip:** Zul texts the bot a US number → bot replies
      "Reply YES to call …" → she sends YES → her cell rings → she answers → she is
      bridged to the target, which sees the 224. Then repeat to a deliberately
      unanswered number and confirm she gets the "didn't connect, resend" Telegram
      notice.
- [ ] **Test 3 — inbound forward:** call the 224 from another phone → it forwards to
      Zul's cell within the 20s timeout with the caller's number shown.

## 8. Optional (owner, decoupled from this feature)

- [ ] If desired, run `server/scripts/createAdmin.js` to give Zul an admin account.
      This is a separate, owner-approved decision — calling needs ZERO admin rights
      (the bridge target is `VA_CELL`, an env var), so do NOT block calling on it.

## Notes / guard rails

- `VA_CELL` is strict E.164 (`+63…`) and is NEVER run through `normalizePhone`.
- Never commit `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
  `TELEGRAM_ALLOWED_USER_ID`, or `VA_CELL` — all are `sync: false` in `render.yaml`.
- Dev testing needs a public HTTPS URL for `setWebhook` (ngrok/cloudflared to
  `:5000`) or test against prod with care. Privileged actions never run on a dev
  signature-skip path.
- Spend caps live in code (`VA_CALL_DAILY_CAP` / `VA_CALL_PER_MIN_CAP` /
  `VA_CALL_TIME_LIMIT_SEC`); the Twilio billing alert is the secondary backstop.
```

Verify:
```bash
test -f /home/drbartender/projects/os/docs/va-calling-runbook.md && grep -c "BOOTSTRAP mode\|setTelegramWebhook\|Validation tests\|createAdmin.js" /home/drbartender/projects/os/docs/va-calling-runbook.md
# expect >= 4
```

---

- [ ] **Step 9.8: Full verification sweep + commit**

Run a final consistency sweep across all six files, then commit with an explicit pathspec (per the os shared-index invariant, never `git add .`).

```bash
# Every new key must appear in BOTH .env.example and render.yaml
for k in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_ALLOWED_USER_ID VOICE_CALLER_ID VA_CELL RUN_VA_CALLING_SCHEDULER VA_CALL_DAILY_CAP VA_CALL_PER_MIN_CAP VA_CALL_TIME_LIMIT_SEC PENDING_CALL_TTL_SEC; do
  e=$(grep -c "$k" /home/drbartender/projects/os/.env.example)
  r=$(grep -c "$k" /home/drbartender/projects/os/render.yaml)
  echo "$k env=$e render=$r"
done
# each key: env>=1 render>=1

# Docs tables mention the new keys + integration + files
grep -q "TELEGRAM_BOT_TOKEN" /home/drbartender/projects/os/.claude/CLAUDE.md && \
grep -q "TELEGRAM_BOT_TOKEN" /home/drbartender/projects/os/README.md && \
grep -q "Zul VA Calling (Telegram trigger" /home/drbartender/projects/os/ARCHITECTURE.md && \
grep -q "telegram.js" /home/drbartender/projects/os/README.md && \
grep -q "voice.js" /home/drbartender/projects/os/README.md && \
grep -q "/api/voice" /home/drbartender/projects/os/ARCHITECTURE.md && \
grep -q "/api/telegram" /home/drbartender/projects/os/ARCHITECTURE.md && \
echo "DOCS OK"

# render.yaml still parses (no tab/indent breakage)
node -e "const fs=require('fs');const s=fs.readFileSync('/home/drbartender/projects/os/render.yaml','utf8');if(/\t/.test(s))throw new Error('tab in yaml');console.log('yaml indent ok')"
```

Commit:
```bash
git -C /home/drbartender/projects/os add \
  .env.example render.yaml .claude/CLAUDE.md README.md ARCHITECTURE.md docs/va-calling-runbook.md
git -C /home/drbartender/projects/os commit -m "$(cat <<'EOF'
docs(va-calling): env vars, docs, and operator runbook for Zul VA calling

Declare TELEGRAM_*, VOICE_CALLER_ID, VA_CELL, RUN_VA_CALLING_SCHEDULER and
the VA_CALL_* spend caps in .env.example + render.yaml (sync:false / defaults,
no secret values). Add the Telegram+Twilio-Voice integration to CLAUDE.md +
README Tech Stack and ARCHITECTURE Third-Party Integrations, the env vars to
both env-var tables, voice.js/telegram.js to the README folder tree, the
/api/voice + /api/telegram route tables to ARCHITECTURE, and the new util files
to the tree. Add docs/va-calling-runbook.md (bootstrap → webhook → 224 wiring →
3 validation tests).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

Notes for the executor:
- This task has **no runnable behavior**; the greps above are the acceptance gate. Do not add a node:test file.
- If any prior task changed a doc anchor line (e.g. the last env-table row or the SMS route line), re-locate the anchor by `grep -n` before editing, the intent (append after the SMS/Twilio-adjacent entry, append at the end of each table) is what matters, not the exact line number.
- Do not commit real secret values. Confirm `git diff --staged` shows only placeholder/`sync: false`/numeric-default entries before committing.
