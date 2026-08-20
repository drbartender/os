# Proposal page: the options ladder

Date: 2026-08-20
Status: approved (brainstormed with Dallas across the 2026-08-20 session; every decision below was settled conversationally, with three design-tool iterations in between)
Amends: `2026-08-14-proposal-options-drawer-design.md`. That spec's SERVER sections stand as built (lane oo-switch-server, 8 commits, tip 38c5a363, unmerged as of this writing); its CLIENT sections (decisions 1 through 8, "Client work", the client test list) are superseded by this document. Its money rules, guard matrix, and switch-endpoint behavior are inherited unchanged and are not restated here.
Design source: claude.ai/design project 90a2308b-2b69-49e3-8586-4cfdf4f54cab, file `Proposal Other Options.dc.html` (the 2026-08-20 revision with the anchor-commit and draft-extras mechanics). Vendored verbatim at `docs/design-artifacts/2026-08-20-proposal-options-ladder.dc.html`. The Visual contract section below is the binding translation; the vendored file alone is provenance, not the contract.

## Context: why the drawer got re-aimed

The 8/14 spec framed the surface as package switching. Prod says that is the 12% case: since June 1, 271 proposals went out on The Core Reaction (BYOB, bar service only) against 36 on all hosted packages combined, and the add-on attach rate on those 271 is close to nil (about 38 addon rows across ~307 proposals). What clients actually ask, in Dallas's words: they don't want a new package, they want to change their options, or at least see them, and often want to know what it costs for DrB to provide everything.

So the drawer becomes one ladder: a single spectrum of how much Dr. Bartender handles, from bare bar service up to a fully stocked bar. Same event, same date, same guest count on every rung; the only thing that changes is how much we take off the client's hands. The catalog already reads this way, and the bundles are strict supersets (`BUNDLE_INCLUDED` in `server/utils/proposalRules.js`), so the ladder is real, not a marketing frame.

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

**The Clear Reaction** (zero-alcohol, $14) is sideways, not up. It renders after the hosted lanes as a dashed one-off card with the kicker "Sideways, not up · zero proof", never as a rung, and shows no delta line.

**Rung identity**: BYOB rungs come from the quote payload's `tiers` array (plus the bar-service-only base); hosted rungs from `options`. The client component maps the existing payload into rungs; no new quote plumbing for the ladder shape itself.

**Open state**: the drawer opens with the client's current rung pinned at top as the anchor, then the three BYOB steps, then one expand line ("Let us stock the whole bar →"). Four rows on open; the hosted block expands in place. A client already on a hosted package opens with the hosted block expanded and their lane open. Lane accordions: Full bar open by default once expanded, Beer & wine collapsed, per the artifact.

**Rung contents** ("what's included? ↓") render from the real catalog via `catalogBuckets.js` for hosted rungs and from `BUNDLE_INCLUDED` names for BYOB rungs, exactly as the shipped panel does. The artifact's inline spirit lists and its BYOB `brings` arrays are placeholders; in particular the artifact still says "stir sticks" in three BYOB contents lines, and the built surface must not (straws/stir-sticks moved to available-on-request 2026-08-20, catalog is already correct, the artifact was deliberately left unedited).

## Form factor

Unchanged from 8/14 decision 2, restated as the artifact renders it:

- Entry: quiet link block in the pricing section (the artifact's "Want us to handle more of this? See every option, priced for your night →" with its subline). Bottom-of-page button and panel mount removed. Renders only when `options_available`.
- Mobile (<1024px): bottom sheet, drag handle, two snap points (peek = min(66vh, 600px), full = 96vh), body scroll locked while open, list internally scrollable in full state.
- Desktop: right-side panel (min(432px, 94vw)), no dimmed backdrop, proposal and sticky sign rail stay visible.
- Dialog semantics, focus trap, Esc closes, focus returns to entry link, `role="status"` live region. Loading = skeleton rows under the anchor.

## Extras

The extras strip lives at the bottom of the drawer, collapsed by default to a summary line, expandable to category groups (popular chips first, "the full à la carte" behind its own toggle).

**Scoped to the selected rung.** Only extras the server's visibility rules admit for the rung the client is standing on are listed; the framing is "add to your package," not "add to every option." Moving rungs re-renders the list. The artifact's "add to any option above" heading and its "BYOB rungs only"/"hosted rungs only" annotations are superseded by this rule (deviation, named below).

**Draft semantics.** Extras toggles accumulate in a client-side draft; nothing is written and the proposal's own displayed total never moves. Every rung total, the anchor total included, re-quotes against the draft, so comparisons stay like for like. This is the artifact's `draft` mechanic and it preserves the browsing-writes-nothing law.

**Bundle conflicts.** An à la carte supply item that intersects the selected BYOB bundle renders as a visible-but-blocked row, never a toggle, with the reason:

- Covered by the bundle (`BUNDLE_INCLUDED`): "included in The Foundation" (locked pattern: "included in {bundle name}").
- Deliberately not offered on this bundle (`BUNDLE_UNAVAILABLE`, e.g. Full Mixers on The Formula): "comes with The Full Compound" (locked pattern: "comes with {the bundle that has it}"), a ladder nudge, not a dead end.

The client twin of the bundle config (`client/src/utils/proposalRules.js` / `bundleConfig.js`) is the data source; no server change needed. The bundles already beat à la carte on price, so the surface offers bundles first and lets à la carte through without argument, per Dallas.

**Incompatible extras on a rung move.** Unchanged from 8/14: a drafted extra that cannot ride to the target rung surfaces in the pre-switch confirm ("Before we switch" card, "Switch & drop it" / "Keep what I have"), never silently.

## The anchor, and extras-only commits

The anchor row ("Yours" pill, name, total) pins above the rung list. When the extras draft differs from the proposal's committed extras, the anchor goes dirty: note "quoted with your extras, not on your proposal yet" and a button **"Add these to my proposal"**. That commit is the same-package branch of the switch endpoint; it carries the anchor's own inflight and repriced states, identical in behavior to a rung commit. This is the most-asked flow (add glassware, add a toast, step a tier) and it must be reachable without changing packages.

## Pricing display

- Every number renders from the quote endpoint. The artifact's rates and totals are placeholders; two are already stale.
- **Per-guest subline is server-derived**, not client-computed. The engine prices small events (<50 guests) on the `_small` rate columns with a 25-guest billing minimum and a $550 floor, so a client-side `rate4 × guests` line lies to 53 of the last 307 proposals.
- **Floor rule** (Dallas approved the recommendation): when the rate sets the price, show the real per-guest rate ("$17.00 per guest, everything included" for a 30-guest client). When the $550 minimum sets it, replace the per-guest line with "$550 minimum for smaller events"; never print effective per-head arithmetic driven by the floor.
- BYOB sublines: tier rungs show "{rate} per guest, on top of bar service"; bar-service-only shows "flat service rate, you supply the alcohol".
- Deltas against the anchor total stay the hero, neutral color (no green, no sage), "same as yours" at zero. The Clear Reaction card shows none.

## Commit, reprice, drop, land, undo

- Rung CTA: **"Make this my proposal"** (supersedes the 8/14 locked "Switch to this package."). Inflight: "Rewriting…" with the button dead.
- Price-moved (the switch 409): the card swaps to "Prices moved / This now totals {new}, it was {old} when you opened this. Nothing has been committed yet. / Confirm at {new}". The drawer adopts the 409 body's fresh quote. (Supersedes the 8/14 "Prices were updated, take another look." line.)
- Landed: drawer closes, page adopts the returned payload, banner at top: "Rewritten just now / Your proposal now reads {name}." with the note "Same package, same {eventLine}, only your extras changed." for extras-only commits or "Same {eventLine}, nothing else about the night moved." for rung moves, plus the dropped-extras sentence when applicable. Total row flashes.
- **Undo** ("Undo · back to {name}"): steps back exactly one commit, restoring the prior rung AND the prior extras (dropped ones included). It is a second real switch call carrying that prior configuration; the server needs no undo machinery and the same guards apply. One level only; a second commit replaces the undo target. Client component state only: a refresh drops the banner and undo, which is acceptable because the switch itself is idempotent and the proposal page shows truth.
- Stripe intent invalidation, gratuity reseed, sessionStorage keyed on `updated_at`, lost-response refetch: all unchanged from 8/14.

## Server deltas (small, after lane 1 merges)

Lane oo-switch-server is NOT reopened; it gets its fleet re-run against current main and merges as is. One follow-on server change, a sibling mini-lane touching `publicOptions.js` (+ shared module if cleaner):

1. Per-option and per-tier pricing display fields: the per-guest label inputs and a `priced_by` discriminator (`'rate' | 'guest_min' | 'dollar_min'`, the distinction `pricingEngine.js` already computes near :368) so the client can apply the floor rule without re-deriving prices.
2. Per-option extras applicability the client can scope the strip with. The response already prices selected extras per option and reports `dropped`; what is missing is the visible-extras set for a NON-current package, since :311 builds `extras` for the current package only. Either a per-option `visible_extra_ids` array or an `applies` map on each extras entry; the mini-lane picks whichever keeps the payload smallest.

Both are additive response fields; nothing existing changes shape. `publicOptions.js` is sensitive-listed, so the mini-lane takes the standard sensitive-path review.

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
- **Mobile**: bottom sheet with centered drag handle, snap animation ~260ms ease, spring disabled while dragging.

Token translation rule: the artifact's inline styles reference the Apothecary design-system tokens (`--brass`, `--amber`, `--cream-text`, `--chalkboard`, `--font-display`, `--font-body`). The proposal page already renders under these tokens via `index.css`; the lane translates inline styles into `.oo-*` classes in `index.css`, reusing the shipped `.oo-*` vocabulary where a class already fits and keeping the artifact's spacing, hierarchy, and states. No new fonts, no new colors outside the token set.

Named deviations from the artifact (deliberate, decided in this session):

1. Extras are scoped to the selected rung; the artifact's "add to any option above" heading and lane annotations are replaced accordingly.
2. Blocked à la carte rows (bundle conflicts) exist only in this contract, not the artifact.
3. The floor-rule price line ("$550 minimum for smaller events") exists only in this contract.
4. Rung contents and BYOB `brings` lists come from the catalog/bundle config; the artifact's inline lists (including its three "stir sticks" mentions) are placeholders.
5. All prices come from the quote endpoint; the artifact's numbers are placeholders.
6. Copy dashes are normalized to house style: no em dashes in client copy; commas or colons instead (e.g. "quoted with your extras, not on your proposal yet").

## Copy (locked, used verbatim)

- Entry headline: "Want us to handle more of this? See every option, priced for your night" · subline: "From bar service only up to a fully stocked bar: switch any time before you sign."
- Drawer headline: "How much should we handle?" · kicker: "Your proposal · a second look" · event line suffix: ", none of this changes." · insurance line: "Every option includes our $2 million liquor liability insurance."
- Anchor dirty note: "quoted with your extras, not on your proposal yet" · anchor commit: "Add these to my proposal"
- Rung commit: "Make this my proposal" · inflight: "Rewriting…"
- Reprice card: "Prices moved" / "This now totals {new}, it was {old} when you opened this. Nothing has been committed yet." / "Confirm at {new}"
- Drop card: "Before we switch" / "Switch & drop it" / "Keep what I have"
- Expand: "From here, we bring the alcohol too" / "Let us stock the whole bar"
- Clear Reaction kicker: "Sideways, not up · zero proof"
- Blocked extras: "included in {bundle}" / "comes with {bundle}"
- Floor line: "$550 minimum for smaller events"
- Banner: "Rewritten just now" / "Your proposal now reads {name}." / "Undo · back to {name}" / extras-only note: "Same package, same {eventLine}, only your extras changed." / rung note: "Same {eventLine}, nothing else about the night moved."
- Deltas: "{amount} more than yours" / "{amount} less than yours" / "same as yours"

## Out of scope (this pass)

Unchanged from 8/14: analytics, admin notification (audit row ships), compare-group flow, guaranteed switch-back beyond the one-step undo. Additionally: the signature-mixers shopping-list coverage deferral stays deferred (see `shoppingListAddonCoverage.js` header), and add-ons as a surface near the signature stays out.

## Sequencing and the push hold

1. Fleet re-run on oo-switch-server against current main (stale since 8/14, 93+ commits underneath, two sensitive-listed files), then merge. Findings go to Dallas, fix-now or push-anyway, per the standing rule.
2. Server-delta mini-lane (quote display fields + extras applicability).
3. Client ladder lane, built to this spec and the Visual contract.
4. **Push hold (Dallas, 2026-08-20): lane 1's price change goes with the drawer.** Lane 1 may merge whenever; nothing pushes until the client lane is in. Push takes the full money-path treatment: fleet plus cross-LLM second opinion.

## Launch checks

- "Walk Test Package" is not in the prod catalog (verified 2026-08-20: 17 active packages, none named that; the options query also excludes `bar_type = 'class'`). Re-verify at ship anyway; it IS active in the dev DB.
- Drink-plan flip check from 8/14 stands: preview a drink plan against a proposal that switched hosted-to-BYOB or back.
- Verify the client bundle-config twin (`bundleConfig.js`) matches `server/utils/proposalRules.js` before the blocked-row logic ships on it.

## Testing

Server mini-lane: `priced_by` correct across the rate/guest-min/dollar-min boundary (guest counts straddling 50 and the floor); extras applicability matches `visibleAddonsFor` for a non-current package; existing response fields byte-identical.

Client (RTL suite owns this list): ladder assembly from the quote payload (tiers become rungs, hosted lanes, Clear Reaction placement); open state for a BYOB client vs a hosted client; draft extras never mutate committed state and every total re-quotes; anchor dirty flow (note, commit, inflight, repriced); blocked à la carte rows for each bundle with the right reason string; floor label rendering when `priced_by` says the floor set the price; drop-confirm on an incompatible drafted extra; landed banner variants (extras-only vs rung move, dropped sentence); undo restores rung and extras exactly once; entry block absent when `options_available` is false and after a same-session sign; reprice re-tap flow; lost-response refetch; sheet snap points and body scroll lock (mobile) vs side panel (desktop); focus trap and Esc.
