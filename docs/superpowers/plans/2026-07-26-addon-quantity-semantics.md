---
lanes:
  - id: addon-quantity-semantics
    footprint:
      - server/utils/addonQuantity.js
      - server/utils/addonQuantity.test.js
      - server/utils/proposalExtrasFold.js
      - server/utils/proposalExtrasFold.stability.test.js
      - server/utils/proposalExtrasFold.legs.test.js
      - server/routes/drinkPlans/lab.js
      - server/routes/drinkPlans/submit.js
      - server/utils/lineItemCancel.js
      - server/utils/lineItemCancel.test.js
      - server/routes/proposals/cancelLineItem.js
      - server/routes/proposals/cancelLineItem.test.js
      - server/utils/refundHelpers.js
      - client/src/pages/admin/CancelLineDialog.js
      - scripts/money-smoke-list.txt
      - docs/fix-list-remaining-2026-07-02.md
      - ARCHITECTURE.md
    deps: []
    review: full-fleet
---

# Add-on Quantity Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every reader and writer of `proposal_addons.quantity` agree on what the column means, so a reprice can no longer multiply a `per_hour` add-on by its own hours.

**Architecture:** The column stores the pricing engine's OUTPUT display quantity, and two consumers already depend on that (`eventCreation.addonHeadcount` divides it by duration to recover headcount; `invoiceLineItems` renders it as `qty x rate`). One reader (`withRepriceQuantities`) feeds it back as the engine's INPUT count, which squares the hours for `per_hour`; two writers (lab, submit) store a raw count instead of the output shape. This plan introduces a single conversion module as the only sanctioned translation between the two, points the reader and the writers at it, and pins the whole thing with a reprice-stability test that no-op folds cannot move money.

**Tech Stack:** Node/Express, raw SQL via `pg`, node:test against the shared dev DB, React admin client.

## The defect, measured

