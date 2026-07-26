---
lanes:
  - id: ext-core
    footprint:
      - server/db/schema.sql
      - server/utils/proposalMoneyShared.js
      - server/utils/eventEndInstant.js
      - server/utils/eventEndInstant.test.js
      - server/data/extensionTermsCopy.js
      - server/utils/serviceExtensionPricing.js
      - server/utils/serviceExtensionPricing.test.js
      - server/utils/serviceExtensionSettle.js
      - server/utils/serviceExtensionSettle.test.js
      - scripts/money-smoke-list.txt
    deps: []
    review: full-fleet
  - id: ext-routes
    footprint:
      - server/routes/serviceExtensions/index.js
      - server/routes/serviceExtensions/create.js
      - server/routes/serviceExtensions/create.test.js
      - server/routes/serviceExtensions/publicAccept.js
      - server/routes/serviceExtensions/publicAccept.test.js
      - server/routes/serviceExtensions/admin.js
      - server/routes/serviceExtensions/admin.test.js
      - server/utils/serviceExtensionNotify.js
      - server/routes/stripe.js
      - server/routes/invoices.js
      - server/routes/invoices.extension.test.js
      - server/index.js
    deps: [ext-core]
    review: full-fleet
  - id: ext-webhook-payroll
    footprint:
      - server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js
      - server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js
      - server/utils/payrollAccrual.js
      - server/utils/payrollAccrual.extension.test.js
      - server/utils/serviceExtensionPayroll.js
      - server/utils/serviceExtensionPayroll.test.js
      - server/utils/serviceExtensionSweep.js
      - server/utils/serviceExtensionSweep.test.js
      - server/index.js
    deps: [ext-core, ext-routes]
    review: full-fleet
  - id: ext-ui
    footprint:
      - client/src/pages/staff/RequestMoreTime.js
      - client/src/pages/staff/ShiftDetail.js
      - client/src/pages/invoice/InvoicePage.js
      - client/src/index.css
      - client/src/components/adminos/ServiceExtensionPanel.js
      - client/src/pages/admin/EventDetailPage.js
      - server/routes/serviceExtensions/create.js
      - server/routes/serviceExtensions/create.test.js
    deps: [ext-routes]
    review: full-fleet
  - id: ext-docs
    footprint:
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
      - .env.example
    deps: [ext-routes, ext-webhook-payroll]
    review: light
---

# On-site Service Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staffer on site can request more bar time from the staff portal; the client accepts brief coverage terms and pays on the regular invoice page; the event's duration and the staffer's payroll hours move, and every outcome leaves an audit record.

**Architecture:** Extension money is SIDE MONEY. A new `Service Extension` invoice label joins the dormant `OFF_LEDGER_INVOICE_LABELS` constant, which makes the existing webhook skip the `amount_paid` roll-up, keeps `refreshUnlockedInvoices` from re-billing, and makes refund reconciliation leave the contract alone. `proposals.total_price`, `pricing_snapshot`, `amount_paid`, and payment status NEVER move. The only contract mutation is `event_duration_hours` (plus the linked shift's `end_time`). Payroll picks up the extra hours via its existing first-accrual seeding, and the extension's gratuity joins the pool as an event-scoped addend, exactly as card tips already do. No existing money path is modified: `foldExtrasIntoProposal`, `reconcileProposalPaymentStatus`, and the auto-complete gates are untouched. Spec: `docs/superpowers/specs/2026-07-25-service-extension-design.md` (rev 3, approved).

**Tech Stack:** Node 26 / Express 4, raw SQL via `pg`, node:test co-located suites against the shared dev DB, Stripe via the `getStripe()` DI seam, React 18 admin + staff client (axios through `client/src/utils/api.js`), vanilla CSS.

## Global Constraints

- **Proposals money is NUMERIC DOLLARS** (`total_price`, `amount_paid`, `event_duration_hours`); invoices, `proposal_payments`, Stripe, and every `*_cents` column are **INTEGER CENTS**. Convert with `toCents()` (`server/utils/invoiceShared.js`) or `cents / 100`. `service_extensions.amount_cents` and `gratuity_cents` are cents.
- **Never touch `total_price`, `pricing_snapshot`, `amount_paid`, or `proposals.status`** anywhere in this feature. If a task seems to need it, the task is wrong. See spec §2 "landmine" and §3 D12.
- **One pooled connection per request:** inside a `pool.connect()` transaction every query goes through the held `client`; `release()` BEFORE any post-commit tail that calls helpers taking their own connection (`serviceExtensionNotify.js` does).
- All Stripe calls via `server/utils/stripeClient.js` `getStripe()`. Tests stub the seam by assigning `require('../../utils/stripeClient').getStripe = () => fakeStripe` BEFORE requiring the router.
- Throw `AppError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `PermissionError`) from `server/utils/errors.js`; never `res.status(...).json({error})`. `asyncHandler` is at `server/middleware/asyncHandler` (NOT utils).
- Schema changes go in `server/db/schema.sql`, idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- **No em dashes** in any client-visible or staff-visible copy. Commas, periods, colons, parentheses only.
- **Staff never see the price.** No response from any staff-facing endpoint may contain `amount_cents`, `gratuity_cents`, or any dollar figure. Explicit column allowlists on every staff SELECT.
- File-size soft cap 700 lines, hard cap 1000. `server/routes/staffShiftActions.js` (929) and `client/src/pages/staff/ShiftDetail.js` (804) are both near/over caps: add NOTHING substantial to either. New surfaces get new files.
- Tests: co-located `*.test.js`, node:test, run **one suite at a time** against the shared dev DB. From a lane worktree (no `.env` there): `node --env-file=/home/drbartender/projects/os/.env --test <file>`. Nonce-suffixed seed rows, FK-ordered teardown, `await pool.end()` in `after()`. Pay-period fixtures use the chicago-keyed track-and-restore pattern (standing test law).
- Hosted-package bartender rule is load-bearing: included 1:100 bartenders are $0; over-ratio bartenders bill `extra_bartender_hourly` PLUS the sub-100-guest surcharge ($50/$25/$15 per hour for <50/<75/<100 guests). The pricing delta inherits this from the engine; Task 4 pins it with a test.

## In-lane review cadence

Per the execution-review cadence rule, agents fire at checkpoints, not only at merge:
- `ext-core` after Task 2 (schema + off-ledger constant): `database-review`.
- `ext-core` after Task 5: `code-review` on the pricing math.
- `ext-webhook-payroll` after Task 12: `security-review` + `code-review` (webhook + payroll are the two money seams).
- `ext-routes` after Task 10: `security-review` (auth predicate, public token surface).
- Merge gate per lane: the fleet declared in front-matter.

---

## Lane ext-core

Pure server-side foundations: the constant flip, the schema, the timezone helper, the terms registry, the pricing delta, and the settle core. No routes, no webhook, no UI. Everything here is unit-testable without HTTP.

### Task 1: Timezone-correct event end instant

The request window and `expires_at` are instants, not wall-clock strings. `server/utils/shiftTime.js` hardcodes Chicago and `addHoursToTime` is naive string math with a `% 24` wrap, so neither can be used for this. The one correct precedent is the SQL expression in `balanceScheduler.js` that composes `event_date + event_start_time + event_duration_hours` in `event_timezone`. Extract it into a reusable helper.

**Files:**
- Create: `server/utils/eventEndInstant.js`
- Test: `server/utils/eventEndInstant.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `eventEndInstant(client, proposalId)` → `Promise<{ startInstant: Date, endInstant: Date, endDisplay: string } | null>`. Returns `null` when the proposal is missing or its `event_start_time` cannot be parsed by Postgres.
  - `eventEndInstantForDuration(client, proposalId, durationHours)` → same shape, computed at an arbitrary duration instead of the stored one.

- [ ] **Step 1: Read the precedent so the SQL matches it**

Run: `grep -n "event_timezone" -B4 -A8 server/utils/balanceScheduler.js`

Read the `AT TIME ZONE` composition it uses for the completion gate. The helper below is that expression, parameterized on duration.

- [ ] **Step 2: Write the failing test**

Create `server/utils/eventEndInstant.test.js`:

```javascript
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { eventEndInstant, eventEndInstantForDuration } = require('./eventEndInstant');

const NONCE = `eei-${Date.now()}`;
let clientId, pkgId, proposalId, tzProposalId, badProposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id",
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    "SELECT id FROM service_packages WHERE pricing_type = 'flat' AND is_active = true LIMIT 1"
  );
  pkgId = p.rows[0].id;

  // 8:00 PM Chicago on 2026-09-12, 4 hours -> midnight Chicago = 05:00 UTC on 9/13 (CDT, UTC-5).
  const ins = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','8:00 PM','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  proposalId = ins.rows[0].id;

  // Same wall clock, New York (UTC-4 in September) -> midnight NY = 04:00 UTC.
  const tz = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','8:00 PM','America/New_York','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  tzProposalId = tz.rows[0].id;

  const bad = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'deposit_paid',100,4,1,350,350,'2026-09-12','whenever','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId]
  );
  badProposalId = bad.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('composes the end instant in the event timezone, crossing midnight', async () => {
  const r = await eventEndInstant(pool, proposalId);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T05:00:00.000Z');
});

test('a different event_timezone yields a different instant for the same wall clock', async () => {
  const r = await eventEndInstant(pool, tzProposalId);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T04:00:00.000Z');
});

test('eventEndInstantForDuration prices an arbitrary duration without persisting it', async () => {
  const r = await eventEndInstantForDuration(pool, proposalId, 4.5);
  assert.equal(r.endInstant.toISOString(), '2026-09-13T05:30:00.000Z');
  const unchanged = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(unchanged.rows[0].event_duration_hours), 4);
});

test('returns null when the start time is unparseable', async () => {
  assert.equal(await eventEndInstant(pool, badProposalId), null);
});

test('returns null for a missing proposal', async () => {
  assert.equal(await eventEndInstant(pool, 999999999), null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/eventEndInstant.test.js`
Expected: FAIL, `Cannot find module './eventEndInstant'`.

- [ ] **Step 4: Write the implementation**

Create `server/utils/eventEndInstant.js`:

```javascript
'use strict';

/**
 * Timezone-correct event start/end instants.
 *
 * The only correct precedent in the codebase is the completion gate in
 * balanceScheduler.js, which composes event_date + event_start_time +
 * event_duration_hours inside event_timezone. This module is that expression,
 * parameterized on duration, so the service-extension request window and
 * expires_at are real instants.
 *
 * Deliberately NOT shiftTime.js (hardcodes Chicago, literal -05:00/-06:00
 * offsets) and NOT addHoursToTime (naive string math with a % 24 midnight
 * wrap). addHoursToTime remains correct for the shift's DISPLAY string only.
 *
 * Postgres does the parsing so free-text event_start_time behaves identically
 * to every other consumer. An unparseable time returns null rather than
 * throwing, so callers can surface an explicit conflict.
 */

const SQL = `
  SELECT
    (((p.event_date::text || ' ' || p.event_start_time)::timestamp)
       AT TIME ZONE COALESCE(NULLIF(p.event_timezone, ''), 'America/Chicago')) AS start_instant,
    (((p.event_date::text || ' ' || p.event_start_time)::timestamp
       + ($2::numeric * INTERVAL '1 hour'))
       AT TIME ZONE COALESCE(NULLIF(p.event_timezone, ''), 'America/Chicago')) AS end_instant,
    to_char(((p.event_date::text || ' ' || p.event_start_time)::timestamp
       + ($2::numeric * INTERVAL '1 hour')), 'FMHH12:MI AM') AS end_display
  FROM proposals p
  WHERE p.id = $1
`;

async function eventEndInstantForDuration(client, proposalId, durationHours) {
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  let rows;
  try {
    ({ rows } = await client.query(SQL, [proposalId, hours]));
  } catch (err) {
    // 22007 invalid_datetime_format / 22008 datetime_field_overflow: the stored
    // event_start_time is free text and this one is not a time. Not our bug to
    // throw on; the caller turns it into an explicit conflict.
    if (err.code === '22007' || err.code === '22008') return null;
    throw err;
  }
  if (!rows[0] || !rows[0].end_instant) return null;
  return {
    startInstant: rows[0].start_instant,
    endInstant: rows[0].end_instant,
    endDisplay: rows[0].end_display,
  };
}

async function eventEndInstant(client, proposalId) {
  const { rows } = await client.query(
    'SELECT event_duration_hours FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!rows[0] || rows[0].event_duration_hours === null) return null;
  return eventEndInstantForDuration(client, proposalId, rows[0].event_duration_hours);
}

module.exports = { eventEndInstant, eventEndInstantForDuration };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/eventEndInstant.test.js`
Expected: PASS, 5 tests.

If the `to_char` format yields `8:00 AM` style with a leading space or a different case than the existing `addHoursToTime` output, adjust the format string so `endDisplay` matches what `shifts.end_time` already stores. Check with: `grep -n "addHoursToTime" -A12 server/utils/eventCreation.js | head -20`.

- [ ] **Step 6: Commit**

```bash
git add server/utils/eventEndInstant.js server/utils/eventEndInstant.test.js
git commit -m "feat(ext): timezone-correct event end instant helper"
```

### Task 2: Schema + the off-ledger label constant

**Files:**
- Modify: `server/db/schema.sql` (append to the end)
- Modify: `server/utils/proposalMoneyShared.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Table `service_extensions` (columns per spec §8).
  - `SERVICE_EXTENSION_INVOICE_LABEL` = `'Service Extension'`, exported from `proposalMoneyShared.js`.
  - `OFF_LEDGER_INVOICE_LABELS` now contains that label.

- [ ] **Step 1: Read the constant module before editing it**

Run: `cat server/utils/proposalMoneyShared.js`

Note the existing `CONTRACT_LABELS` and the frozen-empty `OFF_LEDGER_INVOICE_LABELS`. `CONTRACT_LABELS` must NOT change: adding the extension label there would put extension money inside the contract-refund scope, which is the exact defect spec §3 D12 exists to avoid.

- [ ] **Step 2: Add the constant**

Edit `server/utils/proposalMoneyShared.js`. Replace the `OFF_LEDGER_INVOICE_LABELS` line and the exports:

```javascript
// The service-extension invoice label. Off-ledger by design (spec
// 2026-07-25 D12): its money is never in total_price, so the webhook must
// skip the amount_paid roll-up, refreshUnlockedInvoices must not count it,
// and refund reconciliation must leave the contract alone. All three read
// OFF_LEDGER_INVOICE_LABELS, so joining that set is the whole wiring.
// Deliberately NOT in CONTRACT_LABELS.
const SERVICE_EXTENSION_INVOICE_LABEL = 'Service Extension';

const OFF_LEDGER_INVOICE_LABELS = Object.freeze([SERVICE_EXTENSION_INVOICE_LABEL]);

module.exports = {
  MAX_ADDON_QTY,
  safeAddonQty,
  CONTRACT_LABELS,
  OFF_LEDGER_INVOICE_LABELS,
  SERVICE_EXTENSION_INVOICE_LABEL,
};
```

- [ ] **Step 3: Prove the set is no longer a no-op**

Run:
```bash
node -e "const m=require('/home/drbartender/projects/os/server/utils/proposalMoneyShared');console.log(m.OFF_LEDGER_INVOICE_LABELS, m.CONTRACT_LABELS)"
```
Expected: `[ 'Service Extension' ] [ 'Deposit', 'Balance', 'Full Payment' ]`

- [ ] **Step 4: Run every existing suite that reads either constant**

Run:
```bash
grep -rln "OFF_LEDGER_INVOICE_LABELS\|CONTRACT_LABELS" server --include=*.test.js
```
Then run each hit ONE AT A TIME with `node --env-file=/home/drbartender/projects/os/.env --test <file>`.

Expected: all PASS. The constant was empty until now, so any suite that asserted emptiness or counted off-ledger behavior will move. If one fails, read it: a test asserting `OFF_LEDGER_INVOICE_LABELS.length === 0` is asserting the old placeholder state and should be updated to assert the label is present. A test that fails on actual money math is a real regression and blocks this task.

- [ ] **Step 5: Add the table to the schema**

Append to `server/db/schema.sql`:

```sql
-- ─── Service extensions (on-site added bar time) ──────────────────────────
-- One row per staff request for more bar time. Spec:
-- docs/superpowers/specs/2026-07-25-service-extension-design.md
-- Money is SIDE MONEY: the paid extension lives as its own invoice + payment,
-- and proposals.total_price / amount_paid / pricing_snapshot never move. The
-- only contract mutation is proposals.event_duration_hours.
CREATE TABLE IF NOT EXISTS service_extensions (
  id                        SERIAL PRIMARY KEY,
  proposal_id               INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  shift_id                  INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  requested_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invoice_id                INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  contracted_end_time       VARCHAR(20),
  requested_end_time        VARCHAR(20),
  contracted_duration_hours NUMERIC(4,1) NOT NULL,
  requested_duration_hours  NUMERIC(4,1) NOT NULL,
  amount_cents              INTEGER NOT NULL,
  gratuity_cents            INTEGER NOT NULL DEFAULT 0,
  hosted_product_confirmed  BOOLEAN,
  terms_version             TEXT,
  client_accepted_at        TIMESTAMPTZ,
  client_accept_ip          VARCHAR(64),
  client_accept_ua          TEXT,
  status                    VARCHAR(20) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','paid','expired','cancelled','overridden')),
  override_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  override_reason           TEXT,
  expires_at                TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live request per event at a time. The partial index is what makes a
-- second staffer's concurrent request a clean no-op instead of a double charge.
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_extensions_one_pending
  ON service_extensions (proposal_id) WHERE status = 'pending';

-- Sweep driver: claim pending rows past expiry.
CREATE INDEX IF NOT EXISTS idx_service_extensions_pending_expiry
  ON service_extensions (expires_at) WHERE status = 'pending';

-- Webhook discriminator: settle looks the row up by the paid invoice.
CREATE INDEX IF NOT EXISTS idx_service_extensions_invoice
  ON service_extensions (invoice_id);

-- Payroll gratuity addend sums paid rows per proposal.
CREATE INDEX IF NOT EXISTS idx_service_extensions_proposal_status
  ON service_extensions (proposal_id, status);
```

- [ ] **Step 6: Apply the schema to the dev DB and verify**

Run:
```bash
node --env-file=/home/drbartender/projects/os/.env -e "
const {pool}=require('/home/drbartender/projects/os/server/db');
const fs=require('fs');
(async()=>{
  const sql=fs.readFileSync('/home/drbartender/projects/os/server/db/schema.sql','utf8');
  const start=sql.indexOf('CREATE TABLE IF NOT EXISTS service_extensions');
  await pool.query(sql.slice(start));
  const r=await pool.query(\"SELECT column_name,data_type FROM information_schema.columns WHERE table_name='service_extensions' ORDER BY ordinal_position\");
  console.log(r.rows.map(x=>x.column_name+':'+x.data_type).join('\n'));
  await pool.end();
})();
"
```
Expected: all 22 columns listed, `amount_cents:integer`, `contracted_duration_hours:numeric`.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.sql server/utils/proposalMoneyShared.js
git commit -m "feat(ext): service_extensions table + Service Extension off-ledger label

Flips OFF_LEDGER_INVOICE_LABELS from its frozen-empty placeholder to the
label the webhook, invoice refresh, and refund reconciliation branches were
already written to expect."
```

- [ ] **Step 8: Checkpoint review**

Dispatch `database-review` on `git diff HEAD~1` for this task. The constant flip changes behavior in three call sites that were previously dead; the reviewer should confirm each branch does what §2 of the spec claims.

### Task 3: Terms copy registry

Modeled on `server/data/smsConsentCopy.js`, which refuses an unknown version rather than recording a lie. Without this, a stored `terms_version` maps to no text and the audit artifact is empty.

**Files:**
- Create: `server/data/extensionTermsCopy.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CURRENT_EXTENSION_TERMS_VERSION` (string, `'2026-07-26.1'`)
  - `getExtensionTerms(version)` → `{ version, headline, body }`, THROWS on an unknown version.
  - `renderExtensionTerms({ version, newEndDisplay })` → `{ version, headline, paragraphs: string[] }` with the end time interpolated.

- [ ] **Step 1: Read the precedent**

Run: `sed -n 1,60p server/data/smsConsentCopy.js`

Match its shape: a frozen version map, a lookup that throws on miss, and copy stored as data rather than inline in a route.

- [ ] **Step 2: Write the registry**

Create `server/data/extensionTermsCopy.js`:

```javascript
'use strict';

/**
 * Versioned client-facing terms for an on-site service extension.
 *
 * Stored as data, and looked up by the version recorded on the
 * service_extensions row, so the audit trail can always reproduce exactly
 * what the client agreed to. getExtensionTerms THROWS on an unknown version
 * rather than returning a default: recording "they accepted v3" while showing
 * v1's text would make the artifact a lie (the smsConsentCopy precedent).
 *
 * Copy rule: no em dashes.
 */

const CURRENT_EXTENSION_TERMS_VERSION = '2026-07-26.1';

const VERSIONS = Object.freeze({
  '2026-07-26.1': Object.freeze({
    headline: 'Extend bar service to {{END}}',
    body: Object.freeze([
      'Additional bar service under your existing agreement. Same team, same terms, same $2 million liquor liability coverage.',
      'That coverage applies to service booked through Dr. Bartender. Our bartenders cannot accept payment directly for additional service time, and any arrangement made privately with a bartender is not insured.',
    ]),
  }),
});

function getExtensionTerms(version) {
  const entry = VERSIONS[version];
  if (!entry) {
    throw new Error(`getExtensionTerms: unknown terms version '${version}'`);
  }
  return { version, headline: entry.headline, body: entry.body };
}

function renderExtensionTerms({ version, newEndDisplay }) {
  const terms = getExtensionTerms(version);
  return {
    version: terms.version,
    headline: terms.headline.replace('{{END}}', newEndDisplay || 'the new end time'),
    paragraphs: [...terms.body],
  };
}

module.exports = {
  CURRENT_EXTENSION_TERMS_VERSION,
  getExtensionTerms,
  renderExtensionTerms,
  VERSIONS,
};
```

- [ ] **Step 3: Verify the lookup and the copy rule**

Run:
```bash
node -e "
const m=require('/home/drbartender/projects/os/server/data/extensionTermsCopy');
const r=m.renderExtensionTerms({version:m.CURRENT_EXTENSION_TERMS_VERSION,newEndDisplay:'11:00 PM'});
console.log(r.headline);
console.log(r.paragraphs.join('\n'));
const all=r.headline+r.paragraphs.join('');
if(all.includes('—')) throw new Error('em dash in client copy');
try{m.getExtensionTerms('nope');throw new Error('should have thrown')}catch(e){console.log('unknown version rejected:',e.message)}
console.log('OK');
"
```
Expected: headline `Extend bar service to 11:00 PM`, both paragraphs, `unknown version rejected: ...`, `OK`.

- [ ] **Step 4: Commit**

```bash
git add server/data/extensionTermsCopy.js
git commit -m "feat(ext): versioned extension terms copy registry"
```

### Task 4: The pricing delta

The whole money question, in one pure-ish function. It mirrors `foldExtrasIntoProposal`'s delta discipline exactly: price both legs at CATALOG (`totalPriceOverride: null`) and difference the SERVICE portion, because the override is a service-level contract that the engine substitutes for the calculated total. Differencing `.total` with an override present would collapse the service delta to zero.

Two legs differ ONLY in `durationHours`. Everything else is identical, so anything without a duration term cancels exactly. `calculateSyrupCost(syrupSelections, guestCount)` takes no duration, so syrups cancel and both legs pass `[]`. Add-ons do NOT cancel (`per_guest_timed` and `per_hour` carry duration terms), so the real add-on rows must be loaded.

**Files:**
- Create: `server/utils/serviceExtensionPricing.js`
- Test: `server/utils/serviceExtensionPricing.test.js`

**Interfaces:**
- Consumes: `eventEndInstantForDuration` (Task 1).
- Produces:
  - `MAX_EXTENSION_HOURS` = `3`
  - `computeExtensionDelta({ client, proposalId, requestedDurationHours })` → `Promise<Result>` where `Result` is either
    `{ ok: true, contractedDurationHours, requestedDurationHours, contractedEndDisplay, requestedEndDisplay, serviceDeltaCents, gratuityDeltaCents, amountCents, isHosted }`
    or `{ ok: false, reason }` with `reason` in `'missing_proposal' | 'missing_package' | 'unparseable_time' | 'not_an_extension' | 'over_cap' | 'bad_increment'`.

- [ ] **Step 1: Write the failing test**

Create `server/utils/serviceExtensionPricing.test.js`:

```javascript
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { computeExtensionDelta, MAX_EXTENSION_HOURS } = require('./serviceExtensionPricing');

const NONCE = `sxp-${Date.now()}`;
let clientId, flatPkgId, hostedPkgId;
const made = [];

async function mkProposal(fields) {
  const {
    packageId, guests = 100, hours = 4, gratuityRate = 0, numBartenders = null,
    override = null, totalPrice = 350,
  } = fields;
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        num_bartenders, gratuity_rate, tip_jar, total_price, total_price_override,
        amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot, adjustments)
     VALUES ($1,$2,'deposit_paid',$3,$4,1,$5,$6,true,$7,$8,$7,'2026-09-12','6:00 PM','America/Chicago','{}','[]')
     RETURNING id`,
    [clientId, packageId, guests, hours, numBartenders, gratuityRate, totalPrice, override]
  );
  made.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  // The Core Reaction: flat, base_rate_4hr 350, extra_hour_rate 100.
  const f = await pool.query(
    "SELECT id FROM service_packages WHERE pricing_type='flat' AND extra_hour_rate = 100 AND is_active=true LIMIT 1"
  );
  flatPkgId = f.rows[0].id;
  // The Base Compound: per_guest, base 18, extra_hour_rate 5.
  const h = await pool.query(
    "SELECT id FROM service_packages WHERE pricing_type='per_guest' AND extra_hour_rate = 5 AND bar_type='full_bar' AND is_active=true LIMIT 1"
  );
  hostedPkgId = h.rows[0].id;
});

