# Checkout Gratuity (Project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the client choose, at sign-and-pay (and an admin on a proposal), whether to keep a tip jar and whether to pre-pay gratuity, with the gratuity flowing into `total_price` and out to staff through the existing payroll pipe.

**Architecture:** Gratuity is stored as a per-staff-per-hour *rate* (`gratuity_rate NUMERIC(10,4)`) plus a `tip_jar BOOLEAN`. The dollar amount is always computed (`rate × staffCount × hours`) and appended to the pricing breakdown as a distinct `"Gratuity"` line, layered on top of the existing forced `"Shared Gratuity"` surcharge (untouched). The pricing engine is the single source of the gratuity math; the checkout charge path persists + recomputes the gratuity-adjusted total inside one transaction before building the Stripe PaymentIntent. Payroll pools both gratuity labels and gates the gratuity portion of accrual on the proposal being funded. Money on the proposal side stays in DOLLARS; convert to cents only at the payroll/Stripe seam.

**Tech Stack:** Node 18 / Express, raw SQL (`pg`), React 18 (CRA), Stripe, Neon PostgreSQL. Server tests: `node --test`. Client verification: `CI=true` production build.

**Spec:** `docs/superpowers/specs/2026-06-05-checkout-gratuity-design.md` (r3). Section references below (§N) point at it.

> **Plan status:** r2 — folds in the `/review-plan` fleet (fidelity + decomposition + feasibility) and a Gemini design-stage review. Changes vs r1: added the stripe.js split (Task 6) to clear the file-size ratchet; added the admin overpayment-flag task (Task 14); pinned every previously-vague file location; rewrote all test snippets against the real harnesses; corrected the payroll fixtures that the funded gate would break; added the Batch & Sequencing and Execution Review Cadence sections; documented the "breakdown emails" / "admin-payroll views" §10 surfaces as verified no-ops.

---

## Key design decisions (read before starting)

These resolve ambiguities the spec left to implementation. They are load-bearing — do not deviate without re-reading the spec section cited.

1. **Engine defaults make the existing call sites inert.** `calculateProposal` gains `gratuityRate = 0, tipJar = true` with defaults, so every current caller that doesn't pass them behaves *exactly* as today (rate 0 ⇒ no `"Gratuity"` line). We then explicitly thread the stored values only where they matter (crud update, drinkPlans persist, the create-intent persist) and the preview sites where an admin/body value should show.
2. **Gratuity is added on top of `(total_price_override ?? calculatedTotal)`, NOT into `subtotal`.** It is staff pass-through money — a flat discount/surcharge or an admin override must never dilute it, and an override governs the *service* price while gratuity adds on top. So `total = (override ?? calculatedTotal) + gratuityAmount`. (The forced `"Shared Gratuity"` stays inside `staffing.cost`/subtotal — unchanged; that is a pricing surcharge, a different thing.)
3. **The create-intent recompute is *surgical*, not a full `calculateProposal` re-run.** Re-deriving `calculateProposal`'s addon *inputs* from a stored snapshot is fragile (`proposal_addons.quantity` holds the *computed* qty, e.g. `durationHours × qty`). Instead a pure helper `recomputeSnapshotGratuity()` replaces only the `"Gratuity"` line and adjusts the total, using the `staff_count`+`hours` frozen into the snapshot at compute time. This is drift-free (every non-gratuity line stays byte-identical) and fully satisfies §5's "7th recompute site" intent (server recomputes the gratuity-adjusted `total_price` authoritatively before charging) via the *same* gratuity primitive `calculateProposal` uses. The legacy fallback (snapshots predating this feature, which lack a `gratuity` object) recovers `staff_count` from `staffing.actual` + the addon count; the frozen value is always preferred and is present on every proposal touched after Task 2 ships.
4. **One gratuity-math source.** `gratuityLineAmount(rate, staffCount, hours)` and `computeGratuityBasis()`/`gratuityBasisFromSnapshot()` are the only places staff-count and the dollar line are computed. `calculateProposal`, the create-intent recompute, the admin preview, and the client UI all funnel through them.
5. **Total → rate conversion happens once, server-side, wherever a *total* is submitted** (`deriveGratuityRate()`); everything downstream works in the stored *rate*. The client and admin UIs both speak dollars-totals; the server owns the conversion + validation (route layer) with the DB CHECK as the final backstop.
6. **Forced-line disambiguation (§10):** the forced surcharge keeps its stored snapshot label `"Shared Gratuity"` (payroll/back-compat — NEVER change) but renders as the display string `"Staffing Gratuity"`, captured into `snapshot.display_labels` at compute time (W9) so signed proposals never shift wording. The client line is `"Gratuity"` in both stored and display form.
7. **Funded gate lives inside `accruePayoutsForProposal` (§8),** so it covers both the auto-complete and the manual-completion paths with one change. Wages are never gated; only the gratuity pool is.
8. **Overpayment is surfaced, never auto-refunded (§6).** A price-down on a paid proposal writes a durable `overpayment_detected` activity-log entry and shows a derived "overpaid $X" flag on the admin payment panel (`amount_paid > total_price`). The admin issues the refund through the existing flow.

---

## Batch & Sequencing constraints (read before pushing)

Pushes are batched and user-initiated (CLAUDE.md). Some tasks open a brief correctness gap if shipped alone; the executor may commit them separately but **these clusters must land in the same push to `main`:**

- **Cluster A — gratuity write path:** Task 3 (DB CHECK) + Task 5 (route-layer validation) + Task 7 (checkout validation) + Task 13 (post-payment guard). Rationale: §3 wants the clean route error to precede the raw DB CHECK, and Task 5 widens the admin PATCH to write `gratuity_rate` before Task 13 locks down post-payment rate hikes — shipping Task 5 without Task 13 leaves a window where an admin could raise gratuity on a paid proposal with no rejection. Ship A together.
- **Cluster B — checkout:** Task 6 (stripe split) + Task 7 (checkout gratuity) + Task 11 (client checkout UI). The server endpoint and its only caller ship together.
- Tasks 1, 2, 4, 8, 9, 10, 12, 14, 15, 16 are independently shippable (each is no-op-safe on existing data until its consumers land).
- **Task 7 is a member of BOTH clusters.** If A and B are in flight together, their union {3, 5, 6, 7, 11, 13} must all land in one push — do not split the union across two deploys.

Within a cluster, the task ORDER below still holds (e.g. Task 6 before Task 7); the constraint is only that the cluster reaches `main` in one push.

---

## File Structure

**New files**
- `server/utils/gratuityLabels.js` — shared label constants + display resolver (CJS). Single source.
- `client/src/utils/gratuityLabels.js` — byte-identical mirror (ESM), kept in sync manually like `eventTypes.js`.
- `server/utils/proposalStatus.js` — `reconcileProposalPaymentStatus()` (pure demotion ladder + overpayment detection), extracted from `refundHelpers.js`.
- `server/utils/stripeRouteHelpers.js` — `DEPOSIT_AMOUNT`, `eventLabelFor`, `getOrCreateCustomer` extracted from `stripe.js` (Task 6) so the create-intent sub-router can share them.
- `server/routes/stripeCreateIntent.js` — the `POST /create-intent/:token` route, extracted from `stripe.js` (Task 6) so Task 7's gratuity additions don't grow the over-cap `stripe.js`. (Flat sibling, NOT a `stripe/` dir, to avoid file/dir name ambiguity alongside the surviving `stripe.js`.)
- `server/utils/pricingEngine.test.js`, `server/utils/proposalStatus.test.js`, `server/utils/gratuityLabels.test.js`, `server/utils/invoiceHelpers.gratuity.test.js` — new unit/integration suites.

**Modified (by responsibility)**
- Pricing: `server/utils/pricingEngine.js`; call sites `server/routes/proposals/crud.js`, `metadata.js`, `public.js`, `server/routes/drinkPlans.js`.
- Schema: `server/db/schema.sql`.
- Checkout charge: `server/routes/stripe.js` (split), `server/routes/stripeCreateIntent.js` (gratuity), `client/src/pages/proposal/proposalView/ProposalView.js`, `.../SignAndPaySection.js`.
- Payroll: `server/utils/payrollMath.js`, `server/utils/payrollAccrual.js`; tests `payrollMath.test.js`, `payrollAccrual.test.js`, `server/routes/admin/payroll.test.js`; staff FAQ copy in `client/src/pages/PaydayProtocols.js` (if it describes gratuity as single-source).
- Status: `server/utils/refundHelpers.js` (refactor to call the extracted helper).
- Invoice: `server/utils/invoiceHelpers.js`.
- Labels: `client/src/components/PricingBreakdown.js`, `client/src/pages/admin/ProposalCreate.js`, `client/src/pages/website/quoteWizard/QuoteWizard.js`, `client/src/pages/website/ClassWizard.js`, `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`.
- Admin: `client/src/pages/admin/ProposalDetailEditForm.js`, `client/src/pages/admin/EventEditForm.js`, `client/src/pages/admin/ProposalDetailPaymentPanel.js` (overpayment flag).
- Notification: an `emailTemplates.js` template + a send hook in `crud.js`.
- BEO: `server/routes/beo.js`, `client/src/components/staff/BeoSections.js`, `client/src/pages/staff/ShiftDetail.js`.
- Docs: `ARCHITECTURE.md`, `README.md`, `.claude/CLAUDE.md`.

