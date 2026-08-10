---
lanes:
  - id: gratuity-mandate
    footprint:
      - server/db/schema.sql
      - server/utils/pricingEngine.js
      - server/utils/pricingEngine.test.js
      - server/utils/gratuityMandate.js
      - server/utils/proposalExtrasFold.js
      - server/utils/proposalExtrasFold.stability.test.js
      - server/utils/proposalExtrasFold.legs.test.js
      - server/utils/changeRequests.js
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
      - scripts/reset-unpaid-gratuity.js
      - client/src/pages/admin/proposalEditor/**
      - client/src/pages/proposal/proposalView/**
      - .claude/CLAUDE.md
      - ARCHITECTURE.md
      - README.md
    depends_on: []
    review: full-fleet
---

# Admin Gratuity Mandate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin can set a required prepaid gratuity on an unpaid, unsigned proposal; checkout floors at it on both jar answers; enforced in `deriveGratuityRate`, the webhook apply, and an amended DB CHECK.

**Architecture:** New `proposals.gratuity_floor_rate` column (mandate exists iff `> 0`). Setting a mandate derives a rate from admin-entered dollars and writes it to both `gratuity_floor_rate` and `gratuity_rate`. Every persisting snapshot writer carries the floor into `pricing_snapshot.gratuity.floor_rate`. The mandate becomes the election floor at checkout, replacing (not stacking on) the $50 no-jar floor. `gratuity_rate_change_origin` is never touched by mandate writes.

**Tech Stack:** Node/Express, raw SQL via pg, node:test, React (CRA), Stripe.

**Spec:** `docs/superpowers/specs/2026-08-10-admin-gratuity-mandate-design.md` (revised 2026-08-10 after the design fleet; this plan matches the revision)

## Global Constraints

- Proposals money is DOLLARS (`NUMERIC(10,2)`), rates are `NUMERIC(10,4)`. Never mix with cents tables.
- **Mandate presence is `gratuity_floor_rate > 0` at EVERY layer** (engine, routes, webhook, client). Never test `!= null`.
- No em dashes in any client-facing copy.
- Explicit `git add <path>` only; lane checkpoint commits are free (squash-merged later).
- Single lane; work happens in a worktree cut via `npm run worktree:new gratuity-mandate` from `os`. Never move `os` off main.
- Server suites run ONE AT A TIME from repo root: `node --test -r dotenv/config <file>` (shared dev DB).
- The PATCH still refuses `tip_jar`/`gratuity_total`. The ONE new accepted field is `gratuity_mandate_total` (dollars > 0 sets, null clears, absent carries forward). Rejected once signed (`client_signed_at` set or `status='accepted'`) or paid (`amount_paid > 0`).
- Mandate floor REPLACES the $50 no-jar floor; choosing no-jar under a mandate never charges more.
- `crud.js` is at 995 lines against a 1000 hard cap: all new logic lives in `server/utils/gratuityMandate.js`, and Task 3 moves existing lines out so `crud.js` does not grow. Verify with `wc -l` before committing.
- This is money/checkout code: mid-lane review checkpoint after the server half (Task 9), full review fleet at lane merge, push gets fleet + `/second-opinion`.

---

### Task 1: Schema — column + amended CHECK

**Files:**
- Modify: `server/db/schema.sql` (insert after the `proposals_gratuity_jar_check` block, ~line 1313; amend the rollback comment block ~lines 1327-1335)

**Interfaces:**
- Produces: column `proposals.gratuity_floor_rate NUMERIC(10,4)` NULL; constraint `proposals_gratuity_jar_check` amended to `(tip_jar = true OR gratuity_rate >= 50 OR (gratuity_floor_rate IS NOT NULL AND gratuity_rate >= gratuity_floor_rate))`.

- [ ] **Step 1: Add the DDL block to schema.sql**

Insert after the existing `proposals_gratuity_jar_check` DO block (~line 1313), before the origin-check block:

```sql
-- Admin gratuity mandate (spec 2026-08-10): a required prepaid gratuity,
-- stored as a $/staff/hr floor RATE. A mandate exists iff > 0 (writers never
-- store 0). The rate is canonical; the dollar rescales with staffing/hours.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS gratuity_floor_rate NUMERIC(10,4);

-- Amend the jar CHECK: a mandated proposal whose rate meets its own floor is
-- valid even when no-jar and under $50/staff/hr (the mandate REPLACES the
-- no-jar floor; ruling 2026-08-10). initDb replays this file on every boot,
-- so the drop is CONDITIONAL on the old definition: one-time swap, then a
-- no-op forever (never an unconditional drop, which would re-validate the
-- table per boot with a constraint-free window).
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

Also extend the rollback comment block (~lines 1327-1335) with the two new lines:

```sql
--   ALTER TABLE proposals DROP COLUMN IF EXISTS gratuity_floor_rate;
--   (and re-add the original two-clause proposals_gratuity_jar_check)
```

- [ ] **Step 2: Apply the new block to the dev DB**

Copy just the block above into a scratch file and run it from repo root:

```bash
node -r dotenv/config -e "const{Pool}=require('pg');const fs=require('fs');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(fs.readFileSync(process.argv[1],'utf8')).then(()=>{console.log('applied');return p.end()}).catch(e=>{console.error(e.message);process.exit(1)})" /tmp/claude-1000/-home-drbartender/38eb82ea-bc9c-4cef-bb14-d4537ef967e6/scratchpad/mandate-ddl.sql
```

(Additive column + CHECK-weakening only: a scrapped lane needs no dev-DB rollback.)

- [ ] **Step 3: Verify column + constraint**

```bash
node -r dotenv/config -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='proposals' AND c.conname='proposals_gratuity_jar_check'\").then(r=>{console.log(r.rows[0].def);return p.end()})"
```

Expected: definition contains `gratuity_floor_rate`. Re-run the Step 2 command once more and confirm it prints `applied` with no error (idempotency proof).

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "schema: gratuity_floor_rate column + amended jar CHECK (admin mandate)"
```

NOTE for rollout (NOT this task): the same block runs on PROD before the code push, per standing order.

---

### Task 2: Pricing engine — floor param + snapshot `floor_rate`

**Files:**
- Modify: `server/utils/pricingEngine.js` (`deriveGratuityRate` ~line 294, `calculateProposal` signature ~line 358 and gratuity block ~line 592)
- Test: `server/utils/pricingEngine.test.js`

**Interfaces:**
- Consumes: existing `GRATUITY_FLOOR_RATE` (50), `GRATUITY_SANITY_MAX_RATE` (1000).
- Produces: `deriveGratuityRate({ enteredTotal, staffCount, hours, tipJar, floorRate = 0 })` — when `floorRate > 0` it is the ONLY floor (both jar answers; the 50 no-jar rule is bypassed), with snap-to-floor within the half-cent tolerance. `calculateProposal({ ..., gratuityFloorRate = null })` stamps `snapshot.gratuity.floor_rate` (number when > 0, else null). `recomputeSnapshotGratuity` preserves `floor_rate` (already does via the `...snap.gratuity` spread; test pins it).

- [ ] **Step 1: Write failing tests**

Append to `server/utils/pricingEngine.test.js`. Reuse the file's existing BYOB package fixture constant for `calculateProposal` calls (do NOT invent a minimal pkg literal; the file's fixture carries `base_rate_4hr` / `bartenders_included` / `guests_per_bartender`, which keep staffing non-degenerate):

```js
test('deriveGratuityRate: mandate floor binds on BOTH jar answers, replacing the 50 rule', () => {
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
  assert.strictEqual(
    deriveGratuityRate({ enteredTotal: 230, staffCount: 1, hours: 7, tipJar: true, floorRate: 33.3333 }).ok,
    false);
});

test('deriveGratuityRate: no-floor behavior is byte-identical to before', () => {
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 200, staffCount: 1, hours: 4, tipJar: true }),
    { ok: true, rate: 50 });
  assert.strictEqual(deriveGratuityRate({ enteredTotal: 100, staffCount: 1, hours: 4, tipJar: false }).ok, false);
  // floorRate 0 explicitly = no mandate
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 0, staffCount: 1, hours: 4, tipJar: true, floorRate: 0 }),
    { ok: true, rate: 0 });
});

test('calculateProposal stamps gratuity.floor_rate; non-positive coerces to null; recompute + rescale preserve it', () => {
  // Use the file's existing BYOB fixture constant here.
  const snap = calculateProposal({
    pkg: BYOB, guestCount: 100, durationHours: 2, numBars: 0, numBartenders: 1,
    addons: [], syrupSelections: [], adjustments: [],
    gratuityRate: 50, tipJar: true, gratuityFloorRate: 50,
  });
  assert.strictEqual(snap.gratuity.floor_rate, 50);
  assert.strictEqual(snap.gratuity.total, 100);
  // recompute (webhook path) preserves floor_rate via the spread
  const re = recomputeSnapshotGratuity(snap, { gratuityRate: 75, tipJar: false, staffNoun: 'bartender', durationHours: 2 });
  assert.strictEqual(re.gratuity.floor_rate, 50);
  // rescale at constant rate: doubling hours doubles the dollars, floor intact
  const rescaled = calculateProposal({
    pkg: BYOB, guestCount: 100, durationHours: 4, numBars: 0, numBartenders: 1,
    addons: [], syrupSelections: [], adjustments: [],
    gratuityRate: 50, tipJar: true, gratuityFloorRate: 50,
  });
  assert.strictEqual(rescaled.gratuity.total, 200);
  assert.strictEqual(rescaled.gratuity.floor_rate, 50);
  // absent / zero / negative mandate stamps null
  for (const fr of [undefined, null, 0, -5]) {
    const plain = calculateProposal({
      pkg: BYOB, guestCount: 100, durationHours: 2, numBars: 0, numBartenders: 1,
      addons: [], syrupSelections: [], adjustments: [], gratuityFloorRate: fr,
    });
    assert.strictEqual(plain.gratuity.floor_rate, null);
  }
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
  // Admin mandate (spec 2026-08-10): when set (> 0) it is the ONLY floor, on
  // both jar answers. The $50 no-jar rule applies only when there is no mandate.
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
  // Mandate branch only: a displayed floor that round-trips a hair low
  // (rescaled rate x basis rounded to cents, divided back) must SNAP to the
  // floor rate, because the DB CHECK (gratuity_rate >= gratuity_floor_rate)
  // is strict. The legacy no-jar branch keeps its reject-only behavior.
  if (mandate > 0 && rate < mandate && total >= floorTotal - 0.005) rate = mandate;
  // Re-assert the floor on the DERIVED rate (spec 2026-08-03 section 4.5).
  if (effFloor > 0 && rate < effFloor) {
    return { ok: false, code: 'GRATUITY_BELOW_FLOOR', message: floorMsg };
  }
  if (rate > GRATUITY_SANITY_MAX_RATE) {
    return { ok: false, code: 'GRATUITY_TOO_LARGE', message: 'That gratuity is unusually large — please re-enter it.' };
  }
  return { ok: true, rate };
}
```

(The GRATUITY_TOO_LARGE message keeps its existing text verbatim; pre-existing copy.)

`calculateProposal` (~line 358): add `gratuityFloorRate = null` to the destructured params. In the snapshot's `gratuity` block (~line 592) add one line:

```js
      floor_rate: Number(gratuityFloorRate) > 0 ? Number(gratuityFloorRate) : null,
```

No change to `recomputeSnapshotGratuity` (the `...snap.gratuity` spread at line 347 preserves `floor_rate`; the test pins it).

- [ ] **Step 4: Run tests**

Run: `node --test server/utils/pricingEngine.test.js`
Expected: ALL pass, including every pre-existing gratuity test.

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/utils/pricingEngine.js server/utils/pricingEngine.test.js
git commit -m "engine: mandate floor in deriveGratuityRate + snapshot gratuity.floor_rate"
```

---

### Task 3: Mandate resolution helper + admin PATCH

**Files:**
- Create: `server/utils/gratuityMandate.js`
- Modify: `server/routes/proposals/crud.js` (gratuity resolution ~lines 540-567, UPDATE ~lines 569-606)
- Test: `server/routes/proposals/crud.test.js`

**Interfaces:**
- Consumes: `deriveGratuityRate` (no floorRate here: admin entry has no floor to satisfy, only sanity checks), `computeGratuityBasis({ pkg, guestCount, durationHours, numBartenders, addons })`, `calculateProposal({ ..., gratuityFloorRate })` (Task 2).
- Produces: `resolveGratuityForPatch({ body, old, pkg, guestCount, durationHours, numBartenders, addons })` returning `{ gratuityRate, floorRate, tipJar }` (throws `ValidationError` when locked/invalid) and `staffingGratuityOrigin({ isPaid, origin, oldSnapshot, newSnapshot })` returning `{ origin, notify }`, both in `gratuityMandate.js`. PATCH body key `gratuity_mandate_total`: number > 0 sets, `null` clears (only when a mandate exists; forces `tip_jar = true`), ABSENT carries forward. Rejected once signed or paid.

- [ ] **Step 1: Write failing tests**

Add to `server/routes/proposals/crud.test.js`, following that file's existing insert-then-PATCH pattern (reuse its app/db bootstrap helpers exactly as neighboring tests do). Cases, each with a SELECT-after assertion against the row and snapshot:

```js
// 1. Set: PATCH { gratuity_mandate_total: 100 } on an unpaid unsigned
//    1-bartender 2-hour proposal (seed total_price 250) -> 200; row:
//    gratuity_rate 50, gratuity_floor_rate 50, gratuity_rate_change_origin
//    UNCHANGED (null); snapshot.gratuity {rate:50, total:100, floor_rate:50};
//    breakdown has a 'Gratuity' 100 line; total_price 350.
// 2. Clear: second PATCH { gratuity_mandate_total: null } -> rate 0, floor
//    null, tip_jar TRUE, Gratuity line gone, total_price 250.
// 3. Clear is a no-op without a mandate: seed a proposal with a client-elected
//    gratuity (gratuity_rate 60, gratuity_floor_rate NULL, amount_paid 0 as if
//    refunded to zero); PATCH { gratuity_mandate_total: null } -> 200 and
//    gratuity_rate STILL 60 (an elected gratuity is never wiped by clear).
// 4. Carry-forward + rescale: on a mandated proposal, PATCH WITHOUT the key
//    changing event_duration_hours 2 -> 4 -> floor_rate and rate survive at 50
//    and the Gratuity line rescales 100 -> 200.
// 5. Paid guard: seed amount_paid 100, PATCH { gratuity_mandate_total: 120 }
//    -> 400; row untouched.
// 6. Signed guard: seed client_signed_at NOW() (amount_paid 0), PATCH
//    { gratuity_mandate_total: 120 } -> 400; row untouched.
// 7. Non-positive: { gratuity_mandate_total: 0 } -> 400 (a stored floor of 0
//    would disable the no-jar rule at the webhook; presence is > 0).
// 8. Zero basis: seed event_duration_hours 0 -> set 400s; but
//    { gratuity_mandate_total: null } on the same mandated-then-zeroed row
//    -> 200 (clear works regardless of basis).
// 9. Still refuses election keys: PATCH { tip_jar: false, gratuity_total: 500 }
//    -> 200 with tip_jar/gratuity_rate unchanged (existing behavior, pinned).
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/routes/proposals/crud.test.js`
Expected: new tests FAIL.

- [ ] **Step 3: Implement the helper**

Create `server/utils/gratuityMandate.js`:

```js
// Admin gratuity mandate (spec 2026-08-10) resolution for the proposal PATCH.
// Lives outside crud.js for the file-size ratchet; crud.js is the only consumer.
const { computeGratuityBasis, deriveGratuityRate } = require('./pricingEngine');
const { ValidationError } = require('./errors');

/** Resolve the gratuity columns for a PATCH. A mandate exists iff
 *  gratuity_floor_rate > 0. Returns { gratuityRate, floorRate, tipJar };
 *  floorRate null = no mandate. Throws ValidationError on a locked or
 *  invalid mandate change. */
