# Staffing Roster, Waitlist, and Logistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive shift slots from the full paid roster (bartenders + banquet servers + barbacks), add a computed waitlist with self-removal and an admin bench view, and surface equipment/supply transport requirements to staff before they request.

**Architecture:** A shared vocabulary + parsing + classification layer (Lane 1) underpins everything. The server roster engine (Lane 2) builds `positions_needed` from the proposal; the cover/drop marketplace (Lane 3) and staff/admin queries (Lane 4) adopt the canonical labels and a per-role aggregate; the approval path (Lane 5) becomes the money seam where `position` is resolved and written. Staff (Lane 6) and admin (Lane 7) UIs consume the per-role data; notifications (Lane 8), a one-time backfill (Lane 9), and docs (Lane 10) finish it.

**Tech Stack:** Node.js/Express, raw SQL via `pg` (no ORM), React 18 (CRA), vanilla CSS, Resend (email), node:test.

**Status:** Spec reviewed (fleet v2). Plan reviewed (fleet v1); this is v2, folding in the plan-fleet findings (snapshot source + join-fallback, colocated tests, L5 extraction-first, L8 concrete footprint + full review, `my_requested_positions` feed field, acknowledgment lifecycle, backfill loss report).

## Global Constraints

Copied verbatim from the spec and CLAUDE.md; every task implicitly includes these.

- Canonical role labels: `Bartender`, `Banquet Server`, `Barback`. All role comparisons are case-insensitive; `LOWER(position) = 'bartender'` is load-bearing for payroll.
- `positions_needed` exists in two shapes in prod (flat `["Bartender"]` and object `[{position,count}]`); always parse with the shared shape-tolerant parser, never bare `JSON.parse`.
- Bartender headcount = `proposals.num_bartenders` + `additional-bartender` add-on headcount (additive, never substitute). Per-slug hours divisor: `additional-bartender` ÷ `durationHours`; `banquet-server`/`barback` ÷ `max(durationHours, 4)`; `Math.round`.
- No money path reads `positions_needed`; gratuity comes from `pricing_snapshot`, the tip split from `shift_requests` rows with `LOWER(position)='bartender'`. The `position` column is the only money-sensitive field here.
- Raw parameterized SQL (`$1`), no string concatenation. Throw `AppError` subclasses, never `res.status(4xx).json`. Schema changes idempotent. API JSON keys snake_case, JS camelCase.
- No em dashes in client copy or comments.
- Tests are colocated next to the file they cover (`server/utils/foo.js` -> `server/utils/foo.test.js`), per the repo's 136-file convention (glob `server/**/*.test.js`). Pure-logic suites run with `node --test <file>`; DB-touching suites add `-r dotenv/config` and run one at a time. Client verified with `CI=true react-scripts build` (no client test runner).
- File-size ratchet: hard cap 1000 lines, blocks a commit that grows an over-cap file. `server/routes/shifts.js` is 994 lines today, so L5 extracts before adding.

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
      - server/utils/staffingRoles.test.js
      - server/utils/positionsNeeded.test.js
      - server/utils/staffingClassification.test.js
    deps: []
    review: full   # schema migration + money-adjacent position normalization

  - id: L2-roster-engine
    title: deriveStaffingRoster + addon loader, create/sync wiring, supply-run default, auto-assign scoping
    footprint:
      - server/utils/eventCreation.js
      - server/utils/autoAssign.js
      - server/utils/eventCreation.roster.test.js
    deps: [L1-foundation]
    review: full   # feeds the Stripe webhook; money-adjacent

  - id: L3-cover-canonical
    title: Cover/drop marketplace canonical + case-insensitive matching
    footprint:
      - server/utils/coverBroadcast.js
      - server/routes/staffShiftActions.js
      - server/utils/coverBroadcast.canonical.test.js
    deps: [L1-foundation]
    review: full   # the marketplace Goals pledged not to disturb

  - id: L4-queries
    title: Per-role approved aggregate, my_requested_positions, PII narrowing
    footprint:
      - server/routes/shifts.queries.js
    deps: [L1-foundation]
    review: standard+security   # PII projection

  - id: L5-request-approval
    title: Extract approval handlers, request endpoint, position resolution (money seam), logistics-edit endpoint
    footprint:
      - server/routes/shifts.js
      - server/routes/shifts.approval.js
      - server/routes/shifts.approval.test.js
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
      - server/utils/staffingEmailTemplates.js
      - server/utils/lastMinuteStaffingConfirmation.js
    deps: [L1-foundation]
    review: full   # *EmailTemplates.js is a sensitive path

  - id: L9-backfill
    title: One-time positions_needed re-derive script (dry-run + apply)
    footprint:
      - scripts/backfill-positions-needed.js
    deps: [L1-foundation, L2-roster-engine]
    review: full   # mutates prod staffing data; run is a manual ops step

  - id: L10-docs
    title: ARCHITECTURE + README updates
    footprint:
      - ARCHITECTURE.md
      - README.md
    deps: [L1-foundation, L2-roster-engine, L5-request-approval, L6-staff-ui, L7-admin-ui]
    review: light
