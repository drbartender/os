# Hosted Package-Aware Menu Planner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Potion Planning Lab aware of the client's hosted package — hide steps that duplicate package decisions, add a package recap, surface a "not in your package" upgrade badge on cocktail cards, auto-add specialty-ingredient add-ons on select with a toast, and suppress add-ons already covered by the package.

**Architecture:** Data-driven. New `service_packages.covered_addon_slugs TEXT[]` and `cocktails.upgrade_addon_slugs TEXT[]` columns decide what to hide and what to charge. Client logic lives in a new pure helper `client/src/pages/plan/data/packageGaps.js`. Server pricing-engine gains sibling helpers. Three `PotionPlanningLab` steps are replaced by a new `HostedGuestPrefsStep` when the detected package is hosted.

**Tech Stack:** Node.js / Express 4.18 (server), React 18 CRA (client), PostgreSQL via `pg` (raw SQL, no ORM), Jest via react-scripts (client tests), no root test runner (server verified via running app).

**Spec:** `docs/superpowers/specs/2026-04-23-hosted-package-menu-planner-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/db/schema.sql` | Modify | Add 2 columns, 5 specialty addons, seed `covered_addon_slugs` + `upgrade_addon_slugs`, NA-beer copy cleanup |
| `server/utils/pricingEngine.js` | Modify | Export `computeCocktailGap`, `packageSuppressedAddons`, `isCocktailFullyCovered` |
| `server/routes/drinkPlans.js` | Modify | Extend GET SELECT; reconcile `autoAdded` addons on PUT submit; log `specialty_upgrades` |
| `client/src/pages/plan/data/packageGaps.js` | Create | Pure helpers mirroring server (no DB) |
| `client/src/pages/plan/data/packageGaps.test.js` | Create | Jest tests for the helpers |
| `client/src/pages/plan/PotionPlanningLab.js` | Modify | Propagate package context; skip dead steps in hosted refinement; route to HostedGuestPrefsStep |
| `client/src/pages/plan/data/servingTypes.js` | Modify | `buildStepQueue` takes a `hostedContext` flag; emits the new step |
| `client/src/pages/plan/steps/HostedGuestPrefsStep.js` | Create | Replaces 3 killed steps — one compact card |
| `client/src/pages/plan/steps/RefinementWelcomeStep.js` | Modify | Add package recap card |
| `client/src/pages/plan/steps/SignaturePickerStep.js` | Modify | Gap badges on cards, auto-addon wiring, toast, nested Your-Menu display, remove mixer radio on hosted |
| `client/src/pages/plan/steps/MakeItYoursPanel.js` | Modify | Filter out addons already covered by package |
| `client/src/pages/plan/steps/MocktailStep.js` | Modify | Same filter |
| `client/src/pages/plan/steps/LogisticsStep.js` | Modify | Same filter |
| `client/src/pages/plan/steps/ConfirmationStep.js` | Modify | Nest auto-added upgrades under their triggering drink in Estimated Costs |
| `client/src/pages/admin/ProposalDetail.js` | Modify | Auto-added badge + activity-log detail |
| `client/src/pages/admin/CocktailMenuDashboard.js` | Modify | Edit form + add form: `upgrade_addon_slugs` CSV editor |
| `client/src/App.js` | No change expected | — |
| `.claude/CLAUDE.md` | Modify | Folder tree additions (new HostedGuestPrefsStep, new packageGaps.js) |
| `README.md` | Modify | Folder tree additions |
| `docs/ARCHITECTURE.md` | Modify | New schema columns, new helpers, hosted-package-aware flow |

---

## Task 1: Schema additions, specialty add-ons, seed data, NA copy cleanup

**Files:**
- Modify: `server/db/schema.sql`

Idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` + seed INSERT/UPDATE blocks. Added at logical points in the file.

- [ ] **Step 1: Add `covered_addon_slugs` column**

Open `server/db/schema.sql`. Find line 516 (the existing `ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS bar_type ...` line). Right after that line, insert:

```sql
ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS covered_addon_slugs TEXT[] DEFAULT '{}';
```

- [ ] **Step 2: Add `upgrade_addon_slugs` column**

Find line 354 (the existing `ALTER TABLE cocktails ADD COLUMN IF NOT EXISTS ingredients JSONB DEFAULT '[]';`). Right after that line, insert:

```sql
ALTER TABLE cocktails ADD COLUMN IF NOT EXISTS upgrade_addon_slugs TEXT[] DEFAULT '{}';
```

- [ ] **Step 3: Insert the 5 specialty-ingredient add-ons**

Find the existing `INSERT INTO service_addons` block around line 610 (the one with `champagne-coupe-upgrade`, `real-glassware`, `house-made-ginger-beer`, etc.). Append these rows by adding a new `INSERT INTO service_addons ... ON CONFLICT (slug) DO NOTHING;` block immediately after it:

```sql
-- Specialty-ingredient add-ons — auto-added when a selected cocktail's ingredients
-- are not covered by the client's hosted package. Per-guest billing keeps DRB's
-- bring-and-take-back model consistent (flat pricing would imply client keeps bottle).
INSERT INTO service_addons (slug, name, description, billing_type, rate, extra_hour_rate, applies_to, sort_order, minimum_hours, category, requires_addon_slug) VALUES
  ('specialty-bitter-aperitifs', 'Bitter Aperitifs', 'Campari, Aperol, Cynar, and amaro. For Negronis, Boulevardiers, Paper Planes, and anything with a bitter backbone.', 'per_guest', 3.00, NULL, 'all', 35, NULL, 'craft_ingredients', NULL),
  ('specialty-vermouths', 'Vermouth & Fortified Wines', 'Sweet and dry vermouth plus Lillet Blanc. For Manhattans, Martinis, Negronis, and Corpse Revivers.', 'per_guest', 1.50, NULL, 'all', 36, NULL, 'craft_ingredients', NULL),
  ('specialty-niche-liqueurs', 'Specialty Liqueurs', 'Cointreau, green Chartreuse, maraschino, amaretto, orgeat, absinthe, rye whiskey, coffee liqueur — the classic-cocktail modifiers that elevate Sidecars, Last Words, Mai Tais, Sazeracs, and Espresso Martinis.', 'per_guest', 2.50, NULL, 'all', 37, NULL, 'craft_ingredients', NULL),
  ('specialty-mezcal', 'Mezcal', 'Smoky agave spirit for Smokey Piñas and mezcal-forward cocktails.', 'per_guest', 3.00, NULL, 'all', 38, NULL, 'craft_ingredients', NULL),
  ('specialty-cognac', 'Cognac', 'Aged French grape spirit for Sidecars and classic cognac builds.', 'per_guest', 4.00, NULL, 'all', 39, NULL, 'craft_ingredients', NULL)
ON CONFLICT (slug) DO NOTHING;
```

- [ ] **Step 4: Seed `covered_addon_slugs` on hosted packages**

At the bottom of `server/db/schema.sql` (after the existing UPDATE blocks for categories etc., before any final COMMIT or end-of-file markers), append:

```sql
-- Hosted-package coverage: which add-ons the package's base price already includes.
-- Used by the Potion Planning Lab to (a) suppress redundant add-on offers and
-- (b) compute cocktail "gaps" against the package's stocked ingredients.
UPDATE service_packages SET covered_addon_slugs = '{}'                                    WHERE slug = 'the-base-compound';
UPDATE service_packages SET covered_addon_slugs = '{soft-drink-addon}'                     WHERE slug = 'the-midrange-reaction';
UPDATE service_packages SET covered_addon_slugs = '{soft-drink-addon}'                     WHERE slug = 'the-enhanced-solution';
UPDATE service_packages SET covered_addon_slugs = '{soft-drink-addon}'                     WHERE slug = 'formula-no-5';
UPDATE service_packages SET covered_addon_slugs = '{soft-drink-addon,house-made-ginger-beer}' WHERE slug = 'the-grand-experiment';
UPDATE service_packages SET covered_addon_slugs = '{}'                                    WHERE slug = 'the-primary-culture';
UPDATE service_packages SET covered_addon_slugs = '{}'                                    WHERE slug = 'the-refined-reaction';
UPDATE service_packages SET covered_addon_slugs = '{}'                                    WHERE slug = 'the-carbon-suspension';
UPDATE service_packages SET covered_addon_slugs = '{}'                                    WHERE slug = 'the-cultivated-complex';
UPDATE service_packages SET covered_addon_slugs = '{}'                                    WHERE slug = 'the-clear-reaction';
```

- [ ] **Step 5: Seed `upgrade_addon_slugs` on cocktails**

Append immediately below the previous block:

```sql
-- Cocktail ingredient gaps: which specialty add-ons each cocktail needs when
-- the package doesn't cover them. Conservative seed — cheap gaps (grapefruit
-- juice for Paloma, triple sec for Margarita) are absorbed by DRB (empty array).
-- Admin tunes via CocktailMenuDashboard as real cost data comes in.
UPDATE cocktails SET upgrade_addon_slugs = '{house-made-ginger-beer}'                   WHERE id = 'moscow-mule';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-niche-liqueurs}'                 WHERE id = 'espresso-martini';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-bitter-aperitifs}'               WHERE id = 'aperol-spritz';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-cognac,specialty-niche-liqueurs}' WHERE id = 'sidecar';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-vermouths}'                      WHERE id = 'martini';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-vermouths}'                      WHERE id = 'manhattan';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-bitter-aperitifs,specialty-vermouths}' WHERE id = 'negroni';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-niche-liqueurs}'                 WHERE id = 'amaretto-sour';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-mezcal}'                         WHERE id = 'smokey-pina';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-bitter-aperitifs,specialty-vermouths}' WHERE id = 'boulevardier';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-bitter-aperitifs}'               WHERE id = 'black-manhattan';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-niche-liqueurs}'                 WHERE id = 'sazerac';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-niche-liqueurs}'                 WHERE id = 'mai-tai';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-bitter-aperitifs}'               WHERE id = 'paper-plane';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-vermouths,specialty-niche-liqueurs}' WHERE id = 'corpse-reviver';
UPDATE cocktails SET upgrade_addon_slugs = '{specialty-niche-liqueurs}'                 WHERE id = 'last-word';
```

- [ ] **Step 6: NA-beer copy cleanup**

Append one more UPDATE (keeps the Heineken 0.0 reference out per the Athletic-only rule):

```sql
UPDATE service_addons
SET description = 'Non-alcoholic beer from Athletic Brewing — crisp, refreshing, and endorsed by the doctor.'
WHERE slug = 'non-alcoholic-beer';
```

- [ ] **Step 7: Start the server to apply the schema**

Run: `npm run dev`
Expected: Server boots without error. In the startup logs look for the schema init lines — no errors from the new ALTER TABLE / INSERT / UPDATE statements. Stop the server (`Ctrl+C`) once confirmed.

- [ ] **Step 8: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(schema): package coverage + cocktail upgrades + specialty addons"
```

