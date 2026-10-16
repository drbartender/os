# Price override removal, and hidden lines that add up

Date: 2026-10-16. Status: design approved section by section in the brainstorm (Dallas, 2026-10-14 to 2026-10-16). Nothing is built.

## 1. Why

`total_price_override` replaces the computed service total. Anything that should move the price later (added hours, an added bartender) moves the computed total underneath it and bills nothing: the fix-list item "advance duration change on a booking with an override adds $0" (live on 606, 607, 608 when raised). Dallas, 2026-10-14: "I want to get rid of the override total and use the discount and surcharge feature that we already have. I think that feature still needs a little tweaking though."

The tweaks, all approved:

1. **Set agreed price.** Type the agreed price; the editor writes the discount or surcharge line for the difference. Expected to be the least used.
2. **Hidden lines fold.** "Client sees" stays, and a hidden line must still leave every client view adding up (Dallas: "if we elect to not make it visible to the client the invoice math still needs to make sense"). The fold happens on the server, so hidden labels and amounts stop reaching the browser.
3. **A contract refund writes a discount line,** so the next editor save does not bill the refund again (fix list OWED section 1, live on 847 when raised).
4. **Deposit and Balance invoices show the step from the contract to the Invoice Total.** Approved into scope 2026-10-15.

Removing the override closes the duration bug by construction: every price difference becomes a fixed-dollar line, and the computed total moves with hours, staffing and add-ons as it does on every native booking.

## 2. Decisions

- D1. The override leaves the product. Every existing override becomes a line for its difference, so no total moves. The column stays in the table, unread and unwritten, because proposal 600 holds a value (section 8).
- D2. The client's rows are built on the server by one pure function (approach chosen over a browser fold and over storing folded rows in the snapshot).
- D3. Hidden amounts fold into the package row with the invoice rule: if the package row would go below $0, it stays at its price and one "Pricing adjustment" row carries the gap.
- D4. Refund lines are visible by default, labeled "Refund". Converted override lines and agreed-price lines are hidden by default.
- D5. The invoice change is display only. No stored invoice line or amount changes.
- D6. Release in three steps: a first push with everything new while the override still works, then the data conversion, then a second push that deletes the override code.
- D7. Accepted cost, already told to Dallas: the override was the only lock against later catalog price changes. A converted booking re-prices to the catalog on its next editor save like every native booking, and the reprice confirm (`repriceSummary.js`, `RepriceConfirmModal.js`) shows it. Converted bookings also become eligible for "see other packages" (today only 756 qualifies), and their discount follows onto other packages like every existing discount.

## 3. The data shape

Unchanged: `proposals.adjustments` is `[{ type: 'discount' | 'surcharge', label, amount (positive dollars), visible }]`, and the engine nets it into the service total (`server/utils/pricingEngine.js`, `calculateProposal`: `max(0, subtotal + net)`, client gratuity on top and never touched by adjustments). No new columns and no new keys on an adjustment. The labels this spec writes are plain labels; nothing keys off them except the agreed-price replace rule (section 5).

## 4. Client rows (tweak 2)

### 4.1 The builder

A new pure server module (working name `server/utils/clientPriceLines.js`, no DB, no Sentry import) takes a pricing snapshot and a service-total target and returns the service rows a client sees, already folded.

- Row set: exactly today's public page rows (`ProposalView.js` `lineItems`, about L580-620), ported row for row with the same labels: the package row (`package.base_cost + staffing.total`, labeled with the package display name the page uses today), bar rental, every add-on including $0 ones, syrups, and the VISIBLE adjustments as signed rows with their label (fallback "Discount" / "Surcharge"). Hidden adjustments produce no row.
- The builder returns service rows only. The page keeps adding the gratuity row itself from `snapshot.gratuity`, as today, because `applyIntentQuote` (`intentQuote.js`) re-quotes `snapshot.total` and `snapshot.gratuity` together in client state after create-intent, and `recomputeSnapshotGratuity` moves the total by the gratuity change only. Service rows therefore stay valid through a gratuity election.
- Fold: gap = target minus the sum of the rows, in cents. Gap 0: nothing. Package row plus gap at or above 0: the package row absorbs the gap. Otherwise the package row is unchanged and one row "Pricing adjustment" carries the whole gap. No package row (legacy or empty snapshot): the "Pricing adjustment" row carries the gap.
- The fold decision (package or fallback) is one small pure function shared with `invoiceLineItems.js` `foldToContract`, which keeps its current behavior byte for byte (its tests at `invoiceLineItems.test.js` pin it, including the 141-151 fallback case).
- Invariant, tested: the rows sum to the target exactly, in cents.

