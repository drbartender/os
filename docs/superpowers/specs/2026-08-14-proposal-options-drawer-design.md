# Proposal page: package options drawer

Date: 2026-08-14
Status: approved (brainstormed with Dallas, section-by-section; spec-fleet findings folded back in same day, hidden-add-on carry decided by Dallas)
Design source: none. This pass builds on the existing proposal-page CSS and tokens; the claude.ai/design round-trip was deliberately skipped, so there is no Visual contract section.

## Context

The "See other options" comparison shipped 2026-08-11 (spec 2026-07-01-proposal-options-compare-design.md, reskin 2026-07-02). A third-party review of the proposal page found the real conversion leak: the panel inline-expands at the very bottom of the page, so browsing it scrolls the sign-and-pay surface far out of view with nothing pulling the client back. The mobile jump-to-sign CTA sits above the panel, behind the reader. Nobody has used the panel yet, it just went live, so nothing here is protecting observed behavior.

Two facts about the current build that shaped the decisions:

- Picking an option today opens a pre-filled mailto to contact@drbartender.com. The sign-time commit was never built; the code marks this as a deliberate seam (`handleWantOption`, ProposalView.js).
- Desktop already has a sticky pay rail at 1024px and up. The panel leaks on desktop only because it renders outside that layout.

## Decisions (settled 2026-08-14)

1. The bottom "See other options" button is removed. The single entry point is a quiet inline link beside the package title (the `h2` opening the Package section in ProposalPricingBreakdown.js): **"See other packages for this event"**. The link renders only when the payload's `options_available` flag is true (below), so it never opens an apology.
2. The panel becomes a drawer. One component, two CSS treatments:
   - Mobile: bottom sheet over the proposal. Drag handle, two snap points (peek and full). Peek shows the anchor strip plus roughly one and a half cards so more content is obviously below. Mechanics for this vanilla-CSS codebase: transform between two fixed heights, drag handle driven by pointer events, body scroll locked while open, and the card list internally scrollable only in the full state so drag and scroll never fight. While the quote loads, peek shows skeleton cards.
   - Desktop: side panel sliding in from the right. No dimmed backdrop; the proposal and the sticky sign rail stay visible beside it. Closing returns the client exactly where they were.
   - Accessibility, both breakpoints: dialog semantics with focus trapped while open, Esc closes, focus returns to the entry link, and a landed switch is announced through the same `role="status"` live-region pattern the panel already uses.
3. Drawer header: **"Same date, different package."** ("night" broke for day events; "bar" read as a venue; keep it simple.)
4. Streamlined open state: three cards, then **"See all packages"** which extends the same list in place using the existing lane groupings (we bring everything / you buy the alcohol / also available). On expand, the peek cards re-slot into their lanes (never duplicated) and the anchor strip stays pinned. The three:
   - nearest-priced option below the client's quote,
   - nearest-priced option above it,
   - the structural alternative: BYOB (The Core Reaction) if they are on a hosted package, the nearest hosted if they are on BYOB.

   Boundary rules: if the structural alternative duplicates a neighbor, take the next-nearest distinct option; a client on the cheapest package gets two above plus the structural alternative; fewer than three distinct available options means show what exists. An `available: false` option never occupies a peek slot; it appears only in see-all, with its reason.
5. Anchor strip at the top of the drawer: "YOURS · [package name] · [total]", pinned while the list scrolls so deltas keep their meaning. The anchor number is the current card's displayed total (the contract total echoed verbatim on first load, the re-quoted current-package total once the client toggles an extra), the same source the deltas are computed from.
6. Card content: name, badge, total for their exact event, and the delta line ("$60 less than yours"). The delta is the hero of the card, larger than today, neutral in color: no green savings treatment, no sage (sage already means "discount" in the pricing table and would sell the downgrade).
7. Card action: **"Switch to this package."** The pin-to-compare flow is retired: no picked state, no tray, no CompareTable view. Three stacked cards against a visible "yours" is the comparison. ExtrasPanel stays inside the drawer as the comparison-fairness lever it already is (toggling an extra re-quotes every option together).
8. Browsing writes nothing. No autosave of drawer state to the server; a client who browses and leaves still leaves no trace. The switch is the one write. Drawer state (tier, extras, quote) survives close/reopen by staying mounted, and survives a refresh via sessionStorage keyed on `proposal.updated_at` so an admin edit invalidates it. No localStorage.
9. **The switch is real.** "Switch to this package" rewrites the proposal row (package, BYOB tier, extras, exactly the configuration the drawer quoted) and the signature then commits what is on the row. The mailto hand-off is retired. Rationale: a proposal is a quote, not a commitment; clients can hold many; nothing matters until money moves. This replaces the "DELIBERATE SEAM" in ProposalView.js and its comment.

   This supersedes §5 of `2026-08-11-proposal-compare-and-book-design.md`, which put the commit point inside the sign endpoint. The commit point is now this dedicated switch endpoint, pre-signature. The sign endpoint changes in exactly one way (the total assertion in §Sign-time below); clients who never switch otherwise take today's path byte for byte, the same blast-radius property the old §5.2 was protecting. The old spec's money rules (configuration not price, acknowledged total, override exclusion, engine-owned pricing) transfer to the switch endpoint and are restated below.
