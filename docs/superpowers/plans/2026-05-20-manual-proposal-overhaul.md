# Manual Proposal Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make admin-created proposals support Sign & Pay immediately, and unify the cockpit's business rules with the public quote wizard via a shared rules module.

**Architecture:** Extract the wizard's bundle/addon/guardrail logic into a shared pure-function module (`proposalRules.js`) with a CJS server twin that re-validates authoritatively. Widen `POST /api/proposals` with a `send_now` flag; on send, create the invoice inside the DB transaction and email the client after commit via a shared `sendProposalSentEmail` helper. The cockpit keeps its one-screen UX and consumes the shared rules.

**Tech Stack:** Node 18 / Express, React 18 (CRA), raw SQL via `pg`, `node:test` for server tests, CRA Jest for the client module test.

**Source spec:** `docs/superpowers/specs/2026-05-20-manual-proposal-overhaul-design.md`

---

## File Structure

**New files**
- `client/src/utils/proposalRules.js` — shared pure rules (ESM, client). Bundle logic, addon filtering, guardrails.
- `client/src/utils/proposalRules.test.js` — CRA Jest tests for the client module.
- `server/utils/proposalRules.js` — CJS twin + `validateProposalRules` (authoritative server gate).
- `server/utils/proposalRules.test.js` — node:test for the twin + validation rejections.
- `server/utils/sendProposalSentEmail.js` — post-commit, never-throws client email helper.
- `server/utils/sendProposalSentEmail.test.js` — node:test for the email helper.

