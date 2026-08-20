# Proposal page: the options ladder

Date: 2026-08-20
Status: approved (brainstormed with Dallas across the 2026-08-20 session; every decision below was settled conversationally, with three design-tool iterations in between). Spec-fleet findings folded same day: 2 blockers and 11 warnings resolved below; one grounding finding rejected on re-verification (the mobile sheet numbers ARE in the vendored artifact).
Amends: `2026-08-14-proposal-options-drawer-design.md`. That spec's SERVER sections stand as built (lane oo-switch-server, 8 commits, tip 38c5a363, unmerged as of this writing); its CLIENT sections (decisions 1 through 8, "Client work", the client test list) are superseded by this document. Its money rules, guard matrix, and switch-endpoint behavior are inherited unchanged and are not restated here. The client behaviors it marked load-bearing are RE-INHERITED explicitly in "Re-inherited client behaviors" below; superseding the sections does not shed them.
Design source: claude.ai/design project 90a2308b-2b69-49e3-8586-4cfdf4f54cab, file `Proposal Other Options.dc.html` (the 2026-08-20 revision with the anchor-commit and draft-extras mechanics). Vendored verbatim at `docs/design-artifacts/2026-08-20-proposal-options-ladder.dc.html`. The Visual contract section below is the binding translation; the vendored file alone is provenance, not the contract.

## Context: why the drawer got re-aimed

The 8/14 spec framed the surface as package switching. Prod says that is the 12% case: since June 1, 271 proposals went out on The Core Reaction (BYOB, bar service only) against 36 on all hosted packages combined, and the add-on attach rate on those 271 is close to nil (about 38 addon rows across ~307 proposals). What clients actually ask, in Dallas's words: they don't want a new package, they want to change their options, or at least see them, and often want to know what it costs for DrB to provide everything.

So the drawer becomes one ladder: a single spectrum of how much Dr. Bartender handles, from bare bar service up to a fully stocked bar. Same event, same date, same guest count on every rung; the only thing that changes is how much we take off the client's hands. The catalog already reads this way, and the bundles are supersets in effect (`BUNDLE_INCLUDED` in `server/utils/proposalRules.js`; The Full Compound carries full mixers rather than signature mixers, with `BUNDLE_UNAVAILABLE` encoding the subsumption), so the ladder is real, not a marketing frame.

The 8/14 spec's "nobody has used the panel yet" claim is retired as an argument; the panel has been in front of real clients since 8/11 (98 client `viewed` rows since then). Nothing in this spec leans on it.

## The ladder

Rungs, in order, each priced for the client's real event through the engine:

1. **Bar service only**: The Core Reaction, no tier. Where most clients start.
2. **The Foundation**: $3/guest tier addon, ice delivery, bottled water service, premium cups, cocktail napkins.
3. **The Formula**: $5.50, that plus signature-cocktail mixers, basic garnishes, simple syrup and bitters.
4. **The Full Compound**: $8, that plus the complete mixer selection and the premium garnish package.
5. The break: "From here, we bring the alcohol too"
6. **Beer & wine lane** (collapsible): Primary Culture, Refined Reaction, Carbon Suspension, Cultivated Complex.
7. **Full bar lane** (collapsible): Base Compound, Midrange Reaction, Enhanced Solution, Formula No. 5, Grand Experiment.

The first three rungs above bar-service-only are the SAME package with a different tier addon; the hosted rungs are different packages. The client never sees that distinction; to them it is one ladder. Server-side, both land on the same switch endpoint (tier moves are the same-package flow `publicSwitch.js` already treats as first class).

**Lane identity is data, never slugs.** Lane placement (Beer & wine vs Full bar) and zero-proof detection come from a `bar_type` field the mini-lane adds to every option entry (see Server deltas); the client hard-codes no package lists. An option whose `bar_type` the ladder does not recognize, or a lane that assembles empty, renders in a catch-all position AND drops a client-side Sentry breadcrumb, so a catalog edit is never a silent layout change on a money surface.

**The Clear Reaction** (zero-alcohol) is sideways, not up. It renders after the hosted lanes as a dashed one-off card with the kicker "Sideways, not up · zero proof". It is a full rung in every other way: contents toggle, per-guest subline, and the commit CTA; only the delta line is suppressed. When it IS the client's current package it is the anchor and the sideways card is not rendered (no duplication).

**Rung identity**: BYOB rungs come from the quote payload's `tiers` array (plus the bar-service-only base); hosted rungs from `options`. The client component maps the existing payload into rungs; the only new quote plumbing is the additive display fields in Server deltas.