10. **Hidden add-ons follow the proposal** (Dallas: "still gotta park no matter what we serve"). Admin-added add-ons the client cannot see (parking fee; over-100-guest glassware) are event facts, not package features. The quote endpoint changes to carry the proposal's own hidden add-ons onto EVERY option's price, not only the current card, so every number in the drawer already includes them, deltas compare like with like, and the switch commits exactly what was shown. A hidden add-on whose `applies_to` genuinely does not fit the target package cannot ride; it drops with the same client-facing notice as any incompatible extra, and the audit row records it.
11. Add-ons as a purchase surface outside the drawer: separate, later. The reviewer's "add-ons near the signature" idea is out of scope for this pass.

## Server work

### `options_available` on the public payload

The public GET `/t/:token` payload (built in `server/routes/proposals/publicToken.js`; note the admin read in `getOne.js` is a different surface) gains `options_available`. It is a cheap predicate, not an engine run: status in the switch whitelist below, no `total_price_override`, not signed, and a catalog COUNT confirming at least two comparable packages exist. It intentionally exposes nothing the existing options POST does not already reveal.

The link (and the flag) is false for `draft` and `modified` proposals and for grouped-and-undecided proposals (`group_id` set, group choice not committed). Grouped clients already have the compare page; letting a switch mutate one of Dallas's hand-built alternatives would corrupt what `/compare/:groupToken` renders. The `/compare` redirect machinery is untouched. Decided-group proposals behave as normal proposals.

### Switch endpoint

New public token route, sibling of the options quote in `server/routes/proposals/` (composition-router pattern):

`POST /api/proposals/t/:token/switch`
Body: `package_id`, `tier_addon_id`, `extra_addon_ids`, `acknowledged_total` (the name `changeRequests.js` already uses; DOLLARS, per the proposals money law).

The body carries a configuration, never a price used for pricing. The server re-prices through `priceProposedState()` with every event parameter read off the proposal row under the row lock; this is the drinkPlans/submit.js $627 failure class and the rule is inherited verbatim from the 8/11 spec. Two staffing traps, both live-bitten:

- `priceProposedState()` does NOT fall back to `proposal.num_bartenders` the way it does for guests, hours, and bars; the caller must handle it explicitly.
- The `num_bartenders` column holds persisted DERIVATIONS as well as true overrides (crud writes `staffing.actual` back). Blindly carrying it onto a package with a different ratio prices phantom over-ratio bartenders that quote and commit would AGREE on, so the 409 gate cannot catch it. Rule: pass `num_bartenders` only when the old snapshot shows a real override in effect (`staffing.actual` differs from `staffing.required`); otherwise let the new package derive. The test matrix includes a hosted-to-hosted switch across differing `guests_per_bartender` ratios.

