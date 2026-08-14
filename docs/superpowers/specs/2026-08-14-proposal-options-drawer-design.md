# Proposal page: package options drawer

Date: 2026-08-14
Status: approved (brainstormed with Dallas, section-by-section)
Design source: none. This pass builds on the existing proposal-page CSS and tokens; there is no claude.ai/design artifact and therefore no Visual contract section.

## Context

The "See other options" comparison shipped 2026-08-11 (spec 2026-07-01-proposal-options-compare-design.md, reskin 2026-07-02). A third-party review of the proposal page found the real conversion leak: the panel inline-expands at the very bottom of the page, so browsing it scrolls the sign-and-pay surface far out of view with nothing pulling the client back. The mobile jump-to-sign CTA sits above the panel, behind the reader. Nobody has used the panel yet, it just went live, so nothing here is protecting observed behavior.

Two facts about the current build that shaped the decisions:

- Picking an option today opens a pre-filled mailto to contact@drbartender.com. The sign-time commit was never built; the code marks this as a deliberate seam (`handleWantOption`, ProposalView.js).
- Desktop already has a sticky pay rail at 1024px and up. The panel leaks on desktop only because it renders outside that layout.

## Decisions (settled 2026-08-14)

1. The bottom "See other options" button is removed. The single entry point is a quiet inline link beside the package title (the `h2` opening the Package section in ProposalPricingBreakdown.js): **"See other packages for this event"**.
2. The panel becomes a drawer. One component, two CSS treatments:
   - Mobile: bottom sheet over the proposal. Drag handle, two snap points (peek and full). Peek shows the anchor strip plus roughly one and a half cards so more content is obviously below.
   - Desktop: side panel sliding in from the right. No dimmed backdrop; the proposal and the sticky sign rail stay visible beside it. Closing returns the client exactly where they were.
