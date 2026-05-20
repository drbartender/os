# Spec: Potion Planner Apothecary Reskin + UX Additions (Implementation)

> Reskin the post-booking drink wizard at `/plan/:token` in the Apothecary-Press visual system, and adopt the UX additions (scope banners, welcome roadmap, three-way Menu Design, inline scope notes, continuous save pulse) that grew out of the 2026-05-17 design session.

This spec implements the design package returned from `https://api.anthropic.com/v1/design/h/bU8OWWqmcxI2pGV_4OU79g`. It supersedes the strict "pure reskin" framing of `docs/superpowers/specs/2026-05-17-potion-planner-redesign-design.md`. That brief still captures the visual register, sub-surface checklist, and hard rules, but its "barely touch the .js" and "flow is frozen" constraints are relaxed for the UX additions defined below.

---

## 1. Status and prior art

- **Prior spec** (still authoritative for visual register and hard rules): `docs/superpowers/specs/2026-05-17-potion-planner-redesign-design.md`
- **Design session package**: extracted to ephemeral cache; primary artifacts referenced inline as needed (planner.css, chats #1/#2, README, JSX prototype).
- **Designer's chosen variants** (baked in, not exposed as user options): brass-rail chrome, grid drink picker, split-with-seal confirmation.
- **Magical-realism moment** (single, on this surface): continuous whisper brass pulse on the save indicator.
- **Related shipped surface**: `client/src/pages/public/ClientShoppingList.js` is the apothecary peer for this work, but it uses inline `styles` objects, not `index.css`. We do not match its mechanics; we match its restraint.

---

## 2. What we are shipping in this PR

One logical commit/PR covering:

1. Visual reskin: every sub-surface in the brief's checklist (welcome, quick-pick grid, custom setup, every module step, drink picker, your-menu list, menu design, hosted guest prefs, logistics, confirmation, submitted, loading/locked/error, chrome + step nav).
2. **Scope banners** on drink steps and confirmation (BYOB/hosted/aside tones). Mounted on: SignaturePickerStep, MocktailStep, FullBarSpiritsStep, FullBarBeerWineStep, BeerWineStep, HostedGuestPrefsStep, MenuDesignStep, ConfirmationStep. **Not** on LogisticsStep (Logistics has cost-affecting fields like bar rental).
3. **Welcome roadmap** under the existing welcome card. BYOB and hosted copy variants. Existing bartender/drinks image layout + mobile reflow preserved exactly.
4. **Three-way Menu Design**: Custom, Standard Menu, No Menu Card. New `selections.menuStyle` field replaces the boolean `selections.customMenuDesign`. Backward-compatible migration on load. "Standard Menu" ships as a UI option with a placeholder confirmation note; the auto-generation pipeline is carved out (see §3.1). Internal data value is `menuStyle === 'house'`; only the user-facing label changes from the design-session "House Style" wording.
5. **Inline scope notes** under mocktail notes and access-notes textareas.
6. **Continuous whisper brass pulse** on the save indicator. Always-visible while the wizard is mounted. Idle / saving / failed states.
7. **Hosted welcome polish**: ⚗ bullet style on the existing `package_includes` list, brass divider. Reuses existing plan API fields (`plan.package_name`, `plan.package_includes`); no schema change.
8. **`.potion-app` scoping wrapper** added as a second class on the existing `<div className="auth-page">` in `PotionPlanningLab.js:909`. Login/Register/ClientLogin and global primitives untouched.
9. **Catch-all "Anything else?" textarea** on the Confirmation step, between the summary and extras sections. Stored as `selections.additionalNotes`. Captures the by-the-way stuff (allergies, family stories, special requests) that would otherwise get jammed into a notes field where it does not belong. Closes the same UX gap the scope banners address from the other direction: banners tell clients what NOT to put in the scoped notes fields; the catch-all gives them somewhere to put it instead.
10. **"After submit" footer on the Welcome roadmap.** A small italic line below the three roadmap cards, previewing what the team delivers within 2 business days. Sets the expectation up front instead of only on the submit celebration.

### Non-goals

- No pricing-engine changes. Server has zero references to menu_design/customMenuDesign; confirmed by grep at spec-writing time.
- No schema changes. All required plan fields already exist.
- No new dependencies. Vanilla CSS, no Tailwind, no CSS-in-JS, no font additions.
- No global primitive edits (`.auth-page`, global `.card`, global `.btn-*`). The brief is explicit; we hold it.
- No changes to step queue order, `buildStepQueue`/`buildHostedStepQueue`, 30s auto-save interval, `beforeunload` keepalive, browser-back `popstate` handling, Stripe Elements mounting, or extras pricing math.

---

## 3. Carved out into follow-up specs

Two pieces of work are intentionally deferred. The reskin lands cleanly on top of both, and ships placeholder copy where the deferred work will eventually replace it.

### 3.1 Standard Menu auto-generation

When a client picks "Standard Menu", the wizard tells them we'll bring it printed and framed to the event. This PR ships the radio + data flag (`menuStyle === 'house'` internally). The generator that actually produces the printable menu lands in a separate spec because it requires:

- A reusable Dr. Bartender branded template (creative work)
- A server endpoint that renders the menu from `selections.signatureDrinks`, `selections.mocktails`, beer / wine / spirits selections
- A rendering library decision (likely jsPDF, since the codebase already uses it for the shopping list)
- Drink-list layout (typography, spacing, brand placement)
- Print-and-frame logistics (in-house print? print on demand? handled by the operator pre-event?)

Until that spec ships, the standard menu is produced manually by the operator before the event. The client-facing copy never promises auto-generation; it just says "we bring it printed and framed for the bar." That is operationally true either way.

### 3.2 Hosted package alignment

Hosted-mode copy throughout the planner (scope banners on drink steps, welcome roadmap Part 1, inline notes) is best-effort placeholder in this PR. A full hosted alignment project will:

- Sync the planner's available drink modules with what each hosted package actually includes
- Surface package-specific add-ons (some packages may include cups, ice, napkins; others may not)
- Refine hosted-mode copy across the wizard to match what each package guarantees
- Possibly add a fourth scope-banner tone for "you've already paid for this; pick what you want served"

The reskin ships hosted copy that is accurate at the high level (we're providing, no beverage shopping) without committing to anything package-specific. Hosted client experience is unchanged operationally; only the visual surface gets the apothecary treatment now.

---

## 4. Architectural decisions

### 4.1 Scoping wrapper

`PotionPlanningLab.js:909` changes from:
```jsx
<div className="auth-page">
```
to:
```jsx
<div className="auth-page potion-app">
```

`.auth-page` retains its chalkboard background and unchanged behavior on Login, Register, and ClientLogin. `.potion-app` becomes the scoping root for every planner-specific override added in this PR.

**Every new CSS rule introduced by this PR is prefixed with `.potion-app …`** except where it scopes a global override that must beat existing global rules (see §5.3). This guarantees the reskin cannot leak into other surfaces.

### 4.2 Token strategy

Every `--drb-*` reference in the source `planner.css` maps to an existing token in our `:root` block. Direct renames:

| Source (`planner.css`) | Target (`index.css`) | Notes |
|---|---|---|
| `--drb-amber` | `--amber` | Deep apothecary teal (`#1D8C89`) |
| `--drb-amber-light` | `--amber-light` | Luminous teal (`#2FA7A0`) |
| `--drb-brass` | `--brass` | Antique brass (`#B8924A`) |
| `--drb-brass-bright` | `--brass-bright` | Highlight brass (`#D6AE65`) |
| `--drb-plum` | `--plum` | Dusty plum (`#6B4D7A`) |
| `--drb-paper` | `--paper` | `#EDE6D6` |
| `--drb-paper-dark` | `--paper-dark` | `#D8CFBE` |
| `--drb-card-bg` | `--card-bg` | `#E6DDCC` |
| `--drb-chalkboard` | `--chalkboard` | `#12161C` |
| `--drb-cream-text` | `--cream-text` | `#F0E8D6` |
| `--drb-deep-brown` | `--deep-brown` | `#1C1610` |
| `--drb-text-muted` | `--text-muted` | `#5A5048` (real brown) |
| `--drb-rust` | `--rust` | `#A0522D` |
| `--drb-forest` | `--forest` | `#1D5A4A` |
| `--drb-success` | `--success` | `#2D6B5A` |
| `--drb-radius` | `--radius` | `6px` |
| `--drb-radius-lg` | `--radius-lg` | `10px` |
| `--drb-shadow-card` | `--shadow-card` | existing card shadow |
| `--drb-font-display` | `--font-display` | IM Fell English SC |
| `--drb-font-body` | `--font-body` | IM Fell English |

**One non-mechanical substitution:**
- `var(--drb-warm-brown)` → `var(--text-muted)` everywhere it is used in `planner.css` for italic subtitle text. Reason: our `--warm-brown` token has been repurposed to `#134544` (deepened teal for CTA hover); the designer assumed an actual warm brown. `--text-muted` (`#5A5048`) is the brown value we want. Do not use `--warm-brown` for text in the planner.

**No `--font-mono` exists in our tokens.** The designer used it for placeholder text inside the welcome-screen image fallback. Since we preserve the real `/images/potion-bartender.png` and `/images/potion-drinks.png` images, the fallback styling is moot. Drop the mono references.

### 4.3 Specificity strategy (the load-bearing decision)

The design session shipped twice with cream-on-cream readability bugs because `.drb h3` / `.drb p` overrode component color rules. We do not have a `.drb` wrapper, but we have an **analogous trap**:

- `index.css:134-138`: `h1, h2, h3, h4 { color: var(--cream-text) }`
- `index.css:146-149`: `.page-container h1, h2, h3, h4 { color: var(--cream-text) }`

Since the planner mounts in `<div className="auth-page page-container">…<div className="potion-card">…<h3>`, the line-146 rule wins on a 0,1,1 specificity vs our component rules at 0,1,0. **Headings inside parchment cards will go cream-on-cream unless we explicitly defend.**

**Defense strategy:**

For every place a parchment card contains a heading or label, we add an override scoped as:
```css
.potion-app .potion-card h1,
.potion-app .potion-card h2,
.potion-app .potion-card h3,
.potion-app .potion-card h4 { color: var(--deep-brown); }

.potion-app .page-container .potion-card h1,
.potion-app .page-container .potion-card h2,
.potion-app .page-container .potion-card h3,
.potion-app .page-container .potion-card h4 { color: var(--deep-brown); }
```

The second block (with `.page-container`) is required to beat `index.css:146` (which lives at 0,1,1 + `.page-container`). Specificity must be at least 0,3,1 to win. `.potion-app .page-container .potion-card h3` is 0,3,1, which beats `.page-container h3` (0,1,1) on class count. Confirmed.

The same defense applies to every component class that holds dark-text labels on parchment surfaces: `.serving-type-card`, `.drink-card-horizontal`, `.drink-tile`, `.your-menu-item`, `.checkbox-label`, `.pay-radio`, `.potion-scope`, `.potion-roadmap-step`, `.potion-panel`. The designer's existing override block at the end of `planner.css` (lines 1147-1180) covers most of this. We port it, replacing `.drb` with `.potion-app` and adding the `.page-container` layer where needed.

**Light text on dark backgrounds** (the masthead, the step rail, the save indicator outside any card) inherits the global `--cream-text` rule and needs no override.

### 4.4 What we skip from the source `planner.css`

- `@font-face` blocks (already loaded in our `index.css`)
- `.dev-switcher` class block (prototype-only)
- `.potion-mark*` masthead block (the planner uses the existing `.auth-page` chrome; the medallion logo is not in scope for this PR)
- The `.drb` token override block at the top of `drb-tokens.css` (we have our own `:root` block)
- The `.potion-roman*` (roman-numeral stepper) and `.potion-minimal-rule` (minimal hairline) blocks. Alternate chrome variants the designer exposed via Tweaks; we ship only the chosen brass-rail variant (`.potion-rail` + `.potion-rail-tick`).
- The `.drink-card-list`, `.drink-card-horizontal`, `.category-sidebar`, `.category-sidebar-btn` blocks. Alternate drink-picker variants. We ship only the grid: `.drink-card-grid`, `.drink-tile`, `.drink-tile-name`, `.drink-tile-desc`. **However**, mobile reflow may still need a list-style fallback if the grid does not gracefully collapse below ~360px. Verify and decide at implementation time.
- The `.conf-extras-box` block (alternate confirmation variant). We ship only the split-with-seal variant: `.conf-leader`, `.conf-total`, `.conf-total-seal`.

### 4.5 File size

`client/src/index.css` is currently 11,818 lines. Porting adds an estimated ~900 lines (planner.css source is 1,222 lines, minus skipped blocks and dedupe). Result: ~12,700 lines.

The pre-commit size hook (`.husky/check-file-size.sh`) gates only `server/**/*.js` and `client/src/**/*.{js,jsx}`. CSS is out of scope; no `claude-allow-large-file` marker needed.

---

## 5. Component changes (per file)

### 5.1 `client/src/index.css`

Append a new section (clearly delimited with a banner comment) containing every `.potion-*`, `.serving-type-*`, `.drink-tile*`, `.drink-card-grid`, `.your-menu-*`, `.category-*`, `.form-*`, `.checkbox-*`, `.btn-*` (planner-scoped), `.step-nav`, `.conf-*`, `.pay-radio`, `.potion-submitted`, `.potion-panel*`, `.potion-blocking`, `.potion-spinner`, `.potion-scope*`, `.potion-roadmap*`, `.potion-field-note`, and `.potion-hosted-list` block from the source `planner.css`, with the token and scoping transforms described in §4.2-§4.4.

Do not edit the bare `.auth-page` rule. Do not edit global `.card`, `.btn-primary`, or `.btn-secondary` rules. If a component look incomplete because a global primitive needs work, log it in the brief's Stage-2 primitives spec and ship the reskin without touching the primitive.

### 5.2 `client/src/pages/plan/PotionPlanningLab.js`

Four edits:

**(a) Scoping wrapper.** Five return statements wrap the page (loading at `:644`, locked at `:657`, error at `:684`, submitted at `:702`, and the main render at `:909`). All start with `<div className="auth-page">`. Change all five to `<div className="auth-page potion-app">`.

**(b) Continuous save indicator.** The current block at lines 919-926 only renders content when `saving === true` or `saveFailed === true`. Replace with a persistent component:

```jsx
<div className="potion-save-wrap">
  <span
    className={`potion-save ${saveFailed ? 'failed' : (saving ? '' : 'saved')}`}
    role={saveFailed ? 'alert' : 'status'}
    aria-live={saveFailed ? 'assertive' : (saving ? 'polite' : 'off')}
  >
    {saveFailed
      ? 'Draft may not be saved. Check your connection.'
      : saving ? 'Saving…' : 'Saved'}
  </span>
</div>
```

CSS class structure (matches planner.css:92-119 exactly):
- **Base `.potion-save`** is the *active/saving* state: full opacity, brass dot pulsing on the 3s `potion-brass-pulse` keyframe.
- **`.potion-save.saved`** is the *idle* state: lower opacity, pulse animation paused, no glow.
- **`.potion-save.failed`** is the error state: rust color on text and dot.

So when `saving` is true the element carries no extra class (base state); when idle it carries `.saved`; when failed it carries `.failed`. Do not introduce a `.saving` modifier class; it would collide with the base treatment and is unnecessary.

**ARIA behavior** (important for accessibility, since the indicator is now always-visible):
- Idle: `aria-live="off"` so the screen reader does not announce "Saved" continuously or repeatedly between save cycles.
- Saving: `aria-live="polite"` announces "Saving…" once per save cycle.
- Failed: `role="alert" aria-live="assertive"` so save failures interrupt the screen reader queue.

`prefers-reduced-motion: reduce` halts the visual pulse per planner.css:121-123.

Render the indicator only when `plan && step !== 'submitted'` (so it does not appear on the celebration or locked/error screens).

**(c) Two-variant Menu Design submit copy.** The `"What happens next?"` block at lines 730-732 reads `selections.customMenuDesign === true` to switch copy. Update to read the new `selections.menuStyle`. The celebration does not distinguish between custom and standard menus; if the client picked any menu we tally a generic "menu":

```jsx
{(selections.menuStyle === 'custom' || selections.menuStyle === 'house') ?
  "We'll use your selections to create a shopping list, a menu, and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"
 :
  "We'll use your selections to create a shopping list and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"}
```

**(d) Legacy migration on plan load.** Inside the `if (data.status === 'draft' || data.status === 'submitted')` block (around line 154), after the existing migrations, normalize the menu choice:

```js
if (savedSel.menuStyle === undefined) {
  if (savedSel.customMenuDesign === true) savedSel.menuStyle = 'custom';
  else if (savedSel.customMenuDesign === false) savedSel.menuStyle = 'none';
  else savedSel.menuStyle = null;
}
```

The legacy `customMenuDesign` field is preserved in the JSON (not deleted) so any consumer reading old plans is unaffected. New code reads `menuStyle`.

Add `menuStyle: null` to `DEFAULT_SELECTIONS` (lines 26-60).

### 5.3 `client/src/pages/plan/steps/RefinementWelcomeStep.js`

Add a `<WelcomeRoadmap mode={mode} packageName={…} />` component below the existing welcome card. The existing card (with bartender + drinks images and mobile reflow) is unchanged.

`mode` is `'byob' | 'hosted'`, derived from `plan?.package_category === 'hosted' ? 'hosted' : 'byob'`.

Component structure:
```jsx
<div className="potion-roadmap">
  <div className={`potion-roadmap-step ${mode === 'byob' ? 'shopping' : 'hosted'}`}>
    <div className="potion-roadmap-num">Part 1</div>
    <h4 className="potion-roadmap-title">{… title …}</h4>
    <p className="potion-roadmap-body">{… body …}</p>
    <span className="potion-roadmap-tag">{… tag …}</span>
  </div>
  <div className="potion-roadmap-step">
    <div className="potion-roadmap-num">Part 2</div>
    <h4 className="potion-roadmap-title">Choose menu design</h4>
    <p className="potion-roadmap-body">Custom, standard, or skip it. We bring the printed and framed menu to display on the bar.</p>
  </div>
  <div className="potion-roadmap-step">
    <div className="potion-roadmap-num">Part 3</div>
    <h4 className="potion-roadmap-title">Confirm logistics</h4>
    <p className="potion-roadmap-body">Event-day contact, parking, equipment, access notes.</p>
  </div>
</div>
```

See §6.2 for the verbatim Part 1 copy for BYOB versus hosted.

Below the three roadmap cards, render an italic "after submit" footer with the post-submission preview copy (§6.2 footer). Use a `.potion-roadmap-footer` wrapper with a brass top-hairline so it reads as a coda to the three cards, not a fourth card.

Also retune the existing hosted package summary card (lines 6-25) to use the `.potion-hosted-list` styling: ⚗ bullets in brass, brass top-divider. Keep the existing `<ul>` mapping over `plan.package_includes`.

### 5.4 `client/src/pages/plan/steps/MenuDesignStep.js`

Replace the two-radio block (lines 139-158) with three radios for `menuStyle`:

```jsx
<div className="checkbox-grid">
  <label className="checkbox-label">
    <input type="radio" name="menuStyle"
      checked={selections.menuStyle === 'custom'}
      onChange={() => onChange('menuStyle', 'custom')} />
    <span>Custom Menu Design (designed for your event's look and feel)</span>
  </label>
  <label className="checkbox-label">
    <input type="radio" name="menuStyle"
      checked={selections.menuStyle === 'house'}
      onChange={() => onChange('menuStyle', 'house')} />
    <span>Standard Menu (Dr. Bartender branded, drinks listed in plain terms)</span>
  </label>
  <label className="checkbox-label">
    <input type="radio" name="menuStyle"
      checked={selections.menuStyle === 'none'}
      onChange={() => onChange('menuStyle', 'none')} />
    <span>No Menu Card (we'll skip the printed menu)</span>
  </label>
</div>
```

The conditional content below:

- `menuStyle === 'custom'`: existing theme / drinkNaming / menuDesignNotes textareas (lines 163-198) shown
- `menuStyle === 'house'`: show a single `.potion-field-note`:
  > *"Our standard bar menu. Dr. Bartender branded, listing your drinks in plain terms like Vodka Lemonade, Old Fashioned, or Beer and Wine. We bring it printed and framed for the bar. No setup needed from you."*
- `menuStyle === 'none'`: show a single `.potion-field-note`:
  > *"No printed menu will be created. Your selections still drive your shopping list."*

Mount the scope banner at the top of the step (the `.potion-scope.aside` variant per §6.1).

### 5.5 `client/src/pages/plan/steps/ConfirmationStep.js`

**(a) Menu Design summary.** The block at lines 407-425 currently renders two cases (`true`/`false`). Update to render three based on `menuStyle`:

```jsx
{selections.menuStyle === 'custom' && (
  <div className="mb-2">
    <strong>Custom Menu Design:</strong> Yes
    {selections.menuTheme && (<p className="conf-note">Theme: {selections.menuTheme}</p>)}
    {selections.drinkNaming && (<p className="conf-note">Custom naming: {selections.drinkNaming}</p>)}
    {selections.menuDesignNotes && (<p className="conf-note">Design notes: {selections.menuDesignNotes}</p>)}
  </div>
)}
{selections.menuStyle === 'house' && (
  <div className="mb-2"><strong>Menu Design:</strong> Standard menu (Dr. Bartender branded, printed and framed for the bar)</div>
)}
{selections.menuStyle === 'none' && (
  <div className="mb-2"><strong>Menu Design:</strong> No menu card</div>
)}
```

**(b) Split-with-seal total layout.** Replace the existing extras total block (lines 504-562) with `.conf-leader` rows for each line item and a `.conf-total` footer with the `⚗` seal in brass per planner.css:794-833.

**(c) Scope banner at the top** (`.potion-scope.shopping` for BYOB, `.potion-scope.hosted` for hosted). Verbatim copy per §6.1.

**(d) Catch-all "Anything else?" field.** A new card sits between the summary card and the estimated-extras section. Renders the catch-all textarea bound to `selections.additionalNotes`. Copy per §6.6.

**(e) Stripe Elements integrity.** No changes to `Elements`, `PaymentElement`, `clientSecret`, `paymentScenario`, `paymentChoice`, or any of the payment-state effects. The new `.potion-app` scope must not introduce any rule that affects `.StripeElement` or its iframe. Verify Elements still mount and confirm post-port.

### 5.6 Other step components: scope banner mount

Mount `<ScopeBanner tone={…} title={…} body={…} />` at the top of each:

| File | Tone | Mode |
|---|---|---|
| `steps/SignaturePickerStep.js` | shopping / hosted | based on plan.package_category |
| `steps/MocktailStep.js` | shopping / hosted | based on plan.package_category |
| `steps/FullBarSpiritsStep.js` | shopping / hosted | based on plan.package_category |
| `steps/FullBarBeerWineStep.js` | shopping / hosted | based on plan.package_category |
| `steps/BeerWineStep.js` | shopping / hosted | based on plan.package_category |
| `steps/HostedGuestPrefsStep.js` | hosted | always hosted by definition |
| `steps/MenuDesignStep.js` | aside | both modes |
| `steps/ConfirmationStep.js` | shopping / hosted | based on plan.package_category |

`<ScopeBanner>` is a small local component, either an exported helper from `client/src/pages/plan/components/ScopeBanner.js` (preferred) or inlined per step. Recommend the shared file so copy lives in one place.

The following steps do **not** receive a scope banner:

- `steps/LogisticsStep.js` (Logistics captures cost-affecting fields like bar rental and equipment; a "not part of shopping" banner there would be misleading)
- `steps/QuickPickStep.js` (selecting a serving-type style is configuration, not drink-picking; scope is already conveyed by the welcome roadmap)
- `steps/CustomSetupStep.js` (module-activation configuration; same reasoning as QuickPick)

The welcome step also has no banner; it has the roadmap instead.

### 5.7 Inline scope notes (per quiz answer #6)

Mount `<span className="potion-field-note">` directly under two textareas:

**In `steps/MocktailStep.js`**, under the mocktail notes textarea:
> *"You don't need to tell us what you're providing. Your selections above already settle that. Use this box only for preferences or anything we should know."*

**In `steps/LogisticsStep.js`**, under the access-notes textarea:
> *"Anything tricky we should know about the venue, like parking, load-in, stairs, or building rules. You don't need to repeat anything you've selected above."*

---

## 6. Copy (verbatim, for porting)

All copy below is em-dash-free by deliberate style. Em dashes read as an AI tell and the brand voice avoids them. Use commas, periods, colons, or parentheticals when porting; do not "improve" copy by adding em dashes back.

### 6.1 Scope banners

**Drink steps, BYOB (`.potion-scope.shopping`)**
- Title: *Builds your shopping list*
- Body: *Your choices here turn into your shopping list, down to the ice cube. We'll tell you exactly what and how much to buy.*

**Drink steps, hosted (`.potion-scope.hosted`)** *(best-effort copy; full hosted-mode copy pass lands in the Hosted Package Alignment carve-out, §3.2.)*
- Title: *We're providing*
- Body: *Pick what you want served. No beverage shopping on your end.*

**Menu Design step, both modes (`.potion-scope.aside`)**
- Title: *Not part of your shopping list*
- Body: *How you'd like your drink menu displayed at the event.*

**Confirmation step, BYOB (`.potion-scope.shopping`)**
- Title: *Your shopping list*
- Body: *After you submit, we'll generate your final shopping list from everything you've picked. Anything you've added as an upgrade will come from us instead. Menu design isn't on the list.*

**Confirmation step, hosted (`.potion-scope.hosted`)** *(best-effort, see §3.2)*
- Title: *You're all set*
- Body: *We'll stock everything based on your picks. No shopping on your end.*

### 6.2 Welcome roadmap

**BYOB**
- Part 1: title *Build your drink menu* / body *Cocktails, mocktails, beer and wine, spirits. Whatever you'd like to serve, we'll tally up what you need.* / tag *→ becomes your shopping list*
- Part 2: title *Choose menu design* / body *Custom, standard, or skip it. We bring the printed and framed menu to display on the bar.*
- Part 3: title *Confirm logistics* / body *Event-day contact, parking, equipment, access notes.*

**Hosted** *(Part 1 differs; Parts 2 and 3 match BYOB. Hosted-mode copy pass in §3.2.)*
- Part 1: title *Pick what we serve* / body *Your `{plan.package_name}` is locked in. Choose the specific drinks within it.* / tag *→ we stock everything*

**After-submit footer** (renders below all three cards, both modes)

> *After you submit, we put together your final shopping list, menu, and event order. You'll hear from us within 2 business days.*

### 6.3 Inline field notes

**Mocktail notes textarea:**
*"You don't need to tell us what you're providing. Your selections above already settle that. Use this box only for preferences or anything we should know."*

**Logistics access-notes textarea:**
*"Anything tricky we should know about the venue, like parking, load-in, stairs, or building rules. You don't need to repeat anything you've selected above."*

### 6.4 Menu Design step, radio labels and reveals

See §5.4 for placement. The middle option is labeled **"Standard Menu"** in the UI. The internal data value stays `menuStyle === 'house'` so we don't churn the migration or any other consumer; only the user-facing label and reveal change.

**Radio labels:**
- *Custom Menu Design* (designed for your event's look and feel)
- *Standard Menu* (Dr. Bartender branded, drinks listed in plain terms)
- *No Menu Card* (we'll skip the printed menu)

**Custom reveal:** existing theme / drink-naming / notes textareas (unchanged behavior).

**Standard reveal:**
*"Our standard bar menu. Dr. Bartender branded, listing your drinks in plain terms like Vodka Lemonade, Old Fashioned, or Beer and Wine. We bring it printed and framed for the bar. No setup needed from you."*

**No Menu Card reveal:**
*"No printed menu will be created. Your selections still drive your shopping list."*

### 6.5 Submit-celebration "What happens next?" copy

Two variants, based on whether the client picked a menu at all. The submit screen does not call out which menu variety they chose.

**Menu chosen (custom or standard):**
*"We'll use your selections to create a shopping list, a menu, and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"*

**No menu:**
*"We'll use your selections to create a shopping list and a BEO (Banquet Event Order) for your event. Expect to hear from us within 2 business days!"*

### 6.6 Catch-all "Anything else?" card on Confirmation

Renders as a `.card` between the summary block and the estimated-extras section. One textarea, no validation, optional. Stored as `selections.additionalNotes`.

**Card heading:**
*Anything else we should know?*

**Body text under the heading:**
*One last chance to mention anything we should know about your event or your guests. Allergies, family stories, dietary needs, special requests, the stuff you've been meaning to bring up.*

**Textarea placeholder:**
*E.g., my dad has a nut allergy; the groom wants his old fashioned with extra orange peel; please introduce yourself to my mother-in-law when you arrive.*

**Textarea attributes:** `rows={4}`, value bound to `selections.additionalNotes`, onChange dispatches `onChange('additionalNotes', e.target.value)`.

This field intentionally has no inline scope-note. It IS the scope-note's other half: the banners tell clients what not to put in scoped notes fields; this card gives them somewhere to put it instead.

---

## 7. Data shape

### 7.1 New selection fields

`selections.menuStyle: 'custom' | 'house' | 'none' | null`

- `null` means unanswered. The Menu Design step considers this incomplete (no radio is checked).
- The legacy `selections.customMenuDesign` boolean is preserved in the JSON (not deleted) but unread by new code.

`selections.additionalNotes: string`

- Default empty string. Optional, no validation.
- Captured on the Confirmation step via the catch-all card (§6.6). Submitted as part of the selections JSON via the existing PUT to `/drink-plans/t/<token>`. No server-side reads or processing; the admin reviews it when reading the submitted plan.

### 7.2 Migration (one-time, on plan load)

Per §5.2(d). Run during the existing `if (data.status === 'draft' || data.status === 'submitted')` block, after the existing migrations. Idempotent: only runs when `savedSel.menuStyle === undefined`.

### 7.3 No schema changes

`selections` is a JSON column on `drink_plans`. No DDL. No column adds. No backfill required; migration is read-side only and per-record.

### 7.4 No server-side reads of menu fields

Confirmed: server has zero references to `menu_design`, `customMenuDesign`, `menuTheme`, `drinkNaming`, `menuDesignNotes`. The new `menuStyle` value is stored in the JSON via the existing auto-save / submit paths; no server route changes.

---

## 8. Implementation order (suggested)

This is the order I would tackle it in. Writing-plans skill may resequence as it sees fit.

1. **Token rename + `.potion-app` wrapper.** Add the wrapper class to `PotionPlanningLab.js`. Append a new section banner to `index.css`. Port the base `.potion-app`, `.potion-shell`, `.potion-card`, `.potion-kicker`, `.potion-hairline` blocks. Verify the wizard still loads without visual breakage on top of the existing chalkboard.
2. **Welcome + chrome.** Port `.potion-welcome-*`, the brass-rail chrome (`.potion-rail`, `.potion-rail-tick`), step counter, save indicator (Lab.js change for continuous pulse). Verify the welcome screen renders and the rail ticks update across step navigation.
3. **Step cards.** Port `.potion-step`, `@keyframes potionFadeIn`, `.step-nav`, `.btn-*` planner scopes.
4. **Quick-pick grid.** Port `.serving-type-*` blocks. Verify selection animation (`.selecting`) still fires on click.
5. **Drink picker (grid variant).** Port `.drink-card-grid`, `.drink-tile`, `.drink-tile-name`, `.drink-tile-desc`, `.your-menu-*`. Verify add/remove + per-drink upgrade chips.
6. **Form elements.** Port `.form-input`, `.form-textarea`, `.form-select`, `.checkbox-grid`, `.checkbox-label`. Verify Stripe Elements still inherit clean form-input styling.
7. **Menu Design three-way.** Update `MenuDesignStep.js` to the three-radio shape and reveals. Add the `menuStyle` migration to Lab.js. Update `ConfirmationStep.js` summary block. Update Lab.js submit-celebration copy.
8. **Scope banners.** Add `ScopeBanner` shared component. Mount on each step per §5.6. Port `.potion-scope*` CSS.
9. **Welcome roadmap.** Add `WelcomeRoadmap` to `RefinementWelcomeStep.js`. Port `.potion-roadmap*` CSS. Verify mobile reflow + the existing bartender/drinks image layout untouched.
10. **Inline field notes.** Mount in MocktailStep and LogisticsStep. Port `.potion-field-note` CSS.
11. **Confirmation polish.** Port `.conf-leader`, `.conf-total`, `.conf-total-seal`. Verify Stripe Elements mount + confirm the extras payment.
12. **Submitted celebration.** Port `.potion-submitted`, `.potion-ornament`, `.potion-panels`, `.potion-panel*`. Verify the bartender PNG + 🎉 still render.
13. **Loading / locked / error.** Port `.potion-blocking`, `.potion-spinner`. Verify all three render correctly with the chalkboard background still showing through.
14. **Specificity defense audit.** Read every parchment-card location and verify the `.potion-app .potion-card h1/2/3/4` and component-specific overrides defeat the global `.page-container h*` rule. No cream-on-cream anywhere.
15. **Cross-device pass.** Verify mobile reflow of: welcome image grid, serving-type grid, drink-card grid (collapses to single column ~360px), roadmap (3-col → 1-col), confirmation total.

---

## 9. Quality gates (definition of done)

Adapted from the 2026-05-17 brief's §11. Ship when **all** of these hold:

- [ ] Flow unchanged: every step, hosted/mocktail skips, browser-back, step order, auto-save (30s + beforeunload), Stripe Elements mounting + confirmation, `useFormValidation` → `<FieldError>` → `<FormBanner>` chain all behave exactly as before.
- [ ] No cream-on-cream readability bugs. Every heading and label inside a parchment card renders `--deep-brown` text. Verified by direct inspection of: welcome card, hosted package card, serving-type cards, custom-setup card, every drink card (grid tile), your-menu items, mocktail card, full-bar cards, beer-wine card, menu-design step, logistics step, hosted-guest-prefs step, confirmation card, submitted card, loading card, locked card, error card.
- [ ] Continuous brass pulse runs while the wizard is mounted; halts on `prefers-reduced-motion: reduce`. Save state cycles: idle ("Saved") → saving ("Saving…") → saved ("Saved"). Save-failed state shows the rust dot and the alert text.
- [ ] Three-way Menu Design renders correctly. Custom shows the three textareas. Standard Menu and No Menu Card show their respective field notes. The submit-celebration copy reflects whether any menu was chosen (custom or standard) versus none. Legacy plans with `customMenuDesign === true` migrate to `menuStyle === 'custom'`; `=== false` migrates to `menuStyle === 'none'`.
- [ ] Scope banners render with correct tone on every listed step. No banner on LogisticsStep. Copy matches §6 verbatim.
- [ ] Welcome roadmap renders three cards, with BYOB/hosted copy variants. Mobile reflow collapses to single column at ≤720px. Existing bartender/drinks image layout in the parent welcome card is identical (pixel-equivalent on a screenshot diff). After-submit footer renders below the three cards with the brass top-hairline.
- [ ] Catch-all "Anything else?" card renders on the Confirmation step between summary and extras. `selections.additionalNotes` saves and restores across page reloads. Empty value is allowed; the field is optional.
- [ ] No edits leaked into the bare `.auth-page` rule or any global `.card` / `.btn-*` rule. Login, Register, ClientLogin, and ClientShoppingList visually unchanged.
- [ ] `PotionPlanningLab.js` still under 1000 lines (currently ~952). If JSX additions push it over, extract scope-banner + roadmap to the new `components/` folder rather than fragmenting the state machine.
- [ ] Stripe extras pay-now still mounts and confirms. The `.potion-app` scope adds no rule that targets `.StripeElement` or its iframe.
- [ ] All ARIA preserved: `role="status"` / `aria-live="polite"` on save + loading indicators; `role="alert"` on save-failed; focus-visible outlines on every interactive element; keyboard activation on every clickable non-button card; `useFormValidation` chain intact.
- [ ] `index.css` grows by ~900 lines (no marker required, since CSS is out of scope for the size hook). No new dependencies in `package.json`. No new fonts. No Tailwind, no CSS-in-JS.

**When all gates pass, stop iterating.** This is a finishable surface. Per the brief: *every flourish you add to a working wizard is a small tax on the client trying to finish booking their bar.*

---

## 10. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cream-on-cream readability bug on a heading we missed in §5 | Medium | §9 gate requires direct inspection of every parchment-card surface. The specificity strategy in §4.3 covers `.potion-card` headings globally; a missed component would need its own override. |
| Token substitution sweep misses a `--drb-*` reference | Low | Mechanical bulk-rename. Verify by grep `--drb-` in `index.css` after port → must return zero. |
| `.potion-app` adds a rule that breaks Stripe Elements | Low | `.StripeElement` mounts in an iframe; our rules cannot reach iframe content. We must not target `.StripeElement` or its parent wrapper. Verified by §9 gate on Stripe mount + confirm. |
| The welcome image reflow breaks because we added the roadmap below the existing welcome card | Medium | Roadmap mounts below the welcome card, outside its grid. Existing `.potion-welcome-body` grid is untouched. Verify by screenshot diff at 360px, 720px, 1200px. |
| `menuStyle` migration corrupts in-flight drafts that have neither `customMenuDesign` nor `menuStyle` set yet | Low | Migration only runs when `menuStyle === undefined`, and the value it sets (`null`) is the unanswered state, same as the user never having touched the field. No data lost. |
| LogisticsStep's missing scope banner reads as inconsistent | Low | Intentional. Bar rental and equipment fields can add cost; a "not part of shopping" banner would mislead. The inline access-notes field note covers the related UX concern. |
| Continuous pulse on save indicator distracts users | Low | The "whisper" pulse is intentionally low-contrast (~0.55 → 1.0 opacity over 3s). Reduced-motion fallback halts animation. If user feedback flags it, the indicator can be quieted further by lowering the opacity range. |
| The "Standard Menu" placeholder note over-promises before the generator ships | Low | Copy says we bring it printed and framed to the event, not that it is auto-generated or delivered ahead. The operator brings it manually today; that gap is invisible to the client. The generator timing belongs in §3.1. |
| `client/src/index.css` getting unwieldy (12.7k lines) | Already a concern | CSS file-size discipline is currently absent from the pre-commit hook. Long-term: a future spec may split `index.css` into per-surface files. Out of scope for this PR. |
| Hosted welcome screen stacks three cards vertically: package summary (existing) + welcome card with images (existing) + welcome roadmap (new) | Low | Vertical pileup may feel heavy on hosted plans. Verify at implementation time on desktop and mobile; if cramped, consider tightening the package summary card padding or moving it into the roadmap Part 1 body. |
| Continuous save indicator generates an extra "Saved" screen-reader announcement per save cycle compared to current visibility-toggled behavior | Low | Mitigated by `aria-live="off"` on the idle state (see §5.2(b)). Idle text changes are not announced. Saving and failed states still announce. |
| Brass-rail chrome ticks become very thin on narrow viewports | Low | Each tick uses `flex: 1; height: 2px;` so at ~360px width each tick is ~50px wide, still visible. Verify visually at implementation time; if too thin, add a `min-width` to `.potion-rail-tick` in the mobile media query. |

---

## 11. Out of scope (explicitly)

- Standard Menu auto-generation (see §3.1 carve-out)
- Hosted package alignment (see §3.2 carve-out)
- Marketing site reskin (separate surface)
- Admin app reskin (separate surface)
- The Stage-2 global primitive pass (`.card`, `.btn-primary`, `.btn-secondary`, `.auth-page`)
- Shopping list generator updates to subtract add-ons from the list (the planner reskin promises this in copy; the server-side fix is a separate workstream, and the operator audits the list before the client sees it in the interim)
- Splitting `client/src/index.css` into per-surface files
- Changes to the step queue, hosted skip logic, or any payment math

---

## 12. Open questions (to resolve at writing-plans time, not now)

- Whether `<ScopeBanner>` lives as a shared component file or is inlined per step. Recommendation: shared file at `client/src/pages/plan/components/ScopeBanner.js`. Final call at plan-writing time.
- Whether `<WelcomeRoadmap>` is a separate file or inlined in `RefinementWelcomeStep.js`. Recommendation: separate file if it exceeds ~40 lines; otherwise inline.
- Whether the mobile fallback for the grid drink picker needs an alternate `.drink-card-list` layout below 360px or whether the grid gracefully collapses to one column. Verify visually at implementation time.