**Modified files**
- `server/db/schema.sql` — add `proposals.client_provides_glassware`.
- `server/middleware/rateLimiters.js` — add `adminWriteLimiter`.
- `server/routes/proposals/crud.js` — widen `POST /`, `validateProposalRules`, `send_now` branching, in-txn invoice, post-commit email; wrap `PATCH /:id/status` in a transaction.
- `server/routes/proposals/public.js` — `validateProposalRules`, in-txn invoice (parity #2), post-commit email.
- `client/src/pages/website/quoteWizard/QuoteWizard.js` — consume `proposalRules.js` (behavior-preserving).
- `client/src/pages/admin/ProposalCreate.js` — consume `proposalRules.js`, new UI controls, submit branching.

**Untouched (deliberately out of scope):** `client/src/pages/website/quoteWizard/bundleConfig.js` stays where it is — `proposalRules.js` re-exports from it. `ProposalDetailEditForm.js` keeps its own `toggleAddon` (see spec Non-goals).

---

## Review Tiers

Each task carries a **Review tier** that controls its post-task review. The executor (`superpowers:subagent-driven-development`) runs the review between tasks, after the task's own tests/build pass:

- **Tier 0 — no post-task review.** The task's own tests/build is the gate. Once green, move to the next task.
- **Tier 1 — one reviewer.** Dispatch one Claude `code-review` subagent with a prompt focused on that task's specific risk. Address blockers before continuing.
- **Tier 2 — two reviewers.** A Claude `code-review` subagent **and** a Codex review (`codex review` on the task's diff — cross-LLM). Reconcile both before continuing; findings flagged by both are high-signal.

Rationale: Tier 2 is the money / transaction / security cluster (where GPT-vs-Claude disagreement has repeatedly earned its keep). Tier 1 is single-layer code. Tier 0 is mechanical or self-verifying.

| Tasks | Tier |
|---|---|
| 4, 5, 14, 15 | 0 |
| 1, 3, 6, 10, 11, 12, 13 | 1 |
| 2, 7, 8, 9 | 2 |

---

## Phase 1 — Shared rules foundation

### Task 1: Client shared rules module

**Review tier:** 1 (Claude code-review) — pure + fully unit-tested, but load-bearing; the reviewer confirms the extraction faithfully preserves the `QuoteWizard.js` logic.

**Files:**
- Create: `client/src/utils/proposalRules.js`
- Test: `client/src/utils/proposalRules.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/proposalRules.test.js`:

```js
import {
  getSelectedBundleSlug,
  stripIncludedAddons,
  isIncludedByBundle,
  isUnavailableByBundle,
  toggleAddonWithRules,
  filterAddons,
  enforceHostedMinimum,
  reconcileFlavorBlaster,
  isQuantityCapable,
} from './proposalRules';

// Minimal addon fixtures keyed the same way the API returns them.
const A = {
  foundation:  { id: 1,  slug: 'the-foundation' },
  formula:     { id: 2,  slug: 'the-formula' },
  compound:    { id: 3,  slug: 'the-full-compound' },
  ice:         { id: 4,  slug: 'ice-delivery-only' },
  sigMix:      { id: 5,  slug: 'signature-mixers-only' },
  fullMix:     { id: 6,  slug: 'full-mixers-only' },
  garnish:     { id: 7,  slug: 'garnish-package-only' },
  fb:          { id: 8,  slug: 'flavor-blaster-rental' },
  realGlass:   { id: 9,  slug: 'real-glassware' },
  coupe:       { id: 10, slug: 'champagne-coupe-upgrade', requires_addon_slug: 'champagne-toast' },
  champagne:   { id: 11, slug: 'champagne-toast' },
  syrups:      { id: 12, slug: 'handcrafted-syrups' },
  mocktailBar: { id: 13, slug: 'mocktail-bar', applies_to: 'all' },
  parking:     { id: 14, slug: 'parking-fee', applies_to: 'all' },
  syrups3:     { id: 15, slug: 'handcrafted-syrups-3pack', applies_to: 'all' },
};
const ALL = Object.values(A);

test('getSelectedBundleSlug returns the active BYOB bundle', () => {
  expect(getSelectedBundleSlug([4, 2], ALL)).toBe('the-formula');
  expect(getSelectedBundleSlug([4], ALL)).toBe(null);
});

test('stripIncludedAddons drops bundle-covered addons but keeps the bundle itself', () => {
  // Formula covers ice + signature mixers; the bundle id (2) stays.
  expect(stripIncludedAddons([2, 4, 5], ALL).sort()).toEqual([2]);
});

test('isIncludedByBundle / isUnavailableByBundle reflect bundleConfig', () => {
  expect(isIncludedByBundle('ice-delivery-only', [2], ALL)).toBe(true);
  expect(isUnavailableByBundle('full-mixers-only', [2], ALL)).toBe(true);
  expect(isIncludedByBundle('ice-delivery-only', [], ALL)).toBe(false);
});

test('toggleAddonWithRules enforces BYOB bundle mutex', () => {
  const r = toggleAddonWithRules({ addonIds: [1], syrupSelections: [] }, 2, ALL);
  expect(r.addon_ids).toEqual([2]); // adding Formula removes Foundation
});

test('toggleAddonWithRules enforces mixer mutex', () => {
  const r = toggleAddonWithRules({ addonIds: [5], syrupSelections: [] }, 6, ALL);
  expect(r.addon_ids).toEqual([6]); // full mixers replaces signature mixers
});

test('toggleAddonWithRules clears syrup_selections when syrups removed', () => {
  const r = toggleAddonWithRules({ addonIds: [12], syrupSelections: ['vanilla'] }, 12, ALL);
  expect(r.addon_ids).toEqual([]);
  expect(r.syrup_selections).toEqual([]);
});

test('toggleAddonWithRules removes dependents when parent removed', () => {
  const r = toggleAddonWithRules({ addonIds: [11, 10], syrupSelections: [] }, 11, ALL);
  expect(r.addon_ids).toEqual([]); // removing champagne-toast drops coupe upgrade
});

test('toggleAddonWithRules is a no-op on a bundle-locked addon', () => {
  // Formula active; ice is bundle-covered → toggling ice does nothing.
  const r = toggleAddonWithRules({ addonIds: [2], syrupSelections: [] }, 4, ALL);
  expect(r.addon_ids).toEqual([2]);
});

test('filterAddons hides parking-fee and 3-pack syrup variant', () => {
  const { visibleAddons } = filterAddons({
    addons: ALL, isHosted: false, packageCategory: 'byob',
    addonIds: [], guestCount: 50,
  });
  const slugs = visibleAddons.map(a => a.slug);
  expect(slugs).not.toContain('parking-fee');
  expect(slugs).not.toContain('handcrafted-syrups-3pack');
});

test('filterAddons hides real-glassware and coupe above 100 guests', () => {
  const { visibleAddons } = filterAddons({
    addons: ALL, isHosted: false, packageCategory: 'byob',
    addonIds: [11], guestCount: 150,
  });
  const slugs = visibleAddons.map(a => a.slug);
  expect(slugs).not.toContain('real-glassware');
  expect(slugs).not.toContain('champagne-coupe-upgrade');
});

test('filterAddons hides garnish-package for hosted', () => {
  const { visibleAddons } = filterAddons({
    addons: ALL, isHosted: true, packageCategory: 'hosted',
    addonIds: [], guestCount: 50,
  });
  expect(visibleAddons.map(a => a.slug)).not.toContain('garnish-package-only');
});

test('enforceHostedMinimum bumps below-25 only for hosted', () => {
  expect(enforceHostedMinimum(10, true)).toBe(25);
  expect(enforceHostedMinimum(10, false)).toBe(10);
  expect(enforceHostedMinimum(40, true)).toBe(40);
});

test('reconcileFlavorBlaster removes FB when no glassware', () => {
  expect(reconcileFlavorBlaster([8], ALL, false)).toEqual([]);
  expect(reconcileFlavorBlaster([8], ALL, true)).toEqual([8]);
  expect(reconcileFlavorBlaster([8, 9], ALL, false)).toEqual([8, 9]); // real-glassware present
});

test('isQuantityCapable matches the 4 staffing-ish slugs, not syrups', () => {
  expect(isQuantityCapable({ slug: 'additional-bartender' })).toBe(true);
  expect(isQuantityCapable({ slug: 'barback' })).toBe(true);
  expect(isQuantityCapable({ slug: 'banquet-server' })).toBe(true);
  expect(isQuantityCapable({ slug: 'pre-batched-mocktail' })).toBe(true);
  expect(isQuantityCapable({ slug: 'handcrafted-syrups' })).toBe(false); // syrup picker handles count
  expect(isQuantityCapable({ slug: 'the-formula' })).toBe(false);
  expect(isQuantityCapable(null)).toBe(false);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalRules`
Expected: FAIL — `Cannot find module './proposalRules'`.

- [ ] **Step 3: Create the module**

Create `client/src/utils/proposalRules.js`. This extracts the exact logic currently inline in `QuoteWizard.js` (lines 79-96, 263-273, 304-345, 357, 388-391, 399-427) into pure functions:

```js
// Shared proposal business rules — bundle logic, addon filtering, guardrails.
// Pure functions: no React, no state. Consumed by the public Quote Wizard and
// the admin cockpit (ProposalCreate.js). A CJS twin at server/utils/proposalRules.js
// re-validates these rules authoritatively; keep the two in sync manually
// (same discipline as eventTypes.js).
import {
  BYOB_BUNDLE_SLUGS,
  MIXER_SLUGS,
  BUNDLE_INCLUDED,
  BUNDLE_UNAVAILABLE,
  BUNDLE_COVERED,
} from '../pages/website/quoteWizard/bundleConfig';

export { BYOB_BUNDLE_SLUGS, MIXER_SLUGS, BUNDLE_INCLUDED, BUNDLE_UNAVAILABLE, BUNDLE_COVERED };

export function getSelectedBundleSlug(addonIds, addons) {
  for (const id of addonIds) {
    const a = addons.find(x => x.id === id);
    if (a && BYOB_BUNDLE_SLUGS.includes(a.slug)) return a.slug;
  }
  return null;
}

export function stripIncludedAddons(addonIds, addons) {
  const bundle = getSelectedBundleSlug(addonIds, addons);
  if (!bundle) return addonIds;
  const covered = new Set(BUNDLE_COVERED[bundle]);
  return addonIds.filter(id => {
    const a = addons.find(x => x.id === id);
    return !a || !covered.has(a.slug) || BYOB_BUNDLE_SLUGS.includes(a.slug);
  });
}

export function isIncludedByBundle(slug, addonIds, addons) {
  const bundle = getSelectedBundleSlug(addonIds, addons);
  return !!bundle
    && (BUNDLE_INCLUDED[bundle] || []).includes(slug)
    && !BYOB_BUNDLE_SLUGS.includes(slug);
}

export function isUnavailableByBundle(slug, addonIds, addons) {
  const bundle = getSelectedBundleSlug(addonIds, addons);
  return !!bundle && (BUNDLE_UNAVAILABLE[bundle] || []).includes(slug);
}

// Returns the next-state slice { addon_ids, syrup_selections } after toggling
// `id`. Enforces BYOB bundle mutex, mixer mutex, dependent-addon cleanup, and
// clears syrup_selections when handcrafted-syrups is removed. No-ops if `id` is
// a bundle-locked addon.
export function toggleAddonWithRules({ addonIds, syrupSelections = [] }, id, addons) {
  const clicked = addons.find(a => a.id === id);
  const bundle = getSelectedBundleSlug(addonIds, addons);
  if (clicked && bundle && !BYOB_BUNDLE_SLUGS.includes(clicked.slug)
      && (BUNDLE_COVERED[bundle] || []).includes(clicked.slug)) {
    return { addon_ids: addonIds, syrup_selections: syrupSelections };
  }
  const isRemoving = addonIds.includes(id);
  let newIds;
  let newSyrups = syrupSelections;
  if (isRemoving) {
    const removed = addons.find(a => a.id === id);
    const dependentIds = addons
      .filter(a => a.requires_addon_slug === removed?.slug)
      .map(a => a.id);
    newIds = addonIds.filter(a => a !== id && !dependentIds.includes(a));
    if (removed?.slug === 'handcrafted-syrups') newSyrups = [];
  } else {
    const added = addons.find(a => a.id === id);
    newIds = [...addonIds, id];
    if (added && BYOB_BUNDLE_SLUGS.includes(added.slug)) {
      const others = addons
        .filter(a => BYOB_BUNDLE_SLUGS.includes(a.slug) && a.id !== id)
        .map(a => a.id);
      newIds = newIds.filter(a => !others.includes(a));
    }
    if (added && MIXER_SLUGS.includes(added.slug)) {
      const others = addons
        .filter(a => MIXER_SLUGS.includes(a.slug) && a.id !== id)
        .map(a => a.id);
      newIds = newIds.filter(a => !others.includes(a));
    }
  }
  return { addon_ids: newIds, syrup_selections: newSyrups };
}

// Returns { visibleAddons, isIncludedMap, isUnavailableMap }.
// `packageCategory` is the pkg.category string ('byob' | 'hosted' | 'mocktail')
// used for applies_to matching. Class packages carry category='hosted' — class
// detection is NOT done here (see ProposalCreate PackageSection / QuoteWizard).
// Takes only the args the filter rules actually consume — the Flavor Blaster
// glassware gate lives in reconcileFlavorBlaster, not here.
export function filterAddons({
  addons,
  isHosted,
  packageCategory,
  addonIds,
  guestCount,
}) {
  const hasSlug = (slug) => addonIds.some(id => {
    const a = addons.find(x => x.id === id);
    return a && a.slug === slug;
  });
  const gc = Number(guestCount) || 0;

  const visibleAddons = addons.filter(a => {
    if (a.applies_to !== 'all' && a.applies_to !== packageCategory) return false;
    if (a.slug === 'garnish-package-only' && isHosted) return false;
    if (a.slug === 'mocktail-bar' && packageCategory === 'byob'
        && !hasSlug('the-formula') && !hasSlug('the-full-compound')) return false;
    if ((a.slug === 'real-glassware' || a.slug === 'champagne-coupe-upgrade') && gc > 100) return false;
    if (a.requires_addon_slug) {
      const parent = addons.find(x => x.slug === a.requires_addon_slug);
      if (!parent || !addonIds.includes(parent.id)) return false;
    }
    if (a.slug === 'handcrafted-syrups-3pack') return false;
    if (a.slug === 'parking-fee') return false;
    return true;
  });

  const isIncludedMap = {};
  const isUnavailableMap = {};
  for (const a of addons) {
    isIncludedMap[a.slug] = isIncludedByBundle(a.slug, addonIds, addons);
    isUnavailableMap[a.slug] = isUnavailableByBundle(a.slug, addonIds, addons);
  }
  return { visibleAddons, isIncludedMap, isUnavailableMap };
}

// Hosted packages have a 25-guest floor. `isHosted` = pkg.pricing_type === 'per_guest'.
export function enforceHostedMinimum(guestCount, isHosted) {
  const g = Number(guestCount) || 0;
  return isHosted && g < 25 ? 25 : guestCount;
}

// Drops Flavor Blaster from the selection if its glassware requirement
// (real-glassware addon OR client_provides_glassware) is not met.
export function reconcileFlavorBlaster(addonIds, addons, clientProvidesGlassware) {
  const fb = addons.find(a => a.slug === 'flavor-blaster-rental');
  if (!fb || !addonIds.includes(fb.id)) return addonIds;
  const realGlass = addons.find(a => a.slug === 'real-glassware');
  const hasGlass = (realGlass && addonIds.includes(realGlass.id)) || !!clientProvidesGlassware;
  return hasGlass ? addonIds : addonIds.filter(x => x !== fb.id);
}

// Add-ons billed by a 1-10 count (a quantity stepper). This is the CANONICAL
// source — the wizard's ExtrasStep.js currently hardcodes this same slug list
// inline; Task 3 repoints ExtrasStep at this predicate so the two never drift.
// Handcrafted syrups are NOT here — their bottle count is driven by the syrup
// picker (syrup_selections), a separate control in both flows.
const QUANTITY_CAPABLE_SLUGS = [
  'banquet-server', 'barback', 'pre-batched-mocktail', 'additional-bartender',
];
export function isQuantityCapable(addon) {
  return !!addon && QUANTITY_CAPABLE_SLUGS.includes(addon.slug);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalRules`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/proposalRules.js client/src/utils/proposalRules.test.js
git commit -m "feat(proposals): shared client rules module (bundle/addon/guardrail logic)"
```

---

### Task 2: Server rules twin + authoritative validator

**Review tier:** 2 (Claude code-review + Codex) — `validateProposalRules` is the authoritative server-side security gate; a missed rule means a scripted POST can persist an invalid proposal.

**Files:**
- Create: `server/utils/proposalRules.js`
- Test: `server/utils/proposalRules.test.js`
- Modify: `client/src/pages/website/quoteWizard/bundleConfig.js` (reciprocal sync comment only)

- [ ] **Step 1: Write the failing test**

Create `server/utils/proposalRules.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProposalRules } = require('./proposalRules');

// Addon rows as the DB returns them.
const A = {
  formula:    { id: 2,  slug: 'the-formula' },
  foundation: { id: 1,  slug: 'the-foundation' },
  sigMix:     { id: 5,  slug: 'signature-mixers-only' },
  fullMix:    { id: 6,  slug: 'full-mixers-only' },
  garnish:    { id: 7,  slug: 'garnish-package-only' },
  fb:         { id: 8,  slug: 'flavor-blaster-rental' },
  realGlass:  { id: 9,  slug: 'real-glassware' },
  coupe:      { id: 10, slug: 'champagne-coupe-upgrade', requires_addon_slug: 'champagne-toast' },
  champagne:  { id: 11, slug: 'champagne-toast' },
};
const ALL = Object.values(A);

const HOSTED = { pricing_type: 'per_guest', bar_type: 'full', category: 'hosted' };
const BYOB   = { pricing_type: 'flat', bar_type: 'byob', category: 'byob' };

test('rejects hosted package below 25 guests', () => {
  assert.throws(() => validateProposalRules({
    pkg: HOSTED, guestCount: 10, addonIds: [], addons: ALL, clientProvidesGlassware: false,
  }), /guest/i);
});

test('rejects Flavor Blaster with no glassware', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [8], addons: ALL, clientProvidesGlassware: false,
  }), /glassware/i);
});