`calculateAddonCost` (server/utils/pricingEngine.js:154-186) takes an INPUT
`addonQuantity` (the admin's "how many of this add-on") and returns an OUTPUT
`quantity` that is a per-billing-type DISPLAY figure:

| billing_type | engine OUTPUT quantity | equals the input count? |
|---|---|---|
| `per_guest` | `guestCount` | no |
| `per_guest_timed` | `guestCount` | no |
| `per_hour` | `effectiveHours * qty` | **no** |
| `per_staff` | `staffCount` | no (input ignored entirely) |
| `per_100_guests` | `ceil(guests/100)` | no (input ignored entirely) |
| `flat` / default | `qty` | yes |

Three writers store that OUTPUT verbatim (`server/utils/proposalInsert.js:58`,
`server/routes/proposals/public.js:465`, `server/routes/proposals/crud.js:618`,
all `flatMap`ing `snapshot.addons[].quantity`). Two consumers correctly treat
it as output: `eventCreation.addonHeadcount` (server/utils/eventCreation.js:51-58)
divides by duration to recover headcount, and `invoiceLineItems`
(server/utils/invoiceLineItems.js:83-94) renders `quantity x rate`.

`withRepriceQuantities` (server/utils/proposalExtrasFold.js:57-70) passes the
stored OUTPUT back as the engine's INPUT for every type except
`per_guest`/`per_guest_timed`. Its docstring asserts the column holds "the real
unit count for per_hour/flat/etc." — true for `flat`, false for `per_hour`.

Measured on the dev DB with a prod-shaped row (probe, rolled back): one banquet
server, 6-hour event, stored `quantity 6.00` / `line_total 450`. A NO-OP fold
(identical before/after legs) repriced the line to **$2,700** and the proposal
total from $2,690 to $4,940. Prod stores exactly this shape: proposal 624 has
`quantity 6.00`, `rate 75`, `event_duration_hours 6.0`, `line_total 450.00`.

**Prod exposure at time of writing:** 10 `per_hour` rows, 5 on active
proposals, and `COUNT(*) FILTER (WHERE pa.quantity > p.event_duration_hours * 4)`
is 0 — i.e. no row has been inflated yet. The fold is already reachable from
the client Enhancement Lab save and the drink-plan submit; the unpushed
cancel-line feature adds admin-initiated doors. **No data repair is required**,
only that the code stop squaring. Task 7 re-verifies this immediately before
merge in case a lab save lands in the interim.

## Global Constraints

- Do NOT change what the column means. It holds the engine's OUTPUT display
  quantity. `eventCreation.addonHeadcount` and `invoiceLineItems` depend on
  that and are OUT OF SCOPE — if a change would require editing either, the
  design is wrong and the task should stop and surface.
- Money in `proposals` is NUMERIC DOLLARS; invoices/payments/refunds are INTEGER
  CENTS. `proposal_addons.quantity` is `NUMERIC(10,2)` and can hold fractions
  (prod has `3.50` for a 3.5-hour event).
- One pooled connection per request: inside a `pool.connect()` transaction every
  query goes through the held `client`.
- Tests are co-located `*.test.js`, node:test, and run ALONE against the shared
  dev DB: `node -r dotenv/config --test <file>` from the os checkout root.
  Nonce-suffixed seed rows, FK-ordered teardown, `await pool.end()` in `after()`.
- Seed fixtures MUST store add-on rows the way the writers actually store them
  (`snapshot.addons[].quantity`). A fixture that seeds a hand-computed raw count
  is what hid this defect; see Task 4.
- File-size soft cap 700 lines. `lineItemCancel.js` is ~610 and grows slightly;
  keep it under 700.
- No em dashes in client-visible copy.
- `flat` add-ons round-trip identically under every change here. Any task whose
  diff changes behavior for a `flat` add-on has a bug.

---

## Task 1: The conversion module

**Files:**
- Create: `server/utils/addonQuantity.js`
- Test: `server/utils/addonQuantity.test.js`

**Interfaces:**
- Produces:
  - `STORED_IS_INPUT_COUNT` — `Set` of billing types where the stored OUTPUT
    equals the engine INPUT count (`'flat'` plus the default bucket).
  - `effectiveHoursFor(addon, durationHours)` → `number`. Mirrors
    `calculateAddonCost`'s `per_hour` branch:
    `Math.max(Number(durationHours) || 0, Number(addon.minimum_hours || 0))`.
  - `storedToInputCount(addon, storedQuantity, durationHours)` → `number|null`.
    The engine input count recovered from the stored figure, or `null` when the
    stored figure cannot express one for that billing type (caller then lets the
    engine recompute, which is today's behavior).
  - `countLabelFor(addon)` → `'unit'|'hour'|null`. What one stored unit means,
    used by the admin UI to phrase a quantity picker.

- [ ] **Step 1: Write the failing test**

```js
// server/utils/addonQuantity.test.js
// PURE unit tests, no DB. proposal_addons.quantity holds the ENGINE'S OUTPUT
// display quantity (calculateAddonCost's return .quantity), NOT the input
// count. These are the only sanctioned conversions between the two.
//   node --test server/utils/addonQuantity.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storedToInputCount, effectiveHoursFor, STORED_IS_INPUT_COUNT, countLabelFor } = require('./addonQuantity');
const { calculateAddonCost } = require('./pricingEngine');

test('per_hour: stored is hours x count, so the count divides back out', () => {
  const addon = { billing_type: 'per_hour', rate: 75, minimum_hours: null };
  // 1 server on a 6h event stores 6 (matches prod proposal 624).
  assert.equal(storedToInputCount(addon, 6, 6), 1);
  // 2 bartenders on a 3h event store 6 (matches prod proposal 478).
  assert.equal(storedToInputCount(addon, 6, 3), 2);
  // Fractional durations are real: prod proposal 491 is a 3.5h event.
  assert.equal(storedToInputCount(addon, 3.5, 3.5), 1);
});

test('per_hour: minimum_hours is the divisor when it exceeds the event duration', () => {
  const addon = { billing_type: 'per_hour', rate: 75, minimum_hours: 4 };
  assert.equal(effectiveHoursFor(addon, 2), 4);
  // The engine billed 4 hours, so it stored 4 for one unit; recovering with the
  // raw 2-hour duration would wrongly read that as 2 units.
  assert.equal(storedToInputCount(addon, 4, 2), 1);
});

test('flat: stored IS the input count, round-trips unchanged', () => {
  const addon = { billing_type: 'flat', rate: 200 };
  assert.ok(STORED_IS_INPUT_COUNT.has('flat'));
  assert.equal(storedToInputCount(addon, 2, 4), 2);
});

test('types whose stored figure is not a count return null', () => {
  for (const bt of ['per_guest', 'per_guest_timed', 'per_staff', 'per_100_guests']) {
    assert.equal(storedToInputCount({ billing_type: bt }, 80, 4), null, bt);
  }
});

test('degenerate inputs never produce NaN or Infinity', () => {
  const addon = { billing_type: 'per_hour', rate: 40, minimum_hours: null };
  assert.equal(storedToInputCount(addon, 4, 0), null);     // no duration to divide by
  assert.equal(storedToInputCount(addon, 0, 4), null);     // nothing stored
  assert.equal(storedToInputCount(addon, null, 4), null);
  assert.equal(storedToInputCount({ billing_type: 'flat' }, null, 4), null);
});

test('round-trip against the ENGINE for every countable type', () => {
  // The contract in one assertion: price N units, store what the engine
  // returns, recover N. If calculateAddonCost ever changes shape, this fails.
  for (const [addon, count, hours] of [
    [{ billing_type: 'per_hour', rate: 40, minimum_hours: null }, 3, 4],
    [{ billing_type: 'per_hour', rate: 75, minimum_hours: 4 }, 2, 2],
    [{ billing_type: 'flat', rate: 150 }, 2, 4],
  ]) {
    const priced = calculateAddonCost(addon, 80, hours, 1, count);
    assert.equal(storedToInputCount(addon, priced.quantity, hours), count,
      `${addon.billing_type} count=${count} hours=${hours} stored=${priced.quantity}`);
  }
});

test('countLabelFor names the unit for the admin picker', () => {
  assert.equal(countLabelFor({ billing_type: 'per_hour' }), 'hour');
  assert.equal(countLabelFor({ billing_type: 'flat' }), 'unit');
  assert.equal(countLabelFor({ billing_type: 'per_guest' }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/addonQuantity.test.js`
Expected: FAIL, "Cannot find module './addonQuantity'".

- [ ] **Step 3: Write the module**

```js
'use strict';

/**
 * proposal_addons.quantity holds the pricing engine's OUTPUT display quantity
 * (`calculateAddonCost(...).quantity`), NOT the admin-facing input count. That
 * is the column's established meaning and two consumers already depend on it:
 * eventCreation.addonHeadcount divides it by duration to recover headcount, and
 * invoiceLineItems renders it as `quantity x rate` on the invoice.
 *
 * The two differ for every billing type except `flat`. For `per_hour` the
 * output is `effectiveHours * count`, so feeding the stored value back to the
 * engine as an input multiplies by hours a SECOND time: a $450 banquet-server
 * line repriced to $2,700 on a no-op fold (push review, 2026-07-26).
 *
 * These are the only sanctioned conversions. Anything that needs a unit count
 * out of the column, or needs to write the column from a count, goes through
 * here so the two definitions cannot drift apart again.
 */

// Billing types where the engine's OUTPUT quantity IS its input count, so the
// stored figure can be used as-is. Everything else stores something else
// entirely (guests, staff, blocks) or scales it (hours).
const STORED_IS_INPUT_COUNT = new Set(['flat']);

/** The hours the engine actually billed: never fewer than the addon's minimum. */
function effectiveHoursFor(addon, durationHours) {
  return Math.max(Number(durationHours) || 0, Number(addon?.minimum_hours || 0));
}

/**
 * Recover the engine INPUT count from the stored OUTPUT quantity.
 * @returns {number|null} the count, or null when the stored figure cannot
 *   express one (per_guest / per_guest_timed store guestCount; per_staff stores
 *   the staff count and the engine ignores its input; per_100_guests stores
 *   blocks). null means "let the engine recompute", which is today's behavior
 *   for those types and is deliberately unchanged here.
 */
function storedToInputCount(addon, storedQuantity, durationHours) {
  const stored = Number(storedQuantity);
  if (!Number.isFinite(stored) || stored <= 0) return null;
  const type = addon?.billing_type;
  if (STORED_IS_INPUT_COUNT.has(type)) return stored;
  if (type === 'per_hour') {
    const hours = effectiveHoursFor(addon, durationHours);
    if (!Number.isFinite(hours) || hours <= 0) return null;
    return stored / hours;
  }
  return null;
}

/** What one unit of the recovered count means, for admin-facing copy. */
function countLabelFor(addon) {
  const type = addon?.billing_type;
  if (type === 'per_hour') return 'hour';
  if (STORED_IS_INPUT_COUNT.has(type)) return 'unit';
  return null;
}

module.exports = {
  STORED_IS_INPUT_COUNT,
  effectiveHoursFor,
  storedToInputCount,
  countLabelFor,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/addonQuantity.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/utils/addonQuantity.js server/utils/addonQuantity.test.js
git commit -m "feat(addons): one sanctioned conversion between stored quantity and input count"
```

---

## Task 2: Pin the defect with a reprice-stability test

**Files:**
- Test: `server/utils/proposalExtrasFold.stability.test.js` (new)

**Interfaces:**
- Consumes: `foldExtrasIntoProposal`, `loadRepriceAddons` (server/utils/proposalExtrasFold.js), `calculateProposal` (server/utils/pricingEngine.js).
- Produces: nothing importable. This is the regression gate for the whole plan.

This task lands the failing test BEFORE the fix, so the fix is proven by a red
test going green rather than by inspection.

- [ ] **Step 1: Write the failing test**

```js
require('dotenv').config();

// REPRICE STABILITY: a fold whose before/after legs are IDENTICAL must not move
// money, for every billing type. This is the invariant that catches the whole
// family of stored-quantity-vs-input-count bugs, and the one the earlier
// per_hour test missed because it seeded a hand-written raw count instead of
// the shape the writers actually store.
//
// Fixtures store add-on rows EXACTLY as crud.js / proposalInsert.js /
// public.js do: `snapshot.addons[].quantity`, the engine's OUTPUT.
//   node -r dotenv/config --test server/utils/proposalExtrasFold.stability.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { calculateProposal } = require('./pricingEngine');
const { foldExtrasIntoProposal, loadRepriceAddons } = require('./proposalExtrasFold');

if (process.env.NODE_ENV === 'production') {
  throw new Error('proposalExtrasFold.stability.test.js refuses to run against production');
}

const NONCE = `stab-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId;
let pkg;
const seededProposals = [];
const seededAddons = [];

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id",
    [`Stability ${NONCE}`, `stab-${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'Stability Pkg', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]') RETURNING id`,
    [`stab-${NONCE}`]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [p.rows[0].id])).rows[0];
});