after(async () => {
  if (made.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [made]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('flat package, +30 min above the 4h base, zero gratuity: $50', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 5000);
  assert.equal(r.gratuityDeltaCents, 0);
  assert.equal(r.serviceDeltaCents, 5000);
});

test('gratuity rides along: +30 min at $50/staff/hr adds $25', async () => {
  const id = await mkProposal({ packageId: flatPkgId, gratuityRate: 50 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.5 });
  assert.equal(r.ok, true);
  assert.equal(r.gratuityDeltaCents, 2500);
  assert.equal(r.amountCents, 7500);
});

test('flat package below the 4h tier: 3h -> 4h is $0, the zero-delta path', async () => {
  const id = await mkProposal({ packageId: flatPkgId, hours: 3 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 0);
});

test('over-ratio bartender at 50 guests carries the sub-100 surcharge: +60 min is $165', async () => {
  // 50 guests -> staffing.required = 1; num_bartenders override 2 -> 1 extra.
  // extra x hours x (extra_bartender_hourly 40 + gratuityPerHour 25 for <75)
  // = 1 x 1 x 65 = $65, plus the $100 base extra hour.
  const id = await mkProposal({ packageId: flatPkgId, guests: 50, numBartenders: 2 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 16500);
});

test('at 100 guests the same two-bartender shape has no surcharge: $140', async () => {
  const id = await mkProposal({ packageId: flatPkgId, guests: 100, numBartenders: 2 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 14000);
});

test('hosted per-guest: 100 guests x $5 x 1h = $500', async () => {
  const id = await mkProposal({ packageId: hostedPkgId, guests: 100, totalPrice: 1800 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 50000);
  assert.equal(r.isHosted, true);
});

test('a negotiated override does not swallow the delta', async () => {
  // Sold at $400 against a $350 catalog. The delta must still be the catalog
  // $100/hr, not $0 (which is what differencing .total with the override on
  // would produce).
  const id = await mkProposal({ packageId: flatPkgId, override: 400, totalPrice: 400 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 10000);
});

test('refuses a requested end at or before the contracted end', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 })).reason, 'not_an_extension');
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 3.5 })).reason, 'not_an_extension');
});

test('refuses beyond the 3 hour cap and refuses non-30-minute increments', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 + MAX_EXTENSION_HOURS + 0.5 })).reason, 'over_cap');
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.25 })).reason, 'bad_increment');
});

test('never mutates the proposal', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  const r = await pool.query(
    'SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [id]
  );
  assert.equal(Number(r.rows[0].event_duration_hours), 4);
  assert.equal(Number(r.rows[0].total_price), 350);
  assert.equal(r.rows[0].status, 'deposit_paid');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionPricing.test.js`
Expected: FAIL, `Cannot find module './serviceExtensionPricing'`.

- [ ] **Step 3: Write the implementation**

Create `server/utils/serviceExtensionPricing.js`:

```javascript
'use strict';

/**
 * Price an on-site service extension as the pricing engine's delta.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 6.
 *
 * Discipline copied from foldExtrasIntoProposal: both legs price at CATALOG
 * (totalPriceOverride: null) and we difference the SERVICE portion, never
 * `.total`. A total_price_override is a service-level contract that the engine
 * substitutes for the calculated total, so differencing `.total` with an
 * override present collapses the service delta to zero (many Core Reaction
 * bookings are sold at $400 against a $350 catalog).
 *
 * The two legs differ ONLY in durationHours, so every component with no
 * duration term cancels exactly. calculateSyrupCost(selections, guestCount)
 * has no duration term, so syrups cancel and both legs pass []. Add-ons do NOT
 * cancel (per_guest_timed and per_hour carry duration terms), so the real
 * proposal_addons rows are loaded.
 *
 * READ-ONLY. This function never writes. The caller persists.
 */

const { calculateProposal, isHostedPackage } = require('./pricingEngine');
const { loadRepriceAddons } = require('./proposalExtrasFold');
const { eventEndInstantForDuration } = require('./eventEndInstant');

// Cap on how far a single request may extend, in hours. A mis-scroll must not
// be able to invoice a client for a second event.
const MAX_EXTENSION_HOURS = 3;

// Requests move in 30-minute steps (spec section 3 decision 5).
const INCREMENT_HOURS = 0.5;

/** Dollars-to-cents, matching invoiceShared.toCents rounding. */
function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

/**
 * The service portion of an engine result, in dollars. The engine layers the
 * client-gratuity line on top of serviceTotal, so stripping gratuity.total is
 * how we isolate service (the fold's `serviceOf`).
 */
function serviceOf(snapshot) {
  return Math.round((snapshot.total - (snapshot.gratuity?.total || 0)) * 100) / 100;
}

function gratuityOf(snapshot) {
  return Math.round((snapshot.gratuity?.total || 0) * 100) / 100;
}

async function computeExtensionDelta({ client, proposalId, requestedDurationHours }) {
  const propRes = await client.query(
    `SELECT id, package_id, guest_count, event_duration_hours, num_bars, num_bartenders,
            gratuity_rate, tip_jar, adjustments, total_price_override
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal) return { ok: false, reason: 'missing_proposal' };
  if (!proposal.package_id || !proposal.event_duration_hours || !proposal.guest_count) {
    return { ok: false, reason: 'missing_package' };
  }

  const pkgRes = await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id]);
  const pkg = pkgRes.rows[0];
  if (!pkg) return { ok: false, reason: 'missing_package' };

  const contracted = Number(proposal.event_duration_hours);
  const requested = Number(requestedDurationHours);
  if (!Number.isFinite(requested) || requested <= contracted) {
    return { ok: false, reason: 'not_an_extension' };
  }
  const added = Math.round((requested - contracted) * 100) / 100;
  if (added > MAX_EXTENSION_HOURS) return { ok: false, reason: 'over_cap' };
  // Integer number of 30-minute steps, tolerant of float noise.
  const steps = added / INCREMENT_HOURS;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return { ok: false, reason: 'bad_increment' };

  const contractedEnd = await eventEndInstantForDuration(client, proposalId, contracted);
  const requestedEnd = await eventEndInstantForDuration(client, proposalId, requested);
  if (!contractedEnd || !requestedEnd) return { ok: false, reason: 'unparseable_time' };

  const addons = await loadRepriceAddons(client, proposalId);

  // Identical on both legs. Only durationHours moves.
  const common = {
    pkg,
    guestCount: proposal.guest_count,
    numBars: proposal.num_bars,
    numBartenders: proposal.num_bartenders,
    addons,
    syrupSelections: [], // no duration term, cancels across the legs
    adjustments: proposal.adjustments || [],
    totalPriceOverride: null, // price the delta at CATALOG
    gratuityRate: proposal.gratuity_rate,
    tipJar: proposal.tip_jar,
  };

  const before = calculateProposal({ ...common, durationHours: contracted });
  const after = calculateProposal({ ...common, durationHours: requested });

  const serviceDeltaCents = toCents(serviceOf(after) - serviceOf(before));
  const gratuityDeltaCents = toCents(gratuityOf(after) - gratuityOf(before));

  return {
    ok: true,
    contractedDurationHours: contracted,
    requestedDurationHours: requested,
    contractedEndDisplay: contractedEnd.endDisplay,
    requestedEndDisplay: requestedEnd.endDisplay,
    contractedEndInstant: contractedEnd.endInstant,
    serviceDeltaCents,
    gratuityDeltaCents,
    amountCents: serviceDeltaCents + gratuityDeltaCents,
    isHosted: isHostedPackage(pkg),
  };
}

module.exports = { computeExtensionDelta, MAX_EXTENSION_HOURS, INCREMENT_HOURS };
```

- [ ] **Step 4: Confirm `isHostedPackage` and `loadRepriceAddons` are actually exported**

Run:
```bash
node -e "
const e=require('/home/drbartender/projects/os/server/utils/pricingEngine');
const f=require('/home/drbartender/projects/os/server/utils/proposalExtrasFold');
console.log('isHostedPackage:',typeof e.isHostedPackage,'calculateProposal:',typeof e.calculateProposal,'loadRepriceAddons:',typeof f.loadRepriceAddons);
"
```
Expected: all three `function`. If `isHostedPackage` is not exported, add it to `pricingEngine.js`'s `module.exports` (it is an existing internal helper; exporting it is additive and safe) and note the export in the commit.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionPricing.test.js`
Expected: PASS, 10 tests.

If the 50-guest surcharge case returns $140 instead of $165, the `num_bartenders` override is not reaching `calculateStaffing`. Re-read `calculateStaffing(pkg, guestCount, durationHours, numBartendersOverride)` and confirm the column is `proposals.num_bartenders`; a NULL there means `actual = required` and there is no extra bartender at all, which would make the test's premise wrong rather than the code.

- [ ] **Step 6: Commit**

```bash
git add server/utils/serviceExtensionPricing.js server/utils/serviceExtensionPricing.test.js
git commit -m "feat(ext): engine-delta pricing for a service extension

Both legs at catalog, difference the service portion (the fold's discipline so
a negotiated override cannot swallow the delta), gratuity delta tracked
separately because payroll consumes it."
```

- [ ] **Step 7: Checkpoint review**

Dispatch `code-review` on this task's diff. Focus: the cents rounding, the override handling, and whether any duration-bearing component was missed.

### Task 5: The settle core

One function, three callers (paid webhook, zero-delta acceptance, admin override). It claims the pending row, moves the duration, syncs the linked shift, and logs. It does NOT send messages and does NOT touch payroll: those are sequenced by the caller so a Twilio or payroll hiccup can never roll back a settled payment.

The claim is the race gate. Settle, expiry, override, and cancel all claim with `WHERE status = 'pending'` and act only when `rowCount === 1`, so exactly one of them wins. That is also a second idempotency wall behind the webhook's `isFirstDelivery`.

`addHoursToTime` is deliberately not used: it is not exported and it needs 24-hour input, while `proposals.event_start_time` is free text like `8:00 PM`. The new `end_time` display string is derived in SQL instead. Verified 2026-07-26 that `to_char(..., 'FMHH12:MI AM')` reproduces `addHoursToTime`'s exact format (`11:00 PM`, `12:30 AM`, `9:30 AM`, `12:00 AM`), so nothing downstream sees a format change.

**Files:**
- Create: `server/utils/serviceExtensionSettle.js`
- Test: `server/utils/serviceExtensionSettle.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime (it reads the `service_extensions` row Task 2 created).
- Produces:
  - `settleExtension({ client, extensionId, outcome, actorUserId, overrideReason })` → `Promise<Result>`
    - `outcome` is `'paid'` or `'overridden'`.
    - `Result` on success: `{ ok: true, proposalId, shiftId, staffUserIds: number[], newDurationHours, previousDurationHours, newEndDisplay, multiShift: boolean, gratuityCents, outcome }`
    - `Result` on a lost claim: `{ ok: false, reason: 'not_pending' }`
  - `closeExtension({ client, extensionId, outcome, actorUserId, overrideReason })` → same claim discipline for the non-settling outcomes `'expired'` and `'cancelled'`; returns `{ ok: true, proposalId, shiftId, staffUserIds, invoiceId, outcome }` or `{ ok: false, reason: 'not_pending' }`. No duration change.

- [ ] **Step 1: Write the failing test**

Create `server/utils/serviceExtensionSettle.test.js`:

```javascript
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { settleExtension, closeExtension } = require('./serviceExtensionSettle');

const NONCE = `sxs-${Date.now()}`;
let clientId, pkgId, staffAId, staffBId;
const proposals = [];
const shifts = [];
const extensions = [];

async function mkEvent({ hours = 4, shiftCount = 1 } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot)
     VALUES ($1,$2,'balance_paid',100,$3,1,350,350,'2026-09-12','8:00 PM','America/Chicago','{}')
     RETURNING id`,
    [clientId, pkgId, hours]
  );
  const proposalId = p.rows[0].id;
  proposals.push(proposalId);

  const madeShifts = [];
  for (let i = 0; i < shiftCount; i++) {
    const s = await pool.query(
      `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id,
                           event_duration_hours, positions_needed, client_name)
       VALUES ('2026-09-12','8:00 PM','12:00 AM','open',$1,$2,'["Bartender"]',$3)
       RETURNING id`,
      [proposalId, hours, `${NONCE} client`]
    );
    madeShifts.push(s.rows[0].id);
    shifts.push(s.rows[0].id);
  }
  return { proposalId, shiftId: madeShifts[0], allShiftIds: madeShifts };
}

async function assign(shiftId, userId) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1,$2,'approved','Bartender')`,
    [shiftId, userId]
  );
}

