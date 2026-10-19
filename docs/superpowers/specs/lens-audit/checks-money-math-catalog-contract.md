# Lens audit synthesis: money-math, catalog-data, contract-seam

Input: synth-in/money-math-catalog-contract.jsonl (139 defects: 86 money-math, 26 catalog-data, 27 contract-seam; none flagged by any lens checklist as written today). Lens checklists compared against: checks/{code-review,consistency-check,database-review,performance-review,security-review,ui-ux-review}.md. The only money lines in the six lenses today are SEC-38/39 ("pricingEngine re-computes totals; amounts re-derived from DB") and DAT-04 ("money columns are integer cents"); the only cross-reader line is CON-01..03 ("grep the table name"). Nothing below is covered by those.

Two NEW lenses are proposed: **money-review** (reads row truth: scope partitions, quantity semantics, delta legs, refund scope, floors) and **catalog-review** (par catalog, ingredient resolution, shopping-list composition, package flags). contract-seam checks go to **consistency-check**, which must be rewritten from "grep the table name" to "trace one value from its writer to every reader".

Row-truth sources referenced below (the "Row-truth doc" line on each money check):
- Labels: `server/utils/proposalMoneyShared.js` header (CONTRACT_LABELS, OFF_LEDGER_INVOICE_LABELS, TOTAL_TRACKING_INVOICE_LABELS), `server/utils/invoiceExtras.js` IN_TOTAL_PRICE_LABELS, `server/utils/lineItemCancel.js` DELTA_LABELS; memory `reference-off-ledger-invoices.md`; spec `docs/superpowers/specs/2026-07-25-service-extension-design.md` (D12) and the post-mortem in `docs/superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md`.
- Quantity column: `server/utils/addonQuantity.js` header; memory `reference-addon-quantity-column.md`; plan `docs/superpowers/plans/2026-07-26-addon-quantity-semantics.md`.
- Refund scope: `docs/superpowers/specs/2026-09-15-refund-scope-design.md`; memory `reference-refund-scope-rules.md`; retainer rule in memory `project-retainer-survives-full-payment.md` and `server/routes/proposals/cancel.js`.
- acknowledged_total: memory `reference-acknowledged-total-is-row-truth.md`; `docs/superpowers/specs/2026-08-28-post-payment-settle-and-full-pay-invoice-design.md`.
- Hosted ratio and gratuity: `.claude/CLAUDE.md` (Hosted-package bartender rule; Checkout gratuity); memory `feedback_hosted_bartender_rule.md`, `reference-hosted-coverage-fails-open.md`.
- Override: `docs/superpowers/specs/2026-07-16-drink-plan-override-preservation-design.md`, `docs/superpowers/specs/2026-10-16-price-override-removal-design.md`.
- Extension: `docs/superpowers/specs/2026-07-25-service-extension-design.md`, `docs/superpowers/specs/2026-09-30-extension-contract-duration-design.md`.
- Shopping-list quantities: memory `reference-shopping-list-quantity-truth.md`.

---

## Class: money-math (86 defects, 84 money=true, 23 open)

**Shape.** The engine (`pricingEngine.calculateProposal`) is almost never the wrong number; the code around it is. The same six things recur: a stored OUTPUT (`proposal_addons.quantity`, a legacy pricing snapshot) is read back as an INPUT and multiplied a second time; a subtraction between two columns of different scope (`amount_paid` carries off-contract rails that `total_price` never does, and an invoice row does not record which side it sits on) is written with whatever proxy the author picked that day; a delta is differenced from the wrong leg, after the write, or with the gratuity line inside it; a second hand-rolled pricer (a client preview, a pay-now extras charge, an auto-draft) restates an engine rule with a literal; a reprice call drops one of a dozen contract-bearing inputs and the engine quietly re-derives it from the ratio or a `|| 50`; and floors and rounding are applied per writer instead of per column. The scope cluster (MM-2 plus MM-3, 12 defects) produced three reverted attempts (2026-07-26, 2026-07-28 derivation rewrite, RC3 05c38bb0) because each fix chose a different proxy for "is this dollar inside total_price". Fleet reviewers found 43 of the 86 (51 with the external reviewers), nearly always the second or third instance of a mechanism, never the mechanism.

### Checks

