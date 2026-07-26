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
      - server/routes/drinkPlans/lab.test.js
      - server/routes/drinkPlans/submit.js
      - server/routes/drinkPlans/submitOverride.test.js
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

**Architecture:** The column stores the pricing engine's OUTPUT display quantity, and three consumers already depend on that: `eventCreation.addonHeadcount` divides it by duration to recover headcount, `invoiceLineItems` renders it as `qty x rate`, and the admin editor inverts it back to the stepper count on load
(`client/src/pages/admin/proposalEditor/formState.js:70-116`, `recoverAddonQuantities`).
One reader (`withRepriceQuantities`) feeds it back as the engine's INPUT count, which squares the hours for `per_hour`; two writers (lab, submit) store a raw count instead of the output shape. This plan introduces a single SERVER-side conversion module, modelled on the client inverter that already gets this right, points the reader and the writers at it, and pins the whole thing with a reprice-stability test that no-op folds cannot move money.

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
all `flatMap`ing `snapshot.addons[].quantity`). Three consumers correctly treat
it as output: `eventCreation.addonHeadcount` (server/utils/eventCreation.js:51-58)
divides by duration to recover headcount, `invoiceLineItems`
(server/utils/invoiceLineItems.js:83-94) renders `quantity x rate`, and
`recoverAddonQuantities` (client/src/pages/admin/proposalEditor/formState.js:70-116)
inverts it back to the admin's 1-10 stepper count when the editor loads. The
admin editor is therefore NOT a reproduction path: it already recovers the count
correctly, which is why an unchanged admin re-save does not move money today.

`withRepriceQuantities` (server/utils/proposalExtrasFold.js:57-70) passes the
stored OUTPUT back as the engine's INPUT for every type except
`per_guest`/`per_guest_timed`. Its docstring asserts the column holds "the real
unit count for per_hour/flat/etc.", which is true for `flat` and false for `per_hour`.

Measured on the dev DB with a prod-shaped row (probe, rolled back): one banquet
server, 6-hour event, stored `quantity 6.00` / `line_total 450`. A NO-OP fold
(identical before/after legs) repriced the line to **$2,700** and the proposal
total from $2,690 to $4,940. Prod stores exactly this shape: proposal 624 has
`quantity 6.00`, `rate 75`, `event_duration_hours 6.0`, `line_total 450.00`.

### The second money channel: staff basis, not just the add-on line

The inflated count does not stop at the add-on's own line. `calculateProposal`
reads the SAME input quantity to build `additionalBartenderQty` and `totalStaff`
(pricingEngine.js:369-371), and `gratuityStaffCount` is
`staffing.actual + additionalBartenderQty` (pricingEngine.js:437). So a stored
`4.00` on an `additional-bartender` row reads as FOUR bartenders for the
gratuity basis on a 4-hour event.

That matters because gratuity is layered on TOP of a `total_price_override`
(pricingEngine.js:441-443). On an override proposal the add-on inflation cancels
in the fold's before/after delta and `total_price` looks safe, but the gratuity
line does NOT cancel, so a no-op fold still moves money there. `totalStaff` also
feeds `per_staff` add-on pricing, a third channel. Task 2 pins an override +
`gratuity_rate > 0` case for exactly this reason.

The inflated `snapshot.addons[]` is also persisted verbatim into
`proposals.pricing_snapshot`, which is what the client-facing proposal view
renders. A proposal can therefore carry a client-visible $2,700 line while
`total_price` reads correct.

**Prod exposure at time of writing:** 10 `per_hour` rows, 5 on active
proposals, and `COUNT(*) FILTER (WHERE pa.quantity > p.event_duration_hours * 4)`
is 0, i.e. no ROW has been inflated yet. The fold is already reachable from
the client Enhancement Lab save and the drink-plan submit; the unpushed
cancel-line feature adds admin-initiated doors. **No row repair is expected**,
only that the code stop squaring. That row check does NOT cover the two channels
above, so Task 7 additionally re-verifies `pricing_snapshot->'addons'` and the
gratuity basis before merge.

## Global Constraints

- Do NOT change what the column means. It holds the engine's OUTPUT display
  quantity. `eventCreation.addonHeadcount`, `invoiceLineItems` and the client's
  `recoverAddonQuantities` depend on that and are OUT OF SCOPE. If a change
  would require editing any of them, the design is wrong and the task should
  stop and surface.
- The client inverter is the REFERENCE IMPLEMENTATION.
  `client/src/pages/admin/proposalEditor/formState.js:70-116` already solves
  this problem correctly, including the two subtleties below. The new server
  module mirrors it. If the two disagree on a billing type, say so in the
  module's docstring and explain why; never let them drift silently.
- `additional-bartender` divides by RAW `durationHours`, not effective hours.
  Its engine branch is bespoke (pricingEngine.js:387-405) and ignores
  `minimum_hours` entirely, while every other `per_hour` add-on uses
  `max(durationHours, minimum_hours)`. Both existing inverters encode this split
  (eventCreation.js:52-54, formState.js:80-91). Safe today only because that
  slug's `minimum_hours` is NULL; encode it anyway.