async function mkExtension({ proposalId, shiftId, requested = 4.5, contracted = 4, status = 'pending', gratuityCents = 0 }) {
  const r = await pool.query(
    `INSERT INTO service_extensions
       (proposal_id, shift_id, requested_by_user_id, contracted_duration_hours,
        requested_duration_hours, contracted_end_time, requested_end_time,
        amount_cents, gratuity_cents, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,'12:00 AM','12:30 AM',5000,$6,$7, NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [proposalId, shiftId, staffAId, contracted, requested, gratuityCents, status]
  );
  extensions.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query("SELECT id FROM service_packages WHERE pricing_type='flat' AND is_active=true LIMIT 1");
  pkgId = p.rows[0].id;
  const a = await pool.query(
    "INSERT INTO users (email, password, name, role, onboarding_status) VALUES ($1,'x',$2,'staff','approved') RETURNING id",
    [`${NONCE}-a@example.test`, `${NONCE} A`]
  );
  staffAId = a.rows[0].id;
  const b = await pool.query(
    "INSERT INTO users (email, password, name, role, onboarding_status) VALUES ($1,'x',$2,'staff','approved') RETURNING id",
    [`${NONCE}-b@example.test`, `${NONCE} B`]
  );
  staffBId = b.rows[0].id;
});

after(async () => {
  if (extensions.length) await pool.query('DELETE FROM service_extensions WHERE id = ANY($1)', [extensions]);
  if (shifts.length) await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1)', [shifts]);
  if (shifts.length) await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [shifts]);
  if (proposals.length) await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [proposals]);
  if (proposals.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [proposals]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[staffAId, staffBId]]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('paid settle bumps duration, syncs the shift, returns every assigned staffer', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  await assign(ev.shiftId, staffBId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId, gratuityCents: 2500 });

  const r = await settleExtension({ client: pool, extensionId: extId, outcome: 'paid' });
  assert.equal(r.ok, true);
  assert.equal(r.newDurationHours, 4.5);
  assert.equal(r.previousDurationHours, 4);
  assert.equal(r.newEndDisplay, '12:30 AM');
  assert.equal(r.gratuityCents, 2500);
  assert.deepEqual(r.staffUserIds.slice().sort((x, y) => x - y), [staffAId, staffBId].sort((x, y) => x - y));

  const prop = await pool.query(
    'SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [ev.proposalId]
  );
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
  // Side money: nothing else about the contract moved.
  assert.equal(Number(prop.rows[0].total_price), 350);
  assert.equal(Number(prop.rows[0].amount_paid), 350);
  assert.equal(prop.rows[0].status, 'balance_paid');

  const sh = await pool.query('SELECT event_duration_hours, end_time FROM shifts WHERE id = $1', [ev.shiftId]);
  assert.equal(Number(sh.rows[0].event_duration_hours), 4.5);
  assert.equal(sh.rows[0].end_time, '12:30 AM');

  const ext = await pool.query('SELECT status FROM service_extensions WHERE id = $1', [extId]);
  assert.equal(ext.rows[0].status, 'paid');

  const log = await pool.query(
    "SELECT action FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'extension_paid'",
    [ev.proposalId]
  );
  assert.equal(log.rowCount, 1);
});

test('a second settle on the same row loses the claim and changes nothing', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  assert.equal((await settleExtension({ client: pool, extensionId: extId, outcome: 'paid' })).ok, true);
  const second = await settleExtension({ client: pool, extensionId: extId, outcome: 'paid' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'not_pending');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5, 'must not double-bump');
});

test('override settles the same way and records who and why', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  const r = await settleExtension({
    client: pool, extensionId: extId, outcome: 'overridden',
    actorUserId: staffBId, overrideReason: 'link never arrived',
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'overridden');

  const ext = await pool.query(
    'SELECT status, override_by_user_id, override_reason FROM service_extensions WHERE id = $1',
    [extId]
  );
  assert.equal(ext.rows[0].status, 'overridden');
  assert.equal(ext.rows[0].override_by_user_id, staffBId);
  assert.equal(ext.rows[0].override_reason, 'link never arrived');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
});

test('a multi-shift event bumps the proposal but flags rather than guessing which shift', async () => {
  const ev = await mkEvent({ shiftCount: 2 });
  await assign(ev.allShiftIds[0], staffAId);
  await assign(ev.allShiftIds[1], staffBId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.allShiftIds[0] });

  const r = await settleExtension({ client: pool, extensionId: extId, outcome: 'paid' });
  assert.equal(r.ok, true);
  assert.equal(r.multiShift, true);

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4.5);
  // Neither shift was rewritten: the admin resolves a multi-shift event by hand.
  const sh = await pool.query('SELECT end_time FROM shifts WHERE proposal_id = $1', [ev.proposalId]);
  for (const row of sh.rows) assert.equal(row.end_time, '12:00 AM');
});

test('closeExtension expires without touching duration, and only once', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  const r = await closeExtension({ client: pool, extensionId: extId, outcome: 'expired' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.staffUserIds, [staffAId]);

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4, 'expiry must not extend');

  assert.equal((await closeExtension({ client: pool, extensionId: extId, outcome: 'expired' })).ok, false);
});

test('a settle cannot win after an expiry claimed the row', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });

  assert.equal((await closeExtension({ client: pool, extensionId: extId, outcome: 'expired' })).ok, true);
  const late = await settleExtension({ client: pool, extensionId: extId, outcome: 'paid' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'not_pending');

  const prop = await pool.query('SELECT event_duration_hours FROM proposals WHERE id = $1', [ev.proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4);
});

test('a dropped staffer is not notified', async () => {
  const ev = await mkEvent();
  await assign(ev.shiftId, staffAId);
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position, dropped_at) VALUES ($1,$2,'approved','Bartender',NOW())",
    [ev.shiftId, staffBId]
  );
  const extId = await mkExtension({ proposalId: ev.proposalId, shiftId: ev.shiftId });
  const r = await settleExtension({ client: pool, extensionId: extId, outcome: 'paid' });
  assert.deepEqual(r.staffUserIds, [staffAId]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionSettle.test.js`
Expected: FAIL, `Cannot find module './serviceExtensionSettle'`.

- [ ] **Step 3: Write the implementation**

Create `server/utils/serviceExtensionSettle.js`:

```javascript
'use strict';

/**
 * Settle or close a service extension.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 7.
 *
 * settleExtension is the ONE place the contract changes, and the only column it
 * moves is proposals.event_duration_hours (plus the linked shift's denormalized
 * duration and end_time). total_price, pricing_snapshot, amount_paid, and
 * status are NEVER touched: extension money is side money and rides the
 * off-ledger invoice label instead (D12).
 *
 * The claim UPDATE (... WHERE status = 'pending') is the race gate shared by
 * settle, expiry, override, and cancel: exactly one wins, and a replayed
 * webhook cannot double-bump the duration.
 *
 * Deliberately does NOT send messages or touch payroll. The caller sequences
 * those AFTER this returns, so a Twilio or payroll failure can never roll back
 * a settled payment. Deliberately does NOT call syncShiftsFromProposal: that
 * full sync also rewrites location, setup minutes, and the staffing roster,
 * none of which should move mid-event, and it no-ops on multi-shift events.
 *
 * addHoursToTime is not used (not exported, and it needs 24-hour input while
 * event_start_time is free text like "8:00 PM"). The display string is derived
 * in SQL; to_char(..., 'FMHH12:MI AM') reproduces addHoursToTime's exact format
 * (verified 2026-07-26: 11:00 PM, 12:30 AM, 9:30 AM, 12:00 AM).
 */

const SETTLE_OUTCOMES = new Set(['paid', 'overridden']);
const CLOSE_OUTCOMES = new Set(['expired', 'cancelled']);

const ACTION_BY_OUTCOME = Object.freeze({
  paid: 'extension_paid',
  overridden: 'extension_overridden',
  expired: 'extension_expired',
  cancelled: 'extension_cancelled',
});

/** Every staffer still on the event's roster, so a two-bartender job tells both. */
async function assignedStaffUserIds(client, proposalId) {
  const { rows } = await client.query(
    `SELECT DISTINCT sr.user_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL`,
    [proposalId]
  );
  return rows.map((r) => r.user_id);
}

/** Claim the row for one outcome. Returns the row, or null when someone else won. */
async function claim(client, extensionId, outcome, actorUserId, overrideReason) {
  const { rows } = await client.query(
    `UPDATE service_extensions
        SET status = $2,
            override_by_user_id = COALESCE($3, override_by_user_id),
            override_reason = COALESCE($4, override_reason),
            updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING id, proposal_id, shift_id, invoice_id, gratuity_cents, amount_cents,
                contracted_duration_hours, requested_duration_hours`,
    [
      extensionId,
      outcome,
      Number.isInteger(actorUserId) ? actorUserId : null,
      overrideReason || null,
    ]
  );
  return rows[0] || null;
}

async function logAction(client, proposalId, outcome, details) {
  await client.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, $2, 'system', $3::jsonb)`,
    [proposalId, ACTION_BY_OUTCOME[outcome], JSON.stringify(details || {})]
  );
}

async function settleExtension({ client, extensionId, outcome, actorUserId = null, overrideReason = null }) {
  if (!SETTLE_OUTCOMES.has(outcome)) {
    throw new Error(`settleExtension: invalid outcome '${outcome}'`);
  }

  const row = await claim(client, extensionId, outcome, actorUserId, overrideReason);
  if (!row) return { ok: false, reason: 'not_pending' };

  const proposalId = row.proposal_id;
  const newDuration = Number(row.requested_duration_hours);
  const previousDuration = Number(row.contracted_duration_hours);

  // The ONE contract mutation.
  const { rows: durRows } = await client.query(
    `UPDATE proposals
        SET event_duration_hours = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING (((event_date::text || ' ' || event_start_time)::timestamp
                   + ($2::numeric * INTERVAL '1 hour'))) AS new_end_ts,
                to_char(((event_date::text || ' ' || event_start_time)::timestamp
                   + ($2::numeric * INTERVAL '1 hour')), 'FMHH12:MI AM') AS new_end_display`,
    [proposalId, newDuration]
  );
  const newEndDisplay = durRows[0] ? durRows[0].new_end_display : null;

  // Targeted shift sync, only when the event has exactly one shift row (the
  // same guard syncShiftsFromProposal uses). A multi-shift event is flagged for
  // the admin instead of guessing which shift the extra time belongs to.
  const { rows: countRows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1',
    [proposalId]
  );
  const shiftCount = countRows[0] ? countRows[0].n : 0;
  const multiShift = shiftCount !== 1;

  if (!multiShift) {
    await client.query(
      `UPDATE shifts
          SET event_duration_hours = $2,
              end_time = COALESCE($3, end_time)
        WHERE proposal_id = $1`,
      [proposalId, newDuration, newEndDisplay]
    );
  }

  const staffUserIds = await assignedStaffUserIds(client, proposalId);

  await logAction(client, proposalId, outcome, {
    extension_id: row.id,
    previous_duration_hours: previousDuration,
    new_duration_hours: newDuration,
    new_end: newEndDisplay,
    amount_cents: row.amount_cents,
    gratuity_cents: row.gratuity_cents,
    multi_shift: multiShift,
    override_by_user_id: outcome === 'overridden' ? actorUserId : undefined,
  });

  return {
    ok: true,
    outcome,
    proposalId,
    shiftId: row.shift_id,
    invoiceId: row.invoice_id,
    staffUserIds,
    previousDurationHours: previousDuration,
    newDurationHours: newDuration,
    newEndDisplay,
    multiShift,
    gratuityCents: Number(row.gratuity_cents) || 0,
    amountCents: Number(row.amount_cents) || 0,
  };
}

async function closeExtension({ client, extensionId, outcome, actorUserId = null, overrideReason = null }) {
  if (!CLOSE_OUTCOMES.has(outcome)) {
    throw new Error(`closeExtension: invalid outcome '${outcome}'`);
  }
  const row = await claim(client, extensionId, outcome, actorUserId, overrideReason);
  if (!row) return { ok: false, reason: 'not_pending' };

  const staffUserIds = await assignedStaffUserIds(client, row.proposal_id);
  await logAction(client, row.proposal_id, outcome, {
    extension_id: row.id,
    requested_duration_hours: Number(row.requested_duration_hours),
    amount_cents: row.amount_cents,
  });

  return {
    ok: true,
    outcome,
    proposalId: row.proposal_id,
    shiftId: row.shift_id,
    invoiceId: row.invoice_id,
    staffUserIds,
  };
}

module.exports = { settleExtension, closeExtension, ACTION_BY_OUTCOME };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionSettle.test.js`
Expected: PASS, 7 tests.

If the `users` insert in the fixture fails on a NOT NULL column, run `grep -n "CREATE TABLE IF NOT EXISTS users" -A20 server/db/schema.sql` and add the required columns to the fixture. Do not change the module to accommodate a fixture problem.

- [ ] **Step 5: Register the money-path smoke suites**

The pre-push money gate reads a list file. Add the three new money suites so they run against the isolated Neon branch.

Run: `cat scripts/money-smoke-list.txt`

Append these lines (match the file's existing path style exactly):
```
server/utils/serviceExtensionPricing.test.js
server/utils/serviceExtensionSettle.test.js
server/utils/eventEndInstant.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server/utils/serviceExtensionSettle.js server/utils/serviceExtensionSettle.test.js scripts/money-smoke-list.txt
git commit -m "feat(ext): settle/close core with a single-winner claim gate

Duration is the only contract column that moves. Claim-on-pending is the race
gate shared by settle, expiry, override and cancel, and a second idempotency
wall behind the webhook's isFirstDelivery."
```

- [ ] **Step 7: Lane gate**

`ext-core` is complete. Run all four suites in this lane one at a time, then dispatch the full review fleet declared in the front-matter before merging.

```bash
for f in server/utils/eventEndInstant.test.js server/utils/serviceExtensionPricing.test.js server/utils/serviceExtensionSettle.test.js; do
  echo "=== $f"; node --env-file=/home/drbartender/projects/os/.env --test "$f" || break
done
```
Expected: all PASS. Plus every suite identified in Task 2 Step 4 still passing.

---

## Lane ext-routes

The three HTTP surfaces (staff request, public accept, admin override/cancel), the notification module they share, the acceptance gate on the existing intent route, and the invoice GET additions.

### Task 6: Notification module

All outbound messaging for the feature, in one place. Three audiences: the client (payment link), the assigned staffers (greenlight or decline), and the admins (request went out, plus the failure shapes).

**Why direct sends and not `enqueueCategorizedMessage`:** the categorized-message path is the house pattern for staff notifications, but its dispatcher runs on a 5-minute interval (`server/index.js`, `RUN_MESSAGE_DISPATCHER_SCHEDULER`). A bartender standing at a bar deciding whether to keep pouring cannot wait 5 minutes for a greenlight, and the decline is the message carrying the insurance warning. So this module sends immediately and owns its own channel gate. That gate must still honor everything the queued path honors: `agreements.sms_consent` for staff (the `messages.js` rule), `users.communication_preferences` opt-outs, and `clients.communication_preferences` plus contact-status for clients via `shouldSendImmediate`.

**Files:**
- Create: `server/utils/serviceExtensionNotify.js`

**Interfaces:**
- Consumes: `renderExtensionTerms` (Task 3).
- Produces:
  - `notifyClientOfRequest({ proposalId, invoiceToken, amountCents, newEndDisplay, termsVersion })` → `Promise<{ sms: 'sent'|'skipped', email: 'sent'|'skipped', reachable: boolean }>`
  - `notifyStaffOfOutcome({ staffUserIds, outcome, newEndDisplay, contractedEndDisplay, proposalId })` → `Promise<{ notified: number[], unreachable: number[] }>`; `outcome` is `'approved' | 'declined'`
  - `alertAdminsRequestSent({ proposalId, newEndDisplay, amountCents, requesterUserId, clientReachable })` → `Promise<void>`
  - `alertAdminsProblem({ proposalId, kind, detail })` → `Promise<void>`; `kind` in `'client_unreachable' | 'multi_shift' | 'paid_after_expiry' | 'settle_on_closed_event' | 'staff_unreachable' | 'payroll_hours_locked'`

- [ ] **Step 1: Confirm the copy constants and the consent columns exist**

Run:
```bash
grep -n "sms_consent" server/db/schema.sql | head -3
grep -n "PUBLIC_SITE_URL\|ADMIN_URL" server/utils/urls.js
```
Expected: `agreements.sms_consent` exists; `urls.js` exports both. The client invoice link is built from `PUBLIC_SITE_URL` (client-facing token URLs), matching how invoice links are already sent.

Run: `grep -rn "invoice/\${" server/utils/*.js | head -5` to copy the exact existing invoice-link shape rather than inventing a path.

- [ ] **Step 2: Write the module**

Create `server/utils/serviceExtensionNotify.js`:

```javascript
'use strict';

/**
 * Every outbound message for an on-site service extension.
 *
 * Spec: docs/superpowers/specs/2026-07-25-service-extension-design.md section 10.
 *
 * Sends are IMMEDIATE and direct, not queued through
 * enqueueCategorizedMessage, because that path's dispatcher runs every 5
 * minutes and a bartender waiting to know whether to keep pouring cannot wait
 * that long. The trade is that this module owns its own channel gate, which
 * must honor exactly what the queued path honors:
 *   - staff: agreements.sms_consent (the messages.js rule) + users.communication_preferences
 *   - client: shouldSendImmediate (comm prefs + bad-contact + archived)
 *
 * NEVER call this inside a transaction. Every send helper takes its own pooled
 * connection, so holding one here would deadlock the pool under load
 * (CLAUDE.md one-pooled-connection rule). Callers release first, then notify.
 *
 * Copy rule: no em dashes anywhere in this file's message strings.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { sendAndLogSms } = require('./sms');
const { shouldSendImmediate } = require('./messageSuppression');
const { notifyAdminCategory } = require('./adminNotifications');
const { renderExtensionTerms } = require('../data/extensionTermsCopy');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('./urls');

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2).replace(/\.00$/, '')}`;
}

/** Never let a notification failure escape into a money path. */
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'service-extension', notify: label } });
    }
    console.error(`[serviceExtensionNotify] ${label} failed (non-blocking):`, err.message);
    return null;
  }
}

// ─── Client ────────────────────────────────────────────────────────────────

async function notifyClientOfRequest({ proposalId, invoiceToken, amountCents, newEndDisplay, termsVersion }) {
  const { rows } = await pool.query(
    `SELECT p.status,
            c.id AS client_id, c.name, c.email, c.phone,
            c.communication_preferences, c.email_status, c.phone_status
       FROM proposals p JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  if (!rows[0]) return { sms: 'skipped', email: 'skipped', reachable: false };
  const row = rows[0];
  const proposal = { status: row.status };
  const client = {
    communication_preferences: row.communication_preferences,
    email_status: row.email_status,
    phone_status: row.phone_status,
  };

  const link = `${PUBLIC_SITE_URL}/invoice/${invoiceToken}`;
  const terms = renderExtensionTerms({ version: termsVersion, newEndDisplay });
  const priced = Number(amountCents) > 0 ? ` (${money(amountCents)})` : ' (included in your package)';

  let smsResult = 'skipped';
  const smsGate = await shouldSendImmediate({ proposal, client, channel: 'sms' });
  if (smsGate.ok && row.phone) {
    const sent = await safe('client_sms', () => sendAndLogSms({
      to: row.phone,
      body: `Dr. Bartender: your bartender asked to extend bar service to ${newEndDisplay}${priced}. Review and confirm here: ${link}`,
      clientId: row.client_id,
      proposalId,
      messageType: 'service_extension_request',
      recipientName: row.name || null,
    }));
    if (sent && sent.status !== 'skipped') smsResult = 'sent';
  }

  let emailResult = 'skipped';
  const emailGate = await shouldSendImmediate({ proposal, client, channel: 'email' });
  if (emailGate.ok && row.email) {
    const paragraphs = terms.paragraphs.map((t) => `<p>${t}</p>`).join('');
    const sent = await safe('client_email', () => sendEmail({
      to: row.email,
      subject: `Extend bar service to ${newEndDisplay}?`,
      html: `<h2>${terms.headline}</h2>${paragraphs}
             <p><strong>${Number(amountCents) > 0 ? money(amountCents) : 'No additional charge'}</strong></p>
             <p><a href="${link}">Review and confirm</a></p>`,
      text: [terms.headline, ...terms.paragraphs,
        Number(amountCents) > 0 ? money(amountCents) : 'No additional charge',
        `Review and confirm: ${link}`].join('\n\n'),
      meta: { proposalId, messageType: 'service_extension_request' },
    }));
    if (sent) emailResult = 'sent';
  }

  return {
    sms: smsResult,
    email: emailResult,
    reachable: smsResult === 'sent' || emailResult === 'sent',
  };
}

// ─── Staff ─────────────────────────────────────────────────────────────────

const STAFF_COPY = Object.freeze({
  approved: ({ newEndDisplay }) =>
    `Dr. Bartender: approved. Bar service now runs to ${newEndDisplay}. Your hours are updated, nothing else to do.`,
  declined: ({ contractedEndDisplay }) =>
    `Dr. Bartender: additional time was not approved. Bar service ends at ${contractedEndDisplay} as contracted. Serving past that is not DRB work and is not covered by DRB insurance. Do not accept payment from the client directly.`,
});

async function notifyStaffOfOutcome({ staffUserIds, outcome, newEndDisplay, contractedEndDisplay, proposalId }) {
  const ids = (staffUserIds || []).filter(Number.isInteger);
  if (ids.length === 0) return { notified: [], unreachable: [] };
  if (!STAFF_COPY[outcome]) throw new Error(`notifyStaffOfOutcome: invalid outcome '${outcome}'`);

  const body = STAFF_COPY[outcome]({ newEndDisplay, contractedEndDisplay });
  const subject = outcome === 'approved'
    ? `Bar service extended to ${newEndDisplay}`
    : 'Additional time was not approved';

  // sms_consent is the staff SMS gate (messages.js). LEFT JOIN so a staffer
  // with no agreements row is email-only rather than silently dropped.
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.communication_preferences AS prefs,
            cp.phone, COALESCE(ag.sms_consent, false) AS sms_consent
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
       LEFT JOIN agreements ag ON ag.user_id = u.id
      WHERE u.id = ANY($1)`,
    [ids]
  );

  const notified = [];
  const unreachable = [];

  for (const r of rows) {
    const prefs = r.prefs || {};
    let delivered = false;

    if (r.sms_consent && prefs.sms_enabled !== false && r.phone) {
      const sent = await safe(`staff_sms_${r.id}`, () => sendAndLogSms({
        to: r.phone,
        body,
        clientId: null,
        proposalId,
        messageType: `service_extension_${outcome}`,
      }));
      if (sent && sent.status !== 'skipped') delivered = true;
    }

    if (prefs.email_enabled !== false && r.email) {
      const sent = await safe(`staff_email_${r.id}`, () => sendEmail({
        to: r.email,
        subject,
        html: `<p>${body}</p>`,
        text: body,
        meta: { proposalId, messageType: `service_extension_${outcome}` },
      }));
      if (sent) delivered = true;
    }

    if (delivered) notified.push(r.id);
    else unreachable.push(r.id);
  }

  // A staffer who got neither message is a real problem for the DECLINE case:
  // that message carries the insurance warning and must not vanish silently.
  if (unreachable.length > 0) {
    await alertAdminsProblem({
      proposalId,
      kind: 'staff_unreachable',
      detail: `No channel reached staff user id(s) ${unreachable.join(', ')} for the "${outcome}" message. Contact them directly.`,
    });
  }

  return { notified, unreachable };
}