test('allows Flavor Blaster when client provides glassware', () => {
  assert.doesNotThrow(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [8], addons: ALL, clientProvidesGlassware: true,
  }));
});

test('rejects real-glassware above 100 guests', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 150, addonIds: [9], addons: ALL, clientProvidesGlassware: false,
  }), /100/);
});

test('rejects two BYOB bundles at once (bundle mutex)', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [1, 2], addons: ALL, clientProvidesGlassware: false,
  }), /bundle/i);
});

test('rejects two mixer packages at once (mixer mutex)', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [5, 6], addons: ALL, clientProvidesGlassware: false,
  }), /mixer/i);
});

test('rejects requires_addon_slug addon without its parent', () => {
  assert.throws(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [10], addons: ALL, clientProvidesGlassware: false,
  }), /champagne-toast|requires/i);
});

test('passes a valid selection', () => {
  assert.doesNotThrow(() => validateProposalRules({
    pkg: BYOB, guestCount: 50, addonIds: [11, 10], addons: ALL, clientProvidesGlassware: false,
  }));
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test server/utils/proposalRules.test.js`
Expected: FAIL — `Cannot find module './proposalRules'`.

- [ ] **Step 3: Create the server twin**

Create `server/utils/proposalRules.js`. CJS. Mirrors the bundle constants from `bundleConfig.js` (kept in sync manually — the file is 21 lines, drift is obvious in review) and adds the authoritative `validateProposalRules`:

```js
// Server twin of client/src/utils/proposalRules.js. CJS. The constants below
// MUST stay in sync with client/src/pages/website/quoteWizard/bundleConfig.js
// (same manual-twin discipline as eventTypes.js). validateProposalRules is the
// AUTHORITATIVE gate — a stale tab or scripted POST bypasses the client, so
// every rule the wizard UI enforces is re-checked here.
const { ValidationError } = require('./errors');

const BYOB_BUNDLE_SLUGS = ['the-foundation', 'the-formula', 'the-full-compound'];
const MIXER_SLUGS = ['signature-mixers-only', 'full-mixers-only'];

// Throws ValidationError on any violation. Args:
//   pkg                     — service_packages row (uses pricing_type, bar_type)
//   guestCount              — number
//   addonIds                — number[]
//   addons                  — service_addons rows for the selected ids (+ any
//                             needed for requires_addon_slug parent lookup)
//   clientProvidesGlassware — boolean
function validateProposalRules({ pkg, guestCount, addonIds, addons, clientProvidesGlassware }) {
  const errors = {};
  const ids = addonIds || [];
  const rows = addons || [];
  const selected = rows.filter(a => ids.includes(a.id));
  const hasSlug = (slug) => selected.some(a => a.slug === slug);
  const gc = Number(guestCount) || 0;
  const isHosted = pkg && pkg.pricing_type === 'per_guest';

  // Hosted 25-guest floor
  if (isHosted && gc < 25) {
    errors.guest_count = 'Hosted packages require at least 25 guests';
  }

  // Flavor Blaster needs real glassware OR client-provided glassware
  if (hasSlug('flavor-blaster-rental')
      && !hasSlug('real-glassware') && !clientProvidesGlassware) {
    errors.addon_ids = 'Flavor Blaster requires real glassware or client-provided glassware';
  }

  // Real glassware / coupe upgrade cap at 100 guests
  if ((hasSlug('real-glassware') || hasSlug('champagne-coupe-upgrade')) && gc > 100) {
    errors.addon_ids = 'Real glassware is only available for events of 100 guests or fewer';
  }

  // Mocktail bar on BYOB needs Formula or Full Compound
  if (hasSlug('mocktail-bar') && pkg && pkg.category === 'byob'
      && !hasSlug('the-formula') && !hasSlug('the-full-compound')) {
    errors.addon_ids = 'Mocktail Bar requires The Formula or The Full Compound on BYOB packages';
  }

  // Garnish package not valid on hosted
  if (hasSlug('garnish-package-only') && isHosted) {
    errors.addon_ids = 'Garnish Package is already included with hosted packages';
  }

  // Bundle mutex — at most one BYOB bundle
  const bundleCount = selected.filter(a => BYOB_BUNDLE_SLUGS.includes(a.slug)).length;
  if (bundleCount > 1) {
    errors.addon_ids = 'Only one BYOB bundle may be selected at a time';
  }

  // Mixer mutex — at most one mixer package
  const mixerCount = selected.filter(a => MIXER_SLUGS.includes(a.slug)).length;
  if (mixerCount > 1) {
    errors.addon_ids = 'Only one mixer package may be selected at a time';
  }

  // requires_addon_slug — every dependent addon's parent must be selected
  for (const a of selected) {
    if (a.requires_addon_slug && !hasSlug(a.requires_addon_slug)) {
      errors.addon_ids = `"${a.name || a.slug}" requires "${a.requires_addon_slug}" to also be selected`;
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
}

module.exports = { BYOB_BUNDLE_SLUGS, MIXER_SLUGS, validateProposalRules };
```

Note: confirm `ValidationError` is exported from `server/utils/errors.js` (CLAUDE.md references the hierarchy there). If the constructor signature differs from `new ValidationError(fieldErrorsObject)`, match the existing usage in `crud.js`.

Then add a reciprocal sync comment at the top of `client/src/pages/website/quoteWizard/bundleConfig.js` so the duplication is visible from both ends:
```js
// KEEP IN SYNC: server/utils/proposalRules.js re-declares BYOB_BUNDLE_SLUGS and
// MIXER_SLUGS in CJS. If you edit either array here, update that twin too.
```
(`bundleConfig.js` stays the canonical source for the client; the server twin is a manual mirror — same discipline as `eventTypes.js`.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test server/utils/proposalRules.test.js`
Expected: PASS — 8/8.

- [ ] **Step 5: Commit**

```bash
git add server/utils/proposalRules.js server/utils/proposalRules.test.js client/src/pages/website/quoteWizard/bundleConfig.js
git commit -m "feat(proposals): server rules twin with authoritative validateProposalRules"
```

---

### Task 3: Refactor QuoteWizard to consume the shared module

**Review tier:** 1 (Claude code-review) — behavior-preserving refactor of the public revenue funnel; the reviewer watches for silent regressions vs. pre-refactor behavior.

**Files:**
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js`
- Modify: `client/src/pages/website/quoteWizard/steps/ExtrasStep.js`

Behavior-preserving refactor: replace the inline implementations with imports from `proposalRules.js`. No functional change — the wizard must behave identically.

- [ ] **Step 1: Swap the import**

In `QuoteWizard.js`, replace the `bundleConfig` import block (currently lines ~9-15) with:

```js
import {
  BYOB_BUNDLE_SLUGS,
  MIXER_SLUGS,
  BUNDLE_INCLUDED,
  BUNDLE_UNAVAILABLE,
  BUNDLE_COVERED,
  getSelectedBundleSlug,
  stripIncludedAddons,
  isIncludedByBundle,
  isUnavailableByBundle,
  toggleAddonWithRules,
  reconcileFlavorBlaster,
  enforceHostedMinimum,
  filterAddons,
} from '../../../utils/proposalRules';
```

- [ ] **Step 2: Delete the inline `getSelectedBundleSlug` and `stripIncludedAddons` `useCallback`s**

Remove the two `useCallback` definitions (currently lines ~79-96). Update their call sites to pass `addons` explicitly:
- `getSelectedBundleSlug(ids)` → `getSelectedBundleSlug(ids, addons)`
- `stripIncludedAddons(form.addon_ids)` → `stripIncludedAddons(form.addon_ids, addons)` (call sites: `fetchPreview`, `handleSubmit`, and the `ReviewStep` prop).

`ReviewStep` receives `stripIncludedAddons` as a prop — pass a wrapper: `stripIncludedAddons={(ids) => stripIncludedAddons(ids, addons)}` so `ReviewStep.js` stays unchanged.

- [ ] **Step 3: Replace `toggleAddon` body**

The `toggleAddon` function (lines ~304-345) becomes:

```js
const toggleAddon = (id) => {
  setForm(f => ({
    ...f,
    ...toggleAddonWithRules(
      { addonIds: f.addon_ids, syrupSelections: f.syrup_selections },
      id,
      addons,
    ),
  }));
};
```

- [ ] **Step 4: Replace the Flavor Blaster `useEffect` body**

The auto-deselect effect (lines ~263-273) becomes:

```js
useEffect(() => {
  setForm(f => {
    const next = reconcileFlavorBlaster(f.addon_ids, addons, f.client_provides_glassware);
    return next === f.addon_ids ? f : { ...f, addon_ids: next };
  });
}, [form.addon_ids, form.client_provides_glassware, addons]);
```

- [ ] **Step 5: Replace the hosted-minimum bump in `handleAlcoholChange`**

In `handleAlcoholChange` (line ~357), replace the inline ternary with:

```js
guest_count: enforceHostedMinimum(f.guest_count, value === 'hosted'),
```

- [ ] **Step 6: Replace `isIncludedByBundle` / `isUnavailableByBundle` derivations**

Remove the inline arrow definitions (lines ~388-391). Where they are called, pass args:
`isIncludedByBundle(slug)` → `isIncludedByBundle(slug, form.addon_ids, addons)` and likewise for `isUnavailableByBundle`. (These are passed into `ExtrasStep` — pass wrappers so `ExtrasStep.js` is untouched.)

- [ ] **Step 7: Replace the `filteredAddons` block**

Remove the inline `filteredAddons` filter (lines ~399-427). Replace with:

```js
const { visibleAddons: filteredAddons } = filterAddons({
  addons,
  isHosted,
  packageCategory: selectedPkg?.category,
  addonIds: form.addon_ids,
  guestCount,
});
```

`filterAddons` is already in the Step 1 import block. Keep the existing `groupedAddons` derivation that consumes `filteredAddons`.

- [ ] **Step 8: Repoint `ExtrasStep.js` at the shared `isQuantityCapable`**

`ExtrasStep.js` currently has an inline hardcoded slug list deciding which add-ons get a quantity stepper (`~line 50`: `addon.slug === 'banquet-server' || ... 'additional-bartender'`). Replace that inline list with the shared predicate so the wizard and cockpit never drift:

```js
import { isQuantityCapable } from '../../../../utils/proposalRules';
// ... then replace the inline `addon.slug === 'banquet-server' || ...` check with:
isQuantityCapable(addon)
```

Leave the separate `isSyrupAddon` / syrup-picker logic exactly as-is — `isQuantityCapable` covers only the four staffing-style add-ons, not syrups (by design). Verify the relative import depth: `steps/ExtrasStep.js` → `utils/` is `../../../../utils/proposalRules` (one level deeper than `QuoteWizard.js`).

- [ ] **Step 9: Build and verify no behavior change**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds, no ESLint errors.

Then manual smoke test (dev server): open the quote wizard, walk BYOB → pick The Formula → confirm ice/mixers show "included"; pick Flavor Blaster without glassware → confirm it auto-removes; switch to hosted with <25 guests → confirm bump to 25; confirm the extra-bartender / barback quantity steppers still appear. Behavior must match pre-refactor exactly.

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/website/quoteWizard/QuoteWizard.js client/src/pages/website/quoteWizard/steps/ExtrasStep.js
git commit -m "refactor(quote-wizard): consume shared proposalRules module"
```

---

## Phase 2 — Server

### Task 4: Schema migration — `client_provides_glassware` + read path

**Review tier:** 0 (no post-task review) — idempotent additive `ADD COLUMN` + a one-line detail-page display; the build + the migration verify-query are the gate.

**Files:**
- Modify: `server/db/schema.sql`
- Modify: `client/src/pages/admin/ProposalDetail.js`

- [ ] **Step 1: Add the column**

In `server/db/schema.sql`, in the `proposals` migration block, adjacent to the existing `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS class_options JSONB;` line, add:

```sql
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_provides_glassware BOOLEAN DEFAULT false;
```

- [ ] **Step 2: Apply to the dev database**

Run the project's schema-apply step (the same command used after any `schema.sql` change — check `package.json` / project docs; schema is idempotent so re-running is safe).
Expected: column added, no error.

- [ ] **Step 3: Verify**

Run a quick check against the dev DB:
`SELECT column_name FROM information_schema.columns WHERE table_name='proposals' AND column_name='client_provides_glassware';`
Expected: one row.

- [ ] **Step 4: Surface the flag on the admin proposal detail page**

The column must not be write-only. `crud.js`'s `GET /api/proposals/:id` already returns it (the handler does `SELECT p.*`), so the data reaches `ProposalDetail.js` with no server change. Render it: in the proposal's event/details area, when `proposal.client_provides_glassware` is truthy, show a small line — e.g. `Client provides own glassware` — alongside the other event facts. This is meaningful to the admin because it is what makes a Flavor Blaster line item valid.

- [ ] **Step 5: Build + verify**

Run: `cd client && CI=true npx react-scripts build` → succeeds.
On the dev server, open a proposal that has the flag set → confirm the "Client provides own glassware" line shows; open one without it → confirm the line is absent.

- [ ] **Step 6: Update ARCHITECTURE.md**

Per CLAUDE.md mandatory-docs rule, add `client_provides_glassware` to the `proposals` table description in `ARCHITECTURE.md`'s Database Schema section.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.sql client/src/pages/admin/ProposalDetail.js ARCHITECTURE.md
git commit -m "feat(proposals): add client_provides_glassware column + detail-page display"
```

---

### Task 5: `adminWriteLimiter` rate limiter

**Review tier:** 0 (no post-task review) — a single rate-limiter config block; the load-check in Step 3 is the gate.

**Files:**
- Modify: `server/middleware/rateLimiters.js`

- [ ] **Step 1: Add the limiter**

In `server/middleware/rateLimiters.js`, before the `module.exports` line, add:

```js
// Admin proposal writes (POST /proposals, PATCH /:id/status) can fire client
// emails — every →sent transition emails the client. Keyed by user id, not IP,
// so an office NAT doesn't share a bucket. 10/min is still far above any human
// admin workflow (a person creating proposals one at a time never approaches
// it) while meaningfully capping the email-spam blast radius of a compromised
// admin token.
const adminWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.user && req.user.id ? `admin-${req.user.id}` : req.ip),
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
```

This limiter MUST be placed AFTER the `auth` middleware in every route chain (Tasks 7 + 8) so `req.user` is populated when `keyGenerator` runs — the `req.ip` fallback only exists as a defensive last resort, not a normal path.

- [ ] **Step 2: Export it**

Update the `module.exports` line to include `adminWriteLimiter`.

- [ ] **Step 3: Verify it loads**

Run: `node -e "console.log(typeof require('./server/middleware/rateLimiters').adminWriteLimiter)"`
Expected: `function`.

- [ ] **Step 4: Commit**

```bash
git add server/middleware/rateLimiters.js
git commit -m "feat(proposals): adminWriteLimiter for proposal-write endpoints"
```

---

### Task 6: `sendProposalSentEmail` helper

**Review tier:** 1 (Claude code-review) — email side effect + Sentry PII handling; has its own tests, one pass confirms the never-throws + no-PII contract.

**Files:**
- Create: `server/utils/sendProposalSentEmail.js`
- Test: `server/utils/sendProposalSentEmail.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/sendProposalSentEmail.test.js`. The helper depends on `sendEmail` and `emailTemplates`; the test injects fakes via the exported `__setDeps` seam:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = require('./sendProposalSentEmail');
const { sendProposalSentEmail, __setDeps } = mod;

const baseProposal = {
  id: 42, token: 'tok-abc', client_email: 'client@example.com',
  client_name: 'Pat', event_type: 'Wedding', event_type_custom: null,
  sent_at: null,
};

test('sends the proposalSent template to the client', async () => {
  let captured = null;
  __setDeps({
    sendEmail: async (args) => { captured = args; },
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
  });
  await sendProposalSentEmail(baseProposal, { actorType: 'admin' });
  assert.equal(captured.to, 'client@example.com');
  assert.equal(captured.subject, 'S');
});

test('never throws when sendEmail rejects', async () => {
  __setDeps({
    sendEmail: async () => { throw new Error('Resend down'); },
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
  });
  await assert.doesNotReject(() => sendProposalSentEmail(baseProposal, { actorType: 'admin' }));
});

test('Sentry capture on email failure carries no client email / PII', async () => {
  const captures = [];
  __setDeps({
    // Raw Resend errors can embed the recipient address in the message.
    sendEmail: async () => { throw new Error('Resend rejected to=client@example.com'); },
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
    Sentry: { captureException: (err, ctx) => captures.push({ err, ctx }) },
  });
  process.env.SENTRY_DSN_SERVER = 'test-dsn';
  await sendProposalSentEmail(baseProposal, { actorType: 'admin' });
  delete process.env.SENTRY_DSN_SERVER;
  assert.equal(captures.length, 1);
  const { err, ctx } = captures[0];
  // Must capture the SANITIZED error, not the raw Resend error.
  assert.ok(!/@/.test(err.message), 'captured error message must not contain an email');
  assert.ok(!JSON.stringify(ctx.extra).includes('@'), 'Sentry extra must not contain PII');
  assert.equal(ctx.extra.proposalId, 42);
});

test('still emails when sent_at is already set (no idempotency skip)', async () => {
  let called = false;
  __setDeps({
    sendEmail: async () => { called = true; },
    emailTemplates: { proposalSent: () => ({ subject: 'S', html: 'H' }) },
  });
  await sendProposalSentEmail({ ...baseProposal, sent_at: '2026-05-01T00:00:00Z' }, { actorType: 'admin' });
  assert.equal(called, true);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test server/utils/sendProposalSentEmail.test.js`
Expected: FAIL — `Cannot find module './sendProposalSentEmail'`.

- [ ] **Step 3: Create the helper**

Create `server/utils/sendProposalSentEmail.js`. Match the existing `proposalSent` template call shape in `crud.js:512` and the `PUBLIC_SITE_URL` usage:

```js
// Post-commit, best-effort client email for a proposal that just entered the
// 'sent' state. NEVER throws — the proposal + invoice are already committed,
// so an email failure is recoverable (admin resends from the detail page).
// Invoice creation is NOT here — it runs inside the caller's DB transaction
// via createInvoiceOnSend. See the 2026-05-20 manual-proposal-overhaul spec.
const realSentry = require('@sentry/node');
const realSendEmail = require('./email').sendEmail;
const realEmailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');

const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://drbartender.com';

// Dependency seam for tests.
let _deps = { sendEmail: realSendEmail, emailTemplates: realEmailTemplates, Sentry: realSentry };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

async function sendProposalSentEmail(proposal, { actorType = 'admin' } = {}) {
  try {
    if (!proposal || !proposal.client_email) return;
    const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${proposal.token}`;
    const eventTypeLabel = getEventTypeLabel({
      event_type: proposal.event_type,
      event_type_custom: proposal.event_type_custom,
    });
    const tpl = _deps.emailTemplates.proposalSent({
      clientName: proposal.client_name,
      eventTypeLabel,
      proposalUrl,
      planUrl: null,
    });
    await _deps.sendEmail({ to: proposal.client_email, ...tpl });
  } catch (emailErr) {
    // Capture a SANITIZED error. A raw Resend/HTTP error's .message or .stack
    // can embed the recipient address — never hand the raw error to Sentry.
    // Only proposalId + actorType + a coarse cause code go in `extra`.
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.Sentry.captureException(new Error('proposalSent email failed'), {
        tags: { route: 'proposals/sent', issue: 'email' },
        extra: {
          proposalId: proposal && proposal.id,
          actorType,
          cause: (emailErr && (emailErr.code || emailErr.name)) || 'unknown',
        },
      });
    }
    // Log the proposal id, NOT emailErr.message (which may contain the email).
    console.error('Proposal sent email failed (non-blocking) for proposal',
      proposal && proposal.id);
    // Do NOT re-throw.
  }
}

