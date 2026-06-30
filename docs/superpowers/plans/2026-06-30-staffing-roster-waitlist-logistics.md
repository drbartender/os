# Staffing Roster, Waitlist, and Logistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive shift slots from the full paid roster (bartenders + banquet servers + barbacks), add a computed waitlist with self-removal and an admin bench view, and surface equipment/supply transport requirements to staff before they request.

**Architecture:** A shared vocabulary + parsing + classification layer (Lane 1) underpins everything. The server roster engine (Lane 2) builds `positions_needed` from the proposal; the cover/drop marketplace (Lane 3) and staff/admin queries (Lane 4) adopt the canonical labels and a per-role aggregate; the approval path (Lane 5) becomes the money seam where `position` is resolved and written. Staff (Lane 6) and admin (Lane 7) UIs consume the per-role data; notifications (Lane 8), a one-time backfill (Lane 9), and docs (Lane 10) finish it.

**Tech Stack:** Node.js/Express, raw SQL via `pg` (no ORM), React 18 (CRA), vanilla CSS, Resend (email), node:test.

## Global Constraints

Copied verbatim from the spec and CLAUDE.md; every task implicitly includes these.

- Canonical role labels: `Bartender`, `Banquet Server`, `Barback`. All role comparisons are case-insensitive; `LOWER(position) = 'bartender'` is load-bearing for payroll.
- `positions_needed` exists in two shapes in prod (flat `["Bartender"]` and object `[{position,count}]`); always parse with the shared shape-tolerant parser, never bare `JSON.parse`.
- Bartender headcount = `proposals.num_bartenders` + `additional-bartender` add-on headcount (additive, never substitute). Per-slug hours divisor: `additional-bartender` ÷ `durationHours`; `banquet-server`/`barback` ÷ `max(durationHours, 4)`; `Math.round`.
- No money path reads `positions_needed`; gratuity comes from `pricing_snapshot`, the tip split from `shift_requests` rows with `LOWER(position)='bartender'`. The `position` column is the only money-sensitive field here.
- Raw parameterized SQL (`$1`), no string concatenation. Throw `AppError` subclasses, never `res.status(4xx).json`. Money in integer cents (not relevant here; staffing counts are integers). Schema changes idempotent. API JSON keys snake_case, JS camelCase.
- No em dashes in client copy or comments. NA beer = Athletic only (not relevant here).
- Server suites run one at a time with `node -r dotenv/config`. Client verified with `CI=true react-scripts build`.
- File-size ratchet: hard cap 1000 lines, blocks a commit that grows an over-cap file. `server/routes/shifts.js` is near the cap; if a task would push it over, extract handlers per the `server/routes/proposals/` pattern first.

---

## Lane Map

```yaml
lanes:
  - id: L1-foundation
    title: Vocabulary, parsing, classification, schema, migration
    footprint:
      - server/utils/staffingRoles.js
      - server/utils/positionsNeeded.js
      - server/utils/staffingClassification.js
      - client/src/utils/staffingRoles.js
      - server/db/schema.sql
      - scripts/migrate-staffing-roles.js
      - server/utils/__tests__/staffing*.test.js
    deps: []
    review: full   # schema migration + money-adjacent position normalization

  - id: L2-roster-engine
    title: deriveStaffingRoster, create/sync wiring, supply-run default, auto-assign scoping
    footprint:
      - server/utils/eventCreation.js
      - server/utils/autoAssign.js
      - server/utils/__tests__/eventCreation.roster.test.js
    deps: [L1-foundation]
    review: full   # feeds the Stripe webhook; money-adjacent

  - id: L3-cover-canonical
    title: Cover/drop marketplace canonical + case-insensitive matching
    footprint:
      - server/utils/coverBroadcast.js
      - server/routes/staffShiftActions.js
      - server/utils/__tests__/coverBroadcast.canonical.test.js
    deps: [L1-foundation]
    review: full   # the marketplace Goals pledged not to disturb

  - id: L4-queries
    title: Per-role approved aggregate + PII narrowing in staff/admin queries
    footprint:
      - server/routes/shifts.queries.js
    deps: [L1-foundation]
    review: standard+security   # PII projection

  - id: L5-request-approval
    title: Request endpoint, position resolution at approval (money seam), logistics-edit endpoint
    footprint:
      - server/routes/shifts.js
      - server/routes/__tests__/shifts.approval.test.js
    deps: [L1-foundation, L4-queries, L8-notify]
    review: full   # the money seam; highest-risk lane

  - id: L6-staff-ui
    title: Staff tabs, per-role card, ranked request sheet, waitlist state, logistics tag
    footprint:
      - client/src/pages/staff/ShiftsPage.js
      - client/src/components/staff/RequestSheet.js
      - client/src/components/staff/RoleRankPicker.js
      - client/src/components/staff/LogisticsTag.js
      - client/src/components/staff/ShiftCard.js
    deps: [L1-foundation, L4-queries, L5-request-approval]
    review: standard+client-ci

  - id: L7-admin-ui
    title: ShiftDrawer split + client-side position resolution, waitlist chip, logistics edit
    footprint:
      - client/src/components/adminos/drawers/ShiftDrawer.js
      - client/src/components/adminos/shifts.js
      - client/src/pages/admin/EventDetailPage.js
      - client/src/pages/admin/EventsDashboard.js
    deps: [L1-foundation, L4-queries, L5-request-approval]
    review: full+client-ci   # ShiftDrawer approval resolution = client money seam

  - id: L8-notify
    title: Waitlist-join email template, renderBartenderList role copy
    footprint:
      - server/utils/marketingEmailTemplates.js   # or a staffing template sibling; see task
      - server/utils/lastMinuteStaffingConfirmation.js
    deps: [L1-foundation]
    review: standard

  - id: L9-backfill
    title: One-time positions_needed re-derive script (dry-run + apply)
    footprint:
      - scripts/backfill-positions-needed.js
    deps: [L2-roster-engine]
    review: full   # mutates prod staffing data; run is a manual ops step

  - id: L10-docs
    title: ARCHITECTURE + README updates
    footprint:
      - ARCHITECTURE.md
      - README.md
    deps: [L1-foundation, L2-roster-engine, L5-request-approval, L6-staff-ui, L7-admin-ui]
    review: light
```