**Open state**: for a client on a BYOB configuration, the drawer opens with the anchor pinned at top, then the three BYOB steps, then one expand line ("Let us stock the whole bar →"); four rows on open, hosted expands in place. For any client NOT on a BYOB configuration (hosted, Clear Reaction, or a since-retired package, whose current package the options list always unions in), the drawer opens with the hosted block expanded and their lane open. Lane accordions once expanded: Full bar open by default, Beer & wine collapsed, per the artifact. The expand line renders only when at least one hosted option is available; it never opens an empty block.

**Rung contents** ("what's included? ↓") render from the real catalog via `catalogBuckets.js` for hosted rungs and from `BUNDLE_INCLUDED` names for BYOB rungs, exactly as the shipped panel does. Deliverable: `client/src/data/packages.js` is missing `the-refined-reaction` and `the-clear-reaction`, so `bucketsForSlug` returns null and their contents section would silently not render; the client lane adds both entries. The artifact's inline spirit lists and its BYOB `brings` arrays are placeholders; in particular the artifact still says "stir sticks" in three BYOB contents lines, and the built surface must not (straws/stir-sticks moved to available-on-request 2026-08-20, catalog is already correct, the artifact was deliberately left unedited).

**Rung descriptions** (the one-line "puts" text on each row) come from the payload: the mini-lane adds `description` to option entries (from `service_packages.description`) and to tier entries (from `service_addons.description`). No hand-written client copy per package.

## Form factor

Unchanged from 8/14 decision 2, restated as the artifact renders it:

- Entry: quiet link block in the pricing section (the artifact's "Want us to handle more of this? See every option, priced for your night →" with its subline). Bottom-of-page button and panel mount removed. Renders only when `options_available`.
- Mobile (<1024px): bottom sheet, drag handle, two snap points (peek = min(66vh, 600px), full = 96vh, both verified present in the artifact's sheet logic), body scroll locked while open, list internally scrollable in full state.
- Desktop: right-side panel (min(432px, 94vw)), no dimmed backdrop, proposal and sticky sign rail stay visible.
- Dialog semantics, focus trap, Esc closes, focus returns to entry link, `role="status"` live region. Loading = skeleton rows under the anchor.

## Extras

The extras strip lives at the bottom of the drawer, collapsed by default to a summary line, expandable to category groups (popular chips first, "the full à la carte" behind its own toggle). "Popular" membership is a curated client-side constant of addon slugs (a small module beside `catalogBuckets.js`, seeded from the artifact's four: champagne toast, ginger beer, real glassware, garnish package) plus any extra already committed or drafted; it is a deliverable, not a payload field.

**Scoped to the current rung.** There is no rung "selection" state; rung rows are commit-only. The strip scopes to the ANCHOR, the client's current committed configuration: only extras the visibility rules admit there are toggleable, and the framing is "add to your package," never "add to every option." When a commit lands on a new rung, the strip re-scopes. The artifact's "add to any option above" heading and its "BYOB rungs only"/"hosted rungs only" annotations are superseded by this rule (deviation, named below). Scoping data: the server's per-option visibility (Server deltas) covers hosted rungs; across the three BYOB tier rungs visibility is selection-dependent (`visibleAddonsFor` gates e.g. mocktail-bar on Formula-or-higher), so the client twin (`client/src/utils/proposalRules.js`) owns BYOB-side scoping. Both recompute on every re-quote against the current draft; nothing is cached per proposal.

**Draft semantics.** Extras toggles accumulate in a client-side draft; nothing is written and the proposal's own displayed total never moves. Chips for already-committed extras start ON. Dirty detection is extras-SET inequality against the committed set, never a total comparison (once any body is sent, the contract echo is off and catalog drift alone can move the re-quoted total). Every rung total, the anchor total included, re-quotes against the draft, so comparisons stay like for like. This is the artifact's `draft` mechanic and it preserves the browsing-writes-nothing law.

**Bundle conflicts.** An à la carte supply item that intersects the current BYOB bundle renders as a visible-but-blocked row, never a toggle, with the reason:

- Covered by the bundle (`BUNDLE_INCLUDED`): locked pattern "included in {bundle name}".
- Blocked by `BUNDLE_UNAVAILABLE`, pointing UP (the item rides a higher bundle's `BUNDLE_INCLUDED`, e.g. Full Mixers on The Formula): locked pattern "comes with {that bundle}", a ladder nudge.
- Blocked by `BUNDLE_UNAVAILABLE`, pointing DOWN (the item is subsumed by the current bundle, e.g. Signature Mixers on The Full Compound, whose full mixers cover them): locked pattern "covered by {current bundle}". Never a pointer to a cheaper tier.

The client twin of the bundle config is the data source; no server change needed, and the server independently enforces via `stripIncludedAddons` inside `priceProposedState`, so a crafted POST cannot double-charge.

**Bundle absorption on a rung move is surfaced, not silent.** `stripIncludedAddons` strips covered extras before pricing, so they never reach the quote's `dropped` list; the pre-switch confirm therefore ALSO lists, from the client twin's `BUNDLE_COVERED`, any committed or drafted à la carte item the target bundle covers: "{item} is included in {bundle}, so it comes off as its own line." Distinct from the dropped (not-offered) case; both render in the same "Before we switch" card.

**Incompatible extras on a rung move.** Unchanged from 8/14: a drafted extra that cannot ride to the target rung surfaces in the pre-switch confirm ("Before we switch" card, "Switch & drop it" / "Keep what I have"), never silently.

## The anchor, and extras-only commits

The anchor row ("Yours" pill, name, total) pins above the rung list. When the extras draft differs from the proposal's committed extras, the anchor goes dirty: note "quoted with your extras, not on your proposal yet" and a commit button, **"Add these to my proposal"** when the draft only adds, **"Update my extras"** when it removes anything. That commit is the same-package branch of the switch endpoint, sending `acknowledged_total` = the displayed anchor total; it carries the anchor's own inflight and repriced states, identical in behavior to a rung commit. This is the most-asked flow (add glassware, add a toast, step a tier) and it must be reachable without changing packages.

## Pricing display

- Every number renders from the quote endpoint. The artifact's rates and totals are placeholders; two are already stale.
- **Per-guest subline is server-derived**, not client-computed. The engine prices small events (<50 guests) on the `_small` rate columns with a per-package billing minimum and dollar floor, so a client-side `rate × guests` line lies to 53 of the last 307 proposals.
- **Three display rules, keyed on the payload's `priced_by`** (Dallas approved the floor recommendation; the fleet added the guest_min case and un-hardcoded the amounts):
  - `rate`: the real per-guest rate actually charged ("$17.00 per guest, everything included" for a 30-guest client).
  - `guest_min`: "priced at our {min_billed_guests}-guest minimum", the count from the payload; never per-guest arithmetic the client can disprove against their own headcount.
  - `dollar_min`: "{min_total} minimum for smaller events", the amount from the payload. The floor is per-package data (`pkg.min_total`), never a hardcoded $550.
- BYOB sublines: tier rungs show "{rate} per guest, on top of bar service"; bar-service-only shows "flat service rate, you supply the alcohol".
- Deltas against the anchor total stay the hero, neutral color (no green, no sage), "same as yours" at zero. The Clear Reaction card shows none.
- **`eventLine` is pinned to guests · hours · bars · date and nothing else.** Staffing never appears in it, so the "none of this changes." claim stays structurally true even the day a package with a different bartender ratio enters the catalog (a cross-ratio rung move re-deriving `num_bartenders` is correct per 8/14 and must not be contradicted by copy).

## Commit, reprice, drop, land, undo

- Rung CTA: **"Make this my proposal"** (supersedes the 8/14 locked "Switch to this package."). Inflight: "Rewriting…" with the button dead.
- Price-moved (the switch 409): the card swaps to "Prices moved / This now totals {new}, it was {old} a moment ago. Nothing has been committed yet. / Confirm at {new}". "A moment ago" rather than "when you opened this" because the same card serves rung, anchor, and undo conflicts, where {old} is the last displayed total, not an open-time total. The drawer adopts the 409 body's fresh quote. (Supersedes the 8/14 "Prices were updated, take another look." line.)
- Landed: drawer closes, page adopts the returned payload, banner at top: "Rewritten just now / Your proposal now reads {name}." with a note, plus the dropped/absorbed sentence when applicable. Total row flashes. **The extras-only note ("Same package, same {eventLine}, only your extras changed.") renders only when the total moved by exactly the drafted extras' delta (cents compare);** otherwise, including an extras-only commit that landed on freshly deployed pricing, the note is the rung-move line ("Same {eventLine}, nothing else about the night moved.") plus "Prices were also updated since your original quote."
- **Undo** ("Undo · back to {name}"): steps back exactly one commit, restoring the prior rung AND the prior extras (dropped and absorbed ones included). It is a second real switch carrying the prior configuration, so every server guard, the audit row, intent cancellation, and idempotent replay apply; the server re-validates every restored extra exactly as it validates any switch body.
  - **`acknowledged_total` on undo is the prior committed total** (the total the proposal carried before the commit being undone), captured client-side at land time. Never a fresh re-quote: re-quoting first and acknowledging the new number would silently commit a price the banner never promised.
  - **Failure surface**: undo lives in the banner with the drawer closed, so on a 409 the drawer REOPENS anchored to current state with the prior configuration's row in its reprice state ("Confirm at {new}"); a 409 here is a real case, since the pre-switch total was a contract echo an engine re-price can legitimately fail to reproduce. On a guard refusal (paid meanwhile, signed in a second tab, or the prior package deactivated, which fails the offered-package guard because only the CURRENT package is unioned into the options), the banner swaps to "We could not switch you back automatically. Reply to your proposal email and we will restore it." and the undo link is removed. The audit row from the original switch preserves what the configuration was.
  - One level only; a second commit replaces the undo target. Client component state only: a refresh drops the banner and undo, which is acceptable because the proposal page shows truth and the audit trail preserves history.
- Stripe intent invalidation, gratuity reseed, sessionStorage keyed on `updated_at`, lost-response refetch: all unchanged from 8/14.

## Re-inherited client behaviors

Superseding the 8/14 client sections does not shed these; the drawer keeps them exactly:

- The debounced re-quote, the request-sequencing ref, and keep-last-good-data error handling in `OtherOptionsPanel.js` are load-bearing and survive the rewrite unchanged. The draft mechanic makes stale-response ordering MORE likely (chip toggles burst), so the sequencing ref is not optional.
- First-load quote failure: error banner with "Try again" (the shipped `.oo-error` pattern), inside the open drawer.
- `comparable: false` or fewer than two distinct options: the entry link should already be absent (`options_available`), but a drawer that is open when a re-quote comes back non-comparable shows the error banner, never a blank ladder.
- Extras toggles disabled while a re-quote is in flight (`oo-busy` pattern), so a chip burst cannot interleave with a commit.
- A non-409 switch refusal (guard 4xx) renders as a plain error note in the acting row, drawer stays open, nothing committed.
- Entry link and drawer hide client-side on any non-payable state including a same-session sign, server refusals as backstop only.

## Server deltas (small, after lane 1 merges)

Lane oo-switch-server is NOT reopened; it gets its fleet re-run against current main and merges as is. One follow-on server mini-lane touching `publicOptions.js`, `publicToken.js`, and the shared module where cleaner:

1. **`bar_type` on every option entry.** The lane discriminator: `beer_and_wine` / `full_bar` / `mocktail` / `service_only` straight off `service_packages.bar_type`. Without it the ladder has no data path for lane placement or Clear Reaction identity.
2. **`description` on option entries** (`service_packages.description`) **and tier entries** (`service_addons.description`), the rung rows' one-liners.
3. **Pricing display fields** per option and per tier: `priced_by` (`'rate' | 'guest_min' | 'dollar_min'`, derivable from the engine's `floor_reason` at `pricingEngine.js:373/605`), the per-guest rate actually charged, `min_billed_guests`, and `min_total`, so the client renders the three subline rules without re-deriving prices.
4. **Per-option `visible_extra_ids` for hosted options**, recomputed on every request against the submitted extras (visibility is selection-dependent: `requires_addon_slug` parents, the mocktail-bar tier gate), never cached per proposal. BYOB-side scoping stays with the client twin per the Extras section.
5. **`options_available` gains the `amount_paid = 0` check** the switch already enforces (amending lane 1's predicate in `publicToken.js` post-merge). Without it, a force-rewound or external-paid row with money on `sent`/`viewed` renders the entry card into a guaranteed refusal.
6. **Observability**: Sentry capture when one token lands N successful switches in a short window, alongside lane 1's 409-storm capture. Multi-commit sessions are now the designed norm, so a leaked token grinding SUCCESSFUL switches with correct ack totals would otherwise be silent (audit-log growth, invoice churn, intent churn).

All additive response fields; nothing existing changes shape. `publicOptions.js` and `publicToken.js` are sensitive-listed, so the mini-lane takes the standard sensitive-path review.

## Client footprint

For the docs table and the plan's lane map: `client/src/pages/proposal/proposalView/ProposalView.js` (entry state, banner, undo), `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` (entry block), `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js` (becomes the drawer body), `client/src/pages/proposal/otherOptions/CompareTable.js` (DELETED, lands in the README folder tree), `client/src/pages/proposal/otherOptions/ExtrasPanel.js` (reworked into the scoped strip), `client/src/index.css` (drawer CSS), `client/src/data/packages.js` (two missing package entries), a new popular-chips constant beside `catalogBuckets.js`, and the client bundle-config twin consumed read-only.

## Visual contract

Benchmark artifact: `docs/design-artifacts/2026-08-20-proposal-options-ladder.dc.html` (vendored verbatim from the design project). A named lane (the plan's client lane) owns fidelity to it and pulls the artifact via DesignSync at build time; ui-ux-review judges the built surface against it as the primary benchmark, modulo the named deviations below.

Per-screen contract:

- **Entry block**: full-width link card in the pricing section below the totals, amber-accented, headline + italic subline, arrow affordance. Not a bare text link.
- **Drawer chrome**: dark surface (#0e1218 family) with brass border and the Apothecary tokens; kicker "Your proposal · a second look", display-serif headline "How much should we handle?" with "we" italicized, close button top-right, event line + insurance line under the header.
- **Anchor row**: sticky under the header, amber left border, "Yours" pill, name ellipsized, tabular-nums total right-aligned; dirty note + amber commit button appear inside the anchor when the draft is dirty; anchor carries its own inflight spinner and "Prices moved" card.
- **Rung rows**: flat list rows (not cards) separated by hairlines: name + total on the first line, description, delta line, per-guest subline with the contents toggle inline; amber "Make this my proposal" button right-aligned; inflight/repriced/drop states swap in place within the row. Clear Reaction: dashed-border card, kicker, after the lanes.
- **Break + lanes**: a labeled rule ("From here, we bring the alcohol too") with the expand CTA when collapsed; lane headers with count/hide toggles.
- **Extras strip**: collapsed summary row at the bottom; expanded state shows popular chips then categorized full à la carte with per-item price and unit label; blocked rows render dimmed with their reason string, no toggle.
- **Landed banner**: top of the proposal page, brass-bordered, "Rewritten just now" kicker, name bolded, undo link.
- **Mobile**: bottom sheet with centered drag handle, snap animation ~260ms ease, spring disabled while dragging. (Peek/full heights and the transition are in the artifact's sheet logic; the fleet's contrary finding was checked and rejected.)

Token translation rule: the artifact's inline styles reference the Apothecary design-system tokens (`--brass`, `--amber`, `--cream-text`, `--chalkboard`, `--font-display`, `--font-body`). The proposal page already renders under these tokens via `index.css`; the lane translates inline styles into `.oo-*` classes in `index.css`, reusing the shipped `.oo-*` vocabulary where a class already fits and keeping the artifact's spacing, hierarchy, and states. No new fonts, no new colors outside the token set.

Named deviations from the artifact (deliberate, decided in this session and the fleet pass):

1. Extras are scoped to the current rung; the artifact's "add to any option above" heading and lane annotations are replaced accordingly.
2. Blocked à la carte rows (bundle conflicts, three copy cases) exist only in this contract, not the artifact.
3. The `priced_by` sublines (guest_min and dollar_min cases) exist only in this contract.
4. Rung contents, descriptions, and BYOB `brings` lists come from the catalog/payload; the artifact's inline lists (including its three "stir sticks" mentions) are placeholders.
5. All prices come from the quote endpoint; the artifact's numbers are placeholders.
6. Copy dashes are normalized to house style: no em dashes in client copy; commas or colons instead (e.g. "quoted with your extras, not on your proposal yet").
7. The absorption line in the pre-switch confirm, the undo failure surface (drawer reopen / banner swap), and the removal-draft button label exist only in this contract.

## Copy (locked, used verbatim)

- Entry headline: "Want us to handle more of this? See every option, priced for your night" · subline: "From bar service only up to a fully stocked bar: switch any time before you sign."
- Drawer headline: "How much should we handle?" · kicker: "Your proposal · a second look" · event line suffix: ", none of this changes." · insurance line: "Every option includes our $2 million liquor liability insurance."
- Anchor dirty note: "quoted with your extras, not on your proposal yet" · anchor commit: "Add these to my proposal" (additive draft) / "Update my extras" (draft removes anything)
- Rung commit: "Make this my proposal" · inflight: "Rewriting…"
- Reprice card: "Prices moved" / "This now totals {new}, it was {old} a moment ago. Nothing has been committed yet." / "Confirm at {new}"
- Drop card: "Before we switch" / "Switch & drop it" / "Keep what I have" · absorption line: "{item} is included in {bundle}, so it comes off as its own line."
- Expand: "From here, we bring the alcohol too" / "Let us stock the whole bar"
- Clear Reaction kicker: "Sideways, not up · zero proof"
- Blocked extras: "included in {bundle}" / "comes with {bundle}" / "covered by {bundle}"
- Price sublines: "{rate} per guest, everything included" (hosted, rate) / "priced at our {N}-guest minimum" (guest_min) / "{amount} minimum for smaller events" (dollar_min) / "{rate} per guest, on top of bar service" (tier) / "flat service rate, you supply the alcohol" (bar service only)
- Banner: "Rewritten just now" / "Your proposal now reads {name}." / "Undo · back to {name}" / extras-only note (delta-verified only): "Same package, same {eventLine}, only your extras changed." / rung note: "Same {eventLine}, nothing else about the night moved." / drift addendum: "Prices were also updated since your original quote." / undo failure: "We could not switch you back automatically. Reply to your proposal email and we will restore it."
- Deltas: "{amount} more than yours" / "{amount} less than yours" / "same as yours"

## Out of scope (this pass)

Unchanged from 8/14: analytics, admin notification (audit row ships), compare-group flow, guaranteed switch-back beyond the one-step undo. Additionally: the signature-mixers shopping-list coverage deferral stays deferred (see `shoppingListAddonCoverage.js` header), and add-ons as a surface near the signature stays out.

## Sequencing and the push hold

1. Fleet re-run on oo-switch-server against current main (stale since 8/14, 93+ commits underneath, two sensitive-listed files), then merge. Findings go to Dallas, fix-now or push-anyway, per the standing rule.
2. Server-delta mini-lane (items 1 through 6 above).
3. Client ladder lane, built to this spec and the Visual contract.
4. **Push hold (Dallas, 2026-08-20): lane 1's price change goes with the drawer.** Lane 1 may merge whenever; nothing pushes until the client lane is in. Push takes the full money-path treatment: fleet plus cross-LLM second opinion.

## Launch checks

- "Walk Test Package" is not in the prod catalog (verified 2026-08-20: 17 active packages, none named that; the options query also excludes `bar_type = 'class'`). Re-verify at ship anyway; it IS active in the dev DB.
- Drink-plan flip check from 8/14 stands: preview a drink plan against a proposal that switched hosted-to-BYOB or back.
- Verify the client bundle-config twin (`bundleConfig.js` / `client/src/utils/proposalRules.js`) matches `server/utils/proposalRules.js` before the blocked-row and absorption logic ship on it.

## Testing

Server mini-lane: `bar_type` and `description` present on every option/tier entry; `priced_by` correct across the rate/guest-min/dollar-min boundary (guest counts straddling 50 and each package's floor); `visible_extra_ids` matches `visibleAddonsFor` for a non-current package and recomputes when the submitted extras change (the mocktail-bar gate flips it); `options_available` false when `amount_paid > 0`; the landed-switch frequency capture fires; existing response fields byte-identical.

Client (RTL suite owns this list): ladder assembly from the quote payload keyed on `bar_type` (lanes, Clear Reaction placement, unmapped-type catch-all + breadcrumb); open state for a BYOB client vs hosted vs Clear-Reaction-current vs retired-package client; expand line absent when no hosted option is available; draft extras never mutate committed state, chips for committed extras start on, dirty = set inequality, removal-only draft relabels the button; every total re-quotes against the draft; anchor dirty flow (note, commit with displayed-total ack, inflight, repriced); blocked à la carte rows for each of the three copy cases with the right string; absorption line in the pre-switch confirm when the target bundle covers a committed item; floor sublines for guest_min and dollar_min from payload values; drop-confirm on an incompatible drafted extra; landed banner variants (extras-only gated on the cents-exact extras delta, rung move, drift addendum, dropped/absorbed sentence); undo sends the prior committed total as ack, restores extras exactly once, reopens the drawer to the reprice state on 409, swaps to the failure banner on a guard refusal; entry block absent when `options_available` is false and after a same-session sign; reprice re-tap flow; non-409 refusal rendering; first-load error + retry; extras disabled mid-re-quote; request-sequencing under a chip burst; lost-response refetch; sheet snap points and body scroll lock (mobile) vs side panel (desktop); focus trap and Esc; contents render for Refined Reaction and Clear Reaction (the two new catalog entries).