module.exports = { sendProposalSentEmail, __setDeps };
```

Before implementing, confirm the real module paths: `sendEmail` export location (`./email`), the template module name (`./emailTemplates`), and that `getEventTypeLabel` lives in `server/utils/eventTypes.js`. Adjust the `require` paths to match the actual files.

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test server/utils/sendProposalSentEmail.test.js`
Expected: PASS — 4/4.

- [ ] **Step 5: Commit**

```bash
git add server/utils/sendProposalSentEmail.js server/utils/sendProposalSentEmail.test.js
git commit -m "feat(proposals): post-commit sendProposalSentEmail helper"
```

---

### Task 7: Rewrite `POST /api/proposals` + widen `POST /proposals/calculate`

**Review tier:** 2 (Claude code-review + Codex) — the highest-risk task: money math, in-transaction invoice, `send_now` branching, the authoritative validator call.

**Files:**
- Modify: `server/routes/proposals/crud.js`
- Modify: `server/routes/proposals/metadata.js` (the `/calculate` preview endpoint)
- Test: `server/routes/proposals/crud.test.js` (create if absent)

- [ ] **Step 1: Write the failing tests**

Create or extend `server/routes/proposals/crud.test.js`. Use the project's existing route-test pattern (check a sibling like `server/routes/**/__tests__` or an existing `*.test.js` that exercises a router; match its DB-setup/teardown approach). The cases to cover:

```js
// server/routes/proposals/crud.test.js — node:test
// Cases (match the project's existing route-test harness for app/DB setup):
//
// 1. POST /api/proposals { send_now: true, valid payload }
//    → 201, proposal.status === 'sent', an invoices row exists for proposal.id,
//      sendProposalSentEmail was invoked once.
// 2. POST /api/proposals { send_now: false }
//    → 201, proposal.status === 'draft', NO invoices row, email NOT invoked.
// 3. POST /api/proposals { class_options.top_shelf_requested: true, send_now: true }
//    → 201, proposal.status === 'draft', NO invoices row, email NOT invoked.
// 4. POST /api/proposals { hosted package, guest_count: 10 }
//    → 400 ValidationError, zero new proposals rows.
// 5. POST /api/proposals { addon_ids: [twoBundleIds] }
//    → 400 ValidationError (bundle mutex), zero new proposals rows.
// 6. POST /api/proposals with createInvoiceOnSend stubbed to throw
//    → request errors, zero new proposals rows (txn rolled back); a clean
//      retry yields exactly one proposal.
// 7. 11 rapid POSTs from one user → the 11th returns 429 (limiter max=10/min).
// 8. POST /api/proposals { addon_ids:[additionalBartenderId], addon_quantities:{[id]:2} }
//    → the persisted proposal_addons row for that addon has quantity 2, and the
//      pricing snapshot total reflects the x2 (not x1).
// 9. POST /api/proposals { top_shelf_requested: true on a NON-class package }
//    → 400 ValidationError, zero new proposals rows.
```

Write each as a concrete `test(...)` using the harness. Stub `sendProposalSentEmail` and (for case 6) `createInvoiceOnSend` via the same dependency-injection seam the route module exposes (see Step 3).

- [ ] **Step 2: Run the tests, verify they fail**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: FAIL — current `POST /` ignores `send_now`, never sets `status`, never creates an invoice.

- [ ] **Step 3: Rewrite the `POST /` handler**

In `server/routes/proposals/crud.js`:

1. Add imports near the top:
```js
const { validateProposalRules } = require('../../utils/proposalRules');
const { sendProposalSentEmail } = require('../../utils/sendProposalSentEmail');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
// createInvoiceOnSend is already imported (used by PATCH /:id/status).
```

2. Add `adminWriteLimiter` to the route chain: `router.post('/', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {`

3. Destructure the new body fields alongside the existing ones:
```js
addon_quantities, syrup_selections, class_options, client_provides_glassware,
send_now,
```

4. **Fetch the FULL active addon set once** (mandatory — not the selected-only fetch). The current handler fetches `service_addons WHERE id = ANY($1)` (selected ids only); replace that with one unconditional fetch that serves BOTH the validator (which needs `requires_addon_slug` parent rows absent from the selection) AND the priced-addon mapping:
```js
const allAddonsResult = await dbClient.query(
  'SELECT * FROM service_addons WHERE is_active = true'
);
const allActiveAddons = allAddonsResult.rows;
// Selected rows for pricing — carry BOTH variant (champagne-toast NA bubbles)
// and quantity (extra bartenders / barback / etc) onto each addon row.
const selectedAddons = allActiveAddons
  .filter(a => (addon_ids || []).includes(a.id))
  .map(a => ({
    ...a,
    variant: addon_variants?.[String(a.id)] || null,
    quantity: safeAddonQty(addon_quantities?.[String(a.id)]),
  }));
```
Import `safeAddonQty` from wherever `public.js` imports it (it already uses `safeAddonQty(addon_quantities?.[...])` for exactly this — match that import).