- Counts are INTEGERS. Steppers are 1-10 and half a bartender is not a thing, so
  the conversion rounds to the nearest whole unit with a floor of 1, exactly as
  the client inverter does. This is load-bearing, not cosmetic: it is what keeps
  a legacy mis-shaped row (a lab-written raw `1` on a 4-hour event) recovering as
  1 unit instead of 0.25, i.e. what stops this fix from becoming an under-bill.
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
- File-size soft cap 700 lines. `lineItemCancel.js` is 635 today and Tasks 4 and
  6(d) add roughly 35 to 45, landing near 670 to 680. Under the cap, but the
  headroom is thin: any further growth in this lane needs a split first.
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
  - `storedIsInputCount(billingType)` → `boolean`. True when the stored OUTPUT
    equals the engine INPUT count. That is `flat` AND the engine's `default:`
    bucket, which prices `rate x qty` identically (pricingEngine.js:182-186).
    A PREDICATE, not a Set, and the exclusion list is the explicit one:
    `proposal_addons.billing_type` is a bare `VARCHAR(20)` with no CHECK, and
    today's `withRepriceQuantities` passes the stored count through for every
    type except the per_guest pair. An allowlist of `['flat']` would silently
    drop the count for an unrecognized or NULL billing_type, which is the exact
    under-bill the 2026-07-20 review found, reintroduced for that bucket.
  - `effectiveHoursFor(addon, durationHours)` → `number`. Mirrors
    `calculateAddonCost`'s `per_hour` branch:
    `Math.max(Number(durationHours) || 0, Number(addon.minimum_hours || 0))`.
  - `storedToInputCount(addon, storedQuantity, durationHours)` → `number|null`.
    The engine input count recovered from the stored figure, or `null` when the
    stored figure cannot express one for that billing type (caller then lets the
    engine recompute, which is today's behavior).
  - `countLabelFor(addon)` → `'unit'|'hour'|null`. What one stored unit means,
    used by the admin UI to phrase a quantity picker.

The module is the SERVER twin of
`client/src/pages/admin/proposalEditor/formState.js:70-116`. Read that function
first: it already handles the `additional-bartender` raw-duration split and the
round-to-integer contract, and its comments record why each divisor is what it
is. Two deliberate divergences, both documented in the module:

| | client `recoverAddonQuantities` | this module |
|---|---|---|
| `per_guest` | recovers the count from `line_total / (quantity x rate)` | returns `null` (the fold has no `line_total` in its SELECT; unchanged behavior, logged in Task 7) |
| `per_staff`, `per_100_guests` | treats the stored figure as the raw count | returns `null`. The engine IGNORES the input for both, so dropping the field and letting it recompute is identical in effect. Inert, but write it down |
| upper clamp | clamps to 10 (the stepper's max) | NO clamp: clamping would silently re-bill a corrupt row at 10 units instead of surfacing it |

- [ ] **Step 1: Write the failing test**

```js
// server/utils/addonQuantity.test.js
// PURE unit tests, no DB. proposal_addons.quantity holds the ENGINE'S OUTPUT
// display quantity (calculateAddonCost's return .quantity), NOT the input
// count. These are the only sanctioned conversions between the two.
//   node --test server/utils/addonQuantity.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storedToInputCount, effectiveHoursFor, storedIsInputCount, countLabelFor } = require('./addonQuantity');
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

test('additional-bartender divides by RAW duration, never the minimum', () => {
  // Its engine branch (pricingEngine.js:387-405) is bespoke and ignores
  // minimum_hours; eventCreation.js:52-54 and formState.js:80-84 both encode
  // the same split. NULL on the catalog row today, so this pins the intent.
  const ab = { slug: 'additional-bartender', billing_type: 'per_hour', rate: 40, minimum_hours: 4 };
  assert.equal(effectiveHoursFor(ab, 2), 2, 'raw duration, not the 4h minimum');
  assert.equal(storedToInputCount(ab, 4, 2), 2, '2 bartenders on a 2h event store 4');
});

test('a legacy mis-shaped row recovers as 1 unit, not a fraction', () => {
  // lab.js / submit.js wrote a raw `1` before Task 5. Dividing that by 4 hours
  // gives 0.25, which would price a quarter of a server and UNDER-bill by 4x.
  // Rounding with a floor of 1 (what the client inverter does) keeps today's
  // money exactly where it is while the writers get fixed.
  const addon = { billing_type: 'per_hour', rate: 40, minimum_hours: null };
  assert.equal(storedToInputCount(addon, 1, 4), 1);
  assert.equal(storedToInputCount(addon, 2, 4), 1, 'still one unit, rounded');
  assert.equal(storedToInputCount(addon, 7, 4), 2, 'rounds to the nearest whole unit');
});

test('flat: stored IS the input count, round-trips unchanged', () => {
  const addon = { billing_type: 'flat', rate: 200 };
  assert.ok(storedIsInputCount('flat'));
  assert.equal(storedToInputCount(addon, 2, 4), 2);
});

test('an unrecognized billing_type keeps its count (the engine default branch)', () => {
  // billing_type is a bare VARCHAR with no CHECK, and the engine's `default:`
  // branch prices rate x qty exactly like flat, so the stored figure IS the
  // count. Reading it as "not a count" would drop it to 1 and under-bill, the
  // same defect the 2026-07-20 review found for per_hour.
  assert.ok(storedIsInputCount('some-future-type'));
  assert.ok(storedIsInputCount(null));
  assert.equal(storedToInputCount({ billing_type: 'some-future-type' }, 3, 4), 3);
  assert.equal(storedToInputCount({ billing_type: null }, 3, 4), 3);
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
 * These are the only sanctioned SERVER conversions. Anything that needs a unit
 * count out of the column, or needs to write the column from a count, goes
 * through here so the two definitions cannot drift apart again.
 *
 * SERVER TWIN of client/src/pages/admin/proposalEditor/formState.js:70-116
 * (`recoverAddonQuantities`), which has inverted this column correctly since the
 * editor was built. Two deliberate divergences:
 *   - per_guest: the client recovers the count from line_total / (qty x rate);
 *     the reprice SELECT carries no line_total, so this returns null and the
 *     engine recomputes at count 1, which is the pre-existing behavior.
 *   - no upper clamp: the client clamps to the stepper's max of 10; clamping
 *     here would silently re-bill a corrupt row at 10 units instead of leaving
 *     it visible.
 */

// Billing types whose stored OUTPUT is NOT the input count: they store guests,
// staff, or 100-guest blocks instead. Stated as an exclusion list on purpose.
// billing_type is a bare VARCHAR(20) with no CHECK, and the engine's `default:`
// branch prices `rate x qty` exactly like `flat`, so an unrecognized or NULL
// type stores the count and must keep being read as one.
const STORED_IS_NOT_A_COUNT = new Set(['per_guest', 'per_guest_timed', 'per_staff', 'per_100_guests']);

/** Does the column hold the engine's INPUT count verbatim for this type? */
function storedIsInputCount(billingType) {
  return billingType !== 'per_hour' && !STORED_IS_NOT_A_COUNT.has(billingType);
}

/**
 * The hours the engine actually billed for this add-on.
 * `additional-bartender` is bespoke: calculateProposal gives it its own branch
 * (pricingEngine.js:387-405) that multiplies by RAW durationHours and never
 * consults minimum_hours. Every other per_hour add-on goes through
 * calculateAddonCost's max(durationHours, minimum_hours). eventCreation.js:52-54
 * and formState.js:80-91 both encode the same split; keep all three in step.
 */
function effectiveHoursFor(addon, durationHours) {
  const hours = Number(durationHours) || 0;
  if (addon?.slug === 'additional-bartender') return hours;
  return Math.max(hours, Number(addon?.minimum_hours || 0));
}

/**
 * Recover the engine INPUT count from the stored OUTPUT quantity.
 *
 * Rounds to the nearest whole unit with a floor of 1, matching the client
 * inverter. Counts are integers everywhere (the stepper is 1-10, and half a
 * banquet server does not exist), and the rounding is load-bearing: a legacy
 * lab-written raw `1` on a 4-hour event would otherwise recover as 0.25 and
 * turn this fix into a 4x under-bill on the very paths it is meant to protect.
 *
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
  let raw;
  if (type === 'per_hour') {
    const hours = effectiveHoursFor(addon, durationHours);
    if (!Number.isFinite(hours) || hours <= 0) return null;
    raw = stored / hours;
  } else if (storedIsInputCount(type)) {
    raw = stored;
  } else {
    return null;
  }
  if (!Number.isFinite(raw)) return null;
  return Math.max(1, Math.round(raw));
}

/** What one unit of the recovered count means, for admin-facing copy. */
function countLabelFor(addon) {
  const type = addon?.billing_type;
  if (type === 'per_hour') return 'hour';
  if (storedIsInputCount(type)) return 'unit';
  return null;
}

module.exports = {
  STORED_IS_NOT_A_COUNT,
  storedIsInputCount,
  effectiveHoursFor,
  storedToInputCount,
  countLabelFor,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/addonQuantity.test.js`
Expected: PASS (10 tests).

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

async function catalogAddonFor(spec) {
  if (spec.existingSlug) {
    // A REAL catalog row, needed when the engine branches on the slug itself
    // (additional-bartender). Never pushed to seededAddons: teardown must not
    // delete a live catalog row.
    const r = await pool.query('SELECT * FROM service_addons WHERE slug = $1 AND is_active = true', [spec.existingSlug]);
    assert.ok(r.rows[0], `dev DB has the ${spec.existingSlug} addon`);
    return r.rows[0];
  }
  const r = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active, minimum_hours)
     VALUES ($1, $2, $3, $4, 'all', true, $5) RETURNING *`,
    [spec.slug, spec.name, spec.billingType, spec.rate, spec.minimumHours ?? null]
  );
  seededAddons.push(r.rows[0].id);
  return r.rows[0];
}

/**
 * Seed a proposal the way the ADMIN EDITOR does: price with the engine, then
 * store snapshot.addons[].quantity (the engine's OUTPUT) into proposal_addons.
 * This is crud.js:610-620 verbatim in miniature.
 */
async function seedPricedProposal({
  addonSpecs, durationHours = 4, guestCount = 80, override = null, gratuityRate = 0,
}) {
  const engineAddons = [];
  for (const s of addonSpecs) {
    const cat = await catalogAddonFor(s);
    engineAddons.push({ ...cat, quantity: s.count });
  }
  const snapshot = calculateProposal({
    pkg, guestCount, durationHours, numBars: 0, numBartenders: null,
    addons: engineAddons, syrupSelections: [], adjustments: [],
    totalPriceOverride: override, gratuityRate, tipJar: true,
  });
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, total_price_override, gratuity_rate, tip_jar, amount_paid, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', $3, 'America/Chicago',
             'deposit_paid', 'other', $4, 0, $5, '[]'::jsonb, $6, $7, $8, true, 100, $9::jsonb)
     RETURNING id`,
    [clientId, pkg.id, durationHours, guestCount, snapshot.inputs.numBartenders,
     snapshot.total, override, gratuityRate, JSON.stringify(snapshot)]
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

test('override + gratuity: a no-op fold does not move the gratuity line', async () => {
  // The channel the add-on line alone hides, and the reason this test exists at
  // all. On an override proposal the add-on inflation CANCELS in the fold's
  // catalog delta, so total_price looks safe. But gratuity is layered on TOP of
  // the override (pricingEngine.js:441-443) and its staff basis reads the SAME
  // input quantity (pricingEngine.js:369, :437). Two addon bartenders on a 4h
  // event store 8; read back as 8 HEADS the basis goes 3 to 9 and the gratuity
  // line roughly triples with the override untouched.
  // Uses the REAL additional-bartender slug: both the engine branch and the
  // gratuity basis key on that exact string, so a nonce slug proves nothing.
  const { proposalId, snapshot: seeded } = await seedPricedProposal({
    durationHours: 4,
    override: 3000,
    gratuityRate: 60,
    addonSpecs: [{ existingSlug: 'additional-bartender', count: 2 }],
  });
  const stored = (await pool.query(
    `SELECT pa.quantity FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id
      WHERE pa.proposal_id = $1 AND sa.slug = 'additional-bartender'`,
    [proposalId]
  )).rows[0];
  assert.equal(Number(stored.quantity), 8, 'stored = 4 hours x 2 bartenders');

  const { before, after, snapshot } = await noOpFold(proposalId);
  assert.equal(after, before, `no-op fold moved the total from ${before} to ${after}`);
  assert.equal(snapshot.gratuity.staff_count, seeded.gratuity.staff_count,
    'the gratuity staff basis is a HEADCOUNT and must not move on a no-op fold');
});

test('TWO folds in a row: the second reads what the first wrote (no slow drift)', async () => {
  // Both folds run in ONE transaction on purpose. noOpFold ROLLBACKs, so
  // calling it twice would just repeat the first test from identical state and
  // prove nothing about drift. Drift only shows when the second fold reads the
  // total the first one persisted.
  const { proposalId } = await seedPricedProposal({
    durationHours: 5,
    addonSpecs: [{ slug: `stab-twice-${NONCE}`, name: 'Stability Twice', billingType: 'per_hour', rate: 40, count: 2 }],
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rounds = [];
    for (let i = 0; i < 2; i++) {
      const proposal = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
      const legs = await loadRepriceAddons(client, proposalId);
      const { snapshot } = await foldExtrasIntoProposal({
        client, proposal, pkg,
        addonsBefore: legs, addonsAfter: legs,
        syrupsBefore: [], syrupsAfter: [],
        numBarsBefore: proposal.num_bars ?? 0, numBarsAfter: proposal.num_bars ?? 0,
        statusChangeReason: 'stability probe',
      });
      rounds.push({ before: Number(proposal.total_price), after: Number(snapshot.total) });
    }
    assert.equal(rounds[0].after, rounds[0].before, 'the first fold moved the total');
    assert.equal(rounds[1].before, rounds[0].before, 'the first fold persisted a different total');
    assert.equal(rounds[1].after, rounds[1].before, 'the second fold moved the total');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node -r dotenv/config --test server/utils/proposalExtrasFold.stability.test.js`
Expected: FAIL on the two `per_hour` tests, the override + gratuity test, and
the drift test, with messages like `no-op fold moved the total from 2690 to 4940`.
The `flat` and `per_guest` tests PASS already, which proves the defect is scoped
to `per_hour`. Record the override test's actual before/after: it is the only
evidence in the plan that the gratuity channel is real, and if it PASSES the
premise in "The second money channel" is wrong and the task should stop and
surface rather than delete the test.

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
- Modify: `server/routes/drinkPlans/lab.test.js` (correct the per_hour fixture to the stored shape)
- Test: `server/utils/proposalExtrasFold.stability.test.js` (from Task 2, turns green)

**Interfaces:**
- Consumes: `storedToInputCount` from Task 1.
- Produces: `withRepriceQuantities(rows)` unchanged in signature. Rows from
  `REPRICE_ADDON_SQL` now additionally carry `pa_duration_hours` (aliased from
  `p.event_duration_hours`), so the function can convert without a new parameter
  and no caller changes.
  `loadRepriceAddons(client, proposalId)` signature is unchanged.

Callers that must keep working untouched: `server/routes/drinkPlans/lab.js:279,308`,
`server/routes/drinkPlans/submit.js:238,309`, `server/utils/lineItemCancel.js:409,457`,
and `server/routes/drinkPlans/lab.test.js:244` (which calls
`withRepriceQuantities([{ ...svcRow, pa_quantity: 3 }])` directly, with NO
duration), and it must not crash; see the null-guard below.

- [ ] **Step 1: Replace the SQL and the mapper**

```js
// SQL to load reprice-ready addon rows: service_addons catalog columns PLUS the
// per-proposal stored quantity AND the event duration needed to convert it.
// The bare `SELECT sa.*` this replaced dropped pa.quantity, so calculateProposal
// priced every per_hour addon as quantity 1, silently under-billing the
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

**Then correct `lab.test.js`'s per_hour fixture in the same step.** There is NO
null-guard rescuing that direct call: `banquet-server` carries
`minimum_hours 4`, so `effectiveHoursFor(addon, undefined)` returns 4, not 0,
and `storedToInputCount` returns a count rather than `null`. The suite would
still go green, because the seeded proposal's duration is also 4, so both sides
of its assertion drift to the same wrong count together. A test named
`'empty reconcile preserves total_price even with a multi-quantity per_hour
addon'` would then be proving that ONE server is preserved, and would keep
passing if the reader broke symmetrically. Fix the fixture rather than accept
the free pass, and note that its seeded `quantity 3` is the exact hand-written
raw count this plan's Global Constraints forbid:

```js
  // Seed the ENGINE OUTPUT shape: 4 effective hours x 3 servers. (Was a raw
  // `3`, the hand-written count that hid the squaring defect from this suite.)
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, $2, $3, $4, $5, 12, $6)`,
    [proposalId, svc.rows[0].id, svc.rows[0].name, svc.rows[0].billing_type, rate, rate * 4 * 3]
  );
```

and give the direct `withRepriceQuantities` call the duration it now needs:

```js
    addons: withRepriceQuantities([{ ...svc.rows[0], pa_quantity: 12, pa_duration_hours: 4 }]),
```

With both corrected the ground truth is 3 servers again, which is what the test
claims to defend.

- [ ] **Step 2: Run the stability test to verify it passes**

Run: `node -r dotenv/config --test server/utils/proposalExtrasFold.stability.test.js`
Expected: PASS, all 6, including the override + gratuity case.

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

`lab.test.js` should PASS on the fixture corrected in Step 1 (12 stored, 3
servers recovered). If it fails, STOP and report: the corrected fixture and the
new reader disagree about the column, which is the whole premise of this plan
and not something to paper over by editing the assertion.

Two things are still unfinished at the end of this task, both harmless but worth
knowing while the lane is open:

- The lab and submit writers still hand-write a raw `1`, which the new reader
  rounds back to a count of 1 (the floor in `storedToInputCount` is what holds
  today's money in place through this window). Task 5 fixes the write.
- The cancel-line PARTIAL removal is temporarily a no-op: it still subtracts
  from the stored figure (3 servers stored as 12, remove 1, row becomes 11), and
  the new reader recovers `round(11/4) = 3`, so the total does not move and the
  row is left mis-shaped at 11. No money is wrong (the invoice bills off
  `line_total` and the roster rounds 11/4 back to 3) and it is strictly better
  than main's current +$2,400, but do not report partial removal as working
  until Task 4 lands.

Do not skip from here to Task 6.

- [ ] **Step 4: Commit**

```bash
git add server/utils/proposalExtrasFold.js server/routes/drinkPlans/lab.test.js
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
- Modify: `server/utils/lineItemCancel.js` (both addon SELECTs ~:98 and ~:427,
  `quantityIsCount` ~:68-75, the addon branch of `computeCancelTargets` ~:140-160,
  the addon mutation branch ~:420-460, the post-fold sync ~:540-555)
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

Then pin step (a0), so the widened SELECT can never be quietly narrowed again.
First give the fixture a `minimumHours` pass-through (`seedCatalogAddon`, ~:79):

```js
async function seedCatalogAddon({ slug, name, billingType = 'flat', rate = 200, minimumHours = null }) {
  if (catalogCache[slug]) return catalogCache[slug];
  const r = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active, minimum_hours)
     VALUES ($1, $2, $3, $4, 'all', true, $5) RETURNING id`,
    [slug, name, billingType, rate, minimumHours]
  );
```

and forward it from `seedProposal`'s addon loop (~:117):

```js
    const cat = await seedCatalogAddon({
      slug: a.slug, name: a.name, billingType: a.billingType, rate: a.rate, minimumHours: a.minimumHours ?? null,
    });
```

then:

```js
test('per_hour under its minimum_hours: picker and write-back use the BILLED hours', async () => {
  // 2 banquet servers on a 2h event with a 4h minimum. The engine bills 4 hours
  // and stores 8. Dividing by the RAW 2 (what happens whenever the row is loaded
  // without sa.minimum_hours) recovers FOUR units, so the picker offers to
  // remove 4 servers from a proposal that has 2, and removing 1 writes back 6,
  // which the fold reads as 2 servers: the removal does nothing and the client
  // is still billed for both. The event must be well under the minimum for this
  // to bite; a 3.5h event rounds back to the right answer on its own.
  const slug = `perhour-min-${NONCE}`;
  const { proposalId } = await seedProposal({
    override: 2500,
    durationHours: 2,
    addons: [{ slug, name: 'Banquet Server Min', billingType: 'per_hour', rate: 75, quantity: 2, minimumHours: 4 }],
  });
  const seeded = (await pool.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(seeded.quantity), 8, 'stored = 4 BILLED hours x 2 servers, not 2 x 2');
  assert.equal(Number(seeded.line_total), 600);

  const { targets } = await computeCancelTargets(pool, proposalId);
  const t = targets.find((x) => x.target === `addon:${slug}`);
  assert.equal(t.quantity, 2, 'the picker offers 2 SERVERS, not 4');

  await applyCancel(proposalId, { target: `addon:${slug}`, quantity: 1 }, async (result, client) => {
    const row = (await client.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.quantity), 4, 'stored = 4 BILLED hours x 1 remaining server');
    assert.equal(Number(row.line_total), 300);
    assert.equal(result.newTotal, 2200, 'one server off a 2500 override = -300, not a no-op');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/lineItemCancel.test.js`
Expected: FAIL on all three new per_hour tests. The picker asserts
`t.quantity === 3` but gets `12`, `quantity_unit` is undefined, and the
minimum_hours test gets a picker of `8` (pre-conversion) rather than 2.

- [ ] **Step 3: Convert at the three sites**

Add the import beside the existing requires in `server/utils/lineItemCancel.js`:

```js
const { storedToInputCount, countLabelFor, effectiveHoursFor, storedIsInputCount } = require('./addonQuantity');
```

**(a0) FIRST, widen both addon SELECTs. Nothing below is correct without this.**
Neither query currently selects `sa.minimum_hours`, so every conversion in this
task would see `minimum_hours: undefined` and divide a `banquet-server` /
`barback` row by the raw duration instead of the hours the engine actually
billed. How bad that is scales with how far under the minimum the event runs,
and Task 1's rounding absorbs the mild cases: on a 3.5h event 2 servers stored
as 8 still recover as `round(8/3.5) = 2`, and a partial removal self-heals
through the fold. On a 2h event the same row recovers as `round(8/2) = 4`, so
the picker offers to remove 4 servers when the proposal has 2, and "remove 1 of
4" writes back 6, which the fold reads as 2 servers: the removal silently does
nothing and the client is still billed for both. Widen the SELECTs and the count
is 2 either way.

`computeCancelTargets` (~:98):

```js
    `SELECT pa.id, pa.addon_id, pa.addon_name, pa.billing_type, pa.quantity, pa.line_total,
            sa.slug, sa.minimum_hours
       FROM proposal_addons pa
       LEFT JOIN service_addons sa ON sa.id = pa.addon_id
      WHERE pa.proposal_id = $1
      ORDER BY pa.id`,
```

`applyLineItemCancel`'s addon branch (~:427):

```js
      `SELECT pa.id, pa.addon_id, pa.addon_name, pa.billing_type, pa.quantity,
              sa.slug, sa.minimum_hours
         FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id
        WHERE pa.proposal_id = $1 AND sa.slug = $2`,
```

Both rows now carry `slug` AND `minimum_hours`, which is exactly what
`effectiveHoursFor` needs to apply the `additional-bartender` raw-duration split.
`minimum_hours` is read from the LIVE catalog while `billing_type` and `rate` are
the frozen row values; that residual is inherited from the client inverter
(formState.js:86-89) and is acceptable for the same reason: `minimum_hours`
effectively never changes.

**(a) `quantityIsCount`**, replace the hand-rolled list with the shared
definition, so "can the admin remove part of this?" and "can we convert the
stored figure?" are the same question:

```js
/**
 * Can the admin remove PART of this add-on? Only when the stored quantity can
 * be converted to a unit count (server/utils/addonQuantity.js): `flat` stores
 * the count directly and `per_hour` stores hours x count. per_guest /
 * per_guest_timed / per_staff / per_100_guests store guests, staff, or blocks,
 * so "remove 1 of them" is meaningless and the whole line comes off.
 *
 * BEHAVIOR CHANGE, deliberate: the old quantityIsCount excluded only the
 * per_guest pair and per_staff, so it offered a partial removal for
 * per_100_guests. That was never meaningful (the engine recomputes blocks from
 * guestCount, so "remove 1 block" removes nothing), and it now takes the
 * whole-line path. An unrecognized billing_type still keeps its picker, because
 * the engine's default branch does treat the stored figure as a count.
 */
function unitCountOf(addon, storedQuantity, durationHours) {
  return storedToInputCount(addon, storedQuantity, durationHours);
}
```

Delete the old `quantityIsCount` function and replace its two call sites as
described in (b) and (c).

**(b) `computeCancelTargets`, the addon branch**, the picker must offer the
count, and name its unit:

```js
    const durationHours = Number(proposal.event_duration_hours);
    const count = unitCountOf(row, row.quantity, durationHours);
    targets.push({
      target: `addon:${row.slug}`,
      label: row.addon_name,
      amount: Number(row.line_total),
      ...(count !== null && count > 1
        ? { quantity: count, quantity_unit: countLabelFor(row) }
        : {}),
      ...(labSlugs.has(row.slug) ? { labOwned: true } : {}),
      cancellable: true,
    });
```

**(c) `applyLineItemCancel`, the addon mutation branch**, do the arithmetic in
counts and write back in stored shape:

```js
    // totalCount is already a whole unit count: storedToInputCount rounds with a
    // floor of 1, so nothing here needs its own Math.round (two roundings on the
    // same figure is how the two definitions drifted apart the first time).
    const durationHours = Number(proposal.event_duration_hours);
    const storedQty = Number(row.quantity) || 0;
    const totalCount = unitCountOf(row, storedQty, durationHours);
    let removeN = totalCount;
    if (quantity !== null) {
      if (totalCount === null) {
        throw new ValidationError({ quantity: 'This add-on is priced per guest or per staff; remove it entirely instead.' });
      }
      removeN = positiveIntOrThrow(quantity, 'quantity', totalCount);
    }
    if (totalCount === null || removeN >= totalCount) {
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
      const remainingCount = totalCount - removeN;
      const restored = storedIsInputCount(row.billing_type)
        ? remainingCount
        : remainingCount * effectiveHoursFor(row, durationHours);
      await client.query('UPDATE proposal_addons SET quantity = $1 WHERE id = $2', [restored, row.id]);
      partialAddonId = row.addon_id;
    }
```

`effectiveHoursFor` here is reading the `sa.minimum_hours` and `sa.slug` that
step (a0) added to the SELECT. Without them this line writes the wrong stored
figure on any event shorter than the add-on's minimum.

**(d) The post-fold sync**, restore writing `quantity`, with the corrected
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
Expected: PASS, including all three per_hour tests. If the minimum_hours test is
the only failure, step (a0) was skipped.

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
- Modify: `server/routes/drinkPlans/lab.js:27` (import) and `:289-307` (the addon upsert)
- Modify: `server/routes/drinkPlans/submit.js` (import) and `:285-300` (the addon insert)
- Test: `server/routes/drinkPlans/submitOverride.test.js` (the reachable writer;
  the lab's shelf carries no `per_hour` slug, so the lab half of this task is a
  no-op today and is closing a door rather than fixing live behavior)

**Interfaces:**
- Consumes: `calculateAddonCost` from `server/utils/pricingEngine.js`. Both files
  already call `foldExtrasIntoProposal` and already hold the resulting `snapshot`.
- Produces: no exported change. After this task all five writers store
  `snapshot.addons[].quantity`.

Both files hand-compute `quantity = 1` (or `guest_count` for per_guest) before
the fold. For `per_hour` that is the wrong shape: `eventCreation.addonHeadcount`
would read a lab-added bartender as `1 / duration` staff, and the invoice line
would read "1 x $40" for a 4-hour booking. No such row exists on prod today
(verified: all 10 `per_hour` rows match the engine-output shape), so this is
closing the door rather than repairing damage.

**The pre-fold row IS the fold's input leg, so a post-fold re-sync alone does
not fix this.** Both files build `addonsAfter` by re-reading the rows they just
wrote (`lab.js:305`, `submit.js:309`, both `await loadRepriceAddons(...)`), so
after Task 3 the hand-written raw figure goes back through the new reader before
anything is priced. Task 3's round-with-a-floor-of-1 is what keeps today's money
intact in that window (a raw `1` recovers as 1 unit), but the row is still
wrong for the roster and the invoice, and the floor is a safety net, not a
design. Fix the WRITE, and keep the post-fold re-sync as the second line of
defence for the figures the pre-fold write cannot know:

- `additional-bartender`'s line_total carries the sub-100-guest gratuity
  surcharge, which only `calculateProposal`'s bespoke branch applies.
- `per_staff` prices off `totalStaff`, which is not known until the whole
  add-on set is priced together.

So: price the pre-fold row with the engine, then re-sync from the snapshot after
the fold. Belt and braces, and the same shape `lineItemCancel` already uses.

- [ ] **Step 1: Write the failing test**

**Test the SUBMIT path, not the lab.** The lab cannot reach a `per_hour` add-on
at all: its shelf is six `per_guest` slugs plus drink-dossier enhancements
(`labHelpers.js:17-18`), and `sanitizeLabAddOns` THROWS on any never-stored slug
outside that set (`labHelpers.js:150-159`), so a test that invents a `per_hour`
slug 400s before it writes anything. The reachable writer is `submit.js`, whose
filter honors any active slug from the payload (`submit.js:205`,
`return true; // user-added addon`). `submitOverride.test.js` already exercises
exactly that door with `additional-bartender`, so the test belongs beside it.

Append to `server/routes/drinkPlans/submitOverride.test.js`:

```js
test('a submitted per_hour add-on is stored in the engine OUTPUT shape', async (t) => {
  // Guards the roster and the invoice line: eventCreation.addonHeadcount divides
  // the stored figure by duration to recover headcount, and invoiceLineItems
  // renders it as `quantity x rate`. A raw 1 on a 4-hour booking reads as 0.25
  // staff (rounds to ZERO bartenders on the roster) and "1 x $40" on the invoice
  // (push review, 2026-07-26). The planner UI offers no staffing add-on, but the
  // public token endpoint honors any active slug, which is the door the
  // gratuity-contract test above uses too.
  const addon = (await pool.query(
    "SELECT id, rate FROM service_addons WHERE slug = 'additional-bartender' AND is_active = true"
  )).rows[0];
  if (!addon) { t.skip('additional-bartender add-on not seeded'); return; }

  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });
  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false,
      selections: { addOns: { 'additional-bartender': { enabled: true } } },
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const row = (await pool.query(
    'SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1 AND addon_id = $2',
    [proposalId, addon.id]
  )).rows[0];
  assert.ok(row, 'the submitted addon row exists');
  assert.strictEqual(Number(row.quantity), 4, 'stored = 4 hours x 1 bartender, not a raw 1');
  assert.strictEqual(Number(row.line_total), Number(addon.rate) * 4);

  // The round trip that matters: the roster must read the headcount back out.
  const { deriveStaffingRoster } = require('../../utils/eventCreation');
  const roster = deriveStaffingRoster(
    { event_duration_hours: 4, num_bartenders: 1 },
    [{ slug: 'additional-bartender', quantity: Number(row.quantity) }]
  );
  assert.strictEqual(roster.filter((r) => r === 'Bartender').length, 2,
    'one add-on bartender on top of the one on the proposal');
});
```

The suite seeds a 175-guest, 4-hour event, so `bartenderGratuityPerHour` is 0
and the expected `line_total` is a clean `rate x 4`. `seedProposal`, `request`
and `CONTRACT` are the suite's existing fixtures.

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/routes/drinkPlans/submitOverride.test.js`
Expected: FAIL, `stored = 4 hours x 1 bartender, not a raw 1` (actual: 1), and
the roster assertion reporting 1 Bartender instead of 2.

- [ ] **Step 3a: Price the pre-fold row with the engine**

In `server/routes/drinkPlans/lab.js`, widen the existing pricingEngine import
(line 27) to `const { calculateSyrupCost, calculateAddonCost } = require('../../utils/pricingEngine');`
and replace the hand-computed upsert body (~:293-307):

```js
      for (const addon of labAddonRows) {
        // Store the ENGINE OUTPUT shape, the figures crud.js / proposalInsert.js
        // / public.js all write. This row is ALSO the fold's input leg
        // (addonsAfter re-reads it through loadRepriceAddons two statements
        // below), so a hand-written raw count is not merely a mis-shaped row:
        // the reader converts it back as though it were engine output and
        // prices a FRACTION of a unit. Measured: one per_hour helper on a 4h
        // booking priced at $40 instead of $160 (push review, 2026-07-26).
        // line_total is provisional for additional-bartender (its gratuity
        // surcharge) and per_staff (needs totalStaff); the post-fold re-sync in
        // Step 3b settles both.
        const priced = calculateAddonCost(
          addon, proposal.guest_count || 1, Number(proposal.event_duration_hours), null, 1
        );
        await client.query(`
          INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (proposal_id, addon_id) DO UPDATE SET
            quantity = EXCLUDED.quantity,
            line_total = EXCLUDED.line_total
        `, [proposal.id, addon.id, addon.name, addon.billing_type, Number(addon.rate),
            priced.quantity, Math.round(priced.total * 100) / 100]);
      }
```

`calculateAddonCost` reproduces `per_guest` (quantity = guestCount, line_total =
guestCount x rate) and `flat` (quantity = 1, line_total = rate) exactly as the
hand-written branches did, so those two round-trip byte-identically.

In `server/routes/drinkPlans/submit.js`, add
`const { calculateAddonCost } = require('../../utils/pricingEngine');` beside the
existing requires and apply the same replacement to its upsert loop (~:285-297),
using that file's `proposal` variable, WITH one guard `lab.js` does not need.
`lab.js` fails closed on an unpriceable proposal BEFORE its upsert (`lab.js:258`);
`submit.js`'s equivalent gate sits AFTER the loop (`submit.js:328`). `Number(null)`
is 0, so pricing an unpriceable proposal here would store `quantity 0 /
line_total 0` where today it stores `1 / rate`, and the fold that would repair it
never runs:

```js
          const priceable = Number(proposal.event_duration_hours) > 0 && Number(proposal.guest_count) > 0;
          let quantity = 1;
          let lineTotal = rate;
          if (priceable) {
            const priced = calculateAddonCost(
              addon, proposal.guest_count, Number(proposal.event_duration_hours), null, 1
            );
            quantity = priced.quantity;
            lineTotal = Math.round(priced.total * 100) / 100;
          } else if (addon.billing_type === 'per_guest') {
            // Unpriceable proposal: keep the pre-2026-07-26 literals exactly.
            quantity = proposal.guest_count || 1;
            lineTotal = rate * quantity;
          }
```

then feed `quantity` / `lineTotal` to the existing upsert unchanged.

One divergence to know about in both files: `calculateAddonCost`'s `per_hour`
branch uses `max(durationHours, minimum_hours)`, while the engine's bespoke
`additional-bartender` branch uses raw `durationHours` and adds the
sub-100-guest surcharge. Identical today (that slug's `minimum_hours` is NULL)
and Step 3b's re-sync settles the surcharge either way, but if
`additional-bartender` ever gets a `minimum_hours`, `calculateProposal`'s branch
is the authority and this pre-fold write must follow it.

Also note `per_guest_timed` changes shape here too (`mocktail-bar`, live on the
submit path): stored `quantity` goes from a raw 1 to `guestCount` and
`line_total` from `rate` to the full timed total. That is the correct engine
output and matches what Step 3b would write anyway, so no money moves, but it is
not only `per_hour` that changes.

- [ ] **Step 3b: Re-sync both writers from the snapshot**

In `server/routes/drinkPlans/lab.js`, immediately AFTER the
`foldExtrasIntoProposal` call (which produces `snapshot`) and before the invoice
work, add:

```js
      // Step 3a already wrote the right SHAPE; this settles the figures only the
      // full engine pass knows: additional-bartender's gratuity surcharge and
      // per_staff's totalStaff basis. It also brings any pre-existing row back
      // into agreement with the snapshot the client is about to be shown.
      //
      // SCOPED TO THE ROWS THIS REQUEST WROTE, deliberately. A blanket re-sync
      // over snapshot.addons would also rewrite rows the client never touched,
      // and for a quantity-capable per_guest add-on that is DESTRUCTIVE:
      // pre-batched-mocktail's unit count survives only in line_total
      // (proposalRules.js QUANTITY_CAPABLE_SLUGS, formState.js:92-98), the fold
      // reprices it at count 1 because the column cannot express a count, and
      // overwriting line_total would erase the last record of it. No writer
      // rewrites a pre-existing row's line_total today; do not start here
      // (plan review, 2026-07-26).
      const touchedAddonIds = new Set(labAddonRows.map((a) => a.id));
      for (const entry of snapshot.addons || []) {
        if (!touchedAddonIds.has(entry.id)) continue;
        await client.query(
          'UPDATE proposal_addons SET quantity = $1, line_total = $2 WHERE proposal_id = $3 AND addon_id = $4',
          [entry.quantity, entry.line_total, proposal.id, entry.id]
        );
      }
```

In `server/routes/drinkPlans/submit.js`, add the identical block immediately
after its `foldExtrasIntoProposal` call, using that file's variable names: the
touched set is `resolvedAddons`, not `labAddonRows`.

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
git add server/routes/drinkPlans/lab.js server/routes/drinkPlans/submit.js server/routes/drinkPlans/submitOverride.test.js
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
- Consumes: Task 4's version of `lineItemCancel.js`. Fix (d) below rewrites the
  same `targets.push({ ... })` block Task 4(b) already replaced (~:155-163), so
  apply it on top of Task 4's code, not the code described in Task 4's "before".
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
Expected: FAIL on both, the object target currently reaches the core, and the
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

**(b) Guard the Stripe client BEFORE the removal commits.** Acquire it between
`runCore` and `commit()`, and ONLY when money actually has to move. Not above
`runCore`: the split plan does not exist yet there, so an unconditional guard
would 503 every cancel-line on an unpaid proposal in any environment without
creds, including the CI smoke branch and the suite's own execute-path tests.
`runCore` hands the caller the open client on success, so the guard must roll
back and release before it throws:

```js
  const { client, result, plan, commit } = await runCore(req, { expectFingerprint: fingerprint });
  // getStripe() fails closed when creds are missing. Discovering that AFTER the
  // commit leaves the line removed with a pending refund row blocking headroom
  // and the operator told the refund is "unconfirmed" when nothing was ever
  // attempted (cross-LLM push review). Both other refundExecute callers guard
  // first (stripe.js:430, proposals/cancel.js:468).
  let stripe = null;
  if (plan.splits.length > 0) {
    stripe = getStripe();
    if (!stripe) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
    }
  }
```

and delete the unguarded `const stripe = getStripe();` that currently sits
immediately BEFORE the refund loop (`cancelLineItem.js:147`), not inside it.

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

Export both constants, add `CANCEL_LINE_REFUND_RAILS` to the `refundHelpers`
require at `cancelLineItem.js:27`, and in `runCore` pass the wider set:

```js
    const payments = await loadPaymentsWithRemaining(req.params.id, client, { rails: CANCEL_LINE_REFUND_RAILS });
```

`server/routes/stripe.js` keeps calling `loadPaymentsWithRemaining(proposalId)`
and is unchanged.

Two things this widening touches, both bounded, neither a reason to drop it:

- It hands a NEW funding source to a derivation the fix list already records as
  wrong. `overpaymentCents` is `amount_paid - total_price`
  (`lineItemCancel.js:616`), and Drink Plan Extras fast-path money rolls into
  `amount_paid` and never into `total_price`, so that difference can be a
  phantom overpayment (prod 599, $60). The phantom is ALREADY auto-refunded off
  the deposit/balance charges today, so this does not create the error class; it
  only adds the drink-plan charge as a source in the case where it is the only
  refundable charge on the proposal. Do NOT try to fix the derivation here (see
  the fix list's "do not re-attempt naively"). Task 7 re-checks prod for a
  proposal in exactly that shape.
- **Safety check before running the suite.** This box's `.env` holds LIVE Stripe
  keys and no test keys. Widening the rails can turn a previously split-less
  execute-path test into one that plans a split and fires a REAL refund. Before
  running anything in Step 4, grep `cancelLineItem.test.js` and
  `refundHelpers*.test.js` for `drink_plan_extras` / `drink_plan_with_balance`
  seeds that carry a `stripe_payment_intent_id` AND reach the execute route. The
  new test above is preview-only, which is why it is safe. If an execute-path
  test would newly plan a split, STOP and surface it rather than running it.

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

TWO commits, not one. (a), (b) and (d) are cheap hardening confined to the
cancel-line feature. (c) is the only change in this whole plan that alters WHICH
Stripe charges get refunded, and it edits a helper shared with
`server/routes/stripe.js`. Bundling them means a refund-rail regression can only
be reverted by taking three unrelated fixes with it. Work them in that order:
write the target-validation test, apply (a)(b)(d), commit; then write the
drink-plan-rail test, apply (c), commit.

```bash
git add server/routes/proposals/cancelLineItem.js server/utils/lineItemCancel.js server/routes/proposals/cancelLineItem.test.js
git commit -m "fix(cancel-line): validate target, guard Stripe before commit, restore the bartender addon button"

git add server/utils/refundHelpers.js server/routes/proposals/cancelLineItem.js server/routes/proposals/cancelLineItem.test.js
git commit -m "fix(cancel-line): let a drink-plan-rail charge fund the refund

The admin-panel rail list excluded drink_plan_extras / drink_plan_with_balance,
so an overpayment sitting on one of those charges fell entirely into
manual_return_cents and the client was told we would return it separately, for
money on a fully refundable Stripe charge. stripe.js keeps the panel rails."
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

**(1) The rows.** Divide by the BILLED hours, not the raw duration: an 8 on a
3.5h event is correct for a 4h-minimum `banquet-server` and would look like
2.29 servers under a naive check.

```sql
SELECT pa.proposal_id, sa.slug, pa.quantity, p.event_duration_hours,
       sa.minimum_hours, pa.line_total, pa.rate, p.status,
       ROUND(pa.quantity / NULLIF(CASE WHEN sa.slug = 'additional-bartender'
                                       THEN p.event_duration_hours
                                       ELSE GREATEST(p.event_duration_hours, COALESCE(sa.minimum_hours, 0))
                                  END, 0), 3) AS recovered_count
  FROM proposal_addons pa
  JOIN proposals p ON p.id = pa.proposal_id
  LEFT JOIN service_addons sa ON sa.id = pa.addon_id
 WHERE pa.billing_type = 'per_hour'
 ORDER BY pa.proposal_id DESC;
```

Expected: every `recovered_count` is a whole number, 1 to 3. A fractional one is
a mis-shaped row (the lab/submit writer bug); one above ~6 is an inflated row (a
reprice already squared it). **Either one STOPS the merge.** Write the repair
statement, show it with the affected rows, and get Dallas's explicit go before
running it: it moves money on live proposals and is not the executor's call. If
all clean, record "no repair required" in the commit message.

**(2) The snapshots.** Rows can be clean while `pricing_snapshot` is not: on an
override proposal the add-on inflation cancels in the fold's delta but is still
frozen into the client-visible snapshot.

```sql
SELECT p.id, p.status, a->>'slug' AS slug,
       (a->>'quantity')::numeric AS snap_quantity, p.event_duration_hours
  FROM proposals p
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(p.pricing_snapshot->'addons') = 'array'
         THEN p.pricing_snapshot->'addons' ELSE '[]'::jsonb END) a
 WHERE a->>'billing_type' = 'per_hour'
   AND (a->>'quantity')::numeric > p.event_duration_hours * 4
 ORDER BY p.id DESC;
```

Expected: zero rows.

**(3) The gratuity basis**, the channel that moves money even under an override:

```sql
SELECT p.id, p.status, p.gratuity_rate, p.num_bartenders,
       (p.pricing_snapshot->'gratuity'->>'staff_count')::numeric AS basis
  FROM proposals p
 WHERE p.gratuity_rate > 0
   AND (p.pricing_snapshot->'gratuity'->>'staff_count')::numeric > 6
 ORDER BY p.id DESC;
```

Expected: zero rows. A double-digit basis on a real event is the inflation
signature, and it means a client was quoted too much gratuity.

**(4) The rails widening from Task 6(c).** Find any proposal whose only
refundable charge is a drink-plan rail while `amount_paid > total_price`:

```sql
SELECT p.id, p.total_price, p.amount_paid,
       array_agg(DISTINCT pp.payment_type) AS refundable_rails
  FROM proposals p
  LEFT JOIN proposal_payments pp
    ON pp.proposal_id = p.id AND pp.status = 'succeeded'
   AND pp.stripe_payment_intent_id IS NOT NULL
 WHERE p.amount_paid > p.total_price
 GROUP BY p.id, p.total_price, p.amount_paid;
```

Expected: proposal 599 ($60, a paid Drink Plan Extras invoice, not an
overpayment). Note in the merge report which rails it carries. **If any row's
only refundable rail is `drink_plan_extras` / `drink_plan_with_balance`, STOP:**
that is the one shape where Task 6(c) newly lets a phantom overpayment
auto-refund real money. Hold that commit back (it is split out for exactly this
reason), merge the rest, and put the decision to Dallas.

**(5) The per_guest count**, which this plan deliberately does NOT fix. The
deferral is only safe while no live proposal carries a per_guest add-on at a
count above 1, so verify rather than assume. The count is recoverable the way
the client inverter does it, from the row's own frozen rate:

```sql
SELECT pa.proposal_id, pa.addon_name, pa.quantity, pa.rate, pa.line_total, p.status,
       ROUND(pa.line_total / NULLIF(pa.quantity * pa.rate, 0), 3) AS recovered_count
  FROM proposal_addons pa JOIN proposals p ON p.id = pa.proposal_id
 WHERE pa.billing_type IN ('per_guest', 'per_guest_timed')
   AND pa.line_total > pa.quantity * pa.rate * 1.01
 ORDER BY pa.proposal_id DESC;
```

Expected: zero rows. Any row here is a live per_guest count above 1, which the
fold under-bills on every reprice, and the deferral has to be revisited before
merge. (`per_guest_timed` will read high for events over 4 hours because of its
extra-hours term; check those by hand rather than treating them as counts.)

- [ ] **Step 2: Docs**

In `ARCHITECTURE.md`, the `proposal_addons` entry already has a `quantity`
clause (~:858: "holds fractional hours for per-hour add-ons"). That is a
half-truth that helped this bug survive, so REPLACE it rather than adding a
second description beside it. Keep its coercion note, which is still correct:

```
- `quantity` (NUMERIC(10,2)), the pricing engine's OUTPUT display quantity for
  the add-on (`calculateAddonCost(...).quantity`), NOT the admin's unit count.
  Per billing_type: `per_guest`/`per_guest_timed` store guestCount, `per_hour`
  stores effectiveHours x count, `per_staff` stores the staff count,
  `per_100_guests` stores 100-guest blocks, `flat` stores the count. The
  `additional-bartender` slug is the exception inside `per_hour`: its bespoke
  engine branch stores RAW durationHours x count and never consults
  `minimum_hours`. Read back by `eventCreation.addonHeadcount` (divides by
  duration for headcount), `invoiceLineItems` (renders `quantity x rate`), and
  the admin editor's `recoverAddonQuantities`. Any code converting between this
  and a unit count MUST go through `server/utils/addonQuantity.js` on the server
  or `client/src/pages/admin/proposalEditor/formState.js` on the client, and the
  two must agree; re-feeding the stored figure to the engine as an input
  multiplied per_hour add-ons by their own hours (a $450 line repriced to
  $2,700, 2026-07-26) and inflated the gratuity staff basis with it. pg returns
  NUMERIC as a string, so readers coerce with `::float8` / `Number()`.
```

In `docs/fix-list-remaining-2026-07-02.md`, under the 2026-07-26 push-review
section, DELETE the bullet beginning "The `additional-bartender` ADD-ON
target's amount comes from `proposal_addons.line_total`" (fixed in Task 6),
DELETE the two bullets about the non-string target and `getStripe()` (fixed in
Task 6), DELETE the drink-plan rails bullet (fixed in Task 6), and add:

```
- CORRECTION: a code comment in `lineItemCancel.js` (the post-fold sync) claimed
  `proposal_addons.quantity` holds "the RAW unit count", and `ARCHITECTURE.md`
  described it as fractional hours. Both are wrong; it holds the engine's OUTPUT
  display quantity. See `server/utils/addonQuantity.js` and the rewritten
  ARCHITECTURE schema note. The 2026-07-24 checkpoint change that stopped
  writing `quantity` in the post-fold sync was made on that wrong belief and has
  been reverted.
- Not fixed, same family: `server/utils/changeRequests.js` is a THIRD reader that
  disagrees with the column. `priceProposedState` (:57-69) re-prices the
  proposal's existing add-ons with `safeAddonQty(quantities[id])`, which returns
  1 for `undefined`, so a client-portal change-request price preview silently
  drops any count above 1 and under-quotes; `buildDiff` (:129-137) compares the
  stored OUTPUT against a proposed INPUT count. The diff half is unreachable
  today (the v1 client form exposes no add-on editing, so `addon_ids` is never
  sent) but the preview half is not. Left out of the 2026-07-26 lane to keep it
  narrow. The fix is the same one: route it through `addonQuantity.js`.
- Still open, same family: for `per_guest` add-ons the fold cannot recover the
  admin's unit count, so a per_guest add-on sold at count 2 reprices as count 1
  and UNDER-bills. It is recoverable in principle, just not from `quantity`
  alone: the client inverter already does it as
  `line_total / (quantity x rate)` using the row's OWN persisted rate
  (`formState.js:92-98`), and the fold could too by adding `pa.line_total` to
  `REPRICE_ADDON_SQL`. Deliberately left alone on 2026-07-26 to keep that lane
  narrow, and verified unreachable at the time (query (5) in the plan's Task 7).
  Pick this up with the same care: the divisor must be the row's frozen rate,
  never the live catalog rate, because catalog rates drift.
- A client drink-plan submit can reset an admin-negotiated add-on quantity. The
  upsert loop in `submit.js` honors any active slug in the client payload
  (`return true; // user-added addon`) and its `ON CONFLICT DO UPDATE` overwrites
  `quantity` with the count it just computed for one unit. A payload naming a
  slug an admin had already set to 3 knocks it back to 1. Pre-existing, not
  reachable through the planner UI (it offers no staffing add-on), and untouched
  by the 2026-07-26 work, which only changed what that statement writes, not
  which rows it is allowed to write.
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

- [ ] **Step 3: Lane gate, every suite this work reaches, one at a time**

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

1. Create the fixture: admin editor, 2 Banquet Servers on a 5-hour event. The
   pricing card shows `Banquet Server (10hrs)` at `$750` and the payment panel
   total matches.
2. CONTROL, not the repro: re-save the proposal with no changes. The total must
   not move. It did not move before this work either, because the editor
   recovers the stepper count through `recoverAddonQuantities` on load. This
   step exists to prove the fix did not break the one path that was already
   right, so a "no change" here is the expected result both before and after.
3. THE REPRO, a fold: open that proposal's drink plan, then save the Enhancement
   Lab with nothing selected. An empty reconcile still runs
   `foldExtrasIntoProposal`. Before this work the $750 line repriced to `$3,750`
   and the proposal total jumped by $3,000. After, the total must not move at
   all. (If the proposal has no drink plan, the cancel-line PREVIEW on any other
   line runs the same fold and reports `new_total`; read that instead.)
4. Open the cancel-line dialog on the Banquet Server line. The picker must say
   "Remove how many of the 2?", not 10.
5. Remove 1. The line becomes `$375` and the total drops by exactly `$375`.
6. Open the event page: the staffing card shows exactly 1 Banquet Server (2
   minus the one removed) and the shift's `positions_needed` did not jump.
7. The gratuity channel: on a proposal carrying an `additional-bartender` add-on
   AND a client gratuity rate, note the Gratuity line, run the same empty Lab
   save, and confirm the line is unchanged. Before this work the staff basis
   read the add-on's stored hours as headcount and the line inflated with the
   contract total untouched.

## Review scaling

Money path, and it changes the reprice core every proposal flows through. Full
review fleet at merge plus `/second-opinion` on the same commits. Sensitive
files touched: `proposalExtrasFold.js`, `refundHelpers.js`, `lineItemCancel.js`,
`cancelLineItem.js`, `drinkPlans/submit.js`, `drinkPlans/lab.js`.

**Mid-execution checkpoints**, matched to what each batch changes rather than
one blanket pass at the end:

- After **Task 3**, the highest-risk commit in the lane (the reprice core every
  proposal flows through): a money/pricing review plus a cross-cutting
  consistency pass confirming the new reader agrees with
  `eventCreation.addonHeadcount`, `invoiceLineItems` and `recoverAddonQuantities`.
- After **Task 5**: a money review of the pre-fold-write / post-fold-resync pair
  across both PUBLIC token-gated writers, with the scoping of the re-sync
  (touched rows only) as a named check.
- After **Task 6**: a refunds/Stripe review, since (c) is the only change in the
  lane that moves real money.
- Tasks 1, 2, 4 and 7 ride the merge fleet.

**Revert unit is the LANE, never a single task commit.** Tasks 4 and 5 store the
engine-output shape and are correct only with Task 3's reader present; reverting
Task 3 alone after a push would turn those now-correct writes straight back into
the squaring bug. The squash merge makes this mostly theoretical, but if
anything here has to come out, it all comes out.

## Self-review notes

- **Coverage:** every finding this plan claims to fix has a task, reader
  (Task 3), writers (Task 5), cancel-line consumers (Task 4), the four ride-along
  findings (Task 6), docs and the wrong fix-list entry (Task 7). The stability
  test (Task 2) is the gate for the whole family.
- **Deliberately NOT in scope:** `eventCreation.addonHeadcount`,
  `invoiceLineItems` and the client's `recoverAddonQuantities` (all three already
  read the column correctly), the `per_guest` count-recovery limitation (logged
  in Task 7, verified unreachable by query (5)), `server/utils/changeRequests.js`
  (a third disagreeing reader, logged in Task 7), the `overpaymentCents`
  derivation (the fix list's explicit do-not-re-attempt), and the ~20 previously
  deferred items in the fix list.
- **Type consistency:** `storedToInputCount(addon, storedQuantity, durationHours)`
  and `effectiveHoursFor(addon, durationHours)` are used with those exact
  signatures in Tasks 3, 4 and 6; `storedIsInputCount(billingType)` is called as
  a predicate on a billing-type STRING in all uses, never on an addon object;
  `countLabelFor` returns `'hour'|'unit'|null` and the dialog only branches on
  `'hour'`. `storedToInputCount` returns a WHOLE number or null, so no caller
  rounds again.
- **Row prerequisites:** every row handed to `effectiveHoursFor` or
  `storedToInputCount` must carry `slug` (for the additional-bartender split) and
  `minimum_hours` (for the per_hour floor). `REPRICE_ADDON_SQL` gets both from
  `sa.*`; the two `lineItemCancel` SELECTs get them from Task 4 step (a0). A
  future caller that forgets is the exact bug step (a0) exists to prevent.

## Plan review, 2026-07-26 (what this revision changed)

Reviewed against the code before execution. Two tasks were money-wrong as
originally written and are corrected above:

- **Task 5 shipped a 4x under-bill.** Both writers re-read the row they just
  wrote to build the fold's after-leg, so a post-fold re-sync could not fix the
  input the fold had already priced. Simulated against the real engine: a
  per_hour lab helper on a 4h booking went from `$160` to `$40`, and the re-sync
  wrote the wrong figures straight back. Now the pre-fold row is priced with
  `calculateAddonCost`, and Task 1 rounds with a floor of 1 so the Task 3 window
  cannot move money either.
- **Task 4 corrupted rows on sub-minimum events.** Neither cancel-line SELECT
  carries `sa.minimum_hours`, so a 4h-minimum `banquet-server` on a 3.5h event
  recovered 2.29 units and wrote 3.5 back for one remaining server ($262.50
  instead of $300). Step (a0) widens both SELECTs and a test pins it.

Also corrected: the claim that an admin re-save reproduces the bug (the editor
already inverts correctly), the claim that `lab.test.js:244` is saved by a null
guard (banquet-server's minimum_hours makes it 0.75, not null, and the fixture
itself seeds the forbidden raw-count shape), the claim that the per_guest count
is unrecoverable (the client recovers it from line_total), and the exposure
statement (the gratuity staff basis and the persisted snapshot move money on
override proposals where the add-on line does not). Task 6(b)'s guard was
narrowed to the splits-exist case so a no-refund removal still works without
Stripe creds.

### Second pass: the plan-review fleet (fidelity / decomposition / feasibility)

Run against the revision above. Two more blockers, both in Task 5:

- **Its test could never run.** It added a nonce `per_hour` slug and PUT it at
  the lab, but `sanitizeLabAddOns` THROWS on any never-stored slug outside the
  offered shelf, and that shelf is six `per_guest` slugs. The lab cannot reach a
  `per_hour` add-on at all, so the lab half of Task 5 is a no-op today and the
  reachable writer, `submit.js`, had no test. The test moved to
  `submitOverride.test.js`, beside the existing case that already adds
  `additional-bartender` through the same public door.
- **Its post-fold re-sync was destructive.** Written as a blanket loop over
  `snapshot.addons`, it would rewrite rows the request never touched. For a
  quantity-capable `per_guest` add-on (`pre-batched-mocktail`) the unit count
  survives ONLY in `line_total`, and the fold reprices it at count 1, so the
  re-sync would have erased the last record of the count and made the Task 7
  deferral false going forward. Now scoped to the ids the writer touched.

Corrections the fleet made to THIS document's own first revision: Task 4's
minimum_hours rationale was wrong once Task 1 started rounding (a 3.5h event
recovers correctly on its own and self-heals through the fold; the fixture is
now a 2h event, where the picker really does offer 4 servers for 2 and a partial
removal silently does nothing). Task 1's `STORED_IS_INPUT_COUNT` allowlist
contradicted its own interface text and would have dropped the count for an
unrecognized or NULL `billing_type`; it is now an exclusion-list predicate.
Task 2's "two folds" test could not detect drift because `noOpFold` rolls back;
both folds now run in one transaction. Task 5's submit-side write needed a
priceability guard that `lab.js` gets for free. Task 6 was split so the refund
rails commit alone, and `changeRequests.js` was added to Task 7's fix list as a
third reader that disagrees with the column.
