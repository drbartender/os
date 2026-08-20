# Proposal Options Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the proposal page's options surface as one ladder of how much DrB handles (bar service up through fully hosted), entered beside the pricing section, with real commits: rung switches, extras-only anchor commits, and one-step undo, all riding the already-built switch endpoint.

**Architecture:** Two lanes, strictly sequenced. The server mini-lane (`oo-server-display`) adds six additive payload deltas to the already-merged lane-1 endpoints: `bar_type` + `description` + pricing-display fields (`priced_by`, `per_guest_rate`, `min_billed_guests`, `min_total`) + `visible_extra_ids` on the quote, the `amount_paid` check on `options_available`, and a grinding capture on the switch. The client lane (`oo-ladder-client`) then builds the drawer: a pure ladder-assembly module first (testable without React), then drawer chrome, rungs, the scoped extras strip with draft semantics, and the commit/undo flows, with an RTL suite owning the spec's client test list and the lane owning visual fidelity to the vendored artifact.

**Tech Stack:** Existing stack only, no new dependencies. Raw SQL via `pg`, Express routers, `node --test`, React 18 + jest/RTL (CRA), vanilla CSS in `index.css`, raw axios on the public token page.

**Spec:** `docs/superpowers/specs/2026-08-20-proposal-options-ladder-design.md` (spec-fleet findings folded 2026-08-20). It AMENDS `2026-08-14-proposal-options-drawer-design.md`, whose server sections are built in lane oo-switch-server. Read both.

**PRECONDITION (not a task in this plan):** lane oo-switch-server (8 commits, tip 38c5a363) gets its full fleet re-run against current main and merges BEFORE `oo-server-display` cuts. Per the spec's Sequencing section and Dallas's standing decision: lane 1 may merge whenever, but NOTHING in this project pushes until the client lane is in.

**Proven context (verified against the repo and the lane worktree 2026-08-20):**
- Lane `publicOptions.js`: `priceOption(pkg)` (closure inside the route handler) prices each option via `priceProposedState` and returns `{ total, available, reason, dropped }`, swallowing the engine snapshot; `ValidationError` means `available: false` (`instanceof`, never `.status`). Option entries carry exactly `package_id, slug, name, category, pricing_type, is_current, total, available, reason, dropped`. `echoContract` shows the contract total verbatim on the current package until any body is given. Tier entries carry `addon_id, slug, name, total, covers, selected` (null addon_id = "Bar service only"). The extras block is built from `visibleAddonsFor` for the CURRENT package only, entries already carry `description, billing_type, rate, extra_hour_rate, category, selected`. Inside `priceOption`, `visibleIds` (a Set of admissible addon ids for THAT package) is already computed for cross-package moves; `visible_extra_ids` is a read of it, not new logic.
- `server/utils/pricingEngine.js`: the snapshot carries `floor_reason` (`'guest_min' | 'dollar_min' | null`), `billed_guests`, `floor_applied` (:598-607). The rate-tier rule (:77-88, `hostedBaseComponents`, NOT exported): `isSmall = pkg.min_guests && guestCount < pkg.min_guests`; small events use `base_rate_4hr_small` / `extra_hour_rate_small`. `priceProposedState` returns this snapshot, so `snapshot.floor_reason` is already available to `priceOption`; only the wrapper drops it today.
- Lane `publicToken.js`: the `options_available` predicate is a plain `const optionsAvailable = ['sent','viewed'].includes(...) && ...` chain ending in `Number(proposal.comparable_pkg_count) >= 2`, directly above the delete-on-copy strip of internal fields. `amount_paid` is in the public allowlist SELECT (the page displays it).
- Lane `publicSwitch.js`: `Sentry` required at :27; the TOTAL_CHANGED 409-storm capture at :69 is the pattern for the grinding capture; success responds `res.json(payload)` at :490 with the public-safe payload; the activity-log INSERT in the same handler carries the switch's action string to reuse in the grinding count query.
- `client/src/utils/proposalRules.js:92`: `filterAddons({ addons, isHosted, packageCategory, addonIds, guestCount })` returns `{ visibleAddons, isIncludedMap, isUnavailableMap }`, and the module exports `BUNDLE_INCLUDED`, `BUNDLE_UNAVAILABLE`, `BUNDLE_COVERED`, `isIncludedByBundle`, `isUnavailableByBundle`. This is the client twin the blocked rows, absorption list, and BYOB-side scoping run on. It mirrors the server's `visibleAddonsFor` gates (mocktail-bar needs Formula/Full Compound in the selection, real-glassware capped at 100 guests, parking-fee and syrups-3pack always hidden).
- `client/src/data/packages.js`: `PACKAGES` entries are `{ id: <db slug>, name, category: 'full-bar' | 'beer-wine', tagline, description, sections: [{ heading, items: ['Name – witty text'] }] }`; `getPackageBySlug(slug)` returns null for missing slugs. `the-refined-reaction` and `the-clear-reaction` are MISSING. `catalogBuckets.js` (`client/src/pages/proposal/catalogBuckets.js`) exports `bucketsForSlug` / `SECTION_ORDER` and returns null on a missing slug; `OtherOptionsPanel.js` gates the contents section on truthiness, so missing = silently absent.
- `client/src/pages/proposal/proposalView/ProposalView.js` (695 lines, soft cap 700 warns): `showOptions` :30, `signedThisSession` ref :46, `isPayableStatus` :97, `handleWantOption` (the mailto, comment block above it) :300-323, bottom button + panel mount :683-686. Client jest precedent: `proposalView/gratuityFloor.test.js`, `proposalView/AgreementText.test.js`; suites run `cd client && CI=true npm test`; build gate `cd client && CI=true npx react-scripts build`.
- `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`: Package `h2` :25 reads `proposal.package_name`; Pricing section h2 :58; totals tfoot :72-81. The entry block lands below the tfoot, inside the Pricing section.
- `client/src/pages/proposal/otherOptions/`: `OtherOptionsPanel.js` (345 lines: `load`, debounced `reQuote`, `reqRef` sequencing, keep-last-good `error` handling, `byobBuckets`, lanes render), `ExtrasPanel.js` (53 lines, `rateLabel` covers every billing_type including per_guest_timed via `timedPerGuestRateLabel`), `CompareTable.js` (200 lines, exists to DELETE).
- The ~94 lines of shipped `.oo-*` CSS live in `client/src/index.css`; Apothecary tokens (`--brass`, `--amber`, `--cream-text`, `--chalkboard`, `--font-display`, `--font-body`) already style the proposal page.
- Vendored artifact: `docs/design-artifacts/2026-08-20-proposal-options-ladder.dc.html`. Its sheet logic: peek `min(66vh, 600px)`, full `96vh`, `transition:height 0.26s ease`, pointer-event drag with snap on release; desktop panel `min(432px, 94vw)`. Its `RUNGS`/`EXTRAS` data and BYOB `brings` arrays are placeholders (including three "stir sticks" mentions the built surface must not reproduce).
- Prod catalog (live-queried 2026-08-20): active non-class `bar_type` values are exactly `service_only` (Core Reaction), `beer_and_wine` (4), `full_bar` (5), `mocktail` (Clear Reaction). All non-class actives share `guests_per_bartender=100`, `min_billed_guests=25`, `min_total=550` today, which is exactly why the spec forbids hardcoding any of them.
- The dev server is Claude-managed and normally already running; check before spawning a second instance.