**MM-1. Treat `proposal_addons.quantity` (and `snapshot.addons[].quantity`, `pa.quantity`) as an engine OUTPUT: any read that reaches `calculateProposal` / `priceProposedState` as an `addon_quantities` count must go through `storedToInputCount` (`server/utils/addonQuantity.js`) with the row's own `line_total` and `rate`, or `recoverAddonQuantities` (`client/.../proposalEditor/formState.js`) on the client; any WRITE of the column must store the engine's output (`effectiveHoursFor(addon, hours) x count` for per_hour, additional-bartender keyed on slug at raw duration). Flag any hand-rolled divide-by-hours, any `safeAddonQty` applied to an EXISTING row's count (it returns 1 for undefined), any writer computing `max(duration, minimum_hours)` itself, and the same inverse trap on any other stored output (a gratuity basis reconstructed from a legacy snapshot must read the stored basis or return null, never invert).**
- Trigger: diff touches `proposal_addons.quantity`, `pa.quantity`, `addon_quantities`, `safeAddonQty`, `REPRICE_ADDON_SQL`, `withRepriceQuantities`, `gratuityBasisFromSnapshot`, or any submit / lab / fold / compare / change-request / cancel-line / extension path that re-prices existing add-ons.
- Lens: NEW: money-review.
- Defects caught: D1143, D1146, D1161, D1167, D1197, D1200, D1201 (7).
- Row-truth doc: yes, quantity column (addonQuantity.js header; the per-billing-type table in reference-addon-quantity-column.md).

**MM-2. Before any expression subtracts or divides across `amount_paid`, `total_price`, `external_paid`, locked or open invoice sums, or Stripe fees, write down which invoice-label set each side sums (CONTRACT_LABELS: Deposit, Balance, Full Payment; in-total-price delta labels: Additional Services, Enhancement Lab, Drink Plan Extras; OFF_LEDGER_INVOICE_LABELS: Service Extension; manual free-text labels) and confirm both sides use the same partition; an overpayment is `amount_paid - total_price - sumOffContractPaidCents`, never the raw difference; an overpayment-refund allowance is funded by BOTH uncredited charge headroom and contract-invoice slack; a fee numerator must be restricted to the same rails as its denominator.**
- Trigger: diff contains `amount_paid`, `total_price`, `external_paid`, `lockedTotal`/`locked_total`, `offContractPaidCents`, `sumOffContractPaidCents`, `nettedOverpaymentCents`, `uncreditedHeadroomCents`, `contractInvoiceSlackCents`, any of the label constants, `proRataFeeCents`, or a `SUM(` over `invoices` / `invoice_payments` / `proposal_payments`.
- Lens: NEW: money-review.
- Defects caught: D1141, D1173, D1174, D1184, D1203, D1205, D1207, D1209 (8).
- Row-truth doc: yes, labels and refund scope (proposalMoneyShared.js header; reference-off-ledger-invoices.md; reference-refund-scope-rules.md "the netted overpayment"; spec 2026-09-15).

**MM-3. When a diff derives an invoice `amount_due` or a remainder (Balance, Full Payment, lab remainder, Additional Services delta), name which quantity it subtracts, money COLLECTED (payments net of refunds plus `external_paid`) or money BILLED (open or locked invoices by label), and reject one used as a proxy for the other; when a `total_price` delta is produced (re-price, fold, lab add), trace that `refreshUnlockedInvoices` (unlocked Balance absorbs the delta) and `createAdditionalInvoiceIfNeeded` (delta invoice only when the Balance is locked) cannot both carry it. Probe with the prod-shaped rows: an unbacked $100 deposit, an open Additional Services invoice, a contract fully paid by card then repriced down.**
- Trigger: diff touches `server/utils/invoiceLifecycle.js` (`refreshUnlockedInvoices`, `createAdditionalInvoiceIfNeeded`, `createBalanceInvoice`, `upgradeDepositInvoiceToFull`), `routes/drinkPlans/lab.js` remainder, `invoiceExtras.findOrRefreshExtrasInvoice`, `lineItemCancel.reconcileOpenDeltaInvoices`, or adds a `createInvoice` caller.
- Lens: NEW: money-review.
- Defects caught: D1142, D1177, D1178, D1179 (4; D1179 is a live prod re-bill, proposal 51).
- Row-truth doc: yes, labels plus the 2026-07-28 post-mortem ("invoices do not record whether their money sits inside total_price; every classifier is a proxy"); TOTAL_TRACKING_INVOICE_LABELS comment.

**MM-4. For any code that issues or reconciles a refund (payment panel, cancel, `refund.created` webhook, cancel-line), name its scope (contract / overpayment / off-contract / gratuity) and check it moves exactly the columns that scope owns: contract lowers `total_price` and `amount_paid` (and `total_price_override` pre-gratuity, clamped as a PAIR so total minus override never drops below the derived gratuity line); overpayment lowers `amount_paid` only; off-contract touches neither. The refund TARGET and its cap must be read from a snapshot captured before the first refund (keyed per proposal and reason, retainer read off the upgrade breadcrumb, never the label), never from `amount_paid` or an invoice `amount_paid` the refund itself reduces, so a retry finds the same target and cannot under- or over-refund.**
- Trigger: diff touches `refundHelpers.js` (`planRefund`, `applyRefundReconciliation`, `planOverpaymentSplits`, `availableOverpaymentCents`), `stripeWebhookHandlers/refundCreated.js`, `proposals/cancel.js` refund target, `lineItemCancel.js` overpayment, any write to `proposal_refunds` or `total_price_override`.
- Lens: NEW: money-review.
- Defects caught: D1153, D1154, D1155, D1165, D1206, D1208 (6).
- Row-truth doc: yes, refund scope and retainer (spec 2026-09-15; reference-refund-scope-rules.md; project-retainer-survives-full-payment.md).