after(async () => {
  for (const pid of seededProposals) {
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  for (const aid of seededAddons) await pool.query('DELETE FROM service_addons WHERE id = $1', [aid]);
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

async function seedCatalogAddon({ slug, name, billingType, rate, minimumHours = null }) {
  const r = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active, minimum_hours)
     VALUES ($1, $2, $3, $4, 'all', true, $5) RETURNING *`,
    [slug, name, billingType, rate, minimumHours]
  );
  seededAddons.push(r.rows[0].id);
  return r.rows[0];
}

/**
 * Seed a proposal the way the ADMIN EDITOR does: price with the engine, then
 * store snapshot.addons[].quantity (the engine's OUTPUT) into proposal_addons.
 * This is crud.js:610-620 verbatim in miniature.
 */
async function seedPricedProposal({ addonSpecs, durationHours = 4, guestCount = 80 }) {
  const engineAddons = [];
  for (const s of addonSpecs) {
    const cat = await seedCatalogAddon(s);
    engineAddons.push({ ...cat, quantity: s.count });
  }
  const snapshot = calculateProposal({
    pkg, guestCount, durationHours, numBars: 0, numBartenders: null,
    addons: engineAddons, syrupSelections: [], adjustments: [],
    totalPriceOverride: null, gratuityRate: 0, tipJar: true,
  });
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, amount_paid, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', $3, 'America/Chicago',
             'deposit_paid', 'other', $4, 0, $5, '[]'::jsonb, $6, 100, $7::jsonb)
     RETURNING id`,
    [clientId, pkg.id, durationHours, guestCount, snapshot.inputs.numBartenders,
     snapshot.total, JSON.stringify(snapshot)]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  for (const a of snapshot.addons) {
    await pool.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [proposalId, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total, a.variant ?? null]
    );
  }
  return { proposalId, snapshot };
}

/** Run a fold with IDENTICAL legs and return before/after totals. */
async function noOpFold(proposalId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proposal = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
    const legs = await loadRepriceAddons(client, proposalId);
    const { snapshot } = await foldExtrasIntoProposal({
      client, proposal, pkg,
      addonsBefore: legs, addonsAfter: legs,
      syrupsBefore: [], syrupsAfter: [],
      numBarsBefore: proposal.num_bars ?? 0, numBarsAfter: proposal.num_bars ?? 0,
      statusChangeReason: 'stability probe',
    });
    return { before: Number(proposal.total_price), after: Number(snapshot.total), snapshot };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

test('per_hour add-on: a no-op fold does not move money', async () => {
  // 1 banquet server on a 6h event. Prod shape (proposal 624): stored 6.00,
  // line_total 450. Feeding 6 back as a COUNT reprices it as 6 servers.
  const { proposalId } = await seedPricedProposal({
    durationHours: 6,
    addonSpecs: [{ slug: `stab-srv-${NONCE}`, name: 'Stability Server', billingType: 'per_hour', rate: 75, count: 1 }],
  });
  const stored = (await pool.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(stored.quantity), 6, 'engine OUTPUT quantity is hours x count');
  assert.equal(Number(stored.line_total), 450);

  const { before, after, snapshot } = await noOpFold(proposalId);
  assert.equal(after, before, `no-op fold moved the total from ${before} to ${after}`);
  assert.equal(Number(snapshot.addons[0].line_total), 450);
  assert.equal(Number(snapshot.addons[0].quantity), 6, 'and it re-emits the same stored shape');
});

test('per_hour with count > 1 and a minimum_hours floor: stable', async () => {
  // 2 servers, 2h event, 4h minimum: engine bills 4h, stores 8.
  const { proposalId } = await seedPricedProposal({
    durationHours: 2,
    addonSpecs: [{ slug: `stab-min-${NONCE}`, name: 'Stability Min', billingType: 'per_hour', rate: 75, count: 2, minimumHours: 4 }],
  });
  const stored = (await pool.query('SELECT quantity FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(stored.quantity), 8);
  const { before, after } = await noOpFold(proposalId);
  assert.equal(after, before);
});

test('flat add-on with quantity 2: stable (the type that already round-tripped)', async () => {
  const { proposalId } = await seedPricedProposal({
    addonSpecs: [{ slug: `stab-flat-${NONCE}`, name: 'Stability Flat', billingType: 'flat', rate: 200, count: 2 }],
  });
  const { before, after, snapshot } = await noOpFold(proposalId);
  assert.equal(after, before);
  assert.equal(Number(snapshot.addons[0].line_total), 400);
});

test('per_guest add-on: stable', async () => {
  const { proposalId } = await seedPricedProposal({
    addonSpecs: [{ slug: `stab-guest-${NONCE}`, name: 'Stability Guest', billingType: 'per_guest', rate: 5, count: 1 }],
  });
  const { before, after } = await noOpFold(proposalId);
  assert.equal(after, before);
});

test('TWO no-op folds in a row are also stable (no slow drift)', async () => {
  const { proposalId } = await seedPricedProposal({
    durationHours: 5,
    addonSpecs: [{ slug: `stab-twice-${NONCE}`, name: 'Stability Twice', billingType: 'per_hour', rate: 40, count: 2 }],
  });
  const first = await noOpFold(proposalId);
  assert.equal(first.after, first.before);
  const second = await noOpFold(proposalId);
  assert.equal(second.after, second.before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node -r dotenv/config --test server/utils/proposalExtrasFold.stability.test.js`
Expected: FAIL on the two `per_hour` tests and the drift test with a message
like `no-op fold moved the total from 2690 to 4940`. The `flat` and `per_guest`
tests PASS already, which proves the defect is scoped to `per_hour`.

- [ ] **Step 3: Commit the red test**

Committing the failing test alone is deliberate: it is the artifact that proves
the defect existed, and the next task's diff is what turns it green.

```bash
git add server/utils/proposalExtrasFold.stability.test.js
git commit -m "test(addons): pin reprice stability, currently RED for per_hour"
```

---

## Task 3: Fix the reader

**Files:**
- Modify: `server/utils/proposalExtrasFold.js:44-70` (`REPRICE_ADDON_SQL`, `withRepriceQuantities`)
- Test: `server/utils/proposalExtrasFold.stability.test.js` (from Task 2, turns green)

**Interfaces:**
- Consumes: `storedToInputCount` from Task 1.
- Produces: `withRepriceQuantities(rows)` unchanged in signature. Rows from
  `REPRICE_ADDON_SQL` now additionally carry `event_duration_hours`, so the
  function can convert without a new parameter and no caller changes.
  `loadRepriceAddons(client, proposalId)` signature is unchanged.

Callers that must keep working untouched: `server/routes/drinkPlans/lab.js:279,308`,
`server/routes/drinkPlans/submit.js:238,309`, `server/utils/lineItemCancel.js:409,457`,
and `server/routes/drinkPlans/lab.test.js:244` (which calls
`withRepriceQuantities([{ ...svcRow, pa_quantity: 3 }])` directly, with NO
duration — it must not crash; see the null-guard below).

- [ ] **Step 1: Replace the SQL and the mapper**

```js
// SQL to load reprice-ready addon rows: service_addons catalog columns PLUS the
// per-proposal stored quantity AND the event duration needed to convert it.
// The bare `SELECT sa.*` this replaced dropped pa.quantity, so calculateProposal
// priced every per_hour addon as quantity 1 — silently under-billing the
// instant it repriced (cross-LLM push review, 2026-07-20). Passing that stored
// value straight back through was the OPPOSITE error: the stored figure is the
// engine's OUTPUT (hours x count for per_hour), so the engine multiplied by
// hours a second time (cross-LLM push review, 2026-07-26). service_addons has
// no `quantity` and proposals has no `minimum_hours`, so both aliases are
// unambiguous.
const REPRICE_ADDON_SQL = `
  SELECT sa.*, pa.quantity AS pa_quantity, p.event_duration_hours AS pa_duration_hours
    FROM proposal_addons pa
    JOIN service_addons sa ON sa.id = pa.addon_id
    JOIN proposals p ON p.id = pa.proposal_id
   WHERE pa.proposal_id = $1`;

/**
 * Attach the engine-facing input `quantity` to each reprice addon row.
 *
 * proposal_addons.quantity stores the engine's OUTPUT display quantity, which
 * is NOT the input count for any billing type except `flat`
 * (server/utils/addonQuantity.js explains the full table). Recover the count
 * through the shared conversion; when it cannot express one (per_guest,
 * per_guest_timed, per_staff, per_100_guests) drop the field entirely and let
 * calculateProposal recompute from guestCount / staffCount, which is what this
 * function has always done for the per_guest pair.
 * @param {Array} rows  rows from REPRICE_ADDON_SQL
 * @returns {Array} rows calculateProposal can price correctly
 */
function withRepriceQuantities(rows) {
  return (rows || []).map((r) => {
    const { pa_quantity, pa_duration_hours, ...addon } = r;
    const count = storedToInputCount(addon, pa_quantity, pa_duration_hours);
    return count === null ? addon : { ...addon, quantity: count };
  });
}
```

Add the import at the top of the file, beside the existing requires:

```js
const { storedToInputCount } = require('./addonQuantity');
```

Note the null-guard behavior this gives `lab.test.js:244` for free: that call
passes `pa_quantity: 3` with no `pa_duration_hours`, so `effectiveHoursFor`
returns 0, `storedToInputCount` returns `null`, and the row is passed through
without a `quantity` — the engine recomputes. That test asserts on money, so
run it in Step 3 and read the result rather than assuming.

- [ ] **Step 2: Run the stability test to verify it passes**

Run: `node -r dotenv/config --test server/utils/proposalExtrasFold.stability.test.js`
Expected: PASS, all 5.

- [ ] **Step 3: Run every suite this reader reaches, one at a time**

The fold is the money core; these are its callers and their neighbours.

```
node -r dotenv/config --test server/utils/proposalExtrasFold.legs.test.js
node -r dotenv/config --test server/routes/drinkPlans/lab.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitOverride.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitReconcile.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitExtras.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitPlannerV2.test.js
node -r dotenv/config --test server/utils/lineItemCancel.test.js
node -r dotenv/config --test server/routes/proposals/cancelLineItem.test.js
```

Expected: all PASS **except** `lineItemCancel.test.js`, whose `per_hour`
partial-removal test seeds a hand-written raw count and asserts count
arithmetic. It is expected to fail here and is corrected in Task 4. Record the
exact failure; do not "fix" it by loosening the assertion.

If `lab.test.js` fails, STOP: that means the direct `withRepriceQuantities`
call at line 244 changed money, which the null-guard was supposed to prevent.
Report it rather than working around it.

- [ ] **Step 4: Commit**

```bash
git add server/utils/proposalExtrasFold.js
git commit -m "fix(addons): recover the input count from the stored quantity instead of re-feeding it

proposal_addons.quantity is the engine's OUTPUT display quantity (hours x count
for per_hour), which withRepriceQuantities passed straight back as the engine's
INPUT, multiplying by hours a second time. Measured: a no-op fold took a \$450
banquet-server line to \$2,700. eventCreation.addonHeadcount and
invoiceLineItems already read the column as output; this makes the reprice
reader agree with them."
```

---

## Task 4: Fix the cancel-line consumers

**Files:**
- Modify: `server/utils/lineItemCancel.js` (`quantityIsCount` ~:68-75, the addon
  branch of `computeCancelTargets` ~:140-160, the addon mutation branch ~:420-460,
  the post-fold sync ~:540-555)
- Modify: `server/utils/lineItemCancel.test.js` (correct the fixture and the
  per_hour test)
- Modify: `client/src/pages/admin/CancelLineDialog.js` (quantity picker copy)

**Interfaces:**
- Consumes: `storedToInputCount`, `countLabelFor`, `effectiveHoursFor` (Task 1).
- Produces: target entries whose `quantity` field is the admin-facing COUNT (not
  the stored figure), plus a new optional `quantity_unit` field (`'hour'` or
  `'unit'`) the dialog uses to phrase its picker. The execute route's
  `quantity` request parameter continues to mean "how many units to remove".

This task also REVERTS a wrong fix. At the 2026-07-24 checkpoint review the
post-fold sync was changed from writing `line_total` AND `quantity` to writing
`line_total` only, with a comment asserting the column holds a raw count. That
comment is wrong and the original code was right: the snapshot entry's
`quantity` IS the value the column must hold. Restore it with a correct comment.

- [ ] **Step 1: Correct the test fixture, then write the failing test**

In `server/utils/lineItemCancel.test.js`, the `seedProposal` helper currently
computes `rawQty` and stores that. Replace that block so it stores what the
writers store:

```js
  for (const sa of snapshot.addons) {
    // Store the ENGINE'S OUTPUT quantity, exactly as crud.js / proposalInsert.js
    // / public.js do. Seeding a hand-written raw count here is what hid the
    // per_hour squaring defect from this suite (push review, 2026-07-26).
    await pool.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [proposalId, sa.id, sa.name, sa.billing_type, sa.rate, sa.quantity, sa.line_total, sa.variant ?? null]
    );
  }
```

Then replace the existing test named
`'per_hour addon partial removal keeps the RAW count in the row (no hours-baked corruption)'`
entirely with:

```js
test('per_hour partial removal: the picker counts UNITS and the row stays in stored shape', async () => {
  // 3 banquet servers on a 4h event: the engine stores 12 (hours x count) and
  // charges 4h x 75 x 3 = 900. Removing ONE server must leave 2 servers: a
  // stored 8, a $600 line, and $300 off the contract. The pre-2026-07-26 code
  // read the stored 12 as "12 units" and subtracted 1 to get 11, i.e. 2.75
  // servers.
  const slug = `perhour-${NONCE}`;
  const { proposalId } = await seedProposal({
    override: 2500,
    addons: [{ slug, name: 'Banquet Server X', billingType: 'per_hour', rate: 75, quantity: 3 }],
  });
  const seeded = (await pool.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(seeded.quantity), 12, 'stored = 4 hours x 3 servers');
  assert.equal(Number(seeded.line_total), 900);

  const { targets } = await computeCancelTargets(pool, proposalId);
  const t = targets.find((x) => x.target === `addon:${slug}`);
  assert.equal(t.quantity, 3, 'the picker offers 3 SERVERS, not 12');
  assert.equal(t.quantity_unit, 'hour');

  await applyCancel(proposalId, { target: `addon:${slug}`, quantity: 1 }, async (result, client) => {
    const row = (await client.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.quantity), 8, 'stored = 4 hours x 2 remaining servers');
    const entry = result.snapshot.addons.find((a) => a.slug === slug);
    assert.equal(Number(row.quantity), entry.quantity, 'row and snapshot agree');
    assert.equal(Number(row.line_total), entry.line_total);
    assert.equal(entry.line_total, 600);
    assert.equal(result.newTotal, 2200, 'one server off a 2500 override = -300');

    // The corruption gate: repricing from the row must reproduce 2 servers.
    const { loadRepriceAddons } = require('./proposalExtrasFold');
    const reload = await loadRepriceAddons(client, proposalId);
    assert.equal(reload.find((a) => a.slug === slug).quantity, 2);
  });
});

test('removing ALL units of a per_hour addon deletes the row', async () => {
  const slug = `perhour-all-${NONCE}`;
  const { proposalId } = await seedProposal({
    override: 2500,
    addons: [{ slug, name: 'Banquet Server All', billingType: 'per_hour', rate: 75, quantity: 2 }],
  });
  await applyCancel(proposalId, { target: `addon:${slug}` }, async (result, client) => {
    const rows = (await client.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows;
    assert.equal(rows.length, 0);
    assert.equal(result.newTotal, 2500 - 600, 'both servers off: 4h x 75 x 2');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/lineItemCancel.test.js`
Expected: FAIL. The picker asserts `t.quantity === 3` but gets `12`, and
`quantity_unit` is undefined.

- [ ] **Step 3: Convert at the three sites**

Add the import beside the existing requires in `server/utils/lineItemCancel.js`:

```js
const { storedToInputCount, countLabelFor, effectiveHoursFor } = require('./addonQuantity');
```

**(a) `quantityIsCount`** — replace the hand-rolled list with the shared
definition, so "can the admin remove part of this?" and "can we convert the
stored figure?" are the same question:

```js
/**
 * Can the admin remove PART of this add-on? Only when the stored quantity can
 * be converted to a unit count (server/utils/addonQuantity.js): `flat` stores
 * the count directly and `per_hour` stores hours x count. per_guest /
 * per_guest_timed / per_staff / per_100_guests store guests, staff, or blocks,
 * so "remove 1 of them" is meaningless and the whole line comes off.
 */
function unitCountOf(addon, storedQuantity, durationHours) {
  return storedToInputCount(addon, storedQuantity, durationHours);
}
```

Delete the old `quantityIsCount` function and replace its two call sites as
described in (b) and (c).

**(b) `computeCancelTargets`, the addon branch** — the picker must offer the
count, and name its unit:

```js
    const durationHours = Number(proposal.event_duration_hours);
    const count = unitCountOf(row, row.quantity, durationHours);
    targets.push({
      target: `addon:${row.slug}`,
      label: row.addon_name,
      amount: Number(row.line_total),
      ...(count !== null && count > 1
        ? { quantity: Math.round(count), quantity_unit: countLabelFor(row) }
        : {}),
      ...(labSlugs.has(row.slug) ? { labOwned: true } : {}),
      cancellable: true,
    });
```

**(c) `applyLineItemCancel`, the addon mutation branch** — do the arithmetic in
counts and write back in stored shape:

```js
    const durationHours = Number(proposal.event_duration_hours);
    const storedQty = Number(row.quantity) || 0;
    const totalCount = unitCountOf(row, storedQty, durationHours);
    let removeN = totalCount === null ? null : Math.round(totalCount);
    if (quantity !== null) {
      if (totalCount === null) {
        throw new ValidationError({ quantity: 'This add-on is priced per guest or per staff; remove it entirely instead.' });
      }
      removeN = positiveIntOrThrow(quantity, 'quantity', Math.round(totalCount));
    }
    if (totalCount === null || removeN >= Math.round(totalCount)) {
      await client.query('DELETE FROM proposal_addons WHERE id = $1', [row.id]);
      labCleanup = await stripLabSelection(client, proposalId, (sel) => {
        if (sel.addOns && sel.addOns[t.key] && sel.addOns[t.key].labAdded === true) {
          delete sel.addOns[t.key];
          return true;
        }
        return false;
      });
    } else {
      // Write the column in its STORED shape (engine output), not the count:
      // for per_hour that is hours x remaining. The fold re-derives it in the
      // post-fold sync below, but the row must be coherent for the fold's own
      // read of it, which happens first.
      const remainingCount = Math.round(totalCount) - removeN;
      const restored = STORED_IS_INPUT_COUNT.has(row.billing_type)
        ? remainingCount
        : remainingCount * effectiveHoursFor(row, durationHours);
      await client.query('UPDATE proposal_addons SET quantity = $1 WHERE id = $2', [restored, row.id]);
      partialAddonId = row.addon_id;
    }
```

Add `STORED_IS_INPUT_COUNT` to the import line from Task 1.

**(d) The post-fold sync** — restore writing `quantity`, with the corrected
reasoning (this reverts the 2026-07-24 checkpoint change):

```js
  // 5. Partial-quantity removal: the fold has now repriced, so re-sync the row
  // from the snapshot entry. Writing BOTH figures is correct and is what the
  // three other writers (crud.js, proposalInsert.js, public.js) do: the column
  // holds the engine's OUTPUT quantity. A 2026-07-24 change wrote line_total
  // only, on the belief that the column held a raw count; that belief was
  // wrong (server/utils/addonQuantity.js) and left per_hour rows in a shape
  // nothing else could read.
  if (partialAddonId !== null) {
    const entry = (snapshot.addons || []).find((a) => a.id === partialAddonId);
    if (entry) {
      await client.query(
        'UPDATE proposal_addons SET line_total = $1, quantity = $2 WHERE proposal_id = $3 AND addon_id = $4',
        [entry.line_total, entry.quantity, proposalId, partialAddonId]
      );
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node -r dotenv/config --test server/utils/lineItemCancel.test.js`
Expected: PASS, including the two rewritten per_hour tests.

- [ ] **Step 5: Teach the dialog to name the unit**

In `client/src/pages/admin/CancelLineDialog.js`, the picker currently reads
`Remove how many of the {maxQty}?`. With `per_hour` add-ons the count is now
servers/bartenders, so name it:

```jsx
                <label className="vstack" style={{ gap: 6 }}>
                  <span>
                    {entry.quantity_unit === 'hour'
                      ? `Remove how many of the ${maxQty}? (each is billed hourly)`
                      : `Remove how many of the ${maxQty}?`}
                  </span>
                  <input type="number" min="1" max={maxQty} step="1" value={qty}
                    onChange={(e) => setQty(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))}
                    style={{ maxWidth: 120 }} />
                </label>
```

Run: `cd client && CI=true npx react-scripts build`
Expected: exit 0, no new warnings.

- [ ] **Step 6: Commit**

```bash
git add server/utils/lineItemCancel.js server/utils/lineItemCancel.test.js client/src/pages/admin/CancelLineDialog.js
git commit -m "fix(cancel-line): count units, store engine shape

The quantity picker offered the STORED figure (12 = 4 hours x 3 servers) as if
it were a count, and partial removal subtracted from it, leaving 2.75 servers.
Both now convert through the shared addonQuantity module. Also reverts the
2026-07-24 checkpoint change that stopped writing quantity in the post-fold
sync: the snapshot entry IS the value the column must hold, and the comment
justifying that change had the column's meaning backwards."
```

---

## Task 5: Make the lab and submit writers store the same shape

**Files:**
- Modify: `server/routes/drinkPlans/lab.js:289-307` (the addon upsert)
- Modify: `server/routes/drinkPlans/submit.js:285-300` (the addon insert)

**Interfaces:**
- Consumes: nothing new. Both files already call `foldExtrasIntoProposal` and
  already hold the resulting `snapshot`.
- Produces: no exported change. After this task all five writers store
  `snapshot.addons[].quantity`.

Both files hand-compute `quantity = 1` (or `guest_count` for per_guest) before
the fold. For `per_hour` that is the wrong shape: `eventCreation.addonHeadcount`
would read a lab-added bartender as `1 / duration` staff, and the invoice line
would read "1 x $40" for a 4-hour booking. No such row exists on prod today
(verified: all 10 `per_hour` rows match the engine-output shape), so this is
closing the door rather than repairing damage.

The fix is the same in both files: keep the pre-fold insert as the fold's input
leg, then re-sync from the snapshot afterwards, which is exactly what
`lineItemCancel` does.

- [ ] **Step 1: Write the failing test**

Append to `server/routes/drinkPlans/lab.test.js`:

```js
test('a lab-added per_hour addon is stored in the engine OUTPUT shape', async () => {
  // Guards the roster and the invoice line: eventCreation.addonHeadcount
  // divides the stored figure by duration to get headcount, and
  // invoiceLineItems renders it as `quantity x rate`. Storing a raw 1 for a
  // 4-hour booking reads as 0.25 staff and "1 x $40" (push review, 2026-07-26).
  const svc = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active)
     VALUES ($1, 'Lab Hourly Helper', 'per_hour', 40, 'all', true) RETURNING id, slug`,
    [`lab-hourly-${NONCE}`]
  );
  const res = await request('PUT', `/api/drink-plans/t/${planTokens.money}/lab`, {
    body: { addOns: { [svc.rows[0].slug]: {} }, labSyrupSelections: {} },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = (await pool.query(
    `SELECT pa.quantity, pa.line_total, p.event_duration_hours
       FROM proposal_addons pa JOIN proposals p ON p.id = pa.proposal_id
      WHERE pa.proposal_id = $1 AND pa.addon_id = $2`,
    [proposalIds[proposalIds.length - 1], svc.rows[0].id]
  )).rows[0];
  await pool.query('DELETE FROM service_addons WHERE id = $1', [svc.rows[0].id]);
  assert.ok(row, 'the lab addon row should exist');
  const hours = Number(row.event_duration_hours);
  assert.equal(Number(row.quantity), hours, `stored should be ${hours} (hours x 1), got ${row.quantity}`);
  assert.equal(Number(row.line_total), hours * 40);
});
```

Note: `planTokens.money` and the `proposalIds` array are the suite's existing
fixtures; the addon must be created inside the test because the suite's
`before()` seeds its catalog before this slug exists.

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/drinkPlans/lab.test.js`
Expected: FAIL, `stored should be 4 (hours x 1), got 1`.

- [ ] **Step 3: Re-sync both writers from the snapshot**

In `server/routes/drinkPlans/lab.js`, immediately AFTER the
`foldExtrasIntoProposal` call (which produces `snapshot`) and before the invoice
work, add:

```js
      // The upsert above wrote the fold's INPUT leg by hand. Now that the
      // engine has priced it, re-sync the rows to the shape every other writer
      // stores: snapshot.addons[].quantity, the engine's OUTPUT display
      // quantity. For per_hour that is hours x count, which the staffing roster
      // (eventCreation.addonHeadcount) and the invoice line both read back
      // (push review, 2026-07-26).
      for (const entry of snapshot.addons || []) {
        await client.query(
          'UPDATE proposal_addons SET quantity = $1, line_total = $2 WHERE proposal_id = $3 AND addon_id = $4',
          [entry.quantity, entry.line_total, proposal.id, entry.id]
        );
      }
```

In `server/routes/drinkPlans/submit.js`, add the identical block immediately
after its `foldExtrasIntoProposal` call, using that file's variable names for
the snapshot and the proposal id.

- [ ] **Step 4: Run to verify it passes, then the neighbours**

```
node -r dotenv/config --test server/routes/drinkPlans/lab.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitOverride.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitReconcile.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitExtras.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitPlannerV2.test.js
node -r dotenv/config --test server/utils/proposalExtrasFold.stability.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans/lab.js server/routes/drinkPlans/submit.js server/routes/drinkPlans/lab.test.js
git commit -m "fix(drink-plans): store add-on rows in the engine output shape

lab.js and submit.js hand-wrote quantity 1 for every non-per_guest addon. For
per_hour that reads as 1/duration staff to the roster and '1 x rate' on the
invoice. Both now re-sync from the snapshot after the fold, matching crud.js,
proposalInsert.js and public.js."
```

---

## Task 6: The four cancel-line items that ride along

**Files:**
- Modify: `server/routes/proposals/cancelLineItem.js` (Stripe guard, target validation)
- Modify: `server/utils/refundHelpers.js` (`loadPaymentsWithRemaining` rails)
- Modify: `server/utils/lineItemCancel.js` (addon target amount)
- Test: `server/routes/proposals/cancelLineItem.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks except the Task 1 import already added.
- Produces: `loadPaymentsWithRemaining(proposalId, dbClient, { rails })` gains an
  OPTIONAL third argument. Default rails stay
  `['deposit','balance','full','invoice']` so `server/routes/stripe.js` is
  byte-identical in behavior; the cancel-line route passes the wider set.

These are the push-review findings judged worth fixing with the blocker rather
than logging. Each is independent; commit them together as one "review fixes"
unit since none is independently interesting.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/proposals/cancelLineItem.test.js`:

```js
test('a non-string target is rejected before anything commits', async () => {
  const o = await seedProposal({});
  const before = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  const r = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
    token: await mintAdmin(), body: { target: { kind: 'adjustment', key: '0' } },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'VALIDATION_ERROR');
  const after = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [o.proposalId])).rows[0];
  assert.equal(Number(after.total_price), Number(before.total_price));
  const log = (await pool.query(
    "SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'line_item_cancelled'",
    [o.proposalId])).rows;
  assert.equal(log.length, 0, 'no audit row may claim a removal that never happened');
});

test('a drink-plan-rail charge funds the refund instead of a manual return', async () => {
  // The cancel-line feature removes drink-plan items, so the charge that paid
  // for them must be refundable. The admin-panel rail list excluded
  // drink_plan_extras / drink_plan_with_balance, which sent the client a "we
  // will return it separately" notice for money sitting on a refundable Stripe
  // charge (cross-LLM push review, 2026-07-26).
  const o = await seedProposal({ payments: [] });
  const intent = `pi_dpx_${NONCE}`;
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'drink_plan_extras', 250000, 'succeeded', $2)`,
    [o.proposalId, intent]
  );
  const prev = await request('POST', `/api/proposals/${o.proposalId}/cancel-line/preview`, {
    token: await mintAdmin(), body: { target: `addon:${o.addonSlug}` },
  });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.refund.manual_return_cents, 0, 'this money is refundable, not a manual return');
  assert.equal(prev.body.refund.stripe_cents, 20000);
  assert.equal(prev.body.refund.splits, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node -r dotenv/config --test server/routes/proposals/cancelLineItem.test.js`
Expected: FAIL on both — the object target currently reaches the core, and the
drink-plan charge currently yields `manual_return_cents: 20000`.

- [ ] **Step 3: Apply the four fixes**

**(a) Validate the target at the route.** In `server/routes/proposals/cancelLineItem.js`,
inside `runCore` before calling the core:

```js
    // parseCancelTarget only runs for strings, so a crafted object target would
    // otherwise reach the per-kind switch unvalidated and could commit an audit
    // row claiming a removal that never happened (cross-LLM push review).
    if (typeof req.body.target !== 'string') {
      throw new ValidationError({ target: 'Missing or malformed cancel target' });
    }
```

Add `ValidationError` to the `errors` import on that file.

**(b) Guard the Stripe client BEFORE the removal commits.** Move the
acquisition above `runCore` in the execute handler, matching
`server/routes/stripe.js:430` and `server/routes/proposals/cancel.js:468`:

```js
  // Acquire BEFORE the removal commits. getStripe() fails closed when creds are
  // missing; discovering that after the commit leaves the line removed with a
  // pending refund row blocking headroom and the operator told the refund is
  // "unconfirmed" when nothing was ever attempted (cross-LLM push review).
  const stripe = getStripe();
  if (!stripe) throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
```

and delete the later `const stripe = getStripe();` inside the refund loop.

**(c) Widen the refund rails for this flow.** In `server/utils/refundHelpers.js`:

```js
/** Rails the admin refund panel considers refundable. */
const PANEL_REFUND_RAILS = Object.freeze(['deposit', 'balance', 'full', 'invoice']);
/**
 * Rails the cancel-line flow considers refundable: the panel set PLUS the
 * drink-plan rails, because cancelling a drink-plan item must be able to refund
 * the charge that paid for it. Both rails roll into proposals.amount_paid
 * (paymentIntentSucceeded), so excluding them made the overpayment fall entirely
 * into manual_return_cents (cross-LLM push review, 2026-07-26).
 */
const CANCEL_LINE_REFUND_RAILS = Object.freeze([
  ...PANEL_REFUND_RAILS, 'drink_plan_extras', 'drink_plan_with_balance',
]);

async function loadPaymentsWithRemaining(proposalId, dbClient = pool, { rails = PANEL_REFUND_RAILS } = {}) {
  const res = await dbClient.query(
    `SELECT pp.id,
            pp.stripe_payment_intent_id,
            pp.amount
              - COALESCE((SELECT SUM(pr.amount) FROM proposal_refunds pr
                           WHERE pr.payment_id = pp.id AND pr.status IN ('succeeded', 'pending')), 0)
              AS "remainingCents"
       FROM proposal_payments pp
      WHERE pp.proposal_id = $1
        AND pp.status = 'succeeded'
        AND pp.stripe_payment_intent_id IS NOT NULL
        AND pp.payment_type = ANY($2::text[])`,
    [proposalId, rails]
  );
  return res.rows.map((r) => ({
    id: r.id,
    stripe_payment_intent_id: r.stripe_payment_intent_id,
    remainingCents: Number(r.remainingCents),
  }));
}
```

Export both constants. In `cancelLineItem.js`'s `runCore`, pass the wider set:

```js
    const payments = await loadPaymentsWithRemaining(req.params.id, client, { rails: CANCEL_LINE_REFUND_RAILS });
```

`server/routes/stripe.js` keeps calling `loadPaymentsWithRemaining(proposalId)`
and is unchanged.

**(d) Mirror the breakdown row for the additional-bartender add-on target.** In
`computeCancelTargets`, the add-on's `line_total` bakes the gratuity surcharge in
while its breakdown row splits it out, so the UI's amount check orphans it.
Locate its row the same way the override target does, but skip the override row
when one exists:

```js
    // The additional-bartender ADD-ON row and the num_bartenders OVERRIDE row
    // share a label shape; the engine emits the override first (pricingEngine
    // :458-481, then the addon loop). Take the LAST matching row when both
    // exist. Needed because this addon's line_total includes the gratuity
    // surcharge that its breakdown row puts on a separate Shared Gratuity line.
    let displayAmount = Number(row.line_total);
    if (row.slug === 'additional-bartender') {
      const matches = (snap?.breakdown || []).filter(
        (b) => typeof b?.label === 'string' && b.label.startsWith('Additional Bartender')
      );
      const own = matches.length > 1 ? matches[matches.length - 1] : matches[0];
      if (own) displayAmount = Number(own.amount);
    }
```

and use `amount: displayAmount` in the pushed target.

- [ ] **Step 4: Run to verify they pass, plus the panel's own suite**

```
node -r dotenv/config --test server/routes/proposals/cancelLineItem.test.js
node -r dotenv/config --test server/utils/refundHelpers.test.js
node -r dotenv/config --test server/utils/refundHelpers.splits.test.js
node -r dotenv/config --test server/routes/stripe.webhook.test.js
node -r dotenv/config --test server/utils/lineItemCancel.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/cancelLineItem.js server/utils/refundHelpers.js server/utils/lineItemCancel.js server/routes/proposals/cancelLineItem.test.js
git commit -m "fix(cancel-line): validate target, guard Stripe before commit, refund drink-plan rails, restore the bartender addon button"
```

---

## Task 7: Verify prod is still clean, update the docs, run the lane gate

**Files:**
- Modify: `ARCHITECTURE.md` (Database Schema, `proposal_addons`)
- Modify: `docs/fix-list-remaining-2026-07-02.md` (correct the wrong entry, log what stays deferred)
- Modify: `scripts/money-smoke-list.txt`

- [ ] **Step 1: Re-verify prod data**

The plan was written against a prod snapshot showing 10 `per_hour` rows, none
inflated. A client Lab save could have landed since. Re-run read-only against
the `production` branch (`br-noisy-frog-ad99sa6l`, project `round-tooth-34649976`)
via the Neon MCP:

```sql
SELECT pa.proposal_id, pa.addon_name, pa.quantity, p.event_duration_hours,
       pa.line_total, pa.rate, p.status
  FROM proposal_addons pa JOIN proposals p ON p.id = pa.proposal_id
 WHERE pa.billing_type = 'per_hour'
 ORDER BY pa.proposal_id DESC;
```

Expected: every `quantity` equals `event_duration_hours * a small integer` (1-3
staff). Any row where `quantity / event_duration_hours` is not close to a whole
number, or exceeds ~6, was inflated by a reprice and needs a repair statement
written before merge. If all clean, record "no repair required" in the commit
message.

- [ ] **Step 2: Docs**

In `ARCHITECTURE.md`, under the `proposal_addons` schema entry, add:

```
- `quantity` (NUMERIC(10,2)) — the pricing engine's OUTPUT display quantity for
  the add-on (`calculateAddonCost(...).quantity`), NOT the admin's unit count.
  Per billing_type: `per_guest`/`per_guest_timed` store guestCount, `per_hour`
  stores effectiveHours x count, `per_staff` stores the staff count,
  `per_100_guests` stores 100-guest blocks, `flat` stores the count. Read back
  by `eventCreation.addonHeadcount` (divides by duration for headcount) and
  `invoiceLineItems` (renders `quantity x rate`). Any code converting between
  this and a unit count MUST go through `server/utils/addonQuantity.js`;
  re-feeding the stored figure to the engine as an input multiplied per_hour
  add-ons by their own hours (a $450 line repriced to $2,700, 2026-07-26).
```

In `docs/fix-list-remaining-2026-07-02.md`, under the 2026-07-26 push-review
section, DELETE the bullet beginning "The `additional-bartender` ADD-ON
target's amount comes from `proposal_addons.line_total`" (fixed in Task 6),
DELETE the two bullets about the non-string target and `getStripe()` (fixed in
Task 6), DELETE the drink-plan rails bullet (fixed in Task 6), and add:

```
- CORRECTION: an earlier entry here and a code comment in `lineItemCancel.js`
  claimed `proposal_addons.quantity` holds "the RAW unit count". That is wrong;
  it holds the engine's OUTPUT display quantity. See
  `server/utils/addonQuantity.js` and the ARCHITECTURE schema note. The
  2026-07-24 checkpoint change that stopped writing `quantity` in the post-fold
  sync was made on that wrong belief and has been reverted.
- Still open, same family: for `per_guest` add-ons the admin's unit count is not
  recoverable from the column at all (it stores guestCount), so a per_guest
  add-on sold at count 2 reprices as count 1 and UNDER-bills. Not reachable
  today (no live proposal has an admin-set per_guest count > 1) and deliberately
  unchanged by the 2026-07-26 work, which kept the existing conservative
  behavior for that type.
- A partial removal of a LAB-owned add-on leaves the `labAdded` entry in
  `drink_plans.selections`, so the client's next Lab save re-upserts it at the
  lab's own quantity and undoes the partial removal. Narrow: the lab creates
  its add-ons at count 1, so a partial removal is only possible if an admin
  first raised the quantity in the editor.
- `computeCancelTargets` enumerates targets for a package-less proposal, but
  `applyLineItemCancel` throws `NO_PACKAGE` for it, so every button 409s.
```

In `scripts/money-smoke-list.txt`, add under the cancel-line block:

```
server/utils/proposalExtrasFold.stability.test.js
server/utils/addonQuantity.test.js
```

- [ ] **Step 3: Lane gate — every suite this work reaches, one at a time**

```
node -r dotenv/config --test server/utils/addonQuantity.test.js
node -r dotenv/config --test server/utils/proposalExtrasFold.stability.test.js
node -r dotenv/config --test server/utils/proposalExtrasFold.legs.test.js
node -r dotenv/config --test server/utils/lineItemCancel.test.js
node -r dotenv/config --test server/routes/proposals/cancelLineItem.test.js
node -r dotenv/config --test server/routes/drinkPlans/lab.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitOverride.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitReconcile.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitExtras.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitPlannerV2.test.js
node -r dotenv/config --test server/utils/refundHelpers.test.js
node -r dotenv/config --test server/utils/refundHelpers.scope.test.js
node -r dotenv/config --test server/utils/refundHelpers.splits.test.js
node -r dotenv/config --test server/utils/refundSweepScheduler.test.js
node -r dotenv/config --test server/routes/proposals/cancel.test.js
node -r dotenv/config --test server/routes/stripe.webhook.test.js
node -r dotenv/config --test server/utils/invoiceLifecycle.additionalInvoice.test.js
node -r dotenv/config --test server/utils/payrollAccrual.test.js
```

`payrollAccrual` and `invoiceLifecycle.additionalInvoice` are in the list because
the staffing roster and the invoice line both read the column this plan touches.

Then the client build: `cd client && CI=true npx react-scripts build` (exit 0).

Expected: all PASS. A failure here blocks the merge; do not proceed.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md docs/fix-list-remaining-2026-07-02.md scripts/money-smoke-list.txt
git commit -m "docs(addons): document what proposal_addons.quantity means; correct the wrong fix-list entry"
```

---

## Manual verification (before the merge fleet)

On the dev DB with the dev server restarted:

1. Open an admin proposal with a per_hour add-on (create one: editor, add 2
   Banquet Servers on a 5-hour event). The pricing card should show
   `Banquet Server (10hrs)` at `$750`, and the payment panel total should match.
2. Save the proposal again with NO changes. The total must not move. Before this
   work it would have jumped to `$3,750`.
3. Open the cancel-line dialog on that add-on. The picker must say "Remove how
   many of the 2?", not 10.
4. Remove 1. The line becomes `$375`, the total drops by `$375`, and the
   staffing card on the event page still shows the right number of servers.
5. Open the event page and confirm the shift's `positions_needed` did not jump.

## Review scaling

Money path, and it changes the reprice core every proposal flows through. Full
review fleet at merge plus `/second-opinion` on the same commits. Sensitive
files touched: `proposalExtrasFold.js`, `refundHelpers.js`, `lineItemCancel.js`,
`cancelLineItem.js`, `drinkPlans/submit.js`, `drinkPlans/lab.js`.

## Self-review notes

- **Coverage:** every finding this plan claims to fix has a task — reader
  (Task 3), writers (Task 5), cancel-line consumers (Task 4), the four ride-along
  findings (Task 6), docs and the wrong fix-list entry (Task 7). The stability
  test (Task 2) is the gate for the whole family.
- **Deliberately NOT in scope:** `eventCreation.addonHeadcount` and
  `invoiceLineItems` (they already read the column correctly), the `per_guest`
  count-recovery limitation (logged in Task 7), and the ~20 previously deferred
  items in the fix list.
- **Type consistency:** `storedToInputCount(addon, storedQuantity, durationHours)`
  and `effectiveHoursFor(addon, durationHours)` are used with those exact
  signatures in Tasks 3, 4 and 6; `STORED_IS_INPUT_COUNT` is a `Set` in all uses;
  `countLabelFor` returns `'hour'|'unit'|null` and the dialog only branches on
  `'hour'`.