**Verified NON-surfaces (no change; documented so they aren't mistaken for gaps):**
- **"breakdown emails" (§10):** inventory found NO email template renders `snapshot.breakdown` labels (the only `.breakdown` consumers are `payrollMath.extractGratuityCents` and the unrelated ccImport count object; `sendProposalSentEmail.js` has no breakdown rendering). Nothing to migrate. Task 10 includes a guard step to re-confirm.
- **"admin/payroll views" (§10):** these render `gratuity_share_cents` (a number), not the breakdown label, so there is no label to resolve.
- **Invoice forced surcharge:** the forced `"Shared Gratuity"` stays bundled into the `"Additional Bartender(s)"` invoice line via `snap.staffing.total` (current behavior, intended); only the client gratuity gets its own invoice line (Task 9).

---

## Execution Review Cadence

Run the specialized review agents at these checkpoints (matched to what each cluster changed), in addition to the mandatory full pre-push fleet before the final merge to `main`:

- **After Task 3** (schema): `database-review`.
- **After Task 5** (recompute + bidirectional status reconcile): `code-review` + `consistency-check`.
- **After Task 6** (stripe split — pure refactor): `code-review` (light) + `consistency-check`.
- **After Task 7** (checkout money path + transaction + Stripe): `security-review` + `code-review`.
- **After Task 8** (payroll pool + funded gate): `code-review` + `consistency-check` + `database-review`.
- **After Task 12** (admin gratuity control — the admin twin of the client UI; edits two forms that must agree): `consistency-check`.
- **After Task 13** (post-payment guard + outbound email): `security-review` + `code-review`.
- **Before merge:** the full 5-agent pre-push fleet per CLAUDE.md.

---

## Task 1: Shared gratuity-label module (server + client)

**Files:**
- Create: `server/utils/gratuityLabels.js`
- Create: `client/src/utils/gratuityLabels.js`
- Create: `server/utils/gratuityLabels.test.js`

- [ ] **Step 1: Write the failing test**

`server/utils/gratuityLabels.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./gratuityLabels');

test('canonical labels are the load-bearing strings payroll keys on', () => {
  assert.strictEqual(L.SHARED_GRATUITY_LABEL, 'Shared Gratuity');
  assert.strictEqual(L.GRATUITY_LABEL, 'Gratuity');
  assert.deepStrictEqual(L.GRATUITY_PAYROLL_LABELS, ['Shared Gratuity', 'Gratuity']);
});

test('resolver prefers the snapshot frozen map, then the current display map, then raw', () => {
  assert.strictEqual(L.resolveGratuityDisplayLabel('Shared Gratuity', null), 'Staffing Gratuity');
  assert.strictEqual(L.resolveGratuityDisplayLabel('Gratuity', null), 'Gratuity');
  assert.strictEqual(L.resolveGratuityDisplayLabel('Bar Rental', null), 'Bar Rental');
  const snap = { display_labels: { 'Shared Gratuity': 'OLD WORDING' } };
  assert.strictEqual(L.resolveGratuityDisplayLabel('Shared Gratuity', snap), 'OLD WORDING');
});

test('client mirror keeps identical VALUES and the same resolver branches', () => {
  const clientSrc = fs.readFileSync(
    path.join(__dirname, '../../client/src/utils/gratuityLabels.js'), 'utf8'
  );
  // value parity
  for (const v of [L.SHARED_GRATUITY_LABEL, L.GRATUITY_LABEL, L.SHARED_GRATUITY_DISPLAY, L.GRATUITY_DISPLAY]) {
    assert.ok(clientSrc.includes(`'${v}'`), `client mirror must contain value '${v}'`);
  }
  // resolver-logic parity (not just values): the same two branch returns + frozen-map lookup
  assert.ok(clientSrc.includes('export function resolveGratuityDisplayLabel'));
  assert.ok(clientSrc.includes('snapshot.display_labels'));
  assert.ok(clientSrc.includes('=== SHARED_GRATUITY_LABEL'));
  assert.ok(clientSrc.includes('=== GRATUITY_LABEL'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/gratuityLabels.test.js`
Expected: FAIL — `Cannot find module './gratuityLabels'`.

- [ ] **Step 3: Write the server module**

`server/utils/gratuityLabels.js`:

```js
'use strict';
/**
 * Single source for gratuity line labels (spec §10). The CLIENT mirror at
 * client/src/utils/gratuityLabels.js MUST keep identical VALUES and the same
 * resolver branches — kept in sync manually, exactly like eventTypes.js.
 * gratuityLabels.test.js asserts parity.
 *
 * CANONICAL labels are stored in pricing_snapshot.breakdown and read by payroll
 * (payrollMath.extractGratuityCents). NEVER change them — back-compat + the
 * forced surcharge's stored label is load-bearing for the payroll pool.
 */
const SHARED_GRATUITY_LABEL = 'Shared Gratuity'; // forced over-ratio surcharge
const GRATUITY_LABEL = 'Gratuity';               // client-elected pre-paid gratuity (§8.3)

/**
 * DISPLAY strings (what humans see). The forced line gets a disambiguated
 * display so it can't be read as the §8.3 client gratuity. Frozen into
 * snapshot.display_labels at compute time (W9) so signed proposals never shift.
 */
const SHARED_GRATUITY_DISPLAY = 'Staffing Gratuity';
const GRATUITY_DISPLAY = 'Gratuity';

/** Payroll pools BOTH canonical labels into one gratuity figure (spec §8). */
const GRATUITY_PAYROLL_LABELS = [SHARED_GRATUITY_LABEL, GRATUITY_LABEL];

/**
 * Resolve a stored breakdown label to its display string. Prefers the
 * snapshot's frozen map (W9), then the current display map, then the raw label.
 */
function resolveGratuityDisplayLabel(label, snapshot) {
  const frozen = snapshot && snapshot.display_labels;
  if (frozen && frozen[label]) return frozen[label];
  if (label === SHARED_GRATUITY_LABEL) return SHARED_GRATUITY_DISPLAY;
  if (label === GRATUITY_LABEL) return GRATUITY_DISPLAY;
  return label;
}

/** The display_labels map calculateProposal/recompute freeze into the snapshot. */
function currentDisplayLabels() {
  return {
    [SHARED_GRATUITY_LABEL]: SHARED_GRATUITY_DISPLAY,
    [GRATUITY_LABEL]: GRATUITY_DISPLAY,
  };
}

module.exports = {
  SHARED_GRATUITY_LABEL, GRATUITY_LABEL,
  SHARED_GRATUITY_DISPLAY, GRATUITY_DISPLAY,
  GRATUITY_PAYROLL_LABELS,
  resolveGratuityDisplayLabel, currentDisplayLabels,
};
```

- [ ] **Step 4: Write the client mirror**

`client/src/utils/gratuityLabels.js`:

```js
// Mirror of server/utils/gratuityLabels.js — keep VALUES + resolver branches
// byte-identical (synced manually, like eventTypes.js). server/utils/
// gratuityLabels.test.js asserts parity. Canonical labels are payroll/back-compat
// load-bearing.
export const SHARED_GRATUITY_LABEL = 'Shared Gratuity';
export const GRATUITY_LABEL = 'Gratuity';
export const SHARED_GRATUITY_DISPLAY = 'Staffing Gratuity';
export const GRATUITY_DISPLAY = 'Gratuity';

export function resolveGratuityDisplayLabel(label, snapshot) {
  const frozen = snapshot && snapshot.display_labels;
  if (frozen && frozen[label]) return frozen[label];
  if (label === SHARED_GRATUITY_LABEL) return SHARED_GRATUITY_DISPLAY;
  if (label === GRATUITY_LABEL) return GRATUITY_DISPLAY;
  return label;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test server/utils/gratuityLabels.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/utils/gratuityLabels.js client/src/utils/gratuityLabels.js server/utils/gratuityLabels.test.js
git commit -m "feat(gratuity): shared label constants + display resolver (server+client)"
```

---

## Task 2: Pricing-engine gratuity integration

**Files:**
- Modify: `server/utils/pricingEngine.js` (helpers + `calculateProposal` + exports)
- Create: `server/utils/pricingEngine.test.js`

- [ ] **Step 1: Write the failing test**

`server/utils/pricingEngine.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  calculateProposal, getStaffNoun, gratuityLineAmount, deriveGratuityRate,
  computeGratuityBasis, gratuityBasisFromSnapshot, recomputeSnapshotGratuity,
  GRATUITY_FLOOR_RATE,
} = require('./pricingEngine');

const BYOB = {
  id: 1, slug: 'byob', name: 'BYOB Bar', category: 'byob', pricing_type: 'flat',
  bar_type: 'byob', base_rate_4hr: 1000, base_rate_3hr: 900, extra_hour_rate: 150,
  bartenders_included: 1, guests_per_bartender: 100, extra_bartender_hourly: 40,
  first_bar_fee: 50, additional_bar_fee: 100,
};
const CLASS = { ...BYOB, slug: 'class', name: 'Cocktail Class', category: 'hosted',
  pricing_type: 'per_guest', bar_type: 'class', base_rate_4hr: 100, min_guests: 8 };

function base(extra = {}) {
  return { pkg: BYOB, guestCount: 100, durationHours: 4, numBars: 1,
    numBartenders: null, addons: [], syrupSelections: [], adjustments: [], ...extra };
}

test('no gratuity line when rate is 0 (default = today behavior)', () => {
  const snap = calculateProposal(base());
  assert.ok(!snap.breakdown.some(l => l.label === 'Gratuity'));
  assert.strictEqual(snap.gratuity.total, 0);
  assert.strictEqual(snap.gratuity.rate, 0);
  assert.strictEqual(snap.gratuity.tip_jar, true);
});

test('gratuity = rate x staffCount x hours, folded into total on top of services', () => {
  const noGrat = calculateProposal(base());
  const snap = calculateProposal(base({ gratuityRate: 25, tipJar: true }));
  const line = snap.breakdown.find(l => l.label === 'Gratuity');
  assert.strictEqual(line.amount, 100); // 25 x 1 bartender x 4
  assert.strictEqual(snap.gratuity.staff_count, 1);
  assert.strictEqual(snap.gratuity.hours, 4);
  assert.strictEqual(snap.total, Math.round((noGrat.total + 100) * 100) / 100);
});

test('staffCount excludes barbacks/servers but includes additional-bartender addon', () => {
  const addons = [
    { id: 9, slug: 'additional-bartender', name: 'Additional Bartender',
      billing_type: 'per_hour', rate: 40, quantity: 1 },
    { id: 8, slug: 'barback', name: 'Barback', billing_type: 'per_staff', rate: 30, quantity: 1 },
  ];
  const snap = calculateProposal(base({ gratuityRate: 25, addons }));
  assert.strictEqual(snap.gratuity.staff_count, 2); // 1 auto + 1 addon, barback NOT counted
  assert.strictEqual(snap.breakdown.find(l => l.label === 'Gratuity').amount, 200);
});

test('numBartenders override is not double-counted', () => {
  const snap = calculateProposal(base({ guestCount: 250, numBartenders: 3, gratuityRate: 10 }));
  assert.strictEqual(snap.gratuity.staff_count, 3);
});

test('class package uses the instructor noun; forced surcharge still class-exempt', () => {
  const snap = calculateProposal({ pkg: CLASS, guestCount: 12, durationHours: 2,
    numBars: 0, addons: [], syrupSelections: [], gratuityRate: 30 });
  assert.strictEqual(snap.staff_noun, 'instructor');
  assert.strictEqual(snap.gratuity.staff_noun, 'instructor');
  assert.ok(!snap.breakdown.some(l => l.label === 'Shared Gratuity'));
});

test('coexists with the forced Shared Gratuity line', () => {
  const addons = [{ id: 9, slug: 'additional-bartender', name: 'Additional Bartender',
    billing_type: 'per_hour', rate: 40, quantity: 1 }];
  const snap = calculateProposal(base({ guestCount: 40, gratuityRate: 25, addons }));
  assert.ok(snap.breakdown.some(l => l.label === 'Shared Gratuity'));
  assert.ok(snap.breakdown.some(l => l.label === 'Gratuity'));
});

test('snapshot freezes staff_noun + display_labels', () => {
  const snap = calculateProposal(base({ gratuityRate: 25 }));
  assert.strictEqual(snap.staff_noun, 'bartender');
  assert.strictEqual(snap.display_labels['Shared Gratuity'], 'Staffing Gratuity');
  assert.strictEqual(snap.display_labels['Gratuity'], 'Gratuity');
});

test('gratuity is added on top of a total_price_override (DD #2)', () => {
  const snap = calculateProposal(base({ gratuityRate: 25, totalPriceOverride: 500 }));
  assert.strictEqual(snap.total, 600); // 500 override + 100 gratuity
});

test('getStaffNoun', () => {
  assert.strictEqual(getStaffNoun(BYOB), 'bartender');
  assert.strictEqual(getStaffNoun(CLASS), 'instructor');
  assert.strictEqual(getStaffNoun(null), 'bartender');
});

test('gratuityLineAmount rounds to cents; 0 on degenerate inputs', () => {
  assert.strictEqual(gratuityLineAmount(25, 2, 4), 200);
  assert.strictEqual(gratuityLineAmount(0, 2, 4), 0);
  assert.strictEqual(gratuityLineAmount(25, 0, 4), 0);
  assert.strictEqual(gratuityLineAmount(25, 1, 0), 0);
});

test('deriveGratuityRate: jar kept allows >= 0; derives rate from the entered total', () => {
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 0, staffCount: 1, hours: 4, tipJar: true }),
    { ok: true, rate: 0 });
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 200, staffCount: 1, hours: 4, tipJar: true }),
    { ok: true, rate: 50 });
});

test('deriveGratuityRate: no-jar enforces the >= $50/staff/hr floor', () => {
  const floorTotal = GRATUITY_FLOOR_RATE * 1 * 4; // 200
  const below = deriveGratuityRate({ enteredTotal: floorTotal - 1, staffCount: 1, hours: 4, tipJar: false });
  assert.strictEqual(below.ok, false);
  assert.strictEqual(below.code, 'GRATUITY_BELOW_FLOOR');
  const ok = deriveGratuityRate({ enteredTotal: floorTotal, staffCount: 1, hours: 4, tipJar: false });
  assert.deepStrictEqual(ok, { ok: true, rate: 50 });
});

test('deriveGratuityRate: rejects NaN/negative/Infinity/absurd', () => {
  assert.strictEqual(deriveGratuityRate({ enteredTotal: -5, staffCount: 1, hours: 4, tipJar: true }).ok, false);
  assert.strictEqual(deriveGratuityRate({ enteredTotal: 'abc', staffCount: 1, hours: 4, tipJar: true }).ok, false);
  assert.strictEqual(deriveGratuityRate({ enteredTotal: Infinity, staffCount: 1, hours: 4, tipJar: true }).ok, false);
  assert.strictEqual(deriveGratuityRate({ enteredTotal: 9_999_999, staffCount: 1, hours: 4, tipJar: true }).ok, false);
});

test('deriveGratuityRate: degenerate crew/hours coerces rate to 0', () => {
  assert.deepStrictEqual(deriveGratuityRate({ enteredTotal: 500, staffCount: 0, hours: 4, tipJar: false }),
    { ok: true, rate: 0 });
});

test('recomputeSnapshotGratuity surgically replaces only the Gratuity line', () => {
  const snap0 = calculateProposal(base({ gratuityRate: 25 }));
  const before = JSON.parse(JSON.stringify(snap0));
  const snap1 = recomputeSnapshotGratuity(snap0, { gratuityRate: 50, tipJar: true, staffNoun: 'bartender', durationHours: 4 });
  assert.strictEqual(snap1.breakdown.filter(l => l.label === 'Gratuity').length, 1);
  assert.strictEqual(snap1.breakdown.find(l => l.label === 'Gratuity').amount, 200);
  assert.strictEqual(snap1.total, Math.round((before.total - 100 + 200) * 100) / 100);
  assert.strictEqual(snap0.breakdown.find(l => l.label === 'Gratuity').amount, 100); // input not mutated
});

test('gratuityBasisFromSnapshot prefers frozen staff_count, falls back to staffing+addons', () => {
  const snap = calculateProposal(base({ gratuityRate: 25 }));
  assert.deepStrictEqual(gratuityBasisFromSnapshot(snap, 4), { staffCount: 1, hours: 4 });
  const legacy = { staffing: { actual: 2 }, addons: [{ slug: 'additional-bartender', quantity: 8 }] };
  assert.deepStrictEqual(gratuityBasisFromSnapshot(legacy, 4), { staffCount: 4, hours: 4 });
});

test('computeGratuityBasis matches the engine count', () => {
  assert.deepStrictEqual(
    computeGratuityBasis({ pkg: BYOB, guestCount: 100, durationHours: 4, numBartenders: null, addons: [] }),
    { staffCount: 1, hours: 4 }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/pricingEngine.test.js`
Expected: FAIL — `getStaffNoun is not a function` / `gratuity` undefined.

- [ ] **Step 3: Add the require + gratuity helpers above `calculateProposal`**

At the top of `server/utils/pricingEngine.js` (after the opening doc comment, before `function isHostedPackage`):

```js
const {
  SHARED_GRATUITY_LABEL, GRATUITY_LABEL, currentDisplayLabels,
} = require('./gratuityLabels');
```

Immediately above `function calculateProposal(`:

```js
// ─── Client-elected gratuity (spec §3, §8.3) ─────────────────────────────────
// A per-staff-per-hour RATE (dollars), stored as proposals.gratuity_rate
// NUMERIC(10,4). The dollar line scales: rate x staffCount x hours. It is STAFF
// pass-through money — added on top of the service total, never reduced by a
// discount/surcharge or total_price_override (DD #2). Layered on top of the
// forced "Shared Gratuity" surcharge, which is unchanged.
const GRATUITY_FLOOR_RATE = 50;        // no-jar minimum, $/staff/hr (linking rule §3)
const GRATUITY_SANITY_MAX_RATE = 1000; // reject absurd rates; honest typos fixed via refund (§6)

/** 'instructor' for class packages, else 'bartender'. Frozen into the snapshot
 *  (snapshot.staff_noun) so a later re-categorization can't swap the noun on a
 *  signed proposal (spec §3). */
function getStaffNoun(pkg) {
  return pkg && pkg.bar_type === 'class' ? 'instructor' : 'bartender';
}

/** Staff that share the client gratuity: bartenders (staffing.actual already
 *  folds the numBartenders override) + additional-bartender addon qty. EXCLUDES
 *  barbacks/servers — a SEPARATE count from the engine's totalStaff (spec §3). */
function computeGratuityBasis({ pkg, guestCount, durationHours, numBartenders, addons }) {
  const staffing = calculateStaffing(pkg, guestCount, durationHours, numBartenders);
  const additionalBartenderQty = (addons || [])
    .filter(a => a.slug === 'additional-bartender')
    .reduce((sum, a) => sum + (a.quantity || 1), 0);
  return { staffCount: staffing.actual + additionalBartenderQty, hours: Number(durationHours) || 0 };
}

/** Derive the same basis from a computed snapshot (used by the surgical
 *  create-intent recompute). Prefers the frozen gratuity.staff_count; falls back
 *  to staffing.actual + the addon count recovered from snapshot.addons. */
function gratuityBasisFromSnapshot(snapshot, durationHours) {
  const g = snapshot && snapshot.gratuity;
  const dh = Number(durationHours) || 0;
  if (g && g.staff_count != null) {
    return { staffCount: g.staff_count, hours: g.hours != null ? g.hours : dh };
  }
  const staffActual = (snapshot && snapshot.staffing && snapshot.staffing.actual) || 0;
  const addonQty = ((snapshot && snapshot.addons) || [])
    .filter(a => a.slug === 'additional-bartender')
    // snapshot.addons[].quantity for a bartender is durationHours x rawQty; recover rawQty.
    .reduce((s, a) => s + (dh > 0 && a.quantity ? Math.round(a.quantity / dh) : (a.quantity || 0)), 0);
  return { staffCount: staffActual + addonQty, hours: dh };
}

/** The gratuity dollar line, rounded to cents. ONE source of the math (DD #4). */
function gratuityLineAmount(rate, staffCount, hours) {
  const r = Number(rate) || 0;
  const sc = Number(staffCount) || 0;
  const h = Number(hours) || 0;
  if (r <= 0 || sc <= 0 || h <= 0) return 0;
  return Math.round(r * sc * h * 100) / 100;
}

/** Derive + validate a stored rate from a client/admin-entered TOTAL (dollars).
 *  PURE: the route turns {ok:false} into a clean ValidationError BEFORE the DB
 *  CHECK fires; the DB CHECK is the final backstop (spec §3, §4, §6). */
function deriveGratuityRate({ enteredTotal, staffCount, hours, tipJar }) {
  const basis = (Number(staffCount) || 0) * (Number(hours) || 0);
  // Degenerate crew/hours: no gratuity is possible — coerce to 0 (the UI step is
  // disabled here; the caller also forces tip_jar=true so the DB CHECK passes).
  if (basis <= 0) return { ok: true, rate: 0 };
  const total = Number(enteredTotal);
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false, code: 'INVALID_GRATUITY', message: 'Enter a gratuity amount of $0 or more.' };
  }
  if (tipJar === false) {
    const floorTotal = GRATUITY_FLOOR_RATE * basis;
    if (total < floorTotal - 0.005) {
      return {
        ok: false, code: 'GRATUITY_BELOW_FLOOR',
        message: `Without a tip jar, gratuity must be at least $${floorTotal.toFixed(2)}.`,
      };
    }
  }
  const rate = Math.round((total / basis) * 10000) / 10000; // NUMERIC(10,4)
  if (rate > GRATUITY_SANITY_MAX_RATE) {
    return { ok: false, code: 'GRATUITY_TOO_LARGE', message: 'That gratuity is unusually large — please re-enter it.' };
  }
  return { ok: true, rate };
}

/** Return a NEW snapshot with the client Gratuity line recomputed for a new
 *  rate, leaving every other line byte-identical (drift-free, DD #3). */
function recomputeSnapshotGratuity(snapshot, { gratuityRate, tipJar, staffNoun, durationHours }) {
  const snap = JSON.parse(JSON.stringify(snapshot)); // never mutate the caller's object
  const { staffCount, hours } = gratuityBasisFromSnapshot(snap, durationHours);
  const priorAmount = Number(snap.gratuity && snap.gratuity.total) || 0;
  const newAmount = gratuityLineAmount(gratuityRate, staffCount, hours);
  snap.breakdown = (snap.breakdown || []).filter(l => l.label !== GRATUITY_LABEL);
  if (newAmount > 0) snap.breakdown.push({ label: GRATUITY_LABEL, amount: newAmount });
  snap.total = Math.round((Number(snap.total || 0) - priorAmount + newAmount) * 100) / 100;
  snap.staff_noun = staffNoun || snap.staff_noun || 'bartender';
  snap.display_labels = snap.display_labels || currentDisplayLabels();
  snap.gratuity = {
    rate: Number(gratuityRate) || 0,
    tip_jar: tipJar !== false,
    staff_count: staffCount,
    hours,
    staff_noun: snap.staff_noun,
    total: newAmount,
  };
  return snap;
}
```

- [ ] **Step 4: Wire gratuity into `calculateProposal`**

(a) Signature (line ~180) — add the two params with defaults:

```js
function calculateProposal({ pkg, guestCount, durationHours, numBars, numBartenders, addons, syrupSelections, adjustments, totalPriceOverride, gratuityRate = 0, tipJar = true }) {
```

(b) Replace BOTH forced-line literal labels with the constant. The staffing branch (was `label: 'Shared Gratuity',`):

```js
        breakdown.push({
          label: SHARED_GRATUITY_LABEL,
          amount: Math.round(gratuityAmount * 100) / 100
        });
```

and the addon branch (was `breakdown.push({ label: 'Shared Gratuity', amount: ... });`):

```js
          breakdown.push({ label: SHARED_GRATUITY_LABEL, amount: Math.round(gratuityAmount * 100) / 100 });
```

(c) Just before `const calculatedTotal = ...` (line ~253), reuse the already-computed `staffing` + `additionalBartenderQty` (lines ~186/189 — do NOT recompute staffing):

```js
  // Client-elected gratuity (DD #2/#4): staff pass-through, added on top of the
  // service total. staffing.actual already folds the numBartenders override.
  const gratuityStaffCount = staffing.actual + additionalBartenderQty;
  const staffNoun = getStaffNoun(pkg);
  const clientGratuityAmount = gratuityLineAmount(gratuityRate, gratuityStaffCount, durationHours);
```

(d) Change the `total` line (line ~254) to add gratuity on top of override-or-calculated:

```js
  const serviceTotal = totalPriceOverride !== null && totalPriceOverride !== undefined
    ? Math.round(Number(totalPriceOverride) * 100) / 100
    : calculatedTotal;
  const total = Math.round((serviceTotal + clientGratuityAmount) * 100) / 100;
```

(e) Append the Gratuity breakdown line AFTER the adjustments loop (after the `for (const adj of safeAdjustments)` block, ~line 343):

```js
  if (clientGratuityAmount > 0) {
    breakdown.push({ label: GRATUITY_LABEL, amount: clientGratuityAmount });
  }
```

(f) In the returned snapshot object (`return { ... }`, ~line 345), add three fields next to `breakdown`:

```js
    staff_noun: staffNoun,
    display_labels: currentDisplayLabels(),
    gratuity: {
      rate: Number(gratuityRate) || 0,
      tip_jar: tipJar !== false,
      staff_count: gratuityStaffCount,
      hours: Number(durationHours) || 0,
      staff_noun: staffNoun,
      total: clientGratuityAmount,
    },
```

- [ ] **Step 5: Extend `module.exports`**

Replace the export line (~389) with:

```js
module.exports = {
  calculateProposal, calculateBaseCost, calculateBarRental, calculateStaffing,
  calculateAddonCost, calculateSyrupCost, getBottlesPerSyrup, isHostedPackage,
  computeCocktailGap, packageSuppressedAddons, isCocktailFullyCovered,
  getStaffNoun, computeGratuityBasis, gratuityBasisFromSnapshot, gratuityLineAmount,
  deriveGratuityRate, recomputeSnapshotGratuity,
  GRATUITY_FLOOR_RATE, GRATUITY_SANITY_MAX_RATE,
};
```

- [ ] **Step 6: Run the tests**

Run: `node --test server/utils/pricingEngine.test.js`
Expected: PASS.

Run: `node --test server/utils/payrollMath.test.js`
Expected: PASS (snapshot shape unchanged for existing consumers).

- [ ] **Step 7: Lint + commit**

Run: `npx eslint server/utils/pricingEngine.js server/utils/pricingEngine.test.js`
Expected: clean.

```bash
git add server/utils/pricingEngine.js server/utils/pricingEngine.test.js
git commit -m "feat(gratuity): pricing-engine gratuity line, helpers, and snapshot fields"
```

---

## Task 3: Schema migration (columns + CHECK + stripe_sessions status)

> **Cluster A** — must reach `main` in the same push as Tasks 5, 7, 13 (the route-layer validation that fronts these DB CHECKs).

**Files:**
- Modify: `server/db/schema.sql`

- [ ] **Step 1: Add the proposal gratuity columns + CHECKs**

After the `total_price_override` ALTER (the `-- ─── Proposal Price Adjustments ───` block, ~line 1162), add:

```sql
-- ─── Checkout Gratuity (Project B, spec 2026-06-05) ───────────────
-- Client-elected pre-paid gratuity, stored as a per-staff-per-hour RATE so it
-- scales with crew + hours. The dollar amount is always computed by the pricing
-- engine (rate x staffCount x hours) and appended as a "Gratuity" breakdown line
-- folded into total_price. Layered on top of the forced "Shared Gratuity"
-- surcharge (unchanged). Money here is DOLLARS (proposal side).
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS tip_jar BOOLEAN DEFAULT true;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS gratuity_rate NUMERIC(10,4) DEFAULT 0;
-- Distinguishes a post-payment staffing-driven gratuity change (allowed, client
-- notified) from a direct admin rate increase (disallowed post-payment). See §7.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS gratuity_rate_change_origin TEXT;

-- Linking rule (§3): if the tip jar is skipped, gratuity must be >= $50/staff/hr.
-- Existing rows default to (true, 0) and pass, so a plain inline CHECK validates
-- cleanly with no NOT VALID/VALIDATE dance (the spec's optional path is only
-- needed when existing rows might fail — they can't here). Idempotent guard
-- mirrors the proposals_autopay_status_check pattern (schema.sql ~line 912).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'proposals' AND constraint_name = 'proposals_gratuity_jar_check'
  ) THEN
    ALTER TABLE proposals ADD CONSTRAINT proposals_gratuity_jar_check
      CHECK (tip_jar = true OR gratuity_rate >= 50);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'proposals' AND constraint_name = 'proposals_gratuity_origin_check'
  ) THEN
    ALTER TABLE proposals ADD CONSTRAINT proposals_gratuity_origin_check
      CHECK (gratuity_rate_change_origin IS NULL
             OR gratuity_rate_change_origin IN ('staffing', 'admin'));
  END IF;
END $$;

-- ROLLBACK (manual, if ever needed — schema additions are forward-safe):
--   ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_gratuity_jar_check;
--   ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_gratuity_origin_check;
--   ALTER TABLE proposals DROP COLUMN IF EXISTS gratuity_rate_change_origin;
--   ALTER TABLE proposals DROP COLUMN IF EXISTS gratuity_rate;
--   ALTER TABLE proposals DROP COLUMN IF EXISTS tip_jar;
```

- [ ] **Step 2: Allow the `'canceled'` stripe_sessions status**

Find the `stripe_sessions_status_check` block (~line 1526). It currently lists `('pending','succeeded','failed')`. Replace the two inner lines so the set is a SUPERSET (existing rows can never violate it):

```sql
  ALTER TABLE stripe_sessions DROP CONSTRAINT IF EXISTS stripe_sessions_status_check;
  ALTER TABLE stripe_sessions ADD CONSTRAINT stripe_sessions_status_check CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled'));
```

(Leave the surrounding `DO $$ BEGIN ... EXCEPTION WHEN OTHERS THEN NULL; END $$;` wrapper intact.)

- [ ] **Step 3: Apply the schema to the dev DB**

Run: `node -e "require('dotenv').config(); const fs=require('fs'); const {pool}=require('./server/db'); pool.query(fs.readFileSync('server/db/schema.sql','utf8')).then(()=>{console.log('schema applied');return pool.end();}).catch(e=>{console.error(e);process.exit(1);});"`
Expected: `schema applied`.

- [ ] **Step 4: Sanity SELECT — no existing row violates the new CHECK (§11)**

Run: `node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT count(*) AS bad FROM proposals WHERE NOT (tip_jar = true OR gratuity_rate >= 50)\").then(r=>{console.log('violating rows:', r.rows[0].bad); return pool.end();});"`
Expected: `violating rows: 0`.

- [ ] **Step 5: Commit** (Review checkpoint: `database-review`)

```bash
git add server/db/schema.sql
git commit -m "feat(gratuity): proposal columns, linking-rule CHECK, stripe_sessions canceled status"
```

---

## Task 4: Extract `reconcileProposalPaymentStatus` (shared demotion + overpayment)

**Files:**
- Create: `server/utils/proposalStatus.js`
- Create: `server/utils/proposalStatus.test.js`
- Modify: `server/utils/refundHelpers.js`

- [ ] **Step 1: Write the failing unit test**

`server/utils/proposalStatus.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcileProposalPaymentStatus } = require('./proposalStatus');

test('demotes balance_paid -> deposit_paid when a price rise outruns paid', () => {
  const r = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 1000, totalPrice: 1500 });
  assert.strictEqual(r.status, 'deposit_paid');
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.autopayDisarmed, true);
  assert.strictEqual(r.overpaid, false);
});

test('demotes to accepted when nothing is held', () => {
  const r = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 0, totalPrice: 1500 });
  assert.strictEqual(r.status, 'accepted');
  assert.strictEqual(r.autopayDisarmed, false);
});

test('still fully paid stays balance_paid (no promotion, no demotion)', () => {
  const r = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 1500, totalPrice: 1500 });
  assert.strictEqual(r.status, 'balance_paid');
  assert.strictEqual(r.changed, false);
});

test('overpayment is flagged with cents, status untouched', () => {
  const r = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 1500, totalPrice: 1200 });
  assert.strictEqual(r.overpaid, true);
  assert.strictEqual(r.overpaidCents, 30000);
  assert.strictEqual(r.status, 'balance_paid');
  assert.strictEqual(r.changed, false);
});

test('lifecycle states (confirmed/completed) are never demoted', () => {
  assert.strictEqual(reconcileProposalPaymentStatus({ status: 'completed', amountPaid: 0, totalPrice: 1500 }).status, 'completed');
  assert.strictEqual(reconcileProposalPaymentStatus({ status: 'confirmed', amountPaid: 0, totalPrice: 1500 }).status, 'confirmed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/proposalStatus.test.js`
Expected: FAIL — `Cannot find module './proposalStatus'`.

- [ ] **Step 3: Write the helper**

`server/utils/proposalStatus.js`:

```js
'use strict';
/**
 * Shared payment-status reconciliation (spec §6). PURE — no DB, no Stripe.
 *
 * The DEMOTE-only ladder was historically inline in refundHelpers.js; it is now
 * shared so every price/payment move (refund, admin edit, checkout recompute)
 * keeps proposals.status honest in BOTH directions. A move never PROMOTES
 * (promotion happens only on a money-IN event); it demotes a now-underpaid
 * proposal so no surface shows "Paid in full" when it isn't, and flags an
 * overpayment for an admin-issued refund when amount_paid > total_price.
 *
 * Only the pure payment statuses (deposit_paid / balance_paid) demote.
 * 'confirmed'/'completed' are lifecycle states and are left untouched.
 *
 * @returns {{status:string, changed:boolean, autopayDisarmed:boolean,
 *            overpaid:boolean, overpaidCents:number}}
 */
function reconcileProposalPaymentStatus({ status, amountPaid, totalPrice }) {
  const paidCents = Math.round(Number(amountPaid || 0) * 100);
  const totalCents = Math.round(Number(totalPrice || 0) * 100);
  const overpaid = paidCents > totalCents;
  const overpaidCents = overpaid ? paidCents - totalCents : 0;

  let next = status;
  if (status === 'balance_paid' || status === 'deposit_paid') {
    if (paidCents <= 0) next = 'accepted';
    else if (paidCents < totalCents) next = 'deposit_paid';
    // paidCents >= totalCents → unchanged (still fully paid at the corrected total)
  }
  const changed = next !== status;
  // CRITICAL (mirrors refundHelpers): only the was-fully-paid transition disarms
  // autopay, so a normal deposit-stage move leaves legitimate future autopay armed.
  const autopayDisarmed = status === 'balance_paid' && next === 'deposit_paid';
  return { status: next, changed, autopayDisarmed, overpaid, overpaidCents };
}

module.exports = { reconcileProposalPaymentStatus };
```

- [ ] **Step 4: Refactor refundHelpers to use it (no behavior change)**

In `server/utils/refundHelpers.js`, add near the top:

```js
const { reconcileProposalPaymentStatus } = require('./proposalStatus');
```

Replace the inline ladder block (lines ~263-280, `const mr = moneyRes.rows[0]; if (mr && ['balance_paid','deposit_paid'].includes(statusBefore)) { ... }`) with:

```js
  const mr = moneyRes.rows[0];
  if (mr) {
    const rec = reconcileProposalPaymentStatus({
      status: statusBefore, amountPaid: mr.amount_paid, totalPrice: mr.total_price,
    });
    if (rec.changed) {
      autopayDisarmed = rec.autopayDisarmed;
      await dbClient.query(
        autopayDisarmed
          ? 'UPDATE proposals SET status = $1, autopay_enrolled = false WHERE id = $2'
          : 'UPDATE proposals SET status = $1 WHERE id = $2',
        [rec.status, proposalId]
      );
      statusAfter = rec.status;
    }
  }
```

(Behavior-identical: same demote-only targets, same balance_paid→deposit_paid autopay disarm. The overpayment fields are unused on the refund path — a refund is the money-OUT correction.)

- [ ] **Step 5: Run the helper test + the existing refund suite (regression guard)**

Run: `node --test server/utils/proposalStatus.test.js`
Expected: PASS.

Run: `node --test server/utils/refundHelpers.test.js`
Expected: PASS (unchanged behavior).

- [ ] **Step 6: Lint + commit**

Run: `npx eslint server/utils/proposalStatus.js server/utils/refundHelpers.js`
Expected: clean.

```bash
git add server/utils/proposalStatus.js server/utils/proposalStatus.test.js server/utils/refundHelpers.js
git commit -m "refactor(gratuity): extract reconcileProposalPaymentStatus shared helper"
```

---

## Task 5: Recompute pass-through + bidirectional reconcile + overpayment log

> **Cluster A** — ship with Tasks 3, 7, 13.

**Files:**
- Modify: `server/routes/proposals/crud.js` (create ~236, update ~554, demotion ~594-621)
- Modify: `server/routes/proposals/metadata.js` (preview ~74)
- Modify: `server/routes/proposals/public.js` (preview ~89, book ~341)
- Modify: `server/routes/drinkPlans.js` (persist ~325)
- Modify: `server/routes/proposals/crud.test.js`

- [ ] **Step 1: Write the failing tests (using the real harness)**

The suite has `request(method, path, {token, body})`, `makeFreshAdmin()`, `insertDraftProposal({status, total_price, payment_type})` (direct insert, bypasses the rate limiter), `validHostedBody(overrides)`, `trackResponse(res)`, and `createdProposalIds`. Append:

```js
test('PATCH preserves the Gratuity line across an unrelated edit', async () => {
  const token = await makeFreshAdmin();
  const id = await insertDraftProposal({ status: 'draft' }); // hosted pkg, 120 guests, 4h
  // Seed a gratuity rate directly, then PATCH an unrelated field to force a recompute.
  await pool.query('UPDATE proposals SET gratuity_rate = 25, tip_jar = true WHERE id = $1', [id]);
  const r1 = await request('PATCH', `/api/proposals/${id}`, { token, body: { guest_count: 120 } });
  assert.equal(r1.status, 200);
  let snap = (await pool.query('SELECT pricing_snapshot FROM proposals WHERE id=$1', [id])).rows[0].pricing_snapshot;
  assert.ok(snap.breakdown.some(l => l.label === 'Gratuity'), 'gratuity present after first recompute');
  const r2 = await request('PATCH', `/api/proposals/${id}`, { token, body: { event_location: 'New Venue' } });
  assert.equal(r2.status, 200);
  snap = (await pool.query('SELECT pricing_snapshot FROM proposals WHERE id=$1', [id])).rows[0].pricing_snapshot;
  assert.ok(snap.breakdown.some(l => l.label === 'Gratuity'), 'gratuity preserved on unrelated edit');
});

test('PATCH dropping total below amount_paid demotes status + logs overpayment', async () => {
  const token = await makeFreshAdmin();
  const id = await insertDraftProposal({ status: 'draft', total_price: 2000 });
  await pool.query("UPDATE proposals SET status='balance_paid', amount_paid = total_price WHERE id=$1", [id]);
  const r = await request('PATCH', `/api/proposals/${id}`, {
    token, body: { adjustments: [{ type: 'discount', label: 'Goodwill', amount: 100000, visible: true }] },
  });
  assert.equal(r.status, 200);
  const row = (await pool.query('SELECT status FROM proposals WHERE id=$1', [id])).rows[0];
  assert.notEqual(row.status, 'balance_paid'); // demoted (now underpaid) OR overpaid-flagged
  const log = await pool.query(
    "SELECT 1 FROM proposal_activity_log WHERE proposal_id=$1 AND action='overpayment_detected'", [id]);
  assert.ok(log.rowCount >= 1, 'overpayment_detected logged');
});
```

(Note: `insertDraftProposal` inserts a HOSTED pkg @ 120 guests/4h ⇒ 2 bartenders, so `gratuity_rate 25` ⇒ a $200 Gratuity line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: FAIL — gratuity dropped on the unrelated edit / no overpayment log.

- [ ] **Step 3: crud.js — thread gratuity into the UPDATE recompute (admin entry point)**

Add `tip_jar`, `gratuity_total` to the PATCH body destructure (alongside `adjustments`, `total_price_override`). Update the requires at the top:

```js
const { calculateProposal, deriveGratuityRate, computeGratuityBasis } = require('../../utils/pricingEngine');
const { reconcileProposalPaymentStatus } = require('../../utils/proposalStatus');
```

BEFORE the update `const snapshot = calculateProposal({...})` (~line 554):

```js
    // Gratuity (§3/§4/§7): admin may pass tip_jar + a dollar gratuity_total; else
    // keep the stored rate/jar. staffCount+hours are independent of gratuity, so
    // compute the basis first, derive the rate, then snapshot with that rate.
    const resolvedTipJar = tip_jar !== undefined ? (tip_jar !== false) : (old.tip_jar !== false);
    let resolvedGratuityRate = Number(old.gratuity_rate) || 0;
    let gratuityOrigin = old.gratuity_rate_change_origin || null;
    if (tip_jar !== undefined || gratuity_total !== undefined) {
      const { staffCount, hours } = computeGratuityBasis({
        pkg, guestCount: gc, durationHours: dh, numBartenders: num_bartenders, addons,
      });
      const effTipJar = (staffCount * hours) <= 0 ? true : resolvedTipJar;
      const enteredTotal = gratuity_total !== undefined
        ? gratuity_total
        : resolvedGratuityRate * staffCount * hours; // re-derive total from the stored rate
      const g = deriveGratuityRate({ enteredTotal, staffCount, hours, tipJar: effTipJar });
      if (!g.ok) throw new ValidationError({ gratuity: g.message });
      if (g.rate !== resolvedGratuityRate) gratuityOrigin = 'admin'; // direct rate change
      resolvedGratuityRate = g.rate;
    }
```

Pass it to the snapshot call:

```js
    const snapshot = calculateProposal({
      pkg, guestCount: gc, durationHours: dh, numBars: nb,
      numBartenders: num_bartenders, addons, syrupSelections: syrups,
      adjustments: adj, totalPriceOverride: tpo,
      gratuityRate: resolvedGratuityRate, tipJar: resolvedTipJar,
    });
```

Add the three columns to the `UPDATE proposals SET ...` statement. The current statement ends at `class_options = $25`; append:

```sql
        tip_jar = $26,
        gratuity_rate = $27,
        gratuity_rate_change_origin = $28
```

and append to the params array (after the current last param):

```js
      , resolvedTipJar, resolvedGratuityRate, gratuityOrigin
```

- [ ] **Step 4: crud.js — replace the one-way demotion with the shared reconcile + overpayment log**

Replace the block at ~line 594-621 (`const newTotalCents = ...; if (old.status === 'balance_paid' && newTotalCents > paidCents) { ... }`) with:

```js
    // Keep payment status honest after a price move in EITHER direction (§6),
    // and surface a durable overpayment signal for the admin refund flow.
    const rec = reconcileProposalPaymentStatus({
      status: old.status, amountPaid: old.amount_paid, totalPrice: snapshot.total,
    });
    if (rec.changed) {
      const demoted = await dbClient.query(
        rec.autopayDisarmed
          ? `UPDATE proposals SET status=$1, autopay_enrolled=false, autopay_status=NULL WHERE id=$2 RETURNING *`
          : `UPDATE proposals SET status=$1 WHERE id=$2 RETURNING *`,
        [rec.status, req.params.id]
      );
      updatedRow.rows[0] = demoted.rows[0];
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'status_changed', 'admin', $2, $3)`,
        [req.params.id, req.user.id, JSON.stringify({
          from: old.status, to: rec.status, reason: 'price change reconciled', new_total: snapshot.total,
        })]
      );
    }
    if (rec.overpaid) {
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'overpayment_detected', 'admin', $2, $3)`,
        [req.params.id, req.user.id, JSON.stringify({
          amount_paid: Number(old.amount_paid), total_price: snapshot.total, overpaid_cents: rec.overpaidCents,
        })]
      );
    }
```