**Run order / parallelism:** L1 first (blocks all). Then L2, L3, L4, L8 in parallel. Then L5 (needs L4 + L8). Then L6 and L7 in parallel (need L5). L9 after L2 (can run alongside L5/L6/L7). L10 last. The `position` normalization in L1 must land before L2/L3/L5 touch role data, and before the `position` CHECK is added (the CHECK is part of L1, applied after the normalization within the same lane).

---

## Lane 1: Foundation (vocabulary, parsing, classification, schema, migration)

**Files:**
- Create: `server/utils/staffingRoles.js`
- Create: `server/utils/positionsNeeded.js`
- Create: `server/utils/staffingClassification.js`
- Create: `client/src/utils/staffingRoles.js` (ESM mirror, like `eventTypes.js`)
- Modify: `server/db/schema.sql` (append idempotent columns + CHECK + seed)
- Create: `scripts/migrate-staffing-roles.js` (one-time normalization + backfill + CHECK)
- Test: `server/utils/__tests__/staffingRoles.test.js`, `staffingClassification.test.js`, `positionsNeeded.test.js`

**Interfaces (Produced):**
- `staffingRoles.js` (CJS): `ROLES = { BARTENDER:'Bartender', BANQUET_SERVER:'Banquet Server', BARBACK:'Barback' }`; `CANONICAL_LABELS = ['Bartender','Banquet Server','Barback']`; `canonicalizeRole(value) -> 'Bartender'|'Banquet Server'|'Barback'|null`; `isBartender(position) -> boolean`.
- `positionsNeeded.js`: `parsePositionsNeeded(raw) -> string[]` (canonical labels); `rosterCounts(positionsArray) -> { [role]: number }`.
- `staffingClassification.js`: `computeRemaining(positionsNeeded, approvedByRole) -> { [role]: number }`; `classifyRequest(requestedPositions, remaining) -> { state:'actionable'|'waitlisted', resolvableRole: string|null }`; `isEventFullyStaffed(remaining) -> boolean`.
- `client/src/utils/staffingRoles.js` (ESM): same names as the three server modules combined.

- [ ] **Step 1: Write failing test for `canonicalizeRole`**

```js
// server/utils/__tests__/staffingRoles.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { canonicalizeRole, isBartender } = require('../staffingRoles');

test('canonicalizeRole maps case + legacy Server', () => {
  assert.equal(canonicalizeRole('bartender'), 'Bartender');
  assert.equal(canonicalizeRole('BARTENDER'), 'Bartender');
  assert.equal(canonicalizeRole('Server'), 'Banquet Server');
  assert.equal(canonicalizeRole('banquet server'), 'Banquet Server');
  assert.equal(canonicalizeRole('Barback'), 'Barback');
  assert.equal(canonicalizeRole('  bartender '), 'Bartender');
  assert.equal(canonicalizeRole('chef'), null);
  assert.equal(canonicalizeRole(null), null);
});

test('isBartender is case-insensitive', () => {
  assert.equal(isBartender('bartender'), true);
  assert.equal(isBartender('Bartender'), true);
  assert.equal(isBartender('Banquet Server'), false);
});
```

- [ ] **Step 2: Run, verify fail** — `node -r dotenv/config --test server/utils/__tests__/staffingRoles.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `staffingRoles.js`**

```js
// server/utils/staffingRoles.js
const ROLES = { BARTENDER: 'Bartender', BANQUET_SERVER: 'Banquet Server', BARBACK: 'Barback' };
const CANONICAL_LABELS = [ROLES.BARTENDER, ROLES.BANQUET_SERVER, ROLES.BARBACK];

function canonicalizeRole(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'bartender') return ROLES.BARTENDER;
  if (v === 'banquet server' || v === 'server') return ROLES.BANQUET_SERVER;
  if (v === 'barback') return ROLES.BARBACK;
  return null;
}