---

## Task 2: Extend drink-plans GET endpoint with package context

**Files:**
- Modify: `server/routes/drinkPlans.js:48-68` (the `/t/:token` GET handler)

The client needs `package_category`, `package_slug`, `package_name`, `package_includes`, `package_covered_addon_slugs` in addition to today's `package_bar_type`.

- [ ] **Step 1: Extend the SELECT**

In `server/routes/drinkPlans.js`, replace the current SELECT (lines 49-63) inside the `GET /t/:token` handler with:

```js
const result = await pool.query(
  `SELECT dp.id, dp.token, dp.client_name, dp.client_email, dp.event_type, dp.event_type_custom, dp.event_date,
          dp.status, dp.serving_type, dp.selections, dp.submitted_at, dp.created_at,
          dp.proposal_id, dp.exploration_submitted_at,
          p.guest_count, p.num_bartenders, p.num_bars, p.pricing_snapshot,
          p.status AS proposal_status,
          p.total_price AS proposal_total_price,
          p.amount_paid AS proposal_amount_paid,
          p.event_date AS proposal_event_date,
          p.balance_due_date AS proposal_balance_due_date,
          sp.bar_type            AS package_bar_type,
          sp.category            AS package_category,
          sp.slug                AS package_slug,
          sp.name                AS package_name,
          sp.includes            AS package_includes,
          sp.covered_addon_slugs AS package_covered_addon_slugs
   FROM drink_plans dp
   LEFT JOIN proposals p ON p.id = dp.proposal_id
   LEFT JOIN service_packages sp ON sp.id = p.package_id
   WHERE dp.token = $1`,
  [req.params.token]
);
```

- [ ] **Step 2: Start the server**

Run: `npm run dev` (server half only is fine — Express listens on 5000)

- [ ] **Step 3: Smoke-test the endpoint**

Find a real drink-plan token in the database. Quickest path: log into the admin dashboard, open any proposal that already has a drink plan, and copy the drink-plan token from the URL or the plan detail page.

Run (substituting `<TOKEN>`):

```bash
curl -s http://localhost:5000/api/drink-plans/t/<TOKEN> | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Object.keys(JSON.parse(s))))"
```

Expected: the list of keys includes `package_category`, `package_slug`, `package_name`, `package_includes`, `package_covered_addon_slugs` in addition to the existing `package_bar_type`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/drinkPlans.js
git commit -m "feat(drink-plans): expose package context + coverage to the planner"
```

---

## Task 3: Server pricing-engine helpers

**Files:**
- Modify: `server/utils/pricingEngine.js`

Add sibling helpers to `isHostedPackage`. They're not used by the server yet (the client computes gaps directly), but they exist for parity + future server-side validation in Task 12.

- [ ] **Step 1: Add the helpers**

In `server/utils/pricingEngine.js`, find the existing `isHostedPackage` function (around line 18). Immediately below the `isHostedPackage` definition and its closing brace, insert:

```js
/**
 * Hosted-package gap helpers — used by the Potion Planning Lab (client) and
 * by the drink-plan submit handler (server) to validate auto-added addons.
 * Load-bearing: do NOT move these away from isHostedPackage — keep them
 * grep-adjacent so anyone touching hosted-package pricing finds both.
 */
function computeCocktailGap(cocktail, pkg) {
  const required = cocktail?.upgrade_addon_slugs || [];
  const covered = pkg?.covered_addon_slugs || [];
  return required.filter(slug => !covered.includes(slug));
}

function packageSuppressedAddons(pkg) {
  return pkg?.covered_addon_slugs || [];
}

function isCocktailFullyCovered(cocktail, pkg) {
  return computeCocktailGap(cocktail, pkg).length === 0;
}
```

- [ ] **Step 2: Export the helpers**

Find the `module.exports` block at the bottom of `server/utils/pricingEngine.js`. Add `computeCocktailGap`, `packageSuppressedAddons`, `isCocktailFullyCovered` alongside the existing exports. If the exports use object shorthand, the result looks like:

```js
module.exports = {
  calculateProposal,
  isHostedPackage,
  computeCocktailGap,
  packageSuppressedAddons,
  isCocktailFullyCovered,
  // ...any other existing exports
};
```

If the file uses individual `module.exports.calculateProposal = ...` style, follow that pattern instead.

- [ ] **Step 3: Verify import**

Run: `node -e "const p = require('./server/utils/pricingEngine'); console.log(typeof p.computeCocktailGap, typeof p.packageSuppressedAddons, typeof p.isCocktailFullyCovered);"`
Expected: `function function function`

- [ ] **Step 4: Commit**

```bash
git add server/utils/pricingEngine.js
git commit -m "feat(pricing): cocktail gap helpers alongside isHostedPackage"
```

---

## Task 4: Client pure helper + tests

**Files:**
- Create: `client/src/pages/plan/data/packageGaps.js`
- Create: `client/src/pages/plan/data/packageGaps.test.js`

Client-side mirror of the server helpers, plus summed-per-guest-rate computation used by the badge UI.

- [ ] **Step 1: Write the failing test**

Create `client/src/pages/plan/data/packageGaps.test.js`:

```js
import {
  computeCocktailGap,
  packageSuppressedAddons,
  isCocktailFullyCovered,
  computeGapCost,
} from './packageGaps';

describe('computeCocktailGap', () => {
  test('returns empty when package covers everything', () => {
    const cocktail = { upgrade_addon_slugs: ['house-made-ginger-beer'] };
    const pkg = { package_covered_addon_slugs: ['soft-drink-addon', 'house-made-ginger-beer'] };
    expect(computeCocktailGap(cocktail, pkg)).toEqual([]);
  });

  test('returns missing slugs when package covers none', () => {
    const cocktail = { upgrade_addon_slugs: ['specialty-bitter-aperitifs', 'specialty-vermouths'] };
    const pkg = { package_covered_addon_slugs: [] };
    expect(computeCocktailGap(cocktail, pkg)).toEqual(['specialty-bitter-aperitifs', 'specialty-vermouths']);
  });

  test('returns partial when package covers some', () => {
    const cocktail = { upgrade_addon_slugs: ['specialty-bitter-aperitifs', 'specialty-vermouths'] };
    const pkg = { package_covered_addon_slugs: ['specialty-vermouths'] };
    expect(computeCocktailGap(cocktail, pkg)).toEqual(['specialty-bitter-aperitifs']);
  });

  test('no-gap cocktail returns empty regardless of package', () => {
    const cocktail = { upgrade_addon_slugs: [] };
    const pkg = { package_covered_addon_slugs: [] };
    expect(computeCocktailGap(cocktail, pkg)).toEqual([]);
  });

  test('handles nulls as empty', () => {
    expect(computeCocktailGap(null, null)).toEqual([]);
    expect(computeCocktailGap({}, {})).toEqual([]);
  });
});

describe('packageSuppressedAddons', () => {
  test('returns covered slugs', () => {
    expect(packageSuppressedAddons({ package_covered_addon_slugs: ['soft-drink-addon'] })).toEqual(['soft-drink-addon']);
  });
  test('returns empty when unset', () => {
    expect(packageSuppressedAddons(null)).toEqual([]);
    expect(packageSuppressedAddons({})).toEqual([]);
  });
});

describe('isCocktailFullyCovered', () => {
  test('true when no gap', () => {
    const cocktail = { upgrade_addon_slugs: ['specialty-vermouths'] };
    const pkg = { package_covered_addon_slugs: ['specialty-vermouths'] };
    expect(isCocktailFullyCovered(cocktail, pkg)).toBe(true);
  });
  test('false when partial gap', () => {
    const cocktail = { upgrade_addon_slugs: ['specialty-vermouths', 'specialty-bitter-aperitifs'] };
    const pkg = { package_covered_addon_slugs: ['specialty-vermouths'] };
    expect(isCocktailFullyCovered(cocktail, pkg)).toBe(false);
  });
});

