---
lanes:
  - id: gratuity-mandate
    footprint:
      - server/db/schema.sql
      - server/utils/pricingEngine.js
      - server/utils/pricingEngine.test.js
      - server/utils/lineItemCancel.js
      - server/utils/lineItemCancel.test.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/crud.test.js
      - server/routes/proposals/metadata.js
      - server/routes/proposals/metadata.calculate.test.js
      - server/routes/stripeCreateIntent.js
      - server/routes/stripeCreateIntent.test.js
      - server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js
      - server/routes/stripeWebhook.gratuityApply.test.js
      - client/src/pages/admin/proposalEditor/**
      - client/src/pages/proposal/proposalView/**
      - CLAUDE.md
      - ARCHITECTURE.md
    depends_on: []
    review: full-fleet
---

# Admin Gratuity Mandate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin can set a required prepaid gratuity on an unpaid proposal; checkout floors at it on both jar answers; enforced in `deriveGratuityRate`, the webhook apply, and an amended DB CHECK.

**Architecture:** New `proposals.gratuity_floor_rate` column (NULL = no mandate). Setting a mandate derives a rate from admin-entered dollars and writes it to both `gratuity_floor_rate` and `gratuity_rate`, so the quote carries the Gratuity line immediately. The mandate becomes the election floor at checkout, replacing (not stacking on) the $50 no-jar floor. `gratuity_rate_change_origin` is never touched by mandate writes.

**Tech Stack:** Node/Express, raw SQL via pg, node:test, React (CRA), Stripe.

**Spec:** `docs/superpowers/specs/2026-08-10-admin-gratuity-mandate-design.md`

## Global Constraints

- Proposals money is DOLLARS (`NUMERIC(10,2)`), rates are `NUMERIC(10,4)`. Never mix with cents tables.
- No em dashes in any client-facing copy.
- Explicit `git add <path>` only; lane checkpoint commits are free (squash-merged later).
- Single lane; work happens in a worktree cut via `npm run worktree:new gratuity-mandate` from `os`. Never move `os` off main.
- Server suites run ONE AT A TIME from repo root: `node --test -r dotenv/config <file>` (shared dev DB).
- The PATCH still refuses `tip_jar`/`gratuity_total`. The ONE new accepted field is `gratuity_mandate_total` (dollars, null clears, absent carries forward).
- Mandate floor REPLACES the $50 no-jar floor; choosing no-jar under a mandate never charges more.
- This is money/checkout code: full review fleet at lane merge; push gets fleet + `/second-opinion`.

---

### Task 1: Schema — column + amended CHECK

**Files:**
- Modify: `server/db/schema.sql` (insert after the `proposals_gratuity_jar_check` block, ~line 1313)

**Interfaces:**
- Produces: column `proposals.gratuity_floor_rate NUMERIC(10,4)` NULL; constraint `proposals_gratuity_jar_check` amended to `(tip_jar = true OR gratuity_rate >= 50 OR (gratuity_floor_rate IS NOT NULL AND gratuity_rate >= gratuity_floor_rate))`.

- [ ] **Step 1: Add the DDL block to schema.sql**

Insert after the existing `proposals_gratuity_jar_check` DO block (~line 1313), before the origin-check block:

```sql
-- Admin gratuity mandate (spec 2026-08-10): a required prepaid gratuity,
-- stored as a $/staff/hr floor RATE. NULL = no mandate. The rate is canonical;
-- the dollar rescales with staffing/hours like the elected gratuity.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS gratuity_floor_rate NUMERIC(10,4);

-- Amend the jar CHECK: a mandated proposal whose rate meets its own floor is
-- valid even when no-jar and under $50/staff/hr (the mandate REPLACES the
-- no-jar floor; ruling 2026-08-10: no-jar must not charge more under a mandate).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'proposals' AND c.conname = 'proposals_gratuity_jar_check'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%gratuity_floor_rate%'
  ) THEN
    ALTER TABLE proposals DROP CONSTRAINT proposals_gratuity_jar_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'proposals' AND constraint_name = 'proposals_gratuity_jar_check'
  ) THEN
    ALTER TABLE proposals ADD CONSTRAINT proposals_gratuity_jar_check
      CHECK (tip_jar = true OR gratuity_rate >= 50
             OR (gratuity_floor_rate IS NOT NULL AND gratuity_rate >= gratuity_floor_rate));
  END IF;
END $$;
```

- [ ] **Step 2: Apply the new block to the dev DB**

Copy just the block above into a scratch file and run it from repo root:

```bash
node -r dotenv/config -e "const{Pool}=require('pg');const fs=require('fs');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(fs.readFileSync(process.argv[1],'utf8')).then(()=>{console.log('applied');return p.end()}).catch(e=>{console.error(e.message);process.exit(1)})" /tmp/claude-1000/-home-drbartender/38eb82ea-bc9c-4cef-bb14-d4537ef967e6/scratchpad/mandate-ddl.sql
```

- [ ] **Step 3: Verify column + constraint**

```bash
node -r dotenv/config -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='proposals' AND c.conname='proposals_gratuity_jar_check'\").then(r=>{console.log(r.rows[0].def);return p.end()})"
```

Expected: definition contains `gratuity_floor_rate`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "schema: gratuity_floor_rate column + amended jar CHECK (admin mandate)"
```

NOTE for rollout (NOT this task): the same block runs on PROD before the code push, per standing order. Dev DB historically lacks prod CHECKs; this task closes that gap for this constraint.

---

### Task 2: Pricing engine — floor param + snapshot `floor_rate`

**Files:**
- Modify: `server/utils/pricingEngine.js` (`deriveGratuityRate` ~line 294, `calculateProposal` signature ~line 358 and gratuity block ~line 592)
- Test: `server/utils/pricingEngine.test.js`

**Interfaces:**
- Consumes: existing `GRATUITY_FLOOR_RATE` (50), `GRATUITY_SANITY_MAX_RATE` (1000).
- Produces: `deriveGratuityRate({ enteredTotal, staffCount, hours, tipJar, floorRate = 0 })` — when `floorRate > 0` it is the ONLY floor (both jar answers; the 50 no-jar rule is bypassed), with a snap-to-floor within the half-cent tolerance. `calculateProposal({ ..., gratuityFloorRate = null })` stamps `snapshot.gratuity.floor_rate` (number or null). `recomputeSnapshotGratuity` preserves `floor_rate` (already does via the `...snap.gratuity` spread; test pins it).

- [ ] **Step 1: Write failing tests**

Append to `server/utils/pricingEngine.test.js`:

```js
test('deriveGratuityRate: mandate floor binds on BOTH jar answers, replacing the 50 rule', () => {
  // jar kept, mandate 50/hr, 1 staff x 2h: below 100 rejected, at 100 ok
  const below = deriveGratuityRate({ enteredTotal: 99, staffCount: 1, hours: 2, tipJar: true, floorRate: 50 });
  assert.strictEqual(below.ok, false);
  assert.strictEqual(below.code, 'GRATUITY_BELOW_FLOOR');
  assert.match(below.message, /required gratuity of at least \$100\.00/);
  assert.deepStrictEqual(
    deriveGratuityRate({ enteredTotal: 100, staffCount: 1, hours: 2, tipJar: true, floorRate: 50 }),
    { ok: true, rate: 50 });
  // no-jar with a sub-50 mandate is ALLOWED at the mandate (no stacking)
  assert.deepStrictEqual(
    deriveGratuityRate({ enteredTotal: 60, staffCount: 1, hours: 2, tipJar: false, floorRate: 30 }),
    { ok: true, rate: 30 });
  // above the mandate is fine
  assert.deepStrictEqual(
    deriveGratuityRate({ enteredTotal: 150, staffCount: 1, hours: 2, tipJar: true, floorRate: 50 }),
    { ok: true, rate: 75 });
});

test('deriveGratuityRate: mandate snap-to-floor absorbs display rounding after a rescale', () => {
  // rate 33.3333 rescaled to basis 7: display floor = round(233.3331,2) = 233.33,
  // which derives to 33.3329; within tolerance it must SNAP to the floor rate,
  // never reject and never persist a sub-floor rate (DB CHECK is strict).
  const g = deriveGratuityRate({ enteredTotal: 233.33, staffCount: 1, hours: 7, tipJar: true, floorRate: 33.3333 });
  assert.deepStrictEqual(g, { ok: true, rate: 33.3333 });
  // genuinely below stays rejected
  assert.strictEqual(
    deriveGratuityRate({ enteredTotal: 230, staffCount: 1, hours: 7, tipJar: true, floorRate: 33.3333 }).ok,
    false);
});

test('deriveGratuityRate: no-floor behavior is byte-identical to before', () => {
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 200, staffCount: 1, hours: 4, tipJar: true }),
    { ok: true, rate: 50 });
  assert.strictEqual(deriveGratuityRate({ enteredTotal: 100, staffCount: 1, hours: 4, tipJar: false }).ok, false);
});

test('calculateProposal stamps gratuity.floor_rate; recompute preserves it', () => {
  const pkg = { id: 1, name: 'T', slug: 't', category: 'byob', base_cost: 350, pricing_type: 'flat' };
  const snap = calculateProposal({
    pkg, guestCount: 100, durationHours: 2, numBars: 0, numBartenders: 1,
    addons: [], syrupSelections: [], adjustments: [],
    gratuityRate: 50, tipJar: true, gratuityFloorRate: 50,
  });
  assert.strictEqual(snap.gratuity.floor_rate, 50);
  assert.strictEqual(snap.gratuity.total, 100);
  const re = recomputeSnapshotGratuity(snap, { gratuityRate: 75, tipJar: false, staffNoun: 'bartender', durationHours: 2 });
  assert.strictEqual(re.gratuity.floor_rate, 50); // spread-preserved, pinned here
  // absent mandate stamps null
  const plain = calculateProposal({
    pkg, guestCount: 100, durationHours: 2, numBars: 0, numBartenders: 1,
    addons: [], syrupSelections: [], adjustments: [],
  });
  assert.strictEqual(plain.gratuity.floor_rate, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/utils/pricingEngine.test.js`
Expected: the four new tests FAIL (floorRate ignored / floor_rate undefined).

- [ ] **Step 3: Implement**

`deriveGratuityRate` (~line 294) becomes:

```js
function deriveGratuityRate({ enteredTotal, staffCount, hours, tipJar, floorRate = 0 }) {
  const basis = (Number(staffCount) || 0) * (Number(hours) || 0);
  if (basis <= 0) return { ok: true, rate: 0 };
  const total = Number(enteredTotal);
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false, code: 'INVALID_GRATUITY', message: 'Enter a gratuity amount of $0 or more.' };
  }
  // Admin mandate (spec 2026-08-10): when set it is the ONLY floor, on both jar
  // answers. The $50 no-jar rule applies only when there is no mandate.
  const mandate = Number(floorRate) > 0 ? Number(floorRate) : 0;
  const effFloor = mandate > 0 ? mandate : (tipJar === false ? GRATUITY_FLOOR_RATE : 0);
  const floorTotal = effFloor * basis;
  const floorMsg = mandate > 0
    ? `This event includes a required gratuity of at least $${floorTotal.toFixed(2)}.`
    : `Without a tip jar, gratuity must be at least $${floorTotal.toFixed(2)}.`;
  if (effFloor > 0 && total < floorTotal - 0.005) {
    return { ok: false, code: 'GRATUITY_BELOW_FLOOR', message: floorMsg };
  }
  let rate = Math.round((total / basis) * 10000) / 10000; // NUMERIC(10,4)
  // Mandate branch: a displayed floor that round-trips a hair low (rescaled
  // rate x basis rounded to cents, divided back) must SNAP to the floor rate,
  // because the DB CHECK (gratuity_rate >= gratuity_floor_rate) is strict.
  if (mandate > 0 && rate < mandate && total >= floorTotal - 0.005) rate = mandate;
  // Re-assert the floor on the DERIVED rate (spec 2026-08-03 section 4.5),
  // unchanged for the legacy no-jar branch; for the mandate branch it now only
  // catches genuinely-below totals (the snap above absorbed rounding).
  if (effFloor > 0 && rate < effFloor) {
    return { ok: false, code: 'GRATUITY_BELOW_FLOOR', message: floorMsg };
  }
  if (rate > GRATUITY_SANITY_MAX_RATE) {
    return { ok: false, code: 'GRATUITY_TOO_LARGE', message: 'That gratuity is unusually large — please re-enter it.' };
  }
  return { ok: true, rate };
}
```

(The GRATUITY_TOO_LARGE message keeps its existing text verbatim; it is pre-existing copy.)

`calculateProposal` (~line 358): add `gratuityFloorRate = null` to the destructured params. In the snapshot's `gratuity` block (~line 592) add one line:

```js
    gratuity: {
      rate: Number(gratuityRate) || 0,
      tip_jar: tipJar !== false,
      staff_count: gratuityStaffCount,
      hours: Number(durationHours) || 0,
      staff_noun: staffNoun,
      total: clientGratuityAmount,
      floor_rate: gratuityFloorRate != null ? Number(gratuityFloorRate) : null,
    },
```

No change to `recomputeSnapshotGratuity` (the `...snap.gratuity` spread at line 347 preserves `floor_rate`; the test pins it).

- [ ] **Step 4: Run tests**

Run: `node --test server/utils/pricingEngine.test.js`
Expected: ALL pass, including every pre-existing gratuity test (the no-floor path must be behavior-identical).

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/utils/pricingEngine.js server/utils/pricingEngine.test.js
git commit -m "engine: mandate floor in deriveGratuityRate + snapshot gratuity.floor_rate"
```

---

### Task 3: Admin PATCH accepts `gratuity_mandate_total`

**Files:**
- Modify: `server/routes/proposals/crud.js` (gratuity resolution block ~lines 540-556, UPDATE ~lines 569-606)
- Test: `server/routes/proposals/crud.test.js`

**Interfaces:**
- Consumes: `deriveGratuityRate` (Task 2, call WITHOUT floorRate here: admin entry has no floor to satisfy, only sanity checks), `computeGratuityBasis({ pkg, guestCount, durationHours, numBartenders, addons })` (existing export), `calculateProposal({ ..., gratuityFloorRate })` (Task 2).
- Produces: PATCH body key `gratuity_mandate_total` — number sets, `null` clears, ABSENT carries forward. Row columns `gratuity_rate` + `gratuity_floor_rate` written together. Rejected with 400 when `amount_paid > 0` or when staff x hours is 0.

- [ ] **Step 1: Write failing tests**

Add to `server/routes/proposals/crud.test.js`, following that file's existing insert-then-PATCH pattern (reuse its app/db bootstrap helpers exactly as neighboring tests do). Cases:

```js
// 1. Set: PATCH { gratuity_mandate_total: 100 } on an unpaid 1-bartender 2-hour
//    proposal -> 200; row has gratuity_rate 50, gratuity_floor_rate 50;
//    snapshot.gratuity {rate:50, total:100, floor_rate:50}; snapshot.breakdown
//    has a 'Gratuity' 100 line; total_price went up by exactly 100;
//    gratuity_rate_change_origin is UNCHANGED (still null).
// 2. Clear: a second PATCH { gratuity_mandate_total: null } -> rate 0,
//    floor null, Gratuity line gone, total back down.
// 3. Carry-forward: PATCH WITHOUT the key (e.g. only guest_count) on a mandated
//    proposal -> floor_rate and rate survive; bumping event_duration_hours 2->4
//    rescales the Gratuity line 100->200 at the same rate.
// 4. Paid guard: seed amount_paid 100, PATCH { gratuity_mandate_total: 120 }
//    -> 400; row untouched.
// 5. Still refuses the election keys: PATCH { tip_jar: false, gratuity_total: 500 }
//    -> 200 but tip_jar/gratuity_rate unchanged (existing behavior, pinned).
// 6. Zero basis: proposal shaped so staffCount*hours = 0 -> PATCH with a number
//    -> 400 ValidationError.
```

Write them as real tests with real assertions against the row + snapshot (SELECT after each PATCH), matching the file's style.

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/routes/proposals/crud.test.js`
Expected: new tests FAIL (unknown field ignored, no `gratuity_floor_rate` column write).

- [ ] **Step 3: Implement**

In `crud.js`, replace the gratuity resolution block (lines 546-548 area) with:

```js
    const persistTipJar = old.tip_jar !== false;
    let resolvedGratuityRate = Number(old.gratuity_rate) || 0;
    let resolvedFloorRate = old.gratuity_floor_rate != null ? Number(old.gratuity_floor_rate) : null;
    let gratuityOrigin = old.gratuity_rate_change_origin || null;
    const isPaidForGratuity = Number(old.amount_paid || 0) > 0;

    // Admin gratuity mandate (spec 2026-08-10): the ONE gratuity field this
    // PATCH accepts. Dollars in; the rate is canonical. null clears; an absent
    // key carries the stored mandate forward. Origin is never touched here.
    const mandateProvided = Object.prototype.hasOwnProperty.call(req.body, 'gratuity_mandate_total');
    if (mandateProvided) {
      if (isPaidForGratuity) {
        throw new ValidationError({ gratuity_mandate_total: 'Gratuity cannot be changed after payment. Use cancel-line-item to lower it.' });
      }
      const mt = req.body.gratuity_mandate_total;
      if (mt == null) {
        resolvedFloorRate = null;
        resolvedGratuityRate = 0;
      } else {
        const { staffCount, hours } = computeGratuityBasis({
          pkg, guestCount: gc, durationHours: dh, numBartenders: num_bartenders, addons,
        });
        if (staffCount * hours <= 0) {
          throw new ValidationError({ gratuity_mandate_total: 'Set staffing and duration before requiring a gratuity.' });
        }
        // tipJar true = no floor to satisfy on entry; sanity checks still apply.
        const g = deriveGratuityRate({ enteredTotal: mt, staffCount, hours, tipJar: true });
        if (!g.ok) throw new ValidationError({ gratuity_mandate_total: g.message });
        resolvedFloorRate = g.rate;
        resolvedGratuityRate = g.rate;
      }
    }
```

Import `computeGratuityBasis` and `deriveGratuityRate` from `../../utils/pricingEngine` alongside the file's existing pricingEngine imports.

Pass the floor into the snapshot compute (line 551-556):

```js
    const snapshot = calculateProposal({
      pkg, guestCount: gc, durationHours: dh, numBars: nb,
      numBartenders: num_bartenders, addons, syrupSelections: syrups,
      adjustments: adj, totalPriceOverride: tpo,
      gratuityRate: resolvedGratuityRate, tipJar: persistTipJar,
      gratuityFloorRate: resolvedFloorRate,
    });
```

The staffing-notice block (lines 558-567) is UNCHANGED (it is gated on `isPaidForGratuity`, and mandate edits are unpaid-only, so no notice fires on a mandate edit).

UPDATE statement: add `gratuity_floor_rate = $29` to the SET list and `resolvedFloorRate` as the 29th parameter.

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/routes/proposals/crud.test.js`
Expected: ALL pass (one suite at a time; nothing else running against the dev DB).

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/crud.test.js
git commit -m "crud: PATCH accepts gratuity_mandate_total (set/clear/carry, paid guard)"
```

---

### Task 4: `/proposals/calculate` previews the mandate

**Files:**
- Modify: `server/routes/proposals/metadata.js` (~lines 36-83)
- Test: `server/routes/proposals/metadata.calculate.test.js`

**Interfaces:**
- Consumes: `computeGratuityBasis`, `deriveGratuityRate`, `calculateProposal({ ..., gratuityFloorRate })`.
- Produces: `POST /api/proposals/calculate` accepts optional `gratuity_mandate_total`; when a number, the returned snapshot carries the derived rate + `gratuity.floor_rate`; when `null`, rate 0 / floor null; when ABSENT, today's stored-rate path verbatim. Invalid mandate -> 400.

- [ ] **Step 1: Write failing tests**

Add to `metadata.calculate.test.js` in its existing request style:

```js
// 1. { ...base, gratuity_mandate_total: 100 } with 1 bartender / 2h ->
//    snapshot.gratuity {rate:50, floor_rate:50, total:100}, breakdown has
//    Gratuity 100, total includes it.
// 2. { ...base, gratuity_mandate_total: null } -> gratuity.rate 0, floor_rate null.
// 3. Absent key + { tip_jar:false, gratuity_rate:60 } -> unchanged legacy
//    stored-rate preview (rate 60 honored), floor_rate null.
// 4. { gratuity_mandate_total: -5 } -> 400.
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/routes/proposals/metadata.calculate.test.js`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

In the `/calculate` handler: destructure `gratuity_mandate_total` from `req.body`. After the addons block, replace the two preview lines with:

```js
  // Gratuity preview: a DRAFT mandate (spec 2026-08-10) wins over the stored
  // rate/jar; null previews the mandate cleared; absent = stored-rate path
  // (election-at-payment) exactly as before.
  let previewTipJar = tip_jar !== false;
  let previewRate = Number(gratuity_rate) || 0;
  let previewFloorRate = null;
  if (gratuity_mandate_total !== undefined) {
    if (gratuity_mandate_total == null) {
      previewRate = 0;
    } else {
      const { staffCount, hours } = computeGratuityBasis({
        pkg: pkgResult.rows[0],
        guestCount: guest_count || 50,
        durationHours: duration_hours || 4,
        numBartenders: num_bartenders,
        addons,
      });
      if (staffCount * hours > 0) {
        const g = deriveGratuityRate({ enteredTotal: gratuity_mandate_total, staffCount, hours, tipJar: true });
        if (!g.ok) throw new ValidationError({ gratuity_mandate_total: g.message });
        previewRate = g.rate;
        previewFloorRate = g.rate;
      } else {
        previewRate = 0; // zero basis: preview no line (PATCH rejects the save)
      }
    }
  }
```

and pass `gratuityRate: previewRate, tipJar: previewTipJar, gratuityFloorRate: previewFloorRate` into `calculateProposal`. Import the two helpers next to the existing `calculateProposal` import.

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/routes/proposals/metadata.calculate.test.js`
Expected: ALL pass.

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/routes/proposals/metadata.js server/routes/proposals/metadata.calculate.test.js
git commit -m "calculate: preview draft gratuity mandate"
```

---

### Task 5: create-intent enforces the mandate floor

**Files:**
- Modify: `server/routes/stripeCreateIntent.js` (SELECT ~line 38, election block ~lines 90-104)
- Test: `server/routes/stripeCreateIntent.test.js`

**Interfaces:**
- Consumes: `deriveGratuityRate({ ..., floorRate })` (Task 2).
- Produces: an election below the mandate 400s with the "required gratuity" message before any Stripe call; at/above passes; the metadata-less path (untouched chooser) is unchanged and charges `total_price`, which already includes the mandate.

- [ ] **Step 1: Write failing tests**

Add to `stripeCreateIntent.test.js` in its existing style (seed proposal, hit the route with the file's stripe stub):

```js
// Seed: unpaid proposal, snapshot gratuity {staff_count:1, hours:2,
//   floor_rate:50, rate:50, total:100}, gratuity_floor_rate 50, total_price
//   includes the 100.
// 1. Election below mandate: body { payment_option:'full', tip_jar:true,
//    gratuity_total: 40 } -> 400, message matches /required gratuity of at
//    least \$100\.00/.
// 2. Election at mandate with no-jar: { tip_jar:false, gratuity_total:100 }
//    -> intent created, metadata gratuity_rate '50', charged total unchanged.
// 3. Election above: { tip_jar:true, gratuity_total:150 } -> metadata rate '75',
//    full-pay amount reflects the raised total.
// 4. No election keys at all -> no gratuity metadata, full-pay amount =
//    total_price (mandate-inclusive), exactly the pre-existing path.
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/routes/stripeCreateIntent.test.js`
Expected: test 1 FAILS (no floor passed, 40 accepted).

- [ ] **Step 3: Implement**

Add `p.gratuity_floor_rate,` to the SELECT column list (after `p.deposit_amount`). In the election block, pass the floor:

```js
    const g = deriveGratuityRate({
      enteredTotal: gratuity_total !== undefined ? gratuity_total : 0,
      staffCount, hours, tipJar: effTipJar,
      floorRate: proposal.gratuity_floor_rate != null ? Number(proposal.gratuity_floor_rate) : 0,
    });
```

Nothing else changes (the recompute + metadata stamping already carry the derived rate; `floor_rate` survives the snapshot recompute via the spread).

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/routes/stripeCreateIntent.test.js`
Expected: ALL pass.

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/routes/stripeCreateIntent.js server/routes/stripeCreateIntent.test.js
git commit -m "create-intent: mandate floor on the gratuity election"
```

---

### Task 6: Webhook apply validates against the row floor

**Files:**
- Modify: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (~lines 194-258)
- Test: `server/routes/stripeWebhook.gratuityApply.test.js`

**Interfaces:**
- Consumes: row column `gratuity_floor_rate` (Task 1).
- Produces: apply-time floor rule — mandate set: `electRate >= floor` required; no mandate: legacy `(tip_jar OR rate >= 50)`. Failure degrades to `warnGratuityApplySkipped('below_floor', ...)`; payment recording untouched. The jar/50 pre-flight MOVES from the pre-row `rateUsable` check to the post-row check (the floor lives on the row).

- [ ] **Step 1: Write failing tests**

Add to `stripeWebhook.gratuityApply.test.js` in its existing harness style:

```js
// Seed: payable proposal with gratuity_floor_rate 50, snapshot floor_rate 50.
// 1. Metadata { tip_jar:'true', gratuity_rate:'40' } (undercuts mandate) ->
//    payment recorded, gratuity NOT applied, skip reason 'below_floor',
//    row keeps rate 50 / floor 50 / total_price unchanged.
// 2. Metadata { tip_jar:'false', gratuity_rate:'75' } -> applied: rate 75,
//    tip_jar false, floor_rate STILL 50 in snapshot, origin NULL.
// 3. No-mandate proposal + { tip_jar:'false', gratuity_rate:'30' } -> skipped
//    (legacy 50 rule) — pins that moving the check post-row kept the rule.
// 4. Mandated at 30 (sub-50) + { tip_jar:'false', gratuity_rate:'30' } ->
//    APPLIED (amended CHECK allows it; mandate replaces the 50 rule).
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/routes/stripeWebhook.gratuityApply.test.js`
Expected: tests 1 and 4 FAIL (old inline jar/50 pre-flight, no floor read).

- [ ] **Step 3: Implement**

At lines 200-204, reduce `rateUsable` to shape-only (the floor needs the row):

```js
            const rateUsable = Number.isFinite(electRate)
              && electRate >= 0
              && electRate <= GRATUITY_SANITY_MAX_RATE;
```

Add `gratuity_floor_rate` to the FOR UPDATE SELECT (line 213). After the degenerate-snapshot guard (line 229), before the SAVEPOINT, insert:

```js
              } else {
                // Floor check needs the ROW (spec 2026-08-10): a mandate is the
                // only floor when set; otherwise the legacy no-jar 50 rule.
                // Pre-flights the amended DB CHECK so a failure is a breadcrumb,
                // not an aborted payment transaction.
                const mandateRate = gRow.rows[0].gratuity_floor_rate != null
                  ? Number(gRow.rows[0].gratuity_floor_rate) : null;
                const floorOk = mandateRate != null
                  ? electRate >= mandateRate
                  : (electTipJar || electRate >= GRATUITY_FLOOR_RATE);
                if (!floorOk) {
                  warnGratuityApplySkipped('below_floor', proposalId, intent.id, intent.metadata);
                } else {
                  // ... existing SAVEPOINT gratuity_apply block, unchanged ...
                }
              }
```

(Re-indent the existing SAVEPOINT block inside the new `else`; the UPDATE itself is unchanged — it never touches `gratuity_floor_rate`, and origin stays explicitly NULL.)

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/routes/stripeWebhook.gratuityApply.test.js`
Expected: ALL pass, including every pre-existing case.

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js server/routes/stripeWebhook.gratuityApply.test.js
git commit -m "webhook: gratuity apply validates against the row mandate floor"
```

---

### Task 7: cancel-line-item clears the mandate

**Files:**
- Modify: `server/utils/lineItemCancel.js` (UPDATE ~line 586)
- Test: `server/utils/lineItemCancel.test.js`

**Interfaces:**
- Produces: lowering/removing a paid gratuity also sets `gratuity_floor_rate = NULL` (a deliberate admin reduction unbinds the mandate; a stale floor would trip the amended CHECK on the lowered rate). Origin-admin stamp unchanged.

- [ ] **Step 1: Write failing test**

Add to `lineItemCancel.test.js` next to the existing gratuity-lowering cases: seed a paid proposal with `gratuity_rate 50, gratuity_floor_rate 50`, run the existing gratuity-lower path to rate 30, assert `gratuity_floor_rate IS NULL` after (and that the write did not violate the CHECK).

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/utils/lineItemCancel.test.js`
Expected: new test FAILS (floor survives) — and depending on target rate the UPDATE itself may now 500 against the amended CHECK, which is exactly the bug this task fixes.

- [ ] **Step 3: Implement**

Line 586 becomes:

```js
      `UPDATE proposals SET gratuity_rate = $1, tip_jar = $2, gratuity_rate_change_origin = 'admin', gratuity_floor_rate = NULL WHERE id = $3`,
```

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/utils/lineItemCancel.test.js`
Expected: ALL pass.

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/utils/lineItemCancel.js server/utils/lineItemCancel.test.js
git commit -m "cancel-line-item: clear gratuity mandate on admin reduction"
```

---

### Task 8: Proposal editor — mandate block

**Files:**
- Modify: `client/src/pages/admin/proposalEditor/formState.js` (~line 39)
- Modify: `client/src/pages/admin/proposalEditor/patchBody.js`
- Modify: `client/src/pages/admin/proposalEditor/ProposalEditorForm.js` (preview payload ~line 170, block at the comment ~line 634)
- Test: `client/src/pages/admin/proposalEditor/patchBody.test.js`

**Interfaces:**
- Consumes: proposal row field `gratuity_floor_rate`, snapshot `gratuity.{staff_count,hours}`; `/calculate` mandate param (Task 4); PATCH field (Task 3).
- Produces: form field `gratuity_mandate_total` (dollars or null); `buildProposalPatchBody(form, { includeGratuityMandate })` emits the key ONLY when `includeGratuityMandate` is true (the form passes `!isPaid`), so a paid proposal's unrelated edits never trip the server guard.

- [ ] **Step 1: Write failing tests**

Add to `patchBody.test.js`:

```js
// 1. buildProposalPatchBody({...form, gratuity_mandate_total: 100}, { includeGratuityMandate: true })
//    -> body.gratuity_mandate_total === 100
// 2. { includeGratuityMandate: true } with form value null -> key present, null
// 3. { includeGratuityMandate: false } -> key ABSENT (hasOwnProperty false)
// 4. Body still never contains tip_jar or gratuity_total keys.
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=patchBody`
Expected: FAIL.

- [ ] **Step 3: Implement**

`formState.js` (~line 39), seed alongside `adjustments`:

```js
    // Mandate dollars are DISPLAY-derived from the canonical rate at the
    // CURRENT staffing, so a rescaled mandate shows its rescaled dollars.
    gratuity_mandate_total: p.gratuity_floor_rate != null
      ? Math.round(Number(p.gratuity_floor_rate)
          * (Number(p.pricing_snapshot?.gratuity?.staff_count) || 0)
          * (Number(p.pricing_snapshot?.gratuity?.hours) || 0) * 100) / 100
      : null,
```

`patchBody.js`: add option `includeGratuityMandate = false` to the opts destructure; after the body literal:

```js
  // Admin gratuity mandate (spec 2026-08-10): the ONE gratuity key this form
  // may send, and only for an unpaid proposal (the caller gates on paid).
  // tip_jar/gratuity_total stay banned (election-at-payment).
  if (includeGratuityMandate) {
    body.gratuity_mandate_total = form.gratuity_mandate_total == null
      ? null : Number(form.gratuity_mandate_total);
  }
```

`ProposalEditorForm.js`:
1. Compute `const isPaidProposal = Number(proposal?.amount_paid || 0) > 0;` near the other derived flags (reuse the form's existing paid flag if one exists).
2. Preview payload (~line 170): add `...(isPaidProposal ? {} : { gratuity_mandate_total: editForm.gratuity_mandate_total }),` and add `editForm.gratuity_mandate_total` to the effect deps.
3. Every `buildProposalPatchBody(...)` call site in this file passes `includeGratuityMandate: !isPaidProposal`.
4. Replace the comment block at ~line 634 with the mandate UI (mirrors the Override-total pattern directly above it):

```jsx
        {/* Prepaid gratuity mandate (spec 2026-08-10): admin-required gratuity,
            floors the client's election at checkout. Read-only once paid
            (post-payment changes go through cancel-line-item). */}
        <div style={{ paddingTop: 12, borderTop: '1px solid var(--line-1)', marginBottom: 12 }}>
          <label className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: isPaidProposal ? 'default' : 'pointer' }}>
            <input type="checkbox"
              checked={editForm.gratuity_mandate_total != null}
              disabled={isPaidProposal}
              onChange={e => update('gratuity_mandate_total', e.target.checked ? standardGratuityDollars : null)} />
            Require prepaid gratuity
          </label>
          {editForm.gratuity_mandate_total != null && (
            <div className="hstack" style={{ gap: 8, marginTop: 6 }}>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', fontSize: 12, pointerEvents: 'none' }}>$</span>
                <input className="input" type="number" min="0" step="0.01"
                  value={editForm.gratuity_mandate_total}
                  disabled={isPaidProposal}
                  onChange={e => update('gratuity_mandate_total', e.target.value !== '' ? Number(e.target.value) : null)}
                  style={{ width: 140, paddingLeft: 18 }} />
              </div>
              <button type="button" className="btn btn-ghost btn-sm" disabled={isPaidProposal}
                onClick={() => update('gratuity_mandate_total', standardGratuityDollars)}>
                Standard ($50/{editPreview?.gratuity?.staff_noun || 'bartender'}/hr)
              </button>
              <span className="tiny muted">Client can give more at checkout, never less</span>
            </div>
          )}
        </div>