function isBartender(position) {
  return typeof position === 'string' && position.trim().toLowerCase() === 'bartender';
}

module.exports = { ROLES, CANONICAL_LABELS, canonicalizeRole, isBartender };
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Write failing test for `parsePositionsNeeded` (both shapes)**

```js
// server/utils/__tests__/positionsNeeded.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parsePositionsNeeded, rosterCounts } = require('../positionsNeeded');

test('parses flat string array', () => {
  assert.deepEqual(parsePositionsNeeded('["Bartender","Bartender","Banquet Server"]'),
    ['Bartender', 'Bartender', 'Banquet Server']);
});
test('parses legacy object array and canonicalizes', () => {
  assert.deepEqual(parsePositionsNeeded([{ position: 'bartender', count: 2 }, { position: 'Server', count: 1 }]),
    ['Bartender', 'Bartender', 'Banquet Server']);
});
test('malformed -> []', () => {
  assert.deepEqual(parsePositionsNeeded('not json'), []);
  assert.deepEqual(parsePositionsNeeded(null), []);
});
test('rosterCounts tallies per role', () => {
  assert.deepEqual(rosterCounts(['Bartender', 'Bartender', 'Banquet Server']),
    { Bartender: 2, 'Banquet Server': 1 });
});
```

- [ ] **Step 6: Run, verify fail.**

- [ ] **Step 7: Implement `positionsNeeded.js`** (generalize `coverBroadcast.parsePositionsNeeded`; canonicalize every entry)

```js
// server/utils/positionsNeeded.js
const { canonicalizeRole } = require('./staffingRoles');

function parsePositionsNeeded(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const entry of arr) {
    if (entry && typeof entry === 'object' && 'position' in entry) {
      const role = canonicalizeRole(entry.position);
      const count = Math.max(0, Number(entry.count) || 0);
      for (let i = 0; i < count; i++) if (role) out.push(role);
    } else {
      const role = canonicalizeRole(entry);
      if (role) out.push(role);
    }
  }
  return out;
}

function rosterCounts(positionsArray) {
  const counts = {};
  for (const role of positionsArray) counts[role] = (counts[role] || 0) + 1;
  return counts;
}

module.exports = { parsePositionsNeeded, rosterCounts };
```

- [ ] **Step 8: Run, verify pass.**

- [ ] **Step 9: Write failing test for classification**

```js
// server/utils/__tests__/staffingClassification.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { computeRemaining, classifyRequest, isEventFullyStaffed } = require('../staffingClassification');

test('computeRemaining = needed - approved per role', () => {
  assert.deepEqual(
    computeRemaining(['Bartender', 'Bartender', 'Banquet Server'], { Bartender: 2 }),
    { Bartender: 0, 'Banquet Server': 1 });
});
test('classify actionable picks top ranked open role', () => {
  const r = { Bartender: 0, 'Banquet Server': 1 };
  assert.deepEqual(classifyRequest(['Bartender', 'Banquet Server'], r),
    { state: 'actionable', resolvableRole: 'Banquet Server' });
});
test('classify waitlisted when no ranked role open', () => {
  assert.deepEqual(classifyRequest(['Bartender'], { Bartender: 0, 'Banquet Server': 1 }),
    { state: 'waitlisted', resolvableRole: null });
});
test('empty requested = any role', () => {
  assert.deepEqual(classifyRequest([], { Bartender: 0, 'Banquet Server': 1 }),
    { state: 'actionable', resolvableRole: 'Banquet Server' });
});
test('fully staffed when all <= 0', () => {
  assert.equal(isEventFullyStaffed({ Bartender: 0, 'Banquet Server': 0 }), true);
  assert.equal(isEventFullyStaffed({ Bartender: 0, 'Banquet Server': 1 }), false);
});
```

- [ ] **Step 10: Run, verify fail.**

- [ ] **Step 11: Implement `staffingClassification.js`**

```js
// server/utils/staffingClassification.js
const { rosterCounts } = require('./positionsNeeded');

function computeRemaining(positionsNeeded, approvedByRole = {}) {
  const needed = rosterCounts(positionsNeeded);
  const remaining = {};
  for (const role of Object.keys(needed)) {
    remaining[role] = needed[role] - (approvedByRole[role] || 0);
  }
  return remaining;
}

function classifyRequest(requestedPositions, remaining) {
  const ranked = (Array.isArray(requestedPositions) && requestedPositions.length)
    ? requestedPositions
    : Object.keys(remaining); // empty = any role, in roster order
  for (const role of ranked) {
    if ((remaining[role] || 0) > 0) return { state: 'actionable', resolvableRole: role };
  }
  return { state: 'waitlisted', resolvableRole: null };
}

function isEventFullyStaffed(remaining) {
  return Object.values(remaining).every((n) => n <= 0);
}

module.exports = { computeRemaining, classifyRequest, isEventFullyStaffed };
```