```

**Run order / parallelism:** L1 first (blocks all). Then L2, L3, L4, L8 in parallel. Then L5 (needs L4 + L8). Then L6 and L7 in parallel (need L5). L9 after L2 (alongside L5/L6/L7). L10 last. The `position` normalization in L1 must land before L2/L3/L5 touch role data, and the case-insensitive `position` CHECK is added by L1's migration after that normalization. L3's `LOWER(cp.position)` matching only works once L1 has normalized `contractor_profiles.position`, so L3 depends on L1.

---

## Lane 1: Foundation (vocabulary, parsing, classification, schema, migration)

**Files:**
- Create: `server/utils/staffingRoles.js`, `server/utils/positionsNeeded.js`, `server/utils/staffingClassification.js`
- Create: `client/src/utils/staffingRoles.js` (ESM mirror, like `eventTypes.js`)
- Modify: `server/db/schema.sql`
- Create: `scripts/migrate-staffing-roles.js`
- Test (colocated): `server/utils/staffingRoles.test.js`, `positionsNeeded.test.js`, `staffingClassification.test.js`

**Interfaces (Produced):**
- `staffingRoles.js` (CJS): `ROLES`, `CANONICAL_LABELS`, `canonicalizeRole(value) -> label|null`, `isBartender(position) -> boolean`.
- `positionsNeeded.js`: `parsePositionsNeeded(raw) -> string[]`, `rosterCounts(positionsArray) -> { [role]: number }`.
- `staffingClassification.js`: `computeRemaining(positionsNeeded, approvedByRole) -> { [role]: number }`, `classifyRequest(requestedPositions, remaining) -> { state, resolvableRole }`, `isEventFullyStaffed(remaining) -> boolean`.
- `client/src/utils/staffingRoles.js` (ESM): all of the above.

- [ ] **Step 1: Failing test for `canonicalizeRole`/`isBartender`**

```js
// server/utils/staffingRoles.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { canonicalizeRole, isBartender } = require('./staffingRoles');

test('canonicalizeRole maps case + legacy Server', () => {
  assert.equal(canonicalizeRole('bartender'), 'Bartender');
  assert.equal(canonicalizeRole('Server'), 'Banquet Server');
  assert.equal(canonicalizeRole('banquet server'), 'Banquet Server');
  assert.equal(canonicalizeRole('  Barback '), 'Barback');
  assert.equal(canonicalizeRole('chef'), null);
  assert.equal(canonicalizeRole(null), null);
});
test('isBartender is case-insensitive', () => {
  assert.equal(isBartender('Bartender'), true);
  assert.equal(isBartender('bartender'), true);
  assert.equal(isBartender('Banquet Server'), false);
});
```

- [ ] **Step 2: Run, verify fail** — `node --test server/utils/staffingRoles.test.js` -> FAIL (module missing).

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

- [ ] **Step 5: Failing test for `parsePositionsNeeded` (both shapes) + `rosterCounts`**

```js
// server/utils/positionsNeeded.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parsePositionsNeeded, rosterCounts } = require('./positionsNeeded');

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
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return []; } }
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

- [ ] **Step 9: Failing test for classification**

```js
// server/utils/staffingClassification.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { computeRemaining, classifyRequest, isEventFullyStaffed } = require('./staffingClassification');

test('computeRemaining = needed - approved per role', () => {
  assert.deepEqual(computeRemaining(['Bartender', 'Bartender', 'Banquet Server'], { Bartender: 2 }),
    { Bartender: 0, 'Banquet Server': 1 });
});
test('classify actionable picks top ranked open role', () => {
  assert.deepEqual(classifyRequest(['Bartender', 'Banquet Server'], { Bartender: 0, 'Banquet Server': 1 }),
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
  for (const role of Object.keys(needed)) remaining[role] = needed[role] - (approvedByRole[role] || 0);
  return remaining;
}
function classifyRequest(requestedPositions, remaining) {
  const ranked = (Array.isArray(requestedPositions) && requestedPositions.length)
    ? requestedPositions : Object.keys(remaining);
  for (const role of ranked) if ((remaining[role] || 0) > 0) return { state: 'actionable', resolvableRole: role };
  return { state: 'waitlisted', resolvableRole: null };
}
function isEventFullyStaffed(remaining) {
  return Object.values(remaining).every((n) => n <= 0);
}
module.exports = { computeRemaining, classifyRequest, isEventFullyStaffed };
```

