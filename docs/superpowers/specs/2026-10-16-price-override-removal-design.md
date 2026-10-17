# Price override removal, and hidden lines that add up

Date: 2026-10-16. Status: design approved section by section in the brainstorm (Dallas, 2026-10-14 to 2026-10-16); spec-review fleet (grounding, gaps, risk) folded 2026-10-16 with Dallas's approval of the fixes, including pricing the live conversions against today's catalog; the plan fleet's findings amended 3, 4.5, 5.1, 8.4 and 8.5 the same day. Nothing is built.

## 1. Why

`total_price_override` replaces the computed service total. Anything that should move the price later (added hours, an added bartender) moves the computed total underneath it and bills nothing: the fix-list item "advance duration change on a booking with an override adds $0" (live on 606, 607, 608 when raised). Dallas, 2026-10-14: "I want to get rid of the override total and use the discount and surcharge feature that we already have. I think that feature still needs a little tweaking though."

The tweaks, all approved:

1. **Set agreed price.** Type the agreed price; the editor writes the discount or surcharge line for the difference. Expected to be the least used.
2. **Hidden lines fold.** "Client sees" stays, and a hidden line must still leave every client view adding up (Dallas: "if we elect to not make it visible to the client the invoice math still needs to make sense"). The fold happens on the server, so hidden labels and amounts stop reaching the browser.
3. **A contract refund writes a discount line,** so the next editor save does not bill the refund again (fix list OWED section 1).
4. **Deposit and Balance invoices show the step from the contract to the Invoice Total.** Approved into scope 2026-10-15.

Removing the override closes the duration bug by construction: every price difference becomes a fixed-dollar line, and the computed total moves with hours, staffing and add-ons as it does on every native booking.

## 2. Decisions

