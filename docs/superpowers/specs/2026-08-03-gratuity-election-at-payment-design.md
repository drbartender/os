# Gratuity Election Persists Only at Payment

**Date:** 2026-08-03
**Status:** Approved (conversational, section-by-section)
**Prompted by:** Delara Motlagh (proposal 665): "The $250 mandate for tip for a $450 service is outrageous."

## 1. Context and problem

Policy (unchanged by this spec): the bartender always gets tipped. The client chooses how: allow a tip jar at the bar, or skip the jar and prepay a gratuity of at least $50 per bartender per hour. The floor, the labels, the payroll pooling, and the DB CHECK all stay exactly as they are.

The bug is in *when the election sticks*. `POST /api/stripe/create-intent/:token` (server/routes/stripeCreateIntent.js:80-125) persists the client's tip-jar election into `proposals.tip_jar`, `gratuity_rate`, `pricing_snapshot`, and `total_price` the moment the client clicks, before any money moves. A client who clicks "Skip the tip jar" and then abandons checkout leaves a gratuity line baked into their quote. Every later visit renders it next to the service price, indistinguishable from a mandate, with the skip-jar tablet pre-selected and no memory of having chosen it.

That is exactly what happened on proposal 665: Thumbtack auto-draft went out clean at $450, Delara elected skip-jar at checkout on 7/25, abandoned, and returned four times to a $700 quote carrying a $250 "Gratuity" line. Roughly 13 unpaid proposals are in this state (`gratuity_rate > 0 AND amount_paid = 0`).

Note: the Thumbtack webhook payload carries a "Tip jars" answer ("Tip jars not allowed"). Nothing in the codebase reads it, and this spec does not start reading it. The election belongs to the sign-and-pay moment.

## 2. Decision

The tip-jar election is made at sign-and-pay and **persists only when payment succeeds**.

- An unpaid proposal never carries a gratuity: `tip_jar = true`, `gratuity_rate = 0`, no Gratuity line in its snapshot, `total_price` is service only.
- `create-intent` computes the gratuity **in memory**, charges the correct amount, and carries the election in PaymentIntent **metadata**.
- The `payment_intent.succeeded` webhook applies the election to the proposal, inside the row lock it already takes, before the balance invoice is minted.
- The admin proposal editor loses its gratuity block entirely, and the admin PATCH stops accepting `tip_jar` / `gratuity_total`. Admin keeps exactly one gratuity power: removing or lowering a paid gratuity via the existing cancel-line-item flow (which auto-restores the jar and notifies staff).

Client experience: the quote always shows the true service price. The tip-jar question is fresh on every visit. Picking "Skip the tip jar" makes the gratuity appear as the visible consequence of that click, in the Sign & Pay card only; picking "Keep the tip jar" makes it go away. Abandoning checkout resets nothing because nothing was written.

## 3. Server: create-intent (server/routes/stripeCreateIntent.js)

Replace the persist transaction (lines 80-125) with an in-memory computation:

1. Load the proposal (existing code path; the `FOR UPDATE` transaction is no longer needed for gratuity since nothing is written; keep the status guards exactly as they are).
2. When `gratuityProvided`: `gratuityBasisFromSnapshot`, force jar on when `staffCount * hours <= 0`, `deriveGratuityRate` (floor validation unchanged, `ValidationError` on failure), `recomputeSnapshotGratuity` into a **local** `newSnap`. No UPDATE.
3. Full-pay amount = `Math.round(newSnap.total * 100)`; deposit stays flat `DEPOSIT_AMOUNT`.
4. PaymentIntent metadata gains `tip_jar` (`'true'`/`'false'`) and `gratuity_rate` (decimal string) alongside the existing `proposal_id` and `payment_type`. Metadata is attached only when `gratuityProvided`.
5. Response shape unchanged: `{ clientSecret, total_price, gratuity }` built from the in-memory `newSnap`, so the client's "new total" display keeps working untouched.

Intent reuse and staleness (lines 135-171). A deposit is $100 regardless of election, so amount alone can no longer identify an intent; the election metadata is part of its identity:

- Reuse stays disabled when `gratuityProvided` (existing behavior), AND a pending intent that **carries** gratuity metadata is never reused, even by a metadata-less request. Without this, a client who elects skip-jar, reloads (UI state resets to defaults), and pays untouched would be confirmed against the old intent and the webhook would apply an election the client no longer sees.
- The stale-intent cancellation treats a metadata mismatch as staleness, not just an amount mismatch: cancel-and-recreate when amount OR the (`tip_jar`, `gratuity_rate`) metadata pair differs from the current request, with "absent" counting as a distinct value on both sides.

## 4. Server: webhook apply (server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js)

On the first delivery only (existing `proposal_payments` ON CONFLICT idempotency gate), for `payment_type` `deposit` or `full`, when the intent metadata carries `tip_jar`/`gratuity_rate`:

1. Inside the existing proposal row lock, before the `amount_paid` credit and **before `createBalanceInvoice`**: `recomputeSnapshotGratuity` against the proposal's current snapshot with the metadata rate and jar, then `UPDATE proposals SET tip_jar, gratuity_rate, pricing_snapshot, total_price`.
2. `gratuity_rate_change_origin` stays null (client election, matching today's create-intent write).
3. Ordering is the load-bearing part: the balance invoice computes `total_price - amount_paid`, so the gratuity must be in `total_price` first. The invoice line items regenerate from the snapshot, so the Gratuity line rides into the balance invoice as it does today.
4. Metadata absent (legacy pay-only, balance, invoice, drink-plan payments, or a client who never touched the gratuity controls): no gratuity write at all, defaults stand.
5. The DB CHECK (`tip_jar = true OR gratuity_rate >= 50`) is satisfied by construction: the rate in metadata passed `deriveGratuityRate` at intent creation, and the floor is on the rate, not the basis, so an admin staffing edit mid-flight cannot break the CHECK.

Downstream unchanged: additive `amount_paid` credit, funded gate, payroll pooling of both labels, invoice cents bridge.

## 5. Server: admin PATCH and preview

- `server/routes/proposals/crud.js`: remove `tip_jar` / `gratuity_total` from the PATCH body handling (lines 310, 453-473). The stored rate and jar always carry forward: `resolvedGratuityRate = Number(old.gratuity_rate) || 0`, `persistTipJar = old.tip_jar !== false`, passed into `calculateProposal` as today (line 497). This keeps the staffing-rescale path alive: a staffing change on a paid proposal still rescales the gratuity at the same rate, still stamps `origin = 'staffing'`, still triggers `notifyStaffingGratuity` on an increase (lines 500-509). The admin-increase guard (lines 475-491) becomes dead code and is removed; there is no admin write path left for it to guard. The `gratuity_rate_decreased_post_payment` audit branch goes with it (its only writer is gone; cancel-line-item has its own audit trail).
- `server/routes/proposals/metadata.js` (`POST /calculate`): remove the `gratuity_total` derivation branch (lines 68-75). Keep the `gratuity_rate` pass-through (lines 76-81) and `tip_jar` so the editor preview still renders the stored gratuity on paid proposals.
- `server/utils/changeRequests.js` (`priceProposedState`, lines 77-87): fix the existing gap while we are here: pass `gratuityRate: proposal.gratuity_rate, tipJar: proposal.tip_jar` into `calculateProposal` so a change-request preview on a paid proposal stops silently dropping the gratuity. Every other re-price path already does this.
- Untouched: `proposalExtrasFold.js`, `serviceExtensionPricing.js`, `lineItemCancel.js` (the admin removal path survives as is), all System B "Shared Gratuity" surcharge logic.

## 6. Client: admin editor

`client/src/pages/admin/proposalEditor/`:

- `ProposalEditorForm.js`: delete the gratuity block (lines 634-670), the `gratuityDirty` state and `updateGratuity` plumbing (107-114, 248-251, 323), and the gratuity branch of the preview request body (192-197). The preview body always sends the stored `gratuity_rate` + `tip_jar` (from `formState`) so paid proposals preview correctly.
- `patchBody.js`: remove the `tip_jar` / `gratuity_total` keys (lines 48-54).
- `formState.js`: keep the snapshot seeds (lines 41-42) solely to feed the preview body; they are no longer editable.
- Paid proposals still surface their gratuity read-only: the breakdown renderer (`client/src/components/PricingBreakdown.js`) shows the Gratuity line, and `EventDetailPage.js` keeps its "No tip jar (client paid to skip it)" badge.

## 7. Client: sign-and-pay copy

`client/src/pages/proposal/proposalView/SignAndPaySection.js`, gratuity block. No behavior change beyond copy; every control keeps calling `setGratuityDirty(true)`. Proposed copy (Dallas to approve wording; no em dashes):

- Intro under "Tipping, handled your way": "Our bartenders are always tipped: either guests tip at the bar, or the gratuity is prepaid. Every dollar goes straight to your bartenders. None of it is kept by Dr. Bartender."
- Keep the tip jar (unchanged): "A jar sits on the bar; guests tip as they like. Add a little extra below if you'd like to start it off."
- Skip the tip jar: "No jar at the bar. Instead, a prepaid gratuity of $50 per bartender per hour is added to your total, so your crew is still taken care of."

The mechanics (floor auto-fill, no presets in no-jar mode, min on the input, floor warning, disabled pay button) are the policy working as intended and do not change.

`ProposalView.js` election seeding (lines 169-176): unpaid proposals will have no persisted election, so the seeds naturally resolve to jar-on / $0. Leave the seeding code in place; it is what renders the paid state correctly if a paid proposal is ever revisited.

## 8. Data reset (one-off script)

`scripts/reset-unpaid-gratuity.js`: for every proposal with `COALESCE(gratuity_rate, 0) > 0 AND COALESCE(amount_paid, 0) = 0` (roughly 13 rows in prod, including 665):

- `recomputeSnapshotGratuity(snapshot, { gratuityRate: 0, tipJar: true, ... })`
- `UPDATE proposals SET tip_jar = true, gratuity_rate = 0, gratuity_rate_change_origin = NULL, pricing_snapshot, total_price` (total drops by the gratuity amount).
- Guard: refuse any row with `amount_paid > 0`. Paid proposals (8 in prod) are never touched.
- Dry-run mode by default; `--apply` to write. Run on dev first, then prod with explicit approval per destructive-op rules.

Delara lands back on a clean $450 next visit, with the choice fresh in front of her.

## 9. Invariants preserved

- Floor: `deriveGratuityRate` at intent creation, engine, DB CHECK. All unchanged.
- Labels: `gratuityLabels.js` untouched; payroll keys on the same frozen labels.
- Webhook records the amount actually charged, additively. Unchanged.
- Gratuity added on top of `total_price_override`, never diluted. Unchanged (engine untouched).
- Contract §8.3 (`eventServicesAgreement.js:117`) stays accurate without edit: at signing time, a no-jar election does put the gratuity in the agreement total. No agreement version bump.
- Incidental fix: the proposal-options clone desync (clone copies a gratuity-bearing snapshot but not the columns) disappears, because unpaid proposals no longer carry gratuity to clone.

## 10. Tests

- `stripeCreateIntent`: new route test asserting (a) no proposal write on intent creation, (b) metadata carries the election, (c) full-pay amount reflects the in-memory gratuity, (d) below-floor still 400s, (e) stale-intent cancellation on metadata mismatch.
- `paymentIntentSucceeded`: new cases asserting the gratuity applies on first delivery, before the balance invoice (balance = total incl. gratuity minus deposit), no-op when metadata absent, idempotent on redelivery.
- `crud.test.js`: Cases 21 and 23 (admin rate increase/decrease post-payment) are removed with the code they test. Case 19 (gratuity preserved across unrelated edit) and Case 22 (staffing-driven rescale) stay and must still pass.
- `patchBody.test.js`: gratuity keys never sent.
- `changeRequests`: preview carries stored gratuity.
- Reset script: unit-tested against fixture rows (chicago-keyed fixtures per test law), including the paid-row refusal.

## 11. Out of scope

- Reading the Thumbtack "Tip jars" answer (deliberately unused).
- Any change to the floor amount, the suggested amount, or System B staffing surcharges.
- The refund-suppression gap and other parked items.