Guards, all server-side, all evaluated against the FOR UPDATE row inside the transaction (the quote endpoint's unlocked read is NOT the model here; a webhook must not be able to commit between guard-check and write):

- `requireUuidToken` on `:token` (UUID token-guard law).
- Status whitelist: `sent` or `viewed` only. This is deliberately narrower than the quote's blacklist (which admits draft/modified); the entry-link flag above uses the same whitelist so the link and the write can never disagree.
- Refuse custom-priced (`total_price_override`) and signed proposals, and grouped-undecided proposals.
- Refuse when `amount_paid > 0` or when any Stripe PaymentIntent for this proposal is `processing` or `succeeded`-but-unrecorded: money in flight for the old configuration blocks the switch.
- `package_id` must be one of the options the quote endpoint would offer for this proposal.

Behavior, in one transaction on one pooled connection (SERVER-17 / capture-lead precedent; helpers in any post-commit tail included):

- **Cancel stale intents first.** Cancel every cancelable PaymentIntent attached to the proposal (create-intent's existing stale-cancel pattern in `stripeCreateIntent.js`). Client-side secret invalidation alone cannot revoke a live intent, and a pre-switch intent settling post-switch would pass the webhook's payable guard (a switch deliberately stays in the payable set) and record the OLD amount against the NEW configuration, with a gratuity basis mismatch on top. Server-side cancel plus the processing/succeeded refusal above closes this.
- Re-price the requested configuration through the engine exactly as the quote endpoint prices it, with the proposal's own hidden add-ons carried per decision 10 (same `visibleAddonsFor` gating for client-chosen extras).
- **Price integrity:** compare against `acknowledged_total` in integer cents (`Math.round(x * 100)` both sides, never float equality). On mismatch, 409 carrying the fresh quote. (AppError uses `statusCode`, not `status`.)
- On match: update the proposal's package fields; rewrite `proposal_addons` by delete-and-reinsert from engine output, following the inline precedent at `crud.js:636` (with `withRepriceQuantities` / `utils/addonQuantity.js` for quantity inversion; `insertProposalRecord` is create-only and `foldExtrasIntoProposal` is same-package delta machinery that moves the override column, so neither is the vehicle, and `proposal_addons.quantity` remains an OUTPUT column with one sanctioned inverter); rebuild the pricing snapshot from engine output; run `reconcileProposalPaymentStatus` (crud.js:604 pattern) because "paid is unreachable" is not airtight (force status rewinds and `external_paid` imports leave money on `sent` rows), so this is load-bearing, not belt-and-suspenders; and re-derive invoices via `refreshUnlockedInvoices(proposalId, dbClient)` (`invoiceLifecycle.js:99`), which is in-tx capable, recomputes without invoice-number churn, makes a replayed identical switch an idempotent no-op, and is naturally a no-op for proposals with no invoice yet (grouped proposals mint at accept, which then reads the new configuration).
- `deposit_amount` is deliberately not written. Note the actual mechanism: `create-intent` never reads the column (it charges the standard constant); the Deposit INVOICE via `refreshUnlockedInvoices` is what honors a hand-set value, and the schema default means non-null does not imply hand-set. The switch neither recomputes nor clears it; a hand-set large deposit surviving a switch-down is admin follow-up, not automation.
- Snapshot writer obligations: rebuild the gratuity block for the new staffing basis (staff count, hours, staff noun) and **carry `gratuity.floor_rate`**; every persisting snapshot writer carries the mandate or it strips the checkout floor client-side (gratuity law). Pricing goes through the engine, which owns `isHostedPackage` / `staffing.required`; no new bartender-cost code paths.
- **Audit:** write a `proposal_activity_log` row (the table every other proposal mutation already uses) recording old and new package, old and new totals, dropped add-ons if any, and request IP. This is the provenance for a payment dispute and the detector for leaked-token abuse. Admin notification stays out of scope; the audit row does not.
- Respond with the same public-safe allowlist shape GET `/t/:token` builds (never `RETURNING *`; the raw row carries admin_notes, signature IP/UA, and Stripe ids) so the page adopts server truth without a reload.
- Rate limiting: token-keyed like `optionsQuoteLimiter` but tighter for a write (order of 20 per 15 min); never the shared IP-keyed `publicReadLimiter`.
- Observability: Sentry capture on repeated 409s for one token in a short window (engine/quote drift or a grinding token) and on any switch whose reconcile touches a row with `amount_paid > 0` (a guard hole was exercised).

### Sign-time total assertion

The sign POST gains one field: the total rendered above the signature. The sign UPDATE's WHERE re-asserts `total_price = $X` (the same TOCTOU-collapse pattern its status guard already uses), 409 on mismatch, and the client refetches and re-shows. Without this, the signature commits "whatever is on the row," and a switch landing between render and sign-click (the client's own second tab, or a leaked token stuffing add-ons onto a total someone else pays) would bind a signature to a configuration the signer never saw. This is the single change to the sign endpoint; a request without the field is impossible from the updated client, and the no-switch flow is otherwise untouched.

### Quote endpoint change

`publicOptions.js` carries the proposal's own hidden add-ons onto every option's price (decision 10) and gains a per-option `dropped` list naming any of the client's selected extras or own hidden add-ons that cannot apply to that option; that list is the data path for the client-facing notice, which today's response cannot power.

## Client work

- `ProposalView.js`: drawer open/close state replaces `showOptions`; panel stays mounted once opened (hide, not unmount). Entry link and drawer hide client-side on any non-payable state, including a same-session sign (`signedThisSession`), with server refusals as backstop only.
- Entry link beside the package title in `ProposalPricingBreakdown.js`, rendered only when `options_available`.
- `OtherOptionsPanel.js`: becomes the drawer body. Remove pick/compare state, `CompareTable.js`, and the pinned tray. Add the anchor strip, the three-card open state, and see-all expansion. Keep the debounced re-quote, the request-sequencing ref, and the keep-last-good-data error handling exactly as they are; they are load-bearing.
- Switch action states: button disabled with a spinner while the POST is in flight (double-tap blocked client-side; a replayed identical switch is server-idempotent regardless). On 409, the drawer adopts the fresh quote from the 409 body, shows a plain "Prices were updated, take another look" note, and requires a fresh tap. On timeout or a lost response, the page refetches GET `/t/:token` to reconcile what actually committed; the sign-time total assertion is the backstop if reconciliation is missed.
- On a successful switch: close the drawer, adopt the returned payload, and make the change visible (updated package section, updated Total, a brief highlight on the Total row so the client sees the swap land without verifying it themselves).
- **Stripe intent invalidation:** a switch clears both cached client secrets and refetches, riding the gratuity chooser's exact pattern, ON TOP of the server-side intent cancellation above; the client-side half alone is display hygiene, not the safety mechanism.
- Gratuity chooser reseeds from the new snapshot (new staff count and hours change the suggested amount and the floor) through the existing seeding effect, with `gratuityDirty` reset so the reseed is not blocked.
- Dropped add-ons and extras surface in the drawer before or at switch time from the quote's `dropped` list; never silently.

## Out of scope (this pass)

- Add-ons as a standalone purchase surface near the signature.
- Open/interaction tracking or analytics on the drawer.
- Admin notification when a client switches (the audit row ships; the notification does not).
- Any change to the compare-group flow (`/compare/:groupToken`) or its commit/archive machinery.
- Guaranteed switch-back: the options list always includes the proposal's CURRENT package even when inactive, but a package a client switched AWAY from that has since been deactivated leaves the catalog. The audit row preserves what it was; restoring is an admin edit.

## Launch checks

- Verify "Walk Test Package" is not `is_active` in the prod catalog before this ships; it is active in the dev DB and would render as a real card.
- Plan-stage verify: an existing drink-plan preview against a proposal that switches hosted-to-BYOB or back (the switch writes nothing planner-side; the planner derives from the proposal row on load, and `submit.parking.test.js` shows the planner fold preserving addon lines, but the flip case has never existed before).

## Review

The switch endpoint, the sign-time assertion, the quote change, and the intent invalidation are money paths: full agent fleet on the lane, max effort, plus the standard sensitive-path treatment (full fleet + cross-LLM) at push. The new route file and `CompareTable.js` removal trigger the mandatory docs table: README folder tree and ARCHITECTURE route table in the same change. Suites to run: `publicOptions.test.js`, the proposal crud/extras-fold suites, `publicToken` sign suites, invoice-lifecycle suites, and the create-intent/webhook gratuity suites (grep callers of anything touched and run those suites).

## Testing

- Switch endpoint: guard matrix (bad token, non-UUID token, signed, custom-priced, paid, draft/modified, grouped-undecided, wrong package_id, `amount_paid > 0`, intent in `processing`); price-integrity 409 on stale `acknowledged_total` with cents comparison; stale-intent cancellation actually called; snapshot correctness (gratuity basis rebuilt, `floor_rate` carried, addons rewritten through the sanctioned inverter); transaction atomicity; a TRUE admin `num_bartenders` override surviving while a persisted derivation re-derives on the new ratio (both directions); hidden add-ons carried across packages and `applies_to`-incompatible ones dropped with the audit row recording it; `deposit_amount` untouched; invoice matching the committed total after the switch, including the no-invoice (deferred group) branch; idempotent replay; `reconcileProposalPaymentStatus` on a force-rewound row with `amount_paid` intact; response shape is the public allowlist; activity-log row written.
- Sign endpoint: signature with the total assertion passing; 409 on a total moved between render and sign; the no-switch flow byte-identical otherwise.
- Client: intent invalidation on switch (old secret never reused), gratuity reseed, drawer state surviving close/reopen and keyed sessionStorage invalidation on admin edit, entry link absent when `options_available` is false and after a same-session sign, 409 re-show flow, lost-response refetch.