// ─── Admin ─────────────────────────────────────────────────────────────────

async function alertAdminsRequestSent({ proposalId, newEndDisplay, amountCents, requesterUserId, clientReachable }) {
  await safe('admin_request_sent', async () => {
    const reach = clientReachable ? '' : ' The client could not be reached on any channel, so you may need to relay the link.';
    const line = `A bartender asked to extend event #${proposalId} to ${newEndDisplay} for ${money(amountCents)}. The client has been sent the confirmation link.${reach}`;
    await notifyAdminCategory({
      category: 'routine_admin',
      subject: `Extension requested: event #${proposalId} to ${newEndDisplay}`,
      emailHtml: `<p>${line}</p><p>Requested by staff user id ${requesterUserId}.</p>
                  <p><a href="${ADMIN_URL}/events/${proposalId}">Open the event</a></p>`,
      emailText: `${line} Requested by staff user id ${requesterUserId}. ${ADMIN_URL}/events/${proposalId}`,
    });
  });
}

const PROBLEM_SUBJECTS = Object.freeze({
  client_unreachable: 'Extension link could not be delivered',
  multi_shift: 'Extension on a multi-shift event needs a manual shift edit',
  paid_after_expiry: 'An extension was paid after it expired: refund needed',
  settle_on_closed_event: 'An extension settled on a completed or archived event',
  staff_unreachable: 'Could not reach a staffer with an extension outcome',
  payroll_hours_locked: 'Extension hours could not be added to payroll automatically',
});

async function alertAdminsProblem({ proposalId, kind, detail }) {
  await safe(`admin_problem_${kind}`, async () => {
    const subject = PROBLEM_SUBJECTS[kind] || 'Service extension needs attention';
    const line = `Event #${proposalId}: ${detail}`;
    await notifyAdminCategory({
      // paid_after_expiry means DRB is holding money it should not: urgent.
      category: kind === 'paid_after_expiry' ? 'urgent_client_reply' : 'routine_admin',
      subject: `${subject} (event #${proposalId})`,
      emailHtml: `<p>${line}</p><p><a href="${ADMIN_URL}/events/${proposalId}">Open the event</a></p>`,
      emailText: `${line} ${ADMIN_URL}/events/${proposalId}`,
      ...(kind === 'paid_after_expiry' ? { smsBody: line } : {}),
    });
  });
}

module.exports = {
  notifyClientOfRequest,
  notifyStaffOfOutcome,
  alertAdminsRequestSent,
  alertAdminsProblem,
  STAFF_COPY,
};
```

- [ ] **Step 3: Verify the imports resolve and the copy rule holds**

Run:
```bash
node -e "
const m=require('/home/drbartender/projects/os/server/utils/serviceExtensionNotify');
console.log(Object.keys(m).join(','));
const a=m.STAFF_COPY.approved({newEndDisplay:'11:00 PM'});
const d=m.STAFF_COPY.declined({contractedEndDisplay:'10:00 PM'});
console.log(a); console.log(d);
if((a+d).includes('—')) throw new Error('em dash in staff copy');
console.log('OK');
"
```
Expected: the five exports, both messages, `OK`. If `PUBLIC_SITE_URL` or `ADMIN_URL` is not exported from `urls.js`, run `grep -n "module.exports" -A8 server/utils/urls.js` and use the names that are actually exported.

- [ ] **Step 4: Verify `notifyAdminCategory` accepts the categories used**

Run: `node -e "console.log([...require('/home/drbartender/projects/os/server/utils/adminNotifications').VALID_CATEGORIES])"`

Expected: the list includes `routine_admin` and `urgent_client_reply`. If `urgent_client_reply` reads wrong for a money problem, pick the closest urgent category from the printed list and update `alertAdminsProblem`. Do not add a new category in this task.

- [ ] **Step 5: Commit**

```bash
git add server/utils/serviceExtensionNotify.js
git commit -m "feat(ext): service-extension notifications (client link, staff outcome, admin alerts)

Immediate direct sends rather than the categorized-message queue: the queued
dispatcher runs every 5 minutes and a bartender waiting on a greenlight cannot.
Owns its own channel gate honoring sms_consent and both prefs sets."
```

### Task 7: Staff request endpoint

The security-critical surface. `auth` alone is NOT sufficient: the known onboarding self-promotion hole means an authenticated account is not necessarily real staff on this job. Without the assignment predicate, any account could POST an arbitrary `shift_id` and fire a real SMS and a payable invoice at a real client.

**Files:**
- Create: `server/routes/serviceExtensions/create.js`
- Create: `server/routes/serviceExtensions/index.js`
- Test: `server/routes/serviceExtensions/create.test.js`

**Interfaces:**
- Consumes: `computeExtensionDelta`, `MAX_EXTENSION_HOURS` (Task 4); `CURRENT_EXTENSION_TERMS_VERSION` (Task 3); `SERVICE_EXTENSION_INVOICE_LABEL` (Task 2); `notifyClientOfRequest`, `alertAdminsRequestSent`, `alertAdminsProblem` (Task 6); `eventEndInstant` (Task 1).
- Produces:
  - `GET /api/service-extensions/eligibility/:shiftId` → `{ eligible, reason?, contractedEndDisplay, maxEndDisplay, isHosted, pending: {requestedEndTime,status}|null }`. NO price.
  - `POST /api/service-extensions` body `{ shiftId, requestedEndHours, hostedProductConfirmed }` → `201 { id, status: 'pending', requestedEndTime }`. NO price.
  - `server/routes/serviceExtensions/index.js` composition router.

- [ ] **Step 1: Write the failing test**

Create `server/routes/serviceExtensions/create.test.js`:

```javascript
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');

// Silence real sends: stub the notify module BEFORE the router requires it.
const notify = require('../../utils/serviceExtensionNotify');
notify.notifyClientOfRequest = async () => ({ sms: 'sent', email: 'sent', reachable: true });
notify.alertAdminsRequestSent = async () => {};
notify.alertAdminsProblem = async () => {};

const errorHandler = require('../../middleware/errorHandler');
const router = require('./index');

const NONCE = `sxc-${Date.now()}`;
let app, server, baseUrl;
let clientId, pkgId, onStaffId, otherStaffId, proposalId, shiftId;
const cleanup = { proposals: [], shifts: [], users: [] };

function tokenFor(userId) {
  return jwt.sign({ id: userId, role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function post(body, userId) {
  return fetch(`${baseUrl}/api/service-extensions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  app = express();
  app.use(express.json());
  app.use('/api/service-extensions', router);
  app.use(errorHandler);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const c = await pool.query('INSERT INTO clients (name, email, phone) VALUES ($1,$2,$3) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`, '3125550100']);
  clientId = c.rows[0].id;
  const p = await pool.query("SELECT id FROM service_packages WHERE pricing_type='flat' AND extra_hour_rate=100 AND is_active=true LIMIT 1");
  pkgId = p.rows[0].id;

  for (const key of ['on', 'other']) {
    const u = await pool.query(
      "INSERT INTO users (email, password, name, role, onboarding_status) VALUES ($1,'x',$2,'staff','approved') RETURNING id",
      [`${NONCE}-${key}@example.test`, `${NONCE} ${key}`]
    );
    cleanup.users.push(u.rows[0].id);
    if (key === 'on') onStaffId = u.rows[0].id; else otherStaffId = u.rows[0].id;
  }
  await pool.query(
    "INSERT INTO contractor_profiles (user_id, phone, hourly_rate) VALUES ($1,'3125550111',40)",
    [onStaffId]
  );

  // Event happening RIGHT NOW so the request window is open: start 1 hour ago,
  // 4 hour duration. event_start_time is free text, as in production.
  const now = new Date();
  const startLocal = new Date(now.getTime() - 60 * 60 * 1000);
  const hh = startLocal.getHours();
  const startDisplay = `${hh % 12 === 0 ? 12 : hh % 12}:00 ${hh >= 12 ? 'PM' : 'AM'}`;
  const dateStr = startLocal.toISOString().slice(0, 10);

  const pr = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        total_price, amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot, adjustments)
     VALUES ($1,$2,'balance_paid',100,4,1,350,350,$3,$4,'America/Chicago','{}','[]')
     RETURNING id`,
    [clientId, pkgId, dateStr, startDisplay]
  );
  proposalId = pr.rows[0].id;
  cleanup.proposals.push(proposalId);

  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, proposal_id,
                         event_duration_hours, positions_needed, client_name)
     VALUES ($1,$2,'11:00 PM','open',$3,4,'["Bartender"]',$4) RETURNING id`,
    [dateStr, startDisplay, proposalId, `${NONCE} client`]
  );
  shiftId = sh.rows[0].id;
  cleanup.shifts.push(shiftId);

  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status, position) VALUES ($1,$2,'approved','Bartender')",
    [shiftId, onStaffId]
  );
});

after(async () => {
  await pool.query('DELETE FROM service_extensions WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [cleanup.proposals]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1)', [cleanup.shifts]);
  await pool.query('DELETE FROM shifts WHERE id = ANY($1)', [cleanup.shifts]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [cleanup.proposals]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [cleanup.users]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  server.close();
  await pool.end();
});

test('rejects an unauthenticated request', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, null);
  assert.equal(res.status, 401);
});

test('rejects an authenticated staffer who is NOT assigned to this shift', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, otherStaffId);
  assert.equal(res.status, 403);
  const rows = await pool.query('SELECT COUNT(*)::int n FROM service_extensions WHERE proposal_id = $1', [proposalId]);
  assert.equal(rows.rows[0].n, 0, 'no row may be created for a non-assigned caller');
});

test('an assigned staffer creates a pending request, and the response carries NO price', async () => {
  const res = await post({ shiftId, requestedEndHours: 4.5 }, onStaffId);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.status, 'pending');
  const serialized = JSON.stringify(body);
  for (const leak of ['amount', 'cents', 'price', 'gratuity', 'total']) {
    assert.ok(!serialized.toLowerCase().includes(leak), `response leaked "${leak}": ${serialized}`);
  }

  const ext = await pool.query(
    'SELECT status, amount_cents, gratuity_cents, invoice_id, terms_version, expires_at FROM service_extensions WHERE proposal_id = $1',
    [proposalId]
  );
  assert.equal(ext.rowCount, 1);
  assert.equal(ext.rows[0].status, 'pending');
  assert.equal(ext.rows[0].amount_cents, 5000);
  assert.ok(ext.rows[0].invoice_id, 'an invoice must be minted');
  assert.ok(ext.rows[0].terms_version, 'terms version must be stamped');

  const inv = await pool.query('SELECT label, status, amount_due, token FROM invoices WHERE id = $1', [ext.rows[0].invoice_id]);
  assert.equal(inv.rows[0].label, 'Service Extension');
  assert.equal(inv.rows[0].status, 'sent', 'a draft invoice is not payable');
  assert.equal(inv.rows[0].amount_due, 5000);
  assert.ok(inv.rows[0].token);

  const li = await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1', [ext.rows[0].invoice_id]);
  assert.equal(li.rowCount, 1);
  assert.match(li.rows[0].description, /Additional bar service/);
  assert.equal(li.rows[0].line_total, 5000);

  // Side money: the contract did not move.
  const prop = await pool.query('SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(prop.rows[0].event_duration_hours), 4);
  assert.equal(Number(prop.rows[0].total_price), 350);
  assert.equal(Number(prop.rows[0].amount_paid), 350);
  assert.equal(prop.rows[0].status, 'balance_paid');
});

test('a second concurrent request collides instead of double-charging', async () => {
  const res = await post({ shiftId, requestedEndHours: 5 }, onStaffId);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(JSON.stringify(body), /already/i);
  const rows = await pool.query("SELECT COUNT(*)::int n FROM service_extensions WHERE proposal_id = $1 AND status = 'pending'", [proposalId]);
  assert.equal(rows.rows[0].n, 1);
});

test('rejects over the cap and non-30-minute increments', async () => {
  await pool.query("UPDATE service_extensions SET status = 'expired' WHERE proposal_id = $1", [proposalId]);
  assert.equal((await post({ shiftId, requestedEndHours: 8 }, onStaffId)).status, 400);
  assert.equal((await post({ shiftId, requestedEndHours: 4.25 }, onStaffId)).status, 400);
  assert.equal((await post({ shiftId, requestedEndHours: 3.5 }, onStaffId)).status, 400);
});

