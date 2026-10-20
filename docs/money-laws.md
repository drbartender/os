# Money laws

The money rules that used to live only in memory glosses, each with the code it lives in. Read this before touching a money path. Every law carries a provenance bracket: `[Dallas <date>]` when he decided it, `[Claude default]` when Claude derived it from a defect. A "checked against code" line is written only after a verify pass read the law against the code it points to; a ledger defect id on that line means the code contradicted the law on that day.

Ids only in this file: no client or staff name, email or phone number.

## 1. The retainer survives full payment

Rule: a client who signed deposit terms and then paid the whole contract still forfeits the retainer (the proposal's stated `deposit_amount`) on a client cancel more than 14 days out. The retainer is read off the invoice-upgrade breadcrumb (`invoice_upgraded_to_full` or `invoice_backfilled_to_full`, as `LEAST(amount_paid, details.from_amount_due)`), never off the invoice label alone, because the Deposit row is relabeled Full Payment before a full payment credits. A native Full Payment invoice (full terms from the start) has no breadcrumb and no retainer.

Code: `server/routes/proposals/cancel.js:assembleContext` (the retainer read is a LATERAL join near line 127, with a fallback to the stated deposit when the breadcrumb carries no numeric amount); the breadcrumb writers `server/utils/invoiceLifecycle.js:upgradeDepositInvoiceToFull` and `server/scripts/backfillFullPaymentInvoices.js`. Pinned by `cancel.test.js` (four preview cases).

Source: memory `project-retainer-survives-full-payment`; spec `docs/superpowers/specs/2026-08-28-post-payment-settle-and-full-pay-invoice-design.md`.

Provenance: `[Dallas 2026-08-28]`

Checked against code 2026-10-20: pass (verify pass, Fable, after one pointer correction: the retainer read is a LATERAL join with a fallback to the stated deposit when the breadcrumb carries no numeric amount).

## 2. `acknowledged_total` is row truth; create-intent's total is a projection

Rule: the sign endpoint asserts the client's `acknowledged_total` against the persisted row (`ABS(total_price - $14::numeric) < 0.005`), so the client must send the row's `total_price`, never a computed or previewed figure. `POST /stripe/create-intent/:token` returns a `total_price` that includes the tip-jar election and persists no money (it writes `payment_type`, `autopay_enrolled` and a default `balance_due_date` only, and builds its response from in-memory values), so its total is a projection: client-side it belongs in `pricing_snapshot.total` (what the page renders) and stays off `proposal.total_price` (what the signature acknowledges). A failed assertion blocks the charge entirely, with no Stripe decline to see.

Code: `server/routes/proposals/publicToken.js` (the `POST /t/:token/sign` handler, assertion near line 545); `client/src/pages/proposal/proposalView/intentQuote.js:applyIntentQuote` (the one place the projection merges into the snapshot, with a regression test); `client/src/pages/proposal/proposalView/ProposalView.js` (handleSign sends `Number(proposal.total_price)`).

Source: memory `reference-acknowledged-total-is-row-truth`; spec 2026-08-03 (election at payment).

Provenance: `[Claude default 2026-08-28]`

Checked against code 2026-10-20: pass (verify pass, Fable, after one wording correction: create-intent writes `payment_type`, `autopay_enrolled` and a default `balance_due_date`, never money).

## 3. A `?paid=true` load never renders money

Rule: Stripe's `return_url` lands the client on `/proposal/:token?paid=true` about one second after the `payment_intent.succeeded` webhook transaction starts and before it commits, on every full-payment conversion measured (five of five, 2026-08-28). No post-payment surface may render money from a row read on that load without confirming the webhook has landed (poll `payment-state` until the status is a paid state, or render from the redirect's own PaymentIntent amount). The flag proves a charge happened, never the row's numbers.

Code: `client/src/pages/proposal/proposalView/paidState.js` (row truth for the paid card and the Payment Terms box; `PAID_STATES`); `server/routes/proposals/publicToken.js` (`GET /t/:token/payment-state`, the poll); `client/src/pages/plan/components/PaymentReturnNotice.js` (the drink-plan return, same rule).