5. Compute the Top Shelf flag, reject Top-Shelf-against-non-class, and run the authoritative validator:
```js
const isTopShelfClass =
  pkgResult.rows[0].bar_type === 'class'
  && !!class_options && class_options.top_shelf_requested === true;

// Reject Top Shelf requested against a non-class package — mirrors the guard
// public.js already has (public.js:295). A scripted POST must not short-circuit
// pricing on a full-bar package.
if (class_options && class_options.top_shelf_requested === true
    && pkgResult.rows[0].bar_type !== 'class') {
  throw new ValidationError({ class_options: 'Top Shelf is only valid for class packages' });
}

// Authoritative rule gate. A thrown ValidationError here triggers the existing
// catch → ROLLBACK; only SELECTs have run, so the rollback is harmless.
// The validator gets the FULL active set for requires_addon_slug parent lookup.
if (!isTopShelfClass) {
  validateProposalRules({
    pkg: pkgResult.rows[0],
    guestCount: gc,
    addonIds: (addon_ids || []),
    addons: allActiveAddons,
    clientProvidesGlassware: !!client_provides_glassware,
  });
}
```

6. Normalize `class_options` exactly the way `public.js` does. Copy its `cleanClassOptions` logic (`public.js:251-258`): allowlist `spirit_category` to `{'whiskey_bourbon','tequila_mezcal'}` (else `null`), coerce `top_shelf_requested` to a strict boolean, and only keep the object for class bookings. Persist the NORMALIZED object — never the raw request body — so `ProposalDetail.js` (which reads `class_options.spirit_category` / `.top_shelf_requested`) sees the same shape the wizard path produces.

7. Determine status + branch:
```js
const sendNow = send_now !== false; // default true
const proposalStatus = (sendNow && !isTopShelfClass) ? 'sent' : 'draft';
const snapshot = isTopShelfClass
  ? null
  : calculateProposal({ pkg: pkgResult.rows[0], guestCount: gc, durationHours: dh,
                        numBars: nb, numBartenders: num_bartenders,
                        addons: selectedAddons,            // carries variant + quantity
                        syrupSelections: syrup_selections || [] });
```
For Top Shelf, mirror `public.js`'s handling: `snapshot` null, `total_price` 0, `num_bartenders` 1, persist the normalized `class_options`.

8. Inside the existing `BEGIN`/`COMMIT` block:
   - Add `status`, `sent_at`, `class_options` (normalized), `client_provides_glassware` to the `INSERT INTO proposals (...)` column list and values. `sent_at` = `proposalStatus === 'sent' ? NOW() : NULL`.
   - The `proposal_addons` bulk insert must persist `quantity` from `selectedAddons` (it already persists `variant`); confirm the snapshot's addon rows carry the quantity through.
   - After the `proposal_addons` bulk insert and the activity-log insert, **before `COMMIT`**, add:
```js
if (proposalStatus === 'sent') {
  await createInvoiceOnSend(proposal.id, dbClient); // in-txn — rolls back on failure
}
```

9. After `COMMIT`, before `res.status(201).json(proposal)`:
```js
if (proposalStatus === 'sent') {
  await sendProposalSentEmail(proposal, { actorType: 'admin' }); // never throws
}
```

10. Expose a dependency seam for tests if the route module doesn't already have one — e.g. a module-level `let _deps = { createInvoiceOnSend, sendProposalSentEmail }` plus an exported `__setDeps`, and call `_deps.createInvoiceOnSend(...)` / `_deps.sendProposalSentEmail(...)`. Match whatever DI pattern the existing route tests in this repo already use; if route tests stub via a different mechanism, follow that instead.

- [ ] **Step 4: Widen `POST /proposals/calculate` in `metadata.js`**

The cockpit's live-pricing dock calls `POST /proposals/calculate`, which is handled in `server/routes/proposals/metadata.js` (NOT `public.js`). That handler currently destructures `addon_variants` only and maps `variant` onto addon rows — it has no `addon_quantities` path, so the Task 11 quantity stepper would not move the previewed price.

In `metadata.js`'s `/calculate` handler:
1. Destructure `addon_quantities` and `syrup_selections` from `req.body` alongside the existing `addon_variants`.
2. When building the addon rows passed to `calculateProposal`, add `quantity: safeAddonQty(addon_quantities?.[String(a.id)])` next to the existing `variant` mapping (import `safeAddonQty` the same way `public.js`/`crud.js` do).
3. Pass `syrupSelections: syrup_selections || []` into the `calculateProposal` call.

This makes the cockpit preview, the persisted `POST /proposals` snapshot, and the wizard all compute identical totals for identical selections.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS — all 9 cases.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/metadata.js server/routes/proposals/crud.test.js
git commit -m "feat(proposals): send_now branching, in-txn invoice, rule gate, quantity-aware calculate"
```

---

### Task 8: Refactor `PATCH /:id/status` to use the shared path

**Review tier:** 2 (Claude code-review + Codex) — transaction wrap, `SELECT ... FOR UPDATE` race fix, in-transaction invoice, refactor of a live send-flow.

**Files:**
- Modify: `server/routes/proposals/crud.js`
- Test: `server/routes/proposals/crud.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `crud.test.js`:

```js
// 10. PATCH /api/proposals/:id/status → 'sent' on a draft
//     → status 'sent', an invoices row exists, sendProposalSentEmail invoked.
// 11. PATCH /api/proposals/:id/status: draft→sent→modified, then →'sent' again
//     on a proposal whose sent_at is already set
//     → sendProposalSentEmail invoked AGAIN (re-send works, no sent_at skip).
```

- [ ] **Step 2: Run, verify case 11 fails**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: case 10 may pass already; case 11 fails if any `sent_at` gate is present, or both fail once the inline block is mid-refactor.

- [ ] **Step 3: Refactor the handler**

In `PATCH /:id/status`:

1. Add `adminWriteLimiter` to the route chain, AFTER `auth` and `requireAdminOrManager`.

2. Move the status-transition precheck INSIDE a new transaction and lock the row. Today the `STATUS_TRANSITIONS` validity check reads `SELECT status FROM proposals WHERE id=$1` (~`crud.js:465`) BEFORE any transaction — a check-then-act race lets two concurrent `→sent` PATCHes both read `draft`, both pass, both proceed (duplicate activity-log row + double client email; the invoice is safe via idempotency). Wrap the handler body and read the status under a row lock:
```js
const dbClient = await pool.connect();
try {
  await dbClient.query('BEGIN');
  // Lock the row + read current status under the lock — serializes concurrent transitions.
  const cur = await dbClient.query(
    'SELECT status FROM proposals WHERE id = $1 FOR UPDATE', [req.params.id]
  );
  if (!cur.rows[0]) throw new NotFoundError('Proposal not found');
  // ... existing STATUS_TRANSITIONS validity check, against cur.rows[0].status ...
  // ... existing UPDATE proposals SET status / sent_at / accepted_at ... (use dbClient)
  // ... existing INSERT proposal_activity_log (use dbClient)
  if (status === 'sent') {
    await createInvoiceOnSend(req.params.id, dbClient); // in-txn — rolls back on failure
  }
  await dbClient.query('COMMIT');
} catch (err) {
  try { await dbClient.query('ROLLBACK'); } catch (rb) { console.error('ROLLBACK failed:', rb); }
  throw err;
} finally {
  dbClient.release();
}
```
With `FOR UPDATE`, the second concurrent caller blocks until the first commits, then re-reads the now-updated status and the transition check rejects the duplicate.

3. Delete the inline post-response email block (currently ~lines 495-521) and the inline `createInvoiceOnSend` block (~lines 523-533).