```

with, near the other derived values:

```js
  const standardGratuityDollars = Math.round(
    50 * (Number(editPreview?.gratuity?.staff_count) || 0)
       * (Number(editPreview?.gratuity?.hours) || 0) * 100) / 100;
```

- [ ] **Step 4: Run tests + build gate**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=patchBody`
Expected: PASS.
Run: `cd client && CI=true npx react-scripts build` (the Vercel-exact lint gate; client lint only exists here).
Expected: build succeeds with no new warnings.

- [ ] **Step 5: Checkpoint commit**

```bash
git add client/src/pages/admin/proposalEditor/formState.js client/src/pages/admin/proposalEditor/patchBody.js client/src/pages/admin/proposalEditor/patchBody.test.js client/src/pages/admin/proposalEditor/ProposalEditorForm.js
git commit -m "editor: prepaid gratuity mandate block (dollar input + standard chip)"
```

---

### Task 9: Checkout — mandate floor + copy

**Files:**
- Modify: `client/src/pages/proposal/proposalView/gratuityFloor.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js` (~lines 55-75, 546)
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js` (~lines 73-330)
- Test: `client/src/pages/proposal/proposalView/gratuityFloor.test.js`

**Interfaces:**
- Consumes: snapshot `gratuity.floor_rate` (served inside `pricing_snapshot` by the existing public GET; no API change).
- Produces: `isGratuityBelowFloor({ ..., mandated })` ignores the jar short-circuit when mandated; `gratuityFloorMessage(floorText, staffNoun, mandated)` mandate variant; `SignAndPaySection` prop `gratuityMandated`.

- [ ] **Step 1: Write failing tests**

Add to `gratuityFloor.test.js`:

```js
// 1. isGratuityBelowFloor({gratuityEnabled:true, tipJar:true, gratuityTotal:40,
//    gratuityFloor:100, mandated:true}) === true   (jar no longer exempts)
// 2. same but gratuityTotal:100 -> false
// 3. mandated:false, tipJar:true -> false (legacy path pinned)
// 4. gratuityFloorMessage('$100.00','bartender',true) matches
//    /required gratuity of at least \$100\.00/ and contains no em dash
// 5. gratuityFloorMessage('$100.00','bartender') keeps the legacy no-jar text
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=gratuityFloor`
Expected: FAIL.

- [ ] **Step 3: Implement**

`gratuityFloor.js`:

```js
export function isGratuityBelowFloor({ gratuityEnabled, tipJar, gratuityTotal, gratuityFloor, mandated = false }) {
  if (!gratuityEnabled) return false;
  if (!mandated && tipJar) return false; // mandate floors BOTH jar answers
  return (Number(gratuityTotal) || 0) < gratuityFloor;
}