describe('computeGapCost', () => {
  const addonPricing = [
    { slug: 'specialty-bitter-aperitifs', rate: '3.00', billing_type: 'per_guest' },
    { slug: 'specialty-vermouths', rate: '1.50', billing_type: 'per_guest' },
    { slug: 'house-made-ginger-beer', rate: '2.50', billing_type: 'per_guest' },
  ];

  test('sums per-guest rates for all gap addons', () => {
    const result = computeGapCost(['specialty-bitter-aperitifs', 'specialty-vermouths'], addonPricing, 100);
    expect(result.perGuest).toBe(4.5);
    expect(result.total).toBe(450);
  });

  test('returns zero for empty gap', () => {
    const result = computeGapCost([], addonPricing, 100);
    expect(result.perGuest).toBe(0);
    expect(result.total).toBe(0);
  });

  test('missing guestCount returns per-guest only', () => {
    const result = computeGapCost(['house-made-ginger-beer'], addonPricing, null);
    expect(result.perGuest).toBe(2.5);
    expect(result.total).toBe(null);
  });

  test('ignores unknown slugs', () => {
    const result = computeGapCost(['unknown-slug', 'house-made-ginger-beer'], addonPricing, 50);
    expect(result.perGuest).toBe(2.5);
    expect(result.total).toBe(125);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd client && npx react-scripts test --watchAll=false src/pages/plan/data/packageGaps.test.js`
Expected: FAIL — `Cannot find module './packageGaps'`.

- [ ] **Step 3: Create the implementation**

Create `client/src/pages/plan/data/packageGaps.js`:

```js
/**
 * Pure helpers for hosted-package-aware menu-planner behavior.
 * Mirrors server/utils/pricingEngine.js (computeCocktailGap etc.).
 * No network, no DB — operates on plan data already in React state.
 */

export function computeCocktailGap(cocktail, plan) {
  const required = cocktail?.upgrade_addon_slugs || [];
  const covered = plan?.package_covered_addon_slugs || [];
  return required.filter((slug) => !covered.includes(slug));
}

export function packageSuppressedAddons(plan) {
  return plan?.package_covered_addon_slugs || [];
}

export function isCocktailFullyCovered(cocktail, plan) {
  return computeCocktailGap(cocktail, plan).length === 0;
}

/**
 * Sum per-guest rates for a list of gap slugs against addonPricing.
 * Returns { perGuest, total } — total is null when guestCount is unknown.
 * Unknown slugs are silently skipped.
 */
export function computeGapCost(gapSlugs, addonPricing, guestCount) {
  if (!gapSlugs || gapSlugs.length === 0) {
    return { perGuest: 0, total: guestCount == null ? null : 0 };
  }
  let perGuest = 0;
  for (const slug of gapSlugs) {
    const addon = (addonPricing || []).find((a) => a.slug === slug);
    if (!addon) continue;
    if (addon.billing_type === 'per_guest') {
      perGuest += Number(addon.rate) || 0;
    }
  }
  const total = guestCount == null ? null : perGuest * Number(guestCount);
  return { perGuest, total };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd client && npx react-scripts test --watchAll=false src/pages/plan/data/packageGaps.test.js`
Expected: PASS — all 13 assertions green.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/plan/data/packageGaps.js client/src/pages/plan/data/packageGaps.test.js
git commit -m "feat(plan): packageGaps helper + tests"
```

---

## Task 5: Detect hosted refinement in servingTypes; adjust step queue

**Files:**
- Modify: `client/src/pages/plan/data/servingTypes.js`

Add a `buildHostedStepQueue` that maps directly from `package_bar_type` to a queue, replacing `buildStepQueue` for hosted refinement cases. Keep `buildStepQueue` for BYOB / custom.

- [ ] **Step 1: Add the new builder + constant**

Open `client/src/pages/plan/data/servingTypes.js`. At the bottom, immediately before `export function derivePhase(proposalStatus) {`, insert:

```js
// Hosted-package step for guest preferences — replaces the old spirits/beer-wine
// steps when the client is on a hosted package (spirits/beer/wine are fixed by the package).
export const HOSTED_GUEST_PREFS_STEP = 'stepHostedGuestPrefs';

/**
 * Build the refinement step queue for a client on a hosted package.
 * Bar type (from service_packages.bar_type) determines the queue directly —
 * no QuickPick, no spirits/beer-wine selection.
 */
export function buildHostedStepQueue(barType) {
  const queue = [];
  if (barType === 'full_bar') {
    queue.push(MODULE_STEP_MAP.signatureDrinks);
    queue.push(MODULE_STEP_MAP.mocktails);
  } else if (barType === 'beer_and_wine') {
    queue.push(MODULE_STEP_MAP.mocktails);
  } else if (barType === 'mocktail') {
    queue.push(MODULE_STEP_MAP.mocktails);
  }
  queue.push(HOSTED_GUEST_PREFS_STEP);
  queue.push(MODULE_STEP_MAP.menuDesign);
  queue.push(MODULE_STEP_MAP.logistics);
  return queue;
}

/** Derive the activeModules flags from a hosted bar_type (for display logic in steps). */
export function hostedActiveModules(barType) {
  return {
    signatureDrinks: barType === 'full_bar',
    mocktails: true,
    fullBar: false,
    beerWineOnly: false,
  };
}
```

- [ ] **Step 2: Quick sanity check**

Run: `cd client && node -e "const s = require('./src/pages/plan/data/servingTypes'); console.log(s.buildHostedStepQueue('full_bar'));"`

Note: this will fail because of ESM import syntax in CRA sources. Skip the smoke test; trust the Jest run in Task 4 plus the next task's integration.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/plan/data/servingTypes.js
git commit -m "feat(plan): hosted refinement step queue builder"
```

---

## Task 6: Wire package context + hosted routing through PotionPlanningLab

**Files:**
- Modify: `client/src/pages/plan/PotionPlanningLab.js`

Store the new package fields in state, pass them to child steps, and route hosted-refinement clients through `buildHostedStepQueue` instead of `buildStepQueue`.

- [ ] **Step 1: Import the new helpers**

At the top of `PotionPlanningLab.js` (around line 7), change:

```js
import { QUICK_PICKS, MODULE_STEP_MAP, buildStepQueue, buildExplorationQueue, derivePhase } from './data/servingTypes';
```

to:

```js
import { QUICK_PICKS, MODULE_STEP_MAP, buildStepQueue, buildExplorationQueue, derivePhase, buildHostedStepQueue, hostedActiveModules, HOSTED_GUEST_PREFS_STEP } from './data/servingTypes';
```

Also add the new step component import near the other step imports:

```js
import HostedGuestPrefsStep from './steps/HostedGuestPrefsStep';
```

- [ ] **Step 2: Add a helper for hosted detection**

Inside the `PotionPlanningLab` component, right after the `const paidFromRedirect = useMemo(...)` block, add:

```js
const isHostedRefinement = useMemo(() => {
  if (!plan) return false;
  if (phase !== 'refinement') return false;
  return plan.package_category === 'hosted';
}, [plan, phase]);
```

- [ ] **Step 3: Use the hosted builder when appropriate**

In the plan-load `useEffect` (inside the `if (derivedPhase === 'refinement')` branch around line 251–264), replace the mocktail-only special-case block with a general hosted-refinement block. Find:

```js
if (!data.serving_type) {
  // Mocktail-only package — auto-select mocktails quick pick
  if (planData.package_bar_type === 'mocktail') {
    const mocktailPick = QUICK_PICKS.find(p => p.key === 'mocktails');
    setQuickPickChoice('mocktails');
    setActiveModules(mocktailPick.activeModules);
    setModuleQueue(buildStepQueue(mocktailPick.activeModules));
  }
  setStep('refinementWelcome');
}
```

and replace with:

```js
if (!data.serving_type) {
  if (planData.package_category === 'hosted') {
    // Hosted package — skip QuickPick, derive queue directly from bar_type
    const barType = planData.package_bar_type || 'full_bar';
    setQuickPickChoice(barType);
    setActiveModules(hostedActiveModules(barType));
    setModuleQueue(buildHostedStepQueue(barType));
  }
  setStep('refinementWelcome');
}
```

- [ ] **Step 4: Short-circuit `handleNext` on welcome for hosted**

Find the `handleNext` function (around line 620). Inside its "Refinement navigation" branch, replace:

```js
if (step === 'welcome' || step === 'refinementWelcome') {
  // Mocktail-only packages skip the quick pick
  if (plan?.package_bar_type === 'mocktail') return goToStep(moduleQueue[0]);
  return goToStep('quickPick');
}
```

with:

```js
if (step === 'welcome' || step === 'refinementWelcome') {
  // Hosted packages skip the QuickPick — queue was pre-built from bar_type.
  if (plan?.package_category === 'hosted') return goToStep(moduleQueue[0]);
  if (plan?.package_bar_type === 'mocktail') return goToStep(moduleQueue[0]);
  return goToStep('quickPick');
}
```

- [ ] **Step 5: Short-circuit `handleBack` on hosted**

In the same file find the `handleBack` function (around line 665). Inside the refinement-back block, replace:

```js
const currentIdx = moduleQueue.indexOf(step);
if (currentIdx !== -1) {
  if (currentIdx > 0) {
    return goToStep(moduleQueue[currentIdx - 1]);
  }
  // Mocktail-only packages skip back to quickPick
  if (plan?.package_bar_type === 'mocktail') {
    return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
  }
  return goToStep(quickPickChoice === 'custom' ? 'customSetup' : 'quickPick');
}
```

with:

```js
const currentIdx = moduleQueue.indexOf(step);
if (currentIdx !== -1) {
  if (currentIdx > 0) {
    return goToStep(moduleQueue[currentIdx - 1]);
  }
  // Hosted packages never show QuickPick; back from first step goes to welcome.
  if (plan?.package_category === 'hosted') {
    return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
  }
  if (plan?.package_bar_type === 'mocktail') {
    return goToStep(plan?.exploration_submitted_at ? 'refinementWelcome' : 'welcome');
  }
  return goToStep(quickPickChoice === 'custom' ? 'customSetup' : 'quickPick');
}
```

- [ ] **Step 6: Add HostedGuestPrefsStep case to `renderStep`**

Find the `renderStep` switch (around line 813). Immediately before the `case MODULE_STEP_MAP.logistics:` case, add:

```js
case HOSTED_GUEST_PREFS_STEP:
  return (
    <HostedGuestPrefsStep
      plan={plan}
      selections={selections}
      onChange={updateSelections}
      addOns={selections.addOns || {}}
      toggleAddOn={toggleAddOn}
      addonPricing={addonPricing}
    />
  );
```

- [ ] **Step 7: Pass the plan down to SignaturePickerStep + ConfirmationStep**

Find the `case MODULE_STEP_MAP.signatureDrinks:` in `renderStep` (around line 886). Add `plan={plan}` to the props:

```js
<SignaturePickerStep
  selected={selections.signatureDrinks}
  // ... existing props ...
  plan={plan}
  onNext={() => handleNext()}
  onBack={() => handleBack()}
  onSkipMocktails={() => handleSkipToAfter(MODULE_STEP_MAP.mocktails)}
/>
```

Similarly for `case 'confirmation':`:

```js
<ConfirmationStep
  plan={plan}
  // ... existing props ...
/>
```

(ConfirmationStep already receives `plan` — confirm the prop line is present. If so, no change needed for ConfirmationStep in this task.)

Similarly add `plan={plan}` to the `case MODULE_STEP_MAP.mocktails:` render block for later use in Task 9's addon suppression:

```js
<MocktailStep
  selected={selections.mocktails || []}
  // ... existing props ...
  plan={plan}
  onNext={() => handleNext()}
  onBack={() => handleBack()}
/>
```

Similarly add `plan={plan}` to the `case MODULE_STEP_MAP.logistics:` render block:

```js
<LogisticsStep
  logistics={selections.logistics}
  // ... existing props ...
  plan={plan}
/>
```

- [ ] **Step 8: Pass `plan` to RefinementWelcomeStep (already does — sanity check)**

`RefinementWelcomeStep` already receives `plan`. Nothing to change.

- [ ] **Step 9: Commit (defer until HostedGuestPrefsStep exists)**

The file now imports `HostedGuestPrefsStep` which doesn't exist yet. Don't commit — move straight to Task 7 to create it, then commit both together.

---

## Task 7: Create HostedGuestPrefsStep

**Files:**
- Create: `client/src/pages/plan/steps/HostedGuestPrefsStep.js`

One compact card with the balance question, plus the NA-interest follow-up on `beer_and_wine` bar type.

- [ ] **Step 1: Create the component**

Create `client/src/pages/plan/steps/HostedGuestPrefsStep.js`:

```js
import React from 'react';

const BALANCE_OPTIONS = [
  { value: 'mostly_beer', label: 'Mostly Beer' },
  { value: 'mostly_cocktails', label: 'Mostly Cocktails' },
  { value: 'mostly_wine', label: 'Mostly Wine' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'help_me_decide', label: 'Help me decide' },
];

const NA_OPTIONS = [
  { value: 'yes', label: 'Yes — some guests won’t drink beer or wine' },
  { value: 'no', label: 'No — beer and wine covers everyone' },
  { value: 'unsure', label: 'Not sure yet' },
];

export default function HostedGuestPrefsStep({
  plan,
  selections,
  onChange,
  addOns = {},
  toggleAddOn,
  addonPricing = [],
}) {
  const prefs = selections.guestPreferences || {};
  const barType = plan?.package_bar_type || 'full_bar';
  const showNaQuestion = barType === 'beer_and_wine';

  const update = (patch) => {
    onChange('guestPreferences', { ...prefs, ...patch });
  };

  // Quick-link to mocktail / NA-beer addons if the client flags NA interest
  const naBeerAddon = addonPricing.find((a) => a.slug === 'non-alcoholic-beer');
  const mocktailAddon = addonPricing.find((a) => a.slug === 'pre-batched-mocktail');
  const naBeerOn = !!addOns['non-alcoholic-beer'];
  const mocktailOn = !!addOns['pre-batched-mocktail'];

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Guest Preferences
        </h2>
        <p className="text-muted">
          Your package is locked in &mdash; this just helps us decide how much of each
          category to actually bring.
        </p>
      </div>

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          What will your guests actually drink?
        </h3>
        <div className="form-group">
          <div className="checkbox-grid">
            {BALANCE_OPTIONS.map((opt) => (
              <label key={opt.value} className="checkbox-label">
                <input
                  type="radio"
                  name="hostedBalance"
                  checked={prefs.balance === opt.value}
                  onChange={() => update({ balance: opt.value })}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {showNaQuestion && (
        <div className="card">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            Non-drinkers?
          </h3>
          <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
            Some of your guests may not drink beer or wine. We can bring mocktails or
            non-alcoholic beer as an optional extra.
          </p>
          <div className="form-group">
            <div className="checkbox-grid">
              {NA_OPTIONS.map((opt) => (
                <label key={opt.value} className="checkbox-label">
                  <input
                    type="radio"
                    name="hostedNaInterest"
                    checked={prefs.naInterest === opt.value}
                    onChange={() => update({ naInterest: opt.value })}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
            {prefs.naInterest === 'yes' && (
              <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                {mocktailAddon && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={mocktailOn}
                      onChange={() => toggleAddOn('pre-batched-mocktail')}
                    />
                    <span>
                      Add a pre-batched mocktail (${Number(mocktailAddon.rate).toFixed(2)}/guest)
                    </span>
                  </label>
                )}
                {naBeerAddon && (
                  <label className="checkbox-label" style={{ marginTop: '0.25rem' }}>
                    <input
                      type="checkbox"
                      checked={naBeerOn}
                      onChange={() => toggleAddOn('non-alcoholic-beer')}
                    />
                    <span>
                      Add non-alcoholic beer (${Number(naBeerAddon.rate).toFixed(2)}/guest)
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Start the dev server and smoke-test**

Run: `npm run dev`

Open a drink-plan URL for a proposal that's on a hosted full-bar package in `deposit_paid` or later status. Verify:
- No QuickPick step appears.
- No spirits / beer-wine selection steps.
- After signature drinks + mocktails, the new Guest Preferences step appears with the balance question.
- Menu Design and Logistics follow.

Also open a drink-plan URL for a BYOB proposal. Verify:
- QuickPick still appears.
- Spirits, beer/wine steps still appear.
- No Guest Preferences step (HostedGuestPrefsStep not rendered).

Stop the server (`Ctrl+C`).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/plan/steps/HostedGuestPrefsStep.js client/src/pages/plan/data/servingTypes.js client/src/pages/plan/PotionPlanningLab.js
git commit -m "feat(plan): hosted refinement skips dead steps, routes to Guest Preferences"
```

---

## Task 8: Package recap card in RefinementWelcomeStep

**Files:**
- Modify: `client/src/pages/plan/steps/RefinementWelcomeStep.js`

- [ ] **Step 1: Read the existing component**

Run: `cat client/src/pages/plan/steps/RefinementWelcomeStep.js` — familiarize with the current layout (copy intro, previously-selected drinks, etc.).

- [ ] **Step 2: Add the recap card**

At the top of the component's returned JSX, before any existing content, insert a new card that renders only when `plan.package_category === 'hosted'` and `plan.package_includes` is a non-empty array. Example placement (adapt to your file's actual JSX structure):

```jsx
{plan?.package_category === 'hosted' && Array.isArray(plan.package_includes) && plan.package_includes.length > 0 && (
  <div className="card mb-2">
    <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
      Your package: {plan.package_name}
    </h3>
    <p className="text-muted text-small" style={{ color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>
      Stocked &amp; ready:
    </p>
    <ul style={{ fontSize: '0.9rem', color: 'var(--deep-brown)', paddingLeft: '1.25rem', margin: 0 }}>
      {plan.package_includes
        .filter((item) => !/\{(hours|bartenders|bartenders_s)\}/.test(item))
        .map((item, i) => (
          <li key={i}>{item}</li>
        ))}
    </ul>
    <p className="text-muted text-small" style={{ marginTop: '0.5rem', fontStyle: 'italic' }}>
      Anything beyond this list is an upgrade.
    </p>
  </div>
)}
```

Note the filter — `package_includes` contains service-term placeholders like `"Up to {hours} hours of bar service"` that we suppress from the recap (these apply to the logistics of service, not consumables the client is choosing among).

- [ ] **Step 3: Smoke-test**

Run: `npm run dev`. Open a hosted-package drink-plan URL. Verify the recap card appears on the Refinement Welcome screen with the package name and bulleted ingredient list. Verify placeholders (`{hours}`, `{bartenders}`) are filtered out.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/plan/steps/RefinementWelcomeStep.js
git commit -m "feat(plan): package recap card on refinement welcome"
```

---

## Task 9: Gap badge, auto-addon, toast in SignaturePickerStep

**Files:**
- Modify: `client/src/pages/plan/steps/SignaturePickerStep.js`

Core UX change. Drink cards show a badge when the drink needs ingredients outside the package; toggling the card on auto-adds the specialty addons with toast confirmation; toggling off unwinds the addon (only if `autoAdded` and no other drinks still trigger it).

- [ ] **Step 1: Import new helpers + toast**

At the top of `SignaturePickerStep.js`, add:

```js
import { computeCocktailGap, computeGapCost } from '../data/packageGaps';
import { useToast } from '../../../context/ToastContext';
```

- [ ] **Step 2: Accept `plan` prop + use toast**

Add `plan` to the component's prop destructuring (near `proposalSyrups`). Inside the component body near the top, add:

```js
const toast = useToast();
const isHostedPlan = plan?.package_category === 'hosted';
```

- [ ] **Step 3: Modify `toggleDrink` to handle gap addons**

Find the `toggleDrink` helper (around line 62). Replace with:

```js
const toggleDrink = (drinkId) => {
  const drink = cocktails.find((c) => c.id === drinkId);
  const gapSlugs = isHostedPlan && drink ? computeCocktailGap(drink, plan) : [];

  if (selected.includes(drinkId)) {
    // Deselecting — remove the drink. Auto-added addons whose triggeredBy becomes
    // empty are pruned by pruneAddOnsForRemovedDrinks (extended in Task 9d).
    onChange(selected.filter((id) => id !== drinkId));
  } else {
    onChange([...selected, drinkId]);
    if (selected.length >= 4) setDismissedWarning(false);

    // Auto-add gap addons with autoAdded flag + triggeredBy provenance
    if (gapSlugs.length > 0 && typeof toggleAddOnForDrink === 'function') {
      const cost = computeGapCost(gapSlugs, addonPricing, guestCount);
      const gapAddonNames = gapSlugs
        .map((slug) => (addonPricing.find((a) => a.slug === slug) || {}).name)
        .filter(Boolean)
        .join(' + ');
      for (const slug of gapSlugs) {
        const pricing = addonPricing.find((a) => a.slug === slug);
        if (!pricing) continue;
        // Use updateAddOnMeta + toggleAddOn to preserve autoAdded/triggeredBy shape.
        // If the addon is already on, we'll re-use updateAddOnMeta to append trigger.
        if (!addOns[slug]) {
          toggleAddOn(slug, { autoAdded: true, triggeredBy: [drinkId] });
        } else {
          const existing = addOns[slug];
          const triggered = Array.isArray(existing.triggeredBy) ? existing.triggeredBy : [];
          updateAddOnMeta(slug, {
            triggeredBy: triggered.includes(drinkId) ? triggered : [...triggered, drinkId],
          });
        }
      }
      toast.success(
        cost.perGuest > 0
          ? `Added ${drink.name} · includes $${cost.perGuest.toFixed(2)}/guest for ${gapAddonNames}.`
          : `Added ${drink.name} · includes ${gapAddonNames}.`
      );
    }
  }
};
```

- [ ] **Step 4: Render the gap badge on drink cards**

Find the drink-list rendering block (around line 501-544, the `filteredDrinks.map(drink => ...)` section with `className="drink-card-horizontal"`). Inside the `.map`, before the `return`, compute gap + cost:

```js
const gapSlugs = isHostedPlan ? computeCocktailGap(drink, plan) : [];
const gapCost = gapSlugs.length > 0 ? computeGapCost(gapSlugs, addonPricing, guestCount) : null;
```

In the JSX inside the card button, just below the `<div className="drink-card-info">`'s closing `</div>`, add the badge:

```jsx
{gapCost && gapCost.perGuest > 0 && (
  <span
    className="drink-gap-badge"
    style={{
      alignSelf: 'center',
      marginLeft: '0.5rem',
      padding: '0.25rem 0.5rem',
      borderRadius: '6px',
      background: 'rgba(193, 125, 60, 0.12)',
      color: 'var(--warm-brown)',
      fontSize: '0.75rem',
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}
    title={`Requires $${gapCost.perGuest.toFixed(2)}/guest for ${gapSlugs.map(s => (addonPricing.find(a => a.slug === s) || {}).name).filter(Boolean).join(' + ')}`}
  >
    +${gapCost.perGuest.toFixed(2)}/guest
  </span>
)}
```

- [ ] **Step 5: Extend `pruneAddOnsForRemovedDrinks` in PotionPlanningLab**

Open `client/src/pages/plan/PotionPlanningLab.js` and find the existing `pruneAddOnsForRemovedDrinks` helper (around line 509). Replace with the following version — it now handles the new `autoAdded` + `triggeredBy` metadata alongside the legacy per-drink `drinks[]` field:

```js
const pruneAddOnsForRemovedDrinks = (addOns, removedIds) => {
  if (!removedIds.length) return addOns;
  const next = { ...addOns };
  for (const slug of Object.keys(next)) {
    const addon = next[slug];
    if (!addon) continue;

    // Legacy per-drink addons (carbonation, smoke, smoke-bubble) — prune drinks[]
    if (Array.isArray(addon.drinks)) {
      const filtered = addon.drinks.filter(d => !removedIds.includes(d));
      if (filtered.length === 0) {
        delete next[slug];
        continue;
      }
      if (filtered.length !== addon.drinks.length) {
        const updated = { ...addon, drinks: filtered };
        if (updated.bubbles) {
          const nextBubbles = { ...updated.bubbles };
          for (const id of removedIds) delete nextBubbles[id];
          updated.bubbles = nextBubbles;
        }
        next[slug] = updated;
      }
    }

    // Auto-added specialty addons — prune triggeredBy[]
    if (Array.isArray(addon.triggeredBy)) {
      const filtered = addon.triggeredBy.filter(d => !removedIds.includes(d));
      if (filtered.length === 0 && addon.autoAdded) {
        delete next[slug];
        continue;
      }
      if (filtered.length !== addon.triggeredBy.length) {
        next[slug] = { ...addon, triggeredBy: filtered };
      }
    }
  }
  return next;
};
```

- [ ] **Step 6: Extend `toggleAddOn` to accept metadata**

In the same file find `toggleAddOn` (around line 441). Replace with:

```js
const toggleAddOn = (slug, metadata = {}) => {
  setSelections(prev => {
    const newAddOns = { ...prev.addOns };
    if (newAddOns[slug]) {
      delete newAddOns[slug];
    } else {
      newAddOns[slug] = { enabled: true, ...metadata };
    }
    return { ...prev, addOns: newAddOns };
  });
};
```

(If the function already accepts metadata — double-check — no change needed.)

- [ ] **Step 7: Smoke-test the full flow**

Run: `npm run dev`. Open a drink-plan URL for a hosted Enhanced Solution proposal:
- Navigate to signature drinks. Verify drink cards for Moscow Mule, Negroni, Manhattan, etc. show the `+$X.XX/guest` badge.
- Tap Moscow Mule. Verify: toast appears reading "Added Moscow Mule · includes $2.50/guest for House-Made Ginger Beer." — `selections.addOns['house-made-ginger-beer']` has `autoAdded: true, triggeredBy: ['moscow-mule']` (inspect via React DevTools or a temporary `console.log`).
- Tap Negroni. Verify toast: "Added Negroni · includes $4.50/guest for Bitter Aperitifs + Vermouth & Fortified Wines."
- Tap Boulevardier (also uses bitter aperitifs + vermouths). Verify the existing addons now have `triggeredBy: ['negroni', 'boulevardier']`.
- Un-tap Negroni. Verify the addons remain (still triggered by Boulevardier).
- Un-tap Boulevardier. Verify both addons are removed.
- Open a drink-plan URL for Grand Experiment and confirm Moscow Mule has NO badge (ginger beer is covered).
- Open a BYOB proposal and confirm no badges appear regardless of package.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/plan/steps/SignaturePickerStep.js client/src/pages/plan/PotionPlanningLab.js
git commit -m "feat(plan): gap badge + auto-addon + toast on hosted signature picker"
```

---

## Task 10: Remove mixer radio on hosted; nest upgrade under drink in Your Menu

**Files:**
- Modify: `client/src/pages/plan/steps/SignaturePickerStep.js`

- [ ] **Step 1: Hide the mixer radio group on hosted**

Find the "Mixer question" block (around line 441). It currently reads:

```jsx
{!isFullBarActive && selectedDrinks.length > 0 && extractedSpirits.length > 0 && (
```

Change the condition to ALSO hide when hosted:

```jsx
{!isHostedPlan && !isFullBarActive && selectedDrinks.length > 0 && extractedSpirits.length > 0 && (
```

- [ ] **Step 2: Render auto-added upgrades nested under each drink in Your Menu**

Find the Your Menu list rendering (around line 176–242). After the existing `drinkFlairUpgrades` extraction and BEFORE the closing `)` of the `.map`, look for the extras block around line 205:

```jsx
{(selectedSyrupDetails.length > 0 || drinkFlairUpgrades.length > 0) && (
  <div className="your-menu-drink-extras">
```

Compute a new list of auto-added upgrades for this drink just below `drinkFlairUpgrades` and before the JSX:

```js
const autoAddedForDrink = Object.entries(addOns)
  .filter(([, meta]) => meta?.autoAdded && Array.isArray(meta.triggeredBy) && meta.triggeredBy.includes(drink.id))
  .map(([slug]) => {
    const pricing = addonPricing.find(a => a.slug === slug);
    return pricing ? { slug, name: pricing.name, rate: Number(pricing.rate), billing_type: pricing.billing_type } : null;
  })
  .filter(Boolean);
```

Then extend the extras-block condition to include this new list:

```jsx
{(selectedSyrupDetails.length > 0 || drinkFlairUpgrades.length > 0 || autoAddedForDrink.length > 0) && (
  <div className="your-menu-drink-extras">
    {selectedSyrupDetails.map(/* existing */)}
    {drinkFlairUpgrades.map(/* existing */)}
    {autoAddedForDrink.map((up) => (
      <span
        key={up.slug}
        className="your-menu-extra-tag"
        title={up.billing_type === 'per_guest' ? `$${up.rate.toFixed(2)}/guest` : `$${up.rate.toFixed(2)}`}
      >
        + {up.name}
        <span className="extra-source-badge drb">
          {up.billing_type === 'per_guest' ? `$${up.rate.toFixed(2)}/guest` : `$${up.rate.toFixed(2)}`}
        </span>
      </span>
    ))}
  </div>
)}
```

Note: `your-menu-extra-tag` and `extra-source-badge drb` already have CSS (used for syrups). The auto-upgrade tag piggybacks on the same styling — no new CSS needed.

- [ ] **Step 3: Smoke-test**

Run: `npm run dev`. On a hosted proposal:
- Verify the "include mixers?" radio group no longer appears on the hosted sig-picker's Your Menu view.
- Select Moscow Mule; verify a "+ House-Made Ginger Beer $2.50/guest" tag appears nested beneath the drink row in Your Menu.
- Select Negroni; verify two tags (Bitter Aperitifs and Vermouth & Fortified) appear under it.
- On a BYOB proposal, verify the mixer radio group still appears.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/plan/steps/SignaturePickerStep.js
git commit -m "feat(plan): hide mixer radio on hosted; nest auto-upgrades under drinks"
```

---

## Task 11: Suppress covered addons in MakeItYoursPanel, MocktailStep, LogisticsStep

**Files:**
- Modify: `client/src/pages/plan/steps/MakeItYoursPanel.js`
- Modify: `client/src/pages/plan/steps/MocktailStep.js`
- Modify: `client/src/pages/plan/steps/LogisticsStep.js`

- [ ] **Step 1: MakeItYoursPanel — filter covered slugs**

Open `client/src/pages/plan/steps/MakeItYoursPanel.js`. It's used from `SignaturePickerStep`, which doesn't currently pass `plan` to the panel. First, add `plan` to MakeItYoursPanel's props (`export default function MakeItYoursPanel({ ..., plan })`). Then in `SignaturePickerStep`, at the two places `MakeItYoursPanel` is rendered, add `plan={plan}`.

Inside `MakeItYoursPanel`, after the existing `const allUpgrades = getUpgradesForDrink(drinkId);` line, add a filter:

```js
const coveredSlugs = plan?.package_covered_addon_slugs || [];
const allUpgradesFiltered = allUpgrades.filter((u) => !coveredSlugs.includes(u.addonSlug));
const featuredAddons = allUpgradesFiltered.filter((u) => u.featured);
const flairUpgrades = allUpgradesFiltered.filter((u) => !u.featured);
```

Replace the existing `featuredAddons` / `flairUpgrades` lines with the filtered versions above. The rest of the file continues to use `allUpgrades` in the `useEffect` dependency check — change that reference to `allUpgradesFiltered` as well (search for `for (const upgrade of allUpgrades)` around line 62 and swap).

- [ ] **Step 2: MocktailStep — filter addons in the step**

Open `client/src/pages/plan/steps/MocktailStep.js`. Accept a `plan` prop (already wired from Task 6). Anywhere MocktailStep iterates `addonPricing` to render addon options, wrap the iteration with a filter:

```js
const coveredSlugs = plan?.package_covered_addon_slugs || [];
const visiblePricing = (addonPricing || []).filter((a) => !coveredSlugs.includes(a.slug));
```

Replace `addonPricing` with `visiblePricing` in the addon-rendering parts (search for `addonPricing.find`, `addonPricing.map`, `addonPricing.filter` inside the file and review each).

- [ ] **Step 3: LogisticsStep — filter champagne-toast and coupe if covered**

Open `client/src/pages/plan/steps/LogisticsStep.js`. Accept `plan` as a prop (already wired in Task 6). At the top of the component body, add:

```js
const coveredSlugs = plan?.package_covered_addon_slugs || [];
```

Wrap the champagne-toast card render (the whole IIFE around line 246–332) in a guard:

```jsx
{!coveredSlugs.includes(CHAMPAGNE_TOAST.addonSlug) && (() => {
  const toastPricing = addonPricing.find(a => a.slug === CHAMPAGNE_TOAST.addonSlug);
  // ...existing IIFE body unchanged...
})()}
```

(If CHAMPAGNE_TOAST is ever added to a package's `covered_addon_slugs` in the future, this block hides automatically.)

- [ ] **Step 4: Smoke-test suppression**

Run: `npm run dev`.
- Grand Experiment proposal → open Moscow Mule's Make It Yours panel → verify the "Craft Ginger Beer" flair addon is NOT offered (it's covered by the package).
- Enhanced Solution proposal → same page → ginger beer flair IS offered (only Grand Experiment covers it).
- Mocktail step on any proposal → no regressions; addons render as today.
- Logistics → champagne toast card still appears (no package covers it).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/plan/steps/MakeItYoursPanel.js client/src/pages/plan/steps/MocktailStep.js client/src/pages/plan/steps/LogisticsStep.js client/src/pages/plan/steps/SignaturePickerStep.js
git commit -m "feat(plan): suppress covered addons across planner surfaces"
```

---

## Task 12: ConfirmationStep — nested rendering for auto-added upgrades

**Files:**
- Modify: `client/src/pages/plan/steps/ConfirmationStep.js`

In the Estimated Costs block, render auto-added addons nested beneath their triggering drink. Non-auto addons keep the current flat row format.

- [ ] **Step 1: Read the existing Estimated Costs block**

Find the block in `ConfirmationStep.js` that lists add-ons. Locate the `.map` over `selectedAddonSlugs` (references `addonPricing.find((a) => a.slug === slug)` — likely around line 125 per earlier grep).

- [ ] **Step 2: Split the addon render into drink-nested + flat**

Immediately before the existing addon `.map`, compute two groups:

```js
const autoByDrink = new Map(); // drinkId -> [{ slug, pricing }]
const flatAddons = [];
for (const slug of Object.keys(addOns)) {
  const meta = addOns[slug];
  if (!meta?.enabled) continue;
  const pricing = addonPricing.find((a) => a.slug === slug);
  if (!pricing) continue;
  if (meta.autoAdded && Array.isArray(meta.triggeredBy) && meta.triggeredBy.length > 0) {
    for (const drinkId of meta.triggeredBy) {
      if (!autoByDrink.has(drinkId)) autoByDrink.set(drinkId, []);
      autoByDrink.get(drinkId).push({ slug, pricing });
    }
  } else {
    flatAddons.push({ slug, pricing });
  }
}

const selectedCocktails = cocktails.filter((c) => (selections.signatureDrinks || []).includes(c.id));
```

- [ ] **Step 3: Render nested drinks above the flat add-on list**

At the point in the JSX where the addon summary is rendered, emit nested drink groups first:

```jsx
{selectedCocktails.map((drink) => {
  const auto = autoByDrink.get(drink.id) || [];
  if (auto.length === 0) return null;
  return (
    <div key={`auto-${drink.id}`} style={{ marginBottom: '0.5rem' }}>
      <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>{drink.name}</div>
      {auto.map(({ slug, pricing }) => {
        const rate = Number(pricing.rate);
        const isPerGuest = pricing.billing_type === 'per_guest';
        const lineTotal = isPerGuest && guestCount ? rate * guestCount : rate;
        const priceLabel = isPerGuest
          ? guestCount ? `$${rate.toFixed(2)}/guest × ${guestCount}` : `$${rate.toFixed(2)}/guest`
          : `$${rate.toFixed(2)}`;
        return (
          <div key={slug} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: '1.25rem', fontSize: '0.9rem', color: 'var(--warm-brown)' }}>
            <span>+ {pricing.name} · {priceLabel}</span>
            <span>${lineTotal.toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
})}
```

Replace the existing addon `.map` over `selectedAddonSlugs` with an equivalent map over `flatAddons` — i.e., only render top-level rows for addons that aren't auto-bound to a drink.

- [ ] **Step 4: Smoke-test**

Run: `npm run dev`. On a hosted proposal:
- Add Moscow Mule + Negroni. Go to Confirmation.
- Verify Estimated Costs shows: `Moscow Mule` with `+ House-Made Ginger Beer` indented beneath, and `Negroni` with two indented upgrade rows.
- Add a champagne toast. Verify it renders flat at the top level, not nested under any drink.
- Remove all cocktails. Verify the nested blocks disappear but champagne toast stays flat.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/plan/steps/ConfirmationStep.js
git commit -m "feat(plan): nest auto-added upgrades under drinks in estimated costs"
```

---

## Task 13: Server submit reconciliation + activity-log detail

**Files:**
- Modify: `server/routes/drinkPlans.js`

Sanity-check auto-added addons on submit: for each `autoAdded: true` addon, drop it if no selected cocktail on the current package still requires it. Emit a `specialty_upgrades` array in the activity-log payload.

- [ ] **Step 1: Pull package data inside the submit transaction**

In `server/routes/drinkPlans.js`, inside the `PUT /t/:token` submit handler's transaction (the block around line 132–308), after `const proposal = proposalRes.rows[0];` and before the addon loop, add:

```js
// Pull the package so we can validate autoAdded addons against its coverage.
const pkgEarly = proposal && proposal.package_id
  ? (await client.query('SELECT id, covered_addon_slugs FROM service_packages WHERE id = $1', [proposal.package_id])).rows[0]
  : null;
const coveredAddonSlugs = pkgEarly?.covered_addon_slugs || [];

// Pull the selected cocktails' upgrade_addon_slugs so we can verify triggers.
const sigDrinkIds = Array.isArray(selections?.signatureDrinks) ? selections.signatureDrinks : [];
const cocktailRows = sigDrinkIds.length > 0
  ? (await client.query(
      'SELECT id, upgrade_addon_slugs FROM cocktails WHERE id = ANY($1::text[])',
      [sigDrinkIds]
    )).rows
  : [];
const cocktailById = new Map(cocktailRows.map(r => [r.id, r]));
```

- [ ] **Step 2: Filter addonSlugs to drop stale auto-addeds**

Immediately after the lookups above, rewrite `addonSlugs` computation:

```js
const rawAddons = selections?.addOns || {};
const rawAddonSlugs = Object.keys(rawAddons).filter(slug => rawAddons[slug]?.enabled);

// For each autoAdded addon, require a still-selected triggering cocktail whose
// upgrade_addon_slugs includes the slug AND the package does not cover it.
const addonSlugs = rawAddonSlugs.filter(slug => {
  const meta = rawAddons[slug];
  if (coveredAddonSlugs.includes(slug)) return false; // package already covers — never charge
  if (meta?.autoAdded) {
    const triggers = Array.isArray(meta.triggeredBy) ? meta.triggeredBy : [];
    const validTrigger = triggers.some(drinkId => {
      const c = cocktailById.get(drinkId);
      return c && Array.isArray(c.upgrade_addon_slugs) && c.upgrade_addon_slugs.includes(slug);
    });
    return validTrigger;
  }
  return true; // user-added addon — honor it
});

// Build the specialty_upgrades payload for activity-log enrichment.
const specialtyUpgrades = addonSlugs
  .filter(slug => rawAddons[slug]?.autoAdded)
  .map(slug => ({
    slug,
    triggeredBy: (rawAddons[slug].triggeredBy || []).filter(drinkId => cocktailById.has(drinkId)),
  }));
```

Replace the existing `const addonSlugs = Object.keys(selections?.addOns || {}).filter(...)` line (near the top of the transaction block) with the code above.

- [ ] **Step 3: Add `specialty_upgrades` to the activity log insert**

Find the `INSERT INTO proposal_activity_log` statement later in the same block (around line 222). Add `specialty_upgrades: specialtyUpgrades` to the JSON payload:

```js
await client.query(
  `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
   VALUES ($1, 'drink_plan_addons_added', 'client', $2)`,
  [proposal.id, JSON.stringify({
    addons: addonSlugs,
    syrups: syrupSels,
    champagne_serving_style: selections.addOns?.['champagne-toast']?.servingStyle || null,
    bar_rental_added: !!addBarRental,
    new_total: snapshot.total,
    specialty_upgrades: specialtyUpgrades,
  })]
);
```

- [ ] **Step 4: Smoke-test submit**

Run: `npm run dev`. On a hosted proposal in refinement:
- Pick Moscow Mule + Negroni; submit the drink plan.
- Open the admin dashboard, navigate to the proposal.
- In the proposal's Activity log, look for a `drink_plan_addons_added` event. Verify the JSON details include `specialty_upgrades: [{ slug: 'house-made-ginger-beer', triggeredBy: ['moscow-mule'] }, { slug: 'specialty-bitter-aperitifs', triggeredBy: ['negroni'] }, { slug: 'specialty-vermouths', triggeredBy: ['negroni'] }]`.
- Verify the proposal_addons table shows the expected 3 specialty addon rows.
- Try a "stale draft" scenario: save a draft with Moscow Mule auto-adding ginger beer, then remove Moscow Mule from `selections.signatureDrinks` (simulate by editing the draft via the UI), then submit. Verify ginger beer is NOT inserted into proposal_addons because its only trigger was dropped.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans.js
git commit -m "feat(drink-plans): reconcile auto-added addons on submit; log specialty_upgrades"
```

---

## Task 14: ProposalDetail — auto-added badge + activity-log detail

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js`

- [ ] **Step 1: Find the add-ons list render**

In `ProposalDetail.js`, grep for the block that iterates `proposal.addons` or `proposal.proposal_addons` to render the add-on list. It usually lives near a heading like "Add-ons" or similar — find by searching for `addon.name` in the file.

- [ ] **Step 2: Look up the auto-added metadata from the drink plan**

Above the addon list rendering, compute an `autoAddedMap` from the linked drink plan's `selections.addOns`:

```js
const drinkPlanSelections = drinkPlan?.selections || {};
const autoAddedMap = {}; // slug -> { triggeredBy: [drinkIds] }
for (const [slug, meta] of Object.entries(drinkPlanSelections.addOns || {})) {
  if (meta?.autoAdded && Array.isArray(meta.triggeredBy)) {
    autoAddedMap[slug] = { triggeredBy: meta.triggeredBy };
  }
}

// Resolve drink IDs to names for the badge tooltip.
const cocktailNameById = {};
for (const c of (cocktails || [])) { cocktailNameById[c.id] = c.name; }
```

(If `drinkPlan` and `cocktails` aren't already in scope in this component, locate the fetches — the proposal detail page likely pulls them alongside the proposal. If `cocktails` isn't fetched, add a fetch: `api.get('/cocktails').then(r => setCocktails(r.data.cocktails || []))` inside a `useEffect` that runs when the proposal loads.)

- [ ] **Step 3: Render the badge**

Inside the addon list map, beside each addon's name, conditionally render:

```jsx
{autoAddedMap[addon.slug] && (
  <span
    className="addon-auto-badge"
    style={{
      marginLeft: '0.5rem',
      padding: '0.125rem 0.375rem',
      borderRadius: '4px',
      background: 'rgba(193, 125, 60, 0.12)',
      color: 'var(--warm-brown)',
      fontSize: '0.7rem',
      fontWeight: 600,
    }}
    title={`Auto-added from: ${autoAddedMap[addon.slug].triggeredBy.map(id => cocktailNameById[id] || id).join(', ')}`}
  >
    Auto-added · from {autoAddedMap[addon.slug].triggeredBy.map(id => cocktailNameById[id] || id).join(', ')}
  </span>
)}
```

- [ ] **Step 4: Render specialty_upgrades in activity log**

Find the activity-log rendering block (search for `drink_plan_addons_added` or similar). For that event, extend the details rendering to include, if `details.specialty_upgrades` is a non-empty array:

```jsx
{Array.isArray(details.specialty_upgrades) && details.specialty_upgrades.length > 0 && (
  <ul style={{ marginTop: '0.25rem', paddingLeft: '1.25rem', fontSize: '0.85rem' }}>
    {details.specialty_upgrades.map((u, i) => (
      <li key={i}>
        <strong>{u.slug}</strong>
        {u.triggeredBy && u.triggeredBy.length > 0 && (
          <span className="text-muted"> &mdash; from {u.triggeredBy.map(id => cocktailNameById[id] || id).join(', ')}</span>
        )}
      </li>
    ))}
  </ul>
)}
```

- [ ] **Step 5: Smoke-test**

Run: `npm run dev`. Submit a drink plan with Moscow Mule + Negroni on a hosted proposal. Open the proposal detail page in admin:
- Addons list: each specialty addon row carries the "Auto-added · from Moscow Mule" (or Negroni) badge.
- Activity tab: `drink_plan_addons_added` event shows a `specialty_upgrades` detail list.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js
git commit -m "feat(admin): auto-added badge + specialty_upgrades detail on proposal"
```

---

## Task 15: Admin cocktail-edit form — upgrade_addon_slugs multi-select

**Files:**
- Modify: `client/src/pages/admin/CocktailMenuDashboard.js`

Admin can set/edit each cocktail's `upgrade_addon_slugs` via a simple CSV field (mirrors how `ingredients` is edited today).

- [ ] **Step 1: Add `upgrade_addon_slugs` to `newCocktailForm` and edit form state**

Find the `useState` initializations (around line 270). Extend the default form:

```js
const [newCocktailForm, setNewCocktailForm] = useState({ name: '', emoji: '', description: '', sort_order: '', base_spirit: '', ingredients: '', upgrade_addon_slugs: '' });
```

Also ensure `editCocktailForm` (when an edit session starts) includes `upgrade_addon_slugs`. Find where editing starts (a `startEditCocktail` or similar handler — grep `setEditCocktailForm`). Add `upgrade_addon_slugs` to the seeding:

```js
setEditCocktailForm({
  // ...existing fields...
  upgrade_addon_slugs: Array.isArray(c.upgrade_addon_slugs) ? c.upgrade_addon_slugs.join(', ') : (c.upgrade_addon_slugs || ''),
});
```

- [ ] **Step 2: Parse CSV on save**

In `saveEditCocktail` (around line 334), extend the body normalization to parse `upgrade_addon_slugs`:

```js
const body = { ...editCocktailForm };
if (typeof body.ingredients === 'string') {
  body.ingredients = body.ingredients.split(',').map(s => s.trim()).filter(Boolean);
}
if (typeof body.upgrade_addon_slugs === 'string') {
  body.upgrade_addon_slugs = body.upgrade_addon_slugs.split(',').map(s => s.trim()).filter(Boolean);
}
```

And in `addCocktail` (around line 362), mirror the change when posting:

```js
const res = await api.post('/cocktails', {
  id,
  name: newCocktailForm.name.trim(),
  // ... existing fields ...
  upgrade_addon_slugs: newCocktailForm.upgrade_addon_slugs.split(',').map(s => s.trim()).filter(Boolean),
});
```

- [ ] **Step 3: Add the field to the edit UI**

Inside the `DrinkTable` component's edit-row rendering (around line 15–150), add a new `<td>` or inline input alongside `ingredients`. Minimal version — an extra column header "Upgrades" and an edit input:

```jsx
<td>
  <input
    className="form-input"
    value={editForm.upgrade_addon_slugs || ''}
    onChange={(e) => onEditFormChange({ upgrade_addon_slugs: e.target.value })}
    placeholder="e.g. specialty-vermouths, specialty-bitter-aperitifs"
    title="Comma-separated addon slugs to charge when the package doesn't cover them"
  />
</td>
```

Matching display cell in the non-edit row:

```jsx
<td className="text-muted text-small">
  {Array.isArray(c.upgrade_addon_slugs) && c.upgrade_addon_slugs.length > 0 ? c.upgrade_addon_slugs.join(', ') : '—'}
</td>
```

Add a matching `<th>Upgrades</th>` to the header row.

- [ ] **Step 4: Add the field to the create form**

Find the `addCocktail` form inputs (the `newCocktailForm` inputs above the "Add" button inside each category). Add a new input mirroring the `ingredients` one:

```jsx
<input
  className="form-input"
  placeholder="Upgrade addon slugs (CSV)"
  value={newCocktailForm.upgrade_addon_slugs}
  onChange={(e) => setNewCocktailForm(f => ({ ...f, upgrade_addon_slugs: e.target.value }))}
/>
```

- [ ] **Step 5: Extend server PUT/POST to accept the field**

Open `server/routes/cocktails.js`. The PUT at line 164 already uses `COALESCE`. Extend to include `upgrade_addon_slugs`:

```js
router.put('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { name, category_id, emoji, description, sort_order, is_active, base_spirit, ingredients, upgrade_addon_slugs } = req.body;
  const result = await pool.query(
    `UPDATE cocktails SET
      name        = COALESCE($1, name),
      category_id = COALESCE($2, category_id),
      emoji       = COALESCE($3, emoji),
      description = COALESCE($4, description),
      sort_order  = COALESCE($5, sort_order),
      is_active   = COALESCE($6, is_active),
      base_spirit = COALESCE($7, base_spirit),
      ingredients = COALESCE($8::jsonb, ingredients),
      upgrade_addon_slugs = COALESCE($9::text[], upgrade_addon_slugs)
     WHERE id = $10 RETURNING *`,
    [
      name || null,
      category_id || null,
      emoji || null,
      description || null,
      sort_order ?? null,
      is_active ?? null,
      base_spirit || null,
      ingredients !== undefined ? JSON.stringify(ingredients) : null,
      Array.isArray(upgrade_addon_slugs) ? upgrade_addon_slugs : null,
      req.params.id,
    ]
  );
  if (!result.rows[0]) throw new NotFoundError('Cocktail not found.');
  res.json(result.rows[0]);
}));
```

Same for POST (cocktail create), around line 141:

```js
router.post('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { id, name, category_id, emoji, description, sort_order, base_spirit, ingredients, upgrade_addon_slugs } = req.body;
  // ...existing validation...
  const result = await pool.query(
    `INSERT INTO cocktails (id, name, category_id, emoji, description, sort_order, base_spirit, ingredients, upgrade_addon_slugs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [id, name, category_id || null, emoji || null, description || null, sort_order || 0, base_spirit || null, JSON.stringify(ingredients || []), Array.isArray(upgrade_addon_slugs) ? upgrade_addon_slugs : []]
  );
  // ...existing response...
}));
```

- [ ] **Step 6: Smoke-test**

Run: `npm run dev`. Log into admin. Go to Cocktail Menu dashboard. Edit Moscow Mule: verify the Upgrades column shows `house-made-ginger-beer`. Change to `house-made-ginger-beer, specialty-niche-liqueurs` and save. Reload — verify persistence. Create a new cocktail with upgrade slugs; verify they save.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/CocktailMenuDashboard.js server/routes/cocktails.js
git commit -m "feat(admin): edit cocktail upgrade_addon_slugs"
```

---

## Task 16: Documentation updates

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`

Per the mandatory doc-updates rule in CLAUDE.md.

- [ ] **Step 1: Update CLAUDE.md folder tree**

In `.claude/CLAUDE.md`, add these entries to the folder tree:

- Under `client/src/pages/plan/data/`: `packageGaps.js` and its test file.
- Under `client/src/pages/plan/steps/`: `HostedGuestPrefsStep.js`.

Example patch (adapt to the existing tree layout):

```diff
 │   │   │   ├── data/         # cocktailMenu.js, servingTypes.js, drinkUpgrades.js
+│   │   │   │   └── packageGaps.js # Hosted-package gap helpers + Jest tests
 │   │   │   └── steps/        # WelcomeStep, LogisticsStep, FullBarStep, SyrupUpsellStep, etc.
+│   │   │       └── HostedGuestPrefsStep.js # Compact guest-prefs step for hosted refinement
```

- [ ] **Step 2: Update README.md folder tree**

Mirror the same entries in `README.md`.

- [ ] **Step 3: Update ARCHITECTURE.md**

In `docs/ARCHITECTURE.md`, in the Database Schema section, add the two new columns:

```markdown
- `service_packages.covered_addon_slugs TEXT[]` — which add-on slugs the hosted
  package's base price already includes. Used by the Potion Planning Lab to
  suppress redundant add-on offers and compute cocktail ingredient gaps.
- `cocktails.upgrade_addon_slugs TEXT[]` — add-on slugs that must be purchased
  when the client's hosted package doesn't already cover them. Auto-added when
  the client selects such a cocktail on the planner.
```

In the relevant section about the drink plan flow, add one paragraph:

```markdown
## Hosted package-aware refinement

When a drink plan's linked proposal has a hosted package
(`service_packages.category = 'hosted'`) and the proposal has reached
refinement phase (deposit paid or later), the Potion Planning Lab skips the
serving-style quick pick, the spirits selection, and the beer/wine selection
— these are already fixed by the package. A compact `HostedGuestPrefsStep`
replaces them, asking only how guests lean (mostly beer / cocktails / wine /
balanced). Cocktail cards show a "+$X/guest" badge when the drink needs
ingredients outside the package's stocked catalog; selecting such a drink
auto-adds the relevant specialty-ingredient add-on to the proposal with a
toast confirmation. Add-ons already covered by the package are suppressed
from every offer point. Logic lives in `client/src/pages/plan/data/packageGaps.js`
(pure helpers) + `server/utils/pricingEngine.js` (parity helpers); the data
model is `service_packages.covered_addon_slugs` and `cocktails.upgrade_addon_slugs`.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md README.md docs/ARCHITECTURE.md
git commit -m "docs: hosted package-aware planner"
```

---

## Task 17: End-to-end verification

**Files:** None — verification only.

- [ ] **Step 1: Happy path — hosted full-bar refinement**

Run: `npm run dev`. Pick a hosted Enhanced Solution proposal in refinement phase. Open its drink-plan URL. Walk through:

1. RefinementWelcome → package recap card visible with the correct package name + ingredient list, placeholders stripped.
2. No QuickPick, no Spirits, no Beer&Wine steps.
3. SignaturePicker: Moscow Mule shows `+$2.50/guest` badge. Tap it — toast fires, addon added in state.
4. Negroni shows `+$4.50/guest` badge. Tap it — toast fires, two addons added.
5. Your Menu shows both drinks with nested upgrade tags beneath.
6. No "include mixers?" radio group.
7. MocktailStep runs as usual.
8. New HostedGuestPrefs step appears, balance question working.
9. MenuDesign + Logistics → champagne toast still offered (no package covers it).
10. Confirmation → Estimated Costs block shows Moscow Mule + Negroni with nested upgrade rows; no flat specialty-upgrade rows.
11. Submit. Proposal's addons list now contains 3 specialty addons with the "Auto-added · from X" badge. Activity log shows the `specialty_upgrades` details.

- [ ] **Step 2: Grand Experiment coverage**

On a Grand Experiment proposal: Moscow Mule shows NO badge (ginger beer covered). `house-made-ginger-beer` addon does NOT appear in MakeItYoursPanel. All correct.

- [ ] **Step 3: BYOB regression check**

On a BYOB proposal: QuickPick appears, Spirits and Beer/Wine steps appear, mixer radio appears, no gap badges on drinks. Nothing has regressed.

- [ ] **Step 4: Exploration-phase regression check**

On a proposal in `sent` or `viewed` status (exploration phase): no package recap, no gap badges, full cocktail list. No change to exploration.

- [ ] **Step 5: Final commit (if any straggler copy tweaks)**

If the smoke tests surfaced any copy or styling bugs, fix them and commit with a narrow message. Otherwise no commit — this task is verification only.

---

## Notes for the implementing agent

- **Explicit staging only.** Always `git add <specific-path>` — never `git add .` or `-A`. CLAUDE.md Rule 7.
- **One commit per task.** Group related changes. See CLAUDE.md Rule 3.
- **Don't push unless the user gives the push cue.** Each commit stays local until the user says "push." CLAUDE.md Rule 4.
- **If a pre-commit hook fails**, fix the underlying issue and create a NEW commit (don't amend).
- **Before starting any UI step**, `npm run dev` and open the target page so you can observe the change live.
- **Between tasks**, check `git status` to confirm no stray edits. Don't combine tasks unless explicitly noted.
- **Cross-cutting consistency.** Tasks 1, 6, 9, 10, 12 together touch schema → route → component → admin. If you deviate from the plan on any one, re-check the others — the data contract between them is load-bearing.