function resolveGratuityForPatch({ body, old, pkg, guestCount, durationHours, numBartenders, addons }) {
  let tipJar = old.tip_jar !== false;
  let gratuityRate = Number(old.gratuity_rate) || 0;
  let floorRate = Number(old.gratuity_floor_rate) > 0 ? Number(old.gratuity_floor_rate) : null;
  if (!Object.prototype.hasOwnProperty.call(body, 'gratuity_mandate_total')) {
    return { gratuityRate, floorRate, tipJar };
  }
  // A signature must never stand against a total admin changed afterward;
  // paid changes go through cancel-line-item.
  const locked = Number(old.amount_paid || 0) > 0
    || old.client_signed_at != null || old.status === 'accepted';
  if (locked) {
    throw new ValidationError({
      gratuity_mandate_total: 'Gratuity cannot be changed after the client has signed or paid. Lower a paid gratuity via its line item.',
    });
  }
  const mt = body.gratuity_mandate_total;
  if (mt == null) {
    // Clear: only a real mandate is clearable; never touch an elected
    // gratuity. Forcing the jar on mirrors lineItemCancel (rate 0 with
    // tip_jar=false would violate the CHECK).
    if (floorRate != null) return { gratuityRate: 0, floorRate: null, tipJar: true };
    return { gratuityRate, floorRate, tipJar };
  }
  if (!(Number(mt) > 0)) {
    throw new ValidationError({ gratuity_mandate_total: 'Enter a required gratuity above $0, or clear it.' });
  }
  const { staffCount, hours } = computeGratuityBasis({ pkg, guestCount, durationHours, numBartenders, addons });
  if (staffCount * hours <= 0) {
    throw new ValidationError({ gratuity_mandate_total: 'Set staffing and duration before requiring a gratuity.' });
  }
  const g = deriveGratuityRate({ enteredTotal: mt, staffCount, hours, tipJar: true });
  if (!g.ok) throw new ValidationError({ gratuity_mandate_total: g.message });
  return { gratuityRate: g.rate, floorRate: g.rate, tipJar };
}