export function gratuityFloorMessage(floorText, staffNoun, mandated = false) {
  return mandated
    ? `This event includes a required gratuity of at least ${floorText} for your ${staffNoun}s.`
    : `Without a tip jar, gratuity must be at least ${floorText} so your ${staffNoun}s are covered.`;
}
```

`ProposalView.js` (~lines 65-74): derive the mandate and floor from the snapshot:

```js
  const gratuityMandateRate = Number(gratuityBasis?.floor_rate) || 0;
  const gratuityMandated = gratuityMandateRate > 0;
  // Mandate REPLACES the no-jar 50 rule (ruling 2026-08-10). The literal 50
  // mirrors server GRATUITY_FLOOR_RATE — keep in sync (existing note).
  const gratuityFloor = gratuityMandated
    ? Math.round(gratuityMandateRate * gratuityStaffCount * gratuityHours * 100) / 100
    : Math.round(50 * gratuityStaffCount * gratuityHours);
  const gratuityBelowFloor = isGratuityBelowFloor({
    gratuityEnabled, tipJar, gratuityTotal, gratuityFloor, mandated: gratuityMandated,
  });
```

and pass `gratuityMandated={gratuityMandated}` to `SignAndPaySection` (~line 546).

`SignAndPaySection.js`: accept `gratuityMandated = false` in props; then four copy/behavior changes, all mandate-gated so the legacy render is byte-identical:

1. Intro (~lines 258-262): when mandated, replace the "either guests tip at the bar, or the gratuity is prepaid" sentence with: `A prepaid gratuity of {fmt(gratuityFloor)} is included for your {gratuityStaffNoun}s.` The "None of it is kept by Dr. Bartender." sentence stays (accepted framing).
2. No-jar tablet description (~lines 294-296): when mandated, replace the "$50 per {noun} per hour is added" sentence with: `No jar at the bar. Your prepaid gratuity covers your {gratuityStaffNoun}s.`
3. Amount heading (~line 303): when mandated, always `Gratuity for your {gratuityStaffNoun}s` regardless of jar answer. Hide the preset chips row (`{tipJar && !gratuityMandated && (...)}`) — a "suggested" below the floor is noise.
4. Input (~line 323): `min={gratuityMandated ? gratuityFloor : (tipJar ? 0 : gratuityFloor)}`. The below-floor warning (~line 329) and the pay-gate message (~line 375) pass `gratuityMandated` through to `gratuityFloorMessage(fmt(gratuityFloor), gratuityStaffNoun, gratuityMandated)`.

No em dashes in any of this copy. The jar radio itself is untouched: it still records the answer, and under a mandate both answers show the same floor.

- [ ] **Step 4: Run tests + build gate**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=gratuityFloor`
Expected: PASS.
Run: `cd client && CI=true npx react-scripts build`
Expected: clean.