### 4.2 Proposal page

- Target: `snapshot.total - snapshot.gratuity.total`, the service part of the total the page already shows and checkout already charges. The page's Total, pay buttons, PaymentTermsBox, SignAndPaySection, PaidCard and paidState keep their current sources; this spec does not move what the page charges.
- `buildPublicProposalPayload` (`server/routes/proposals/publicToken.js`) adds the builder's rows to the payload, and `ProposalView` renders them in place of its own `lineItems` memo. The settling state (gratuity row filtered, Total "Pending") behaves as today.
- Known drift, not fixed here: a booking whose `total_price` and `snapshot.total` disagree for reasons other than a refund (prod: 59, total $20 above its snapshot, no refund) shows the snapshot figure on the page as today, while its invoices fold to `total_price`.

### 4.3 Hidden data leaves the public payloads

Today the public proposal payload carries every hidden adjustment's label and amount (`snapshot.adjustments`, `snapshot.breakdown`, `snapshot.total_price_override`), logged on the fix list 2026-10-08 ("The public proposal route hands the browser hidden adjustments and the override").

- One sanitizer (pure, beside the builder) produces the public copy of a snapshot: `adjustments` filtered to visible, `breakdown` removed, `total_price_override` removed, and every field from which the hidden net could be recovered by arithmetic either removed or replaced by its folded value: at minimum `subtotal`, and the package price fields that feed the package row. The plan inventories every field the public pages read from the snapshot (ProposalView and its children, SignAndPaySection, PaymentTermsBox, PaidCard, paidState, the drink plan page) and keeps only those; any read that needs an unfolded price is surfaced to Dallas, not silently kept.
- Applied on every route that hands a snapshot to a token holder: `GET /api/proposals/t/:token` (`publicToken.js`), the switch response (`publicSwitch.js`, same payload builder), and `GET /api/drink-plans/t/:token` (`server/routes/drinkPlans.js`, which selects `p.pricing_snapshot`). The plan greps for any other public route selecting `pricing_snapshot` or `adjustments`.
- The client portal route stops returning the raw `total_price_override` (`server/routes/clientPortal.js`, about L117).
- Test: build the public responses for a booking with a hidden discount whose label and amount are distinctive, and fail if the label, the amount, or the pre-fold subtotal appears anywhere in the serialized JSON.

### 4.4 Client portal

- The Prescription tab (`client/src/pages/public/portal/tabs/PrescriptionTab.js`) shows the builder's rows plus the gratuity row in place of its add-ons-only list, so its rows add up to its Total. Target for the portal: `total_price - snapshot.gratuity.total` (the portal shows the row total, as invoices do).
- The portal Total, archive list and summary read `total_price` (drop `COALESCE(total_price_override, total_price)` and `total_price_override ?? total_price`: `clientPortal.js` about L84, `clientPortal/summary.js` about L20, `client/src/pages/public/portal/constants.js` about L15). This fixes the latent bug where the override left gratuity out of the portal total and balance.
- `changeRequestApproved` (`changeRequestNotifications.js` about L45) reads `total_price` for the same reason.

### 4.5 Admin price breakdown

`client/src/components/PricingBreakdown.js` renders `snapshot.breakdown`, which lists every adjustment with no visibility marker. Hidden adjustment rows get a small "hidden from client" tag. Breakdown rows carry no `visible` flag, so the engine adds `visible` to adjustment rows in `breakdown` (pricingEngine.js about L574-580); older snapshots without it read as visible (no tag), which is the safe default for an admin-only view.

"Preview as client" (`ProposalDetail.js`) opens the real public page and needs no change.

## 5. Editor (tweak 1)