- [ ] **Step 5: crud.js create — explicit defaults (no behavior change)**

At the create `calculateProposal({...})` (~line 236), add `gratuityRate: 0, tipJar: true`. No INSERT change (columns default via the schema).

- [ ] **Step 6: drinkPlans.js — preserve the stored gratuity on the post-booking recompute**

`drinkPlans.js` loads the proposal via `SELECT * ... FOR UPDATE` (~line 220), so `proposal.gratuity_rate`/`proposal.tip_jar` are in scope. At the recompute (~line 325) add:

```js
            gratuityRate: proposal.gratuity_rate, tipJar: proposal.tip_jar,
```

- [ ] **Step 7: metadata.js — admin preview reflects an entered gratuity**

`metadata.js` `POST /calculate` (handler ~line 45; `calculateProposal` ~line 74). Add `tip_jar, gratuity_total` to the body destructure, extend the require to include `deriveGratuityRate, computeGratuityBasis`, and derive a preview rate before the call:

```js
  let previewRate = 0;
  const previewTipJar = tip_jar !== false;
  if (gratuity_total !== undefined) {
    const { staffCount, hours } = computeGratuityBasis({
      pkg: pkgResult.rows[0], guestCount: guest_count || 50,
      durationHours: duration_hours || 4, numBartenders: num_bartenders, addons,
    });
    const g = deriveGratuityRate({ enteredTotal: gratuity_total, staffCount, hours, tipJar: previewTipJar });
    if (!g.ok) throw new ValidationError({ gratuity: g.message });
    previewRate = g.rate;
  }
```