- [ ] **Step 5: Checkpoint commit**

```bash
git add client/src/pages/proposal/proposalView/gratuityFloor.js client/src/pages/proposal/proposalView/gratuityFloor.test.js client/src/pages/proposal/proposalView/ProposalView.js client/src/pages/proposal/proposalView/SignAndPaySection.js
git commit -m "checkout: mandate floors both jar answers + stated-not-invited copy"
```

---

### Task 10: Docs

**Files:**
- Modify: `CLAUDE.md` (Checkout gratuity invariant bullet)
- Modify: `ARCHITECTURE.md` (Database Schema section, proposals table)

**Interfaces:** none (docs).

- [ ] **Step 1: Amend the CLAUDE.md invariant**

In the **Checkout gratuity** bullet, replace the sentence
`Unpaid proposals never carry a gratuity, and the admin PATCH never accepts tip_jar/gratuity_total (admin removal goes through cancel-line-item only).`
with:
`Unpaid proposals never carry a client-elected gratuity; the ONLY pre-payment gratuity is an admin mandate (gratuity_floor_rate NOT NULL, spec 2026-08-10), which floors the client's election on BOTH jar answers (replacing, never stacking on, the $50 no-jar floor) and rides the same rate machinery. The admin PATCH accepts exactly one gratuity field, gratuity_mandate_total (dollars; null clears; absent carries forward; unpaid only), and still never accepts tip_jar/gratuity_total (admin removal goes through cancel-line-item only, which also clears the mandate).`