**MM-5. Where a money delta is computed as `after - before` from two engine or catalog runs, check that both legs apply the identical filter set (self-provided syrups, comped lines, suppressed add-ons; a one-leg strip pushes a negative delta onto a public route), that the `before` leg is captured BEFORE the UPSERT/UPDATE that changes its inputs (a post-write delta is always $0), and that the client gratuity line and any line derived from the basis the delta moves (staff count) are excluded or the override is kept pre-gratuity, so moving the basis cannot bake gratuity into `total_price_override` and charge it twice. `totalPriceOverride` passed to the engine REPLACES the service total: an override-preserving path adds the catalog delta to the override, never hands the override back whole.**
- Trigger: diff contains two `calculateProposal` / `computeCatalogSnapshot` calls that are differenced, writes `total_price_override`, touches `foldExtrasIntoProposal`, `computeExtrasBreakdown`, `computeExtensionDelta`, or drink-plan submit / lab override preservation.
- Lens: NEW: money-review.
- Defects caught: D1144, D1145, D1172, D1198 (4; D1144 was a verified $200 overcharge in prod).
- Row-truth doc: yes, override and gratuity (spec 2026-07-16 override preservation; spec 2026-10-16 override removal; CLAUDE.md "added on top of total_price, never diluted by a discount/override").

**MM-6. For every SUM or COUNT over payments, proposals, invoices or staff that feeds a dashboard, ledger, financials card, metric or fee rule: (1) subtract succeeded refunds with the same `refundsInWindow` leg the sibling metrics use so paid, revenue and outstanding agree by construction; (2) run the count and the sum over the same predicate and the same status set as the live enum (no phantom 'archived' value, cancelled-after-accept is not won); (3) pre-aggregate or DISTINCT any JOIN to a one-to-many child (`invoice_payments`, `proposal_refunds`) and attribute a refund that funded two invoices per link, not whole on each; (4) compute totals server-side over the full set, never by reducing a LIMITed list endpoint on the client; (5) carry the role filter (`role IN ('staff','manager')`) on any count that drives a fee.**
- Trigger: diff adds or edits `SUM(`, `COUNT(`, `LEFT JOIN invoice_payments` / `proposal_refunds`, a query in `metricsQueries.js` (`qMoney`, `qRevenue`, `qOutstanding`, `qAccepted`, `qWinRate`, `qLostValue`) or `proposals/metadata.js` financials, a client-side `.reduce` over an `/api/...` list that renders a dollar total, or a count predicate in `serviceArea.js`.
- Lens: database-review (rewritten; today DAT-08..10 read every query with no aggregate semantics), with money-review reading the refund-netting rule.
- Defects caught: D1121, D1122, D1157, D1158, D1159, D1181, D1182, D1183, D1210 (9).
- Row-truth doc: no; the shared leg is `refundsInWindow` in metricsQueries.js.

**MM-7. A `GREATEST(0, ...)` / `Math.max(0, ...)` on a money column is policy, not hygiene: when a diff adds, keeps or removes one on a payout `line_total`, `net_amount`, `total_price_after`, `total_price` or `total_price_override`, grep every INSERT, UPDATE, ON CONFLICT and admin PATCH that writes that column and confirm they all apply the identical floor or none; a column that must carry debt (clawback, late tip, admin edit) has no per-line floor anywhere, only the payout-level clamp; and a clamp that zeroes a negative must not also advance the ledger cursor (`tips.refunded_amount_cents`) that would make the replay a no-op. History columns clamp exactly as their live twin does.**
- Trigger: diff contains `GREATEST(0` or `Math.max(0,` near `line_total`, `_cents`, `total_price`; touches `payrollClawback.js`, `payrollLateTip.js`, `payrollAccrual.js`, `routes/admin/payroll.js` line PATCH, `refundHelpers` `totalAfter`, `proposal_refunds.total_price_after`.
- Lens: NEW: money-review.
- Defects caught: D1136, D1186, D1190, D1204 (4; D1186 was a prod tip debt never collected).
- Row-truth doc: yes, the H1 floor rule (comments at payrollAccrual.js:50 and payrollLateTip.js:153; memory project-seam-sweep-2026-07-02).