## Global Constraints

- **No em dashes** in copy, comments, or docs. Commas, colons, parentheses.
- **Max effort everywhere.** Money on proposals is DOLLARS; every total comparison in integer cents via `Math.round(Number(x) * 100)`.
- **AppError discipline:** `instanceof` / `statusCode`, never `.status`.
- **Server tests one at a time from repo root.** Client gate: `cd client && CI=true npx react-scripts build` before any commit touching `client/`; client suites via `cd client && CI=true npm test`.
- **Explicit staging only; no backticks in commit messages** (`git commit -F -` heredoc).
- **Copy is LOCKED by the spec's Copy section and used verbatim** (the spec, not this plan, is the copy source of record; every string below is quoted from it).
- **Additive payload only:** every existing quote/public-payload field stays byte-identical; the mini-lane adds fields, never changes one.
- **The artifact is the visual benchmark** (Visual contract + 7 named deviations in the spec). Lane `oo-ladder-client` owns fidelity and pulls the live artifact via DesignSync at build time; the vendored copy is provenance.
- **Frontend calls on this page use raw axios + BASE_URL** (public token page, no JWT), matching `ProposalView.js`.
- `publicOptions.js`, `publicToken.js`, `publicSwitch.js`, `rateLimiters.js` are sensitive-listed: full fleet per lane, plus the standard sensitive-path treatment at push.

## Lane map