/** Staffing-notice resolution, moved verbatim from crud.js (ratchet): stamp
 *  origin 'staffing' + notify only on a PAID rescale (spec 2026-08-03 §7). */
function staffingGratuityOrigin({ isPaid, origin, oldSnapshot, newSnapshot }) {
  const oldTotal = Number(oldSnapshot?.gratuity?.total) || 0;
  const newTotal = Number(newSnapshot?.gratuity?.total) || 0;
  if (isPaid && origin !== 'admin' && newTotal !== oldTotal) {
    return { origin: 'staffing', notify: newTotal > oldTotal };
  }
  return { origin, notify: false };
}

module.exports = { resolveGratuityForPatch, staffingGratuityOrigin };
```

- [ ] **Step 4: Wire crud.js (net non-growing)**

Replace BOTH existing blocks: the resolution lines (~546-549) AND the staffing-notice block (~558-567) with:

```js
    const isPaidForGratuity = Number(old.amount_paid || 0) > 0;
    // Gratuity (election-at-payment 2026-08-03 + admin mandate 2026-08-10):
    // the election persists only via the webhook; this PATCH accepts exactly
    // one gratuity field, gratuity_mandate_total, resolved in gratuityMandate.js.
    const { gratuityRate: resolvedGratuityRate, floorRate: resolvedFloorRate, tipJar: persistTipJar } =
      resolveGratuityForPatch({
        body: req.body, old, pkg, guestCount: gc, durationHours: dh,
        numBartenders: num_bartenders, addons,
      });
```

then after the `calculateProposal` call (which gains `gratuityFloorRate: resolvedFloorRate`):

```js
    const { origin: gratuityOrigin, notify: staffingNotify } = staffingGratuityOrigin({
      isPaid: isPaidForGratuity, origin: old.gratuity_rate_change_origin || null,
      oldSnapshot: old.pricing_snapshot, newSnapshot: snapshot,
    });
    if (staffingNotify) notifyStaffingGratuity = true;