- [ ] **Step 12: Run, verify pass. Commit** (`feat(staffing): canonical roles, shape-tolerant parser, classification helpers`).

- [ ] **Step 13: Mirror to client** — create `client/src/utils/staffingRoles.js` exporting the same functions as ESM (one file combining all three). Keep logic identical (manual sync, like `server/utils/eventTypes.js` ↔ `client/src/utils/eventTypes.js`). Add a header comment: `// Mirror of server/utils/staffingRoles.js + positionsNeeded.js + staffingClassification.js; keep in sync manually.` Commit.

- [ ] **Step 14: Schema columns + CHECK + seed (append to `schema.sql`, idempotent)**

```sql
-- Staffing roster + waitlist + logistics
ALTER TABLE shift_requests ADD COLUMN IF NOT EXISTS requested_positions TEXT DEFAULT '[]';
ALTER TABLE shift_requests ADD COLUMN IF NOT EXISTS transport_acknowledged_at TIMESTAMP;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS supply_run_required BOOLEAN DEFAULT false;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS supply_run_overridden BOOLEAN DEFAULT false;
ALTER TABLE service_addons ADD COLUMN IF NOT EXISTS requires_provisioning BOOLEAN DEFAULT false;
-- case-insensitive position CHECK (added by the migration script AFTER normalization)
```

The `position` CHECK is NOT added inline here (it would fail on existing non-canonical rows). It is added by the migration script (Step 16) which normalizes first. Document this in a `schema.sql` comment.

- [ ] **Step 15: Seed `requires_provisioning`** (append to `schema.sql`; derive the COMPLETE list by reading the current `service_addons` catalog: every consumable/gear add-on TRUE, the staffing and pure-fee add-ons FALSE)

```sql
UPDATE service_addons SET requires_provisioning = true WHERE slug IN (
  'ice-delivery-only','bottled-water-only','signature-mixers-only','full-mixers-only',
  'garnish-package-only','cups-disposables-only','soft-drink-addon','zero-proof-spirits',
  'non-alcoholic-beer','champagne-toast','pre-batched-mocktail','mocktail-bar',
  'house-made-ginger-beer','carbonated-cocktails','flavor-blaster-rental','handcrafted-syrups',
  'handcrafted-syrups-3pack','real-glassware','champagne-coupe-upgrade','smoked-cocktail-kit',
  'specialty-mezcal','specialty-bitter-aperitifs','specialty-vermouths','specialty-niche-liqueurs',
  'specialty-cognac','class-tool-kit-rental','class-tool-kit-purchase'
);
-- At build, run `SELECT slug,name,category FROM service_addons ORDER BY slug` and confirm every
-- physical/consumable add-on is listed and only staffing/fee add-ons are omitted.
```

- [ ] **Step 16: Migration script** `scripts/migrate-staffing-roles.js` — ordered: (1) print `SELECT DISTINCT position` from `shift_requests` and `contractor_profiles`; (2) normalize both columns to canonical via `canonicalizeRole` (parameterized `UPDATE ... WHERE position ...`); (3) backfill `requested_positions = to_jsonb(ARRAY[position])` where `position IS NOT NULL AND (requested_positions IS NULL OR requested_positions = '[]')`; (4) add the CHECK via `ALTER TABLE shift_requests DROP CONSTRAINT IF EXISTS shift_requests_position_canonical; ALTER TABLE shift_requests ADD CONSTRAINT shift_requests_position_canonical CHECK (position IS NULL OR LOWER(position) IN ('bartender','banquet server','barback'));`. Wrap in a transaction. Support `--dry-run` (print counts, no writes). Idempotent.

- [ ] **Step 17: Apply schema + migration to the dev DB by hand** (schema.sql is not auto-applied to dev). Run the `ALTER`s, then `node -r dotenv/config scripts/migrate-staffing-roles.js --dry-run`, review, then without `--dry-run`. Commit the lane.

---

## Lane 2: Roster engine

**Files:**
- Modify: `server/utils/eventCreation.js` (`createEventShifts`, `syncShiftsFromProposal`; add `deriveStaffingRoster`, `computeSupplyRunDefault`)
- Modify: `server/utils/autoAssign.js` (scope to Bartender)
- Test: `server/utils/__tests__/eventCreation.roster.test.js`

**Interfaces:**
- Consumes: `parsePositionsNeeded`, `ROLES`, `canonicalizeRole` (L1).
- Produces: `deriveStaffingRoster(proposal, snapshot) -> string[]`; `computeSupplyRunDefault(snapshot, provisioningSlugs:Set<string>) -> boolean`.

- [ ] **Step 1: Failing test for `deriveStaffingRoster`** (cover hosted ratio via num_bartenders, additional-bartender add-on additive, servers, barbacks, per-slug divisor on a sub-4-hour event, snapshot-missing fallback). Build the proposal/snapshot fixtures from `pricingEngine` output shapes.

