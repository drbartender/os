# Pay-Now Extras Non-Flat Add-On Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price non-`{per_guest,flat}` drink-plan add-ons (parking, garnish, mocktail) at their real, scaled rate in the pay-now extras flow so the Stripe charge, the "Drink Plan Extras" invoice, and the `total_price` fold all agree — eliminating the comp `total_price` residual and the silent under-charge.

**Architecture:** Reuse `calculateProposal` (the money source-of-truth) via a with-vs-without add-on delta, run ONLY when a new non-flat add-on is present and the proposal has a valid package/guest/duration; everything else (syrup, per_guest, flat, bar) keeps its existing math. The delta operates on the coverage/trigger-filtered add-on set captured pre-UPSERT. Callers (create-intent, submit) resolve the context; the invoice itemizer preserves `source_type:'addon'` so comp keeps working. Backward-compatible task ordering: the helper and the invoice itemizer fall back to today's flat math when the new context is absent, so each task leaves a working checkpoint.

**Tech Stack:** Node 18 / Express 4, React 18 (CRA), Neon PostgreSQL via `pg` raw SQL (no ORM), Stripe via `server/utils/stripeClient.js`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-01-paynow-extras-addon-pricing-design.md` (authoritative; read it first).

## Global Constraints

- Money is integer cents in invoice tables (`invoices`, `invoice_line_items`, `invoice_payments`, `proposal_payments`); `proposals.total_price` is `NUMERIC(10,2)` DOLLARS. `calculateProposal` returns dollars; convert to cents with `Math.round(x * 100)`.
- All SQL parameterized (`$1,$2`). Never concatenate values.
- Stripe only via `server/utils/stripeClient.js` (`getStripe()`); never `require('stripe')`.
- Public token routes keep `requireUuidToken(...)` + their rate limiter. Never drop a guard.
- Client-visible errors throw `AppError` subclasses from `server/utils/errors.js`, wrapped by `asyncHandler`.
- No em dashes in client-facing copy or comment prose.
- The hosted-package bartender rule (1:100 ratio) is load-bearing. This plan does NOT re-implement it — it delegates all add-on pricing to `calculateProposal` and touches only the `additional-bartender` ADD-ON path (inside `addons`), never the `num_bartenders` override.
- Money invariant to hold at the end: create-intent charge cents == submit invoice `amount_due` == the add-on portion of the `total_price` fold, for the reachable set (parking `per_staff`, garnish `per_100_guests`, mocktail `per_guest_timed`, champagne `per_guest`, bar rental).
- Server tests run one suite at a time: `node -r dotenv/config --test <file>`. Client verify: `cd client && CI=true npx react-scripts build`.
- File-size hard cap 1000 lines; `invoiceHelpers.js` is ~960 — keep additions minimal (a split is tracked tech-debt, out of scope here).

## Lane Map

```
lane: paynow-extras-realrate
  footprint:
    - server/utils/drinkPlanExtras.js
    - server/utils/drinkPlanExtras.test.js
    - server/utils/invoiceHelpers.js
    - server/routes/stripe.js
    - server/routes/drinkPlans/submit.js
    - server/routes/drinkPlans/submitExtras.test.js
    - server/routes/invoices.extrasVoid.test.js
    - server/routes/stripeWebhook.extrasLink.test.js
    - client/src/pages/plan/steps/LogisticsStep.js
  depends_on: []
  review_fleet: full          # stripe + invoices + charge money seam
  checkpoints: { T1: [code-review], T4: [database-review, code-review, security-review] }