test('eligibility read carries the end times and no price', async () => {
  const res = await fetch(`${baseUrl}/api/service-extensions/eligibility/${shiftId}`, {
    headers: { Authorization: `Bearer ${tokenFor(onStaffId)}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.contractedEndDisplay);
  assert.ok(body.maxEndDisplay);
  const serialized = JSON.stringify(body).toLowerCase();
  for (const leak of ['amount', 'cents', 'price']) {
    assert.ok(!serialized.includes(leak), `eligibility leaked "${leak}"`);
  }
});

test('eligibility is refused for a non-assigned staffer', async () => {
  const res = await fetch(`${baseUrl}/api/service-extensions/eligibility/${shiftId}`, {
    headers: { Authorization: `Bearer ${tokenFor(otherStaffId)}` },
  });
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/create.test.js`
Expected: FAIL, cannot find `./index`.

If `require('../../middleware/errorHandler')` does not resolve, find the real path with `grep -rn "errorHandler" server/index.js | head -3` and fix the test's import. The global error middleware is what turns `AppError` subclasses into status codes, so the test needs it.

- [ ] **Step 3: Write the composition router**

Create `server/routes/serviceExtensions/index.js`:

```javascript
'use strict';

/**
 * Service-extension routes (spec 2026-07-25).
 *
 * Per-concern split behind a composition router, matching server/routes/proposals/.
 * Mounted at /api/service-extensions in server/index.js.
 *
 * Auth differs per file, so `auth` is applied inside each one rather than at
 * this router level:
 *   create.js       - staff, auth + assigned-to-this-shift predicate
 *   publicAccept.js - PUBLIC, invoice-token gated (no auth)
 *   admin.js        - auth + admin/manager
 */

const express = require('express');
const router = express.Router();

router.use('/', require('./create'));
router.use('/', require('./publicAccept'));
router.use('/', require('./admin'));

module.exports = router;
```

Note: `publicAccept.js` and `admin.js` arrive in Tasks 8 and 10. To keep this task's test runnable now, create both as one-line stubs that will be replaced:

```javascript
// server/routes/serviceExtensions/publicAccept.js  (stub, replaced in Task 8)
'use strict';
module.exports = require('express').Router();
```

```javascript
// server/routes/serviceExtensions/admin.js  (stub, replaced in Task 10)
'use strict';
module.exports = require('express').Router();
```

- [ ] **Step 4: Write the create route**

Create `server/routes/serviceExtensions/create.js`:

```javascript
'use strict';

/**
 * Staff-initiated service-extension request (spec 2026-07-25 section 5.1).
 *
 * SECURITY: `auth` alone is NOT sufficient. The onboarding self-promotion hole
 * means an authenticated account is not necessarily real staff, so every
 * endpoint here requires the same predicate the staff home uses:
 *   sr.user_id = req.user.id AND sr.shift_id = $ AND sr.status = 'approved'
 *   AND sr.dropped_at IS NULL
 * Without it, any account could POST an arbitrary shift_id and fire a real SMS
 * plus a payable invoice at a real client.
 *
 * STAFF NEVER SEE THE PRICE (spec decision 2). No response in this file may
 * contain amount_cents, gratuity_cents, or any dollar figure. Every response
 * body is built from an explicit field list, never by spreading a DB row.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, PermissionError, NotFoundError } = require('../../utils/errors');
const { createInvoice, writeLineItems } = require('../../utils/invoiceHelpers');
const { SERVICE_EXTENSION_INVOICE_LABEL } = require('../../utils/proposalMoneyShared');
const { computeExtensionDelta, MAX_EXTENSION_HOURS } = require('../../utils/serviceExtensionPricing');
const { eventEndInstantForDuration } = require('../../utils/eventEndInstant');
const { CURRENT_EXTENSION_TERMS_VERSION } = require('../../data/extensionTermsCopy');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();
router.use(auth);

// Grace after the contracted end during which a request may still be opened.
const REQUEST_GRACE_MINUTES = 15;

/**
 * Resolve the caller's assignment to this shift, or throw. Returns the shift +
 * proposal context every handler needs.
 */
async function requireAssignment(req, shiftId) {
  const { rows } = await pool.query(
    `SELECT s.id AS shift_id, s.proposal_id, s.event_date, s.start_time,
            p.event_duration_hours, p.status AS proposal_status, p.package_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN proposals p ON p.id = s.proposal_id
      WHERE sr.user_id = $1
        AND sr.shift_id = $2
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL
      LIMIT 1`,
    [req.user.id, shiftId]
  );
  if (!rows[0]) {
    // Deliberately not distinguishing "no such shift" from "not your shift":
    // a caller who is not on the job learns nothing either way.
    throw new PermissionError('You are not assigned to this event.');
  }
  return rows[0];
}

/** Window check: event start through contracted end + grace, as instants. */
async function checkWindow(ctx) {
  const end = await eventEndInstantForDuration(pool, ctx.proposal_id, Number(ctx.event_duration_hours));
  if (!end) return { ok: false, code: 'unparseable_shift_time', message: 'Could not determine this event’s start time. Contact management.' };
  const now = Date.now();
  if (now < new Date(end.startInstant).getTime()) {
    return { ok: false, code: 'too_early', message: 'You can request more time once the event has started.' };
  }
  const deadline = new Date(end.endInstant).getTime() + REQUEST_GRACE_MINUTES * 60 * 1000;
  if (now > deadline) {
    return { ok: false, code: 'too_late', message: 'The window to request more time for this event has closed.' };
  }
  return { ok: true, end };
}

/** GET /api/service-extensions/eligibility/:shiftId */
router.get('/eligibility/:shiftId', asyncHandler(async (req, res) => {
  const shiftId = Number(req.params.shiftId);
  if (!Number.isInteger(shiftId)) throw new ValidationError({ shiftId: 'Invalid shift.' });
  const ctx = await requireAssignment(req, shiftId);

  const contracted = Number(ctx.event_duration_hours);
  const [end, maxEnd, pendingRes, pkgRes] = await Promise.all([
    eventEndInstantForDuration(pool, ctx.proposal_id, contracted),
    eventEndInstantForDuration(pool, ctx.proposal_id, contracted + MAX_EXTENSION_HOURS),
    pool.query(
      `SELECT requested_end_time, status FROM service_extensions
        WHERE proposal_id = $1 AND status = 'pending' LIMIT 1`,
      [ctx.proposal_id]
    ),
    pool.query('SELECT pricing_type, bar_type FROM service_packages WHERE id = $1', [ctx.package_id]),
  ]);

  const window = await checkWindow(ctx);
  const pkg = pkgRes.rows[0] || {};

  res.json({
    eligible: window.ok && pendingRes.rowCount === 0,
    reason: !window.ok ? window.code : (pendingRes.rowCount > 0 ? 'already_pending' : null),
    contractedEndDisplay: end ? end.endDisplay : null,
    maxEndDisplay: maxEnd ? maxEnd.endDisplay : null,
    maxAdditionalHours: MAX_EXTENSION_HOURS,
    // Hosted packages need the product confirmation tick before sending.
    isHosted: pkg.pricing_type === 'per_guest',
    isClass: pkg.bar_type === 'class',
    pending: pendingRes.rows[0]
      ? { requestedEndTime: pendingRes.rows[0].requested_end_time, status: pendingRes.rows[0].status }
      : null,
  });
}));

/** POST /api/service-extensions */
router.post('/', asyncHandler(async (req, res) => {
  const shiftId = Number(req.body?.shiftId);
  const requestedEndHours = Number(req.body?.requestedEndHours);
  const hostedProductConfirmed = req.body?.hostedProductConfirmed === true;

  if (!Number.isInteger(shiftId)) throw new ValidationError({ shiftId: 'Invalid shift.' });
  if (!Number.isFinite(requestedEndHours)) {
    throw new ValidationError({ requestedEndHours: 'Choose a new end time.' });
  }

  const ctx = await requireAssignment(req, shiftId);
  if (['archived', 'completed'].includes(ctx.proposal_status)) {
    throw new ConflictError('This event is closed.', 'EVENT_CLOSED');
  }

  const window = await checkWindow(ctx);
  if (!window.ok) throw new ConflictError(window.message, window.code);

  const delta = await computeExtensionDelta({
    client: pool, proposalId: ctx.proposal_id, requestedDurationHours: requestedEndHours,
  });
  if (!delta.ok) {
    const messages = {
      not_an_extension: 'Pick an end time later than the contracted one.',
      over_cap: `You can add at most ${MAX_EXTENSION_HOURS} hours. Contact management for more.`,
      bad_increment: 'Pick a time on a 30 minute mark.',
      unparseable_time: 'Could not determine this event’s times. Contact management.',
      missing_package: 'This event cannot be priced online. Contact management.',
      missing_proposal: 'This event cannot be priced online. Contact management.',
    };
    throw new ValidationError({ requestedEndHours: messages[delta.reason] || 'That end time is not available.' });
  }
  if (delta.isHosted && !hostedProductConfirmed) {
    throw new ValidationError({
      hostedProductConfirmed: 'Confirm you have the product to serve the extra time.',
    });
  }

  const dbClient = await pool.connect();
  let created;
  let invoiceToken;
  try {
    await dbClient.query('BEGIN');

    const invoice = await createInvoice({
      proposalId: ctx.proposal_id,
      label: SERVICE_EXTENSION_INVOICE_LABEL,
      amountDueCents: delta.amountCents,
      // 'sent', never 'draft': create-intent-for-invoice only accepts
      // sent/partially_paid, so a draft extension invoice would be unpayable.
      status: 'sent',
    }, dbClient);

    await writeLineItems(invoice.id, [{
      description: `Additional bar service, ${delta.contractedEndDisplay} to ${delta.requestedEndDisplay}`,
      quantity: 1,
      unit_price: delta.amountCents,
      line_total: delta.amountCents,
      source_type: 'service_extension',
      source_id: null,
    }], dbClient);

    const expiresAt = new Date(
      new Date(delta.contractedEndInstant).getTime() + REQUEST_GRACE_MINUTES * 60 * 1000
    );

    // The partial unique index on (proposal_id) WHERE status='pending' is what
    // makes a concurrent second request a clean 409 instead of a double charge.
    const ins = await dbClient.query(
      `INSERT INTO service_extensions
         (proposal_id, shift_id, requested_by_user_id, invoice_id,
          contracted_end_time, requested_end_time,
          contracted_duration_hours, requested_duration_hours,
          amount_cents, gratuity_cents, hosted_product_confirmed,
          terms_version, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)
       RETURNING id, requested_end_time, status`,
      [
        ctx.proposal_id, shiftId, req.user.id, invoice.id,
        delta.contractedEndDisplay, delta.requestedEndDisplay,
        delta.contractedDurationHours, delta.requestedDurationHours,
        delta.amountCents, delta.gratuityDeltaCents,
        delta.isHosted ? hostedProductConfirmed : null,
        CURRENT_EXTENSION_TERMS_VERSION, expiresAt,
      ]
    );
    created = ins.rows[0];
    invoiceToken = invoice.token;

    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'extension_requested', 'staff', $2, $3::jsonb)`,
      [ctx.proposal_id, req.user.id, JSON.stringify({
        extension_id: created.id,
        requested_end: delta.requestedEndDisplay,
        amount_cents: delta.amountCents,
      })]
    );

    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    // 23505 on the partial unique index = another staffer got there first.
    if (err.code === '23505') {
      throw new ConflictError(
        'Another request for this event is already with the client.',
        'EXTENSION_ALREADY_PENDING'
      );
    }
    throw err;
  } finally {
    // Release BEFORE notifying: the notify helpers take their own pooled
    // connections (CLAUDE.md one-pooled-connection rule).
    dbClient.release();
  }

  // Post-commit tail. A send failure must not undo a created request.
  const reach = await notify.notifyClientOfRequest({
    proposalId: ctx.proposal_id,
    invoiceToken,
    amountCents: delta.amountCents,
    newEndDisplay: delta.requestedEndDisplay,
    termsVersion: CURRENT_EXTENSION_TERMS_VERSION,
  });
  await notify.alertAdminsRequestSent({
    proposalId: ctx.proposal_id,
    newEndDisplay: delta.requestedEndDisplay,
    amountCents: delta.amountCents,
    requesterUserId: req.user.id,
    clientReachable: reach.reachable,
  });
  if (!reach.reachable) {
    await notify.alertAdminsProblem({
      proposalId: ctx.proposal_id,
      kind: 'client_unreachable',
      detail: `The extension link could not be delivered by SMS or email. Relay it manually: /invoice/${invoiceToken}`,
    });
  }

  // Explicit field list. No price, ever (spec decision 2).
  res.status(201).json({
    id: created.id,
    status: created.status,
    requestedEndTime: created.requested_end_time,
    clientNotified: reach.reachable,
  });
}));

module.exports = router;
```

- [ ] **Step 5: Mount the router**

Edit `server/index.js`. Add next to the other feature mounts (order does not matter here since the path prefix is unique):

```javascript
app.use('/api/service-extensions', require('./routes/serviceExtensions'));
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/create.test.js`
Expected: PASS, 7 tests.

If the 403 tests return 500, the `PermissionError` import name is wrong: check `grep -n "class.*Error" server/utils/errors.js` and use the real class names.

- [ ] **Step 7: Add the rate limiter**

Re-read `server/middleware/rateLimiters.js`. Add a limiter for this endpoint following the file's existing construction exactly (copy the shape of `clientPortalWriteLimiter`), named `serviceExtensionLimiter`, at 5 requests per hour keyed on the authenticated user id rather than IP (several staffers at one venue can share an IP):

Then apply it to the POST only, after `auth` so `req.user` exists:
```javascript
router.post('/', serviceExtensionLimiter, asyncHandler(async (req, res) => {
```

Re-run the suite. If the limiter's window trips the multi-request tests, give the test file its own bypass the way the existing rate-limiter-bound suites do (check `grep -rn "rateLimit\|NODE_ENV === 'test'" server/middleware/rateLimiters.js | head`), or reduce the number of POSTs per test.

- [ ] **Step 8: Commit**

```bash
git add server/routes/serviceExtensions/ server/index.js server/middleware/rateLimiters.js
git commit -m "feat(ext): staff request endpoint, assignment-gated and price-free

Requires the staff-home assignment predicate rather than trusting auth alone
(the onboarding self-promotion hole), enforces the request window as real
instants, mints a 'sent' Service Extension invoice, and returns an explicit
field list so no dollar figure can reach a staffer."
```

### Task 8: Public terms acceptance, invoice GET additions, and the zero-delta settle

The client-facing surface. Acceptance is recorded server-side, which is the whole point: a client-side-only gate would let the exact client who routes around the system produce an artifact-free payment.

The zero-delta case settles here, because Stripe cannot charge $0 and the coverage artifact matters regardless of price.

**Files:**
- Replace: `server/routes/serviceExtensions/publicAccept.js` (the Task 7 stub)
- Modify: `server/routes/invoices.js` (add extension fields to `GET /t/:token`)
- Test: `server/routes/serviceExtensions/publicAccept.test.js`
- Test: `server/routes/invoices.extension.test.js`

**Interfaces:**
- Consumes: `renderExtensionTerms`, `getExtensionTerms` (Task 3); `settleExtension` (Task 5); `notifyStaffOfOutcome`, `alertAdminsProblem` (Task 6).
- Produces:
  - `POST /api/service-extensions/t/:token/accept` → `{ accepted: true, requiresPayment: boolean, acceptedAt }`. Idempotent.
  - `GET /api/invoices/t/:token` response gains `extension: { is_extension: true, terms: {headline, paragraphs, version}, accepted_at, requires_payment } | null`.

- [ ] **Step 1: Write the accept route**

Create `server/routes/serviceExtensions/publicAccept.js`:

```javascript
'use strict';

/**
 * Public terms acceptance for a service extension (spec section 5.3).
 *
 * PUBLIC, gated by the invoice's UUID token. No auth, so requireUuidToken is
 * mandatory: a non-UUID :token would otherwise reach Postgres as a uuid
 * comparison and raise 22P02 -> 500 (the standing UUID token-guard rule).
 *
 * Acceptance is recorded HERE, server-side, and create-intent-for-invoice
 * refuses an extension invoice until it is stamped (Task 9). A client-side-only
 * gate would let a client who routes around the page pay with no artifact,
 * which is the one thing this feature exists to prevent.
 *
 * Idempotent: re-accepting is a no-op that returns the original timestamp, so a
 * double-tap on a phone cannot rewrite the audit record.
 */

const express = require('express');
const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');
const { publicLimiter } = require('../../middleware/rateLimiters');
const { requireUuidToken } = require('../../utils/tokens');
const { NotFoundError, ConflictError } = require('../../utils/errors');
const { settleExtension } = require('../../utils/serviceExtensionSettle');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();

/** POST /api/service-extensions/t/:token/accept */
router.post(
  '/t/:token/accept',
  requireUuidToken('token', 'This request is no longer available'),
  publicLimiter,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT se.id, se.status, se.amount_cents, se.client_accepted_at,
              se.contracted_end_time, se.requested_end_time, se.expires_at,
              se.proposal_id, p.status AS proposal_status
         FROM service_extensions se
         JOIN invoices i ON i.id = se.invoice_id
         JOIN proposals p ON p.id = se.proposal_id
        WHERE i.token = $1 AND i.status <> 'void'`,
      [req.params.token]
    );
    const ext = rows[0];
    if (!ext) throw new NotFoundError('This request is no longer available');

    if (ext.status !== 'pending') {
      // Already settled/expired: report the terminal state rather than
      // pretending acceptance is still meaningful.
      if (ext.client_accepted_at) {
        return res.json({
          accepted: true,
          requiresPayment: false,
          acceptedAt: ext.client_accepted_at,
          settled: true,
        });
      }
      throw new ConflictError('This request has expired.', 'EXTENSION_NOT_PENDING');
    }
    if (new Date(ext.expires_at).getTime() < Date.now()) {
      throw new ConflictError('This request has expired.', 'EXTENSION_EXPIRED');
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    const ua = (req.headers['user-agent'] || '').slice(0, 500) || null;

    // Stamp only once. COALESCE keeps the FIRST acceptance as the record.
    const upd = await pool.query(
      `UPDATE service_extensions
          SET client_accepted_at = COALESCE(client_accepted_at, NOW()),
              client_accept_ip   = COALESCE(client_accept_ip, $2),
              client_accept_ua   = COALESCE(client_accept_ua, $3),
              updated_at = NOW()
        WHERE id = $1
        RETURNING client_accepted_at`,
      [ext.id, ip, ua]
    );
    const acceptedAt = upd.rows[0].client_accepted_at;

    const amountCents = Number(ext.amount_cents) || 0;
    if (amountCents > 0) {
      // Payment is the settle trigger; the webhook takes it from here.
      return res.json({ accepted: true, requiresPayment: true, acceptedAt });
    }

    // Zero-delta: acceptance itself settles (spec decision 13). Stripe cannot
    // charge $0, and the coverage artifact matters regardless of price.
    const settled = await settleExtension({ client: pool, extensionId: ext.id, outcome: 'paid' });
    if (settled.ok) {
      await notify.notifyStaffOfOutcome({
        staffUserIds: settled.staffUserIds,
        outcome: 'approved',
        newEndDisplay: settled.newEndDisplay,
        contractedEndDisplay: ext.contracted_end_time,
        proposalId: settled.proposalId,
      });
      if (settled.multiShift) {
        await notify.alertAdminsProblem({
          proposalId: settled.proposalId,
          kind: 'multi_shift',
          detail: `Duration moved to ${settled.newDurationHours}h but the event has multiple shift rows, so no shift end_time was rewritten. Edit the right shift by hand.`,
        });
      }
    }
    return res.json({ accepted: true, requiresPayment: false, acceptedAt, settled: settled.ok });
  })
);

module.exports = router;
```

- [ ] **Step 2: Add the extension block to the invoice GET**

Edit `server/routes/invoices.js`. In the `GET /t/:token` handler, after the existing parallel line-items/payments/refunds fetch, add a fourth query and include it in the response. The block is `null` for every ordinary invoice, so Deposit and Balance links already in client inboxes are byte-unaffected.

```javascript
// Service-extension block. Non-null ONLY when a service_extensions row
// references this invoice, so ordinary Deposit/Balance invoices (including
// links already sitting in client inboxes) see no change at all. Drives the
// terms gate on InvoicePage: pay stays disabled until accepted_at is set.
const extRes = await pool.query(
  `SELECT id, status, amount_cents, terms_version, client_accepted_at,
          contracted_end_time, requested_end_time, expires_at
     FROM service_extensions
    WHERE invoice_id = $1
    ORDER BY id DESC LIMIT 1`,
  [invoice.id]
);
let extension = null;
if (extRes.rows[0]) {
  const e = extRes.rows[0];
  // renderExtensionTerms throws on an unknown version rather than showing copy
  // the client never agreed to. Fall back to no terms block (which leaves pay
  // disabled) instead of 500-ing a client's payment page.
  let terms = null;
  try {
    terms = renderExtensionTerms({ version: e.terms_version, newEndDisplay: e.requested_end_time });
  } catch (copyErr) {
    console.error('[invoices] unknown extension terms version', e.terms_version, copyErr.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(copyErr, { tags: { feature: 'service-extension', step: 'terms_render' } });
    }
  }
  extension = {
    is_extension: true,
    status: e.status,
    terms,
    accepted_at: e.client_accepted_at,
    expires_at: e.expires_at,
    contracted_end_time: e.contracted_end_time,
    requested_end_time: e.requested_end_time,
    requires_payment: Number(e.amount_cents) > 0,
    requires_acceptance: !e.client_accepted_at,
  };
}
```

Add to the top of `server/routes/invoices.js`:
```javascript
const Sentry = require('@sentry/node');
const { renderExtensionTerms } = require('../data/extensionTermsCopy');
```

And add `extension` to the `res.json({ invoice: { ... } })` payload alongside the existing arrays.

- [ ] **Step 3: Write the tests**

Create `server/routes/serviceExtensions/publicAccept.test.js` covering, with the same fixture shape as Task 7's suite (copy its `before`/`after`, adding a `service_extensions` row plus its invoice):

1. A non-UUID token returns 404, not 500. `fetch('/api/service-extensions/t/not-a-uuid/accept', {method:'POST'})` → 404.
2. An unknown UUID returns 404.
3. A priced pending request: accept returns `{accepted:true, requiresPayment:true}`, stamps `client_accepted_at`, `client_accept_ip`, `client_accept_ua`, and does NOT settle (`status` still `pending`, `event_duration_hours` unchanged).
4. Accepting twice keeps the FIRST timestamp: capture `acceptedAt` from the first call, assert the second call returns the identical value.
5. A zero-delta request (`amount_cents = 0`) settles on accept: response `{requiresPayment:false, settled:true}`, row `status = 'paid'`, `proposals.event_duration_hours` bumped, and `total_price`/`amount_paid`/`status` all unchanged.
6. An expired-by-timestamp pending row returns 409 `EXTENSION_EXPIRED` and does not stamp acceptance.
7. A voided invoice returns 404.

Create `server/routes/invoices.extension.test.js` covering:

1. An ordinary Balance invoice's `GET /t/:token` returns `extension: null` and is otherwise unchanged (assert `invoice.amount_due` and the `line_items` array still present).
2. An extension invoice returns `extension.is_extension === true`, `terms.headline` containing the requested end time, `requires_acceptance === true`, and `requires_payment === true`.
3. After acceptance, the same GET returns `requires_acceptance === false` and a non-null `accepted_at`.
4. An extension row carrying an unknown `terms_version` (insert one with `terms_version = 'bogus'`) returns `terms: null` and a 200, never a 500.

Stub the notify module at the top of both files exactly as Task 7's suite does.

- [ ] **Step 4: Run both suites, one at a time**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/publicAccept.test.js
node --env-file=/home/drbartender/projects/os/.env --test server/routes/invoices.extension.test.js
```
Expected: both PASS.

- [ ] **Step 5: Confirm no existing invoice suite regressed**

Run each of these one at a time:
```bash
node --env-file=/home/drbartender/projects/os/.env --test server/routes/invoices.clientTokenValidation.test.js
node --env-file=/home/drbartender/projects/os/.env --test server/routes/invoices.extrasVoid.test.js
node --env-file=/home/drbartender/projects/os/.env --test server/routes/invoices.refunds.test.js
```
Expected: all PASS. The GET addition is additive, so a failure here means the response shape changed for ordinary invoices, which is a blocker.

- [ ] **Step 6: Commit**

```bash
git add server/routes/serviceExtensions/publicAccept.js server/routes/serviceExtensions/publicAccept.test.js server/routes/invoices.js server/routes/invoices.extension.test.js
git commit -m "feat(ext): server-recorded terms acceptance + invoice-page extension block

Acceptance is stamped server-side and is idempotent; the zero-delta case
settles on acceptance since Stripe cannot charge \$0. The invoice GET block is
null for every ordinary invoice, so links already in client inboxes are
unaffected."
```

### Task 9: Gate intent creation on acceptance

Without this, Task 8's acceptance is decorative: a client could POST straight to the intent route and pay with no recorded agreement.

**Files:**
- Modify: `server/routes/stripe.js` (the `POST /create-intent-for-invoice/:token` handler)
- Test: extend `server/routes/serviceExtensions/publicAccept.test.js`

**Interfaces:**
- Consumes: the `service_extensions` row.
- Produces: a 409 `EXTENSION_TERMS_NOT_ACCEPTED` on an unaccepted extension invoice; existing behavior for every other invoice.

- [ ] **Step 1: Add the gate**

Edit `server/routes/stripe.js`. The existing handler already fetches the invoice into `inv` and then runs the archived-event guard. Immediately AFTER the archived guard and BEFORE the `balanceCents` computation, add:

```javascript
  // Extension invoices require a recorded terms acceptance before they can be
  // paid (spec decision 8). The acceptance is what makes the payment an
  // artifact, so the gate has to live server-side: a client who skips the page
  // and posts straight here would otherwise pay with no record of agreeing.
  // Ordinary invoices have no service_extensions row and skip this entirely.
  const extGate = await pool.query(
    `SELECT id, status, client_accepted_at, expires_at
       FROM service_extensions
      WHERE invoice_id = $1
      ORDER BY id DESC LIMIT 1`,
    [inv.invoice_id]
  );
  if (extGate.rows[0]) {
    const ext = extGate.rows[0];
    if (ext.status !== 'pending') {
      throw new ConflictError(
        'This request is no longer open. Contact us if you still need more time.',
        'EXTENSION_NOT_PENDING'
      );
    }
    if (new Date(ext.expires_at).getTime() < Date.now()) {
      throw new ConflictError('This request has expired.', 'EXTENSION_EXPIRED');
    }
    if (!ext.client_accepted_at) {
      throw new ConflictError(
        'Please review and accept the terms before paying.',
        'EXTENSION_TERMS_NOT_ACCEPTED'
      );
    }
  }
```

`ConflictError` is already imported in this file (the archived guard uses it). Verify with `grep -n "ConflictError" server/routes/stripe.js | head -2`.

- [ ] **Step 2: Add the tests to the accept suite**

Append to `server/routes/serviceExtensions/publicAccept.test.js`. Mount the stripe router alongside the extensions router in that suite's `before` (`app.use('/api/stripe', require('../stripe'))`), and stub the Stripe seam BEFORE requiring it:

```javascript
require('../../utils/stripeClient').getStripe = () => ({
  paymentIntents: {
    create: async (params) => ({ id: `pi_test_${Date.now()}`, client_secret: 'cs_test', amount: params.amount }),
  },
  customers: { create: async () => ({ id: 'cus_test' }), retrieve: async () => ({ id: 'cus_test', deleted: false }) },
});
```

Tests to add:
1. Intent creation on an unaccepted extension invoice returns 409 with code `EXTENSION_TERMS_NOT_ACCEPTED`.
2. After accepting, intent creation on the same token returns 200 with a `clientSecret`.
3. Intent creation on an EXPIRED pending extension returns 409 `EXTENSION_EXPIRED`.
4. Intent creation on an ORDINARY Balance invoice still returns 200 (proves the gate is scoped to extension invoices only). This one is the regression guard that matters most: the gate sits in the busiest client payment route.

- [ ] **Step 3: Run the suite plus the stripe suites**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/publicAccept.test.js
```
Then find and run the existing stripe route suites one at a time:
```bash
ls server/routes/stripe*.test.js
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add server/routes/stripe.js server/routes/serviceExtensions/publicAccept.test.js
git commit -m "feat(ext): refuse intent creation until extension terms are accepted

Server-side gate, scoped to invoices carrying a service_extensions row, so the
acceptance artifact cannot be skipped by posting straight to the intent route.
Ordinary invoices are untouched."
```

### Task 10: Admin override, cancel, and read

The override grants time and **voids the invoice** (spec decision 14). It never leaves a receivable, because an unpaid extension is not something DRB carries. Rev 2 of the spec had it leaving the invoice open; that was corrected, so do not reintroduce it.

**Files:**
- Replace: `server/routes/serviceExtensions/admin.js` (the Task 7 stub)
- Test: `server/routes/serviceExtensions/admin.test.js`

**Interfaces:**
- Consumes: `settleExtension`, `closeExtension` (Task 5); `notifyStaffOfOutcome`, `alertAdminsProblem` (Task 6); `cancelOpenInvoiceIntents` (existing).
- Produces:
  - `GET /api/service-extensions/proposal/:proposalId` → `{ extensions: [...] }` WITH money (admin surface).
  - `POST /api/service-extensions/:id/override` body `{ reason }` → `{ status: 'overridden', newEndTime, payrollWarning }`.
  - `POST /api/service-extensions/:id/cancel` → `{ status: 'cancelled' }`.

- [ ] **Step 1: Write the route**

Create `server/routes/serviceExtensions/admin.js`:

```javascript
'use strict';

/**
 * Admin surfaces for service extensions (spec sections 5.6, 8).
 *
 * Override grants the time and VOIDS the invoice (decision 14). It does NOT
 * leave an open invoice to collect: per decision 12 an unpaid extension is not
 * a receivable DRB carries, so there is deliberately no aging view, no
 * reminder, and no collect action anywhere in this feature.
 *
 * Because extension money is side money, an unpaid override cannot demote
 * payment status, block auto-completion, or disturb the funded-gratuity gate.
 * That is the entire reason the override is safe now.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { settleExtension, closeExtension } = require('../../utils/serviceExtensionSettle');
const { cancelOpenInvoiceIntents } = require('../../utils/invoiceVoid');
const { logAdminAction } = require('../../utils/adminAuditLog');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();

/** Void the extension's invoice and cancel any open intent against it. */
async function voidExtensionInvoice(proposalId, invoiceId) {
  if (!invoiceId) return;
  // Best-effort intent cancel first, so a client mid-checkout cannot complete
  // against an invoice we are about to void.
  await cancelOpenInvoiceIntents(proposalId, invoiceId);
  await pool.query(
    "UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND status <> 'paid'",
    [invoiceId]
  );
}

/**
 * Payroll warning text when the event's hours are already accrued and
 * admin-edited, so the automatic re-seed will refuse to touch them.
 * Mirrors the rule in serviceExtensionPayroll (Task 13).
 */
async function payrollWarningFor(proposalId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS locked
       FROM payout_events pe
       JOIN shifts s ON s.id = pe.shift_id
      WHERE s.proposal_id = $1
        AND pe.hours IS DISTINCT FROM pe.contracted_hours`,
    [proposalId]
  );
  return rows[0] && rows[0].locked > 0
    ? 'Payroll hours for this event were edited by hand, so the extra time was NOT added automatically. Update the payout line yourself.'
    : null;
}

/** GET /api/service-extensions/proposal/:proposalId */
router.get('/proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposalId = Number(req.params.proposalId);
  if (!Number.isInteger(proposalId)) throw new ValidationError({ proposalId: 'Invalid event.' });
  const { rows } = await pool.query(
    `SELECT se.id, se.status, se.amount_cents, se.gratuity_cents,
            se.contracted_end_time, se.requested_end_time,
            se.contracted_duration_hours, se.requested_duration_hours,
            se.client_accepted_at, se.expires_at, se.created_at,
            se.override_reason, se.hosted_product_confirmed,
            se.requested_by_user_id, se.invoice_id,
            i.status AS invoice_status, i.token AS invoice_token,
            COALESCE(cp.preferred_name, u.name) AS requested_by_name,
            ov.name AS override_by_name
       FROM service_extensions se
       LEFT JOIN invoices i ON i.id = se.invoice_id
       LEFT JOIN users u ON u.id = se.requested_by_user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = se.requested_by_user_id
       LEFT JOIN users ov ON ov.id = se.override_by_user_id
      WHERE se.proposal_id = $1
      ORDER BY se.id DESC`,
    [proposalId]
  );
  res.json({ extensions: rows, payrollWarning: await payrollWarningFor(proposalId) });
}));