Source: memory `reference-post-payment-redirect-races-webhook`.

Provenance: `[Claude default 2026-08-28]`

Checked against code 2026-10-20: pass (verify pass, Fable; `paidState.js` reads the row never the URL, the poll is `GET /t/:token/payment-state`, the drink-plan return notice renders no amount).

## 4. Frozen rates beat the live catalog

Rule: when a price for a row that is already sold (signed, paid, intent created, accrued) is computed, every factor comes from the row or its snapshot: `proposal_addons.rate`, `billing_type`, `variant`, `quantity` and `line_total` under the `pa.` alias, the snapshot's per-addon extra-hour rate, the package extra-hour rate the client signed under (which the snapshot does not hold today) and the signature version, the payout line's `rate_cents`, the PaymentIntent metadata for the gratuity election and its floor. A fresh read of `service_addons`, `service_packages` or `contractor_profiles` prices new quotes only; feeding one into a `line_total`, a delta, a snapshot rewrite or a settle-time guard for an existing row is a defect, and where a frozen value is seeded once from a live source, something must compare the two afterwards and alert on disagreement.

Code, where the law holds: `server/utils/lineItemCancel.js` (both cancel-line queries dispatch on the frozen `pa.billing_type` and read `pa.quantity`, the first also `pa.line_total`; they never read a catalog rate, though they join the live `service_addons` row for `slug` and `minimum_hours`); `server/utils/addonQuantity.js:storedToInputCount` (a `per_guest` count is recovered from the row's own `rate` and `line_total`, never the catalog rate, because rates drift); `server/utils/payrollAccrual.js` (a payout line keeps the prior line's `rate_cents`, near line 444); `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (the gratuity rate and jar answer come from `intent.metadata`, near lines 200 to 260).

Code, where the law is broken today (open defects, cited on the checked line): `server/utils/proposalExtrasFold.js:REPRICE_ADDON_SQL` selects `sa.*`, so `withRepriceQuantities` uses the `pa_rate` and `pa_line_total` aliases only to recover the count and the fold prices an existing row at the live catalog rate and `billing_type`, dropping `variant`; `server/utils/serviceExtensionPricing.js:computeExtensionDelta` prices the delta from the live `service_packages` row (the comment says "at CATALOG") through `pricingEngine.extraHourCharge`, reading no signature version, and `server/utils/additionalTimeRate.js` prints the added-time rate on the signed proposal from the same live row; the lab and drink-plan submit upserts price an upserted add-on line from a live `service_addons` row selected inside the transaction (`rate = EXCLUDED.rate`); the webhook validates the gratuity floor against the current row rather than the floor the intent was created under.

Source: `docs/superpowers/specs/lens-audit/checks-money-seam.md` check 3 (ten defects behind it); the old project CLAUDE.md money section.

Provenance: `[Claude default]`

Checked against code 2026-10-20: the code contradicts this law at the fold, the extension delta and the printed added-time rate, the lab and submit upserts, and the webhook floor check, exactly as the "broken today" paragraph describes (verify pass, Fable, three rounds; the paragraphs were corrected to the code each round). Open defects in `docs/superpowers/specs/lens-audit/defects.jsonl`: D0939, D0950, D1009, D1012, D1087, D1090, D1110; D1071 is the related seeded-once case in payroll. The "where the law holds" paragraph is verified true.

## 5. The label partition: five constant sets, and a label is neither a semantic nor a key

Rule: invoice labels fall into five frozen sets and every expression that subtracts or divides across `amount_paid`, `total_price`, `external_paid` or an invoice sum must name which set each side sums and use the same partition on both sides. The sets: `CONTRACT_LABELS` (Deposit, Balance, Full Payment: a refund-scope classification); `TOTAL_TRACKING_INVOICE_LABELS` (Balance, Full Payment: the demand `refreshUnlockedInvoices` recomputes from `total_price` on every reprice); `IN_TOTAL_PRICE_LABELS` (Deposit, Balance, Full Payment, Additional Services, Enhancement Lab: every label whose collected money is inside `total_price`; not the same thing as `CONTRACT_LABELS`, and confusing the two under-refunded a client by $300 in a 2026-07-28 review); `DELTA_LABELS` (Additional Services, Enhancement Lab, and conditionally Drink Plan Extras: the open delta invoices a cancel must shrink); `OFF_LEDGER_INVOICE_LABELS` (money entirely outside `total_price` and outside `amount_paid`; law 7). Drink Plan Extras and free-text manual invoices are a third kind: collected into `amount_paid` but outside `total_price`, netted out of any overpayment test by `sumOffContractPaidCents`. Whether an invoice's money sits inside `total_price` is read from stored provenance (`invoice_line_items.source_type`: package, addon, fee, manual), never from the label string, never from a closed list applied to a route that accepts free-text labels, and never as "everything not off-ledger". A line, invoice, cancel target, retainer or refund leg is matched by id, never by label text and never by amount equality.

Code: `server/utils/proposalMoneyShared.js` (`CONTRACT_LABELS`, `OFF_LEDGER_INVOICE_LABELS`, `TOTAL_TRACKING_INVOICE_LABELS`, with the header that explains each); `server/utils/invoiceExtras.js:IN_TOTAL_PRICE_LABELS`; `server/utils/lineItemCancel.js:DELTA_LABELS`; `server/utils/invoiceLineItems.js` (the `source_type` writers); `server/utils/refundHelpers.js:applyRefundReconciliation` (the contract-vs-extra scope split). Enhancement Lab left the off-ledger set on 2026-07-20 when lab additions began folding into `total_price` (owner decision), so a lab invoice is ordinary contract money.

Source: `docs/superpowers/specs/lens-audit/checks-money-math-catalog-contract.md` MM-2; `checks-money-seam.md` check 8.

Provenance: `[Claude default; the lab fold is Dallas 2026-07-20]`

Checked against code 2026-10-20: pass (verify pass, Fable, after the set members were corrected to what the code defines; the third kind, collected into `amount_paid` but outside `total_price`, was added).

## 6. The addon quantity column has a shape

Rule: `proposal_addons.quantity` stores the pricing engine's computed display quantity, not the admin's input count, and the two differ for every billing type except `flat`: `per_guest` and `per_guest_timed` store the guest count, `per_hour` stores `effectiveHours x count`, `per_staff` the staff count, `per_100_guests` the block count, `flat` or unknown the input count. Feeding the stored value back to the engine multiplies a second time. The one sanctioned server-side inverter is `storedToInputCount`, called with the row's contract hours; a caller that needs a `per_guest` count also passes the row's own `rate` and `line_total` (the fold does), while the cancel-line picker deliberately passes neither, gets null for `per_guest`, and removes the whole line. Never hand-roll it (it handles the additional-bartender slug's raw-duration divisor, a NULL `billing_type`, zero duration, and `per_guest` recovery from the row rather than the catalog).

Code: `server/utils/addonQuantity.js:storedToInputCount` (header carries the full table); callers `server/utils/proposalExtrasFold.js`, `server/utils/lineItemCancel.js`, `server/routes/proposals/optionsPricingShared.js`; client twin `client/src/pages/admin/proposalEditor/formState.js:recoverAddonQuantities`.

Source: memory `reference-addon-quantity-column` (three money bugs on this column: 2026-07-20, 2026-07-26, 2026-08-11).

Provenance: `[Claude default 2026-07-26]`

Checked against code 2026-10-20: pass (verify pass, Fable, after the caller wording was corrected: the cancel picker passes neither `rate` nor `line_total` by design and removes a `per_guest` line whole).

## 7. Off-ledger invoice labels join `OFF_LEDGER_INVOICE_LABELS`

Rule: an invoice label whose money lives entirely outside `proposals.total_price` (an invoice-only upsell that never touches the contract) must be in `OFF_LEDGER_INVOICE_LABELS`, or paying it forgives the contract by its amount: the webhook would roll its payment into `amount_paid`, the Balance refresh would count its locked invoice in `lockedTotal`, and refund reconciliation would lower the contract. Three seams read the set and joining it is the whole wiring. Today the set holds exactly one label, Service Extension. Additional Services does not belong there (its money is inside `total_price`); Drink Plan Extras and free-text manual invoices do not either, for the opposite reason: their money is outside `total_price` but the webhook rolls it into `amount_paid` and `sumOffContractPaidCents` (`server/utils/invoiceExtras.js`, near line 316) nets it out of the overpayment test, so it must stay on the `amount_paid` side where off-ledger money never is.

Code: `server/utils/proposalMoneyShared.js:OFF_LEDGER_INVOICE_LABELS`; the three seams `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (the invoice branch's `amount_paid` roll-up skip near line 355), `server/utils/refundHelpers.js:paymentIsOffLedger` read by `applyRefundReconciliation` and `refundCreated.js`, `server/utils/invoiceLifecycle.js:refreshUnlockedInvoices` (the `lockedTotal` exclusion); `server/utils/balanceInvoiceMonitor.js` alerts on either direction.

Source: memory `reference-off-ledger-invoices` (which still names Enhancement Lab as the member; the code moved on 2026-07-26); spec 2026-07-25 D12 for the extension label.

Provenance: `[Claude default 2026-07-20]`

Checked against code 2026-10-20: pass (verify pass, Fable, after the Drink Plan Extras reason was corrected: its money is outside `total_price`, rolled into `amount_paid` and netted by `sumOffContractPaidCents`; the set holds Service Extension alone and all three seams read it).

## 8. The paid flag is `amount_paid` against `total_price`, never status or payment type

Rule: a proposal is paid when `amount_paid` reaches `total_price`. `amount_paid` already carries `external_paid` (money collected off-platform is written to both columns, with no payment row behind it), so the test is `amount_paid >= total_price` and the status that follows is derived from that comparison: inline in the webhook's UPDATE, and by `reconcileProposalPaymentStatus` on every reprice or refund, in both directions. An invoice demand nets `external_paid` out of `total_price`. No surface or derivation reads `status` or `payment_type` alone as the paid flag, and every credit to `amount_paid` adds the amount Stripe actually captured, never `= total_price` or `= deposit_amount`.

Code: `server/utils/proposalStatus.js:reconcileProposalPaymentStatus` (pure; the ladder and its fail-closed guards); `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (`COALESCE(amount_paid,0) + $2 >= total_price` near lines 286 and 309); `server/utils/invoiceLifecycle.js:refreshUnlockedInvoices` (Full Payment = total minus external, Balance = total minus external minus locked); `scripts/cc-transfer-events.js` (writes `external_paid` and `amount_paid` together); `client/src/pages/proposal/proposalView/paidState.js`.

Source: `docs/superpowers/specs/lens-audit/checks-money-seam.md` check 6 (twelve defects behind it); the old project CLAUDE.md "Proposal price changes" line.

Provenance: `[Claude default]`

Checked against code 2026-10-20: pass (verify pass, Fable; the webhook credits `amount_paid + captured` and derives status inline, `reconcileProposalPaymentStatus` runs on the PATCH reprice, on refund, on the fold and on the public switch, external money is written to both columns and netted out of the invoice demand).

## 9. Refund scope: the overpayment allowance is headroom plus contract slack

Rule: a refund is either contract scope (lowers `total_price`) or overpayment scope (returns excess and moves neither `total_price` nor the override). An overpayment refund may be funded from two things, and naming only one breaks it in one direction: the uncredited headroom on the charge (`linkPaymentToInvoice` caps an invoice credit at the invoice's remaining due while the webhook rolls the whole intent into `amount_paid`), plus `contractInvoiceSlackCents` (how much the Deposit, Balance and Full Payment invoices still demand beyond `total_price` after a reprice down). Money taken outside Stripe (`external_paid`) funds neither and is refused with `OVERPAYMENT_NOT_ON_A_CHARGE`. The netted overpayment is `amount_paid - total_price - sumOffContractPaidCents`, never the raw difference, and the cap is asserted under `FOR UPDATE` on the proposals row. Never tell an admin "not overpaid" while a refund is in flight.

Code: `server/utils/refundHelpers.js` (`nettedOverpaymentCents`, `uncreditedHeadroomCents`, `contractInvoiceSlackCents`, `offContractPaidCents`); `server/utils/refundExecute.js` (the `OVERPAYMENT_NOT_ON_A_CHARGE` refusal); `server/routes/stripeWebhookHandlers/refundCreated.js` (dashboard refunds reconcile through `refund.created`, headroom plus slack near line 193); `server/routes/proposals/getOne.js` (`overpayment_cents`).

Source: memory `reference-refund-scope-rules`; spec 2026-09-15.

Provenance: `[Claude default 2026-09-15]`

Checked against code 2026-10-20: pass (verify pass, Fable; overpayment is `max(0, paid - total - offContract)`, the allowance sums headroom and slack under `FOR UPDATE`, off-ledger payments are refused with `OVERPAYMENT_NOT_ON_A_CHARGE`).

## 10. The hosted 1:100 bartender ratio

Rule: hosted (per-guest) packages include bartender staffing in the per-guest rate at one bartender per `pkg.guests_per_bartender` guests (default 100), so bartenders within the ratio are $0 line items with $0 gratuity, and bartenders above it, whether added through the `num_bartenders` override or the `additional-bartender` add-on, are charged at `pkg.extra_bartender_hourly` (default $40 an hour) plus the same sub-100-guest gratuity surcharge BYOB uses. Use `isHostedPackage(pkg)` and `staffing.required` from `calculateStaffing`, and only zero the charge for the first `staffing.required` bartenders. Hosted packages with `bar_type = 'class'` are the one exception: every bartender charge and surcharge is zeroed. Grep `isHostedPackage` before adding any bartender-cost code path; this rule has been re-lost more than once.

Code: `server/utils/pricingEngine.js:isHostedPackage` (header comment carries the rule and the class exception) and `calculateStaffing`; `server/utils/invoiceLineItems.js` for the invoice side (the extra-bartender line near line 104 bills `snap.staffing.extra` at `snap.staffing.total`).

Source: memory `feedback_hosted_bartender_rule`; the old project CLAUDE.md "Hosted-package bartender rule" line.

Provenance: `[Dallas 2026-05-14]`

Checked against code 2026-10-20: pass (verify pass, Fable, after the invoice pointer moved to `invoiceLineItems.js` and the class exception was added; defaults 100 and $40 and the 50/25/15 surcharge match the engine).

## 11. Owner no-draw payouts

Rule: the owner works events but takes no payout. A contractor whose `contractor_profiles.takes_draw` is false gets a payout born `no_draw` (user 12 only today): tracked and line-editable, excluded from owed, paid and 1099 totals, and never blocking a period close. Every payout-creation path goes through `ensurePayout`, never an inline INSERT, and the toggle-draw route refuses to park anyone whose `takes_draw` is true (server-side authority, not a render gate).

Code: `server/utils/payrollProcessing.js:ensurePayout`; `server/routes/admin/payroll.js` (the toggle-draw guard near line 653); `server/utils/payrollAccrual.js` (accrual reaches `takes_draw` only through `ensurePayout`, near line 462).

Source: memory `project-owner-no-draw-payouts`; spec `docs/superpowers/specs/2026-08-07-owner-no-draw-payouts-design.md`.

Provenance: `[Dallas 2026-08-07]`

Checked against code 2026-10-20: pass (verify pass, Fable, after one pointer correction: accrual reaches `takes_draw` through `ensurePayout`, the sole payout INSERT; the toggle-draw guard refuses to park a draw-taker; which user is flagged is database state, not code).

## 12. Which pay period is now is `chicagoTodayYmd()`, never SQL `CURRENT_DATE`

Rule: the Postgres session runs at GMT, so `CURRENT_DATE` is the UTC day and rolls over at 19:00 Chicago (18:00 in winter). Every "which period is now" lookup in the payroll family takes the Chicago business day as a bound parameter (`WHERE $n::date BETWEEN pp.start_date AND pp.end_date`) fed from `chicagoTodayYmd()`. A pay-period boundary is a DATE boundary: a day string, never a timestamp comparison. Test such a route under both `TZ=UTC` and `TZ=America/Chicago` through its injection seam, mounting the real router.

Code: `server/utils/businessTime.js:chicagoTodayYmd`; `server/routes/staffPortal.js` (`GET /staff-home`, the day passed in through `_deps.today`); `server/routes/admin/payroll.js`; `server/routes/admin/staffHub.js`.

Source: memory `reference-pay-period-boundary-current-date` (the 2026-08-19 defect, lane `pay-period-boundary`).

Provenance: `[Claude default 2026-08-19]`

Checked against code 2026-10-20: pass (verify pass, Fable; the period lookups bind a Chicago day through `_deps.today` or `chicagoTodayYmd`, and no live `CURRENT_DATE` remains in the payroll routes).

## 13. The stale-proposal sweep never adds `accepted` to its statuses

Rule: the hourly sweep archives past-dated, never-booked proposals in `draft`, `sent`, `viewed` or `modified` as `event_passed`. `accepted` stays out of `SWEEP_STATUSES` because `reconcileProposalPaymentStatus` demotes a fully refunded proposal to `accepted`, so such a row has `amount_paid = 0` and a real payment history; sweeping it would stamp a refunded booking as a lead that never booked. Past-dated `accepted` rows are emailed to an admin instead, send before mark. `event_completed` has zero writers and must keep them.

Code: `server/utils/staleProposalSweep.js:SWEEP_STATUSES` (the header above it carries the reasoning); `server/utils/proposalStatus.js:reconcileProposalPaymentStatus` (the `paidCents <= 0` arm).

Source: memory `project-stale-proposal-sweep`; spec `docs/superpowers/specs/2026-08-20-stale-proposal-sweep-design.md`.

Provenance: `[Claude default 2026-08-20]`

Checked against code 2026-10-20: pass (verify pass, Fable; `SWEEP_STATUSES` excludes `accepted`, past-dated accepted rows are marked only after the email went out, `event_completed` has no writers).

## 14. Gratuity

Moved verbatim from the "Checkout gratuity" paragraph of the project CLAUDE.md on 2026-10-20 (em dashes replaced by commas or colons, no other change).

Rule: gratuity is stored as a per-staff-per-hour RATE (`gratuity_rate`); the dollar line is always computed (`rate × staffCount × hours`, staff = bartenders + additional-bartender addon, NOT barbacks/servers) and layered on top of the forced `"Shared Gratuity"` surcharge. Added on top of `total_price` (never diluted by a discount/override), pooled with the forced surcharge in payroll (both labels via `gratuityLabels.GRATUITY_PAYROLL_LABELS`), and gated on funded before accrual. Applies to all packages via `staff_noun`. Labels come from the one shared constant module (`gratuityLabels.js`, server + client mirror). The no-jar floor (rate ≥ 50) is enforced at the route (`deriveGratuityRate`), in the engine, and by a DB CHECK; an admin mandate (below) REPLACES that floor on both jar answers (the CHECK's third disjunct), never stacks on it. The Stripe webhook records the amount actually charged (additive), never `= total_price`. Aside from an admin mandate, the election persists ONLY at payment: `create-intent` computes it in memory and stamps `tip_jar`/`gratuity_rate` into PaymentIntent metadata; the `payment_intent.succeeded` webhook applies it (before the Balance invoice, `FOR UPDATE` on the proposal row, under the PAYABLE status guard `sent`/`viewed`/`accepted`, deliberately narrower than the credit's lifecycle guard, so a stale intent settling post-conversion or post-refund cannot rewrite `total_price` back up from a stale snapshot). The payment is never hostage to that write: the metadata is validated against the DB CHECK before the row is touched and the UPDATE runs inside a `SAVEPOINT`, so a failed gratuity apply degrades to "not applied, alerted" and never rolls back the payment record. Unpaid proposals never carry a client-elected gratuity; the ONLY pre-payment gratuity is an admin mandate (`gratuity_floor_rate > 0`, spec 2026-08-10), which floors the client's election on BOTH jar answers and rides the same rate machinery, with EVERY persisting snapshot writer carrying `gratuity.floor_rate` (crud, extras fold, webhook spread: a writer that drops it strips the checkout floor client-side while the server still enforces). The admin PATCH accepts exactly one gratuity field, `gratuity_mandate_total` (dollars > 0 via `gratuityMandate.js`; null clears only a real mandate and forces the jar on; absent carries forward and rescales at the canonical rate; rejected once signed or paid), and still never accepts `tip_jar`/`gratuity_total` (admin removal goes through cancel-line-item only, which also clears the mandate column AND the in-memory row before its fold). Payments that carry no metadata (balance, invoice, drink-plan, admin-issued Stripe payment links) never touch the gratuity FIELDS; a mandated gratuity rides inside `total_price` and is collected by any payment. Grep `gratuityLineAmount` / `GRATUITY_LABEL` before touching gratuity.

Payroll nets each tip's pro-rata Stripe card fee out of the gratuity before paying staff (`splitEvenly(netGratuity, n)`); the business keeps $0 either way, and the "100% to your staff" client copy is an accepted framing, not a bug to fix.

Code: `server/utils/pricingEngine.js:gratuityLineAmount` and `deriveGratuityRate`; `server/utils/gratuityLabels.js` (`GRATUITY_PAYROLL_LABELS`) with its client mirror `client/src/utils/gratuityLabels.js`; `server/utils/gratuityMandate.js:resolveGratuityForPatch`; `server/db/schema.sql` (the `tip_jar = true OR gratuity_rate >= 50` CHECK and the `gratuity_floor_rate` CHECKs near lines 1351 to 1416); `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (the `SAVEPOINT gratuity_apply` block near line 247); `server/utils/payrollMath.js` and `server/utils/payrollAccrual.js` (the fee netting).

Source: the project CLAUDE.md paragraph; memory `reference-gratuity-fee-netting`; specs 2026-06-08 (redesign), 2026-08-03 (election at payment), 2026-08-10 (mandate).

Provenance: `[Dallas 2026-08-10 for the mandate; Dallas 2026-06-08 for the fee netting; Claude default for the mechanics]`

Checked against code 2026-10-20: pass (verify pass, Fable; `deriveGratuityRate` lives in the engine and is called by create-intent and the admin PATCH, the webhook applies the election under the payable guard inside `SAVEPOINT gratuity_apply`, the PATCH refuses `tip_jar` and `gratuity_total`, the fee netting is in `payrollAccrual.js`).

## 15. The legal-hold proposal

Rule: proposal 600 is under a legal hold and its database state is preserved exactly. Never archive it, reap or close its shift, void or re-send its invoice, chase its balance, edit its price, or include it in any sweep, backfill, reconciliation, cleanup or AI read. Any bulk operation over past events, open shifts or unpaid invoices excludes it and confirms its row count first. The guard fails closed: an id the seam cannot read as a positive integer reads as held.

Code: `server/utils/staleProposalSweep.js:LEGAL_HOLD_PROPOSAL_IDS` (the one list, read at call time); `server/utils/legalHold.js:isLegalHold` (the seam every writer guard calls); `server/utils/inbox/readJob.js` never reads the held client.

Source: memory `reference-proposal-600-legal-hold`; spec 2026-10-16 section 5.3.

Provenance: `[Dallas 2026-08-11]`

Checked against code 2026-10-20: pass (verify pass, Fable; the list holds the one id, `isLegalHold` reads it at call time and treats an unreadable id as held, the Inbox read job excludes the held client's keys).

## Who reads this file

The review skill before any money lens runs; the money lens's brief, which carries these laws verbatim; the externals' brief (codex and gemini); and any session before a money-path change.