```

Run order: T1 -> T2 -> T3 -> T4 -> T5 -> T6, sequential.

---

## Task 1: `computeExtrasBreakdown` engine-delta core (guarded, backward-compatible)

**Files:** Modify `server/utils/drinkPlanExtras.js`; Test `server/utils/drinkPlanExtras.test.js`.

**Interfaces:**
- Produces `computeExtrasBreakdown({ selections, guestCount, pricingSnapshot, numBars, pkg, durationHours, numBartenders, existingAddons, newAddons }, dbClient)` → `{ totalCents, addonDeltaCents, barRentalCents, syrupCents, addonLineItems }`.
  - `pkg`: full `service_packages` row or null. `existingAddons`: array of the proposal's current `proposal_addons`-shaped rows (pre-UPSERT). `newAddons`: array of resolved, coverage/trigger-FILTERED `service_addons` rows the drink plan is adding (each `{ id, slug, name, rate, billing_type, extra_hour_rate, minimum_hours, quantity }`).
  - `addonLineItems`: array of `{ description, quantity, unit_price, line_total, source_type:'addon', source_id }` (cents), one per `newAddons` entry, priced at real rate.
- When `newAddons` is empty, OR every `newAddon.billing_type ∈ {'per_guest','flat'}`, OR `pkg`/`guestCount`/`durationHours` is missing/0 → the add-on portion uses the EXISTING flat/per_guest math (no `calculateProposal` call) and `addonLineItems` uses the existing flat line shape. This preserves the syrup-only fast path and package-less proposals (no throw).

- [ ] **Step 1: Write the failing unit test** — assert the delta against a direct `calculateProposal`, and assert the flat/guard fallbacks.

```js
// server/utils/drinkPlanExtras.test.js — add these (calculateProposal is pure, no DB)
const { calculateProposal } = require('./pricingEngine');

// Minimal per_guest hosted package so calculateProposal runs without throwing.
const PKG = { id: 1, name: 'Test', pricing_type: 'flat', bar_type: 'full',
  base_cost: 500, min_total: 0, guests_per_bartender: 100, extra_bartender_hourly: 40 };
const ctx = { pkg: PKG, guestCount: 200, durationHours: 4, numBartenders: null, numBars: 0,
  pricingSnapshot: {}, selections: {} };

function addonDelta(existing, next) {
  const a = calculateProposal({ pkg: PKG, guestCount: 200, durationHours: 4, numBars: 0, addons: next })
    .addons.reduce((s, x) => s + x.line_total, 0);
  const b = calculateProposal({ pkg: PKG, guestCount: 200, durationHours: 4, numBars: 0, addons: existing })
    .addons.reduce((s, x) => s + x.line_total, 0);
  return a - b;
}

test('computeExtrasBreakdown: per_staff parking priced via engine delta (real rate)', async () => {
  const parking = { id: 9, slug: 'parking-fee', name: 'Parking Fee', rate: 20, billing_type: 'per_staff' };
  const expected = Math.round(addonDelta([], [parking]) * 100);
  const bd = await computeExtrasBreakdown(
    { ...ctx, existingAddons: [], newAddons: [parking],
      selections: { addOns: { 'parking-fee': { enabled: true } } } }, pool);
  assert.equal(bd.addonDeltaCents, expected);
  assert.equal(bd.totalCents, expected);
  assert.equal(bd.addonLineItems.length, 1);
  assert.equal(bd.addonLineItems[0].source_type, 'addon');       // comp depends on this
  assert.equal(bd.addonLineItems[0].line_total, expected);
});

test('computeExtrasBreakdown: no engine call for flat/per_guest add-ons (existing math)', async () => {
  const champagne = { id: 3, slug: 'champagne-toast', name: 'Champagne', rate: 5, billing_type: 'per_guest' };
  const bd = await computeExtrasBreakdown(
    { ...ctx, existingAddons: [], newAddons: [champagne],
      selections: { addOns: { 'champagne-toast': { enabled: true } } } }, pool);
  assert.equal(bd.addonDeltaCents, 5 * 200 * 100); // per_guest flat-path unchanged
});