/** POST /api/service-extensions/:id/override */
router.post('/:id/override', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError({ id: 'Invalid request.' });
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) throw new ValidationError({ reason: 'Give a short reason for the override.' });
  if (reason.length > 500) throw new ValidationError({ reason: 'Keep the reason under 500 characters.' });

  const probe = await pool.query(
    'SELECT status, contracted_end_time FROM service_extensions WHERE id = $1',
    [id]
  );
  if (!probe.rows[0]) throw new NotFoundError('Request not found');

  const settled = await settleExtension({
    client: pool, extensionId: id, outcome: 'overridden',
    actorUserId: req.user.id, overrideReason: reason,
  });
  if (!settled.ok) {
    throw new ConflictError(
      `This request is already ${probe.rows[0].status}.`,
      'EXTENSION_NOT_PENDING'
    );
  }

  // Decision 14: no receivable survives an override.
  await voidExtensionInvoice(settled.proposalId, settled.invoiceId);

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'service_extension_override',
    metadata: {
      extension_id: id,
      proposal_id: settled.proposalId,
      reason,
      new_duration_hours: settled.newDurationHours,
      amount_cents_waived: settled.amountCents,
    },
  });

  await notify.notifyStaffOfOutcome({
    staffUserIds: settled.staffUserIds,
    outcome: 'approved',
    newEndDisplay: settled.newEndDisplay,
    contractedEndDisplay: probe.rows[0].contracted_end_time,
    proposalId: settled.proposalId,
  });
  if (settled.multiShift) {
    await notify.alertAdminsProblem({
      proposalId: settled.proposalId,
      kind: 'multi_shift',
      detail: `Duration moved to ${settled.newDurationHours}h but this event has multiple shift rows, so no shift end_time was rewritten. Edit the right shift by hand.`,
    });
  }

  res.json({
    status: 'overridden',
    newEndTime: settled.newEndDisplay,
    newDurationHours: settled.newDurationHours,
    payrollWarning: await payrollWarningFor(settled.proposalId),
  });
}));

/** POST /api/service-extensions/:id/cancel */
router.post('/:id/cancel', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError({ id: 'Invalid request.' });

  const probe = await pool.query(
    'SELECT status, contracted_end_time FROM service_extensions WHERE id = $1',
    [id]
  );
  if (!probe.rows[0]) throw new NotFoundError('Request not found');

  const closed = await closeExtension({
    client: pool, extensionId: id, outcome: 'cancelled', actorUserId: req.user.id,
  });
  if (!closed.ok) {
    throw new ConflictError(`This request is already ${probe.rows[0].status}.`, 'EXTENSION_NOT_PENDING');
  }

  await voidExtensionInvoice(closed.proposalId, closed.invoiceId);

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'service_extension_cancel',
    metadata: { extension_id: id, proposal_id: closed.proposalId },
  });

  await notify.notifyStaffOfOutcome({
    staffUserIds: closed.staffUserIds,
    outcome: 'declined',
    newEndDisplay: null,
    contractedEndDisplay: probe.rows[0].contracted_end_time,
    proposalId: closed.proposalId,
  });

  res.json({ status: 'cancelled' });
}));

module.exports = router;
```

- [ ] **Step 2: Write the test**

Create `server/routes/serviceExtensions/admin.test.js` using Task 7's fixture shape plus an admin user (`role: 'admin'`). Stub `getStripe` (so `cancelOpenInvoiceIntents` is inert) and the notify module. Cover:

1. A staff-role token gets 403 on override, cancel, and the GET.
2. Override with a reason under 3 characters returns 400.
3. Override on a pending request: 200, row `status = 'overridden'` with the reason and actor recorded, `proposals.event_duration_hours` bumped, the shift `end_time` updated, and **the invoice `status = 'void'`** (this is decision 14: assert explicitly that no open invoice survives).
4. After the override, `total_price`, `amount_paid`, and `proposals.status` are all unchanged (side money).
5. An `admin_audit_log` row exists with action `service_extension_override`.
6. A second override on the same row returns 409.
7. Cancel on a pending request: 200, `status = 'cancelled'`, invoice `void`, and `event_duration_hours` UNCHANGED.
8. The GET returns money fields (this is the admin surface, so `amount_cents` is expected here, unlike the staff endpoints).

- [ ] **Step 3: Run it**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/routes/serviceExtensions/admin.test.js`
Expected: PASS.

If `requireAdminOrManager` is not exported under that name, check `grep -n "module.exports" -A8 server/middleware/auth.js` and use the real guard.

- [ ] **Step 4: Commit**

```bash
git add server/routes/serviceExtensions/admin.js server/routes/serviceExtensions/admin.test.js
git commit -m "feat(ext): admin override and cancel, both voiding the invoice

Override grants the time and leaves no receivable (spec decision 14). Side
money is what makes an unpaid override safe: it cannot demote payment status,
block auto-completion, or disturb the funded-gratuity gate."
```

- [ ] **Step 5: Lane checkpoint review**

Dispatch `security-review` on the whole `ext-routes` diff. Focus: the assignment predicate, the public token surface, the acceptance gate's scoping to extension invoices only, and whether any staff-facing response can leak a price.

- [ ] **Step 6: Lane gate**

Run every suite in this lane one at a time, then the full fleet declared in front-matter.

```bash
for f in \
  server/routes/serviceExtensions/create.test.js \
  server/routes/serviceExtensions/publicAccept.test.js \
  server/routes/serviceExtensions/admin.test.js \
  server/routes/invoices.extension.test.js ; do
  echo "=== $f"; node --env-file=/home/drbartender/projects/os/.env --test "$f" || break
done
```

---

## Lane ext-webhook-payroll

The two money seams: settling a paid extension inside the Stripe webhook, and getting the extra time into payroll. Plus the expiry sweep that makes the hard stop real.

### Task 11: Settle on payment inside the webhook

The extension settles by looking itself up from the paid invoice. That lookup IS the discriminator: `create-intent-for-invoice` stamps `payment_type: 'invoice'` unconditionally, so nothing else in the intent distinguishes an extension from a Balance payment, and no new metadata is needed.

Three facts about the existing handler this task depends on, all verified 2026-07-26:
1. The whole block runs inside `if (isFirstDelivery)`, gated by the `proposal_payments` ON CONFLICT insert, so a Stripe retry never re-enters it.
2. The invoice branch already links the payment via `intent.metadata.invoice_id` with a proposal-ownership cross-check. **Do not add a second `linkPaymentToInvoice` call**; it would return not-payable and Sentry-warn on every extension payment.
3. Because `Service Extension` is now in `OFF_LEDGER_INVOICE_LABELS`, the branch's `amount_paid` roll-up is already skipped for it. That is the side-money guarantee and it needs no new code.

**Files:**
- Modify: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`
- Test: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js`

**Interfaces:**
- Consumes: `settleExtension` (Task 5); `notifyStaffOfOutcome`, `alertAdminsProblem` (Task 6); `applyExtensionHours` (Task 12, imported lazily so the two tasks can be built in either order within this lane).
- Produces: no new exports. Behavior: a paid extension invoice bumps duration and greenlights staff.

- [ ] **Step 1: Read the handler around the insertion point**

Run: `grep -n "if (invOwner.rows\[0\])" -A6 server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`

The settle hook goes immediately AFTER the existing `linkPaymentToInvoice(...)` call, still inside `if (invOwner.rows[0])`, so it only runs for an invoice that genuinely belongs to this proposal.

- [ ] **Step 2: Add the settle hook**

Insert after the `await linkPaymentToInvoice(Number(invoiceId), paymentRowId, intent.amount, dbClient);` line:

```javascript
                // ─── Service extension settle (spec 2026-07-25 section 7) ───
                // The service_extensions lookup by invoice_id IS the
                // discriminator: create-intent-for-invoice stamps
                // payment_type:'invoice' unconditionally, so nothing else in
                // the intent tells an extension from a Balance payment.
                //
                // The claim UPDATE (WHERE status='pending') is the race gate
                // against the expiry sweep and a second idempotency wall behind
                // isFirstDelivery. Deliberately NO fold, NO reconcile, NO
                // invoice refresh: extension money is off-ledger side money and
                // the ONLY contract column that moves is event_duration_hours.
                const extRow = await dbClient.query(
                  `SELECT id, status, contracted_end_time
                     FROM service_extensions
                    WHERE invoice_id = $1
                    ORDER BY id DESC LIMIT 1`,
                  [Number(invoiceId)]
                );
                if (extRow.rows[0]) {
                  extensionSettleContext = {
                    extensionId: extRow.rows[0].id,
                    priorStatus: extRow.rows[0].status,
                    contractedEndDisplay: extRow.rows[0].contracted_end_time,
                  };
                }
```

Declare `let extensionSettleContext = null;` alongside the handler's other pre-transaction locals (find them with `grep -n "^        let \|^      let " server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js | head`), so the post-commit tail can see it.

- [ ] **Step 3: Do the settle in the post-commit tail, not in the transaction**

Find the handler's post-commit section (after its `COMMIT`, where other best-effort work runs): `grep -n "COMMIT" server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`.

Add there:

```javascript
  // ─── Service extension: settle AFTER the commit ─────────────────────────
  // Outside the transaction on purpose. The payment is already durably
  // recorded; a settle, payroll, or Twilio failure here must never roll that
  // back and make Stripe retry a charge the client already made.
  if (extensionSettleContext) {
    const { settleExtension } = require('../../utils/serviceExtensionSettle');
    const notify = require('../../utils/serviceExtensionNotify');
    try {
      if (extensionSettleContext.priorStatus !== 'pending') {
        // The expiry sweep (or an admin) claimed the row before this payment
        // landed. DRB is holding money for time nobody authorized: contain it
        // to "refund one payment" and tell a human. Modeled on the existing
        // payment_on_archived alert. Never throw: a throw here would make
        // Stripe retry forever against an already-charged client.
        await notify.alertAdminsProblem({
          proposalId,
          kind: 'paid_after_expiry',
          detail: `An extension payment of ${intent.amount} cents landed after the request was already ${extensionSettleContext.priorStatus}. The event was NOT extended. Refund this payment.`,
        });
      } else {
        const settled = await settleExtension({
          client: pool,
          extensionId: extensionSettleContext.extensionId,
          outcome: 'paid',
        });
        if (settled.ok) {
          const { applyExtensionHours } = require('../../utils/serviceExtensionPayroll');
          const payroll = await applyExtensionHours({
            proposalId: settled.proposalId,
            newDurationHours: settled.newDurationHours,
          });
          if (payroll && payroll.lockedLines > 0) {
            await notify.alertAdminsProblem({
              proposalId: settled.proposalId,
              kind: 'payroll_hours_locked',
              detail: `${payroll.lockedLines} payout line(s) for this event were edited by hand, so the extra time was not added automatically. Update them yourself.`,
            });
          }
          await notify.notifyStaffOfOutcome({
            staffUserIds: settled.staffUserIds,
            outcome: 'approved',
            newEndDisplay: settled.newEndDisplay,
            contractedEndDisplay: extensionSettleContext.contractedEndDisplay,
            proposalId: settled.proposalId,
          });
          if (settled.multiShift) {
            await notify.alertAdminsProblem({
              proposalId: settled.proposalId,
              kind: 'multi_shift',
              detail: `Duration moved to ${settled.newDurationHours}h but this event has multiple shift rows, so no shift end_time was rewritten. Edit the right shift by hand.`,
            });
          }
        } else {
          // Lost the claim between the read and here: same containment.
          await notify.alertAdminsProblem({
            proposalId,
            kind: 'paid_after_expiry',
            detail: `An extension payment landed but the request was claimed by another process first. The event was NOT extended. Verify and refund if needed.`,
          });
        }
      }
    } catch (extErr) {
      // Contain: the payment stands, the extension did not settle, a human is told.
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(extErr, { tags: { feature: 'service-extension', step: 'webhook_settle' } });
      }
      console.error('[webhook] service-extension settle failed:', extErr.message);
      await notify.alertAdminsProblem({
        proposalId,
        kind: 'settle_on_closed_event',
        detail: `A paid extension could not be settled automatically (${extErr.message}). Extend the event by hand and check the bartender was told.`,
      }).catch(() => {});
    }
  }
```

Confirm `pool` and `Sentry` are already in scope in that file (`grep -n "require('@sentry/node')\|{ pool }" server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js | head`). If `pool` is not imported, add it.

- [ ] **Step 4: Write the test**

Create `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js`. Call the handler function directly with a synthetic intent rather than going through signature verification. Read the existing sibling suites first to copy their invocation shape: `ls server/routes/stripeWebhookHandlers/*.test.js` and read one.

Cover:
1. **Happy path.** A `Service Extension` invoice, a pending row, an intent with `metadata.invoice_id` and `payment_type: 'invoice'`. After the handler: extension `status = 'paid'`, `proposals.event_duration_hours` bumped, shift `end_time` updated.
2. **Side money, the critical assertion.** After the same run: `proposals.amount_paid` is UNCHANGED, `total_price` unchanged, `status` unchanged. This is the off-ledger guarantee and the single most important test in the feature.
3. **Deposit-only regression guard (spec §13).** Set up a proposal with `total_price = 1000`, `amount_paid = 100`, status `deposit_paid`, then settle a paid extension. Assert `amount_paid` is still 100 and status is still `deposit_paid`, so the funded-gratuity gate stays false and auto-completion is not tripped.
4. **Replay.** Invoke the handler twice with the same intent. Assert `event_duration_hours` moved exactly once and exactly one `proposal_payments` row exists.
5. **Paid after expiry.** Pre-set the row to `expired`, then run the handler. Assert the duration did NOT move, and that the admin alert path was hit (stub `alertAdminsProblem` to record calls and assert `kind === 'paid_after_expiry'`).
6. **Ordinary Balance invoice.** No `service_extensions` row: assert `amount_paid` DOES increase as it always did, proving the change is inert for normal payments.
7. **No dunning (spec decision 12).** After a pending extension exists and after one settles, assert zero `scheduled_messages` rows reference the extension invoice or carry an extension `message_type`. An unpaid extension is not a receivable, so nothing may ever chase it. This is the regression guard for the invariant, not just documentation.