and add to the `calculateProposal({...})` args: `gratuityRate: previewRate, tipJar: previewTipJar`.

- [ ] **Step 8: public.js — preview + book stay default-inert**

Add `gratuityRate: 0, tipJar: true` to both `calculateProposal({...})` calls (~line 89 calculate, ~line 341 book). No other change.

- [ ] **Step 9: Run the tests**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS.

Run: `node --test server/utils/pricingEngine.test.js`
Expected: PASS.

- [ ] **Step 10: Lint + commit** (Review checkpoint: `code-review` + `consistency-check`)

Run: `npx eslint server/routes/proposals/crud.js server/routes/proposals/metadata.js server/routes/proposals/public.js server/routes/drinkPlans.js`
Expected: clean.

```bash
git add server/routes/proposals/crud.js server/routes/proposals/metadata.js server/routes/proposals/public.js server/routes/drinkPlans.js server/routes/proposals/crud.test.js
git commit -m "feat(gratuity): thread gratuity through recompute sites + bidirectional status reconcile"
```

---

## Task 6: Split `stripe.js` (extract create-intent + shared helpers) — pure refactor

> **Why:** `stripe.js` is **1720 lines, over the 1000-line hard cap.** Task 7 adds ~70 lines to the create-intent route, which the pre-commit ratchet would BLOCK. This task moves the create-intent route (and the helpers it shares) into their own files, SHRINKING `stripe.js`, so Task 7's additions land in a fresh, well-under-cap file. Behavior-inert. **Cluster B.**