```

Import `{ resolveGratuityForPatch, staffingGratuityOrigin }` from `../../utils/gratuityMandate` alongside the file's existing utils imports. UPDATE statement: add `gratuity_floor_rate = $29` to the SET list and `resolvedFloorRate` as the 29th parameter.

Then verify the ratchet: `wc -l server/routes/proposals/crud.js` must print <= 995 (the moved notice block pays for the additions). If over, move the `calculateProposal` argument assembly into the helper too.

- [ ] **Step 5: Run tests**

Run: `node --test -r dotenv/config server/routes/proposals/crud.test.js`
Expected: ALL pass.

- [ ] **Step 6: Checkpoint commit**

```bash
git add server/utils/gratuityMandate.js server/routes/proposals/crud.js server/routes/proposals/crud.test.js
git commit -m "crud: gratuity_mandate_total via gratuityMandate.js (set/clear/carry, signed+paid guard)"
```

---

### Task 4: Persisting snapshot writers carry the floor

**Files:**
- Modify: `server/utils/proposalExtrasFold.js` (calculateProposal call ~line 176)
- Modify: `server/utils/changeRequests.js` (calculateProposal call ~line 77-89)
- Modify: `scripts/reset-unpaid-gratuity.js` (WHERE clause ~lines 40-41)
- Test: `server/utils/proposalExtrasFold.stability.test.js`

**Interfaces:**
- Consumes: `calculateProposal({ ..., gratuityFloorRate })` (Task 2); both utils load the proposal via `SELECT *`, so `gratuity_floor_rate` is already in hand.
- Produces: a fold or change-request recompute on a mandated proposal preserves `pricing_snapshot.gratuity.floor_rate`; the reset script can never touch a mandated quote.

Why this task exists (fleet blocker #1): `calculateProposal` rebuilds the gratuity block from scratch, and `proposalExtrasFold.js` PERSISTS its result (`UPDATE proposals SET pricing_snapshot = ...`), reached from `lineItemCancel.js`, `drinkPlans/submit.js`, and `drinkPlans/lab.js`. Without the pass-through, a drink-plan submit strips the snapshot floor while the row column survives, and checkout stops floor-enforcing client-side while create-intent still 400s: a dead-end for the client. (`public.js` and `thumbtackProposalDraft.js` are CREATE paths for rows that cannot have a mandate; audited, no change.)

- [ ] **Step 1: Write failing test**

Add to `proposalExtrasFold.stability.test.js` in its existing harness style: seed a mandated proposal (`gratuity_rate 50, gratuity_floor_rate 50`, snapshot with `gratuity.floor_rate: 50`), run a fold, assert the persisted snapshot still has `gratuity.floor_rate === 50` and the row column is unchanged.

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/utils/proposalExtrasFold.stability.test.js`
Expected: new test FAILS (floor_rate null after fold).

- [ ] **Step 3: Implement**

In `proposalExtrasFold.js`, at the `calculateProposal` call (~line 176), add:

```js
    gratuityFloorRate: Number(proposal.gratuity_floor_rate) > 0 ? Number(proposal.gratuity_floor_rate) : null,
```

In `changeRequests.js`, at its `calculateProposal` call (~line 77-89), add the same line using that scope's proposal row variable. (Read the surrounding code first: if this call is preview-only the pass-through simply keeps the preview consistent; if it persists, it is load-bearing. Either way it is correct.)

In `scripts/reset-unpaid-gratuity.js`, extend the selection WHERE clause (~lines 40-41) with:

```sql
AND gratuity_floor_rate IS NULL
```

so a re-run can never strip admin-mandated quotes (they are exactly the shape the script hunts: unpaid, rate > 0).

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/utils/proposalExtrasFold.stability.test.js`
Then: `node --test -r dotenv/config server/utils/proposalExtrasFold.legs.test.js`
Expected: ALL pass (legs suite untouched but adjacent; run it now, not just at exit).

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/utils/proposalExtrasFold.js server/utils/changeRequests.js scripts/reset-unpaid-gratuity.js server/utils/proposalExtrasFold.stability.test.js
git commit -m "snapshot writers: carry gratuity_floor_rate through fold/change-request; guard reset script"
```

---

### Task 5: `/proposals/calculate` previews the mandate

**Files:**
- Modify: `server/routes/proposals/metadata.js` (~lines 36-83)
- Test: `server/routes/proposals/metadata.calculate.test.js`

**Interfaces:**
- Consumes: `computeGratuityBasis`, `deriveGratuityRate`, `calculateProposal({ ..., gratuityFloorRate })`.
- Produces: `POST /api/proposals/calculate` accepts optional `gratuity_mandate_total`; number > 0 previews the derived rate + `gratuity.floor_rate`; `null` previews cleared (rate 0, floor null); ABSENT is today's stored-rate path verbatim. Non-positive or invalid -> 400 (parity with the PATCH).

- [ ] **Step 1: Write failing tests**

Add to `metadata.calculate.test.js` in its existing request style. Pass `num_bartenders: 1` and `duration_hours: 2` EXPLICITLY in every new case (the suite resolves a real package; without the override a hosted package could derive a different staff count):

```js
// 1. { ...base, num_bartenders: 1, duration_hours: 2, gratuity_mandate_total: 100 }
//    -> snapshot.gratuity {rate:50, floor_rate:50, total:100}, breakdown has
//    Gratuity 100, total includes it.
// 2. { ...base, gratuity_mandate_total: null } -> gratuity.rate 0, floor_rate null.
// 3. Absent key + { tip_jar:false, gratuity_rate:60 } -> legacy stored-rate
//    preview (rate 60 honored), floor_rate null.
// 4. { gratuity_mandate_total: 0 } -> 400.   5. { gratuity_mandate_total: -5 } -> 400.
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/routes/proposals/metadata.calculate.test.js`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

Destructure `gratuity_mandate_total` from `req.body`. After the addons block, replace the two preview lines with:

```js
  // Gratuity preview: a DRAFT mandate (spec 2026-08-10) wins over the stored
  // rate/jar; null previews the mandate cleared; absent = stored-rate path
  // (election-at-payment) exactly as before. Validation mirrors the PATCH.
  let previewTipJar = tip_jar !== false;
  let previewRate = Number(gratuity_rate) || 0;
  let previewFloorRate = null;
  if (gratuity_mandate_total !== undefined) {
    if (gratuity_mandate_total == null) {
      previewRate = 0;
    } else if (!(Number(gratuity_mandate_total) > 0)) {
      throw new ValidationError({ gratuity_mandate_total: 'Enter a required gratuity above $0, or clear it.' });
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
        previewRate = 0; // zero basis: preview no line (the PATCH rejects the save)
      }
    }
  }
```