- The "Override total" block (`ProposalEditorForm.js` about L735-758) is removed.
- A third button joins "+ Discount" and "+ Surcharge": "Set agreed price". It opens one input (dollars, before gratuity, the way the override worked; helper text says gratuity is added on top) and an Apply button.
- Apply computes `diff = agreed - current service total` from the live preview (`editPreview`), with the agreed-price line itself excluded: if a line labeled exactly "Agreed price adjustment" exists, its signed amount is backed out of the preview total and the line is replaced in place; otherwise a new line is appended. Negative diff writes a discount, positive a surcharge, zero removes the line. The line starts hidden ("Client sees" off).
- Apply is disabled while the preview is stale or loading (`previewStale`, a null `editPreview`) so it never computes against an old total. The line and the new total show in the form before save.
- If backing out the existing line would cross the engine's 0 clamp, Apply refuses with a message rather than guess (vanishingly rare; noted for completeness).
- The math lives in a pure client util with tests (beside `editorCore.js` / `formState.js`).
- Step 1 window (before the conversion runs): a booking that still carries an override shows it read-only with a note that it will convert to a line, and "Set agreed price" is disabled on it (while the override stands, the engine ignores adjustments for the service total, so a new line would do nothing).
- The phone edit sheet (`components/mobile/useEditSheet.js`) has no override or adjustment controls and is unchanged beyond `patchBody.js` no longer sending the override.

### 5.1 Server PATCH (step 1)

- `patchBody.js` stops sending `total_price_override`.
- `PATCH /api/proposals/:id` (`server/routes/proposals/crud.js` about L422-470) refuses any non-null `total_price_override` that differs from the stored value (ValidationError naming the field: overrides are retired, use a discount line). Absent carries forward as today; null still clears (an old editor tab with the box unticked). Equal-to-stored is accepted so an editor tab opened before the deploy can still save an untouched override booking during the step 1 window.
- Legal-hold guard: the PATCH refuses (ConflictError, no write) any proposal in `LEGAL_HOLD_PROPOSAL_IDS` (`server/utils/staleProposalSweep.js` L47). Reason: once step 3 lands the engine no longer reads the override, so any re-priced save on 600 would move it from $3,373 to catalog. The plan checks every other writer that re-prices a stored proposal (extras fold, change-request approval, service extension, cancel-line-item, drink-plan submit, the payment webhook's gratuity apply, the public switch) and adds the same refusal wherever 600 could reach it; the expected answer is that 600's state (confirmed, past-dated) already keeps it out of those paths, and the plan records the check either way.

## 6. Refund line (tweak 3)

- In `applyRefundReconciliation` (`server/utils/refundHelpers.js`), the same transaction that lowers `total_price` by the contract portion (`contractCents`, about L565-604) appends one adjustment `{ type: 'discount', label: 'Refund', amount: contractCents / 100, visible: true }` to `proposals.adjustments` and updates `pricing_snapshot` to match: the same adjustment appended to `snapshot.adjustments`, its row added to `snapshot.breakdown` where the engine would put it (after existing adjustment rows, before the gratuity row), and `snapshot.total` lowered by the same amount with the same 0 floor.
- Only when `contractCents > 0`. Overpayment scope and extra-scope refunds (Additional Services, extensions, extras, off-ledger labels) leave `total_price` alone today and write nothing.
- Exactly once per refund: the line write sits after the already-applied check (`if (done.rows[0]) return { applied: false }`, about L333), so a re-run of the same refund writes nothing.
- One code path covers every caller: `refundExecute.js` (payment panel, Cancel event via `proposals/cancel.js`), `refundSweepScheduler.js` (stuck pending refunds), and `stripeWebhookHandlers/refundCreated.js` (refunds made in the Stripe dashboard).
- Until step 3, `applyRefundReconciliation` keeps lowering the override too. On an override booking in the step 1 window the refund therefore writes the line and lowers the override; the conversion then computes the override line against a subtotal that already includes the refund line, so the two split cleanly (override line = original override minus subtotal, refund line = the refund).
- The client page shows the line between the full price and the lower total; the admin can relabel or hide it like any other line.
- Out of scope, already on the fix list (refundHelpers.js comment, 2026-08-25): a refund larger than the service total, which can only happen when it reaches into gratuity, clamps at 0 and a later re-price bills the gratuity part again. The override had the same flaw.

## 7. Invoice display (tweak 4)

Display only (D5). `client/src/pages/invoice/InvoicePage.js` totals block (about L362-377):

- Compute `diff = sum(line_items.line_total) - amount_due` in cents, in a pure client util with tests.
- Show the step only when the invoice label is Deposit, Balance or Full Payment and `diff > 0`. Rows: "Contract total" (the line sum), then the step row at `-diff`, then "Invoice total" (`amount_due`), then Amount Paid and Balance Due as today.
- Step row label by invoice type: Deposit "Balance, billed later"; Balance "Less deposit and earlier payments"; Full Payment "Less payments already received" (appears only when money was recorded outside online checkout, since Full Payment `amount_due = total - external_paid`).
- Every other invoice renders exactly as today: Additional Services, Service Extension, extras, manual, the Check Cherry balance invoices that already carry a "less deposit" line (diff 0), and any invoice whose rows fall short of `amount_due` (diff at or below 0).
- The PDF (html2pdf of the same DOM) and the print view inherit it. Check the print CSS (`client/src/index.css`, `.invoice-page` print rules about L10541) renders the new rows.
- Why display only: `invoice_line_items` and `amount_due` feed `balanceInvoiceMonitor.js`, the line-sum guard in the deposit-to-full upgrade (`invoiceLifecycle.js` about L517-521), and refresh. None of them change.

## 8. The conversion (step 2)

### 8.1 Scope (prod census 2026-10-16, re-verified in the dry run)

- Override bookings: 38 rows carry `total_price_override`. All except 600 are converted: 37 rows (23 archived, 10 completed, 3 confirmed: 606, 607, 608, and 1 viewed: 756).
- Refund backfill: bookings with no override whose `snapshot.total - total_price` is positive and equals the sum of their succeeded contract-scope refunds' logged drops (`total_price_before - total_price_after`): 7 rows today, 847, 500, 54, 439, 595, 633, 784.
- Excluded: every id in `LEGAL_HOLD_PROPOSAL_IDS` (600). Not touched: any drift without a matching refund (59).

### 8.2 Per-row change

Override rows:
- `line = total_price_override - max(0, snapshot.subtotal + net(adjustments))`, in cents, using the ROW's override (527 and 599 had refunds lower the row's override without updating the snapshot) and the row's `adjustments` (the gate checks the snapshot's copy matches).
- Nonzero: append `{ type: line < 0 ? 'discount' : 'surcharge', label: 'Contract price adjustment', amount: |line|, visible: false }`. Every prod row today is a discount or zero; 26 get a line, 11 are exactly even (551, 574, 575, 596, 597, 601, 602, 605, 607, 608, 629). Live ones: 606 $162 discount, 756 $100 discount, 607 and 608 even.
- `total_price_override = NULL`.