```js
const { deriveStaffingRoster } = require('../eventCreation');
test('roster = bartenders(+addon) then servers then barbacks', () => {
  const proposal = { num_bartenders: 2, event_duration_hours: 5 };
  const snapshot = { package: { pricing_type: 'per_guest' }, addons: [
    { slug: 'additional-bartender', quantity: 5 },   // 5h / 5h = 1
    { slug: 'banquet-server', quantity: 5 },          // 5h / max(5,4)=5 = 1
    { slug: 'barback', quantity: 8 },                 // 8h / max(5,4)=5 -> round = 2 (example)
  ]};
  assert.deepEqual(deriveStaffingRoster(proposal, snapshot),
    ['Bartender', 'Bartender', 'Bartender', 'Banquet Server', 'Barback', 'Barback']);
});
test('sub-4h class: additional-bartender divides by durationHours not max', () => {
  const proposal = { num_bartenders: 1, event_duration_hours: 2 };
  const snapshot = { package: { pricing_type: 'per_guest' }, addons: [
    { slug: 'additional-bartender', quantity: 2 },    // 2h / 2h = 1 (NOT /4)
  ]};
  assert.deepEqual(deriveStaffingRoster(proposal, snapshot), ['Bartender', 'Bartender']);
});
test('missing snapshot -> num_bartenders only', () => {
  assert.deepEqual(deriveStaffingRoster({ num_bartenders: 3 }, null),
    ['Bartender', 'Bartender', 'Bartender']);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `deriveStaffingRoster` + helpers in `eventCreation.js`**

```js
function addonHeadcount(snapshot, slug, durationHours) {
  const addons = (snapshot && Array.isArray(snapshot.addons)) ? snapshot.addons : [];
  const divisor = slug === 'additional-bartender'
    ? Math.max(1, Number(durationHours) || 1)
    : Math.max(Number(durationHours) || 0, 4);
  return addons.filter(a => a.slug === slug)
    .reduce((sum, a) => sum + Math.max(0, Math.round((Number(a.quantity) || 0) / divisor)), 0);
}