test('computeExtrasBreakdown: non-flat add-on but null pkg falls back to flat (no throw)', async () => {
  const parking = { id: 9, slug: 'parking-fee', name: 'Parking Fee', rate: 20, billing_type: 'per_staff' };
  const bd = await computeExtrasBreakdown(
    { ...ctx, pkg: null, existingAddons: [], newAddons: [parking],
      selections: { addOns: { 'parking-fee': { enabled: true } } } }, pool);
  assert.equal(bd.addonDeltaCents, 20 * 100); // flat fallback, no engine, no throw
});
```

- [ ] **Step 2: Run to verify it fails** — `node -r dotenv/config --test server/utils/drinkPlanExtras.test.js` → FAIL (new signature/fields not present).

- [ ] **Step 3: Implement.** Rewrite the add-on portion of `computeExtrasBreakdown`. Keep the bar-rental and syrup blocks exactly as today (they already price correctly). Replace the add-on loop with:

```js
const { calculateProposal } = require('./pricingEngine');
// ... inside computeExtrasBreakdown, args now include pkg, durationHours, numBartenders, existingAddons, newAddons
const FLATTABLE = new Set(['per_guest', 'flat']);
const newAddons = args.newAddons || [];
const hasNonFlat = newAddons.some((a) => !FLATTABLE.has(a.billing_type));
const canEngine = hasNonFlat && args.pkg && (args.guestCount > 0) && (args.durationHours > 0);