**MM-8. Cents discipline. In any code that builds invoice lines or a running money series: compute each line's cents from its own `rate x quantity` (never as total minus the other lines, which mints 1-cent ghost lines); compare the sum of `line_total` to `amount_due` and resolve drift in ONE explicit step that keeps `unit_price x quantity` true (adjust a quantity-1 line or add a labeled rounding line, never fold drift silently into a multi-quantity line or the last line of a cumulative set); carry the engine's sign for adjustments (discounts are negative); for a series of partial refunds or fees, book `round(cumulative) - round(prior cumulative)`, never round each delta, and state the one-cent exposure for rows mid-sequence at deploy; re-assert a rate floor AFTER rounding a derived rate; pin each money source as DOLLARS (proposals.total_price, amount_paid, service_addons.rate NUMERIC) or CENTS (`*_cents`, Stripe amounts, invoice amount_due) and convert once at the boundary; format a rate with a two-decimal formatter (`formatMoney`), never a whole-dollar one; compare two money fields with a cent tolerance, never `===`.**
- Trigger: diff touches `invoiceLineItems.js`, `invoiceExtras.writeExtrasLineItems`, `invoiceHelpers.js`, `lab.js` delta lines, `payrollMath.proRataFeeCents`, clawback fee math, `deriveGratuityRate`; adds `Math.round` on a per-line value inside a loop, a `cents = totalCents - ...` line, a new money variable without a cents/dollars suffix or conversion, a `$`-formatter on a `rate`, or an `=== total_price` comparison.
- Lens: NEW: money-review (code-review may carry the formatting and tolerance half).
- Defects caught: D1120, D1125, D1131, D1139, D1170, D1175, D1176, D1180, D1187, D1188, D1189, D1199 (12; D1180 put a +$50 discount on 26 live invoices, D1199 500-looped the webhook).
- Row-truth doc: yes for the units half (reference-proposals-money-and-status: proposals money is DOLLARS); no for the rest.

**MM-9. Every call to `calculateProposal` / `priceProposedState` / `computeCatalogSnapshot`, and every PATCH or preview body builder, must carry each contract-bearing input from the row or the proposed state: `package_id`, `guest_count`, `event_duration_hours`, `num_bars`, `num_bartenders` override, `gratuity_rate` / `tip_jar` / `gratuity_floor_rate`, `total_price_override`, `adjustments`, add-on quantities and variants, syrup selections. A missing input is silently re-derived (1:100 ratio, 50 guests, 4 hours) and a field that is not being edited is carried forward verbatim, never re-derived. Flag every `|| default` on a money or count field where 0 is a legal value (`num_bars`, `first_bar_fee`, `guest_count`, hours; `pkg.first_bar_fee || 50` still charges $50 on an explicit 0) and require `??` or an explicit null test; confirm the preview renders from the payload the save sends (a blank that previews at 50 and PATCHes 0 is a defect); confirm a tier fallback (`base_rate_3hr_small || base_rate_3hr`) is applied identically in every branch; and for an auto-draft, map every lead fact that carries a charge (asked DRB to bring the bar means `num_bars = 1`; the real duration, not 4).**
- Trigger: diff touches a `calculateProposal` / `priceProposedState` call site, a proposal PATCH or preview builder (`ProposalEditorForm`, `ProposalDetailEditForm`, `ChangeRequestForm`, `changeRequests.js`, `publicOptions.js`, `thumbtackProposalDraft.js`), or adds `|| 50`, `|| 4`, `|| 100`, `|| 40` next to a `pkg.` / `proposal.` / `lead.` field.
- Lens: NEW: money-review (server half); consistency-check for preview-vs-save parity.
- Defects caught: D1126, D1128, D1129, D1133, D1137, D1168, D1192, D1195, D1216, D1217 (10).
- Row-truth doc: yes, hosted ratio ("cover BOTH paths, override and add-on") and gratuity ("absent carries forward and rescales at the canonical rate") in CLAUDE.md.

**MM-10. Every client- or admin-facing dollar must be read from the engine's output (`pricing_snapshot` / `breakdown`) or be asserted equal to `calculateProposal` in a test for the prod-shaped case; when a diff adds or edits a figure on a surface (a deposit line, a per_staff parking preview, a paid card balance, a compare-option card, a pay-now extras charge), name the engine rule it restates (per_staff bills over ALL staff; deposit is `proposals.deposit_amount`, not 50%; balance is `total_price - amount_paid`, not total minus 100; per_100 and per_guest_timed at their real rate, not flat) and grep the diff for literal money constants (100, 0.5, 4, "x bartenders") and for an eligibility or visibility gate evaluated on first load but not on re-render, so an option card can never price below the total printed above it.**
- Trigger: diff touches client code that computes dollars (`ProposalCreate`, `LogisticsStep`, `ProposalView` paid card, `PricingBreakdown`, `otherOptions/ExtrasPanel`, `quoteWizard/helpers`, `formState.js`), `drinkPlanExtras.computeExtrasBreakdown`, or `publicOptions.js` compare pricing.
- Lens: consistency-check (rewritten as "two pricers must agree"), with ui-ux-review for the card-below-total contradiction.
- Defects caught: D1123, D1130, D1132, D1163, D1171 (5; D1130 is a live under-quote on v1 plans).
- Row-truth doc: no; the engine breakdown is the truth.