and pass `gratuityRate: previewRate, tipJar: previewTipJar, gratuityFloorRate: previewFloorRate` into `calculateProposal`. Import `computeGratuityBasis` and `deriveGratuityRate` next to the existing `calculateProposal` import.

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/routes/proposals/metadata.calculate.test.js`
Expected: ALL pass.

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/routes/proposals/metadata.js server/routes/proposals/metadata.calculate.test.js
git commit -m "calculate: preview draft gratuity mandate (validation parity with PATCH)"
```

---

### Task 6: create-intent enforces the mandate floor

**Files:**
- Modify: `server/routes/stripeCreateIntent.js` (SELECT ~line 38, election block ~lines 90-104)
- Test: `server/routes/stripeCreateIntent.test.js`

**Interfaces:**
- Consumes: `deriveGratuityRate({ ..., floorRate })` (Task 2).
- Produces: an election below the mandate 400s with the "required gratuity" message before any Stripe call; at/above passes; the metadata-less path is unchanged and charges `total_price` (mandate-inclusive).

- [ ] **Step 1: Write failing tests**

Add to `stripeCreateIntent.test.js` in its existing style (seed proposal, hit the route with the file's stripe stub). Seed: unpaid proposal, `total_price 350` (250 service + 100 mandate), `gratuity_floor_rate 50`, snapshot gratuity `{staff_count:1, hours:2, rate:50, total:100, floor_rate:50}`:

```js
// 1. Below mandate: { payment_option:'full', tip_jar:true, gratuity_total:40 }
//    -> 400, message matches /required gratuity of at least \$100\.00/.
// 2. At mandate, no-jar: { payment_option:'full', tip_jar:false, gratuity_total:100 }
//    -> intent created, metadata gratuity_rate '50', amount 35000 cents.
// 3. Above: { payment_option:'full', tip_jar:true, gratuity_total:150 }
//    -> metadata rate '75', amount 40000 cents (250 + 150).
// 4. No election keys -> no gratuity metadata, amount 35000 cents
//    (total_price verbatim; the pre-existing metadata-less path).
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
      floorRate: Number(proposal.gratuity_floor_rate) > 0 ? Number(proposal.gratuity_floor_rate) : 0,
    });
```

Nothing else changes (`floor_rate` survives the snapshot recompute via the spread; metadata stamping already carries the derived rate).

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/routes/stripeCreateIntent.test.js`
Expected: ALL pass.

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/routes/stripeCreateIntent.js server/routes/stripeCreateIntent.test.js
git commit -m "create-intent: mandate floor on the gratuity election"
```

---

### Task 7: Webhook apply validates against the row floor

**Files:**
- Modify: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (~lines 194-258)
- Test: `server/routes/stripeWebhook.gratuityApply.test.js`

**Interfaces:**
- Consumes: row column `gratuity_floor_rate` (Task 1).
- Produces: pre-row `rateUsable` is shape-only; the jar/50-or-mandate floor check runs AFTER the FOR UPDATE row read (the floor lives on the row; the old inline pre-flight would reject the sub-$50 no-jar mandate case the amended CHECK exists to permit, dropping a legitimately charged gratuity post-capture). Failure emits `warnGratuityApplySkipped('below_floor', ...)`; payment recording untouched. Known and deliberate: some legacy failures change reason strings (`invalid_metadata` -> `below_floor`); tests pin the new strings; nothing in the repo filters on the old one.

- [ ] **Step 1: Write failing tests**

Add to `stripeWebhook.gratuityApply.test.js` in its existing harness style, asserting the skip REASON strings where the harness exposes them:

```js
// Seed A: payable proposal, gratuity_floor_rate 50, snapshot floor_rate 50.
// 1. Metadata { tip_jar:'true', gratuity_rate:'40' } -> payment recorded,
//    gratuity NOT applied, skip reason 'below_floor', row keeps rate 50 /
//    floor 50 / total_price unchanged.
// 2. Metadata { tip_jar:'false', gratuity_rate:'75' } -> applied: rate 75,
//    tip_jar false, snapshot floor_rate STILL 50, origin NULL.
// Seed B: payable proposal, NO mandate.
// 3. { tip_jar:'false', gratuity_rate:'30' } -> skipped with reason
//    'below_floor' (was 'invalid_metadata'; the legacy 50 rule moved
//    post-row -- pin the new string deliberately).
// Seed C: payable proposal, gratuity_floor_rate 30 (sub-50 mandate).
// 4. { tip_jar:'false', gratuity_rate:'30' } -> APPLIED (amended CHECK
//    permits it; mandate replaces the 50 rule).
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/routes/stripeWebhook.gratuityApply.test.js`
Expected: tests 1, 3 (reason string), and 4 FAIL.

- [ ] **Step 3: Implement**

At lines 200-204, reduce `rateUsable` to shape-only:

```js
            const rateUsable = Number.isFinite(electRate)
              && electRate >= 0
              && electRate <= GRATUITY_SANITY_MAX_RATE;
```

Add `gratuity_floor_rate` to the FOR UPDATE SELECT (line 213). After the degenerate-snapshot guard (line 229), before the SAVEPOINT, insert (re-indenting the existing SAVEPOINT block inside the new `else`):

```js
              } else {
                // Floor check needs the ROW (spec 2026-08-10): a mandate
                // (> 0) is the only floor when set; otherwise the legacy
                // no-jar 50 rule. Pre-flights the amended DB CHECK so a
                // failure is a breadcrumb, never an aborted payment tx.
                const floorVal = Number(gRow.rows[0].gratuity_floor_rate);
                const mandateRate = floorVal > 0 ? floorVal : null;
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

The UPDATE itself is unchanged: it never touches `gratuity_floor_rate`, and origin stays explicitly NULL.

- [ ] **Step 4: Run tests**

Run: `node --test -r dotenv/config server/routes/stripeWebhook.gratuityApply.test.js`
Expected: ALL pass, including every pre-existing case.

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js server/routes/stripeWebhook.gratuityApply.test.js
git commit -m "webhook: gratuity apply validates against the row mandate floor (post-row check)"
```

---

### Task 8: cancel-line-item clears the mandate

**Files:**
- Modify: `server/utils/lineItemCancel.js` (UPDATE ~line 586)
- Test: `server/utils/lineItemCancel.test.js`

**Interfaces:**
- Produces: lowering/removing a paid gratuity also sets `gratuity_floor_rate = NULL` on EVERY lowering, including above-floor targets (deliberate per spec section 6: the mandate is no longer the operative agreement, and a stale floor would trip the amended CHECK on a below-floor target). `lineItemCancel` already forces `tip_jar = true` below 50, so the clear cannot strand a CHECK violation. Origin-admin stamp unchanged.

REVERT COUPLING: this task rides with Task 3. Once mandates exist in the wild, reverting this task alone reintroduces a live CHECK violation (500) on the paid-gratuity lowering path. Never drop 8 without also dropping 3.

- [ ] **Step 1: Write failing test**

Add to `lineItemCancel.test.js` next to the existing gratuity-lowering cases: seed a paid proposal with `gratuity_rate 50, gratuity_floor_rate 50`, run the existing gratuity-lower path to rate 30, assert `gratuity_floor_rate IS NULL` after and the write succeeded (no CHECK violation). Add a second case lowering 50 -> 40 with floor 30 (above-floor target): floor STILL cleared.

- [ ] **Step 2: Run to verify failure**

Run: `node --test -r dotenv/config server/utils/lineItemCancel.test.js`
Expected: new tests FAIL (floor survives; the below-floor case may 500 against the amended CHECK, which is exactly the bug).

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

### Task 9: Mid-lane server review checkpoint

**Files:** none (review gate).

The server half is complete and every server suite is green. Per the execution-review cadence, dispatch the repo's `code-review` and `consistency-check` agents (`.claude/agents/`) on the lane's server diff (`git diff main...HEAD -- server/ scripts/`) BEFORE starting the client tasks, foreground. The iron rule applies: a failed, DOA, or verdict-less agent is a re-dispatch (once) and never a pass. Fix confirmed findings in place (new checkpoint commits) before proceeding; surface anything ambiguous to Dallas.

---

### Task 10: Proposal editor — mandate block (dirty-gated)

**Files:**
- Modify: `client/src/pages/admin/proposalEditor/formState.js` (~line 39)
- Modify: `client/src/pages/admin/proposalEditor/patchBody.js`
- Modify: `client/src/pages/admin/proposalEditor/ProposalEditorForm.js` (preview payload ~line 170, block at the comment ~line 634, `buildProposalPatchBody` call site ~line 303)
- Test: `client/src/pages/admin/proposalEditor/patchBody.test.js`

**Interfaces:**
- Consumes: proposal row fields `gratuity_floor_rate`, `client_signed_at`, `status`, `amount_paid` (the editor's `getOne` uses `SELECT p.*`, all present); snapshot `gratuity.{staff_count,hours,staff_noun}`; `/calculate` mandate param (Task 5); PATCH field (Task 3).
- Produces: form field `gratuity_mandate_total` (dollars or null) + a `mandateDirty` flag; `buildProposalPatchBody(form, { includeGratuityMandate })` emits the key ONLY when `includeGratuityMandate` is true. The form passes `mandateDirty && !mandateLocked` — dirty-gating is the fix for fleet blocker #3 (an always-sent display dollar would re-derive a stale rate on staffing edits and defeat the rate-constant rescale); the lock keeps unrelated edits on signed/paid proposals from tripping the server guard.

- [ ] **Step 1: Write failing tests**

Add to `patchBody.test.js`:

```js
// 1. buildProposalPatchBody({...form, gratuity_mandate_total: 100}, { includeGratuityMandate: true })
//    -> body.gratuity_mandate_total === 100
// 2. { includeGratuityMandate: true } with form value null -> key present, null
// 3. { includeGratuityMandate: false } -> key ABSENT (hasOwnProperty false)
// 4. Default opts (no includeGratuityMandate) -> key ABSENT (untouched forms
//    carry forward server-side; this is the rescale-preserving path)
// 5. Body still never contains tip_jar or gratuity_total keys.
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=patchBody`
Expected: FAIL.

- [ ] **Step 3: Implement**

`formState.js` (~line 39), seed alongside `adjustments`:

```js
    // Mandate dollars are DISPLAY-derived from the canonical rate at the
    // CURRENT staffing, so a rescaled mandate shows its rescaled dollars.
    // Presence is rate > 0 (never != null).
    gratuity_mandate_total: Number(p.gratuity_floor_rate) > 0
      ? Math.round(Number(p.gratuity_floor_rate)
          * (Number(p.pricing_snapshot?.gratuity?.staff_count) || 0)
          * (Number(p.pricing_snapshot?.gratuity?.hours) || 0) * 100) / 100
      : null,
```

`patchBody.js`: add `includeGratuityMandate = false` to the opts destructure; after the body literal:

```js
  // Admin gratuity mandate (spec 2026-08-10): the ONE gratuity key this form
  // may send, and ONLY when the admin touched the mandate this session and
  // the proposal is unsigned+unpaid (caller gates both). An untouched form
  // omits the key so the server rescales at the canonical rate.
  // tip_jar/gratuity_total stay banned (election-at-payment).
  if (includeGratuityMandate) {
    body.gratuity_mandate_total = form.gratuity_mandate_total == null
      ? null : Number(form.gratuity_mandate_total);
  }
```

`ProposalEditorForm.js`:

1. Near the other derived flags:

```js
  const mandateLocked = Number(proposal?.amount_paid || 0) > 0
    || proposal?.client_signed_at != null || proposal?.status === 'accepted';
  const [mandateDirty, setMandateDirty] = useState(false);
  const updateMandate = (v) => { update('gratuity_mandate_total', v); setMandateDirty(true); };
  const standardGratuityDollars = Math.round(
    50 * (Number(editPreview?.gratuity?.staff_count) || 0)
       * (Number(editPreview?.gratuity?.hours) || 0) * 100) / 100;
```

2. Preview payload (~line 170): add `...(mandateDirty && !mandateLocked ? { gratuity_mandate_total: editForm.gratuity_mandate_total } : {}),` and add `editForm.gratuity_mandate_total` and `mandateDirty` to the effect deps. (When not dirty, the stored-rate path already previews a stored mandate correctly, since stored rate = floor.)

3. The `buildProposalPatchBody` call site (~line 303) passes `includeGratuityMandate: mandateDirty && !mandateLocked`.

4. Replace the comment block at ~line 634 with the mandate UI (the Override-total block it mirrors sits directly BELOW, at ~639):

```jsx
        {/* Prepaid gratuity mandate (spec 2026-08-10): admin-required gratuity,
            floors the client's election at checkout. Locked once signed or paid
            (post-payment changes go through cancel-line-item). Renders on both
            editor mounts (proposal page + event page) intentionally. */}
        <div style={{ paddingTop: 12, borderTop: '1px solid var(--line-1)', marginBottom: 12 }}>
          <label className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: mandateLocked ? 'default' : 'pointer' }}>
            <input type="checkbox"
              checked={editForm.gratuity_mandate_total != null}
              disabled={mandateLocked || (!editForm.gratuity_mandate_total && !(standardGratuityDollars > 0))}
              onChange={e => updateMandate(e.target.checked ? standardGratuityDollars : null)} />
            Require prepaid gratuity
          </label>
          {!(standardGratuityDollars > 0) && editForm.gratuity_mandate_total == null && !mandateLocked && (
            <span className="tiny muted">Set staffing and duration first</span>
          )}
          {editForm.gratuity_mandate_total != null && (
            <div className="hstack" style={{ gap: 8, marginTop: 6 }}>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', fontSize: 12, pointerEvents: 'none' }}>$</span>
                <input className="input" type="number" min="0" step="0.01"
                  value={editForm.gratuity_mandate_total}
                  disabled={mandateLocked}
                  onChange={e => updateMandate(e.target.value !== '' ? Number(e.target.value) : null)}
                  style={{ width: 140, paddingLeft: 18 }} />
              </div>
              <button type="button" className="btn btn-ghost btn-sm" disabled={mandateLocked}
                onClick={() => updateMandate(standardGratuityDollars)}>
                Standard ($50/{editPreview?.gratuity?.staff_noun || 'bartender'}/hr = ${standardGratuityDollars.toFixed(2)})
              </button>
              <span className="tiny muted">Client can give more at checkout, never less</span>
            </div>
          )}
        </div>
```

- [ ] **Step 4: Run tests + build gate**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=patchBody`
Expected: PASS.
Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with no new warnings. (`ProposalEditorForm.js` is in the 700-1000 warn zone and grows; the pre-commit hook will WARN, which is acceptable, but confirm it stays under 1000: `wc -l client/src/pages/admin/proposalEditor/ProposalEditorForm.js`.)

- [ ] **Step 5: Manual verification (dev editor walk)**

With the dev servers running, open a scratch unpaid proposal in the admin editor: tick "Require prepaid gratuity" (fills the standard dollars), watch the Live preview grow by the mandate, Save, reload, confirm the block re-seeds with the saved dollars. Change duration WITHOUT touching the mandate, Save, reload: dollars rescaled at constant rate. Open a paid proposal: block disabled.

- [ ] **Step 6: Checkpoint commit**

```bash
git add client/src/pages/admin/proposalEditor/formState.js client/src/pages/admin/proposalEditor/patchBody.js client/src/pages/admin/proposalEditor/patchBody.test.js client/src/pages/admin/proposalEditor/ProposalEditorForm.js
git commit -m "editor: prepaid gratuity mandate block (dirty-gated, signed/paid locked)"
```

---

### Task 11: Checkout — mandate floor + copy + in-lane walk

**Files:**
- Modify: `client/src/pages/proposal/proposalView/gratuityFloor.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js` (~lines 55-75, handleSign guard ~line 329, SignAndPaySection props ~line 546)
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js` (~lines 73-330)
- Test: `client/src/pages/proposal/proposalView/gratuityFloor.test.js`

**Interfaces:**
- Consumes: snapshot `gratuity.floor_rate` (served inside `pricing_snapshot` by the existing public GET; no API change).
- Produces: `isGratuityBelowFloor({ ..., mandated })` bypasses the jar short-circuit when mandated (fleet blocker: jar-yes is the mandate's default branch and today's guard is unreachable there); `gratuityFloorMessage(floorText, staffNoun, mandated)` mandate variant; `gratuityFloorDollars({ mandateRate, staffCount, hours })` tested helper; `SignAndPaySection` prop `gratuityMandated`. BOTH warning callers pass the flag: the inline warning AND the `handleSign` guard at `ProposalView.js:329`. (`SignAndPaySection.js:375` is a hardcoded generic string, "Add the required gratuity above to continue to payment." — it reads correctly for mandates and stays as is.)

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
// 6. gratuityFloorDollars({mandateRate:50, staffCount:1, hours:2}) === 100
// 7. gratuityFloorDollars({mandateRate:0, staffCount:1, hours:2}) === 100
//    (falls back to the 50-rule dollars for the no-jar case)
// 8. gratuityFloorDollars({mandateRate:33.3333, staffCount:1, hours:7}) === 233.33
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=gratuityFloor`
Expected: FAIL.

- [ ] **Step 3: Implement**

`gratuityFloor.js`:

```js
export function isGratuityBelowFloor({ gratuityEnabled, tipJar, gratuityTotal, gratuityFloor, mandated = false }) {
  if (!gratuityEnabled) return false;
  if (!mandated && tipJar) return false; // a mandate floors BOTH jar answers
  return (Number(gratuityTotal) || 0) < gratuityFloor;
}

export function gratuityFloorMessage(floorText, staffNoun, mandated = false) {
  return mandated
    ? `This event includes a required gratuity of at least ${floorText} for your ${staffNoun}s.`
    : `Without a tip jar, gratuity must be at least ${floorText} so your ${staffNoun}s are covered.`;
}

// Floor dollars for the Sign & Pay card. mandateRate > 0 = admin mandate
// (spec 2026-08-10), which REPLACES the 50 rule; otherwise the no-jar
// $50/staff/hr dollars. The literal 50 mirrors server GRATUITY_FLOOR_RATE.
export function gratuityFloorDollars({ mandateRate, staffCount, hours }) {
  const r = Number(mandateRate) || 0;
  const sc = Number(staffCount) || 0;
  const h = Number(hours) || 0;
  if (r > 0) return Math.round(r * sc * h * 100) / 100;
  return Math.round(50 * sc * h);
}
```

`ProposalView.js` (~lines 65-74):

```js
  const gratuityMandateRate = Number(gratuityBasis?.floor_rate) || 0;
  const gratuityMandated = gratuityMandateRate > 0;
  const gratuityFloor = gratuityFloorDollars({
    mandateRate: gratuityMandateRate, staffCount: gratuityStaffCount, hours: gratuityHours,
  });
  const gratuityBelowFloor = isGratuityBelowFloor({
    gratuityEnabled, tipJar, gratuityTotal, gratuityFloor, mandated: gratuityMandated,
  });
```

Update the `handleSign` guard (~line 329) to `gratuityFloorMessage(fmt(gratuityFloor), gratuityStaffNoun, gratuityMandated)`, and pass `gratuityMandated={gratuityMandated}` to `SignAndPaySection` (~line 546).

`SignAndPaySection.js`: accept `gratuityMandated = false`; four mandate-gated changes (legacy render byte-identical when false):

1. Intro (~lines 258-262): when mandated, replace the "either guests tip at the bar, or the gratuity is prepaid" sentence with `A prepaid gratuity of {fmt(gratuityFloor)} is included for your {gratuityStaffNoun}s.` The "None of it is kept by Dr. Bartender." sentence stays.
2. No-jar tablet description (~lines 294-296): when mandated, replace the "$50 per {noun} per hour is added" sentence with `No jar at the bar. Your prepaid gratuity covers your {gratuityStaffNoun}s.`
3. Amount heading (~line 303): when mandated, always `Gratuity for your {gratuityStaffNoun}s`. Hide the preset chips row: `{tipJar && !gratuityMandated && (...)}` (both presets sit below the floor).
4. Input (~line 323): `min={gratuityMandated ? gratuityFloor : (tipJar ? 0 : gratuityFloor)}`. The inline warning (~line 329) passes `gratuityMandated` to `gratuityFloorMessage`.

No em dashes in any of this copy. The jar radio itself is untouched: it still records the answer, and under a mandate both answers show the same floor.

- [ ] **Step 4: Run tests + build gate**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=gratuityFloor`
Expected: PASS.
Run: `cd client && CI=true npx react-scripts build`
Expected: clean.

- [ ] **Step 5: In-lane browser walk (before merge, not post-push)**

Seed a mandated scratch proposal in the dev DB (or use the Task 10 walk's proposal). With dev servers running, open `/proposal/<token>`:
- Quote shows the Gratuity line and mandate-inclusive total.
- Chooser: stated copy ("A prepaid gratuity of $X is included..."), no preset chips, input min = mandate dollars.
- Clear the amount box: inline required-gratuity warning appears, Sign & Pay blocked (jar-YES branch, the previously dead path).
- Flip to "No jar": floor unchanged (no $50 stacking), copy reads "Your prepaid gratuity covers your bartenders."
- Enter more than the floor: allowed, total updates.
Screenshot the chooser to the scratchpad for the record.

- [ ] **Step 6: Checkpoint commit**

```bash
git add client/src/pages/proposal/proposalView/gratuityFloor.js client/src/pages/proposal/proposalView/gratuityFloor.test.js client/src/pages/proposal/proposalView/ProposalView.js client/src/pages/proposal/proposalView/SignAndPaySection.js
git commit -m "checkout: mandate floors both jar answers + stated-not-invited copy"
```

---

### Task 12: Docs

**Files:**
- Modify: `.claude/CLAUDE.md` (Checkout gratuity invariant bullet; note the path — there is NO root CLAUDE.md)
- Modify: `ARCHITECTURE.md` (proposals schema; CHECK quote ~line 931; editor/calculate claims ~line 1595; snapshot gratuity key list ~line 930)
- Modify: `README.md` (Key Features)

- [ ] **Step 1: Amend the CLAUDE.md invariant (all four falsified clauses)**

In the **Checkout gratuity** bullet of `.claude/CLAUDE.md`:

1. Replace `Unpaid proposals never carry a gratuity, and the admin PATCH never accepts tip_jar/gratuity_total (admin removal goes through cancel-line-item only).` with:
`Unpaid proposals never carry a client-elected gratuity; the ONLY pre-payment gratuity is an admin mandate (gratuity_floor_rate > 0, spec 2026-08-10), which floors the client's election on BOTH jar answers (replacing, never stacking on, the $50 no-jar floor) and rides the same rate machinery, with every persisting snapshot writer carrying gratuity.floor_rate. The admin PATCH accepts exactly one gratuity field, gratuity_mandate_total (dollars > 0; null clears only a real mandate and forces the jar on; absent carries forward; rejected once signed or paid), and still never accepts tip_jar/gratuity_total (admin removal goes through cancel-line-item only, which also clears the mandate).`
2. In `The election persists ONLY at payment: ...` prepend `Aside from an admin mandate, ` (lowercasing "the").
3. In `The no-jar floor (rate ≥ 50) is enforced at the route ... and by a DB CHECK.` append `; an admin mandate replaces that floor on both jar answers (the CHECK's third disjunct).`
4. In `Payments that carry no metadata — ... — never touch the gratuity, so a link-paid proposal cannot collect a prepaid gratuity.` replace the consequence clause with `so no payment path can ALTER the gratuity fields; a mandated gratuity rides inside total_price and is collected by any payment.`

- [ ] **Step 2: ARCHITECTURE.md + README.md**

- Proposals schema section: add `gratuity_floor_rate NUMERIC(10,4)` with one line (admin gratuity mandate, > 0 = mandated, checkout election floor, third disjunct of `proposals_gratuity_jar_check`).
- ~Line 930: add `floor_rate` to the snapshot gratuity key list.
- ~Line 931: update the verbatim CHECK quote to the three-disjunct form; soften "admin's only path to change the gratuity is cancel-line-item" to name the mandate field.
- ~Line 1595: update "the admin proposal editor and PATCH /:id have NO gratuity write path" and "`POST /calculate` previews the STORED rate only" to name `gratuity_mandate_total`.
- README Key Features: one line for the admin gratuity mandate.

- [ ] **Step 3: Commit**

```bash
git add .claude/CLAUDE.md ARCHITECTURE.md README.md
git commit -m "docs: admin gratuity mandate invariants + schema notes"
```

---

## Full-suite verification (lane exit gate)

Before the merge request, run every suite the change reaches, one at a time from repo root:

```bash
node --test server/utils/pricingEngine.test.js
node --test -r dotenv/config server/routes/proposals/crud.test.js
node --test -r dotenv/config server/routes/proposals/crud.demotion.test.js
node --test -r dotenv/config server/routes/proposals/metadata.calculate.test.js
node --test -r dotenv/config server/routes/proposals/cancelLineItem.test.js
node --test -r dotenv/config server/routes/stripeCreateIntent.test.js
node --test -r dotenv/config server/routes/stripeWebhook.gratuityApply.test.js
node --test -r dotenv/config server/utils/lineItemCancel.test.js
node --test -r dotenv/config server/utils/proposalExtrasFold.stability.test.js
node --test -r dotenv/config server/utils/proposalExtrasFold.legs.test.js
node --test -r dotenv/config server/utils/invoiceHelpers.gratuity.test.js
node --test -r dotenv/config server/utils/changeRequests.gratuity.test.js
node --test -r dotenv/config server/routes/admin/payroll.test.js
cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern="gratuityFloor|patchBody" && CI=true npx react-scripts build
```

The consumer suites (`crud.demotion`, `cancelLineItem`, `invoiceHelpers.gratuity`, `changeRequests.gratuity`, `payroll`, `proposalExtrasFold.legs`) reach the changed code and must stay green untouched (run-suites-a-change-reaches rule).

## Rollout order (push time, not lane time)

1. Run the Task 1 DDL block on PROD (Neon `round-tooth-34649976` default branch) and verify the amended constraint definition (`pg_get_constraintdef` contains `gratuity_floor_rate`).
2. Merge the lane (full review fleet), then push per the standard push model (fleet + `/second-opinion` on these sensitive commits).
3. Post-deploy walk: set a $100 mandate on a scratch proposal, view the public page (line + total), verify checkout shows the stated copy and refuses a below-floor election on the jar-yes branch, flip the radio (floor unchanged), then clear the mandate. Then set the real mandate on Lauren Karcz's proposal 719 (unpaid, unsigned, 1 bartender x 2h: the $100 standard fill).