4. After `COMMIT`, if `status === 'sent'`, send the client email. The proposal re-fetch (joined to `clients` — `sendProposalSentEmail` needs `client_email`, `client_name`, `token`, `event_type*`) AND the helper call must sit together in their OWN try/catch: they run post-COMMIT, so a failed SELECT here must not 500 a request whose status change already succeeded.
```js
if (status === 'sent') {
  try {
    const pd = await pool.query(`
      SELECT p.token, p.event_type, p.event_type_custom,
             c.name AS client_name, c.email AS client_email
      FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`, [req.params.id]);
    if (pd.rows[0]) {
      await sendProposalSentEmail(
        { ...pd.rows[0], id: Number(req.params.id) },
        { actorType: 'admin' },
      );
    }
  } catch (e) {
    console.error('Post-send email step failed (non-blocking) for proposal', req.params.id);
  }
}
```
There is no `sent_at` check — the email fires on every `→sent` transition (matches pre-refactor behavior; this is what makes `modified→sent` re-sends work).

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS — all 11 cases.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/crud.test.js
git commit -m "refactor(proposals): PATCH status uses in-txn invoice + shared email helper"
```

---

### Task 9: Wire `POST /public/submit` to the shared path (parity #2)

**Review tier:** 2 (Claude code-review + Codex) — an unauthenticated public endpoint gaining money side effects (invoice creation) plus the `admin_notes` clobber removal.

**Files:**
- Modify: `server/routes/proposals/public.js`

> **Accepted-risk note (write amplification).** After this task, every successful `POST /public/submit` — an unauthenticated endpoint — also creates an `invoices` row + line items + consumes `nextval('invoice_number_seq')`. `publicLimiter` (20 / 15 min per IP) caps this; 20 invoices per IP per window is a tolerable worst case and the sequence gaps are cosmetic (`invoice_number` has no contiguity requirement). Decision: keep `publicLimiter` as-is, do not add a separate gate. This note records the deliberate accept.

- [ ] **Step 1: Fetch the full active addon set + add the rule gate**

`public.js` currently fetches `service_addons WHERE id = ANY($1)` — selected ids only. `validateProposalRules` needs the FULL active set so `requires_addon_slug` parent lookups can see parent rows absent from the selection. Add an unconditional fetch and pass it to the validator (the existing selected-addon fetch + `safeAddonQty` mapping stays, for pricing):

```js
const { validateProposalRules } = require('../../utils/proposalRules'); // at top of file
// ... inside the handler, after pkgResult is fetched ...
const allActiveAddons = (await dbClient.query(
  'SELECT * FROM service_addons WHERE is_active = true'
)).rows;
if (!isTopShelfClass) {
  validateProposalRules({
    pkg: pkgResult.rows[0],
    guestCount: gc,
    addonIds: (addon_ids || []),
    addons: allActiveAddons,
    clientProvidesGlassware: !!client_provides_glassware,
  });
}
```

- [ ] **Step 2: Add the in-transaction invoice call**

Inside the existing `BEGIN`/`COMMIT` block, after the `proposal_addons` insert and activity-log insert, before `COMMIT`:

```js
if (proposalStatus === 'sent') {
  await createInvoiceOnSend(proposal.id, dbClient);
}
```
Add `const { createInvoiceOnSend } = require('../../utils/invoiceHelpers');` at the top if not already imported (match the export name used in `crud.js`).

- [ ] **Step 3: Swap the email block for the helper**

Replace the existing post-commit `emailTemplates.proposalSent` + `sendEmail` block in the non-Top-Shelf branch with:

```js
await sendProposalSentEmail(proposal, { actorType: 'client' });
```
Add `const { sendProposalSentEmail } = require('../../utils/sendProposalSentEmail');` at the top. Leave the Top Shelf branch and its `topShelfClassRequestAdmin` admin email exactly as-is.

- [ ] **Step 4: Persist `client_provides_glassware` to the column; drop the `admin_notes` clobber**

`public.js` currently builds a `glasswareNote` string and appends it into `admin_notes` (~`public.js:334`). Now that `proposals.client_provides_glassware` exists (Task 4), that free-text hack must go — leaving it would double-store the flag and the spec chose the column specifically to stop `admin_notes` clobbering.

1. Delete the `glasswareNote` variable and remove it from the `admin_notes` value in the `INSERT INTO proposals`.
2. Add `client_provides_glassware` to the `INSERT INTO proposals (...)` column list, with value `!!client_provides_glassware`.

- [ ] **Step 5: Verify the wizard submit end-to-end**

Run: `cd client && CI=true npx react-scripts build` (confirm nothing client-side broke).
Then on the dev server: submit a quote through the public wizard → confirm the proposal is created `status='sent'`, an `invoices` row now exists for it, `client_provides_glassware` is set on the row (not in `admin_notes`), and the client email still sends.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/public.js
git commit -m "feat(proposals): wizard submit creates invoice in-txn, shared email helper, glassware column"
```

---

## Phase 3 — Cockpit UI

### Task 10: Cockpit consumes shared rules + glassware checkbox

**Review tier:** 1 (Claude code-review) — single-layer React: form state, shared-rules wiring, the hosted-minimum handler change; the reviewer checks effect deps + the handler-based enforcement.

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js`

- [ ] **Step 1: Import the shared rules**

Add to `ProposalCreate.js` imports:

```js
import {
  getSelectedBundleSlug,
  toggleAddonWithRules,
  filterAddons,
  enforceHostedMinimum,
  reconcileFlavorBlaster,
  isQuantityCapable,
} from '../../utils/proposalRules';
```

- [ ] **Step 2: Add `client_provides_glassware` to form state**

In the `useState` form initializer (currently ~line 109), add `client_provides_glassware: false,` and `addon_quantities: {},` and `syrup_selections: [],` and `class_options: null,`.

- [ ] **Step 3: Replace `toggleAddon`**

Replace the cockpit's `toggleAddon` (currently ~lines 197-208) with:

```js
const toggleAddon = useCallback((id) => {
  setForm(f => {
    const next = toggleAddonWithRules(
      { addonIds: f.addon_ids, syrupSelections: f.syrup_selections },
      id, addons,
    );
    // preserve the cockpit's addon_variants cleanup for removed addons
    const newVariants = { ...f.addon_variants };
    if (!next.addon_ids.includes(id)) delete newVariants[String(id)];
    return { ...f, ...next, addon_variants: newVariants };
  });
}, [addons]);
```

- [ ] **Step 4: Replace `filteredAddons`**

Replace the `useMemo` `filteredAddons` (currently ~lines 213-218) with:

```js
const { visibleAddons: filteredAddons, isIncludedMap, isUnavailableMap } = useMemo(
  () => filterAddons({
    addons,
    isHosted: isHostedPackage,
    packageCategory: selectedPkg?.category,
    addonIds: form.addon_ids,
    guestCount: form.guest_count,
  }),
  [addons, isHostedPackage, selectedPkg, form.addon_ids, form.guest_count],
);
```

- [ ] **Step 5: Enforce hosted minimum (on blur + on package select), reconcile Flavor Blaster**

The hosted 25-guest floor is enforced on the guest-count field's `onBlur` AND when a hosted package is selected — NOT via a `useEffect` watching `isHostedPackage`. (A watching effect does not re-run when the admin types a new guest count after the package is already chosen, so it silently bypasses the floor. The wizard enforces this on its change handler `handleAlcoholChange`, not an effect — match that.)

Guest-count input — add an `onBlur` to the Event section's guest-count `<input>` (`onBlur`, not `onChange`, so the admin can type "1" → "10" without a mid-keystroke bump):
```js
onBlur={(e) => update('guest_count', enforceHostedMinimum(e.target.value, isHostedPackage))}
```

Package selection — in `PackageSection`'s `selectPkg`, bump `guest_count` when the newly-selected package is hosted (`form` is already a prop of `PackageSection`):
```js
const selectPkg = (pkg) => {
  const pkgIsHosted = pkg.pricing_type === 'per_guest';
  merge({
    package_id: String(pkg.id),
    addon_ids: [], addon_variants: {},
    guest_count: enforceHostedMinimum(form.guest_count, pkgIsHosted),
  });
};
```

Flavor Blaster reconciliation stays an effect — `reconcileFlavorBlaster` returns the SAME array reference when nothing changes, so the `next === f.addon_ids` guard genuinely prevents a render loop:
```js
useEffect(() => {
  setForm(f => {
    const next = reconcileFlavorBlaster(f.addon_ids, addons, f.client_provides_glassware);
    if (next === f.addon_ids) return f;
    toast.info('Flavor Blaster removed — requires real glassware.');
    return { ...f, addon_ids: next };
  });
}, [form.addon_ids, form.client_provides_glassware, addons, toast]);
```

- [ ] **Step 6: Add the "Client provides glassware" checkbox**

In `AddonSection`, above the addon list, add a checkbox row bound to `form.client_provides_glassware` (call `update('client_provides_glassware', e.target.checked)`). Label: "Client provides their own glassware". Pass `form`/`update` into `AddonSection` if not already available.

- [ ] **Step 7: Build + manual verify**

Run: `cd client && CI=true npx react-scripts build` → succeeds.
Dev server: cockpit → hosted package + type guest_count 10 → bumps to 25. Add Flavor Blaster with no glassware → toast + auto-remove. Check the glassware box → Flavor Blaster can stay.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat(proposal-create): cockpit consumes shared rules + glassware checkbox"
```

---

### Task 11: Cockpit addon section — bundle badges, quantity stepper, syrup picker