let addonDollars = 0;
let addonLineItems = [];
if (canEngine) {
  const base = { pkg: args.pkg, guestCount: args.guestCount, durationHours: args.durationHours,
    numBars: args.numBars, numBartenders: args.numBartenders };
  const existing = args.existingAddons || [];
  const withNew = [...existing, ...newAddons];
  const sum = (rows) => calculateProposal({ ...base, addons: rows })
    .addons.reduce((s, x) => s + x.line_total, 0);
  addonDollars = sum(withNew) - sum(existing);
  // Itemize the NEW add-ons from the engine's own line results (real rate),
  // preserving source_type:'addon' so voidExtrasInvoiceWithReconcile can detect them.
  const newSlugs = new Set(newAddons.map((a) => a.slug));
  addonLineItems = calculateProposal({ ...base, addons: withNew }).addons
    .filter((r) => newSlugs.has(r.slug))
    .map((r) => ({ description: r.name, quantity: r.quantity || 1,
      unit_price: Math.round((r.line_total / (r.quantity || 1)) * 100),
      line_total: Math.round(r.line_total * 100), source_type: 'addon', source_id: r.id }));
} else {
  // Existing flat/per_guest math (byte-identical to today), over newAddons.
  for (const addon of newAddons) {
    const rate = Number(addon.rate);
    const lineDollars = addon.billing_type === 'per_guest' ? rate * (args.guestCount || 1) : rate;
    addonDollars += lineDollars;
    addonLineItems.push({ description: addon.name,
      quantity: addon.billing_type === 'per_guest' ? (args.guestCount || 1) : 1,
      unit_price: Math.round(rate * 100), line_total: Math.round(lineDollars * 100),
      source_type: 'addon', source_id: addon.id });
  }
}
const addonDeltaCents = Math.round(addonDollars * 100);
// barRentalCost (dollars) + syrupCost.total (dollars) come from the unchanged
// bar/syrup blocks; barRentalCents/syrupCents are their rounded cents.
const totalCents = Math.round((addonDollars + barRentalCost + syrupCost.total) * 100);
return { totalCents, addonDeltaCents, barRentalCents, syrupCents, addonLineItems };
```

NOTE: `newAddons` is now supplied by the caller (resolved + filtered), so `computeExtrasBreakdown` no longer does its own `service_addons` `SELECT`. `dbClient` is retained in the signature for compatibility but unused by the add-on path (bar/syrup need no DB). The old `addonCents` field is renamed `addonDeltaCents`.

- [ ] **Step 4: Run to verify it passes** → PASS (all three tests).
- [ ] **Step 5: Commit** — `git add server/utils/drinkPlanExtras.js server/utils/drinkPlanExtras.test.js && git commit -m "feat(potion): computeExtrasBreakdown prices non-flat add-ons via calculateProposal delta (guarded, itemized, source_type:'addon')"`

---

## Task 2: real-rate invoice itemization + graceful fallback

**Files:** Modify `server/utils/invoiceHelpers.js`; Test `server/routes/drinkPlans/submitExtras.test.js` (extend).

**Interfaces:**
- `writeExtrasLineItems(invoiceId, { selections, guestCount, pricingSnapshot, numBars, totalCents, addonLineItems }, dbClient)` — when `addonLineItems` is a non-null array, emit those add-on lines verbatim (they already carry `source_type:'addon'` + real-rate `line_total`) instead of re-pricing add-ons flat; still append the bar + syrup lines and run the drift-reconcile. When `addonLineItems` is absent (webhook/backfill post-commit callers), keep the CURRENT flat add-on itemization unchanged.
- `createDrinkPlanExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents, lineItemState })` and `findOrRefreshExtrasInvoice({ ..., breakdown })` thread `breakdown.addonLineItems` into `writeExtrasLineItems` via `lineItemState.addonLineItems`.

- [ ] **Step 1: Failing test** — a submit-created invoice keeps the real-rate add-on line with `source_type:'addon'`; a webhook/backfill create (no addonLineItems) still writes lines that sum to `amount_due`.

```js
// server/routes/drinkPlans/submitExtras.test.js — add (uses the existing inline harness)
test('writeExtrasLineItems: real-rate add-on line kept with source_type addon', async () => {
  const { pool } = require('../../db');
  const { createInvoice, writeExtrasLineItems } = require('../../utils/invoiceHelpers');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const inv = await createInvoice({ proposalId, label: 'Drink Plan Extras',
      amountDueCents: 6000, status: 'sent', dueDate: null }, c);
    await writeExtrasLineItems(inv.id, { selections: {}, guestCount: 200, pricingSnapshot: {},
      numBars: 0, totalCents: 6000,
      addonLineItems: [{ description: 'Parking Fee', quantity: 3, unit_price: 2000,
        line_total: 6000, source_type: 'addon', source_id: 9 }] }, c);
    const rows = (await c.query(
      'SELECT source_type, line_total FROM invoice_line_items WHERE invoice_id=$1', [inv.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_type, 'addon');
    assert.equal(Number(rows[0].line_total), 6000);
    await c.query('ROLLBACK');
  } finally { c.release(); }
});
```

- [ ] **Step 2: Run → FAIL** (writeExtrasLineItems ignores `addonLineItems` today).
- [ ] **Step 3: Implement** — at the top of `writeExtrasLineItems`, branch the add-on section:

```js
const items = [];
if (Array.isArray(addonLineItems)) {
  items.push(...addonLineItems);   // real-rate, source_type:'addon' preserved
} else {
  // ... existing flat add-on loop (service_addons lookup) unchanged ...
}
// ... existing bar-rental + syrup blocks + drift-reconcile unchanged ...
```

In `createDrinkPlanExtrasInvoice`, extend `lineItemState` to carry `addonLineItems` and pass it through. In `findOrRefreshExtrasInvoice`, pass `lineItemState: { ...pre-mutation state..., addonLineItems: breakdown.addonLineItems }` on BOTH the refresh (`writeExtrasLineItems`) and the create branch.

- [ ] **Step 4: Run → PASS.** Also run the existing `submitExtras.test.js` + `stripeWebhook.extrasLink.test.js` (webhook fallback path, no addonLineItems) → PASS (flat fallback intact).
- [ ] **Step 5: Commit** — `git commit -m "feat(potion): writeExtrasLineItems emits real-rate add-on lines when supplied, flat fallback for webhook/backfill"`

---

## Task 3: create-intent supplies full context + the coverage/trigger filter

**Files:** Modify `server/routes/stripe.js` (create-drink-plan-intent handler); Test `server/routes/stripeWebhook.extrasLink.test.js` or a new `server/routes/stripe.createIntent.test.js` (hand-rolled harness).

**Interfaces:** Consumes `computeExtrasBreakdown` (Task 1). create-intent must resolve `pkg` (`SELECT * FROM service_packages WHERE id = p.package_id`), `event_duration_hours`, `num_bartenders`, and the existing `proposal_addons` (join), and resolve+FILTER the new add-on slugs the same way submit does (drop package-covered `covered_addon_slugs`, drop autoAdded slugs lacking a still-selected triggering cocktail — mirror `submit.js:228-258`).

- [ ] **Step 1: Failing test** — create-intent for a `parking-fee` selection returns `extrasAmount` = the real `totalStaff * $20`, not flat `$20`, for a multi-staff proposal.
- [ ] **Step 2: Run → FAIL** (flat `$20` today).
- [ ] **Step 3: Implement** — expand the create-intent `SELECT` to add `p.event_duration_hours, p.num_bartenders, p.package_id`; add `const pkg = (await pool.query('SELECT * FROM service_packages WHERE id=$1',[data.package_id])).rows[0]`; add `const existingAddons = (await pool.query('SELECT sa.* FROM proposal_addons pa JOIN service_addons sa ON sa.id=pa.addon_id WHERE pa.proposal_id=$1',[data.proposal_id])).rows`; resolve+filter the enabled `selections.addOns` slugs into `newAddons` (reuse the exact filter from `submit.js`, extracted to a shared helper `resolveDrinkPlanAddons(selections, pkg, dbClient)` in `server/utils/drinkPlanExtras.js` so create-intent and submit share ONE filter and cannot drift). Call `computeExtrasBreakdown({ selections, guestCount: data.guest_count, pricingSnapshot: data.pricing_snapshot, numBars: data.num_bars, pkg, durationHours: Number(data.event_duration_hours), numBartenders: data.num_bartenders, existingAddons, newAddons }, pool)`. Keep `extrasAmount = bd.totalCents / 100; extrasCents = bd.totalCents;` as today.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(potion): create-intent resolves full pricing context + shared add-on filter for the extras delta"`

---

## Task 4: submit captures pre-UPSERT state + threads context (charge == invoice == fold)

**Files:** Modify `server/routes/drinkPlans/submit.js`; Test `server/routes/drinkPlans/submitExtras.test.js` (add a parking integration case).

**Interfaces:** Consumes Task 1 + Task 3's `resolveDrinkPlanAddons`. The transaction path must capture `existingAddonsAtIntent` (the proposal's `proposal_addons` BEFORE the UPSERT at `submit.js:~213`), alongside the existing `numBarsAtIntent`, and pass both into `computeExtrasBreakdown`/`findOrRefreshExtrasInvoice`. The syrup-only fast path passes `newAddons: []` → the guard skips the engine (no throw, no context needed).