**Files:**
- Create: `server/utils/stripeRouteHelpers.js`
- Create: `server/routes/stripeCreateIntent.js`
- Modify: `server/routes/stripe.js`

- [ ] **Step 1: Extract the shared helpers**

Create `server/utils/stripeRouteHelpers.js` with the three things create-intent shares with the rest of `stripe.js`. Move `DEPOSIT_AMOUNT` (stripe.js:39), `eventLabelFor` (stripe.js:28-30), and `getOrCreateCustomer` (stripe.js:48-81) here verbatim, wiring their imports:

```js
const { pool } = require('../db');
const { getStripe } = require('./stripeClient');
const { getEventTypeLabel } = require('./eventTypes');

const DEPOSIT_AMOUNT = parseInt(process.env.STRIPE_DEPOSIT_AMOUNT, 10) || 10000; // $100.00

function eventLabelFor(row) {
  return getEventTypeLabel({ event_type: row?.event_type, event_type_custom: row?.event_type_custom });
}

// (paste getOrCreateCustomer(proposal) verbatim from stripe.js:48-81)
async function getOrCreateCustomer(proposal) { /* …verbatim… */ }

module.exports = { DEPOSIT_AMOUNT, eventLabelFor, getOrCreateCustomer };
```

- [ ] **Step 2: Move the create-intent route into its own sub-router**

Create `server/routes/stripeCreateIntent.js`. Move the entire `router.post('/create-intent/:token', ...)` handler (stripe.js:85-202) verbatim into a fresh router, importing what it needs:

```js
const express = require('express');
const { pool } = require('../db');
const { publicLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, NotFoundError, ConflictError, ExternalServiceError } = require('../utils/errors');
const { getStripe } = require('../utils/stripeClient');
const { getBookingWindow } = require('../utils/bookingWindow');
const { DEPOSIT_AMOUNT, eventLabelFor, getOrCreateCustomer } = require('../utils/stripeRouteHelpers');

const router = express.Router();

// POST /api/stripe/create-intent/:token — public, token-gated
router.post('/create-intent/:token', publicLimiter, asyncHandler(async (req, res) => {
  // …moved handler body verbatim (Task 7 will edit it)…
}));

module.exports = router;
```

- [ ] **Step 3: Update `stripe.js` to import + mount, and delete the moved code**

In `server/routes/stripe.js`: delete the local `eventLabelFor`, `DEPOSIT_AMOUNT`, `getOrCreateCustomer` definitions and the create-intent handler; import the helpers from `stripeRouteHelpers` where other routes still use them; and mount the sub-router:

```js
const { DEPOSIT_AMOUNT, eventLabelFor, getOrCreateCustomer } = require('../utils/stripeRouteHelpers');
// …after `const router = express.Router();`:
router.use(require('./stripeCreateIntent'));
```

(Keep every OTHER route in `stripe.js` exactly as-is — they now consume the helpers via the import.)

- [ ] **Step 4: Verify the move is behavior-inert**

Run: `npx eslint server/routes/stripe.js server/routes/stripeCreateIntent.js server/utils/stripeRouteHelpers.js`
Expected: clean (no unused vars, no missing imports).

Run: `node -e "require('./server/routes/stripe'); console.log('stripe router loads');"`
Expected: `stripe router loads` (catches a broken require/mount).

Run: `npm run check:filesize`
Expected: `server/routes/stripe.js` is now well below its prior 1720 (≈1550) and shrinking — no RED growth.

Manual smoke (dev server up): `POST /api/stripe/create-intent/:token` for a payable proposal still returns `{ clientSecret }`.

- [ ] **Step 5: Commit** (Review checkpoint: `code-review` light + `consistency-check`)

```bash
git add server/utils/stripeRouteHelpers.js server/routes/stripeCreateIntent.js server/routes/stripe.js
git commit -m "refactor(stripe): extract create-intent route + shared helpers (clears file-size cap)"
```

---

## Task 7: Checkout create-intent — persist + recompute + intent + cancel-on-change

> **Cluster A + B.** Edits the file created in Task 6.

**Files:**
- Modify: `server/routes/stripeCreateIntent.js`

- [ ] **Step 1: Extend the SELECT + requires**

Add the gratuity + snapshot columns to the proposal SELECT (the `SELECT p.id, p.status, ...` block):

```sql
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price,
           p.event_date, p.event_start_time, p.event_duration_hours,
           p.stripe_customer_id, p.deposit_amount,
           p.pricing_snapshot, p.gratuity_rate, p.tip_jar,
           c.email AS client_email, c.name AS client_name
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.token = $1
```

Add to requires:

```js
const { ValidationError } = require('../utils/errors');
const { deriveGratuityRate, gratuityBasisFromSnapshot, recomputeSnapshotGratuity } = require('../utils/pricingEngine');
```

(Confirm `ValidationError` is imported — add it to the existing errors destructure if not already there.)

- [ ] **Step 2: Read the gratuity body + persist/recompute in a transaction**

Extend the body destructure:

```js
  const { payment_option = 'deposit', autopay = false, tip_jar, gratuity_total } = req.body;
  const gratuityProvided = tip_jar !== undefined || gratuity_total !== undefined;
```

After the status + booking-window guards and BEFORE `const isFullPay = ...`, insert:

```js
  // §6: persist the client's gratuity choice + recompute total_price in one
  // transaction so the PaymentIntent amount is built from the JUST-WRITTEN total
  // (removes the old TOCTOU). Skipped on the initial intent fetch (no gratuity in
  // body) — that path charges the already-stored total.
  //
  // No reconcileProposalPaymentStatus call here BY DESIGN: this route is gated to
  // status sent/viewed/accepted (the guards just above), all of which have
  // amount_paid = 0, so a gratuity change can never make amount_paid > total_price.
  if (gratuityProvided) {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      const lockRes = await dbClient.query(
        `SELECT pricing_snapshot, event_duration_hours, gratuity_rate, tip_jar, total_price
           FROM proposals WHERE id = $1 FOR UPDATE`,
        [proposal.id]
      );
      const row = lockRes.rows[0];
      const snap = row.pricing_snapshot || {};
      const { staffCount, hours } = gratuityBasisFromSnapshot(snap, row.event_duration_hours);
      const effTipJar = (staffCount * hours) <= 0 ? true : (tip_jar !== false);
      const g = deriveGratuityRate({
        enteredTotal: gratuity_total !== undefined ? gratuity_total : 0,
        staffCount, hours, tipJar: effTipJar,
      });
      if (!g.ok) { await dbClient.query('ROLLBACK'); throw new ValidationError({ gratuity: g.message }); }
      const newSnap = recomputeSnapshotGratuity(snap, {
        gratuityRate: g.rate, tipJar: effTipJar,
        staffNoun: snap.staff_noun, durationHours: row.event_duration_hours,
      });
      await dbClient.query(
        `UPDATE proposals SET tip_jar = $1, gratuity_rate = $2,
                pricing_snapshot = $3, total_price = $4, updated_at = NOW()
           WHERE id = $5`,
        [effTipJar, g.rate, JSON.stringify(newSnap), newSnap.total, proposal.id]
      );
      await dbClient.query('COMMIT');
      proposal.total_price = newSnap.total;     // use the just-written total below
      proposal.pricing_snapshot = newSnap;
    } catch (e) {
      try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw e;
    } finally {
      dbClient.release();
    }
  }
```