**Review tier:** 1 (Claude code-review) — single-layer cockpit UI; the reviewer checks the quantity stepper feeds the preview correctly and the bundle badges gate add/remove.

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js`

- [ ] **Step 1: Bundle badges in `AddonSection`**

Pass `isIncludedMap` and `isUnavailableMap` (from Task 10 Step 4) into `AddonSection`. In the selected-addon rows and the power-search dropdown results, when `isIncludedMap[addon.slug]` is true render a greyed "Included with bundle" badge and make the remove control inert; when `isUnavailableMap[addon.slug]` is true render a greyed "Unavailable with bundle" badge and make the add action inert.

- [ ] **Step 2: Quantity stepper**

For any selected addon where `isQuantityCapable(addon)` is true (imported from `proposalRules` in Task 10 Step 1 — the canonical predicate, also used by `ExtrasStep` after Task 3), render a 1–10 stepper in the selected-addon row bound to `form.addon_quantities[addon.id]` (default 1). On change:
```js
setForm(f => ({
  ...f,
  addon_quantities: { ...f.addon_quantities, [addon.id]: Math.min(10, Math.max(1, n)) },
}));
```
Handcrafted syrups are deliberately NOT `isQuantityCapable` — the syrup bottle count is driven by the syrup picker (Step 4), not this generic stepper.

- [ ] **Step 3: Pass quantities into the pricing preview**

In the pricing-preview effect (currently ~line 152), add `addon_quantities: form.addon_quantities` and `syrup_selections: form.syrup_selections` to the `POST /proposals/calculate` body, and add `form.addon_quantities` / `form.syrup_selections` to the effect's dependency array.

- [ ] **Step 4: Syrup picker**

When Handcrafted Syrups is selected, render an inline chip multi-select for syrup flavors bound to `form.syrup_selections` (mirror the wizard's `ExtrasStep` syrup UI — reuse the same flavor list source).

- [ ] **Step 5: Build + manual verify**

Run: `cd client && CI=true npx react-scripts build` → succeeds.
Dev server: BYOB + The Formula → ice/mixers show "Included with bundle", greyed. Add 2 extra bartenders via stepper → pricing dock reflects ×2. Select Handcrafted Syrups → flavor chips appear.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat(proposal-create): bundle badges, quantity stepper, syrup picker"
```

---

### Task 12: Cockpit package section — Top Shelf class flow

**Review tier:** 1 (Claude code-review) — single-layer cockpit UI; the reviewer confirms class detection keys off `bar_type === 'class'` (not `category`).

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js`

- [ ] **Step 1: Detect class packages**

In `PackageSection`, compute `isClassPackage` from the selected package: `selectedPkg?.bar_type === 'class'` (NOT `category` — class packages carry `category='hosted'`).

- [ ] **Step 2: Render Top Shelf controls**

When `isClassPackage`, render two controls below the package grid:
- A spirit-category `<select>`: options Whiskey/Bourbon (`whiskey_bourbon`), Tequila/Mezcal (`tequila_mezcal`). Bound to `form.class_options?.spirit_category`.
- A "Top Shelf requested (custom pricing)" checkbox bound to `form.class_options?.top_shelf_requested`.

On change, `merge({ class_options: { spirit_category, top_shelf_requested } })`.

- [ ] **Step 3: Pricing dock — custom-pricing state**

When `form.class_options?.top_shelf_requested` is true, the `PricingDock` shows "Custom pricing — admin will follow up" instead of a total, and the preview/snapshot are skipped (guard the pricing-preview effect: if Top Shelf, `setPreview(null)` and return early).

- [ ] **Step 4: Build + manual verify**

Run: `cd client && CI=true npx react-scripts build` → succeeds.
Dev server: select a class package → spirit dropdown + Top Shelf checkbox appear. Check Top Shelf → pricing dock shows the custom-pricing message.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat(proposal-create): Top Shelf class flow in package section"
```

---

### Task 13: Cockpit submit — send_now branching + buttons

**Review tier:** 1 (Claude code-review) — payload wiring + button gating; the server-side money logic it triggers was already Tier-2 reviewed in Task 7, so one pass on the client integration suffices.

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js`

- [ ] **Step 1: Add `sendNow` UI state**

Add `const [saveAsDraft, setSaveAsDraft] = useState(false);` near the other `useState`s. `send_now` sent to the API is `!saveAsDraft`.

- [ ] **Step 2: Repurpose `SendSection`**

Replace the placeholder `SendSection` body with: a two-line summary ("Create & send → client gets the proposal email at [form.client_email] · Sign & Pay live immediately · auto-creates the first invoice") and a "Save as draft instead" checkbox bound to `saveAsDraft`/`setSaveAsDraft`.

- [ ] **Step 3: Wire the submit payload**

In `handleSubmit`, add to the payload:
```js
addon_quantities: form.addon_quantities,
syrup_selections: form.syrup_selections,
class_options: form.class_options,
client_provides_glassware: form.client_provides_glassware,
send_now: !saveAsDraft,
```

- [ ] **Step 4: Button labels + gating**

The primary button label is `saveAsDraft ? 'Save as draft' : 'Create & send'` (top bar + pricing-dock footer). When `!saveAsDraft`, disable the primary button unless `status.client === 'done' && status.event === 'done' && status.package === 'done'` (the `fieldStatus` helper already computes these). Add a `title` on the disabled button: "Add client, event date, and package to send."

- [ ] **Step 5: Build + manual verify**

Run: `cd client && CI=true npx react-scripts build` → succeeds.
Dev server: fill a full proposal → "Create & send" → lands on the detail page in `sent`. New proposal, check "Save as draft instead" → button relabels → submit → lands in `draft`.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat(proposal-create): send_now branching with Create & send / Save as draft"
```

---

### Task 14: Cockpit pricing dock trust block

**Review tier:** 0 (no post-task review) — static trust-block copy; the build is the gate.

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js`

- [ ] **Step 1: Add the trust block**

In `PricingDock`, below the breakdown, add a small Apothecary-Press-styled trust block matching the wizard's `wz-price-trust`: "Stripe · sign & pay electronically", "$100 deposit locks the date". Static copy.

- [ ] **Step 2: Build + manual verify**

Run: `cd client && CI=true npx react-scripts build` → succeeds. Dev server: confirm the trust block renders in the pricing dock and the footer button label tracks the Task 13 toggle.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat(proposal-create): Stripe sign-and-pay trust block in pricing dock"
```

---

## Phase 4 — Verification

### Task 15: Full manual test pass

**Review tier:** 0 (no post-task review) — this task *is* the verification pass.

**Files:** none (verification only)

- [ ] **Step 1: Run the spec's manual test plan**

With the dev server running, execute manual tests 1–11 from the spec's Test Plan section. Key ones:
- #1 cockpit "Create & send" → Sign & Pay visible on the public link → Stripe test deposit completes.
- #2 "Save as draft" → detail page "Send to client" → email + invoice fire.
- #7 pricing equivalence: Full Compound, 75 guests, 4 hr, Champagne Toast + Garnish Package + Syrups — totals match to the cent between wizard and cockpit.
- #10 `modified→sent` re-send emails the client again.
- #11 simulate `createInvoiceOnSend` failure → no orphan proposal, clean retry.

- [ ] **Step 2: Run the full server test suite**

Run: `node --test server/utils/proposalRules.test.js server/utils/sendProposalSentEmail.test.js server/routes/proposals/crud.test.js`
Expected: all PASS.

- [ ] **Step 3: Client build + client unit test**

Run: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=proposalRules`
Expected: the `proposalRules` Jest suite passes.
Then run: `cd client && CI=true npx react-scripts build`
Expected: succeeds, no ESLint errors.

- [ ] **Step 4: Update docs**

Per CLAUDE.md mandatory-docs rule, confirm `ARCHITECTURE.md` reflects: the new `proposals.client_provides_glassware` column (Task 4 covered this), the `validateProposalRules` server util, and the `sendProposalSentEmail` util. Update `README.md`'s folder tree with the three new `utils/` files.

- [ ] **Step 5: Commit any doc updates**

```bash
git add ARCHITECTURE.md README.md
git commit -m "docs: manual proposal overhaul — new utils + schema column"
```

---

## Notes for the executor

- **Per-task review tiers.** Each task header carries a **Review tier** (0/1/2) — see the Review Tiers section near the top. After a task's own tests/build pass, run the tiered review (none / one Claude `code-review` subagent / Claude + Codex) before starting the next task. This is separate from and additional to the pre-push agents.
- **No pushing.** This plan only commits locally. The user controls push timing (CLAUDE.md Rule 4). Pre-push review agents run on the user's push cue, not here.
- **`send_now` default is `true`.** Once Task 7 ships, `POST /api/proposals` sends emails by default. The cockpit isn't wired to send `send_now` until Task 13 — between Task 7 and Task 13 the cockpit's existing "Create proposal" button would post without `send_now` and therefore default to `true` (sending). If Phase 2 and Phase 3 land in separate pushes, ship Task 13 in the same push as Task 7, or temporarily default the cockpit payload to `send_now: false` until Task 13. Simplest: execute and push Phases 2 + 3 together.
- **DB tests.** `crud.test.js` needs a test database. Match the existing route-test harness in the repo for connection/teardown; if no route tests exist yet, the in-transaction-rollback case (#6) and rate-limit case (#7) are the highest-value — prioritize them.
- **Class package detection** is `bar_type === 'class'` everywhere — never `category` (class packages are seeded `category='hosted'`).