- [ ] **Step 1: Failing integration test** — a `parking-fee` pay-now submit (proposal with ≥2 staff) creates an extras invoice at `totalStaff * $20`, `amount_due` equals the create-intent charge for the same selections, and it is NOT $0 (proves pre-UPSERT capture).
- [ ] **Step 2: Run → FAIL** (today: flat $20, or $0 if computed post-UPSERT).
- [ ] **Step 3: Implement** — capture `const existingAddonsAtIntent = (await client.query('SELECT sa.* FROM proposal_addons pa JOIN service_addons sa ON sa.id=pa.addon_id WHERE pa.proposal_id=$1',[proposal.id])).rows;` immediately after the `FOR UPDATE` lock and BEFORE the addon UPSERT. Build `newAddons` via the shared `resolveDrinkPlanAddons`. In the `paidSeparately` branch, call `computeExtrasBreakdown({ selections, guestCount: proposal.guest_count, pricingSnapshot: proposal.pricing_snapshot, numBars: numBarsAtIntent, pkg, durationHours: Number(proposal.event_duration_hours), numBartenders: proposal.num_bartenders, existingAddons: existingAddonsAtIntent, newAddons }, client)` and pass `breakdown` (incl. `addonLineItems`) to `findOrRefreshExtrasInvoice`. The fast path passes `newAddons: []`.
- [ ] **Step 4: Run → PASS.** Also run `submitExtras.test.js` (syrup-only still green, no engine).
- [ ] **Step 5: Commit** — `git commit -m "feat(potion): submit prices extras add-ons at real rate via pre-UPSERT engine delta"`

---

## Task 5: comp regression — real-rate add-on invoice fully restores total_price