(Stripe network calls stay OUTSIDE the transaction, mirroring payrollAccrual's discipline.)

- [ ] **Step 3: Cancel a stale prior intent when the amount changed**

`amount` is computed (from `proposal.total_price`, now possibly rewritten). Replace the reuse block with:

```js
  const existing = await pool.query(
    "SELECT stripe_payment_intent_id, amount FROM stripe_sessions WHERE proposal_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [proposal.id]
  );
  if (existing.rows[0] && existing.rows[0].amount === amount && !gratuityProvided) {
    try {
      const intent = await stripe.paymentIntents.retrieve(existing.rows[0].stripe_payment_intent_id);
      if (intent.status === 'requires_payment_method' || intent.status === 'requires_confirmation') {
        return res.json({
          clientSecret: intent.client_secret,
          total_price: Number(proposal.total_price),
          gratuity: (proposal.pricing_snapshot && proposal.pricing_snapshot.gratuity) || null,
        });
      }
    } catch (e) { /* intent no longer valid — fall through to create a new one */ }
  }
  // Stale-intent safety (§6): a prior pending intent whose amount no longer
  // matches must be cancelled so a stale browser tab can't confirm the old total.
  if (existing.rows[0] && existing.rows[0].amount !== amount) {
    try { await stripe.paymentIntents.cancel(existing.rows[0].stripe_payment_intent_id); } catch (e) { /* already gone/uncancelable */ }
    await pool.query(
      "UPDATE stripe_sessions SET status = 'canceled' WHERE stripe_payment_intent_id = $1",
      [existing.rows[0].stripe_payment_intent_id]
    );
  }
```

- [ ] **Step 4: Return the new total + gratuity**

Change the final `res.json({ clientSecret: paymentIntent.client_secret });` to:

```js
  res.json({
    clientSecret: paymentIntent.client_secret,
    total_price: Number(proposal.total_price),
    gratuity: (proposal.pricing_snapshot && proposal.pricing_snapshot.gratuity) || null,
  });
```

- [ ] **Step 5: Manual verification (server)**

Dev server up, with a payable token (substitute real values):

`node -e "const a=require('axios'); a.post(process.env.API_URL+'/api/stripe/create-intent/TOKEN',{payment_option:'full',tip_jar:false,gratuity_total:10}).then(r=>console.log(r.data)).catch(e=>console.log(e.response?.status,e.response?.data));"`
Expected: `400` with `{ gratuity: 'Without a tip jar, gratuity must be at least $...' }`.

Then post a valid full-pay gratuity and confirm `total_price` rose; re-post a DIFFERENT `gratuity_total` and assert the prior session was cancelled:

`node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT status, amount FROM stripe_sessions WHERE proposal_id=PID ORDER BY created_at DESC LIMIT 3\").then(r=>{console.log(r.rows); return pool.end();});"`
Expected: the superseded row shows `status = 'canceled'`.

- [ ] **Step 6: Lint + commit** (Review checkpoint: `security-review` + `code-review`)

Run: `npx eslint server/routes/stripeCreateIntent.js`
Expected: clean.

```bash
git add server/routes/stripeCreateIntent.js
git commit -m "feat(gratuity): checkout persists + recomputes gratuity total before charging, cancels stale intent"
```

---

## Task 8: Payroll — pool both labels + funded-accrual gate

> **Important:** the funded gate changes what the EXISTING `payrollAccrual.test.js` fixtures accrue (the seeded proposal's `amount_paid` defaults to 0 < its `total_price` 1000, so gratuity would now gate to 0 and break the current assertions). Step 4 updates the seeder to a funded state so the existing assertions hold; the new tests then exercise the gate explicitly.

**Files:**
- Modify: `server/utils/payrollMath.js`, `server/utils/payrollAccrual.js`
- Modify: `server/utils/payrollMath.test.js`, `server/utils/payrollAccrual.test.js`, `server/routes/admin/payroll.test.js`
- Modify (if needed): `client/src/pages/PaydayProtocols.js` (staff FAQ copy)

- [ ] **Step 1: Write the failing extractor tests**

In `server/utils/payrollMath.test.js`, add:

```js
test('extractGratuityCents sums BOTH Shared Gratuity and Gratuity lines (pooled)', () => {
  const snap = { breakdown: [
    { label: 'Shared Gratuity', amount: 50 },
    { label: 'Gratuity', amount: 200 },
    { label: 'Bar Rental', amount: 50 },
  ]};
  assert.strictEqual(extractGratuityCents(snap), 25000); // (50+200)*100
});

test('extractGratuityCents still extracts an old single-label snapshot', () => {
  assert.strictEqual(extractGratuityCents({ breakdown: [{ label: 'Shared Gratuity', amount: 100 }] }), 10000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/utils/payrollMath.test.js`
Expected: FAIL — the `Gratuity` line isn't summed yet.

- [ ] **Step 3: Extend `extractGratuityCents` + add the funded gate**

`server/utils/payrollMath.js` — add near the top:

```js
const { GRATUITY_PAYROLL_LABELS } = require('./gratuityLabels');
```

Change the loop condition from `line.label === 'Shared Gratuity'` to:

```js
    if (line && GRATUITY_PAYROLL_LABELS.includes(line.label)) {
```

(Update the function doc to say it sums the pooled label set.)

`server/utils/payrollAccrual.js` — add `amount_paid` to the proposal SELECT (~line 57-60):

```js
    `SELECT id, event_date, status, event_duration_hours, total_price, amount_paid, pricing_snapshot
       FROM proposals WHERE id = $1`,
```

Where `grossGratuity` is computed (~line 143), gate it:

```js
    // Funded-gratuity-accrual gate (§8): the gratuity pool only accrues when the
    // proposal is paid in full. Wages are NEVER gated (staff worked → staff paid).
    // Covers BOTH the auto-complete and manual (lifecycle.js) completion paths —
    // both funnel through this function.
    const totalCentsFunded = Math.round(Number(proposal.total_price || 0) * 100);
    const paidCentsFunded = Math.round(Number(proposal.amount_paid || 0) * 100);
    const gratuityFunded = paidCentsFunded >= totalCentsFunded;
    const grossGratuity = gratuityFunded ? extractGratuityCents(proposal.pricing_snapshot) : 0;
```

- [ ] **Step 4: Update the existing accrual fixture to a FUNDED state**

In `server/utils/payrollAccrual.test.js` `beforeEach`, set the seeded proposal funded so the existing gratuity assertions (10000c, 9680c, the split test) still hold under the gate. Change the INSERT to include `amount_paid` equal to `total_price`:

```js
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, amount_paid, pricing_snapshot)
     VALUES (NULL, CURRENT_DATE, 'completed', 'birthday-party', '6:00 PM', 4, 1000, 1000,
             '{"breakdown":[{"label":"Shared Gratuity","amount":100}]}')
     RETURNING id`
```

Then add the two gate tests:

```js
test('manual completion of a partially-paid event accrues wages but $0 gratuity', async () => {
  await pool.query('UPDATE proposals SET amount_paid = 100 WHERE id = $1', [proposalId]); // underpaid
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents, pe.wage_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`, [userId]);
  assert.equal(rows[0].gratuity_share_cents, 0);
  assert.ok(rows[0].wage_cents > 0, 'wages still accrue when underpaid');
});

test('a fully-paid event accrues the pooled gratuity', async () => {
  // beforeEach already seeds amount_paid = total_price (funded).
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`, [userId]);
  assert.equal(rows[0].gratuity_share_cents, 10000);
});
```

(The gate lives inside `accruePayoutsForProposal`, so these unit tests cover BOTH completion paths — `lifecycle.js` and `balanceScheduler.js` only differ in WHO calls accrue.)

- [ ] **Step 5: Audit + fix the third fixture**

`server/routes/admin/payroll.test.js:53` seeds a `'Shared Gratuity'` snapshot. If that suite calls `accruePayoutsForProposal` and asserts a non-zero gratuity, its proposal must also be funded (`amount_paid >= total_price`); if it only asserts the extractor/report and never accrues, no change. Read the suite, and if it accrues, add `amount_paid` = `total_price` to that fixture.

- [ ] **Step 6: Paystub / FAQ copy (§8)**

The paystub PDF already prints a `Gratuity` row (`paystubPdf.js:101`) fed by `gratuity_share_cents`, so the pooled figure flows in with no PDF change. Check `client/src/pages/PaydayProtocols.js` (the staff pay FAQ) for copy that describes gratuity as a single-source / per-event figure; if it implies gratuity is only the forced surcharge, update the wording to "pooled gratuity" (no em dashes per the copy rule). If no such copy exists, note "FAQ copy already neutral — no change."

- [ ] **Step 7: Run the payroll suites one at a time (shared dev DB)**

Run: `node --test server/utils/payrollMath.test.js`
Run: `node --test server/utils/payrollAccrual.test.js`
Run: `node --test server/routes/admin/payroll.test.js`
Expected: all PASS.

- [ ] **Step 8: Lint + commit** (Review checkpoint: `code-review` + `consistency-check` + `database-review`)

Run: `npx eslint server/utils/payrollMath.js server/utils/payrollAccrual.js`
Expected: clean.

```bash
git add server/utils/payrollMath.js server/utils/payrollAccrual.js server/utils/payrollMath.test.js server/utils/payrollAccrual.test.js server/routes/admin/payroll.test.js
git commit -m "feat(gratuity): payroll pools both labels and gates gratuity accrual on funded"
```

(If PaydayProtocols.js changed, commit it separately: `git add client/src/pages/PaydayProtocols.js && git commit -m "docs(gratuity): staff FAQ reflects pooled gratuity"`.)

---

## Task 9: Invoice — emit the Gratuity line (B1)

**Files:**
- Modify: `server/utils/invoiceHelpers.js`
- Create: `server/utils/invoiceHelpers.gratuity.test.js`

> Note: the forced `"Shared Gratuity"` surcharge is intentionally NOT broken out here — it stays bundled into the `"Additional Bartender(s)"` invoice line via `snap.staffing.total` (current behavior). Only the client gratuity gets its own line.

- [ ] **Step 1: Write the failing test**

`server/utils/invoiceHelpers.gratuity.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { generateLineItemsFromProposal } = require('./invoiceHelpers');
const { pool } = require('../db');

test('invoice line items include a Gratuity line when gratuity > 0', async () => {
  const snap = { package: { name: 'BYOB', base_cost: 1000 }, staffing: { extra: 0, total: 0 },
    bar_rental: { total: 0 }, syrups: { total: 0 }, adjustments: [],
    gratuity: { rate: 25, tip_jar: true, staff_count: 1, hours: 4, total: 100 } };
  const r = await pool.query(
    `INSERT INTO proposals (pricing_snapshot, total_price, status, tip_jar, gratuity_rate)
     VALUES ($1, 1100, 'sent', true, 25) RETURNING id`, [JSON.stringify(snap)]);
  const id = r.rows[0].id;
  try {
    const items = await generateLineItemsFromProposal(id);
    const grat = items.find(i => i.description === 'Gratuity');
    assert.ok(grat, 'Gratuity line present');
    assert.strictEqual(grat.line_total, 10000);
  } finally {
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
});

test('no Gratuity line when gratuity is 0', async () => {
  const snap = { package: { name: 'BYOB', base_cost: 1000 }, staffing: { extra: 0, total: 0 },
    bar_rental: { total: 0 }, syrups: { total: 0 }, adjustments: [],
    gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 4, total: 0 } };
  const r = await pool.query(
    `INSERT INTO proposals (pricing_snapshot, total_price, status) VALUES ($1, 1000, 'sent') RETURNING id`,
    [JSON.stringify(snap)]);
  const id = r.rows[0].id;
  try {
    const items = await generateLineItemsFromProposal(id);
    assert.ok(!items.some(i => i.description === 'Gratuity'));
  } finally {
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/utils/invoiceHelpers.gratuity.test.js`
Expected: FAIL — no Gratuity line.

- [ ] **Step 3: Add the gratuity branch**

In `generateLineItemsFromProposal`, after the Syrups block and before the Adjustments block (~line 156):

```js
  // Gratuity (§10 B1). Built from snapshot SHAPE (snap.gratuity), since this
  // function never reads breakdown labels. total_price already includes it, so
  // this only makes the client-paid gratuity visible on the invoice.
  if (snap.gratuity && snap.gratuity.total > 0) {
    const lineTotal = toCents(snap.gratuity.total);
    items.push({
      description: 'Gratuity',
      quantity: 1,
      unit_price: lineTotal,
      line_total: lineTotal,
      source_type: 'fee',
      source_id: null,
    });
  }
```

- [ ] **Step 4: Run + commit**

Run: `node --test server/utils/invoiceHelpers.gratuity.test.js`
Expected: PASS.

Run: `npx eslint server/utils/invoiceHelpers.js`

```bash
git add server/utils/invoiceHelpers.js server/utils/invoiceHelpers.gratuity.test.js
git commit -m "feat(gratuity): emit a Gratuity invoice line from the proposal snapshot"
```

---

## Task 10: Client label surfaces + display resolver

**Files:**
- Modify: `client/src/components/PricingBreakdown.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`
- Modify: `client/src/pages/admin/ProposalCreate.js`
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js`
- Modify: `client/src/pages/website/ClassWizard.js`

> The `ProposalView.js` gratuity line lives in Task 11 (it already heavily edits that file) to avoid two tasks touching it.

- [ ] **Step 1: PricingBreakdown.js**

Add `import { resolveGratuityDisplayLabel } from '../utils/gratuityLabels';` and change `{item.label}` (line ~20) to `{resolveGratuityDisplayLabel(item.label, snapshot)}`.

- [ ] **Step 2: ProposalPricingBreakdown.js**

This renders `lineItems` (built by ProposalView) and `item.label` at line ~63; it already receives `snapshot` as a prop. Add `import { resolveGratuityDisplayLabel } from '../../../components/gratuityLabels';` — wait, the shared util is at `client/src/utils/gratuityLabels.js`; from `client/src/pages/proposal/proposalView/` that is `../../../utils/gratuityLabels`. Add the import and change `{item.label}` to `{resolveGratuityDisplayLabel(item.label, snapshot)}`.

- [ ] **Step 3: ProposalCreate.js**

Add `import { resolveGratuityDisplayLabel } from '../../utils/gratuityLabels';`. The preview map (~line 1247) uses `breakdown.map(...)` with the preview snapshot in scope as `preview` (confirmed). Change the row to:

```jsx
            {breakdown.map((item, i) => (
              <Row key={i} label={resolveGratuityDisplayLabel(item.label, preview)} value={item.amount} />
            ))}
```

- [ ] **Step 4: QuoteWizard.js**

Add `import { resolveGratuityDisplayLabel } from '../../../utils/gratuityLabels';`. At ~line 742 change `<span>{item.label}</span>` to `<span>{resolveGratuityDisplayLabel(item.label, preview)}</span>`.

- [ ] **Step 5: ClassWizard.js — reconcile the regex to the frozen staff_noun**

Add `import { resolveGratuityDisplayLabel } from '../../utils/gratuityLabels';`. Replace the blanket regex at ~line 511:

```jsx
                        <span>{resolveGratuityDisplayLabel(item.label, preview)
                          .replace(/bartender/gi, preview?.staff_noun === 'instructor' ? 'instructor' : 'bartender')}</span>
```

(Noun swap is now driven by the snapshot's frozen `staff_noun` instead of assuming a class; the resolver handles the gratuity disambiguation.)

- [ ] **Step 6: Re-confirm the "breakdown emails" no-op (§10)**

Search the codebase for any email template iterating a pricing breakdown: grep `server/` for `breakdown` and for `pricing_snapshot` inside files matching `*mail*`/`*Template*`. Expected: only `payrollMath.js` (extractor) and the unrelated ccImport count — i.e. NO client breakdown email. Record the result in the commit body. (If one is found, apply `resolveGratuityDisplayLabel` there too and add it to this task.)

- [ ] **Step 7: Verify the client build + commit**

Run (PowerShell): `$env:CI='true'; npm run build`
Expected: clean build.

```bash
git add client/src/components/PricingBreakdown.js client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js client/src/pages/admin/ProposalCreate.js client/src/pages/website/quoteWizard/QuoteWizard.js client/src/pages/website/ClassWizard.js
git commit -m "feat(gratuity): client breakdown surfaces use the shared label resolver"
```

---

## Task 11: Client checkout UI — the jar choice + gratuity amount

> **Cluster B.** Adds the gratuity line to `ProposalView`'s `lineItems` (moved here from Task 10) plus the full checkout chooser.

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js`

- [ ] **Step 1: ProposalView — gratuity line in `lineItems`**

In the `lineItems` builder (~line 280-310), after the adjustments `forEach`, before the close of the `if (snapshot && snapshot.package)` block:

```js
    if (snapshot.gratuity && snapshot.gratuity.total > 0) {
      lineItems.push({ label: 'Gratuity', amount: snapshot.gratuity.total });
    }
```

- [ ] **Step 2: ProposalView — gratuity state + intent round-trip**

Add state near the payment state (~line 39):

```js
  const [tipJar, setTipJar] = useState(true);
  const [gratuityTotal, setGratuityTotal] = useState(0);
  const [gratuityDirty, setGratuityDirty] = useState(false);
```

Initialize from the loaded snapshot (in the proposal-load effect, after `setProposal`):

```js
      const g = data?.pricing_snapshot?.gratuity;
      if (g) { setTipJar(g.tip_jar !== false); setGratuityTotal(Number(g.total) || 0); }
```

In the consolidated intent effect (~line 111-156), include the gratuity when dirty and adopt the server's authoritative total. Replace the `axios.post(...)` body and success handling:

```js
        const res = await axios.post(`${BASE_URL}/stripe/create-intent/${token}`, {
          payment_option: option,
          autopay,
          ...(gratuityDirty ? { tip_jar: tipJar, gratuity_total: gratuityTotal } : {}),
        });
        if (cancelled) return;
        if (typeof res.data.total_price === 'number') {
          setProposal(p => p ? { ...p,
            total_price: res.data.total_price,
            pricing_snapshot: { ...(p.pricing_snapshot || {}), gratuity: res.data.gratuity } } : p);
        }
        if (option === 'full') setFullSecret(res.data.clientSecret);
        else { setDepositSecret(res.data.clientSecret); depositIntentAutopayRef.current = autopay; }
```

Add `tipJar, gratuityTotal, gratuityDirty` to the effect's dependency array. A gratuity change must invalidate BOTH cached secrets (full amount changes; deposit must re-persist) — add:

```js
  useEffect(() => {
    if (!gratuityDirty) return;
    setDepositSecret(''); setFullSecret('');
  }, [tipJar, gratuityTotal, gratuityDirty]);
```

Compute the UI basis after `const totalPrice = ...` (~line 269):

```js
  const gratuityBasis = snapshot?.gratuity || null;
  const gratuityStaffCount = gratuityBasis?.staff_count ?? 0;
  const gratuityHours = gratuityBasis?.hours ?? 0;
  const gratuityStaffNoun = gratuityBasis?.staff_noun || 'bartender';
  const gratuityEnabled = gratuityStaffCount * gratuityHours > 0;
  const gratuitySuggested = Math.round(25 * gratuityStaffCount * gratuityHours);
  const gratuityFloor = Math.round(50 * gratuityStaffCount * gratuityHours);
```

Pass these to BOTH `<SignAndPaySection ... />` render sites: `tipJar, setTipJar, gratuityTotal, setGratuityTotal, setGratuityDirty, gratuityEnabled, gratuitySuggested, gratuityFloor, gratuityStaffNoun`.

- [ ] **Step 3: SignAndPaySection — render the chooser before the payment tablets**

Add the new props to the signature. Inside the `{/* Payment Options */}` block, BEFORE `How would you like to pay?`, insert (signAndPay mode; mirror for payOnly if desired):

```jsx
        {gratuityEnabled && (
          <div className="gratuity-chooser" style={{ marginBottom: '1rem' }}>
            <label className="sign-pay-eyebrow">Tip jar at the bar?</label>
            <div className="payment-tablet-row" role="radiogroup" aria-label="Tip jar">
              <label><input type="radio" name="tipJar" checked={tipJar}
                onChange={() => { setTipJar(true); setGratuityDirty(true); }} /> Keep it</label>
              <label style={{ marginLeft: '1rem' }}><input type="radio" name="tipJar" checked={!tipJar}
                onChange={() => {
                  setTipJar(false); setGratuityDirty(true);
                  setGratuityTotal(g => Math.max(Number(g) || 0, gratuityFloor));
                }} /> Skip it</label>
            </div>

            <label className="sign-pay-eyebrow" style={{ marginTop: '0.6rem', display: 'block' }}>
              {tipJar ? 'Add a gratuity?' : `Gratuity for your ${gratuityStaffNoun}s:`}
            </label>
            <div className="hstack" style={{ gap: 8, alignItems: 'center' }}>
              {tipJar && (
                <>
                  <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => { setGratuityTotal(0); setGratuityDirty(true); }}>No</button>
                  <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => { setGratuityTotal(gratuitySuggested); setGratuityDirty(true); }}>
                    ${gratuitySuggested} (suggested)
                  </button>
                </>
              )}
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }}>$</span>
                <input className="sign-pay-input" type="number" min={tipJar ? 0 : gratuityFloor} step="1"
                  value={gratuityTotal}
                  onChange={(e) => { setGratuityTotal(e.target.value); setGratuityDirty(true); }}
                  style={{ paddingLeft: 18, width: 130 }} />
              </div>
            </div>
            {!tipJar && Number(gratuityTotal) < gratuityFloor && (
              <p className="payment-policy-warn" role="alert">
                Without a tip jar, gratuity must be at least ${gratuityFloor}.
              </p>
            )}
          </div>
        )}
```

The "Pay in Full" tablet's `amount={fmt(totalPrice)}` already reflects the server-updated total, and `loadingIntent` hides the form during the refetch — satisfying §4's "New total updates only after server confirmation" + loading state.

- [ ] **Step 4: Verify the client build**

Run (PowerShell): `$env:CI='true'; npm run build`
Expected: clean build.

- [ ] **Step 5: Manual verification (browser)**

With the dev server + a payable proposal: (a) toggling the jar or changing the amount updates the "Pay in Full" total **only after** the network round-trip; (b) a jar-only toggle (no amount change) still refetches and BOTH tablets refresh (deposit secret invalidated); (c) the no-jar floor warning blocks below-floor; (d) "No" with the jar kept removes the gratuity; (e) the chooser is hidden when staffCount × hours is 0 (TBD-duration event).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/proposal/proposalView/SignAndPaySection.js client/src/pages/proposal/proposalView/ProposalView.js
git commit -m "feat(gratuity): client checkout tip-jar + gratuity chooser with server-confirmed total"
```

---

## Task 12: Admin gratuity control (ProposalDetailEditForm + EventEditForm)

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailEditForm.js`
- Modify: `client/src/pages/admin/EventEditForm.js`

- [ ] **Step 1: ProposalDetailEditForm — fields + control block**

Seed `editForm` from the proposal (where it initializes):

```js
  tip_jar: proposal?.pricing_snapshot?.gratuity?.tip_jar !== false,
  gratuity_total: Number(proposal?.pricing_snapshot?.gratuity?.total) || 0,
```

Derive the basis from the form's live `/calculate` preview snapshot (the variable already in scope, here called `preview`):

```js
  const gBasis = preview?.gratuity || null;
  const gEnabled = (gBasis?.staff_count ?? 0) * (gBasis?.hours ?? 0) > 0;
  const gFloor = Math.round(50 * (gBasis?.staff_count ?? 0) * (gBasis?.hours ?? 0));
  const gNoun = gBasis?.staff_noun || 'bartender';
```

Render near the Adjustments / Total-override section (~line 540-578):

```jsx
        <div className="meta-k" style={{ marginBottom: 8 }}>Gratuity</div>
        <div style={{ marginBottom: 12 }}>
          {gEnabled ? (
            <>
              <label className="hstack" style={{ gap: 6 }}>
                <input type="checkbox" checked={editForm.tip_jar !== false}
                  onChange={e => update('tip_jar', e.target.checked)} /> Tip jar at the bar
              </label>
              <div className="hstack" style={{ gap: 6, marginTop: 6 }}>
                <span>Pre-paid gratuity for {gNoun}s $</span>
                <input className="input" type="number"
                  min={editForm.tip_jar !== false ? 0 : gFloor} step="1"
                  value={editForm.gratuity_total}
                  onChange={e => update('gratuity_total', e.target.value)} style={{ width: 120 }} />
              </div>
              {editForm.tip_jar === false && Number(editForm.gratuity_total) < gFloor && (
                <p className="chip danger" style={{ marginTop: 6 }}>Without a tip jar, minimum is ${gFloor}.</p>
              )}
            </>
          ) : (
            <p className="tiny" style={{ color: 'var(--ink-3)' }}>
              Gratuity unavailable until staffing + duration are set.
            </p>
          )}
        </div>
```

Ensure `handleSave` includes `tip_jar` + `gratuity_total` in the PATCH body, and that the live-preview `/calculate` POST forwards them so the preview total reflects the gratuity.

- [ ] **Step 2: EventEditForm — pass-through**

Add `tip_jar` + `gratuity_total` to whatever payload `EventEditForm.js` forwards (mirror exactly how it threads `adjustments`). No derivation here.

- [ ] **Step 3: Verify build + manual**

Run (PowerShell): `$env:CI='true'; npm run build` — clean.

Manual: (a) admin sets a gratuity on a proposal → preview shows the Gratuity line, save raises `total_price`; (b) control disables when duration/staffing is unset; (c) no-jar below-floor save is rejected by the server with the floor message; (d) edit a CONVERTED event via EventEditForm and confirm the gratuity persists.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/ProposalDetailEditForm.js client/src/pages/admin/EventEditForm.js
git commit -m "feat(gratuity): admin gratuity control on proposal/event edit"
```

---

## Task 13: Post-payment guard + staffing-change notification + change-origin

> **Cluster A.** Closes the money window opened by Task 5's wider admin PATCH.

**Files:**
- Modify: `server/routes/proposals/crud.js`
- Modify: `server/utils/emailTemplates.js`
- Modify: `server/routes/proposals/crud.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `crud.test.js`:

```js
test('post-payment direct admin gratuity RATE increase is rejected', async () => {
  const token = await makeFreshAdmin();
  const id = await insertDraftProposal({ status: 'draft', total_price: 2000 });
  await pool.query("UPDATE proposals SET status='deposit_paid', amount_paid=100, gratuity_rate=25, tip_jar=true WHERE id=$1", [id]);
  const r = await request('PATCH', `/api/proposals/${id}`, { token, body: { gratuity_total: 100000 } });
  assert.equal(r.status, 400);
});

test('post-payment staffing-driven gratuity increase is allowed (rate unchanged)', async () => {
  const token = await makeFreshAdmin();
  const id = await insertDraftProposal({ status: 'draft', total_price: 2000 });
  await pool.query("UPDATE proposals SET status='deposit_paid', amount_paid=100, gratuity_rate=25, tip_jar=true WHERE id=$1", [id]);
  const r = await request('PATCH', `/api/proposals/${id}`, { token, body: { guest_count: 250 } });
  assert.equal(r.status, 200); // 120->250 guests => more bartenders, same rate
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: FAIL — the rate hike isn't rejected.

- [ ] **Step 3: Add the post-payment guard (crud update)**

Right after the gratuity-rate resolution block (Task 5 Step 3) and BEFORE `calculateProposal`:

```js
    // Post-payment gratuity guard (§7). Once money is collected (amount_paid > 0)
    // a DIRECT admin RATE increase is a new charge → rejected (a separate
    // client-consented flow is out of scope). A staffing-driven increase at the
    // SAME rate is allowed and triggers a client notice.
    const isPaid = Number(old.amount_paid || 0) > 0;
    const oldRate = Number(old.gratuity_rate) || 0;
    let notifyStaffingGratuity = false;
    if (isPaid) {
      if (gratuityOrigin === 'admin' && resolvedGratuityRate > oldRate) {
        throw new ValidationError({
          gratuity: 'Gratuity rate cannot be increased after payment. Adjust staffing, or arrange a separate client-consented charge.',
        });
      }
      if (resolvedGratuityRate === oldRate && oldRate > 0) gratuityOrigin = 'staffing';
    }
```

After `const snapshot = calculateProposal({...})`, detect a real staffing-driven rise:

```js
    const oldGratuityTotal = Number(old.pricing_snapshot?.gratuity?.total) || 0;
    const newGratuityTotal = Number(snapshot.gratuity?.total) || 0;
    if (isPaid && gratuityOrigin === 'staffing' && newGratuityTotal > oldGratuityTotal) {
      notifyStaffingGratuity = true;
    }
```

- [ ] **Step 4: Send the staffing-change email (post-commit, best-effort)**

Confirm `sendEmail` + `emailTemplates` are imported in `crud.js`; add the requires if missing. After the transaction COMMIT (with the other post-commit notifications):

```js
    if (notifyStaffingGratuity) {
      try {
        const full = await pool.query(
          `SELECT p.total_price, p.pricing_snapshot, c.email AS client_email, c.name AS client_name
             FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
          [req.params.id]
        );
        const row = full.rows[0];
        if (row?.client_email) {
          await sendEmail({
            to: row.client_email,
            ...emailTemplates.gratuityStaffingChange({
              name: row.client_name,
              newTotal: Number(row.total_price),
              gratuity: row.pricing_snapshot?.gratuity || null,
            }),
          });
        }
      } catch (mailErr) {
        console.error('Gratuity staffing-change email failed (non-blocking):', mailErr);
      }
    }