- [ ] **Step 12: Run, verify pass. Commit** (`feat(staffing): canonical roles, shape-tolerant parser, classification helpers`).

- [ ] **Step 13: Mirror to client** — create `client/src/utils/staffingRoles.js` (ESM) exporting all of the above with identical logic. Header: `// Mirror of server/utils/{staffingRoles,positionsNeeded,staffingClassification}.js; keep in sync manually.` (Same dual-file pattern as `eventTypes.js`.) Commit.

- [ ] **Step 14: Schema columns (append to `schema.sql`, idempotent)**

```sql
-- Staffing roster + waitlist + logistics
ALTER TABLE shift_requests ADD COLUMN IF NOT EXISTS requested_positions TEXT DEFAULT '[]';
ALTER TABLE shift_requests ADD COLUMN IF NOT EXISTS transport_acknowledged_at TIMESTAMP;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS supply_run_required BOOLEAN DEFAULT false;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS supply_run_overridden BOOLEAN DEFAULT false;
ALTER TABLE service_addons ADD COLUMN IF NOT EXISTS requires_provisioning BOOLEAN DEFAULT false;
-- The position CHECK is added by scripts/migrate-staffing-roles.js AFTER normalization
-- (an inline CHECK here would fail on existing non-canonical rows).
```

- [ ] **Step 15: Seed `requires_provisioning`** (append to `schema.sql`; derive the COMPLETE list by reading the current catalog, every consumable/gear add-on TRUE, staffing/fee add-ons FALSE)

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
-- Before committing, run `SELECT slug,name,category FROM service_addons ORDER BY slug` and confirm
-- every physical/consumable add-on is listed and only staffing/fee add-ons are omitted.
```

- [ ] **Step 16: Migration script** `scripts/migrate-staffing-roles.js` (transaction; `--dry-run` prints counts only):
  1. Print `SELECT DISTINCT position FROM shift_requests` and `... FROM contractor_profiles`.
  2. Normalize both columns to canonical via parameterized `UPDATE` (e.g. `UPDATE shift_requests SET position='Banquet Server' WHERE LOWER(position) IN ('server','banquet server')`; same for `Bartender`/`Barback`; same on `contractor_profiles`).
  3. `UPDATE shift_requests SET requested_positions = to_jsonb(ARRAY[position]) WHERE position IS NOT NULL AND (requested_positions IS NULL OR requested_positions = '[]')`.
  4. `ALTER TABLE shift_requests DROP CONSTRAINT IF EXISTS shift_requests_position_canonical; ALTER TABLE shift_requests ADD CONSTRAINT shift_requests_position_canonical CHECK (position IS NULL OR LOWER(position) IN ('bartender','banquet server','barback'));`

- [ ] **Step 17: Apply schema + migration to the dev DB by hand** (schema.sql is not auto-applied to dev): run the `ALTER`s, then `node -r dotenv/config scripts/migrate-staffing-roles.js --dry-run`, review, then run for real. Commit the lane.

---

## Lane 2: Roster engine

**Files:**
- Modify: `server/utils/eventCreation.js` (add `loadStaffingAddons`, `deriveStaffingRoster`, `computeSupplyRunDefault`; wire `createEventShifts`, `syncShiftsFromProposal`)
- Modify: `server/utils/autoAssign.js` (scope to Bartender)
- Test (colocated): `server/utils/eventCreation.roster.test.js`

**Interfaces:**
- Consumes: `parsePositionsNeeded`, `rosterCounts`, `ROLES` (L1).
- Produces: `deriveStaffingRoster(proposal, addons) -> string[]` (pure; `addons` = `[{slug, quantity}]` in hours); `loadStaffingAddons(proposal, db) -> Promise<Array<{slug, quantity}>>` (snapshot-first, `proposal_addons` join fallback); `computeSupplyRunDefault(isHosted, addons, provisioningSlugs:Set) -> boolean`.

- [ ] **Step 1: Failing test for `deriveStaffingRoster`** (pure; pass an `addons` array directly so the unit test needs no DB; cover additive bartender, servers, barbacks, per-slug divisor on a sub-4-hour event, and a class-$0 case where counts are still real)

```js
const { deriveStaffingRoster } = require('./eventCreation');
test('roster = bartenders(+addon) then servers then barbacks', () => {
  const proposal = { num_bartenders: 2, event_duration_hours: 5 };
  const addons = [
    { slug: 'additional-bartender', quantity: 5 },  // 5/5 = 1
    { slug: 'banquet-server', quantity: 5 },         // 5/max(5,4)=5 = 1
    { slug: 'barback', quantity: 10 },               // 10/5 = 2
  ];
  assert.deepEqual(deriveStaffingRoster(proposal, addons),
    ['Bartender', 'Bartender', 'Bartender', 'Banquet Server', 'Barback', 'Barback']);
});
test('sub-4h class: additional-bartender divides by durationHours not max', () => {
  assert.deepEqual(
    deriveStaffingRoster({ num_bartenders: 1, event_duration_hours: 2 }, [{ slug: 'additional-bartender', quantity: 2 }]),
    ['Bartender', 'Bartender']);
});
test('class $0: counts derive from quantity regardless of price', () => {
  assert.deepEqual(
    deriveStaffingRoster({ num_bartenders: 1, event_duration_hours: 4 }, [{ slug: 'barback', quantity: 4 }]),
    ['Bartender', 'Barback']);
});
test('no addons -> num_bartenders only', () => {
  assert.deepEqual(deriveStaffingRoster({ num_bartenders: 3 }, []), ['Bartender', 'Bartender', 'Bartender']);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `deriveStaffingRoster` + `addonHeadcount` in `eventCreation.js`**

```js
function addonHeadcount(addons, slug, durationHours) {
  const divisor = slug === 'additional-bartender'
    ? Math.max(1, Number(durationHours) || 1)
    : Math.max(Number(durationHours) || 0, 4);
  return (addons || []).filter(a => a.slug === slug)
    .reduce((sum, a) => sum + Math.max(0, Math.round((Number(a.quantity) || 0) / divisor)), 0);
}
function deriveStaffingRoster(proposal, addons) {
  const dur = Number(proposal && proposal.event_duration_hours) || 0;
  const bartenders = (Number(proposal && proposal.num_bartenders) || 1) + addonHeadcount(addons, 'additional-bartender', dur);
  const servers = addonHeadcount(addons, 'banquet-server', dur);
  const barbacks = addonHeadcount(addons, 'barback', dur);
  const out = [];
  for (let i = 0; i < bartenders; i++) out.push('Bartender');
  for (let i = 0; i < servers; i++) out.push('Banquet Server');
  for (let i = 0; i < barbacks; i++) out.push('Barback');
  return out;
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Implement `loadStaffingAddons` (snapshot-first, join fallback)** — this is where the missing-snapshot tier lives; `deriveStaffingRoster` stays pure and DB-free.

```js
const STAFFING_NAME_TO_SLUG = {
  'additional bartender': 'additional-bartender',
  'banquet server': 'banquet-server',
  'barback': 'barback',
};
async function loadStaffingAddons(proposal, db) {
  try {
    const snap = typeof proposal.pricing_snapshot === 'string'
      ? JSON.parse(proposal.pricing_snapshot) : proposal.pricing_snapshot;
    if (snap && Array.isArray(snap.addons) && snap.addons.length) {
      return snap.addons.map(a => ({ slug: a.slug, quantity: Number(a.quantity) || 0 })).filter(a => a.slug);
    }
  } catch { /* fall through to the join */ }
  const { rows } = await db.query(
    `SELECT sa.slug, pa.quantity, pa.addon_name
       FROM proposal_addons pa
       LEFT JOIN service_addons sa ON sa.id = pa.addon_id
      WHERE pa.proposal_id = $1`, [proposal.id]);
  return rows.map(r => ({
    slug: r.slug || STAFFING_NAME_TO_SLUG[String(r.addon_name || '').trim().toLowerCase()] || null,
    quantity: Number(r.quantity) || 0,
  })).filter(a => a.slug);
}
```

Add a colocated test that, given a proposal whose `pricing_snapshot` is `'{}'` but which has `proposal_addons` rows (one with a NULL `addon_id` but `addon_name='Banquet Server'`), `loadStaffingAddons` returns the banquet-server addon via the name fallback. (Use a stub `db` with a `query` returning canned rows.)

- [ ] **Step 6: Implement `computeSupplyRunDefault`** (hosted detection is passed in, since a snapshotless proposal needs a package lookup the caller does)

```js
function computeSupplyRunDefault(isHosted, addons, provisioningSlugs) {
  if (isHosted) return true;
  return (addons || []).some(a => provisioningSlugs.has(a.slug));
}
```

- [ ] **Step 7: Wire `createEventShifts`** — `const addons = await loadStaffingAddons(proposal, client);` then `positions_needed = JSON.stringify(deriveStaffingRoster(proposal, addons))`. Determine hosted: `const isHosted = (snap && snap.package && snap.package.pricing_type === 'per_guest') || (await packagePricingType(proposal.package_id, client)) === 'per_guest'` (add a small `packagePricingType` query helper). Load `provisioningSlugs` once (`SELECT slug FROM service_addons WHERE requires_provisioning = true`) into a `Set`. Set `supply_run_required = computeSupplyRunDefault(isHosted, addons, slugs)` in the INSERT. `proposal.pricing_snapshot` is already selected by `p.*` in this function; never throw on a `'{}'` snapshot (the helpers null-guard).

- [ ] **Step 8: Wire `syncShiftsFromProposal`** — rebuild `positions_needed` from `deriveStaffingRoster(proposal, await loadStaffingAddons(proposal, client))`, per-role shrink-capped: `desired[role] = max(rosterCounts(roster)[role], approvedActiveByRole[role])`; rebuild the array; log `staffing_shrink_capped` per role when capped. Recompute `supply_run_required` ONLY when `supply_run_overridden = false`. Add a test: an event with 2 approved servers whose proposal now lists 1 keeps 2 server slots and logs.

- [ ] **Step 9: Scope `autoAssign` to Bartender** — `slotsRemaining = rosterCounts(parsePositionsNeeded(positions_needed))['Bartender'] - approvedBartenders`; filter candidates to those whose `requested_positions` includes `Bartender` OR whose `requested_positions` is empty/`'[]'` (legacy "any role"); write `position = 'Bartender'`. Test: a server-only requester is never auto-assigned; a bartender (and a legacy empty-requested) is. Commit the lane.

---

## Lane 3: Cover/drop canonical matching

**Files:** Modify `server/utils/coverBroadcast.js`, `server/routes/staffShiftActions.js`. Test (colocated): `server/utils/coverBroadcast.canonical.test.js`.

**Interfaces:** Consumes `parsePositionsNeeded`, `canonicalizeRole` (L1). Precondition: L1 normalized `contractor_profiles.position` (assert this ordering in review).

- [ ] **Step 1: Failing test** — a shift with `positions_needed = ["Banquet Server"]` broadcasts to a candidate whose `contractor_profiles.position = 'Banquet Server'` (post-migration), and a claimer with `position='banquet server'` passes the eligibility gate (canonical + case-insensitive, no exact-string miss).

- [ ] **Step 2: Replace** `coverBroadcast.js:148` `cp.position = ANY($2)` with `LOWER(cp.position) = ANY($2)` where `$2 = parsePositionsNeeded(shift.positions_needed).map(r => r.toLowerCase())`. (`contractor_profiles.position` is already canonical post-L1, so lowercasing both sides is sufficient.)

- [ ] **Step 3: Update `staffShiftActions.js:566`** claim gate to compare `canonicalizeRole(claimerPosition)` against the canonical roster from `parsePositionsNeeded`.

- [ ] **Step 4: Run tests, verify pass. Commit.**

---

## Lane 4: Per-role aggregate, my_requested_positions, PII narrowing

**Files:** Modify `server/routes/shifts.queries.js`.

**Interfaces (Produced):** the staff feed and admin shift queries return `approved_by_role` (JSON `{role: count}`, approved AND `dropped_at IS NULL`) and `my_requested_positions` (the viewer's own `shift_requests.requested_positions`); `STAFF_OPEN_SHIFTS_SQL` no longer projects `client_email`/`client_phone`.

- [ ] **Step 1: Add the per-role aggregate LATERAL** to `STAFF_OPEN_SHIFTS_SQL` and the admin by-proposal/detail queries:

```sql
LEFT JOIN LATERAL (
  SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb) AS approved_by_role
  FROM (SELECT position, COUNT(*) c FROM shift_requests
        WHERE shift_id = s.id AND status='approved' AND dropped_at IS NULL GROUP BY position) g
) abr ON true
```

- [ ] **Step 2: Add `my_requested_positions`** to the per-viewer join in `STAFF_OPEN_SHIFTS_SQL` (it already joins the viewer's own `shift_requests` row for `my_request_status`): project `mr.requested_positions AS my_requested_positions`.

- [ ] **Step 3: Narrow the staff projection** — replace `s.*` in `STAFF_OPEN_SHIFTS_SQL` with an explicit column list that excludes `client_email`/`client_phone` and includes `equipment_required`, `supply_run_required`. Confirm the `team`-attach gate (`status='approved'` only) and the `WHERE s.status='open' AND event_date >= CURRENT_DATE` are unchanged: under the computed-fullness model nothing sets `status='filled'`, so fully-staffed events stay `status='open'` and are already returned, which is exactly what the "All" tab needs (L6 filters the "Available" subset client-side).

- [ ] **Step 4: Manual verify** the queries return `approved_by_role` + `my_requested_positions`, no client contact fields, and a fully-staffed upcoming event still appears (run against a dev row via Neon MCP/psql). Commit.

---

## Lane 5: Extract approval handlers, request endpoint, position resolution (money seam), logistics-edit endpoint

**Files:** Modify `server/routes/shifts.js`; create `server/routes/shifts.approval.js`. Test (colocated): `server/routes/shifts.approval.test.js`.

**Interfaces:** Consumes `parsePositionsNeeded`, `canonicalizeRole`, `classifyRequest`, `computeRemaining` (L1); `approved_by_role` (L4); `sendWaitlistJoinEmail` (L8).

- [ ] **Step 1: Extract first (mandatory, the file is 994/1000 lines).** Move the assign/approve/request handlers out of `shifts.js` into `server/routes/shifts.approval.js` (export functions, mount from `shifts.js` via the existing router), behavior unchanged. Verify the server boots and an existing approve still works (manual: approve a pending request in dev). Commit the pure extraction on its own so the diff is reviewable.

- [ ] **Step 2: Failing test — approve resolves and writes `position`** (in `shifts.approval.test.js`): approving a request ranked `['Banquet Server']` into an open server slot writes `position='Banquet Server'`; a bartender approval writes exactly `Bartender`; an approval with no resolvable role and no admin override returns 400 and leaves `position` untouched.

- [ ] **Step 3: Rework the approve branch (`PUT /shifts/requests/:requestId`)** — load the shift's `positions_needed` + `approved_by_role`; `const remaining = computeRemaining(parsePositionsNeeded(positions_needed), approvedByRole)`; `const { resolvableRole } = classifyRequest(requested_positions, remaining)`; final role = `req.body.position ? canonicalizeRole(req.body.position) : resolvableRole`; if null throw `ValidationError('Cannot resolve a role for this approval')`; `UPDATE shift_requests SET status='approved', position=$role`. An over-fill (admin picks a full role) writes a `proposal_activity_log` entry (the table + the `staffing_shrink_capped` INSERT pattern already exist in `eventCreation.js`).

- [ ] **Step 4: `POST /shifts/:id/assign`** — require an explicit `position`; `const role = canonicalizeRole(req.body.position)`; if `!role` throw `ValidationError`; remove the `|| 'Bartender'` default.

- [ ] **Step 5: Rework `POST /shifts/:id/request`** — accept `requested_positions` (array) + `transport_acknowledged` (bool). `const roles = [...new Set((requested_positions||[]).map(canonicalizeRole).filter(Boolean))]`; reject empty or any role not in `parsePositionsNeeded(positions_needed)`. Compute `transportRequired = (equipment_required && equipment_required !== '[]') || supply_run_required` from the shift row; if `transportRequired` require `transport_acknowledged === true` else `ValidationError` (this re-checks ack against the CURRENT logistics flags on every submit, which is the re-require-on-escalation behavior). Upsert `requested_positions=$json`, `position=NULL`, `transport_acknowledged_at = transportRequired && transport_acknowledged ? now() : NULL` (clearing a stale ack when the event is no longer transport-required). Compute classification; on the transition INTO waitlisted (prior state was not waitlisted) call `sendWaitlistJoinEmail`; if actionable keep the existing admin `urgent_staffing` notify; a re-rank that stays waitlisted sends nothing.

- [ ] **Step 6: Add equipment/supply fields to `PUT /shifts/:id`** (already `requireStaffing`) — accept `equipment_required` (validate each token in `['portable_bar','cooler','table_with_spandex']`, bounded length) and `supply_run` (boolean -> `supply_run_required = $v, supply_run_overridden = true`). Editing `equipment_required` does NOT touch supply fields.

- [ ] **Step 7: Tests** (empty roles -> 400, non-subset role -> 400, transport-required without ack -> 400, waitlist-join emails once across two re-ranks). Run, verify pass. Commit.

---

## Lane 6: Staff UI

**Files:** Modify `client/src/pages/staff/ShiftsPage.js`, `client/src/components/staff/ShiftCard.js`. Create `client/src/components/staff/RequestSheet.js`, `RoleRankPicker.js`, `LogisticsTag.js`.

**Interfaces:** Consumes `client/src/utils/staffingRoles.js`; staff feed fields `positions_needed`, `approved_by_role`, `equipment_required`, `supply_run_required`, `my_request_status`, `my_requested_positions`. API via `client/src/utils/api.js`.

- [ ] **Step 1: Add the "All" tab** — extend `SUB_TABS` to `['available','all','mine','past']`; update the route whitelist, `labelFor` (`all -> 'All'`), and `counts`. Both Available and All source from the existing open-shift feed (full events remain `status='open'`); Available filters to `!isEventFullyStaffed(computeRemaining(parsePositionsNeeded(s.positions_needed), s.approved_by_role))`, All shows all. Verify `CI=true react-scripts build`.

- [ ] **Step 2: `LogisticsTag.js`** — given `{ equipment_required, supply_run_required }`, render green "Bar Kit Only" when both empty/false, else a warning chip listing "Equipment" and/or "Supplies". Follow existing chip styles in `index.css`.

- [ ] **Step 3: Per-role fill on `ShiftCard`** — compute `remaining` per role, render `Bartender 2/2 · Banquet Server 0/1`; button = `isEventFullyStaffed(remaining) ? 'Join waitlist' : 'Request'` with a "Fully staffed" chip when full; render `LogisticsTag`.

- [ ] **Step 4: `RoleRankPicker.js`** — checkbox list of the event's needed roles (`parsePositionsNeeded`) with fill status; selecting 2+ shows up/down reorder controls (NOT HTML5 drag, phone-first); emits an ordered `requested_positions`; blocked with inline copy when zero selected.

- [ ] **Step 5: `RequestSheet.js`** — hosts `RoleRankPicker`; on a transport-required event renders the warning block + required acknowledgment checkbox (submit disabled until ticked); submit copy = all-picked-full ? "Join waitlist" : "Request"; POSTs `requested_positions` + `transport_acknowledged` to `/shifts/:id/request`; loading, empty (no roles/event gone), error-with-retry, and disabled/pending states.

- [ ] **Step 6: Waitlist + leave** in `Mine` — a waitlisted request shows "You're on the waitlist" (no rank/count); pending/waitlisted rows show "Leave waitlist"/"Withdraw" -> `DELETE /shifts/requests/:requestId`. Client guards mirror the server. Verify `CI=true react-scripts build`. Commit.

---

## Lane 7: Admin UI

**Files:** Modify `client/src/components/adminos/drawers/ShiftDrawer.js`, `client/src/components/adminos/shifts.js`, `client/src/pages/admin/EventDetailPage.js`, `client/src/pages/admin/EventsDashboard.js`.

**Interfaces:** Consumes `client/src/utils/staffingRoles.js`; admin shift detail (`requests` with `requested_positions`, `position`, the requester's `reliable_transportation`, `transport_acknowledged_at`), `approved_by_role`. The `EventsDashboard` create-form payload must match L5's `POST /shifts` contract (cross-lane coupling; flag for review). API via `api.js`.

- [ ] **Step 1: `shifts.js` (client) per-role** — `shiftPositions` reads real labels via `parsePositionsNeeded` (drop the `role:'Bartender'` hardcode); add `remainingByRole(shift)`. Verify build.

- [ ] **Step 2: ShiftDrawer money seam (client)** — `handleApprove`/`handleManualAssign` resolve `position` from the request's `requested_positions` (top-ranked open role via `classifyRequest`), NEVER `req.position || 'Bartender'`; when the only open slot is an unranked role, show a role-`<select>` (canonical labels) the admin must choose. Change the manual-assign dropdown option value `Server` -> `Banquet Server`.

- [ ] **Step 3: Actionable vs Waitlist split** — split "Pending requests" via `classifyRequest`; Waitlist rows show staffer name, ranked roles, and logistics flags: `reliable_transportation` mapped case-insensitively (`no`/null/'' = red "no transportation on file", `maybe`/`sometimes` = "transportation uncertain", `yes` = none), shown ONLY when the event is transport-required (a stale ack on a now-Bar-Kit event shows nothing); plus a "transport acknowledged" check. Approving a still-full role requires explicit confirm.

- [ ] **Step 4: Per-role open math** — replace ShiftDrawer's global `openCount` with per-role remaining so the manual-assign block and "fully staffed" render per role (do not hide a needed server slot because bartenders are full).

- [ ] **Step 5: EventDetail/Dashboard** — add the "N on waitlist" chip + per-role fill; the `EventsDashboard` create form builds slots from the roster, not `Array(n).fill('Bartender')`; "No bartenders assigned yet" copy generalizes.

- [ ] **Step 6: Equipment + supply edit surface** — token checkboxes for `equipment_required` + a `supply_run` toggle, saving via `PUT /shifts/:id` (L5); explicit save/validation/loading states. Verify `CI=true react-scripts build`. Commit.

---

## Lane 8: Notifications

**Files:** Create `server/utils/staffingEmailTemplates.js`; modify `server/utils/lastMinuteStaffingConfirmation.js`.

**Interfaces (Produced):** `sendWaitlistJoinEmail({ to, staffName, eventLabel }) -> Promise<void>` (gated by `SEND_NOTIFICATIONS`, try/catch + Sentry, non-throwing).

- [ ] **Step 1: `sendWaitlistJoinEmail`** in `staffingEmailTemplates.js` — low-key "You're on the waitlist for {eventLabel}" email through the existing channel resolver (default email), wrapped like other sends (log-and-skip when `SEND_NOTIFICATIONS` off, try/catch + Sentry on 5xx, never throws). The transition-into-waitlisted dedup lives in L5; this just sends.

- [ ] **Step 2: `renderBartenderList` role-per-row** — carry `position` per approved row and label each by role so a Banquet Server is not announced as "your bartender"; keep the one-shot `last_minute_hold` gate untouched. Add a test asserting a mixed roster renders role-correct copy. Commit.

---

## Lane 9: Backfill script

**Files:** Create `scripts/backfill-positions-needed.js`.

**Interfaces:** Consumes `deriveStaffingRoster`, `loadStaffingAddons` (L2), `parsePositionsNeeded`, `rosterCounts` (L1).

- [ ] **Step 1: Implement** — for each upcoming confirmed event (`event_date >= CURRENT_DATE`), `const addons = await loadStaffingAddons(proposal, client)` (so the join fallback covers snapshotless proposals), compute the roster, per-role shrink-cap against current approved-active counts, `UPDATE shifts SET positions_needed=$json`. Wrap the run in a transaction with a `SAVEPOINT` per event. `--dry-run` prints, per event, current vs planned arrays, and TWO reports: events that GAINED newly-unfilled role slots (the recruiting list) AND events that would LOSE a server/barback slot (a snapshotless re-derive red flag to inspect before apply); no writes.

- [ ] **Step 2: Verify** — run `--dry-run` on dev, confirm both report shapes and that no approved assignment would be dropped. Do NOT run the apply here (gated ops step at rollout). Commit the script.

---

## Lane 10: Docs

**Files:** Modify `ARCHITECTURE.md` (Database Schema: the 5 new columns), `README.md` (Key Features: per-role roster, waitlist, Bar Kit Only / transport gating).

- [ ] **Step 1:** Add the new columns to `ARCHITECTURE.md` and the feature bullets to `README.md`. Commit.

---

## Self-Review

- **Spec coverage:** §1 -> L2 (+L1); §2 -> L6 (+L4); §3 -> L1 classify + L5 + L7 + L6; §4 money seam -> L5 + L7 + L1 CHECK + L8 copy; §5 -> L1 + L9; §6 -> L1 column + L2 default + L5 edit endpoint + L6 tag/ack + L7 edit/flag; cover/drop -> L3; notifications -> L8; docs -> L10. The plan-fleet findings are folded: snapshot source named (`proposal.pricing_snapshot`) with the `proposal_addons` join fallback in `loadStaffingAddons` (L2 Step 5); tests colocated; L5 extraction is Step 1; L8 footprint concrete + full review; `my_requested_positions` added in L4; acknowledgment re-require/clear in L5 Step 5 + L7 Step 3; backfill loss report in L9.
- **Type consistency:** `parsePositionsNeeded`, `rosterCounts`, `computeRemaining`, `classifyRequest`, `isEventFullyStaffed`, `canonicalizeRole`, `isBartender`, `deriveStaffingRoster(proposal, addons)`, `loadStaffingAddons`, `computeSupplyRunDefault`, `sendWaitlistJoinEmail` consistent across lanes.
- **Footprint disjointness:** verified disjoint (the shared parser is a new file in L1; L3 wires it without L1 touching `coverBroadcast.js`; all `shifts.js`/`shifts.approval.js` in L5; all `ShiftDrawer.js` in L7; `shifts.queries.js` L4-only).