3. Drawer header: **"Same date, different package."** ("night" broke for day events; "bar" read as a venue; keep it simple.)
4. Streamlined open state: three cards, then **"See all packages"** which extends the same list in place using the existing lane groupings (we bring everything / you buy the alcohol / also available). The three:
   - nearest-priced option below the client's quote,
   - nearest-priced option above it,
   - the structural alternative: BYOB (The Core Reaction) if they are on a hosted package, the nearest hosted if they are on BYOB.

   If the structural alternative duplicates a neighbor card (a BYOB client's nearest options are all hosted), take the next-nearest option instead so the open state always shows three distinct cards.
5. Anchor strip at the top of the drawer: "YOURS · [package name] · [total]", pinned while the list scrolls so deltas keep their meaning.
6. Card content: name, badge, total for their exact event, and the delta line ("$60 less than yours"). The delta is the hero of the card, larger than today, neutral color: no green savings treatment, no sage (sage already means "discount" in the pricing table and would sell the downgrade).
7. Card action: **"Switch to this package."** The pin-to-compare flow is retired: no picked state, no tray, no CompareTable view. Three stacked cards against a visible "yours" is the comparison. ExtrasPanel stays inside the drawer as the comparison-fairness lever it already is (toggling an extra re-quotes every option together).
8. Browsing writes nothing. No autosave of drawer state to the server; a client who browses and leaves still leaves no trace. The switch is the one write.
9. **The switch is real.** "Switch to this package" rewrites the proposal row (package, BYOB tier, extras, exactly the configuration the drawer quoted) and the existing signature flow then commits whatever is on the row, unchanged. The mailto hand-off is retired. Rationale: a proposal is a quote, not a commitment; clients can hold many; nothing matters until money moves. This replaces the "DELIBERATE SEAM" in ProposalView.js and its comment.

   This supersedes §5 of `2026-08-11-proposal-compare-and-book-design.md`, which put the commit point inside the sign endpoint. The commit point is now this dedicated switch endpoint, pre-signature, and **the sign endpoint is not touched at all**: clients who never switch take today's path byte for byte, which is the same blast-radius property the old §5.2 was protecting. The old spec's money rules (configuration not price, acknowledged total, override exclusion, engine-owned pricing) transfer to the switch endpoint and are restated below.
10. Add-ons as a purchase surface outside the drawer: separate, later. The reviewer's "add-ons near the signature" idea is out of scope for this pass.

## Server work

### `comparable` on the proposal payload

The public getOne payload gains a boolean (`options_available`) computed with the same gates the options quote applies (standard-priced, not signed, at least two comparable options). The entry link renders only when true, so a custom-priced or signed proposal never shows a link that opens an apology.

### Switch endpoint

New public token route, sibling of the options quote (`server/routes/proposals/publicOptions.js` pattern):

`POST /api/proposals/t/:token/switch`
Body: `package_id`, `tier_addon_id`, `extra_addon_ids`, `acknowledged_total` (the name `changeRequests.js` already uses for this concept).

The body carries a configuration, never a price used for pricing. The server re-prices through `priceProposedState()` with every event parameter read off the proposal row under the row lock; this is the drinkPlans/submit.js $627 failure class and the rule is inherited verbatim from the 8/11 spec. Known trap, live-bitten once already: `priceProposedState()` does NOT fall back to `proposal.num_bartenders` the way it does for guests, hours, and bars. The caller must pass it explicitly or an admin staffing override is silently re-derived from the 1:100 ratio.

Guards, all server-side and all mirroring the quote endpoint:

- `requireUuidToken` on `:token` (UUID token-guard law).
- Status must be `sent` or `viewed`. Refuse `accepted` (signed under the old flow), refuse anything paid or converted.
- Refuse custom-priced proposals (`custom_pricing`) and signed proposals (`already_signed`), same reasons the quote refuses.
- `package_id` must be one of the options the quote endpoint would offer for this proposal (active, non-class, or the current package).

Behavior:

- Re-price the requested configuration through the pricing engine, exactly as the quote endpoint prices it (same `visibleAddonsFor` gating, same tier and extras handling, the proposal's own hidden add-ons carried).
- **Price integrity:** if the engine total does not match `acknowledged_total`, refuse with 409 and return the fresh quote. The client-side drawer re-quotes and re-shows; we never commit a number the client was not looking at. (AppError uses `statusCode`, not `status`.)
- On match, in one transaction: update the proposal's package fields, rewrite `proposal_addons` for the new configuration, rebuild the pricing snapshot from engine output, and **re-derive the invoice minted at send**, which is stale the moment the total moves (which invoice function satisfies this is a plan question; it is on the sensitive-paths list).
- `deposit_amount` is deliberately not written. A non-null value is a deposit Dallas set by hand and a switch must neither recompute nor clear it (`create-intent` falls back to the standard constant when null).
- One pooled connection for the whole handler, helpers in the post-commit tail included (SERVER-17 / capture-lead precedent).
- Rate limiting: token-keyed, following `optionsQuoteLimiter`; never the shared IP-keyed `publicReadLimiter`, which browsing already must not exhaust.
- Respond with the updated proposal payload (new snapshot, new total) so the page adopts server truth without a reload.

Cross-cutting consistency (the reason this is a money seam):

- The snapshot writer must rebuild the gratuity block for the new staffing basis (staff count, hours, staff noun) and **must carry `gratuity.floor_rate`**: every persisting snapshot writer carries the mandate or it strips the checkout floor client-side (gratuity law).
- `proposal_addons.quantity` is an OUTPUT column. Reuse the existing insert/fold utilities (`proposalInsert.js` / `proposalExtrasFold.js` machinery), never hand-write quantity math (addon quantity trap; three money bugs so far).
- Payment-status re-evaluation per the cross-cutting law. The guards make a paid proposal unreachable, so this is belt-and-suspenders, but the check is stated so the reviewer verifies it rather than assumes it.
- Hosted bartender ratio: pricing goes through the engine, which owns `isHostedPackage` / `staffing.required`. No new bartender-cost code paths in this feature.

## Client work

- `ProposalView.js`: drawer open/close state replaces `showOptions`; panel stays mounted once opened (hide, do not unmount) so tier and extras selections and the priced quote survive close/reopen within the visit. `sessionStorage` for refresh survival only; no `localStorage` (a proposal edited since would restore stale state).
- Entry link beside the package title in `ProposalPricingBreakdown.js`, rendered only when `options_available`.
- `OtherOptionsPanel.js`: becomes the drawer body. Remove pick/compare state, `CompareTable.js`, and the pinned tray. Add the anchor strip, the three-card open state, and see-all expansion. Keep the debounced re-quote, the request-sequencing ref, and the keep-last-good-data error handling exactly as they are; they are load-bearing.
- On a successful switch: close the drawer, adopt the returned proposal payload, and make the change visible (updated package section, updated Total, a brief highlight on the Total row so the client sees the swap land without verifying it themselves).
- **Stripe intent invalidation:** a switch invalidates both cached client secrets and refetches, riding the exact pattern the gratuity chooser already uses (clear `depositSecret` / `fullSecret`, let the consolidated intent effect refetch). A client who switches after the payment form loaded must never be charged the old amount.
- Gratuity chooser reseeds from the new snapshot (new staff count and hours change the suggested amount and the floor); the switch response's snapshot drives it through the existing seeding effect, with `gratuityDirty` reset so the reseed is not blocked.
- If the new configuration cannot carry an extra the client had toggled (visibility gating drops it), say so in the drawer before or at switch time; never drop it silently.

## Out of scope (this pass)

- Add-ons as a standalone purchase surface near the signature.
- Open/interaction tracking or analytics on the drawer.
- Admin notification when a client switches.
- Any change to the compare-group flow (`/compare/:groupToken`), which is a different surface for admin-sent alternatives.

## Launch checks

- Verify "Walk Test Package" is not `is_active` in the prod catalog before this ships; it is active in the dev DB and would render as a real card.

## Review

The switch endpoint and the intent invalidation are money paths: full agent fleet on the lane, max effort, plus the standard sensitive-path treatment at push. Suites to run: `publicOptions.test.js`, the proposal crud/extras-fold suites, and the create-intent/webhook gratuity suites (grep callers of anything touched and run those suites).

## Testing

- Switch endpoint: guard matrix (bad token, non-UUID token, signed, custom-priced, paid, wrong package_id), price-integrity 409 on stale `acknowledged_total`, snapshot correctness (gratuity basis rebuilt, `floor_rate` carried, addons rewritten through the fold utilities), transaction atomicity, an admin `num_bartenders` override surviving the switch, `deposit_amount` untouched, and the send-time invoice matching the committed total after the switch.
- Client: intent invalidation on switch (old secret never reused), gratuity reseed, drawer state survives close/reopen, entry link absent when `options_available` is false.