**Files:** Test `server/routes/invoices.extrasVoid.test.js` (add a case). No production code change (comp already reverses the full invoice when a `source_type:'addon'` line exists).

- [ ] **Step 1: Add a test** — seed a `Drink Plan Extras` invoice with a `per_staff`-style add-on line (`source_type:'addon'`, `line_total` = 6000) and a proposal `total_price` that includes it; PATCH `{status:'void'}`; assert `total_price` reduced by the full `$60` (add-on portion) and the invoice voided.

```js
test('comp per_staff add-on extras: total_price fully restored (no residual)', async () => {
  const p = await seedProposal({ totalPrice: 1060 });
  const inv = await seedExtrasInvoice(p, { amountDue: 6000, lines: [
    { description: 'Parking Fee', line_total: 6000, source_type: 'addon', source_id: 9 },
  ] });
  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(await totalPriceOf(p), 1000); // full $60 add-on removed
});
```

- [ ] **Step 2: Run → PASS** (comp already handles `source_type:'addon'`; this locks in that the new itemizer keeps it).
- [ ] **Step 3: Commit** — `git commit -m "test(potion): comp of a real-rate per_staff extras invoice restores total_price with no residual"`

---

## Task 6: client parity — LogisticsStep parking preview uses totalStaff

**Files:** Modify `client/src/pages/plan/steps/LogisticsStep.js:41`.

- [ ] **Step 1: Implement** — change the parking preview from `rate * (numBartenders || 1)` to `rate * totalStaff`, where `totalStaff` = bartenders + `additional-bartender` add-on qty + barbacks/servers, matching `pricingEngine.js:311`. Source the staff count from the same proposal/pricing-snapshot data the step already has (`snapshot.staffing.actual` + selected staffing add-ons); if unavailable client-side, show a "priced per staff member at booking" note rather than a wrong number.
- [ ] **Step 2: Verify build** — `cd client && CI=true npx react-scripts build` → PASS.
- [ ] **Step 3: Manual check** — the parking line preview matches the server charge for a multi-staff event.
- [ ] **Step 4: Commit** — `git commit -m "fix(potion): LogisticsStep parking preview scales on totalStaff to match the server charge"`

---

## Notes for the executor

- **Shared filter (`resolveDrinkPlanAddons`)** is the load-bearing dedup: create-intent (Task 3) and submit (Task 4) MUST use the same function so the charge and the fold operate on the same add-on set. Extract it once; do not copy the filter logic.
- **Deploy window:** an in-flight PaymentIntent created pre-deploy carries the old flat `extras_amount_cents`; if confirmed post-deploy the webhook settles the invoice at the flat amount. Accept the small mid-checkout window or deploy off-peak (spec Backwards-compat).
- **Reachable set only:** staffing add-ons (`additional-bartender`/`barback`/`banquet-server`) are not drink-plan-selectable, so no `additional-bartender` gratuity residual arises in practice; do not add complexity for it.
- **Review:** T4 touches the sensitive charge/invoice/webhook seam → full fleet (code + database + security) before merge, per the lane map.

## Review corrections applied (from the spec-review fleet)

1. Engine call GUARDED to non-flat add-ons + valid pkg/guest/duration (no `calculateProposal` throw on the syrup-only fast path or package-less proposals).
2. Delta over the coverage/trigger-FILTERED set, captured PRE-UPSERT (a post-UPSERT read collapses the delta to $0).
3. `writeExtrasLineItems` keeps the flat fallback for the webhook + backfill callers that supply no `addonLineItems` (an unguarded map would 500 the webhook).
4. Real-rate add-on lines preserve `source_type:'addon'` so `voidExtrasInvoiceWithReconcile` still detects them (else the comp residual silently returns).
5. create-intent expanded to the full `calculateProposal` context and the shared add-on filter, matching submit exactly (charge == invoice).
6. Pseudocode uses `calculateProposal(...).addons[].line_total` (the engine has no `.addonTotal`/`.addonResults` return field).
7. LogisticsStep client preview reconciled to `totalStaff` (cross-cutting-consistency rule).