```yaml
lanes:
  - id: oo-server-display
    phase: 1
    scope: >
      The six additive server deltas from the spec's "Server deltas" section,
      applied to the lane-1 endpoints after oo-switch-server has merged:
      bar_type + description + priced_by/per_guest_rate/min_billed_guests/
      min_total on option entries; description + pricing-display fields on
      tier entries; per-option visible_extra_ids (hosted options, recomputed
      per request); amount_paid = 0 joins the options_available predicate;
      Sentry capture on N landed switches per token per window. No schema
      changes, no new files, no doc-table changes.
    footprint:
      - server/routes/proposals/publicOptions.js
      - server/routes/proposals/publicOptions.test.js
      - server/routes/proposals/publicToken.js
      - server/routes/proposals/publicToken.test.js
      - server/routes/proposals/publicSwitch.js
      - server/routes/proposals/publicSwitch.test.js
    depends_on: []   # but see PRECONDITION: cuts only after oo-switch-server merges
    review_fleet: [code-review, consistency-check, security-review, database-review, performance-review]

  - id: oo-ladder-client
    phase: 2
    scope: >
      The drawer, ladder-first: a pure assembly module (bar_type keyed lanes,
      Clear Reaction sideways, open state), then drawer chrome (sheet/panel,
      entry block, mailto retirement), rung rows with the three priced_by
      sublines, the anchor with extras-only commits, the scoped extras strip
      (draft semantics, three blocked-row copy cases, absorption in the
      pre-switch confirm), the commit/reprice/drop/land/undo flows, the RTL
      suite owning the spec's client test list, and visual fidelity to the
      artifact (DesignSync pull, ui-ux-review judged against it).
    footprint:
      - client/src/pages/proposal/proposalView/ProposalView.js
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
      - client/src/pages/proposal/otherOptions/OtherOptionsPanel.js
      - client/src/pages/proposal/otherOptions/OtherOptionsPanel.test.js
      - client/src/pages/proposal/otherOptions/ladder.js
      - client/src/pages/proposal/otherOptions/ladder.test.js
      - client/src/pages/proposal/otherOptions/popularExtras.js
      - client/src/pages/proposal/otherOptions/ExtrasPanel.js
      - client/src/pages/proposal/otherOptions/CompareTable.js
      - client/src/data/packages.js
      - client/src/index.css
      - README.md
    depends_on: [oo-server-display]
    review_fleet: [code-review, consistency-check, security-review, ui-ux-review]
```

The client lane consumes only the HTTP contract pinned in the Interfaces blocks below, so it can be BUILT from this plan alone, but merges after the mini-lane so integration runs against real payloads.

---

# Lane oo-server-display

### Task 1: Pricing-display + identity fields on options and tiers

**Files:**
- Modify: `server/routes/proposals/publicOptions.js` (the `priceOption` closure, the option-entry push, the tier loop)
- Test: `server/routes/proposals/publicOptions.test.js` (extend)

**Interfaces:**
- Produces (client lane consumes): every `options[]` entry gains
  `bar_type` (string, verbatim `service_packages.bar_type`),
  `description` (string|null, verbatim `service_packages.description`),
  `priced_by` (`'rate' | 'guest_min' | 'dollar_min' | null`; null for BYOB/flat and for `echoContract` rows),
  `per_guest_rate` (number|null: the per-guest rate actually charged across the full event, small-tier aware),
  `min_billed_guests` (number|null, `pkg.min_billed_guests`),
  `min_total` (number|null, `pkg.min_total`).
  Every `tiers[]` entry gains `description` (string|null, `service_addons.description`) and `per_guest_rate` (number|null: `rate + extra_hour_rate * max(0, hours - 4)`; null for the bar-service-only row).
- Consumes: `snapshot.floor_reason` / `snapshot.billed_guests` from `priceProposedState` (already returned, currently dropped by the wrapper).

- [ ] **Step 1: Extend the `priceOption` wrapper** to thread the engine's floor verdict through instead of dropping it:

```js
return {
  total: Number(snapshot.total), available: true, reason: null, dropped,
  floor_reason: snapshot.floor_reason ?? null,
};
// and in the ValidationError catch:
return { total: null, available: false, reason: err.message || '...', dropped, floor_reason: null };
```

- [ ] **Step 2: Add a per-guest-rate helper** near `priceOption` (rate-tier logic mirrors `hostedBaseComponents`, which is not exported; keep the comment saying so and pointing at `pricingEngine.js:77`):

```js
// Display only: the per-guest rate the engine actually charges this event,
// small-tier aware. Mirrors hostedBaseComponents (pricingEngine.js:77),
// which is deliberately unexported; totals still come only from the engine.
const perGuestRateFor = (pkg, guestCount, hours) => {
  if (pkg.pricing_type !== 'per_guest') return null;
  const isSmall = pkg.min_guests && guestCount < pkg.min_guests;
  const rate4 = Number(isSmall ? pkg.base_rate_4hr_small : pkg.base_rate_4hr);
  const extra = Number(isSmall ? (pkg.extra_hour_rate_small || pkg.extra_hour_rate) : pkg.extra_hour_rate);
  return rate4 + extra * Math.max(0, hours - 4);
};
```