- D1. The override leaves the product. Every existing override becomes a line for its difference, so no total moves. The column stays in the table, unread and unwritten, because proposal 600 holds a value (section 5.3).
- D2. The client's rows are built on the server by one pure function (approach chosen over a browser fold and over storing folded rows in the snapshot).
- D3. Hidden amounts fold into the package row with the invoice rule: if the package row would go below $0, it stays at its price and one "Pricing adjustment" row carries the gap.
- D4. Refund lines are visible by default, labeled "Refund". Converted override lines and agreed-price lines share one label, "Agreed price adjustment", and are hidden by default.
- D5. The invoice change is display only. No stored invoice line or amount changes.
- D6. Release in three steps: a first push with everything new while the override still works, then the data conversion, then a second push that deletes the override code.
- D7. Accepted cost, restated after the fleet. A converted booking becomes native and re-prices at the live catalog wherever a native booking does: the editor save (the reprice confirm, `repriceSummary.js` / `RepriceConfirmModal.js`, fires only for `BOOKED_STATUSES` = deposit_paid, balance_paid, confirmed, completed; a viewed booking such as 756 saves without it), drink-plan submit and the Enhancement Lab (client-triggered, no admin confirm, through `foldExtrasIntoProposal`'s native branch, `proposalExtrasFold.js` L131-205), cancel-line, and change-request approval. To keep the conversion itself from billing anything, live bookings are converted against TODAY's catalog (section 8.2): each line absorbs the drift to date, so a client's first drink-plan submit bills only the extras, exactly as the override branch does today. Only catalog changes made after the conversion reach these bookings, which is the existing fix-list item that drink-plan submit re-prices every native booking at today's catalog. Converted bookings also become eligible for "see other packages" (today only 756), and their discount follows onto other packages like every existing discount.
- D8. Lines this spec writes carry a stable marker (section 3), so nothing depends on a label an admin can edit.
- D9. A save that would change price lines its editor never saw is refused (section 5.1), so no open tab can erase a server-written line.
- D10. Refund and agreed-price lines are not cancel-line targets (section 6).

## 3. The data shape

`proposals.adjustments` stays `[{ type: 'discount' | 'surcharge', label, amount (positive dollars), visible }]`, netted by the engine into the service total (`server/utils/pricingEngine.js` `calculateProposal`: `max(0, subtotal + net)`, client gratuity on top and never touched by adjustments). No new columns. Two optional keys are added, ignored by the engine:

- `source`: `'agreed_price'` (the Set agreed price line and every converted override line) or `'refund'` (a refund line). Absent on ordinary lines.
- `refund_id`: `proposal_refunds.id`, present only with `source: 'refund'`.

The editor round-trips both keys (`updateAdjustment` spreads the object; `addAdjustment` creates ordinary lines without them).

Server validation of `adjustments` on every writer that accepts it from a client (today only `PATCH /api/proposals/:id`; nothing validates it now): array of at most 50; `type` in the two values; `amount` finite, at least 0, below 1,000,000 (the bound the override had, `TOTAL_PRICE_OVERRIDE_MAX`, crud.js L38), with blank, null and undefined counting as 0 (the engine's reading; the editor's "+ Discount" seeds a blank amount) and no rounding; `label` a string of at most 255 characters (the `invoice_line_items.description` limit; the fix list carries the overflow); `visible` coerced to a boolean; `source` absent or one of the two values; `refund_id` a positive integer only alongside `source: 'refund'`. Violations are a ValidationError naming the field. A read-only prod census (2026-10-16) found all 72 stored lines already valid: discount or surcharge, numeric amounts, boolean `visible`, labels under 255, no other keys.

Every new reader of adjustments (builder, sanitizer, admin tag, conversion) uses the engine's own coercions (`pricingEngine.js` about L475-479): `!!adj.visible`, `Math.abs(Number(adj.amount) || 0)`, and `type === 'discount'` else surcharge. A missing `visible` means hidden, the reading the page (`ProposalView.js` L605) and invoices (`invoiceLineItems.js` L192) already use.

## 4. Client rows (tweak 2)

### 4.1 The builder

A new pure server module (working name `server/utils/clientPriceLines.js`, no DB, no Sentry import) takes a pricing snapshot and a service-total target and returns the service rows a client sees, already folded, plus what it did (gap, package or fallback).

- Row set: exactly today's public page rows (`ProposalView.js` `lineItems`, about L580-620), ported row for row with the same labels: the package row (`package.base_cost + staffing.total`, labeled with the package display name the page uses today), bar rental, every add-on including $0 ones, syrups, and the VISIBLE adjustments as signed rows with their label (fallback "Discount" / "Surcharge"). Hidden adjustments produce no row.
- Service rows only. The page keeps adding the gratuity row from `snapshot.gratuity`, as today, because `applyIntentQuote` (`intentQuote.js`) re-quotes `snapshot.total` and `snapshot.gratuity` together in client state after create-intent, and `recomputeSnapshotGratuity` moves the total by the gratuity change only.
- Fold: gap = target minus the sum of the rows, in cents. Gap 0: nothing. Package row plus gap at or above 0: the package row absorbs the gap. Otherwise the package row is unchanged and one "Pricing adjustment" row carries the whole gap.
- No `snapshot.total` (or a non-finite one), or no snapshot: no rows; the page shows its Total only, as it does today for a package-less snapshot. A snapshot with a total but no package row: rows as built with no fold (the invoice rule: `foldToContract` does not fold without a package line, `invoiceLineItems.js` L30), reported to Sentry.
- The fold decision (package or fallback) is one small pure function shared with `invoiceLineItems.js` `foldToContract`, which keeps its current behavior byte for byte (`invoiceLineItems.test.js` pins it, including the L141-151 fallback case). The two package rows differ (invoice: `base_cost` alone with staffing on its own line, `invoiceLineItems.js` L88-121; page: `base_cost + staffing.total`), so one booking can fold into the package on the page and fall back on its invoice; the conversion dry run reports both verdicts.
- Invariant, tested: when a fold applies, the rows sum to the target exactly, in cents.
- Observability: the routes that call the builder report a fallback or a gap the snapshot does not explain to Sentry, throttled, the way `reportFold` does for invoices (`invoiceLineItems.js` L216-242).

### 4.2 Proposal page

- Target: `snapshot.total - (snapshot.gratuity.total or 0)`, the service part of the total the page already shows and checkout already charges. The page's Total, pay buttons, PaymentTermsBox, SignAndPaySection, PaidCard and paidState keep their current sources; this spec does not move what the page charges.
- `buildPublicProposalPayload` (`server/routes/proposals/publicToken.js`) adds the builder's rows to the payload, and `ProposalView` renders them in place of its own `lineItems` memo. The settling state (gratuity row filtered, Total "Pending") behaves as today.
- Known drift, not fixed here: a booking whose `total_price` and `snapshot.total` disagree for reasons other than a refund (prod: 59, total $20 above its snapshot, no refund) shows the snapshot figure on the page as today, while its invoices fold to `total_price`.

### 4.3 Hidden data leaves the public payloads

Today the public proposal payload carries every hidden adjustment's label and amount (`snapshot.adjustments`, `snapshot.breakdown`, `snapshot.total_price_override`), logged on the fix list 2026-10-08.

- Goal, stated exactly: no public payload carries a hidden line's label, a hidden line's amount, the override, or the pre-fold `subtotal`. Arithmetic recovery of the hidden net is NOT prevented and is accepted: the public catalog calculator (`POST /api/proposals/public/calculate`, `public.js` L67-98) prices any configuration, the payload must keep guest count, hours, package and add-on rows with `rate` (`publicToken.js` about L288), and the options drawer returns totals and `per_guest_rate` priced with the booking's adjustments (`publicOptions.js` L225-246, L326-333).
- One sanitizer (pure, beside the builder) produces the public copy of a snapshot: `adjustments` filtered to visible, `breakdown` removed, `total_price_override` removed, `subtotal` removed, and the package price fields that feed the package row replaced by the folded package row. The plan inventories every field the public pages read from the snapshot (ProposalView and its children, SignAndPaySection, PaymentTermsBox, PaidCard, paidState, the drink plan page) and keeps only those; any read that needs an unfolded price is surfaced to Dallas, not silently kept.
- Applied on every route that hands a snapshot to a token holder: `GET /api/proposals/t/:token` (`publicToken.js`), the switch response (`publicSwitch.js`, same payload builder), and `GET /api/drink-plans/t/:token` (`server/routes/drinkPlans.js` L52, which selects `p.pricing_snapshot`). The plan greps for any other public route selecting `pricing_snapshot` or `adjustments`. Checked clean by the fleet: `compareGroup.js` (positive allowlist), create-intent responses, Lab GET, portal `shapeFocus`, change-request `price_preview` (totals only), client emails (no snapshot line items).
- Test: build each public response for a booking with a hidden discount whose label and amount are distinctive, and fail if the label, the amount, the override or the pre-fold subtotal appears anywhere in the serialized JSON.

### 4.4 Client portal

- The portal detail route (`server/routes/clientPortal.js` L102-170) selects explicit columns and returns no snapshot today (`PrescriptionTab.js` L51 says so). It changes server-side: it selects `pricing_snapshot`, runs the builder with target `total_price - (snapshot.gratuity.total or 0)` (the portal shows the row total, as invoices do), and returns the rows and the gratuity figure. It still never returns `pricing_snapshot`, and it stops returning the raw `total_price_override` (about L117).
- The Prescription tab (`client/src/pages/public/portal/tabs/PrescriptionTab.js`) renders those rows plus the gratuity row in place of its add-ons-only list, so its rows add up to its Total.
- The portal Total, archive list and summary read `total_price` (drop `COALESCE(total_price_override, total_price)` and `total_price_override ?? total_price`: `clientPortal.js` about L84, `clientPortal/summary.js` about L20, `client/src/pages/public/portal/constants.js` about L15). This fixes the latent bug where the override left gratuity out of the portal total and balance.
- `changeRequestApproved` (`changeRequestNotifications.js` about L45) reads `total_price` for the same reason.

### 4.5 Admin views tag hidden lines

`client/src/components/PricingBreakdown.js` (desktop) and `financialsOf` in `client/src/utils/eventDetailView.js` about L240 (drawn on the admin phone by `client/src/pages/mobile/EventDetailSections.js` L95-100) render `snapshot.breakdown`, which lists every adjustment with no visibility marker. Hidden adjustment rows get a small "hidden from client" tag in both.

- New snapshots: the engine adds `visible` (coerced) to each adjustment row it pushes into `breakdown` (`pricingEngine.js` about L574-580).
- Existing snapshots lack that key on breakdown rows. The tag is decided per row: adjustment rows are matched to `snapshot.adjustments` in engine order (same label fallback, same signed amount) and use the row's own `visible` when present, else the adjustment's. A missing `visible` on the adjustment means hidden, so every existing hidden line (551's four included) stays tagged with no backfill, including on an old snapshot that later gains a server-written row carrying the key (a Refund line, a converted line).

"Preview as client" (`ProposalDetail.js`) opens the real public page and needs no change.

## 5. Editor (tweak 1)

- The "Override total" block (`ProposalEditorForm.js` about L735-758) is removed.
- A third button joins "+ Discount" and "+ Surcharge": "Set agreed price". It opens one dollar input and an Apply button. Helper text: "Before gratuity. Gratuity is added on top." When the package carries staffing gratuity inside `staffing.total` (the forced Shared Gratuity on over-ratio bartenders, which payroll pools from the breakdown, `payrollMath.js` L45-54), the helper adds "Includes staffing gratuity."
- Input rules, client-side: blank, non-numeric, negative, or at or above 1,000,000 disables Apply with an inline message ("Enter a price of $0 or more"). The server bound in section 3 backs it.
- Apply computes `diff = agreed - current service total` from the live preview (`editPreview`), with the agreed-price line itself excluded: if a line with `source: 'agreed_price'` exists, its signed amount is backed out of the preview total and that line is replaced in place (label reset to "Agreed price adjustment", visibility kept as the admin left it); otherwise a new hidden line `{ label: 'Agreed price adjustment', source: 'agreed_price', visible: false }` is appended. Negative diff writes a discount, positive a surcharge, zero removes the line.
- Apply is disabled while the preview is stale or loading (`previewStale`, a null `editPreview`). The line and the new total show in the form before save.
- If backing out the existing line would cross the engine's 0 clamp, Apply refuses with a message rather than guess.
- The math lives in a pure client util with tests (beside `editorCore.js` / `formState.js`).
- Removing or lowering a line with `source: 'refund'` asks for confirmation inline in the form (no browser dialog): "This line records money already refunded. Removing it bills that amount again."
- Step 1 window (before the conversion): a booking that still carries an override shows it read-only with a note that it will convert to a line, and "Set agreed price" is disabled on it (while the override stands, the engine ignores adjustments for the service total).
- The phone edit sheet (`components/mobile/useEditSheet.js`) has no override or adjustment controls; it changes only through `patchBody.js` (no override, and the staleness field below).

### 5.1 Server PATCH (step 1)

- `patchBody.js` stops sending `total_price_override` and starts sending `adjustments_token`, the token the admin GET returned with the lines the form loaded.
- Staleness guard (keyed on the LINES, not `updated_at`: every client page view bumps `updated_at`, `publicToken.js` L336-341, so an `updated_at` check would refuse editors at random): the admin GET and the PATCH response carry `adjustments_token = md5(COALESCE(adjustments, '[]'::jsonb)::text)`. A PATCH whose `adjustments` differ from the stored lines (compared canonically after the validator's coercions) must carry the current token, else a ConflictError ("This booking changed since you opened it. Reload to see the latest.", `STALE_EDIT`). A body that leaves the lines unchanged needs no token, so partial PATCHes, the phone sheet's non-line saves and `contractDuration.extension.test.js` keep working; `RemoteStaffingFeePrompt.js` does send `adjustments` (through `buildProposalPatchBody`) and carries the token from its own GET. A server-written line (a refund, the conversion) changes the token, so a tab that saw the old lines can never write over it.
- Override: any non-null `total_price_override` that differs from the stored value IN CENTS is refused (ValidationError: overrides are retired, use Set agreed price). Pg returns NUMERIC as a string ("3373.00") and an old body may send a Number or a string, so a raw compare would refuse every save. Absent carries forward; null still clears.
- Section 3 validation of `adjustments`.
- Legal hold (section 5.3).
- Audit: when `adjustments` change, the PATCH activity entry records the old and new arrays (today it stores only `new_total`, crud.js about L670-671).

### 5.2 Change requests

Change-request approval does not re-check the client's `acknowledged_total` (`crud.js` about L711-726). A request a client acknowledged at an override-era price could be approved at a different figure after conversion. The conversion dry run lists pending change requests on every live converted booking; Dallas settles them before step 2.

### 5.3 Proposal 600 (legal hold)

Once step 3 lands the engine no longer reads the override, so any re-pricing write on 600 would move it from $3,373 to catalog. 600 is confirmed, so its state does NOT keep it out of re-pricing writers (cancel-line blocks only archived and completed, `lineItemCancel.js` L29). In step 1, before anything can re-price it:

- `foldExtrasIntoProposal` refuses legal-hold ids (one guard covering drink-plan submit, the Lab and cancel-line).
- Change-request approval, `publicSwitch`, and `PATCH /api/proposals/:id` refuse them (ConflictError, no write).
- `applyRefundReconciliation` skips the refund LINE for legal-hold ids; the money reconciliation itself runs unchanged.
- The admin GET carries a legal-hold flag and the editor and phone sheet open read-only with a note, rather than failing at save.
- The ids come from `LEGAL_HOLD_PROPOSAL_IDS` (`server/utils/staleProposalSweep.js` L47). Step 3 does not ship until every guard here is live and tested.

## 6. Refund line (tweak 3)

- In `applyRefundReconciliation` (`server/utils/refundHelpers.js`), the same transaction that lowers `total_price` by the contract portion (`contractCents`, about L565-604) appends `{ type: 'discount', label: 'Refund', amount: contractCents / 100, visible: true, source: 'refund', refund_id }` to `proposals.adjustments` and updates `pricing_snapshot` to match: the same adjustment appended to `snapshot.adjustments`, its row added to `snapshot.breakdown` where the engine would put it (after existing adjustment rows, before the gratuity row, with `visible`), and `snapshot.total` lowered by the same amount with the same 0 floor.
- Only when `contractCents > 0`. Overpayment scope and extra-scope refunds (Additional Services, extensions, extras, off-ledger labels) leave `total_price` alone today and write nothing. Skipped for legal-hold ids (section 5.3).
- Exactly once per refund: the write sits after the already-applied check (`if (done.rows[0]) return { applied: false }`, about L333), under the row lock the function already takes.
- One code path covers every caller: `server/utils/refundExecute.js` (payment panel, and Cancel event via `server/routes/proposals/cancel.js`), `server/utils/refundSweepScheduler.js` (stuck pending refunds), and `server/routes/stripeWebhookHandlers/refundCreated.js` (refunds made in the Stripe dashboard).
- Until step 3, `applyRefundReconciliation` keeps lowering the override too. On an override booking in the step 1 window the refund writes the line and lowers the override; for a live booking the conversion's fresh compute then includes the refund line, and for a terminal booking the in-place line is computed against a subtotal net of it, so the two split cleanly either way.
- Cancel-line: lines with `source` `'refund'` or `'agreed_price'` are not cancel targets (`lineItemCancel.js` L244-251 lists every adjustment as `cancellable: true` today, and `matchCancelTargets` in `PricingBreakdown.js` L11-66 puts remove buttons on them). Removing either through cancel-line would raise the total through `createAdditionalInvoiceIfNeeded` (L640-644) and bill refunded money, or the whole agreed difference, again. The editor can still change them, with the section 5 warning on refund lines.
- Out of scope, already on the fix list (refundHelpers.js comment, 2026-08-25): a refund larger than the service total, which can only happen when it reaches into gratuity, clamps at 0 and a later re-price bills the gratuity part again.

## 7. Invoice display (tweak 4)

Display only (D5). Computed on the server in `GET /api/invoices/t/:token` (`server/routes/invoices.js` L27-180), which returns a `contract_step` object or null; `client/src/pages/invoice/InvoicePage.js` renders it in the totals block (about L362-377).

- Shown only when all hold: the invoice label is Deposit, Balance or Full Payment; the sum of its stored lines equals `proposals.total_price` to the cent (the lines describe the current contract exactly); and `diff = sum(lines) - amount_due` is positive.
- The equality gate is what keeps the step honest. It excludes every invoice whose lines are not the current contract: invoices minted before the fold landed (lane invoice-lines, `3e71a01c`, 2026-10-09), whose lines carry unfolded catalog prices on override bookings; a locked invoice after a contract refund, which lowers its `amount_due` but not its lines (`refundHelpers.js` about L489-516); an invoice locked before a later price edit; and a Full Payment that kept the Deposit's old lines (`invoiceLifecycle.js` about L517-521). Those render exactly as today.
- Rows: "Contract Total" (the line sum), the step row at `-diff`, "Invoice Total" (`amount_due`), then Amount Paid and Balance Due as today. Step label by type: Deposit "Balance, billed later"; Balance "Less deposit and earlier payments"; Full Payment "Less payments already received".
- No new information leaves: the contract total is the sum of rows the page already shows.
- Every other invoice is unchanged: Additional Services, Service Extension, extras, manual invoices under other labels, and the Check Cherry balance invoices that already carry a "less deposit" line (their diff is 0).
- Known edge, sent to the fix list rather than fixed here: the manual-invoice route rejects only off-ledger labels (`invoices.js` L258-266), so an admin can mint a manual "Balance"; the lifecycle refresh already treats such an invoice as its own and rewrites its amount, and the equality gate keeps the step off it unless its lines happen to equal the contract.
- The PDF (html2pdf of the same DOM) and the print view inherit it; the plan checks the print CSS (`client/src/index.css`, `.invoice-page` print rules about L10541).
- Why display only: `invoice_line_items` and `amount_due` feed `balanceInvoiceMonitor.js`, the line-sum guard in the deposit-to-full upgrade, and refresh. None of them change.

## 8. The conversion (step 2)

### 8.1 Scope (prod census 2026-10-16, re-verified in the dry run)

- Override bookings: 38 rows; all except 600 convert, 37 rows.
  - Live (status not archived or completed): 606, 607, 608 (confirmed), 756 (viewed). Priced against today's catalog (8.2).
  - Terminal: 23 archived and 10 completed. Converted in place (8.3).
- Refund backfill candidates: every non-hold booking with a succeeded contract-scope refund. Today seven carry an unbilled gap equal to their refunds: 847, 500, 54, 439, 595, 633, 784 (8.4).
- Excluded: every id in `LEGAL_HOLD_PROPOSAL_IDS` (600). Not touched: drift with no matching refund (59).

### 8.2 Live override bookings: priced against today's catalog

- The fold's input loading and catalog engine call (`proposalExtrasFold.js`: the package row, `REPRICE_ADDON_SQL` add-ons through `withRepriceQuantities`, syrups, contract hours via `contractDurationHours`, gratuity rate, tip jar, mandate floor) are extracted into one shared function that the fold keeps calling and the conversion calls too. Not a copy: a test pins that the conversion's compute equals the fold's for the same inputs.
- Run against a Neon branch of prod created for the conversion through the Neon API with `NEON_API_KEY` (the push gate's mechanism, `scripts/testdb-smoke.js`), never the `ci-smoke` branch the gate resets, and never while a push is running. The branch doubles as the point-in-time rollback copy and is kept until Dallas confirms the result.
- `line = total_price_override - freshServiceTotal`, where `freshServiceTotal` is the engine's service total (before client gratuity) for the booking's current inputs, current adjustments and no override. The new snapshot is that same compute with the line appended. Gate: the new `snapshot.total` equals `total_price` to the cent.
- The line: `{ type: line < 0 ? 'discount' : 'surcharge', label: 'Agreed price adjustment', amount: |line|, visible: false, source: 'agreed_price' }`; none when the line is 0.
- What it changes: the saved line prices of these four bookings move to today's catalog; the total, amount paid, status and invoices do not. Measured against the stored subtotal on 2026-10-16, 606 came to a $162 discount, 756 $100, and 607 and 608 even; the fresh compute may differ, and the dry run shows each booking's catalog drift (fresh service total against the stored snapshot's), which is exactly what the conversion absorbs.

### 8.3 Terminal override bookings: in place

- `line = total_price_override - max(0, snapshot.subtotal + net(adjustments))`, in cents, using the ROW's override (527 and 599 had refunds lower the row's override without updating the snapshot).
- The row's `adjustments` and the snapshot's copy must match (group clones copy `pricing_snapshot` but not `proposals.adjustments`, `proposalGroups.js` L28-41, so they can differ). A mismatch is not guessed at: the row is skipped and listed for Dallas.
- Same line shape as 8.2. On 2026-10-16 figures, 24 of the 33 get a line (all discounts) and 9 come out even (551, 574, 575, 596, 597, 601, 602, 605, 629).
- Snapshot synced in place: `adjustments` replaced, the new row added to `breakdown` where the engine would put it (with `visible`), `total_price_override` null, `total` set to `total_price`. Line prices are untouched. Why in place: payroll reads completed bookings' breakdown (`payrollMath.js` L45-54), and their history should not move. A later editor save on a completed booking shows the reprice confirm; an archived booking would re-price silently if edited, which is accepted for dead rows.
- 527 and 599: their refunds stay folded into the hidden agreed-price line rather than a visible Refund line (both completed), an accepted exception to D4.

### 8.4 Refund backfill

- Lines are matched to refunds one by one. Each succeeded contract-scope refund with a logged drop (`total_price_before - total_price_after`) above 0 and no line carrying its `refund_id` gets `{ type: 'discount', label: 'Refund', amount: drop, visible: true, source: 'refund', refund_id }`, but only when the booking's snapshot gap (`snapshot.total - total_price`) equals the sum of the drops being backfilled. Snapshot synced in place as in 8.3.
- Refunds on a booking that still carries an override at conversion are absorbed by its agreed-price line (8.2, 8.3: computed from the ROW's override, which the refund already lowered) and are never backfilled; 527 and 599 are the prod cases. The confirmation query counts them as covered.
- Listed for Dallas instead of written: a booking whose gap is 0 although a refund has no line (the refund was likely billed again by an editor save; the list shows any Additional Services invoice minted after the refund), and a booking whose gap is positive but not equal to the unbacked refunds. The fix-list refund item closes only for bookings the backfill writes.

### 8.5 Gates and mechanism

- The data never passes through a chat or an MCP result. A fresh Neon branch of prod is cut through the Neon API (`NEON_API_KEY`, as the push gate does; never the gate's own `ci-smoke` branch, never while a push runs); the export runs over `pg` against that branch and writes JSON to the session scratchpad; the fresh compute for live rows runs there too.
- A pure transform in the repo (tested) computes the change set and emits (a) the dry-run report, (b) the forward DO block, (c) a reverse DO block. A missing `snapshot.gratuity` counts as 0.
- Dry-run report, per booking: id, status, kind, the line(s), the catalog drift (live rows), the page and invoice fold verdicts (package or fallback), and pending change requests (live rows). Plus the Dallas lists from 8.3 and 8.4.
- The forward block is compact: `SELECT ... FOR UPDATE` on every target row first; each row guarded by an md5 of its money columns (`total_price`, `amount_paid`, `status`, `total_price_override`, `adjustments`, `pricing_snapshot`) captured at export, compared with IS DISTINCT FROM (never `updated_at`, which page views move); in-place rows written with jsonb operations, live rows with their full after-snapshot; each write's row count asserted with GET DIAGNOSTICS; then, inside the block, `adjustments` must equal `pricing_snapshot->'adjustments'`, the engine arithmetic recomputed from the written JSON (`max(0, subtotal + net) + gratuity`) must equal `total_price`, and `pricing_snapshot.total` must equal `total_price`; one `proposal_activity_log` row per booking (`price_override_converted`, `refund_line_backfilled`, system actor). Any failure aborts everything. The reverse block restores the money columns only (never `updated_at`), guarded on the after-state md5.
- The rendered SQL gets its own review pass (`database-review`, `consistency-check`) before Dallas's go. Immediately before running, the branch is re-cut and the change set re-derived; an identical change set runs under his go, a different one goes back to him.
- After it, a read query confirms: no overrides outside the legal-hold list; every converted or backfilled row has `snapshot.total` equal to `total_price`; every non-hold contract refund has a line, sits on an override-absorbed booking, or is on Dallas's list.
- The repo is public: the report and both blocks carry free-text labels, so they live only in the session scratchpad and are never committed. Test fixtures use synthetic labels and amounts.
- Before prod, the whole pipeline is rehearsed on a branch of the dev database with synthetic rows of every shape.

### 8.6 Timing

Step 2 runs after step 1 is live (no new override can be written, every new refund writes its line, the staleness guard and the legal-hold guards are in). Step 3 ships only after step 2's confirmation query is clean.

## 9. Override code removal (step 3)

The engine stops reading `total_price_override` (`serviceTotal = calculatedTotal`), and every consumer drops it:

- Server: `pricingEngine.js`; `routes/proposals/crud.js` (destructure, bounds check, `TOTAL_PRICE_OVERRIDE_MAX` (its bound moves to the section 3 adjustment validation), UPDATE column $16; the step 1 refusal becomes "field not accepted"); `routes/proposals/metadata.js` (/calculate); `utils/proposalExtrasFold.js` (the override branch, leaving the shared compute function); `utils/refundHelpers.js` (the override CASE in the money UPDATE and its comment); `utils/changeRequests.js`; `utils/changeRequestNotifications.js`; `utils/serviceExtensionPricing.js` (the SELECT at L120 and its comment); `routes/proposals/publicToken.js` (the `optionsAvailable` override condition at L238 and the delete); `routes/proposals/publicOptions.js` (`notComparable('custom_pricing')`); `routes/proposals/publicSwitch.js` (the refusal); `routes/proposals/optionsPricingShared.js` (SELECT); `routes/clientPortal.js`, `routes/clientPortal/summary.js`.
- Client: `pages/admin/proposalEditor/{formState.js, patchBody.js, editorCore.js, ProposalEditorForm.js}`; `pages/public/portal/constants.js`.
- Scripts: delete `scripts/cc-transfer-events.js`, its test `scripts/cc-transfer-events.test.js` (it requires the script), and `scripts/cc-balance-invoice.js`.
- Tests: about 23 test files reference the override; each is updated or its override case deleted.
- `schema.sql` (about L1326): the column stays, with a comment that it is retired and holds only legal-hold data.
- `invoiceLineItems.js` keeps its fold (hidden adjustments still need it); comments that name the override are updated.
- The plan greps `total_price_override` across `server/`, `client/src/`, `scripts/`, `docs/` and the root `*.md` files (excluding history docs) and accounts for every hit.

### 9.1 Docs (Mandatory documentation table)

- ARCHITECTURE.md: the override rows and feature text (about L355, L378, L379, L412, L1150, L2084), the CC transfer script (about L1878), the schema note that the column is retired, the route-table notes for the changed responses (`GET /api/proposals/t/:token`, `GET /api/drink-plans/t/:token`, the portal detail route, `GET /api/invoices/t/:token`), and the new server utils.
- README.md: the folder tree (`cc-transfer-events.js` about L752 out; the new server utils, the new client util, and the conversion transform script in).

## 10. Testing

- Builder: fold into the package, the fallback, no package row (no fold, reported), no snapshot total (no rows), visible rows signed and labeled, $0 add-ons kept, rows sum to the target, cents rounding, engine coercions on legacy string or odd-type rows.
- Sanitizer and leak test (section 4.3) on every public route that returns a snapshot.
- Admin tag: new snapshots, and existing snapshots with no `visible` on breakdown rows (matched from `snapshot.adjustments`).
- Agreed-price util: new line, replace in place by `source`, discount vs surcharge, zero removes, stale preview disabled, clamp refusal, input rules.
- PATCH: staleness guard (refused on mismatch, accepted on match at millisecond precision, required with adjustments, partial bodies unaffected); override refused when changed and accepted when equal in cents (string and Number); adjustment validation; activity entry with old and new arrays.
- Legal hold: each guard in section 5.3 refuses 600 and writes nothing; the refund line is skipped for it.
- Refund: a contract refund writes exactly one line with `source` and `refund_id` and syncs the snapshot; overpayment and extra-scope refunds write none; a repeat reconciliation writes nothing; an open editor tab is refused afterwards; the step 1 override-booking case.
- Cancel-line: refund and agreed-price lines are not targets; ordinary lines still are.
- Regression for the original bug: on a converted booking, adding an hour in the editor raises the total by the hour's price.
- Drink-plan submit on a live converted booking (fixture) bills only the extras.
- Invoice step: each label, the equality gate (pre-fold lines, a refunded locked invoice, a later price edit), diff 0, non-contract labels.
- Conversion transform: a synthetic fixture per shape (live fresh compute, terminal plain override, existing adjustments, 527/599-style drift, an even row, a refund backfill with more than one refund, a step-1 refund that already has its line, gap 0 and unequal gap lists, snapshot/row mismatch skip, 600 skipped, 59 skipped); the shared compute equals the fold's; the DO blocks reject a tampered before-state and a NULL mismatch; the reverse block restores.
- Money smoke suites at push (`npm run gate`).
- Walkthroughs added to `docs/walkthroughs-owed.md`: the proposal page for a hidden-discount booking, the portal Prescription tab, a Deposit and a Balance invoice (screen and PDF), "Set agreed price", the stale-tab refusal, and a refund on a dev booking (dev talks to live Stripe: the smallest real amount on a booking Dallas names, or skip and rely on the unit tests).

## 11. Review

Money and public-payload paths: the full fleet per lane before merge, `/second-opinion` and the money smoke gate at push. The conversion's transform and DO blocks get their own review pass before they run on prod.

## 12. Fix-list links

- "Advance duration change on a booking with an override adds $0": superseded 2026-10-14, closed by step 3.
- "A contract refund on a booking with no override is billed again by the next editor save": closed by section 6 and, for existing bookings, by the backfill rows it writes; bookings on Dallas's 8.4 list stay open until he settles them.
- "The public proposal route hands the browser hidden adjustments and the override": closed by section 4.3 (labels, amounts, override and subtotal; arithmetic recovery accepted).
- New, for the fix list: the manual-invoice route accepts the contract labels Deposit, Balance and Full Payment (section 7).