**MM-11. For any charge, surcharge, staff line, minimum, or duty trigger a diff adds or changes, write the package-path predicate it is keyed on (`isHostedPackage(pkg)` with `staffing.required`; `pkg.bar_type === 'class'`; `applies_to` in byob / hosted / all / class; `PACKAGE_EXCLUDED_ADDONS` / `packageSuppressedAddons`; `requires_addon_slug`) and state the outcome on each of hosted, BYOB, mocktail and class, including "the package already covers it" and "the triggering pick is no longer selected"; a charge that is right on one path and silent or wrong on another is a finding; the gate must sit where the charge is computed, not only in the picker UI; and a documented policy threshold (the 25-guest hosted minimum) must be enforced where the quote is computed, not only in copy.**
- Trigger: diff touches `pricingEngine.js` staffing or add-on branches, `drinkPlans/submit.js` auto-added upgrades, `schema.sql` `service_addons` seed (`applies_to`), `addonCategories.js`, `serviceExtensionPricing.js`, duty-pay triggers in `payrollAccrual.js`, `hostedRateTier` / `min_guests`.
- Lens: NEW: money-review (reads the hosted rule).
- Defects caught: D1124, D1135, D1138, D1193, D1194, D1196, D1219 (7; D1124 and D1135 also by CD-5).
- Row-truth doc: yes, hosted ratio and class rule (CLAUDE.md; feedback_hosted_bartender_rule.md; reference-hosted-coverage-fails-open.md).

**MM-12. A duration-based charge (service extension, added hours) bills every hour past the BOOKED end at the package's extra-hour rate (`extraHourCharge`), never as the difference of two catalog quotes where a 3h-to-4h move inside the base tier prices $0 and adjustments or an override net against it; both legs drop `adjustments` and `totalPriceOverride`; the formula is selected by the agreement version the client SIGNED (v3 and v4 differ on hosted packages), not the current one; and a class package's extension is priced explicitly (a $0 class line is an owner decision, not a fall-through).**
- Trigger: diff touches `serviceExtensionPricing.js`, `contractDuration.js`, `extraHourCharge`, `agreement_version` reads, `eventCreation` `STAFFING_ADDON_MIN_HOURS`, `minimum_hours`.
- Lens: NEW: money-review.
- Defects caught: D1212, D1213, D1218 (3; D1212 collected only $25 gratuity on a paid prod extension, proposal 842).
- Row-truth doc: yes, extension spec D12 (off-ledger) and the 2026-09-26 "every hour past the booked end" rule (spec 2026-09-30).

**MM-13. For every reducer that splits, sums, filters or divides money, state what it returns on the empty, NULL, zero or negative case and show that case is impossible by construction or handled loudly: `splitEvenly(x, 0)` must not return `[]` while a matched tip exists (nobody paid, nothing warned); a SQL `SUM(...)` must `COALESCE`; a label filter must be NULL-safe (`COALESCE(label, '') = ANY(...)`, since `NULL = ANY` drops the row); a division by hours or staff must return null and surface; a negative delta from catalog data must throw, never invoice.**
- Trigger: diff adds `SUM(` without `COALESCE`, `= ANY` / `NOT IN` on a nullable column, a division by `durationHours` / `staffCount` / `n`, a split over a roster that can shrink to zero bartenders, or an `amountCents` that can go negative.
- Lens: database-review (SQL half) and code-review (JS half).
- Defects caught: D1169, D1185, D1202, D1211 (4).
- Row-truth doc: no.

D1214 and D1215 (shopping-list procurement quantities, money=false) are quantity math, not DRB money; they are caught by catalog-data check CD-3 below, not by a money check.