- [ ] **Step 2: ARCHITECTURE.md schema note**

Add `gratuity_floor_rate NUMERIC(10,4)` to the proposals-table description with one line: admin gratuity mandate, NULL = none, checkout election floor, amended `proposals_gratuity_jar_check`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md
git commit -m "docs: admin gratuity mandate invariant + schema note"
```

---

## Full-suite verification (lane exit gate)

Before the merge request, run every touched suite one at a time from repo root:

```bash
node --test server/utils/pricingEngine.test.js
node --test -r dotenv/config server/routes/proposals/crud.test.js
node --test -r dotenv/config server/routes/proposals/metadata.calculate.test.js
node --test -r dotenv/config server/routes/stripeCreateIntent.test.js
node --test -r dotenv/config server/routes/stripeWebhook.gratuityApply.test.js
node --test -r dotenv/config server/utils/lineItemCancel.test.js
node --test -r dotenv/config server/utils/invoiceHelpers.gratuity.test.js
node --test -r dotenv/config server/utils/changeRequests.gratuity.test.js
cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern="gratuityFloor|patchBody" && CI=true npx react-scripts build
```

The last two server suites are consumers of the gratuity fields that this plan does not modify; they must stay green untouched (run-suites-a-change-reaches rule).

## Rollout order (push time, not lane time)

1. Run the Task 1 DDL block on PROD (Neon `round-tooth-34649976` default branch) and verify the amended constraint definition.
2. Merge the lane (full review fleet), then push per the standard push model (fleet + `/second-opinion` on these sensitive commits).
3. Post-deploy walk: set a $100 mandate on a scratch proposal, view the public page (line + total), verify checkout shows the stated copy and refuses a below-floor election, then clear the mandate.