Stub `serviceExtensionNotify` and `serviceExtensionPayroll` at the top so no real sends or payroll writes occur.

- [ ] **Step 5: Run it, plus every existing webhook suite**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js
ls server/routes/stripeWebhookHandlers/*.test.js
```
Then run each existing webhook suite one at a time. Expected: all PASS. This handler is the busiest money path in the app; a regression here is a blocker, not a warning.

- [ ] **Step 6: Commit**

```bash
git add server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js
git commit -m "feat(ext): settle a paid extension in the webhook, off-ledger

Looks the extension up by paid invoice (the only available discriminator),
claims it, and settles AFTER the commit so a settle/payroll/Twilio failure
cannot roll back a recorded payment. amount_paid stays put via the off-ledger
label, so a deposit-stage event cannot be falsely marked funded."
```

### Task 12: Payroll, both halves

Two separate problems.

**Wage hours.** Accrual seeds `contracted_hours` from `proposals.event_duration_hours` on FIRST accrual only, and afterwards treats `hours` as admin-owned. First accrual mid-event is the NORM, not the exception: a card tip matched to the shift triggers accrual while the period is open, and auto-completion fires at the contracted end, which is inside the request window. So the spec's rule is: re-seed when `hours = contracted_hours` (the admin demonstrably has not touched the line), and refuse plus warn when they differ.

**Gratuity share.** The pool is snapshot-derived and the snapshot never moves (side money), so the extension's gratuity joins as an event-scoped addend, mirroring how card tips already join.

**The fee-netting trap.** `proRataFeeCents(grossGratuity, proposalTotalCents, fee)` relies on the stated invariant that the gratuity is a part of `total_price`, so the ratio cannot exceed 1. Extension gratuity is NOT inside `total_price`. Adding it to `grossGratuity` before the fee call would break that invariant and could over-net the fee. So the addend is applied AFTER fee-netting, which also implements the spec's decision that DRB absorbs the extension's Stripe fee rather than charging it to the staff pool.

**Files:**
- Create: `server/utils/serviceExtensionPayroll.js`
- Modify: `server/utils/payrollAccrual.js`
- Test: `server/utils/serviceExtensionPayroll.test.js`
- Test: `server/utils/payrollAccrual.extension.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `applyExtensionHours({ proposalId, newDurationHours })` → `Promise<{ updatedLines: number, lockedLines: number, frozenLines: number }>`
  - `payrollAccrual`'s gratuity pool includes `SUM(gratuity_cents)` over that proposal's `paid` extensions, added after fee-netting.

- [ ] **Step 1: Read the accrual code this task modifies**

Run: `sed -n 283,300p server/utils/payrollAccrual.js` and `sed -n 330,340p server/utils/payrollAccrual.js`

Confirm the current shape: `gratuityFunded`, `grossGratuity`, `gratuityFee = proRataFeeCents(grossGratuity, proposalTotalCents, fee)`, `netGratuity = Math.max(0, grossGratuity - gratuityFee)`. Also read the `contractedHours()` helper (`grep -n "function contractedHours" -A8 server/utils/payrollAccrual.js`) so the re-seed uses the same rounding the seeding path uses.

- [ ] **Step 2: Write the hours module**

Create `server/utils/serviceExtensionPayroll.js`:

```javascript
'use strict';

/**
 * Get a settled extension's extra time into payroll (spec section 9).
 *
 * payrollAccrual seeds contracted_hours from proposals.event_duration_hours on
 * FIRST accrual and then treats hours as admin-owned. First accrual mid-event
 * is the NORM, not the exception: matchTipToEvent accrues on any card tip while
 * the period is open, and auto-completion fires at the contracted end, which is
 * inside the request window itself. So an extension frequently lands AFTER a
 * line already exists, and re-accrual would preserve the old hours and silently
 * underpay.
 *
 * Rule: re-seed only when hours = contracted_hours, meaning the admin has
 * demonstrably not touched the line. When they differ the admin owns it, so we
 * refuse and report a locked line for the caller to surface. Frozen pay periods
 * are never written (the late-tip deferral precedent); they are reported too.
 *
 * Wages are recomputed from the new hours because wage_cents is a stored,
 * JS-computed column in this schema.
 */

const { pool } = require('../db');

/** Same rounding the accrual seeding path uses. */
function contractedHoursFor(durationHours) {
  const h = Number(durationHours) || 0;
  return Math.round(h * 100) / 100;
}

async function applyExtensionHours({ proposalId, newDurationHours }) {
  const target = contractedHoursFor(newDurationHours);
  if (!target) return { updatedLines: 0, lockedLines: 0, frozenLines: 0 };

  const { rows } = await pool.query(
    `SELECT pe.payout_id, pe.shift_id, pe.hours, pe.contracted_hours, pe.rate_cents,
            pe.gratuity_share_cents, pe.card_tip_net_cents, pe.adjustment_cents,
            pp.status AS period_status
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       JOIN pay_periods pp ON pp.id = po.pay_period_id
       JOIN shifts s ON s.id = pe.shift_id
      WHERE s.proposal_id = $1`,
    [proposalId]
  );

  let updatedLines = 0;
  let lockedLines = 0;
  let frozenLines = 0;

  for (const line of rows) {
    // Frozen / processed periods are never rewritten here.
    if (line.period_status && line.period_status !== 'open') {
      frozenLines += 1;
      continue;
    }
    // Admin-edited hours are admin-owned.
    if (Number(line.hours) !== Number(line.contracted_hours)) {
      lockedLines += 1;
      continue;
    }
    // Already at the new duration (a replay, or accrual ran after the bump).
    if (Number(line.contracted_hours) === target) continue;

    const wage = Math.round(target * Number(line.rate_cents));
    const lineTotal = wage
      + Number(line.gratuity_share_cents || 0)
      + Number(line.card_tip_net_cents || 0)
      + Number(line.adjustment_cents || 0);

    await pool.query(
      `UPDATE payout_events
          SET contracted_hours = $3, hours = $3, wage_cents = $4, line_total_cents = $5
        WHERE payout_id = $1 AND shift_id = $2`,
      [line.payout_id, line.shift_id, target, wage, lineTotal]
    );
    updatedLines += 1;
  }

  return { updatedLines, lockedLines, frozenLines };
}

module.exports = { applyExtensionHours, contractedHoursFor };
```

- [ ] **Step 3: Verify the column and table names before trusting the query**

Run:
```bash
grep -n "CREATE TABLE IF NOT EXISTS pay_periods" -A12 server/db/schema.sql
grep -n "CREATE TABLE IF NOT EXISTS payout_events" -A22 server/db/schema.sql
```
Confirm `pay_periods.status` exists and its open value is literally `'open'`, and that `payout_events` has `line_total_cents`, `wage_cents`, `rate_cents`, `card_tip_net_cents`, `adjustment_cents`. Fix the query to the real names if any differ. If the period-open concept is a boolean or a different column (e.g. `frozen_at`), use that instead and keep the semantics: never write a non-open period.

- [ ] **Step 4: Add the gratuity addend to accrual**

Edit `server/utils/payrollAccrual.js`. Replace the `grossGratuity` / `gratuityFee` / `netGratuity` sequence with:

```javascript
    const gratuityFunded = proposalPaidCents >= proposalTotalCents;
    // CONTRACT gratuity only. This is the value the fee pro-ration is allowed
    // to see, because proRataFeeCents relies on the gratuity being a part of
    // the total_price denominator so the ratio cannot exceed 1.
    const contractGrossGratuity = gratuityFunded
      ? extractGratuityCents(readSnapshot(proposal.pricing_snapshot, { context: 'payrollAccrual' }))
      : 0;

    // Service-extension gratuity (spec 2026-07-25 section 9). Side money: it is
    // NOT in pricing_snapshot and NOT in total_price, so it joins the pool as an
    // event-scoped addend, mirroring how card tips already join. Gated
    // per-extension on status='paid' (its own money arrived), independent of the
    // proposal-level funded gate above, so a deposit-stage event still pays out
    // the gratuity a client actually paid for extra time. An 'overridden'
    // extension contributes nothing: its invoice is voided, so that money never
    // arrives (spec decision 14).
    const extGratRes = await client.query(
      `SELECT COALESCE(SUM(gratuity_cents), 0)::int AS cents
         FROM service_extensions
        WHERE proposal_id = $1 AND status = 'paid'`,
      [proposalId]
    );
    const extensionGratuity = Number(extGratRes.rows[0].cents) || 0;
```

Leave the `feeRes` query exactly as it is, then replace the fee application with:

```javascript
    const gratuityFee = proRataFeeCents(
      contractGrossGratuity, proposalTotalCents, Number(feeRes.rows[0].fee)
    );
    // The addend is applied AFTER fee-netting on purpose, for two reasons.
    // (1) Correctness: extension dollars are outside the total_price
    // denominator, so feeding them into proRataFeeCents would break its
    // ratio-cannot-exceed-1 invariant. (2) Policy: the extension payment's
    // Stripe fee sits outside CONTRACT_LABELS and is therefore not in the fee
    // numerator either, so DRB absorbs it rather than the staff pool. Decided,
    // not accidental; it errs toward staff, consistent with this file's bias.
    const netGratuity = Math.max(0, contractGrossGratuity - gratuityFee) + extensionGratuity;
```

Then update the two places that referenced `grossGratuity` afterwards if any remain (`grep -n "grossGratuity" server/utils/payrollAccrual.js` after editing; there must be zero stale references).

- [ ] **Step 5: Write both test suites**

Create `server/utils/serviceExtensionPayroll.test.js`. Use the chicago-keyed track-and-restore pay-period fixture pattern (standing test law: read an existing payroll suite first, `grep -ln "pay_period" server/utils/*.test.js server/routes/admin/payroll*.test.js | head -3`, and copy its period setup and restore). Cover:
1. An untouched line (`hours = contracted_hours = 4`) re-seeds to 4.5, and `wage_cents` recomputes as `4.5 * rate_cents`.
2. `line_total_cents` recomputes as wage + gratuity + card tip + adjustment.
3. An admin-edited line (`hours = 3`, `contracted_hours = 4`) is NOT touched and is counted in `lockedLines`.
4. A line in a non-open period is NOT touched and is counted in `frozenLines`.
5. Re-running with the same target is a no-op (`updatedLines === 0`).
6. A proposal with no payout lines returns all zeros without error.

Create `server/utils/payrollAccrual.extension.test.js`. Cover:
1. A fully-paid proposal with one paid extension carrying `gratuity_cents = 2500`: each bartender's `gratuity_share_cents` is higher than the same setup with no extension, by the extension amount split evenly.
2. A DEPOSIT-stage proposal (`amount_paid < total_price`) with a paid extension: the contract gratuity stays $0 (funded gate false) but the extension gratuity still reaches the bartenders. This proves the two gates are independent.
3. A `pending` extension and an `overridden` extension both contribute $0.
4. The extension gratuity is NOT reduced by any Stripe fee (assert the share equals the split of the raw `gratuity_cents`, so the fee-netting change is provably scoped to contract gratuity).

- [ ] **Step 6: Run both suites and the existing payroll suites, one at a time**

```bash
node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionPayroll.test.js
node --env-file=/home/drbartender/projects/os/.env --test server/utils/payrollAccrual.extension.test.js
```
Then every existing payroll suite:
```bash
ls server/utils/payroll*.test.js server/routes/admin/payroll*.test.js
```
Run each alone. Expected: all PASS. The `grossGratuity` rename touches the busiest payroll math in the app, so any failure is a blocker.

- [ ] **Step 7: Add to the money smoke list and commit**

Append to `scripts/money-smoke-list.txt`:
```
server/utils/serviceExtensionPayroll.test.js
server/utils/payrollAccrual.extension.test.js
```

```bash
git add server/utils/serviceExtensionPayroll.js server/utils/serviceExtensionPayroll.test.js server/utils/payrollAccrual.js server/utils/payrollAccrual.extension.test.js scripts/money-smoke-list.txt
git commit -m "feat(ext): extension hours re-seed + gratuity addend in payroll

Hours re-seed only when the admin has not edited the line, and never in a
frozen period. Gratuity joins the pool AFTER fee-netting: extension dollars are
outside the total_price denominator, so feeding them to proRataFeeCents would
break its ratio invariant, and DRB absorbs the extension's Stripe fee rather
than the staff pool."
```

- [ ] **Step 8: Checkpoint review**

Dispatch `security-review` AND `code-review` on Tasks 11 and 12 together. These are the two money seams; the reviewers should specifically check that `amount_paid` cannot move, that the fee pro-ration invariant holds, and that no payroll line can be written in a frozen period.

### Task 13: Expiry sweep and scheduler registration

The hard stop is the entire coverage argument in the spec, and nothing enforces it without this. The sweep also sends the decline message, which is the one carrying the insurance warning.

**Files:**
- Create: `server/utils/serviceExtensionSweep.js`
- Modify: `server/index.js` (scheduler registration)
- Test: `server/utils/serviceExtensionSweep.test.js`

**Interfaces:**
- Consumes: `closeExtension` (Task 5); `notifyStaffOfOutcome`, `alertAdminsProblem` (Task 6); `cancelOpenInvoiceIntents` (existing).
- Produces: `sweepExpiredExtensions()` → `Promise<{ expired: number, notified: number }>`

- [ ] **Step 1: Write the sweep**

Create `server/utils/serviceExtensionSweep.js`:

```javascript
'use strict';

/**
 * Expire pending service-extension requests (spec section 5.5).
 *
 * The hard stop is the whole coverage argument: no greenlight means bar service
 * ends at the contracted time. Nothing enforces that without this sweep, so it
 * is load-bearing rather than housekeeping.
 *
 * closeExtension's claim (WHERE status='pending') is the race gate against a
 * payment settling at the same moment: exactly one of the two wins, and the
 * webhook's post-commit path contains the losing case by alerting for a refund
 * rather than extending an event nobody paid for.
 *
 * Runs every 60 seconds because a bartender is standing at a bar waiting, and
 * the decline message carries the insurance warning.
 */

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { closeExtension } = require('./serviceExtensionSettle');
const { cancelOpenInvoiceIntents } = require('./invoiceVoid');
const notify = require('./serviceExtensionNotify');

// Cap per tick so a backlog cannot make one run unbounded. At real volume
// (a handful of events a night) this is never reached.
const SWEEP_LIMIT = 50;