- [ ] **Step 3: Extend the option-entry push.** `priced_by`: `'rate'` when `floor_reason` is null and the package is per_guest; the engine's `'guest_min'`/`'dollar_min'` otherwise; null for BYOB and for the `echoContract` row (a contract echo was never engine-priced this request):

```js
options.push({
  /* ...existing ten fields byte-identical... */
  bar_type: pkg.bar_type,
  description: pkg.description ?? null,
  priced_by: echoContract || pkg.pricing_type !== 'per_guest'
    ? null : (priced.floor_reason ?? 'rate'),
  per_guest_rate: perGuestRateFor(pkg, Number(proposal.guest_count), Number(proposal.event_duration_hours)),
  min_billed_guests: pkg.min_billed_guests === null ? null : Number(pkg.min_billed_guests),
  min_total: pkg.min_total === null ? null : Number(pkg.min_total),
});
```

- [ ] **Step 4: Extend the tier push** with `description: t ? (t.description ?? null) : null` and `per_guest_rate: t ? Number(t.rate) + Number(t.extra_hour_rate || 0) * Math.max(0, Number(proposal.event_duration_hours) - 4) : null`.

- [ ] **Step 5: Tests.** Extend `publicOptions.test.js` (real router, real seeded catalog, nonce'd `service_addons` helper already in the file): (a) every option entry carries `bar_type` matching its catalog row and a non-undefined `description`; (b) a sub-50-guest proposal gets `priced_by: 'guest_min'` or `'dollar_min'` per the engine on a package with `min_billed_guests`, and the 50+ case gets `'rate'` with `per_guest_rate` equal to `base_rate_4hr + extra_hour_rate * (hours - 4)`; (c) the small-tier rate: a 30-guest event's `per_guest_rate` uses `base_rate_4hr_small`; (d) the current-package `echoContract` row has `priced_by: null`; (e) tier entries carry `description` and the timed per-guest math; (f) a snapshot assertion that the PRE-EXISTING ten option fields and six tier fields are unchanged (additive-only guard).

- [ ] **Step 6: Run** `node --test server/routes/proposals/publicOptions.test.js` (from repo root, alone). Commit with explicit paths.

### Task 2: `visible_extra_ids` per hosted option

**Files:**
- Modify: `server/routes/proposals/publicOptions.js` (inside `priceOption`, cross-package branch)
- Test: `server/routes/proposals/publicOptions.test.js` (extend)

**Interfaces:**
- Produces: every `options[]` entry gains `visible_extra_ids` (integer array): the addon ids `visibleAddonsFor` admits for THAT package against THIS request's submitted extras, minus tier-addon ids. For the current package it equals the ids of the top-level `extras` list. Recomputed every request; the client re-quotes on draft changes, so the set tracks selection-dependent gates (mocktail-bar) automatically. BYOB tier-rung scoping is deliberately NOT served (client twin owns it, spec Extras section).

- [ ] **Step 1: Capture the set.** `visibleIds` already exists inside `priceOption` for the cross-package branch; the same-package branch builds the equivalent for the current package. Return `visible_extra_ids: [...visibleIds].filter(id => !tierIds.has(id))` from both branches alongside the existing fields, and spread it into the option entry.
- [ ] **Step 2: Tests:** (a) the current package's `visible_extra_ids` equals the `extras` list's `addon_id`s; (b) a BYOB-only addon id (nonce fixture, `applies_to='byob'`) appears in the BYOB option's set and not in any hosted option's; (c) submitting extras that include The Formula's id flips mocktail-bar into the BYOB option's set (selection dependence); (d) tier addon ids never appear.
- [ ] **Step 3: Run the suite; commit.**

### Task 3: `options_available` gains the `amount_paid` check

**Files:**
- Modify: `server/routes/proposals/publicToken.js` (the `optionsAvailable` predicate)
- Test: `server/routes/proposals/publicToken.test.js` (extend)

**Interfaces:**
- Produces: `options_available` is false whenever `Number(proposal.amount_paid) > 0`, matching the switch's own refusal, so the entry card can never render into a guaranteed `SWITCH_NOT_AVAILABLE`. (`amount_paid` is already in the public SELECT.)

- [ ] **Step 1:** Add `&& Number(proposal.amount_paid || 0) === 0` to the predicate chain, with a comment naming the force-rewind / `external_paid` import class it exists for (the reconcile comment in `publicSwitch.js` describes the same class).
- [ ] **Step 2: Test:** a `sent` proposal with `amount_paid > 0` gets `options_available: false`; the zero-paid case stays true. Run `node --test server/routes/proposals/publicToken.test.js`; commit.

### Task 4: Grinding capture on landed switches + lane gate

**Files:**
- Modify: `server/routes/proposals/publicSwitch.js` (post-commit tail, before `res.json`)
- Test: `server/routes/proposals/publicSwitch.test.js` (extend)

**Interfaces:**
- Produces: a Sentry `captureMessage('switch: high landed-switch frequency for one token')` when this proposal has 5+ switch activity-log rows in the last 30 minutes (count includes the row just written). Mirrors the TOTAL_CHANGED capture at :69 (same tag shape). Threshold constants module-level (`GRIND_COUNT = 5`, `GRIND_WINDOW_MIN = 30`).

- [ ] **Step 1:** After COMMIT (in the best-effort tail, on the pooled client BEFORE release per the one-connection law, or after release via `pool.query`, whichever the file's existing tail already does; match it): `SELECT COUNT(*) FROM proposal_activity_log WHERE proposal_id = $1 AND action = $2 AND created_at > NOW() - INTERVAL '30 minutes'` using the handler's own action string; capture at >= 5. A query failure logs and never affects the response.
- [ ] **Step 2: Test:** stub Sentry in the require cache (the file's existing test pattern); land 5 switches on one proposal inside the window; assert one capture. Run the suite.
- [ ] **Step 3: Lane gate:** run, one at a time, `publicOptions.test.js`, `publicToken.test.js`, `publicToken.signTotal.test.js`, `publicSwitch.test.js`. Commit; lane ready for its fleet + merge.

---

# Lane oo-ladder-client

### Task 1: Ladder assembly module + popular chips + the two missing catalog entries

**Files:**
- Create: `client/src/pages/proposal/otherOptions/ladder.js`
- Create: `client/src/pages/proposal/otherOptions/ladder.test.js`
- Create: `client/src/pages/proposal/otherOptions/popularExtras.js`
- Modify: `client/src/data/packages.js` (add `the-refined-reaction`, `the-clear-reaction`)

**Interfaces:**
- Produces:
  - `buildLadder({ options, tiers, current_package_id })` returns
    `{ anchor, byobRungs, hostedLanes, sideways, unmapped }` where
    `anchor = { kind: 'option'|'tier', ...entry }` (the client's current configuration: the `is_current` option, refined to the selected tier row when that option is BYOB);
    `byobRungs` = always the full tier list (bar-service-only row included) minus the anchor's own row, for hosted and BYOB clients alike, per the spec's open state;
    `hostedLanes = [{ key: 'full_bar', label: 'Full bar', rungs: [...] }, { key: 'beer_wine', label: 'Beer & wine', rungs: [...] }]` from `bar_type` (`beer_and_wine` maps to `beer_wine`), each excluding the current option;
    `sideways` = the `bar_type === 'mocktail'` option, or null when it is the anchor;
    `unmapped` = options whose `bar_type` fits no lane (rendered in the Also-available catch-all AND breadcrumbed).
  - `sublineFor(entry, kind)` returns the LOCKED spec strings:
    hosted `priced_by === 'rate'` → `"{fmt(per_guest_rate)} per guest, everything included"`;
    `'guest_min'` → `"priced at our {min_billed_guests}-guest minimum"`;
    `'dollar_min'` → `"{fmt(min_total)} minimum for smaller events"`;
    tier rows → `"{fmt(per_guest_rate)} per guest, on top of bar service"`;
    the bar-service-only row → `"flat service rate, you supply the alcohol"`.
  - `openState(ladder)` → `{ expanded: boolean }`: expanded when the anchor is not a BYOB configuration (hosted, mocktail, retired, unmapped).
  - `POPULAR_EXTRA_SLUGS` from `popularExtras.js`: `['champagne-toast', 'house-made-ginger-beer', 'real-glassware', 'garnish-package-only']` (curated, spec Extras section).
- Consumes: the mini-lane's option/tier fields (Interfaces, lane 1 Tasks 1-2).

- [ ] **Step 1: Write `ladder.test.js` first** (plain jest, no React): lane mapping for each `bar_type`; Clear Reaction in `sideways` and suppressed when current; anchor resolution for a BYOB client on The Formula (anchor is the Formula tier row, `byobRungs` excludes it); a hosted client's anchor is the option row and all four tier rows are rungs; `unmapped` catches an unknown `bar_type`; `openState` for BYOB vs hosted vs mocktail-current; every `sublineFor` case including the small-event pair.
- [ ] **Step 2: Implement `ladder.js` + `popularExtras.js`;** run `cd client && CI=true npm test -- --testPathPattern=ladder`.
- [ ] **Step 3: Catalog entries.** Pull the real contents: `SELECT slug, name, description, includes FROM service_packages WHERE slug IN ('the-refined-reaction','the-clear-reaction')` against the dev DB; map `includes` into `sections` using the existing entries' heading conventions (`bucketFor` maps headings to the four buckets, so use catalog-style headings: Beer & Wine, Non-Alcoholic, Mixers & Extras). Match the file's tagline/description voice; items may carry the `Name – text` en-dash form the file already uses (`itemName` splits on it). Verify `bucketsForSlug('the-refined-reaction')` and `('the-clear-reaction')` return non-null in a quick jest assertion added to `ladder.test.js`.
- [ ] **Step 4: Commit** (explicit paths).

### Task 2: Drawer chrome + entry block + mailto retirement

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`
- Modify: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`
- Modify: `client/src/index.css`

**Interfaces:**
- Produces: `OtherOptionsPanel` renders as a drawer (`role="dialog"`, `aria-modal`, focus trap, Esc closes, focus returns to the entry element). Mobile <1024px: bottom sheet, drag-handle pointer events, snap points peek `min(66vh, 600px)` / full `96vh`, `transition:height 0.26s ease` suppressed while dragging, body scroll locked while open, list scrollable only in full. Desktop: right panel `min(432px, 94vw)`, no backdrop. Skeleton rows under the anchor while the first quote loads. Panel stays MOUNTED once opened (hide, not unmount), preserving quote state across close/reopen.
- Consumes: `options_available` on the public payload (lane 1 + mini-lane Task 3).

- [ ] **Step 1: Entry block** in `ProposalPricingBreakdown.js` below the pricing tfoot: the artifact's amber link card, locked copy `"Want us to handle more of this? See every option, priced for your night"` + subline `"From bar service only up to a fully stocked bar: switch any time before you sign."`, rendered only when `proposal.options_available` and not `signedThisSession` (passed down). It calls an `onOpenOptions` prop.
- [ ] **Step 2: `ProposalView.js`:** replace `showOptions` with `drawerOpen`; delete the bottom button block and the panel mount at the page bottom (:683-686); mount the drawer at the page root; delete `handleWantOption` and its DELIBERATE-SEAM comment block (:300-323). Entry + drawer hide client-side on any non-payable state including a same-session sign; server refusals stay the backstop.
- [ ] **Step 3: Drawer chrome in `OtherOptionsPanel.js` + `.oo-*` CSS in `index.css`:** header (kicker `"Your proposal · a second look"`, headline `"How much should we handle?"` with `we` in `<em>`, close button, event line + `", none of this changes."` suffix, insurance line `"Every option includes our $2 million liquor liability insurance."`), the sheet/panel mechanics above, skeletons. `eventLine` composes guests · hours · bars · date ONLY (spec: staffing never appears). Keep `load`/`reQuote`/`reqRef`/keep-last-good untouched.
- [ ] **Step 4: Gate:** `cd client && CI=true npx react-scripts build`; eyeball at phone width via the dev server. Commit.

### Task 3: Anchor + rungs + lanes + contents

**Files:**
- Modify: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`
- Modify: `client/src/index.css`

**Interfaces:**
- Produces: the ladder body per the Visual contract: sticky anchor row ("Yours" pill, ellipsized name, tabular-nums total); `byobRungs` as flat hairline rows; the break rule (`"From here, we bring the alcohol too"`) with expand CTA (`"Let us stock the whole bar"`) rendered only when a hosted lane has at least one available option; lane accordions (Full bar open, Beer & wine collapsed once expanded); `sideways` as the dashed Clear Reaction card (kicker `"Sideways, not up · zero proof"`, full rung otherwise, no delta); `unmapped` in a plain trailing group plus a `Sentry.addBreadcrumb` (via `@sentry/react`) when `unmapped.length > 0` or a lane assembles empty. Rung rows: name + total, description (payload), delta vs the anchor total (`"{fmt} more than yours"` / `"less than yours"` / `"same as yours"`, neutral color), `sublineFor` line, contents toggle (`"what's included? ↓"` / `"hide what's included ↑"`) rendering `bucketsForSlug` buckets for hosted rungs and `BUNDLE_INCLUDED`-derived `covers` for tiers.
- Consumes: `buildLadder`, `sublineFor`, `openState` (Task 1); pick/compare state, `CompareTable` import, and the pinned tray are REMOVED from the render path here (file deletion happens in Task 7).

- [ ] **Step 1:** Build the ladder render from `buildLadder(data)`; wire `openState` for the initial expanded flag; remove `picked`/`togglePick`/`pickedCols`/tray/`CompareTable` usage.
- [ ] **Step 2:** Deltas compute off the ANCHOR total (the drawer's displayed current total, draft-aware after Task 4), cents-compared for the zero case.
- [ ] **Step 3:** Gate build; visual pass against the artifact side by side. Commit.

### Task 4: Scoped extras strip with draft semantics

**Files:**
- Modify: `client/src/pages/proposal/otherOptions/ExtrasPanel.js`
- Modify: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`
- Modify: `client/src/index.css`

**Interfaces:**
- Produces: the strip scopes to the ANCHOR configuration (spec: rungs are commit-only, no selection state). Visibility: hosted anchor → the anchor option's `visible_extra_ids`; BYOB anchor → `filterAddons({ addons: data.extras-joined-catalog…, isHosted: false, packageCategory: 'byob', addonIds: draft + tier id, guestCount })`.visibleAddons from the client twin. Draft state: `draft` (array of addon ids) seeded from the committed extras (chips for committed extras start ON); `dirty` = extras-SET inequality, `[...draft].sort().join(',') !== [...committed].sort().join(',')`, never a total comparison; every re-quote POSTs the draft; committed state never mutates until a commit lands. Collapsed summary row by default; expanded shows POPULAR chips then the categorized full à la carte behind its own toggle. Blocked rows (BYOB anchor with a tier): from `isIncludedMap` → `"included in {bundle}"`; from `isUnavailableMap`, pointing up (the slug is in a HIGHER bundle's `BUNDLE_INCLUDED`) → `"comes with {that bundle}"`; otherwise → `"covered by {current bundle}"`. Blocked rows render dimmed, no toggle.
- Consumes: `visible_extra_ids` (mini-lane Task 2), `filterAddons` + bundle maps (client twin), `POPULAR_EXTRA_SLUGS` (Task 1).

- [ ] **Step 1:** Rework `ExtrasPanel` props to `{ extras, blocked, hours, onToggle, collapsed, onExpand }`; keep `rateLabel` exactly (it already covers every billing_type honestly).
- [ ] **Step 2:** Draft plumbing in `OtherOptionsPanel`: seed on first quote, `toggleExtra` writes the draft only, re-quote debounce unchanged, chips disabled while a re-quote is in flight (`oo-busy`).
- [ ] **Step 3:** The bundle-direction resolver:

```js
// Blocked-row copy, three cases (spec Extras section). "Up" = the slug rides a
// higher bundle's BUNDLE_INCLUDED; everything else unavailable is subsumed by
// the current bundle (signature mixers under full mixers) and must never point
// at a cheaper tier.
const blockedReason = (slug, currentBundleSlug, bundleNames) => {
  const order = BYOB_BUNDLE_SLUGS; // foundation -> formula -> full-compound
  const cur = order.indexOf(currentBundleSlug);
  const higherWithIt = order.slice(cur + 1).find(b => (BUNDLE_INCLUDED[b] || []).includes(slug));
  if ((BUNDLE_INCLUDED[currentBundleSlug] || []).includes(slug)) return `included in ${bundleNames[currentBundleSlug]}`;
  if (higherWithIt) return `comes with ${bundleNames[higherWithIt]}`;
  return `covered by ${bundleNames[currentBundleSlug]}`;
};
```

- [ ] **Step 4:** Gate build; commit.

### Task 5: Commit, reprice, drop + absorption, landed banner, undo

**Files:**
- Modify: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`
- Modify: `client/src/index.css`

**Interfaces:**
- Produces:
  - Rung commit: `"Make this my proposal"` → POST `/api/proposals/t/:token/switch` with `{ package_id, tier_addon_id, extra_addon_ids: draft, acknowledged_total }` (the row's displayed total). Inflight `"Rewriting…"`, button dead, double-tap blocked.
  - Anchor commit (dirty draft): `"Add these to my proposal"` (additive) / `"Update my extras"` (any removal), ack = displayed anchor total, same POST with the anchor's own package/tier.
  - 409: the acting row swaps to the reprice card (`"Prices moved"` / `"This now totals {new}, it was {old} a moment ago. Nothing has been committed yet."` / `"Confirm at {new}"`); drawer adopts the 409 body's fresh quote. Non-409 refusal: plain error note in the acting row, drawer open, nothing committed.
  - Pre-switch confirm (`"Before we switch"`): lists dropped extras (target's `dropped` + drafted extras absent from the target's visibility) AND absorbed ones from the client twin's `BUNDLE_COVERED` (`"{item} is included in {bundle}, so it comes off as its own line."`); `"Switch & drop it"` / `"Keep what I have"`.
  - Landed: drawer closes; page adopts the response payload; banner (`"Rewritten just now"` / `"Your proposal now reads {name}."`) with the extras-only note ONLY when `Math.round(newTotal*100) - Math.round(oldTotal*100)` equals the cents sum of the drafted extras' line-total delta, else the rung note + `"Prices were also updated since your original quote."`; dropped/absorbed sentence appended when applicable; Total row flashes; drawer state re-seeds from the new committed extras.
  - Undo (`"Undo · back to {name}"`): captured at land time as `undoTo = { package_id, tier_addon_id, extra_addon_ids, acknowledged_total: priorCommittedTotal }` (the proposal total BEFORE the commit, never a re-quote). Fires the same POST. On 409: drawer REOPENS with the prior configuration's row in reprice state. On guard refusal: banner swaps to `"We could not switch you back automatically. Reply to your proposal email and we will restore it."`, undo link removed. One level; a new commit replaces `undoTo`. Component state only (refresh drops it).
  - Stripe secret invalidation + refetch and gratuity reseed ride the existing `ProposalView` patterns (secret debounce effect, `gratuityDirty` reset); drawer quote state persists to sessionStorage keyed on `proposal.updated_at`.
- Consumes: everything above; the switch endpoint contract from the 8/14 spec (unchanged).

- [ ] **Step 1:** Commit state machine (`commit = { rowKey, phase: 'confirm-drop' | 'inflight' | 'repriced' }`) + POST wiring, cents-compare helper, per-row rendering of the three states.
- [ ] **Step 2:** Landed banner + undo in `ProposalView.js` (banner lives on the page, not the drawer), payload adoption, total flash, sessionStorage seed/invalidate.
- [ ] **Step 3:** Undo failure paths exactly as the Interfaces block; lost-response timeout refetches GET `/t/:token` to reconcile.
- [ ] **Step 4:** Gate build; walk every state on the dev server against the artifact. Commit.

### Task 6: RTL behavior suite

**Files:**
- Create/extend: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.test.js`

**Interfaces:**
- Consumes: axios mocked at module level (jest.mock), fixture payloads built to the mini-lane contract.

- [ ] **Step 1:** Write the suite owning the spec's Testing > Client list, one test per clause, in this order: ladder assembly + unmapped breadcrumb; open states (BYOB / hosted / Clear-current / retired); expand-line absence; draft isolation + chip seeding + set-inequality dirty + removal relabel; re-quote against draft; anchor dirty flow; three blocked-row strings; absorption line; guest_min + dollar_min sublines; drop-confirm; banner variants (delta-gated extras-only, drift addendum, dropped sentence); undo (prior-total ack, single restore, 409 reopen, refusal banner); entry absence (`options_available` false, same-session sign); reprice re-tap; non-409 refusal; first-load error + retry; chips disabled mid-quote; sequencing under a chip burst (two overlapping re-quotes, late response discarded); lost-response refetch; focus trap + Esc.
- [ ] **Step 2:** `cd client && CI=true npm test -- --testPathPattern=OtherOptionsPanel`. Fix until green. Commit.

### Task 7: Retirement, fidelity pass, docs, lane gate

**Files:**
- Delete: `client/src/pages/proposal/otherOptions/CompareTable.js`
- Modify: `client/src/index.css` (dead `.oo-*` rules for pick/tray/compare)
- Modify: `README.md` (folder tree: CompareTable removed, ladder.js + popularExtras.js added)

- [ ] **Step 1:** Delete `CompareTable.js`, strip dead imports and dead CSS, grep `oo-tray|oo-pick|CompareTable` to zero.
- [ ] **Step 2: Fidelity pass (this lane owns the Visual contract):** pull the live artifact via DesignSync (`list_files` → `get_file "Proposal Other Options.dc.html"` from project 90a2308b-2b69-49e3-8586-4cfdf4f54cab), diff its current state against the vendored copy (drift check), then walk the built surface against it screen by screen per the Visual contract, honoring the 7 named deviations. Record the walk's result in the lane's final commit message.
- [ ] **Step 3:** README tree update; full client suite `cd client && CI=true npm test`; build gate; commit. Lane ready for its fleet (ui-ux-review judged against the artifact) + merge.

---

## Post-merge (push time, not lane time)

- Push hold: both lanes merged + fleets clean, THEN the batch pushes with the full money-path treatment (fleet + /second-opinion) per the spec's Sequencing.
- Launch checks from the spec: Walk Test Package absent from prod catalog (re-verify), drink-plan flip preview, bundle-config twin parity check.
- Owed walkthrough entry: Dallas's real-device walk of the drawer (add to `docs/walkthroughs-owed.md` at push, not before).