```

- [ ] **Step 5: Add the email template**

In `server/utils/emailTemplates.js`, add `gratuityStaffingChange({ name, newTotal, gratuity })` returning `{ subject, html, text }` in the file's existing style. Copy: LEAD with "your gratuity rate hasn't changed" — the crew grew, so the gratuity TOTAL changed, but the per-staff RATE they agreed to did not; then show the new total + new gratuity figure (minimizes client friction). Email (not SMS) per the notification-cost preference. No em dashes.

- [ ] **Step 6: Run + commit** (Review checkpoint: `security-review` + `code-review`)

Run: `node --test server/routes/proposals/crud.test.js` — PASS.
Run: `npx eslint server/routes/proposals/crud.js server/utils/emailTemplates.js` — clean.

```bash
git add server/routes/proposals/crud.js server/utils/emailTemplates.js server/routes/proposals/crud.test.js
git commit -m "feat(gratuity): post-payment guard for admin rate hikes + staffing-change client email"
```

---

## Task 14: Admin overpayment flag

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js`

- [ ] **Step 1: Add the derived overpayment chip**

`ProposalDetailPaymentPanel.js` is the panel that renders the "Paid in full" chip. Add a derived warning when `amount_paid > total_price` (the durable signal logged by Task 5):

```jsx
{Number(proposal.amount_paid) > Number(proposal.total_price) && (
  <div className="chip danger" title="Issue a refund to correct the overpayment">
    Overpaid ${(Number(proposal.amount_paid) - Number(proposal.total_price)).toFixed(2)} — issue a refund
  </div>
)}
```