Refund rows:
- One line per succeeded contract-scope refund: `{ type: 'discount', label: 'Refund', amount: total_price_before - total_price_after, visible: true }`.

Both kinds:
- Snapshot synced: `snapshot.adjustments = new adjustments`, the new rows added to `snapshot.breakdown` where the engine would put them (with `visible`), `snapshot.total_price_override = null`, `snapshot.total = total_price`.
- Untouched: `total_price`, `amount_paid`, `status`, every invoice and invoice line, every line price in the snapshot. Nothing re-prices.
- One `proposal_activity_log` row per booking (actions `price_override_converted` and `refund_line_backfilled`, system actor; the plan confirms the allowed actor_type values).

### 8.3 Gates

- Per row, after the change: `max(0, snapshot.subtotal + net(new adjustments)) + snapshot.gratuity.total` equals `total_price` to the cent, and equals `snapshot.total`. One failure aborts the whole run.
- Every row's before-state (`total_price`, `total_price_override`, `adjustments`, `pricing_snapshot->'total'`, `status`) must equal what the dry run read; any change since aborts the whole run.
- One transaction.

### 8.4 Mechanism

The production connection string is blocked from this machine, so prod writes go through a guarded DO block via the Neon MCP `run_sql`:

1. A read query (run_sql) pulls the candidate rows as JSON.
2. A pure Node transform in the repo (tested) computes the change set with the engine's own math and the client-rows builder, and emits (a) the dry-run report and (b) the DO block with every row's expected before-state and exact after-state as literals.
3. Dallas reads the report: per booking, id, status, kind, the line(s), and whether the client rows fold into the package or land on the "Pricing adjustment" fallback.
4. On his go, the DO block runs. It re-checks every before-state and every gate inside the block and RAISEs to abort on any mismatch.
5. A read query afterwards confirms zero overrides outside the legal-hold list and zero refund gaps among the backfilled rows.