**Not anticipable:** D1134 (one staffer's rate row seeded at $20 instead of $22; a data correction, no diff to review).

---

## Class: catalog-data (26 defects, 3 money=true, 9 open)

**Shape.** Most of these are not diffs anyone reviewed. Nine of 26 are a recipe naming a thing the par catalog has no row or alias for (olives, lavender syrup, bare 'lemon', 'red wine', 'coco real', rimming sugar, limoncello, a misspelled jalapeno, a stuck plan), found one at a time by Sentry SERVER-1H over three months while the substring fallback in `resolveIngredient` masked the rest by binding to the wrong row. The remainder is the shopping-list generator treating display labels as identity (duplicate lines when a lookup label differs from the catalog name; a strip that removes every line whose name CONTAINS a Lab syrup's name), scaling a quantity with the wrong rule (rim salt per guest and per drink), drawing a par slice with no package scoping (a zero-proof package stocking tonic and bitters), an unknown legacy `serving_type` falling silently to the mocktail recipe, and catalog rows shipped with their behavioral flags at the column default. The review action that earns its place here is a sweep run on catalog or resolver changes, not a diff read.

### Checks

**CD-1. On any change to the resolver, an alias, a par row, a recipe seed, a consult or custom recipe writer, or a drink activation, run `resolveRecipeRow` over EVERY active cocktail and mocktail ingredient row plus pending consult recipes and report: unresolved count (must be 0, each miss named by drink and ingredient) and every resolution that landed on the substring fallback (reviewed as a miss). For consult and custom recipes, resolve at WRITE time and surface the unresolved ingredient on the admin review surface, not only in Sentry, so a plan cannot sit in pending_review with an ingredient nobody will buy.**
- Trigger: diff touches `server/utils/potionCatalog.js`, a `par_items` migration or seed, `cocktails.ingredients` / `mocktails.ingredients` seeds, `drinkPlanConsult.js` `sanitizeConsult`, `shoppingListGen.reportUnresolvedIngredients`; or a new SERVER-1H event after a recipe was added.
- Lens: NEW: catalog-review.
- Defects caught: D1222, D1223, D1224, D1225, D1226, D1228, D1229, D1230, D1231 (9); cross-class D1479 (contract-seam).
- Row-truth doc: not money.

**CD-2. The resolver of record is exact normalized alias match; the substring fallback in `resolveIngredient` is never allowed to decide a bottle on a reviewed path (it bound 'Smoked Salt' to wood chips and 'Dark Rum' to white Bacardi). `normalizeName` must be symmetric (an accented item name and its unaccented spelling normalize to one key, on both the row and the alias, in the script and in dev data); a rename of a par row keeps every prior name as an alias; an alias list change re-runs CD-1.**
- Trigger: diff touches `normalizeName`, `buildCatalogSlices`, `resolveIngredient`, an `aliases` column write, a par-row rename script.
- Lens: NEW: catalog-review.
- Defects caught: D1241 (1); cross-class D1479, D1480, D1526, D1527 (contract-seam). Earns its place because it is the mechanism that let the nine CD-1 holes stay invisible and because a wrong bottle is worse than a missing one.
- Row-truth doc: not money.

**CD-3. Every path that pushes a line onto a shopping list (baseline pars, `mergeSignatureRecipes`, `addSelfProvidedSyrups`, Lab syrup refresh, `addMatchingMixers`, consult merge) keys its exists-check AND its strip on the resolved `par_items` id (or the resolver's canonical name), never on a lookup label (`SYRUP_NAME_LOOKUP` 'Grenadine (Pomegranate) Syrup' beside a recipe 'Grenadine') and never on `name.includes(...)` (a Lab ginger syrup removed Ginger Beer); one shared duplicate guard serves every push path; and a self-provided or Lab push consults the proposal's comped and paid syrups so the client is not told to buy what DRB already supplies.**
- Trigger: diff touches `shoppingList.js`, `shoppingListGen.js`, `labListRefresh.js`, `SYRUP_NAME_LOOKUP`; adds `.find(i => i.item.toLowerCase() === ...)` or `.includes(` on list names.
- Lens: NEW: catalog-review.
- Defects caught: D1236, D1243, D1244, D1246, D1247, D1248, D1249 (7).
- Row-truth doc: not money.

**CD-4. For any change to a quantity formula (`scaleQty`, `ceil(guests / 25)`, +1 per extra drink, `recipe_qty_per_100`, `qty_per_100`), state for each item class (baseline par, recipe spirit, recipe mixer, rim garnish or salt, syrup) which rule produces the number and that the rule reads the catalog column meant for it; recipe-only rim items are a flat 1; then diff the generator's output against prod's approved lists (lines with `admin_set: true` are the owner's hand edits) for three plans before merging, because a rule that is right for salt quarters the mint.**
- Trigger: diff touches `scaleQty`, `qty`, `recipe_qty_per_100`, `qty_per_100`, `Math.ceil(guestCount` in `shoppingList*.js`, or a `par_items` quantity migration.
- Lens: NEW: catalog-review.
- Defects caught: D1245 (1); cross-class D1214, D1215 (money-math) for 3 total. Earns its place because the owner corrected the number on every approved list and the fix-list's prescribed rule would have been wrong.
- Row-truth doc: yes, reference-shopping-list-quantity-truth.md (approved lists are the truth; `qty_per_100` on recipe-only rows is a placeholder no path reads).

**CD-5. Every catalog slice a generator consumes (`PARS_100`, `legacySlices`, `pairableItems`, in_full_bar rows, the add-on coverage map) is filtered by the plan's package kind (hosted vs BYOB; zero-proof or mocktail vs full bar; class) before use; the `serving_type` / `plannerServiceStyle` switch enumerates every stored value including legacy ones ('custom' from v1 Custom Setup plans) with a default branch that reports and refuses rather than falling to the mocktail recipe; and when an add-on's provisioning changes (straws to available-on-request) the coverage entry of every package that listed it changes in the same diff.**
- Trigger: diff touches `PARS_100`, `legacySlices`, `buildCatalogSlices`, `GENERATOR_STYLES` / `plannerServiceStyle`, `isHostedPlan`, `shoppingListAddonCoverage.js`, any `serving_type` read.
- Lens: NEW: catalog-review.
- Defects caught: D1240, D1242, D1250, D1251 (4).
- Row-truth doc: not money (reference-hosted-coverage-fails-open.md for the hosted/no-list rule).

**CD-6. When a diff adds or edits a `service_addons` or `service_packages` row, or changes a package lineup, list every behavioral flag the row carries (`applies_to`, `requires_provisioning`, `requires_addon_slug`, `minimum_hours`, `includes`, `package_items`, the `PACKAGE_EXCLUDED_ADDONS` entry, the coverage-map entry) and show the value chosen for each with its reason; a row left at the column DEFAULT (`'all'`, `false`, `'[]'`) is a finding, not a pass; a script that changes package contents writes `service_packages.includes` and updates the `schema.sql` seed copy in the same change, because four public surfaces read the column.**
- Trigger: diff touches `schema.sql` `INSERT INTO service_addons` / `service_packages`, `applyPackageLineup*.js`, `addonCategories.js`, `shoppingListAddonCoverage.js`, `package_items`.
- Lens: NEW: catalog-review (database-review for the seed SQL).
- Defects caught: D1235 (1); cross-class D1124, D1135 (money-math), D1510 (contract-seam) for 4 total. Earns its place because two of the cross-class instances sold alcohol add-ons to BYOB proposals and re-sold add-ons a package already includes (money lost), and every new add-on row is a fresh instance.
- Row-truth doc: for D1135 / D1124, the hosted and package-coverage rules (CLAUDE.md); D1235 is money=true (supply run never set) but needs no money doc.

D1221 (a checkbox wrote `users.notifications_opt_in`, which no notification path reads) is a write-only field and is caught by contract-seam check CS-1 below.

**Not anticipable:** D1232 (a staffer's W-9 slot holds a mis-uploaded headshot; a human upload error, fixable by type and duplicate validation on the slot, not a review check); D1233 (seven clientless test proposals at status completed in prod holding $12,400; prod data hygiene, a sweep, not a diff).

---

## Class: contract-seam (27 defects, 2 money=true, 7 open)

**Shape.** A value is written in one shape and read in another, and nothing throws: a positional call to a helper that takes `({ to, body })`, a display-shaped selection written where the storage shape is read, `String()` on a structured row persisting '[object Object]', a token minted with `{clientId, marketing}` for an endpoint that only reads `{leadId}`, a `RETURNING` row or `SELECT` list narrower than its consumer, a sanitizer that drops the key it does not know, a creation-time copy of a mutable field (`drink_plans.client_email`) read by three different senders, a second entry point to a transition that forgets the first one's side effects, and a button bound to a non-unique human label. Eleven of 27 were found by the fleet or an external reviewer, but always the instance: the stale email column bit three senders after the first was fixed, which is what today's consistency-check (CON-01: grep the table name) cannot see.

### Checks

**CS-1. For each field a diff persists or emits (a JSONB column, a token payload, a selections blob, an argument to a shared helper), name the reader(s) and open them: the reader's key names must appear in the writer's output (`venue_`-prefixed vs bare; `{leadId}` vs `{clientId, marketing}`); a function invoked positionally when its signature takes an object (`sendSMS({ to, body })`) is a silent no-op; `String(row)` on a structured row is '[object Object]'; a display shape is never written where the storage shape is read; a column written by a control with no reader (`notifications_opt_in`, `sel.customCocktails`) is a finding. Conversely a reader that parses a stored blob with a bare `JSON.parse(...).length` where a shape-aware shared reader exists (`parsePositionsNeeded`) must use the shared reader.**
- Trigger: diff adds a JSON/JSONB write, a token mint, a new column write, a new argument or call to a shared helper, or a new parse of a stored blob; any `String(` or `JSON.parse(` on a row field.
- Lens: consistency-check (rewritten: trace writer to reader, not grep the table).
- Defects caught: D1469, D1475, D1482, D1493, D1497, D1511, D1529 (7); cross-class D1221 (catalog-data).

**CS-2. When a diff builds an object from a query (`RETURNING *`, a `SELECT` list, `lookupEntity`, `REPRICE_ADDON_SQL`), from a sanitizer, or on a sibling code path, enumerate the fields every downstream consumer reads (the email helper's `client_email` and `client_name`; the shift handlers' `event_type`, `event_type_custom`, `client_name`; the fold's `variant`; the logo key `_logoFilename`) and confirm each is selected, carried through the sanitizer (unknown keys preserved or explicitly allow-listed), and populated on the sibling path (manual shift vs synced shift) rather than hardcoded to `{}` or null; a wholesale `selections = sanitized` write is a defect unless the sanitizer is shown to carry every stored key.**
- Trigger: diff contains `RETURNING`, a `SELECT` feeding a notify, email or handler, an assignment of a sanitizer result onto a JSONB column, or a second code path producing the same payload shape.
- Lens: consistency-check.
- Defects caught: D1496, D1498, D1528, D1532 (4; D1496 lost every uploaded client logo on 7 prod plans).

**CS-3. Every outbound client email or text resolves its recipient through one shared resolver that joins the live `clients` row (or the proposal's live client), never from a creation-time copy (`drink_plans.client_email`) or from a bare `INSERT ... RETURNING` row that has no email; when one sender is fixed, grep the column across all senders (submit, consult recap, shopping-list approve) and fix them in the same change; a send helper that receives no recipient throws or alerts, never early-returns silently.**
- Trigger: diff adds or edits a `sendEmail` / `sendSMS` call, reads `client_email` or `client_name` from any table other than `clients`, or builds a recipient from a `RETURNING` row.
- Lens: consistency-check (with the "client names come from the SOURCE" memory).
- Defects caught: D1492, D1495, D1500, D1514 (4; D1514 sent a wedding client's approved list to a dead address in prod).

**CS-4. A creation-time copy of a mutable value is a cache: when a diff reads one (`service_packages.includes` vs the lineup script, a stored `shopping_list`, a menu-art fingerprint, any `*_snapshot`), ask whether the source can change after the copy was taken; if so, either the reader joins the source or the writer of the source refreshes every copy, and a stored artifact carries a regenerate path; a fingerprint or cache key must list every input the rendered artifact depends on (bar picks included), and a lineup script that changes package contents must write the column the public surfaces read.**
- Trigger: diff touches `buildFingerprint`, `service_packages.includes`, `applyPackageLineup*.js`, a stored list or snapshot column, or adds a new rendered artifact with a change-detection banner.
- Lens: consistency-check.
- Defects caught: D1510, D1524, D1535 (3).

**CS-5. When a diff adds a second entry point to a transition (a Hire button beside the legacy hired path; a manual shift beside a synced one; a CANT/CONFIRM text beside the next-shift card) or edits one side of a cross-entity sync (`syncShiftsFromProposal`), list the side effects of the existing path (email, `contractor_profiles` seed, `positions_needed` reconciled to the bartender count, the ordering rule the twin uses) and show each is present on the new path or dropped with a stated reason; a comment claiming parity is not evidence, read both paths.**
- Trigger: diff adds a route or handler whose status write matches an existing one (hire / hired, approve / approved), touches `eventCreation.syncShiftsFromProposal`, `staffPortal.js` next-shift ordering, or any `ORDER BY` on a surface whose text-command twin orders separately.
- Lens: consistency-check.
- Defects caught: D1483, D1484, D1508, D1517 (4; D1517 is money=true because `positions_needed` is the payroll seam).

**CS-6. A client control that targets a server row carries the row's id or the shared composite key (`parseCancelTarget` kind:key), never a display label; grep the diff for a handler that resolves its target with `.find(x => x.label === ...)` or `.name === ...` over money or roster rows.**
- Trigger: diff adds a remove, select or edit button bound to a breakdown, invoice-line or roster row.
- Lens: ui-ux-review (control binding) or code-review.
- Defects caught: D1468 (1). Earns its place because the admin's click removed the $320 override line instead of the $160 add-on (money path), and it is the same label-as-identity mechanism CD-3 flags in the shopping list.

D1479, D1480, D1526, D1527 (par-row name matching: a rename dropped an alias, 'Dark Rum' substring-matched a white rum, unnormalized and non-ASCII aliases) are catalog resolution and are caught by catalog-review CD-1 and CD-2 above.

**Not anticipable:** none; every contract-seam defect sits under one of the six checks or the catalog cross-reference.

---

## Coverage ledger

money-math: 83 of 86 under MM-1..MM-13; D1214, D1215 under CD-4; D1134 not anticipable.
catalog-data: 22 of 26 under CD-1..CD-6; D1221 under CS-1; D1232, D1233 not anticipable.
contract-seam: 23 of 27 under CS-1..CS-6; D1479, D1480, D1526, D1527 under CD-1 / CD-2.

Lens assignment summary: money-review (NEW) carries MM-1, 2, 3, 4, 5, 7, 8, 9, 11, 12; database-review carries MM-6 and the SQL half of MM-13; consistency-check carries MM-10, CS-1..CS-5; catalog-review (NEW) carries CD-1..CD-6; ui-ux-review / code-review carry CS-6 and the JS half of MM-13.