Place it next to the existing payment-status chip; if the panel already has a refund action, link/scroll to it.

- [ ] **Step 2: Verify build + manual matrix + commit**

Run (PowerShell): `$env:CI='true'; npm run build` — clean.

Manual matrix on the admin proposal detail (money-display feature — confirm both states):
- An OVERPAID proposal (`amount_paid > total_price` — reproduce via a Task 5 price-down on a fully-paid proposal) shows the "Overpaid $X — issue a refund" chip.
- A normally fully-paid proposal (`amount_paid == total_price`) does NOT show the chip.

```bash
git add client/src/pages/admin/ProposalDetailPaymentPanel.js
git commit -m "feat(gratuity): admin overpayment flag on the proposal payment panel"
```

---

## Task 15: BEO surface (tip jar + pre-paid gratuity)

**Files:**
- Modify: `server/routes/beo.js`
- Modify: `client/src/components/staff/BeoSections.js`
- Modify: `client/src/pages/staff/ShiftDetail.js`

- [ ] **Step 1: beo.js — select + expose the gratuity fields**

Extend the proposal SELECT (~line 57-69) to add (reading the frozen `staff_noun` as a single JSON field, NOT the whole snapshot):

```sql
            p.tip_jar, p.gratuity_rate,
            (p.pricing_snapshot->>'staff_noun') AS staff_noun,
```

In the `res.json({ proposal: { ... } })` block (~line 219-232), add:

```js
      tip_jar: p.tip_jar !== false,
      gratuity_prepaid: Number(p.gratuity_rate) > 0,
      staff_noun: p.staff_noun || 'bartender',
```

- [ ] **Step 2: BeoSections.js — a small gratuity/tips card**

Add a presentational export mirroring the file's `sp-card` pattern:

```jsx
export function GratuityTipsCard({ tipJar, gratuityPrepaid, staffNoun }) {
  return (
    <div className="sp-card tight">
      <div className="sp-card-head"><div className="sp-card-title">Gratuity &amp; tips</div></div>
      <div className="sp-row">
        <span>Tip jar</span>
        <span>{tipJar ? 'Yes — set out a tip jar' : 'No tip jar requested'}</span>
      </div>
      <div className="sp-row">
        <span>Pre-paid gratuity</span>
        <span>{gratuityPrepaid ? `Yes — gratuity pre-paid for the ${staffNoun}s` : 'None'}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: ShiftDetail.js — render the card**

`ShiftDetail.js` composes the `BeoSections` cards from the BEO payload. Import `GratuityTipsCard` and render it among the other cards, passing the new fields:

```jsx
<GratuityTipsCard
  tipJar={beo.proposal.tip_jar}
  gratuityPrepaid={beo.proposal.gratuity_prepaid}
  staffNoun={beo.proposal.staff_noun}
/>
```

(Confirm the BEO payload variable name in `ShiftDetail.js` — it fetches `/api/beo/:proposalId`; use whatever it stores the response in.)

- [ ] **Step 4: Run the BEO test + build**

Run: `node --test server/routes/beo.test.js` — PASS (add a field assertion if the suite snapshots the response shape).
Run (PowerShell): `$env:CI='true'; npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add server/routes/beo.js client/src/components/staff/BeoSections.js client/src/pages/staff/ShiftDetail.js
git commit -m "feat(gratuity): surface tip jar + pre-paid gratuity on the BEO"
```

---

## Task 16: Documentation

**Files:**
- Modify: `ARCHITECTURE.md`, `README.md`, `.claude/CLAUDE.md`

- [ ] **Step 1: ARCHITECTURE.md** — gratuity model under proposal/pricing + payroll: the `tip_jar` / `gratuity_rate` / `gratuity_rate_change_origin` columns, the snapshot `gratuity` / `staff_noun` / `display_labels` fields, the layering on the forced surcharge, the funded-accrual gate, the pooled payroll extraction, and the new `server/routes/stripeCreateIntent.js` + `server/utils/stripeRouteHelpers.js` + `server/utils/gratuityLabels.js` + `server/utils/proposalStatus.js` files in the route/util tables.

- [ ] **Step 2: README.md** — add "Checkout gratuity" to Key Features if a feature list exists; add the new files to the folder-structure tree.

- [ ] **Step 3: CLAUDE.md cross-cutting bullet** — under Cross-Cutting Consistency (sibling to the hosted-bartender rule):

> **Checkout gratuity** — gratuity is stored as a per-staff-per-hour RATE (`gratuity_rate`), the dollar line is always computed (`rate × staffCount × hours`, staff = bartenders + additional-bartender addon, NOT barbacks/servers), layered on top of the forced `"Shared Gratuity"` surcharge. It is added on top of `total_price` (never diluted by a discount/override), pooled with the forced surcharge in payroll (both labels extracted via `gratuityLabels.GRATUITY_PAYROLL_LABELS`), and gated on funded before accrual. Applies to all packages via `staff_noun`. Labels come from the one shared constant module (`gratuityLabels.js`, server + client mirror). The linking rule (no jar ⇒ rate ≥ 50) is enforced at the route, in the engine (`deriveGratuityRate`), and by a DB CHECK. Grep `gratuityLineAmount` / `GRATUITY_LABEL` before touching gratuity.

- [ ] **Step 4: Verify + commit**

Confirm each doc actually mentions the feature (30-second checkpoint matching the rigor elsewhere):

Run: `grep -l "gratuity_rate" ARCHITECTURE.md README.md .claude/CLAUDE.md`
Expected: all three listed (CLAUDE.md via the cross-cutting bullet; ARCHITECTURE/README via the model + folder-tree entries).

```bash
git add ARCHITECTURE.md README.md .claude/CLAUDE.md
git commit -m "docs(gratuity): architecture, readme, cross-cutting rule"
```

---

## Final verification (run before declaring complete)

- [ ] **All server tests pass, run per-suite (shared dev DB):**
  - `node --test server/utils/gratuityLabels.test.js`
  - `node --test server/utils/pricingEngine.test.js`
  - `node --test server/utils/proposalStatus.test.js`
  - `node --test server/utils/refundHelpers.test.js`
  - `node --test server/utils/payrollMath.test.js`
  - `node --test server/utils/payrollAccrual.test.js`
  - `node --test server/utils/invoiceHelpers.gratuity.test.js`
  - `node --test server/routes/proposals/crud.test.js`
  - `node --test server/routes/admin/payroll.test.js`
  - `node --test server/routes/beo.test.js`
- [ ] **Lint:** `npm run lint` clean.
- [ ] **Client build:** `$env:CI='true'; npm run build` clean.
- [ ] **File-size ratchet:** `npm run check:filesize` — `stripe.js` shrank (Task 6); confirm no NEW red and that `crud.js` (was 797, yellow) did not cross the 1000 hard cap (if it did, extract the gratuity resolution into a helper or split the route file first).
- [ ] **End-to-end (browser + dev server):** client picks jar/gratuity → total updates after server confirm → signs → pays full → invoice shows the Gratuity line → admin marks completed → payroll accrues pooled gratuity (only when fully paid).
- [ ] **Cluster integrity:** Cluster A (Tasks 3,5,7,13) and Cluster B (Tasks 6,7,11) each land in one push (Batch & Sequencing section).

---

## Manual staging verification — Stripe webhook (before production)

The `payment_intent.succeeded` change (commit a22e022: additive `amount_paid` + derived status, never `= total_price`) is verified by DB simulation but has **no automated test** (no local `STRIPE_WEBHOOK_SECRET_TEST`; the live payment handler was deliberately not refactored at merge time per "protect working money paths"). The tracked follow-up is to extract the webhook handler into a testable module (it also pays down `stripe.js`, still RED over the 1000-line cap). Until then, confirm these on staging with a real Stripe test event for each:

- [ ] **Full payment** → `proposals.amount_paid` equals the amount actually charged; status `balance_paid`.
- [ ] **Deposit** → status `deposit_paid`; a Balance invoice is created.
- [ ] **Balance payment** → status `balance_paid`.
- [ ] **Idempotent retry** (Stripe re-delivers the same event) → `amount_paid` is NOT double-credited (the `proposal_payments` ON CONFLICT gate).
- [ ] **Race / overpay** (edit the total UP between charge and webhook) → records the charged amount, status resolves to `deposit_paid` with the shortfall owed (NOT a false "paid in full"); admin overpaid chip shows if `amount_paid > total_price`.
- [ ] **Refund below total** then complete the event → payroll accrues wages but **$0 gratuity** (funded gate; also unit-tested).

---

## Self-review against the spec

- **§3 model** → Task 2 (engine), Task 3 (columns). ✅
- **§4 client presentation** → Task 11 (jar choice, suggested 25×, floor 50×, server-confirmed total, disabled at staffCount×hours≤0). ✅
- **§5 engine + 6 recompute sites** → Task 2 + Task 5 (crud create/update, metadata, public×2, drinkPlans) + Task 7 (7th = create-intent surgical recompute). ✅
- **§6 money flow / persistence / overpayment** → Task 7 (transactional persist+recompute+intent+cancel) + Task 4/5 (bidirectional reconcile + overpayment log) + Task 14 (admin flag). ✅
- **§7 two entry points / consent / notification** → Task 12 (admin) + Task 13 (post-payment guard + change-origin + staffing email). ✅
- **§8 payroll pool + funded gate** → Task 8 (incl. fixture corrections + FAQ copy). ✅
- **§9 BEO** → Task 15 (proposal row + staff_noun JSON; null-safe via defaults). ✅
- **§10 invoice line + label strategy + W9** → Task 9 (invoice line) + Task 1/10 (shared constant + resolver + frozen display_labels); "breakdown emails" / "admin-payroll views" documented as verified no-ops. ✅
- **§11 data model** → Task 3 (3 columns + 2 CHECKs + sanity SELECT + stripe_sessions canceled; rollback noted). ✅
- **§12 testing** → unit + DB tests across Tasks 1-9, 13, 15; migration sanity SELECT; client build. ✅
- **§13 files touched** → mapped in File Structure. ✅
- **§14 docs** → Task 16. ✅
- **§15 out of scope** → distribution split, forced-label rename, Project A, on-site cash: none implemented. ✅

**Decomposition self-check:** logical-feature commits, each with a verifiable checkpoint; cross-task safety captured in Batch & Sequencing (Clusters A/B); forward dependencies eliminated (every task is no-op-safe on existing data until its consumer lands); the one file-size blocker resolved (Task 6 splits `stripe.js` before Task 7 grows it).

**Type/name consistency:** `gratuityLineAmount`, `deriveGratuityRate`, `computeGratuityBasis`, `gratuityBasisFromSnapshot`, `recomputeSnapshotGratuity`, `getStaffNoun`, `reconcileProposalPaymentStatus`, `resolveGratuityDisplayLabel`, `GRATUITY_PAYROLL_LABELS`, `GRATUITY_LABEL`/`SHARED_GRATUITY_LABEL`, snapshot fields `gratuity`/`staff_noun`/`display_labels`, columns `tip_jar`/`gratuity_rate`/`gratuity_rate_change_origin` — used identically across every task.