Before prod, the transform and DO block run against the dev database on fixture rows shaped like each prod case.

### 8.5 Timing

Step 2 runs after step 1 is live, so no new override can be written and every new refund already writes its line. Step 3 ships only after step 2's confirmation query is clean.

## 9. Override code removal (step 3)

The engine stops reading `total_price_override` (`serviceTotal = calculatedTotal`), and every consumer drops it:

- Server: `pricingEngine.js`; `routes/proposals/crud.js` (destructure, bounds check, `TOTAL_PRICE_OVERRIDE_MAX`, UPDATE column $16; the step 1 refusal becomes "field not accepted"); `routes/proposals/metadata.js` (/calculate); `utils/proposalExtrasFold.js` (the override branch); `utils/refundHelpers.js` (the override CASE in the money UPDATE and its comment); `utils/changeRequests.js`; `utils/changeRequestNotifications.js`; `utils/serviceExtensionPricing.js` (comment); `routes/proposals/publicToken.js` (the `optionsAvailable` override condition and the delete); `routes/proposals/publicOptions.js` (`notComparable('custom_pricing')`); `routes/proposals/publicSwitch.js` (the refusal); `utils/optionsPricingShared.js` (SELECT); `routes/clientPortal.js`, `routes/clientPortal/summary.js`.
- Client: `pages/admin/proposalEditor/{formState.js, patchBody.js, editorCore.js, ProposalEditorForm.js}`; `pages/public/portal/constants.js`.
- Scripts: delete `scripts/cc-transfer-events.js` and `scripts/cc-balance-invoice.js` (one-off Check Cherry cutover scripts that wrote overrides).
- Tests: about 23 test files reference the override; each is updated or its override case deleted.
- `schema.sql` (about L1326): the column stays, with a comment that it is retired and holds only legal-hold data. ARCHITECTURE.md schema section notes the same.
- `invoiceLineItems.js` keeps its fold (hidden adjustments still need it); comments that name the override are updated.
- The plan greps `total_price_override` across `server/`, `client/src/`, `scripts/` and `docs/` (excluding history docs) and accounts for every hit.

## 10. Testing

- Builder: fold into the package, the fallback, no package row, visible rows signed and labeled, $0 add-ons kept, rows always sum to the target, cents rounding.
- Sanitizer and leak test (section 4.3).
- Agreed-price util: new line, replace in place, discount vs surcharge, zero removes, stale preview disabled, clamp refusal.
- PATCH: override refused when changed, accepted when equal, null clears; legal-hold refusal.
- Refund: contract refund writes exactly one line and syncs the snapshot; overpayment and extra-scope refunds write none; a repeat reconciliation writes nothing; the step 1 override-booking case.
- Regression for the original bug: on a converted booking, adding an hour in the editor raises the total by the hour's price.
- Invoice util: each label, diff 0, diff negative, non-contract labels.
- Conversion transform: a fixture per prod shape (plain override, 551's four existing adjustments, 527 and 599 drift, an even row, a refund backfill with more than one refund, 600 skipped, 59 skipped), the gates rejecting a tampered before-state.
- Money smoke suites at push (`npm run gate`).
- Walkthroughs added to `docs/walkthroughs-owed.md`: the proposal page for a hidden-discount booking, the portal Prescription tab, a Deposit and a Balance invoice (screen and PDF), "Set agreed price", a refund on a dev booking (dev talks to live Stripe: use the smallest real amount on a booking Dallas names, or skip and rely on the unit tests).

## 11. Review

Money and public-payload paths: the full fleet per lane before merge, `/second-opinion` and the money smoke gate at push. The conversion's DO block gets its own review pass before it runs on prod.

## 12. Fix-list links

- "Advance duration change on a booking with an override adds $0": superseded 2026-10-14, closed by step 3.
- "A contract refund on a booking with no override is billed again by the next editor save": closed by section 6 and the backfill.
- "The public proposal route hands the browser hidden adjustments and the override": closed by section 4.3.