async function sweepExpiredExtensions() {
  const { rows } = await pool.query(
    `SELECT id FROM service_extensions
      WHERE status = 'pending' AND expires_at < NOW()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [SWEEP_LIMIT]
  );
  if (rows.length === 0) return { expired: 0, notified: 0 };

  let expired = 0;
  let notified = 0;

  for (const { id } of rows) {
    try {
      // Read the copy inputs BEFORE claiming, since the claim does not return them.
      const pre = await pool.query(
        'SELECT contracted_end_time FROM service_extensions WHERE id = $1',
        [id]
      );
      const contractedEndDisplay = pre.rows[0] ? pre.rows[0].contracted_end_time : null;

      const closed = await closeExtension({ client: pool, extensionId: id, outcome: 'expired' });
      if (!closed.ok) continue; // a settle or an admin won the claim
      expired += 1;

      // Make the invoice unpayable. Best-effort intent cancel first so a client
      // mid-checkout cannot complete against an invoice about to be voided.
      if (closed.invoiceId) {
        await cancelOpenInvoiceIntents(closed.proposalId, closed.invoiceId);
        await pool.query(
          "UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND status <> 'paid'",
          [closed.invoiceId]
        );
      }

      const result = await notify.notifyStaffOfOutcome({
        staffUserIds: closed.staffUserIds,
        outcome: 'declined',
        newEndDisplay: null,
        contractedEndDisplay,
        proposalId: closed.proposalId,
      });
      notified += result.notified.length;
    } catch (err) {
      // One bad row must not stop the sweep: the next tick retries it, and the
      // claim makes that safe.
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(err, { tags: { feature: 'service-extension', step: 'sweep' }, extra: { extensionId: id } });
      }
      console.error(`[serviceExtensionSweep] extension ${id} failed:`, err.message);
    }
  }

  if (expired > 0) console.log(`[serviceExtensionSweep] expired ${expired}, notified ${notified} staffer(s)`);
  return { expired, notified };
}

module.exports = { sweepExpiredExtensions, SWEEP_LIMIT };
```

- [ ] **Step 2: Register the scheduler**

Edit `server/index.js`. Copy the `RUN_REFUND_PENDING_SWEEP_SCHEDULER` block's exact shape (read it first: `grep -n "RUN_REFUND_PENDING_SWEEP_SCHEDULER" -A8 server/index.js`) and add alongside it:

```javascript
      // Service-extension expiry (spec 2026-07-25 section 5.5): a 60s sweep that
      // makes the hard stop real. A pending request past its grace window is
      // expired, its invoice voided, and every assigned staffer told service
      // ends at the contracted time. Load-bearing, not housekeeping.
      if (enabled('RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER')) {
        const { sweepExpiredExtensions } = require('./utils/serviceExtensionSweep');
        const wrapped = wrapScheduler('service_extension_sweep', 60, sweepExpiredExtensions);
        setTimeout(wrapped, 60000); // stagger from the other schedulers
        setInterval(wrapped, 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('service_extension_sweep');
      }
```

Match the `wrapScheduler(name, expectedIntervalSeconds, fn)` argument order to the sibling blocks exactly; verify by reading two of them.

- [ ] **Step 3: Write the test**

Create `server/utils/serviceExtensionSweep.test.js`. Stub `serviceExtensionNotify` and `getStripe`. Cover:
1. A pending row with `expires_at` in the past becomes `expired`, its invoice becomes `void`, and the decline notify was called with `outcome: 'declined'` and the correct `contractedEndDisplay`.
2. `proposals.event_duration_hours` is UNCHANGED by expiry.
3. A pending row with `expires_at` in the FUTURE is untouched.
4. An already-`paid` row is untouched and its invoice is not voided.
5. A row whose invoice is already `paid` does not get voided (the `status <> 'paid'` guard), while the extension still expires.
6. Two consecutive sweeps expire the row exactly once (`expired: 1` then `expired: 0`).
7. A row that throws mid-processing does not prevent a second eligible row from expiring: seed two expired rows on different proposals, force a failure on the first (e.g. stub `notifyStaffOfOutcome` to throw once), and assert the second still reached `expired`.

- [ ] **Step 4: Run it**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/serviceExtensionSweep.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm the scheduler wiring boots**

Run: `RUN_SCHEDULERS=false node --env-file=/home/drbartender/projects/os/.env -e "require('/home/drbartender/projects/os/server/index.js')" 2>&1 | head -20`

Expected: the server boots with no require error. `RUN_SCHEDULERS=false` keeps the timers off; this only proves the new `require` path and registration block parse. Kill it once it prints its listening line.

- [ ] **Step 6: Commit**

```bash
git add server/utils/serviceExtensionSweep.js server/utils/serviceExtensionSweep.test.js server/index.js
git commit -m "feat(ext): 60s expiry sweep behind RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER

Expires the request, voids the invoice, and sends the decline carrying the
insurance warning. The claim-on-pending gate is what makes the settle/expire
race single-winner."
```

- [ ] **Step 7: Lane gate**

Run every suite in this lane one at a time, plus every pre-existing webhook and payroll suite. Then the full fleet declared in front-matter.

---

## Lane ext-ui

Three surfaces. `ShiftDetail.js` (804 lines) and `InvoicePage.js` (373 lines) are both existing files: add the minimum to each and put real content in new components.

**Verification for every task in this lane:** the only thing that catches CI-fatal ESLint warnings locally is the exact Vercel build. After each task run:

```bash
cd /home/drbartender/projects/os/client && CI=true npx react-scripts build
```
Expected: exit 0. A warning here fails the real deploy, so treat it as a failure.

### Task 14: Staff request screen

**Files:**
- Create: `client/src/pages/staff/RequestMoreTime.js`
- Modify: `client/src/pages/staff/ShiftDetail.js` (entry button only)

**Interfaces:**
- Consumes: `GET /api/service-extensions/eligibility/:shiftId`, `POST /api/service-extensions` (Task 7).
- Produces: `<RequestMoreTime shiftId={...} onClose={...} />`, a modal/panel component.

- [ ] **Step 1: Build the component**

Create `client/src/pages/staff/RequestMoreTime.js`:

```javascript
import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';

/**
 * Staff-facing "request more time" panel (spec 2026-07-25 section 5.1).
 *
 * The staffer picks a NEW END TIME from a picker that opens on the contracted
 * end and steps in 30 minutes. NO PRICE is shown, and the API deliberately does
 * not return one (spec decision 2), so there is nothing here to leak.
 */
export default function RequestMoreTime({ shiftId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState(null);
  const [error, setError] = useState('');
  const [choiceHours, setChoiceHours] = useState(null);
  const [productConfirmed, setProductConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/service-extensions/eligibility/${shiftId}`);
      setEligibility(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load this event. Try again.');
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (choiceHours === null) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post('/service-extensions', {
        shiftId,
        requestedEndHours: choiceHours,
        hostedProductConfirmed: productConfirmed,
      });
      setSent(true);
    } catch (err) {
      const data = err.response?.data;
      setError(
        (data?.fields && Object.values(data.fields)[0])
        || data?.error
        || 'Could not send the request. Try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="sp-card"><div className="sp-skeleton" style={{ height: '4rem' }} /></div>;
  }

  if (sent) {
    return (
      <div className="sp-card">
        <div className="sp-detail-title">Request sent</div>
        <p className="sp-detail-sub">
          The client has been texted to confirm. You will get a message either way.
          Until then, bar service ends at the contracted time.
        </p>
        <button type="button" className="sp-btn sp-btn-sm" onClick={onClose}>Close</button>
      </div>
    );
  }

  const blocked = eligibility && !eligibility.eligible;
  const blockedCopy = {
    already_pending: 'A request for this event is already with the client.',
    too_early: 'You can request more time once the event has started.',
    too_late: 'The window to request more time for this event has closed.',
    unparseable_shift_time: 'We could not read this event’s times. Contact management.',
  };

  // Step the picker in 30-minute increments from the contracted end.
  const steps = [];
  if (eligibility) {
    const maxSteps = Math.round((eligibility.maxAdditionalHours || 3) / 0.5);
    for (let i = 1; i <= maxSteps; i++) steps.push(i * 0.5);
  }
  const baseHours = eligibility?.contractedDurationHours;

  return (
    <div className="sp-card">
      <div className="sp-detail-title">Request more time</div>
      <div className="sp-detail-sub">
        Bar service is contracted to end at {eligibility?.contractedEndDisplay || 'the scheduled time'}.
      </div>

      {blocked && (
        <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
          <div className="sp-error-card-msg">
            {blockedCopy[eligibility.reason] || 'More time cannot be requested for this event right now.'}
          </div>
        </div>
      )}

      {!blocked && (
        <>
          <fieldset style={{ border: 0, padding: 0, margin: '0.8rem 0' }}>
            <legend className="sp-detail-sub">New end time</legend>
            {steps.map((added) => (
              <label key={added} className="sp-row" style={{ gap: '0.5rem', padding: '0.35rem 0' }}>
                <input
                  type="radio"
                  name="ext-end"
                  checked={choiceHours === (baseHours + added)}
                  onChange={() => setChoiceHours(baseHours + added)}
                />
                <span>{eligibility.stepLabels?.[String(added)] || `+${added * 60} minutes`}</span>
              </label>
            ))}
          </fieldset>

          {eligibility?.isHosted && (
            <label className="sp-row" style={{ gap: '0.5rem', margin: '0.6rem 0' }}>
              <input
                type="checkbox"
                checked={productConfirmed}
                onChange={(e) => setProductConfirmed(e.target.checked)}
              />
              <span>I have the product to serve this extra time.</span>
            </label>
          )}

          {error && (
            <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
              <div className="sp-error-card-msg">{error}</div>
            </div>
          )}

          <div className="sp-row" style={{ gap: '0.5rem', marginTop: '0.8rem' }}>
            <button
              type="button"
              className="sp-btn sp-btn-sm"
              disabled={choiceHours === null || submitting || (eligibility?.isHosted && !productConfirmed)}
              onClick={submit}
            >
              {submitting ? 'Sending...' : 'Ask the client'}
            </button>
            <button type="button" className="sp-btn sp-btn-sm" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Return the step labels and base duration from the API**

The component needs `contractedDurationHours` and human labels. Go back to `server/routes/serviceExtensions/create.js` and add to the eligibility response:

```javascript
    contractedDurationHours: contracted,
    stepLabels: await (async () => {
      const labels = {};
      const maxSteps = Math.round(MAX_EXTENSION_HOURS / 0.5);
      for (let i = 1; i <= maxSteps; i++) {
        const added = i * 0.5;
        const e = await eventEndInstantForDuration(pool, ctx.proposal_id, contracted + added);
        if (e) labels[String(added)] = `${e.endDisplay} (+${added === 0.5 ? '30 min' : added + ' hr'})`;
      }
      return labels;
    })(),
```

These are times and durations, never money, so decision 2 still holds. Extend Task 7's eligibility test to assert `stepLabels` is present and still contains no price-like key.

- [ ] **Step 3: Add the entry point to ShiftDetail**

`ShiftDetail.js` is 804 lines, past the soft cap, so add ONLY a lazy import, one state flag, and a button. Do not add logic.

```javascript
const RequestMoreTime = React.lazy(() => import('./RequestMoreTime'));
```

State: `const [showExtend, setShowExtend] = useState(false);`

In the existing action-button row (the `sp-row` with `flexWrap: 'wrap'` near line 365), add:

```javascript
        <button type="button" className="sp-btn sp-btn-sm" onClick={() => setShowExtend((v) => !v)}>
          {showExtend ? 'Close' : 'Request more time'}
        </button>
```

And below that row:

```javascript
      {showExtend && (
        <React.Suspense fallback={<div className="sp-skeleton" style={{ height: '4rem' }} />}>
          <RequestMoreTime shiftId={shiftRow?.id} onClose={() => setShowExtend(false)} />
        </React.Suspense>
      )}
```

Use whatever the file's real shift-id variable is (it reads `shiftRow` in the code around line 349; confirm before wiring).

- [ ] **Step 4: Confirm the file did not grow past its cap**

Run: `node scripts/check-file-size.js --staged` after staging, and `wc -l client/src/pages/staff/ShiftDetail.js`.
Expected: still under 1000 and grown by roughly 10 lines. If the ratchet blocks, extract the action-button row into its own component rather than using `--no-verify`.

- [ ] **Step 5: Build and commit**

```bash
cd /home/drbartender/projects/os/client && CI=true npx react-scripts build
```
Expected: exit 0.

```bash
cd /home/drbartender/projects/os
git add client/src/pages/staff/RequestMoreTime.js client/src/pages/staff/ShiftDetail.js server/routes/serviceExtensions/create.js server/routes/serviceExtensions/create.test.js
git commit -m "feat(ext): staff request-more-time screen, price-free by construction"
```

### Task 15: Invoice page terms gate

**Files:**
- Modify: `client/src/pages/invoice/InvoicePage.js`

**Interfaces:**
- Consumes: the `extension` block on `GET /api/invoices/t/:token` (Task 8); `POST /api/service-extensions/t/:token/accept` (Task 8).
- Produces: no exports. Behavior: pay disabled until accepted; zero-delta shows Accept only.

- [ ] **Step 1: Add the terms block and gate**

Edit `client/src/pages/invoice/InvoicePage.js`. Add state:

```javascript
  // Service-extension terms gate (spec 2026-07-25 decision 8). Non-null only
  // for an extension invoice, so every ordinary invoice renders exactly as before.
  const [extension, setExtension] = useState(null);
  const [accepting, setAccepting] = useState(false);
```

Where the fetch sets the invoice, also `setExtension(res.data.extension || null);`.

Add the accept handler:

```javascript
  const acceptTerms = async () => {
    setAccepting(true);
    setFormError('');
    try {
      const res = await api.post(`/service-extensions/t/${token}/accept`);
      setExtension((prev) => ({ ...prev, accepted_at: res.data.acceptedAt, requires_acceptance: false }));
      // A zero-delta request settles on acceptance: nothing left to pay.
      if (!res.data.requiresPayment) setPaymentSuccess(true);
    } catch (err) {
      setFormError(err.response?.data?.error || 'Could not record your acceptance. Please try again.');
    } finally {
      setAccepting(false);
    }
  };
```

Render the terms above the payment section, and gate the pay control:

```javascript
      {extension?.is_extension && extension.terms && !paymentSuccess && (
        <section className="invoice-extension-terms">
          <h2>{extension.terms.headline}</h2>
          {extension.terms.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          {extension.requires_acceptance ? (
            <button type="button" className="btn" onClick={acceptTerms} disabled={accepting}>
              {accepting
                ? 'Confirming...'
                : (extension.requires_payment ? 'Accept and continue to payment' : 'Accept')}
            </button>
          ) : (
            <p className="invoice-extension-accepted">Accepted. Thank you.</p>
          )}
        </section>
      )}
```

Then gate the existing payment reveal so an extension invoice cannot show the payment element before acceptance. Find where `showPayment` is set true and add the guard:

```javascript
  const paymentBlockedByTerms = Boolean(extension?.is_extension && extension.requires_acceptance);
```
and use `{showPayment && !paymentBlockedByTerms && ( ... )}` on the payment section, plus `disabled={paymentBlockedByTerms}` on whatever button reveals it.

- [ ] **Step 2: Add the CSS**

Add to `client/src/index.css` (vanilla CSS, no modules), near the other `invoice-` rules:

```css
.invoice-extension-terms {
  border: 1px solid var(--border, #ddd);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin: 1.25rem 0;
}
.invoice-extension-terms h2 { margin-top: 0; font-size: 1.15rem; }
.invoice-extension-terms p { font-size: 0.92rem; line-height: 1.5; }
.invoice-extension-accepted { font-weight: 600; }
```

Add `client/src/index.css` to the `ext-ui` lane footprint in this plan's front-matter before committing, so the footprint-drift check does not abort the lane.

- [ ] **Step 3: Verify against a real extension invoice**

The dev server is a Claude-managed background process with no auto-reload for server edits: restart it after the server-side tasks. Then create a pending extension against a dev proposal (reuse the `create.test.js` fixture pattern via a scratch script in the scratchpad directory), open `/invoice/<token>`, and confirm:
1. The terms block renders and the pay control is unavailable.
2. Clicking Accept enables payment.
3. An ORDINARY Balance invoice's page is visually unchanged and pays as before. This is the regression that matters most: this page is every client's payment surface.

Take screenshots with the mobile-check harness (`playwright-core`, screenshots into the scratchpad directory) at 390px width as well, since clients open these on phones.

- [ ] **Step 4: Build and commit**

```bash
cd /home/drbartender/projects/os/client && CI=true npx react-scripts build
```
Expected: exit 0.

```bash
cd /home/drbartender/projects/os
git add client/src/pages/invoice/InvoicePage.js client/src/index.css
git commit -m "feat(ext): terms gate on the invoice page, inert for ordinary invoices"
```

### Task 16: Admin extensions panel

**Files:**
- Create: `client/src/components/adminos/ServiceExtensionPanel.js`
- Modify: `client/src/pages/admin/EventDetailPage.js`

**Interfaces:**
- Consumes: `GET /api/service-extensions/proposal/:proposalId`, `POST /:id/override`, `POST /:id/cancel` (Task 10).
- Produces: `<ServiceExtensionPanel proposalId={...} />`. Renders nothing when there are no extensions.

- [ ] **Step 1: Build the panel**

Create `client/src/components/adminos/ServiceExtensionPanel.js` with:
- A load on mount via `api.get(\`/service-extensions/proposal/${proposalId}\`)`, with loading skeleton and an error state that offers Retry.
- **Renders `null` when `extensions.length === 0`** (spec: empty state is a hidden panel, no new top-level page).
- One row per extension: status chip, requester name, `contracted_end_time` to `requested_end_time`, the amount formatted from `amount_cents`, accepted-at, and the invoice status.
- On a `pending` row: a Cancel button, and an Override button that opens a required-reason textarea (min 3 chars, max 500, matching the server rule) and warns inline that overriding grants the time with no charge and voids the invoice.
- After either action, re-load and surface `payrollWarning` from the response as a visible banner when present, since a silently underpaid bartender is the failure mode this warning exists to prevent.
- Money is shown here on purpose: this is the admin surface, unlike every staff surface.
- No em dashes in any string.

- [ ] **Step 2: Mount it on the event detail page**

Edit `client/src/pages/admin/EventDetailPage.js`. Import the panel and render it in the existing detail column, passing the proposal id the page already has. Check the page's current size first (`wc -l client/src/pages/admin/EventDetailPage.js`); if adding the import and one JSX line pushes it over a cap, mount the panel from a lower-level section component instead.

- [ ] **Step 3: Verify in the app**

With a pending extension seeded on a dev event, open the admin event page and confirm: the panel lists the request, Cancel voids it and flips the row to cancelled, Override requires a reason, and after an override the invoice shows `void` and the duration reflects the new end. Confirm the panel is absent entirely on an event with no extensions.

- [ ] **Step 4: Build and commit**

```bash
cd /home/drbartender/projects/os/client && CI=true npx react-scripts build
```
Expected: exit 0.

```bash
cd /home/drbartender/projects/os
git add client/src/components/adminos/ServiceExtensionPanel.js client/src/pages/admin/EventDetailPage.js
git commit -m "feat(ext): admin extensions panel with override, cancel, and the payroll warning"
```

- [ ] **Step 5: Lane gate**

Full fleet per front-matter, including `ui-ux-review` on the three surfaces at 390px.

---

## Lane ext-docs

### Task 17: Mandatory documentation updates

Per the mandatory-updates table, every one of these is required, not optional.

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `.claude/CLAUDE.md`, `.env.example`

- [ ] **Step 1: README.md**

Add to the folder-structure tree: `server/routes/serviceExtensions/` (create, publicAccept, admin), `server/utils/serviceExtension{Pricing,Settle,Notify,Sweep,Payroll}.js`, `server/utils/eventEndInstant.js`, `server/data/extensionTermsCopy.js`, `client/src/pages/staff/RequestMoreTime.js`, `client/src/components/adminos/ServiceExtensionPanel.js`.

Add to Key Features: on-site service extension (staff-initiated added bar time, client accepts coverage terms and pays on the invoice page, duration and payroll hours move, side money).

- [ ] **Step 2: ARCHITECTURE.md**

Add to the API route table: the five new endpoints plus the two modified ones (`GET /api/invoices/t/:token` gains the extension block; `POST /api/stripe/create-intent-for-invoice/:token` gains the acceptance gate).

Add `service_extensions` to the Database Schema section with its columns and the partial unique index.

Add a short note in the money/invoicing section recording that `OFF_LEDGER_INVOICE_LABELS` is now non-empty and what that flips (webhook `amount_paid` skip, invoice-refresh exclusion, refund-reconciliation skip), plus the reason extension money is deliberately outside `CONTRACT_LABELS`.

- [ ] **Step 3: CLAUDE.md env table**

Add one row:

| `RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER` | Optional. Set to `false` to disable the 60-second service-extension expiry sweep (expires a pending request past its grace window, voids its invoice, sends the staff decline). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |

- [ ] **Step 4: .env.example**

Add the same variable with a brief comment, matching the file's existing style.

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md .claude/CLAUDE.md .env.example
git commit -m "docs(ext): README tree, ARCHITECTURE routes + schema, env var for the sweep"
```

### Task 18: Revenue-reporting enumeration (spec §12)

The spec names this as the one real cost of going off-ledger and explicitly defers the per-surface decision to the plan, so it needs a task rather than an assumption. Extension revenue lives in `proposal_payments` and `invoices` but NOT in `proposals.amount_paid`. Any surface that totals revenue from `amount_paid` will under-report it; any surface that sums payments will include it. Neither is wrong, but the split has to be known rather than discovered later from a number that looks off.

This task produces a decision record, not a refactor. Any code change it identifies gets raised as its own item.

**Files:**
- Modify: `docs/fix-list-remaining-2026-07-02.md` (record findings + any follow-ups)

- [ ] **Step 1: Enumerate the revenue surfaces**

```bash
cd /home/drbartender/projects/os
grep -rn "amount_paid" server/routes/admin/ server/routes/proposals/ --include=*.js | grep -v test | grep -iE "sum|total|revenue|collected"
grep -rln "dashboard-stats\|financials\|metrics" server/routes --include=*.js | grep -v test
```

For each hit, write down: the surface name, whether it totals from `amount_paid` or from `proposal_payments` / `invoices`, and therefore whether extension revenue appears in it.

- [ ] **Step 2: Check the Money Board specifically**

The Money Board is the surface most likely to matter. Read its endpoint and record which basis it uses. Also check the Stripe payout matching path, since an extension payment is a real Stripe charge that will appear in a payout and must reconcile.

```bash
grep -rn "amount_paid\|proposal_payments" server/routes/admin/*.js | grep -v test | head -20
```

- [ ] **Step 3: Decide per surface and record it**

For each surface, pick one and write the reason:
- **Leave as is** (it sums payments, so extensions are already included), or
- **Leave as is with a known gap** (it sums `amount_paid`; extensions are excluded and that is acceptable because the surface is about contract performance), or
- **Needs a fix** (the surface claims to show total collected revenue and would be materially wrong).

Append the findings to the fix list under a new heading, "Service-extension revenue reporting (added when the feature shipped)", including the explicit warning: do NOT resolve any discrepancy by rolling the extension payment into `amount_paid`, because that reintroduces the landmine in spec §2 (it would falsely satisfy the funded-gratuity gate and the auto-complete gate).

- [ ] **Step 4: Commit**

```bash
git add docs/fix-list-remaining-2026-07-02.md
git commit -m "docs(ext): enumerate which revenue surfaces include extension money"
```

---

## Spec coverage map

Every spec section, and the task that implements it. Written so a reviewer can check coverage without re-reading the spec.

| Spec | Task |
|---|---|
| D1 staff portal initiates | 7, 14 |
| D2 staff never see the price | 7 (explicit field list + leak tests), 14 |
| D3 no permission gate, assignment predicate instead | 7 |
| D4 hosted product confirmation | 7, 14 |
| D5 new end time, 30-min steps, +3h cap | 4, 14 |
| D6 engine delta, gratuity rides along | 4 |
| D7 regular invoice page | 15 |
| D8 terms accepted before paying, server-enforced | 8, 9 |
| D9 unpaid is a hard stop | 13 |
| D10 contract does not move until settle | 7, 11 |
| D11 SERVICE ends at the contracted time | 6 (copy) |
| D12 side money, off-ledger, no dunning ever | 2, 11 (no-dunning test), 10, 18 |
| D13 zero-delta settles on acceptance | 4, 8 |
| D14 override grants time, no receivable | 10 |
| §5.2 client sends through suppression, admins notified | 6, 7 |
| §5.5 expiry sweep with kill switch | 13 |
| §7 targeted shift sync, multi-shift flagged | 5 |
| §7 paid-after-expiry containment | 11 |
| §7 completed/archived settle does not throw | 11 |
| §8 `service_extensions` table + indexes | 2 |
| §8 versioned terms registry | 3 |
| §8 routes | 7, 8, 9, 10 |
| §8 admin surfaces | 10 (API), 16 (UI) |
| §8 activity log + admin audit log | 5, 7, 10 |
| §8 mandatory docs | 17 |
| §9 payroll hours re-seed + gratuity addend | 12 |
| §10 copy and channel gates | 6 |
| §11 timezone-correct instants | 1 |
| §11 authoritative contracted end (proposal-derived) | 4, 7, 11 (edge case) |
| §11 second extension baseline | 4 |
| §12 cross-cutting consistency | 5, 11, 12, 18 |
| §12 revenue reporting split | 18 |
| §13 test matrix | distributed; every task carries its slice |

Deliberately not built, and why: nothing. The spec's own open items (the broker question and the signed-document copy) are tracked on the fix list and are not code.
