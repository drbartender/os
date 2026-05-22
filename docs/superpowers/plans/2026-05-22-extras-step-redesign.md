# Extras Step Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the Quote Wizard's Extras step to the apothecary "Lab Add-Ons" design, preserving every business rule and behavior.

**Architecture:** Presentation-only restructure. `ExtrasStep.js` becomes a thin orchestrator that splits add-ons into bundles vs a-la-carte, plus three new components under `steps/extras/` (`BundlePicker`, `AddonAccordion`, `AddonTile`). All selection logic stays in `proposalRules.js` and routes through the existing `toggleAddon`. New `wz-*` CSS ports the mockup's `ex-*` styles; the apothecary tokens already live in `index.css`.

**Tech Stack:** React 18 (Create React App), vanilla CSS in `client/src/index.css`. No new dependencies.

**Verification approach:** This is a presentation reskin with zero business-logic changes, and the codebase does not unit-test wizard step components, so there are no failing-test cycles. Tasks 1 to 5 are behavior-inert (data, CSS, and component files nothing imports yet) and commit safely under the project's commit rule. Task 6 is the behavior swap and is verified with `CI=true react-scripts build` plus a dev-server walkthrough before its commit. Builds and the dev server run inside the worktree only when no dev server is running in `os`.

**Reference mockup:** `C:\Users\dalla\Downloads\Dr Bartender Marketing (4)\`
- `apothecary/PageExtras.jsx` — component structure (`BundlePicker` lines 391-447, `Tile` 451-518, `ALaCarte` 522-567)
- `extras-explorations.html` — inline `ex-*` CSS, lines 14-601
- `styles/redesign.css` — `drb-*` base classes

---

## Task 1: Prep — category display fields and shared price-label helper

Two small, behavior-inert additions the new components depend on.

**Files:**
- Modify: `client/src/data/addonCategories.js`
- Modify: `client/src/pages/website/quoteWizard/helpers.js`

- [ ] **Step 1: Add `glyph` and `blurb` to each `ADDON_CATEGORIES` entry**

In `addonCategories.js`, add two string fields to each of the 6 entries. Do NOT touch `key`, `label`, or `icon` (the admin cockpit reads `label`/`icon`).

| key | glyph | blurb |
|---|---|---|
| `byob_support` | `⚗` | `Ice, cups, mixers and garnishes, a la carte` |
| `premium` | `✦` | `Glass, bubbles, fanfare` |
| `beverage` | `◉` | `Mocktails and non-alcoholic options` |
| `craft_ingredients` | `✺` | `Smoke, syrups, novelty` |
| `staffing` | `✻` | `Extra hands at the bar` |
| `logistics` | `⬡` | `Parking and the practical details` |

Each entry becomes e.g. `{ key: 'premium', label: 'Premium Enhancements', icon: '<existing>', glyph: '✦', blurb: 'Glass, bubbles, fanfare' }`.

- [ ] **Step 2: Add `priceLabel` to `helpers.js`**

Append to `client/src/pages/website/quoteWizard/helpers.js` (this is the existing per-add-on price logic from the current `ExtrasStep.js` lines 61-72, minus the now-removed syrup special case):

```js
// Per-add-on price label (Extras step tiles + bundle cards).
export function priceLabel(addon) {
  switch (addon.billing_type) {
    case 'per_guest':
    case 'per_guest_timed': return `$${Number(addon.rate)}/guest`;
    case 'per_hour':        return `$${Number(addon.rate)}/hr`;
    case 'per_staff':       return `$${Number(addon.rate)}/staff member`;
    case 'per_100_guests':  return `$${Number(addon.rate)}/100 guests`;
    case 'flat':
    default:                return `$${Number(addon.rate)}`;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/data/addonCategories.js client/src/pages/website/quoteWizard/helpers.js
git commit -m "feat(wizard): add category display fields and price-label helper for extras redesign"
```

---

## Task 2: The `wz-*` CSS block

Port the mockup's step-content styles into `index.css`. The mockup namespaces everything `ex-*`; production uses `wz-*`.

**Files:**
- Modify: `client/src/index.css` (append after the existing `wz-addon-*` block, around line 5731)

- [ ] **Step 1: Port the step-content classes**

Read the `<style>` block in `extras-explorations.html` (lines 14-601). Port the rule groups below into `index.css`, renaming the `ex-` prefix to `wz-` on every selector. All `var(--...)` tokens they use (`--amber`, `--brass`, `--paper`, `--paper-dark`, `--deep-brown`, `--warm-brown`, `--text-muted`, `--border-dark`, `--cream-text`, `--font-display`, `--font-body`) already exist in the production `:root`, so no value changes.

PORT these groups:
- `.ex-tile` and every `.ex-tile-*`, `.ex-tile.selected/.included/.unavailable`, `.ex-tile.has-desc`, `.ex-tile-info`, `.ex-tile-desc`, `.ex-tile-qty-row`
- `.ex-pill-included`, `.ex-pill-unavailable`
- `.ex-bundle-band` (with `::before`), `.ex-bundle-band-head`, `.ex-bundle-grid`
- `.ex-bundle`, `.ex-bundle.selected`, `.ex-bundle.popular` (with `::after`), `.ex-bundle-head/-name/-tag/-glyph/-foot`, `.ex-bundle ul/li`
- `.ex-link-button`
- `.ex-accordion`, `.ex-acc-row`, `.ex-acc-head` (+ `-icon`), `.ex-acc-meta`, `.ex-acc-chev`, `.ex-acc-body`, `.ex-acc-list`, `.ex-acc-pill`
- `.ex-title-row`, `.ex-skip-inline`
- `.ex-reassure` (+ `em`, `-glyph`)
- `.ex-acla`, `.ex-acla-lede`
- `.ex-qty`
- `.ex-step-eyebrow`

SKIP these (wizard chrome already styled in production, or unused mockup variations): `.ex-hero*`, `.ex-stepper*`, `.ex-body`, `.ex-sidebar`, `.ex-step`, `.ex-nav`, `.ex-side-*`, `.ex-skip` (the hero skip), `.ex-tabs/.ex-tab*`, `.ex-featured-band*`, `.ex-bundle-customize`, `.ex-bundle-browse*`, `.ex-grid`, `.ex-section-head`, `.ex-tile.compact`.

Apply these deltas during the port:
- `.ex-acc-body` in the mockup uses `display: none` toggled by `.open`. `AddonAccordion` conditionally renders the body instead, so drop the `display` rules and keep only the padding on `.wz-acc-body`.
- The mockup's `.ex-step h2` (font-size 1.8rem) styles the step heading. We render an `<h3>`, so add `.wz-title-row h3 { font-size: 1.8rem; color: var(--deep-brown); margin: 0; }`.

- [ ] **Step 2: Add the new classes the mockup did not have**

Append these (no mockup equivalent):

```css
/* Extras: Flavor Blaster locked tile (glassware requirement unmet) */
.wz-tile-locked {
  grid-template-areas: "icon name" "icon msg" "unlock unlock";
  background: rgba(28,22,16,0.04);
  border-color: rgba(28,22,16,0.16);
  cursor: default;
}
.wz-tile-locked .wz-tile-name { opacity: 0.7; }
.wz-tile-locked-msg {
  grid-area: msg;
  font-size: 0.84rem; line-height: 1.5;
  color: var(--text-muted); font-style: italic;
}
.wz-tile-unlock {
  grid-area: unlock;
  display: flex; flex-wrap: wrap; gap: 8px;
  margin-top: 10px; padding-top: 10px;
  border-top: 1px dotted rgba(28,22,16,0.18);
}
.wz-tile-unlock .btn-sm { font-size: 0.78rem; padding: 7px 12px; }

/* Extras: small helpers replacing mockup inline styles */
.wz-tile-qty-label { color: var(--text-muted); font-style: italic; font-size: 0.85rem; }
.wz-acc-head-label { flex: 1; }
.wz-acc-count { font-family: var(--font-body); font-style: italic; font-size: 12px; color: var(--text-muted); }
.wz-bundle-kicker {
  font-family: var(--font-display); font-size: 10px; letter-spacing: 0.32em;
  text-transform: uppercase; color: var(--warm-brown);
}
.wz-bundle-band-title { font-family: var(--font-display); font-size: 1.15rem; color: var(--deep-brown); margin-top: 4px; }
.wz-bundle-band-hint { font-style: italic; color: var(--text-muted); font-size: 13px; }
.wz-acla-divider { margin: 24px 0 12px; }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/index.css
git commit -m "feat(wizard): add wz-* extras styling for the redesign"
```

---

## Task 3: AddonTile component

One add-on tile, including the Flavor Blaster locked variant and the quantity stepper. Ported from the mockup `Tile` (`PageExtras.jsx:451-518`) with production data wiring.

**Files:**
- Create: `client/src/pages/website/quoteWizard/steps/extras/AddonTile.js`

- [ ] **Step 1: Write the component**

```jsx
import React, { useState } from 'react';
import { ADDON_ICONS } from '../../../../../data/addonCategories';
import { ADDON_TAGLINES, priceLabel } from '../../helpers';
import { isQuantityCapable } from '../../../../../utils/proposalRules';

// One add-on tile. The whole tile is the toggle control; the info chevron and
// quantity stepper stop propagation so they do not also toggle selection.
export default function AddonTile({
  addon, selected, included, unavailable, onToggle,
  quantities, setForm,
  guestCount, glasswareRequirementMet, realGlasswareAddon,
}) {
  const [expanded, setExpanded] = useState(false);

  // Flavor Blaster: locked tile when the glassware requirement is not met.
  if (addon.slug === 'flavor-blaster-rental' && !glasswareRequirementMet) {
    const showGlassBtn = guestCount <= 100 && realGlasswareAddon;
    return (
      <div className="wz-tile wz-tile-locked">
        <div className="wz-tile-icon" aria-hidden="true">{ADDON_ICONS[addon.slug] || '✦'}</div>
        <div className="wz-tile-name">{addon.name}</div>
        <div className="wz-tile-locked-msg">
          Aromatic finishing bubbles need proper glassware to form and present
          correctly. Available with the real glassware upgrade.
        </div>
        <div className="wz-tile-unlock">
          {showGlassBtn && (
            <button type="button" className="btn btn-primary btn-sm"
              onClick={() => onToggle(realGlasswareAddon.id)}>
              Add Real Glassware
            </button>
          )}
          <button type="button"
            className={showGlassBtn ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
            onClick={() => setForm(f => ({ ...f, client_provides_glassware: true }))}>
            I'll provide my own
          </button>
        </div>
      </div>
    );
  }

  const isLocked = included || unavailable;
  const hasDesc = !!addon.description;
  const hasQty = isQuantityCapable(addon);
  const q = quantities[addon.id] || 1;
  const cls = [
    'wz-tile',
    selected && !unavailable && 'selected',
    included && 'included',
    unavailable && 'unavailable',
    hasDesc && 'has-desc',
    expanded && 'expanded',
  ].filter(Boolean).join(' ');

  const setQty = (next) => setForm(f => ({
    ...f,
    addon_quantities: { ...f.addon_quantities, [addon.id]: next },
  }));

  return (
    <div
      className={cls}
      role="button"
      tabIndex={isLocked ? -1 : 0}
      aria-disabled={isLocked || undefined}
      aria-pressed={isLocked ? undefined : (selected && !unavailable)}
      onClick={() => !isLocked && onToggle(addon.id)}
      onKeyDown={(e) => {
        if (!isLocked && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onToggle(addon.id);
        }
      }}
    >
      <div className="wz-tile-icon" aria-hidden="true">{ADDON_ICONS[addon.slug] || '✦'}</div>
      <div className="wz-tile-name">{addon.name}</div>
      <div className="wz-tile-price">
        {included
          ? <span className="wz-pill-included">Included</span>
          : unavailable
            ? <span className="wz-pill-unavailable">Covered</span>
            : priceLabel(addon)}
      </div>
      {ADDON_TAGLINES[addon.slug] && (
        <div className="wz-tile-tagline">
          {unavailable
            ? 'Your bundle supersedes this, no need to add it.'
            : ADDON_TAGLINES[addon.slug]}
        </div>
      )}
      {hasDesc && (
        <button
          type="button"
          className={`wz-tile-info${expanded ? ' open' : ''}`}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          aria-expanded={expanded}
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
        >
          <svg width="11" height="7" viewBox="0 0 12 8" fill="none" aria-hidden="true">
            <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
      {hasDesc && expanded && (
        <div className="wz-tile-desc" onClick={(e) => e.stopPropagation()}>
          {addon.description}
        </div>
      )}
      {hasQty && selected && !unavailable && (
        <div className="wz-tile-qty-row" onClick={(e) => e.stopPropagation()}>
          <span className="wz-tile-qty-label">How many?</span>
          <div className="wz-qty">
            <button type="button" aria-label="Decrease quantity"
              onClick={() => setQty(Math.max(1, q - 1))} disabled={q <= 1}>−</button>
            <span className="wz-qty-value">{q}</span>
            <button type="button" aria-label="Increase quantity"
              onClick={() => setQty(Math.min(10, q + 1))}>+</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

Deltas from the mockup `Tile`: real production add-on fields (`slug`, `name`, `description`, `billing_type`, `rate`); `priceLabel` from `helpers.js`; `ADDON_ICONS` / `ADDON_TAGLINES`; `isQuantityCapable` instead of the mockup's `addon.qty`; the included/unavailable pills read "Included" / "Covered"; the Flavor Blaster locked variant (not in the mockup); a keyboard handler for the `role="button"` tile (accessibility, not in the mockup); quantity writes to `form.addon_quantities`. Note `.wz-qty` and `.wz-qty-value` come from the `wz-qty` group ported in Task 2.

- [ ] **Step 2: Commit** (behavior-inert: nothing imports this file yet)

```bash
git add client/src/pages/website/quoteWizard/steps/extras/AddonTile.js
git commit -m "feat(wizard): add AddonTile component for extras redesign"
```

---

## Task 4: BundlePicker component

The bundle band. Ported from the mockup `BundlePicker` (`PageExtras.jsx:391-447`).

**Files:**
- Create: `client/src/pages/website/quoteWizard/steps/extras/BundlePicker.js`

- [ ] **Step 1: Write the component**

```jsx
import React from 'react';
import { ADDON_TAGLINES, priceLabel } from '../../helpers';
import { BYOB_BUNDLE_SLUGS, BUNDLE_INCLUDED } from '../../../../../utils/proposalRules';

// Decorative per-bundle glyphs (lightest to fullest).
const BUNDLE_GLYPH = {
  'the-foundation': '⚗',
  'the-formula': '⚛',
  'the-full-compound': '⚜',
};
const BUNDLE_FOOT = {
  'the-foundation': 'Lightest',
  'the-formula': 'The middle',
  'the-full-compound': 'The works',
};

// The 3 BYOB bundles, hoisted out of the a-la-carte list into a featured band.
// No bundle is pre-selected; selecting a card routes through the wizard's
// toggleAddon, which runs the existing bundle mutex + include/unavailable rules.
export default function BundlePicker({ bundles, nameBySlug, selectedIds, onToggle }) {
  const ordered = BYOB_BUNDLE_SLUGS
    .map(slug => bundles.find(b => b.slug === slug))
    .filter(Boolean);
  const selected = ordered.find(b => selectedIds.includes(b.id)) || null;

  return (
    <div className="wz-bundle-band">
      <div className="wz-bundle-band-head">
        <div>
          <div className="wz-bundle-kicker">Lab notes · Where most BYOB events start</div>
          <div className="wz-bundle-band-title">Pick a starter recipe.</div>
        </div>
        {selected ? (
          <button type="button" className="wz-link-button" onClick={() => onToggle(selected.id)}>
            Skip the bundle ×
          </button>
        ) : (
          <span className="wz-bundle-band-hint">Or skip and go à la carte ↓</span>
        )}
      </div>
      <div className="wz-bundle-grid">
        {ordered.map(b => {
          const isSel = !!selected && selected.id === b.id;
          const popular = b.slug === 'the-foundation';
          const included = BUNDLE_INCLUDED[b.slug] || [];
          return (
            <button
              key={b.id}
              type="button"
              className={`wz-bundle${isSel ? ' selected' : ''}${popular ? ' popular' : ''}`}
              onClick={() => onToggle(b.id)}
              aria-pressed={isSel}
            >
              <div className="wz-bundle-head">
                <div>
                  <div className="wz-bundle-name">{b.name}</div>
                  <div className="wz-bundle-tag">{ADDON_TAGLINES[b.slug] || ''}</div>
                </div>
                <span className="wz-bundle-glyph" aria-hidden="true">
                  {BUNDLE_GLYPH[b.slug] || '⚗'}
                </span>
              </div>
              <ul>
                {included.map(slug => (
                  <li key={slug}>{nameBySlug[slug] || slug}</li>
                ))}
              </ul>
              <div className="wz-bundle-foot">
                <span>{popular ? 'Most picked' : (BUNDLE_FOOT[b.slug] || '')}</span>
                <strong>{priceLabel(b)}</strong>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

Deltas from the mockup `BundlePicker`: real bundle add-ons filtered by `BYOB_BUNDLE_SLUGS`; `BUNDLE_INCLUDED` from `proposalRules`; included-item slugs resolved to names via the `nameBySlug` map passed from `ExtrasStep` (the mockup had the whole add-on array in scope); the "Most picked" ribbon is on `the-foundation`; selection state derived from `selectedIds` rather than a local Set; `priceLabel` from `helpers.js`.

- [ ] **Step 2: Commit** (behavior-inert: nothing imports this file yet)

```bash
git add client/src/pages/website/quoteWizard/steps/extras/BundlePicker.js
git commit -m "feat(wizard): add BundlePicker component for extras redesign"
```

---

## Task 5: AddonAccordion component

The collapsible category list. Ported from the mockup `ALaCarte` (`PageExtras.jsx:522-567`).

**Files:**
- Create: `client/src/pages/website/quoteWizard/steps/extras/AddonAccordion.js`

- [ ] **Step 1: Write the component**

```jsx
import React, { useState } from 'react';
import AddonTile from './AddonTile';

// Collapsible category accordion. First category open by default; open/close
// state is local and resets on step remount (acceptable).
export default function AddonAccordion({
  groups, form, setForm, toggleAddon, guestCount,
  glasswareRequirementMet, realGlasswareAddon,
  isIncludedByBundle, isUnavailableByBundle,
}) {
  const [openKeys, setOpenKeys] = useState(
    () => new Set(groups[0] ? [groups[0].key] : []),
  );

  const toggleKey = (key) => setOpenKeys(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="wz-accordion">
      {groups.map(group => {
        const open = openKeys.has(group.key);
        const count = group.addons.length;
        const selectedCount = group.addons.filter(
          a => form.addon_ids.includes(a.id) || isIncludedByBundle(a.slug),
        ).length;
        return (
          <div key={group.key} className={`wz-acc-row${open ? ' open' : ''}`}>
            <button type="button" className="wz-acc-head"
              aria-expanded={open} onClick={() => toggleKey(group.key)}>
              <span className="wz-acc-head-icon" aria-hidden="true">{group.glyph || '⚗'}</span>
              <span className="wz-acc-head-label">
                {group.label}
                <span className="wz-acc-meta"> · {group.blurb}</span>
              </span>
              {selectedCount > 0
                ? <span className="wz-acc-pill">{selectedCount} added</span>
                : <span className="wz-acc-count">{count} option{count !== 1 ? 's' : ''}</span>}
              <svg className="wz-acc-chev" viewBox="0 0 12 8" fill="none" aria-hidden="true">
                <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {open && (
              <div className="wz-acc-body">
                <div className="wz-acc-list">
                  {group.addons.map(addon => (
                    <AddonTile
                      key={addon.id}
                      addon={addon}
                      selected={form.addon_ids.includes(addon.id)}
                      included={isIncludedByBundle(addon.slug)}
                      unavailable={isUnavailableByBundle(addon.slug)}
                      onToggle={toggleAddon}
                      quantities={form.addon_quantities}
                      setForm={setForm}
                      guestCount={guestCount}
                      glasswareRequirementMet={glasswareRequirementMet}
                      realGlasswareAddon={realGlasswareAddon}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

Deltas from the mockup `ALaCarte`: real `groupedAddons` shape (`key`, `label`, `glyph`, `blurb`, `addons`); selection and included/unavailable derived from the wizard's `form` and the `isIncludedByBundle` / `isUnavailableByBundle` props; the body is conditionally rendered rather than CSS-hidden.

- [ ] **Step 2: Commit** (behavior-inert: nothing imports this file yet)

```bash
git add client/src/pages/website/quoteWizard/steps/extras/AddonAccordion.js
git commit -m "feat(wizard): add AddonAccordion component for extras redesign"
```

---

## Task 6: Rewrite ExtrasStep and wire QuoteWizard (the swap)

This task makes the redesign live. After it, the wizard renders the new Extras step.

**Files:**
- Modify (full rewrite): `client/src/pages/website/quoteWizard/steps/ExtrasStep.js`
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js`

- [ ] **Step 1: Rewrite `ExtrasStep.js`**

Replace the entire file with:

```jsx
import React from 'react';
import { BYOB_BUNDLE_SLUGS } from '../../../../utils/proposalRules';
import BundlePicker from './extras/BundlePicker';
import AddonAccordion from './extras/AddonAccordion';

// Extras step: featured bundle band (BYOB only) + a-la-carte category accordion.
// All add-on rules live in proposalRules.js and run through toggleAddon; this
// component only arranges and presents.
export default function ExtrasStep({
  form, setForm, groupedAddons, toggleAddon, guestCount,
  glasswareRequirementMet, realGlasswareAddon,
  isIncludedByBundle, isUnavailableByBundle, onSkipExtras, stepRoman,
}) {
  const isBundle = (a) => BYOB_BUNDLE_SLUGS.includes(a.slug);
  const allAddons = groupedAddons.flatMap(g => g.addons);
  const bundles = allAddons.filter(isBundle);
  const nameBySlug = Object.fromEntries(allAddons.map(a => [a.slug, a.name]));
  const accordionGroups = groupedAddons
    .map(g => ({ ...g, addons: g.addons.filter(a => !isBundle(a)) }))
    .filter(g => g.addons.length > 0);

  return (
    <div className="wz-card">
      <div className="wz-step-eyebrow">Step {stepRoman} · Apothecary Add-Ons</div>
      <div className="wz-title-row">
        <h3>Customize your experience.</h3>
        <button type="button" className="wz-skip-inline" onClick={onSkipExtras}>
          Skip this step →
        </button>
      </div>
      <p className="wz-reassure">
        <span className="wz-reassure-glyph" aria-hidden="true">⚗</span>
        <span>
          Every choice is optional, and <em>nothing here is final</em>. You can
          swap, add, or remove anything later, even after you book, during your
          Potion Planning consult.
        </span>
      </p>

      {bundles.length > 0 && (
        <BundlePicker
          bundles={bundles}
          nameBySlug={nameBySlug}
          selectedIds={form.addon_ids}
          onToggle={toggleAddon}
        />
      )}

      {accordionGroups.length > 0 ? (
        <div className="wz-acla">
          <div className="divider-ornate wz-acla-divider"><span>à la carte</span></div>
          <p className="wz-acla-lede">
            Add anything else your event needs, beyond what your bundle covers.
          </p>
          <AddonAccordion
            groups={accordionGroups}
            form={form}
            setForm={setForm}
            toggleAddon={toggleAddon}
            guestCount={guestCount}
            glasswareRequirementMet={glasswareRequirementMet}
            realGlasswareAddon={realGlasswareAddon}
            isIncludedByBundle={isIncludedByBundle}
            isUnavailableByBundle={isUnavailableByBundle}
          />
        </div>
      ) : bundles.length === 0 ? (
        <p className="wz-no-addons">
          No add-ons available for this package. You can skip this step.
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Update the `ExtrasStep` render in `QuoteWizard.js`**

Find the `currentStepKey === 'addons'` block (currently around lines 687-703). Replace it with:

```jsx
          {/* Step: Add-ons */}
          {currentStepKey === 'addons' && (
            <ExtrasStep
              form={form}
              setForm={setForm}
              groupedAddons={groupedAddons}
              toggleAddon={toggleAddon}
              guestCount={guestCount}
              glasswareRequirementMet={glasswareRequirementMet}
              realGlasswareAddon={realGlasswareAddon}
              isIncludedByBundle={(slug) => isIncludedByBundle(slug, form.addon_ids, addons)}
              isUnavailableByBundle={(slug) => isUnavailableByBundle(slug, form.addon_ids, addons)}
              onSkipExtras={skipExtras}
              stepRoman={ROMANS[step]}
            />
          )}
```

Changes: removed the `update`, `expandedAddons`, and `toggleExpand` props; added `stepRoman={ROMANS[step]}`. `ROMANS` is already defined in `QuoteWizard.js` (around line 601) and is in scope here.

- [ ] **Step 3: Remove the now-unused `expandedAddons` state in `QuoteWizard.js`**

Delete this block (currently around lines 416-425):

```jsx
  // Track which add-on descriptions are manually expanded
  const [expandedAddons, setExpandedAddons] = useState(new Set());
  const toggleExpand = (id) => {
    setExpandedAddons(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
```

Leave the `update` function itself in place; it is still passed to the other step components.

- [ ] **Step 4: Build**

Run: `CI=true npx react-scripts build` (from `client/`, or `npm run build --prefix client` from the repo root)
Expected: build completes with no errors. This is the first compile of `AddonTile`, `BundlePicker`, and `AddonAccordion`. Fix any import-path or syntax errors it surfaces.

- [ ] **Step 5: Dev-server walkthrough**

Start the dev server (only if `os` has no dev server running). Verify against the mockup and the spec's verification list:
- BYOB path: bundle band shows 3 cards (Foundation with "Most picked"), nothing pre-checked; picking a bundle marks its included a-la-carte tiles "Included" and any superseded tile "Covered"; "Skip the bundle" clears it.
- Hosted path and mocktail path: no bundle band, accordion only.
- Accordion: first category open, others toggle; count pills read "{n} added" / "{n} options".
- Tiles: select/deselect, description expander, quantity steppers (barback, banquet server, additional bartender, pre-batched mocktail).
- Flavor Blaster: locked tile when glassware unmet; both unlock buttons work; normal tile once glassware is satisfied.
- The "Skip this step" pill advances without clearing selections.
- The live estimate sidebar updates as tiles toggle.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/website/quoteWizard/steps/ExtrasStep.js client/src/pages/website/quoteWizard/QuoteWizard.js
git commit -m "feat(wizard): rebuild Extras step with the apothecary Lab Add-Ons design"
```

---

## Task 7: Cleanup and docs

Remove the now-dead old styles and update the folder tree.

**Files:**
- Modify: `client/src/index.css` (remove the dead `wz-addon-*` block)
- Modify: `README.md`

- [ ] **Step 1: Remove the dead `wz-addon-*` CSS**

The old `ExtrasStep.js` markup is gone, so its CSS is dead. In `index.css`, delete the `wz-addon-*` rule block (currently around lines 5539-5731: `.wz-addon-category` through `.wz-addon-qty-value`). Keep `.wz-no-addons` (still used by the new `ExtrasStep`) and the unrelated `.wz-addon-option input[type="radio"]` rule near line 6177 if it belongs to another surface; verify with a grep for `wz-addon` across `client/src` before deleting each rule, and keep any class still referenced.

- [ ] **Step 2: Update the folder tree in `README.md`**

In the README folder-structure tree, under `client/src/pages/website/quoteWizard/steps/`, add the new `extras/` folder with `AddonTile.js`, `BundlePicker.js`, and `AddonAccordion.js`. Match the surrounding tree's indentation and comment style.

- [ ] **Step 3: Build check**

Run: `CI=true npx react-scripts build`
Expected: still clean; the dev-server walkthrough from Task 6 still passes (CSS removal only).

- [ ] **Step 4: Commit**

```bash
git add client/src/index.css README.md
git commit -m "chore(wizard): drop dead extras CSS and update the folder tree"
```

---

## Self-review notes

- Spec coverage: step chrome (Task 6), bundle band (Tasks 4, 6), accordion (Tasks 5, 6), tile with all states (Task 3), Flavor Blaster lock (Task 3), syrup-as-plain-tile (Task 3, no picker imported), category metadata (Task 1), no auto-check (Task 4, `BundlePicker` derives selection from `selectedIds` and pre-selects nothing), dynamic step roman (Task 6), CSS (Tasks 2, 7), docs (Task 7). All spec sections map to a task.
- The `priceLabel` helper, `nameBySlug` map, and all prop names (`isIncludedByBundle`, `isUnavailableByBundle`, `glasswareRequirementMet`, `realGlasswareAddon`, `addon_quantities`) are used consistently across Tasks 1, 3, 4, 5, 6.
- No placeholders: every component is given in full; the CSS port names exact source rules and an exact `ex-` to `wz-` transform.