function deriveStaffingRoster(proposal, snapshot) {
  const dur = Number(proposal && proposal.event_duration_hours) || 0;
  const bartenders = (Number(proposal && proposal.num_bartenders) || 1)
    + addonHeadcount(snapshot, 'additional-bartender', dur);
  const servers = addonHeadcount(snapshot, 'banquet-server', dur);
  const barbacks = addonHeadcount(snapshot, 'barback', dur);
  const out = [];
  for (let i = 0; i < bartenders; i++) out.push('Bartender');
  for (let i = 0; i < servers; i++) out.push('Banquet Server');
  for (let i = 0; i < barbacks; i++) out.push('Barback');
  return out;
}
```

Wrap any snapshot access in try/catch returning the `num_bartenders`-only roster, so a malformed snapshot inside the Stripe webhook can never throw.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Failing test for `computeSupplyRunDefault`** (hosted -> true; provisioning addon present -> true; neither -> false). Then implement:

```js
function computeSupplyRunDefault(snapshot, provisioningSlugs) {
  if (snapshot && snapshot.package && snapshot.package.pricing_type === 'per_guest') return true;
  const addons = (snapshot && Array.isArray(snapshot.addons)) ? snapshot.addons : [];
  return addons.some(a => provisioningSlugs.has(a.slug));
}
```

- [ ] **Step 6: Wire into `createEventShifts`** — replace `Array(numBartenders).fill('Bartender')` with `deriveStaffingRoster(proposal, snapshot)`; load `provisioningSlugs` once (`SELECT slug FROM service_addons WHERE requires_provisioning = true`) and set `supply_run_required = computeSupplyRunDefault(snapshot, slugs)` in the INSERT.

- [ ] **Step 7: Wire into `syncShiftsFromProposal`** — rebuild `positions_needed` from `deriveStaffingRoster`, **per-role shrink-capped**: for each role, `desired[role] = max(rosterCounts(roster)[role], approvedActiveByRole[role])`; reconstruct the array; log `staffing_shrink_capped` per role when capped. Recompute `supply_run_required` ONLY when `supply_run_overridden = false`.

- [ ] **Step 8: Failing test + fix for per-role shrink-cap** (an event with 2 approved servers whose proposal now lists 1 keeps 2 server slots and logs).

- [ ] **Step 9: Scope `autoAssign` to Bartender** — `slotsRemaining = rosterCounts(parsed)['Bartender'] - approvedBartenders`; filter candidates to those whose `requested_positions` include `Bartender`; write `position = 'Bartender'`. Add a test that a server-only requester is never auto-assigned and a bartender is. Commit the lane.

---

## Lane 3: Cover/drop canonical matching

**Files:**
- Modify: `server/utils/coverBroadcast.js` (use shared `parsePositionsNeeded`; canonical case-insensitive candidate match)
- Modify: `server/routes/staffShiftActions.js` (claim-eligibility gate uses canonical compare)
- Test: `server/utils/__tests__/coverBroadcast.canonical.test.js`

**Interfaces:** Consumes `parsePositionsNeeded`, `canonicalizeRole` (L1).

- [ ] **Step 1: Failing test** — a shift with `positions_needed = ["Banquet Server"]` broadcasts to a candidate whose `contractor_profiles.position = 'Server'` (post-migration `'Banquet Server'`), and a claimer with `position='banquet server'` passes the eligibility gate. Assert the SQL/JS compares canonical + case-insensitive (no exact-string miss).

- [ ] **Step 2: Replace** `coverBroadcast.js:148` exact `cp.position = ANY($2)` with a canonical compare: pass `parsePositionsNeeded(shift.positions_needed)` mapped through `canonicalizeRole` as `$2`, and compare `canonicalizeRole(cp.position)` — since SQL can't call JS, lower-case both sides in SQL: `LOWER(cp.position) = ANY($2)` where `$2` is the lower-cased canonical roster. Verify `contractor_profiles.position` was normalized by L1 so legacy `'Server'` is already `'Banquet Server'`.

- [ ] **Step 3: Update `staffShiftActions.js:566`** claim gate (`positionsNeededList.includes(claimerPosition)`) to compare `canonicalizeRole(claimerPosition)` against the canonical roster from `parsePositionsNeeded`.

- [ ] **Step 4: Run tests, verify pass. Commit.**

---

## Lane 4: Per-role aggregate + PII narrowing

**Files:** Modify `server/routes/shifts.queries.js`.

**Interfaces (Produced):** the staff feed and admin shift queries return `approved_by_role` (JSON object `{role: count}`, approved AND `dropped_at IS NULL`) and `request_count`/`waitlist`-able rows; `STAFF_OPEN_SHIFTS_SQL` no longer projects `client_email`/`client_phone`.

- [ ] **Step 1: Add the per-role aggregate LATERAL** to `STAFF_OPEN_SHIFTS_SQL` and the admin by-proposal/detail queries:

```sql
LEFT JOIN LATERAL (
  SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb) AS approved_by_role
  FROM (
    SELECT position, COUNT(*) c
    FROM shift_requests
    WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
    GROUP BY position
  ) g
) abr ON true
```

- [ ] **Step 2: Narrow the staff projection** — replace `s.*` in `STAFF_OPEN_SHIFTS_SQL` with an explicit column list that excludes `client_email` and `client_phone` (keep `location`, `client_name`, `event_*`, `positions_needed`, `equipment_required`, `supply_run_required`). Confirm `USER_EVENTS_SQL` and the `team`-attach gate (`status='approved'` only) are unchanged.

- [ ] **Step 3: Manual verify** the two queries return `approved_by_role` and no client contact fields (run against a dev row, `psql`/Neon MCP). Commit. (No unit test harness for raw SQL strings; verification is a live query.)

---

## Lane 5: Request endpoint + position resolution (money seam) + logistics-edit endpoint

**Files:** Modify `server/routes/shifts.js`. Test `server/routes/__tests__/shifts.approval.test.js`. If `shifts.js` would cross 1000 lines, first extract the approval handlers into `server/routes/shifts.approval.js` and mount them (footprint then includes that file).

**Interfaces:** Consumes `parsePositionsNeeded`, `canonicalizeRole`, `classifyRequest`, `computeRemaining`, `isBartender` (L1); `approved_by_role` (L4); `sendWaitlistJoinEmail` (L8).

- [ ] **Step 1: Failing test — approve resolves and writes `position`**

```js
// approving a request ranked ['Banquet Server'] into an open server slot writes position='Banquet Server'
// approving a bartender request writes exactly 'Bartender'
// approving with no resolvable role and no admin override -> 400 (ValidationError), position untouched
```

- [ ] **Step 2: Rework `PUT /shifts/requests/:requestId` approve branch** — load the shift's `positions_needed` + `approved_by_role`; `const remaining = computeRemaining(parsePositionsNeeded(positions_needed), approvedByRole)`; `const { resolvableRole } = classifyRequest(requested_positions, remaining)`; the final role = `req.body.position ? canonicalizeRole(req.body.position) : resolvableRole`; if null -> throw `ValidationError('Cannot resolve a role for this approval')`; `UPDATE shift_requests SET status='approved', position=$role`. An over-fill (admin picks a full role) writes a `proposal_activity_log` entry.

- [ ] **Step 3: `POST /shifts/:id/assign`** — require an explicit `position`; `const role = canonicalizeRole(req.body.position)`; if `!role` throw `ValidationError`; remove the `|| 'Bartender'` default.

- [ ] **Step 4: Rework `POST /shifts/:id/request`** — accept `requested_positions` (array) + `transport_acknowledged` (bool). Validate: `const roles = [...new Set((requested_positions||[]).map(canonicalizeRole).filter(Boolean))]`; reject empty or any role not in `parsePositionsNeeded(positions_needed)` (`ValidationError`). On a transport-required shift (Lane 6 derives the same flag server-side: `equipment_required != '[]' || supply_run_required`) require `transport_acknowledged === true` else `ValidationError`. Upsert `requested_positions = $json`, `position = NULL`, `transport_acknowledged_at = now()` when acknowledged. Compute classification; on transition INTO waitlisted (was not previously waitlisted) call `sendWaitlistJoinEmail`; if actionable, keep the existing admin `urgent_staffing` notify; a re-rank that stays waitlisted sends nothing.

- [ ] **Step 5: Add equipment/supply fields to `PUT /shifts/:id`** (already `requireStaffing`) — accept `equipment_required` (validate each token in `['portable_bar','cooler','table_with_spandex']`, bounded length) and `supply_run` (boolean); setting `supply_run` writes `supply_run_required = $v, supply_run_overridden = true`. Editing `equipment_required` does NOT touch supply fields.

- [ ] **Step 6: Tests for request validation** (empty roles -> 400, non-subset role -> 400, transport-required without ack -> 400, waitlist-join sends email once across two re-ranks). Run, verify pass. Commit.

---

## Lane 6: Staff UI

**Files:** Modify `client/src/pages/staff/ShiftsPage.js`, `client/src/components/staff/ShiftCard.js`. Create `client/src/components/staff/RequestSheet.js`, `RoleRankPicker.js`, `LogisticsTag.js`.

**Interfaces:** Consumes `client/src/utils/staffingRoles.js` (`parsePositionsNeeded`, `computeRemaining`, `classifyRequest`, `isEventFullyStaffed`); the staff feed fields `positions_needed`, `approved_by_role`, `equipment_required`, `supply_run_required`, `my_request_status`, `my_requested_positions`. All API calls via `client/src/utils/api.js`.

- [ ] **Step 1: Add the "All" tab** — extend `SUB_TABS` to `['available','all','mine','past']`; update the route whitelist, `labelFor` (`all -> 'All'`), and the `counts` object. `Available` filters to events with any open slot (`!isEventFullyStaffed(computeRemaining(parsePositionsNeeded(s.positions_needed), s.approved_by_role))`); `All` shows every upcoming event. Verify with `CI=true react-scripts build`.

- [ ] **Step 2: `LogisticsTag.js`** — given `{ equipment_required, supply_run_required }`, render green "Bar Kit Only" when both empty/false, else a warning chip listing "Equipment" and/or "Supplies". Pure presentational; follow existing chip styles in `index.css`.

- [ ] **Step 3: Per-role fill on `ShiftCard`** — compute `remaining` per role and render `Bartender 2/2 · Banquet Server 0/1`; button label = `isEventFullyStaffed(remaining) ? 'Join waitlist' : 'Request'`, with a "Fully staffed" chip when full. Render `LogisticsTag`.

- [ ] **Step 4: `RoleRankPicker.js`** — checkbox list of the event's needed roles (from `parsePositionsNeeded`), each with its fill status; selecting 2+ shows up/down reorder controls (NOT HTML5 drag, since this is the phone-first staff app); emits an ordered `requested_positions` array. Blocked (with inline copy) when zero selected.

- [ ] **Step 5: `RequestSheet.js`** — hosts `RoleRankPicker`; on a transport-required event renders the warning block + required acknowledgment checkbox (submit disabled until ticked); submit copy = all-picked-roles-full ? "Join waitlist" : "Request"; POSTs `requested_positions` + `transport_acknowledged` to `/shifts/:id/request` via `api.js`; has loading, empty (no roles/event gone), and error-with-retry states; disabled/pending button while in flight.

- [ ] **Step 6: Waitlist + leave** in `Mine` — a waitlisted request shows "You're on the waitlist" (no rank/count); pending/waitlisted rows show "Leave waitlist"/"Withdraw" calling `DELETE /shifts/requests/:requestId`. Client guards mirror the server (non-empty, subset, ack). Verify `CI=true react-scripts build`. Commit.

---

## Lane 7: Admin UI

**Files:** Modify `client/src/components/adminos/drawers/ShiftDrawer.js`, `client/src/components/adminos/shifts.js`, `client/src/pages/admin/EventDetailPage.js`, `client/src/pages/admin/EventsDashboard.js`.

**Interfaces:** Consumes `client/src/utils/staffingRoles.js`; the admin shift detail (`requests` with `requested_positions`, `position`, the requester's `reliable_transportation`, `transport_acknowledged_at`), `approved_by_role`. API via `api.js`.

- [ ] **Step 1: `shifts.js` (client) per-role** — `shiftPositions` reads real labels via `parsePositionsNeeded` (drop the `role:'Bartender'` hardcode); add a `remainingByRole(shift)` helper. Verify build.

- [ ] **Step 2: ShiftDrawer money seam (client side)** — `handleApprove`/`handleManualAssign` must resolve `position` from the request's `requested_positions` (top-ranked open role via `classifyRequest`), NOT `req.position || 'Bartender'`; when the only open slot is an unranked role, show a small role-`<select>` (canonical labels) the admin must choose; never POST a defaulted `'Bartender'`. Change the manual-assign dropdown option value from `Server` to `Banquet Server`.

- [ ] **Step 3: Actionable vs Waitlist split** — split "Pending requests" into Actionable and Waitlist groups via `classifyRequest`; Waitlist rows show the staffer name, ranked roles, and the logistics flags (`no transportation on file` from `reliable_transportation` mapped case-insensitively: `no`/null/'' = red flag, `maybe`/`sometimes` = "uncertain", `yes` = none; plus a "transport acknowledged" check). Approving a still-full role requires an explicit confirm.

- [ ] **Step 4: Per-role open math** — replace ShiftDrawer's global `openCount` with per-role remaining so the manual-assign block and "fully staffed" render per role (do not hide a needed server slot because bartenders are full).

- [ ] **Step 5: EventDetail/Dashboard** — add the "N on waitlist" chip and per-role fill to the staffing summary; the create form (`EventsDashboard`) builds slots from the roster, not `Array(n).fill('Bartender')`; "No bartenders assigned yet" copy generalizes.

- [ ] **Step 6: Equipment + supply edit surface** — on the event detail (or the create/edit form), an editor for `equipment_required` (token checkboxes) and a `supply_run` toggle, saving via `PUT /shifts/:id` (Lane 5); explicit save/validation/loading states. Verify `CI=true react-scripts build`. Commit.

---

## Lane 8: Notifications

**Files:** Modify `server/utils/lastMinuteStaffingConfirmation.js`; add a `sendWaitlistJoinEmail` template+sender (place beside the existing lifecycle templates; if `emailTemplates.js` is near the size cap, add `server/utils/staffingEmailTemplates.js`).

**Interfaces (Produced):** `sendWaitlistJoinEmail({ to, staffName, eventLabel }) -> Promise<void>` (gated by `SEND_NOTIFICATIONS`, try/catch + Sentry, non-throwing).

- [ ] **Step 1: `sendWaitlistJoinEmail`** — low-key "You're on the waitlist for {eventLabel}" email, routed through the existing channel resolver defaulting to email, wrapped like other sends (log-and-skip when `SEND_NOTIFICATIONS` off, try/catch + Sentry on 5xx, never throws). The transition-into-waitlisted dedup lives in Lane 5 (it owns the prior-state check); this function just sends.

- [ ] **Step 2: `renderBartenderList` role-per-row** — change the query/render in `lastMinuteStaffingConfirmation.js` to carry `position` per approved row and label each by role (so a Banquet Server is not announced as "your bartender"); keep the one-shot `last_minute_hold` gate untouched. Add a test asserting a mixed roster renders "2 bartenders and 1 banquet server" style copy, not "your bartender" for the server. Commit.

---

## Lane 9: Backfill script

**Files:** Create `scripts/backfill-positions-needed.js`.

**Interfaces:** Consumes `deriveStaffingRoster` (L2), `parsePositionsNeeded`, `rosterCounts` (L1).

- [ ] **Step 1: Implement** — for each upcoming confirmed event (`event_date >= CURRENT_DATE`), load proposal + `pricing_snapshot`, compute the roster, per-role shrink-cap against current approved-active counts, and `UPDATE shifts SET positions_needed = $json`. Wrap the whole run in a transaction with a `SAVEPOINT` per event so one mis-derive rolls back just that event. `--dry-run` prints, per event, the current vs planned array and a final "events that gained newly-unfilled role slots" report (the recruiting list); no writes.

- [ ] **Step 2: Verify** — run `--dry-run` against dev, confirm the report shape and that no approved assignment would be dropped. Do NOT run the apply here; the apply is a gated ops step at rollout (Section 7 of the spec). Commit the script.

---

## Lane 10: Docs

**Files:** Modify `ARCHITECTURE.md` (Database Schema section: the 5 new columns), `README.md` (Key Features: per-role staffing roster, waitlist, Bar Kit Only / transport gating).

- [ ] **Step 1:** Add the new columns to the `ARCHITECTURE.md` schema section and the feature bullets to `README.md`. Commit.

---

## Self-Review

- **Spec coverage:** Section 1 -> L2 (+L1 helpers); Section 2 -> L6 (+L4 data); Section 3 -> L1 classification + L5 (request) + L7 (admin split) + L6 (staff view); Section 4 money seam -> L5 + L7 (client) + L1 (CHECK) + L8 (copy); Section 5 schema/backfill -> L1 + L9; Section 6 logistics -> L1 (column) + L2 (default) + L5 (edit endpoint) + L6 (tag/ack) + L7 (admin edit + flag); cover/drop -> L3; notifications -> L8; docs -> L10. All covered.
- **Type consistency:** `parsePositionsNeeded`, `computeRemaining`, `classifyRequest`, `isEventFullyStaffed`, `canonicalizeRole`, `isBartender`, `deriveStaffingRoster`, `computeSupplyRunDefault`, `sendWaitlistJoinEmail` used with the same signatures across lanes.
- **Footprint disjointness:** no file appears in two lanes (the parser is a new file in L1, so L3 wires it without L1 touching `coverBroadcast.js`; all `shifts.js` route changes are in L5; all `ShiftDrawer.js` in L7).
- **No placeholders:** load-bearing server logic is shown in full; UI tasks specify components, props, states, and the resolution logic concretely and follow existing component patterns.
