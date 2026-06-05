# Checkout Gratuity (Project B)

- **Date:** 2026-06-05
- **Status:** Brainstormed; two `/review-spec` passes folded in (r3). Ready for implementation plan.
- **Author:** Dallas + Claude
- **Scope:** Let the client choose, at sign-and-pay, whether to keep a tip jar and whether to pre-pay gratuity for the bartenders (or instructors); let an admin set the same on a proposal. The gratuity flows into `total_price` and out to staff through the existing payroll pipe. This is the behavior the new master agreement's §8.3 describes (Project A shipped that text).

### Revision log

- **r2:** folded first review (overpayment handling, all-package gratuity with "instructor" wording, BEO on-add, post-payment consent, pooling, server authority/validation, degenerate guards, 6-site verdicts, relabel inventory, migration order, admin-UI pin, race guard, rounding).
- **r3:** folded second review. Corrected three r2 claims that rested on code that doesn't behave as assumed: (a) `invoiceHelpers.js` builds lines from snapshot *shape*, not breakdown labels, so a real Gratuity invoice line is required; (b) the "existing payment-status re-eval" is one-way and not shared, so the demotion ladder must be extracted; (c) "unpaid events are cancellations" is wrong, the real protection is a funded-accrual gate. Added: the persistence/recompute flow at create-intent (7th recompute site), a `staff_noun` resolver frozen into the snapshot, a full relabel surface inventory + shared constant + compute-time snapshot of the display string, the funded-gratuity-accrual gate + the "paid before the event or we don't work it" policy, client notification on staffing-driven increases, and Dallas's calls on the ceiling ($0=No, sane validation not a hard max, refund typos) and pooling (all DrB-processed gratuity pools).

## 1. Goal

Make gratuity a deliberate, simple choice at checkout: a tip jar yes/no and an optional pre-paid amount, both shown as plain dollars. Internally it is a per-staff-per-hour rate so it scales with crew and hours, and it reuses the existing total/balance/payroll machinery.

## 2. Background: current state (grounded)

- **Only gratuity today is automatic + narrow.** `pricingEngine.js` emits a `"Shared Gratuity"` line ($50/$25/$15 per hour per *over-ratio* bartender at <50/<75/<100 guests) at `:287,313`; logic `:107-124,199-313`. Exempt for class packages (`isClassPackage`, a non-exported local at `:97,182`). Most proposals have no gratuity line.
- **Payroll reads gratuity from the snapshot.** `payrollMath.js:45` `extractGratuityCents` sums every breakdown line `label === 'Shared Gratuity'` (dollars→cents). `payouts.gratuity_share_cents` (`schema.sql:2567`) holds the share; surfaced on the paystub as one row (`paystubPdf.js:101`). Accrual: `payrollAccrual.js` (`:68` gates on `status==='completed'`; `:143` extracts gratuity).
- **Two completion paths.** Auto-complete gates on `(total_price - amount_paid) <= 0` (`balanceScheduler.js:183-198`). The **manual** path `PATCH /api/proposals/:id/status` (`lifecycle.js:168-184`) accrues on any admin `completed` with **no funding check** today.
- **Money is DOLLARS on the proposal side.** `total_price`, `amount_paid`, `deposit_amount` (`:901`, default 100.00) are `NUMERIC` dollars; invoices/Stripe are cents. Convert at the payroll/Stripe seam only.
- **Pricing recomputed in 6 places:** `calculateProposal` (`pricingEngine.js:180`) at `crud.js:236,554`, `metadata.js:74`, `public.js:89,341`, `drinkPlans.js:325`. The sign/checkout charge path does NOT recompute today (it reads `total_price`) — this spec adds it as a 7th site (§5/§6).
- **Checkout charge.** `POST /api/stripe/create-intent/:token` (`stripe.js:86-202`) builds the PaymentIntent `amount` from `proposal.total_price` (`:135-137`); reuse cache keyed on `(proposal_id, amount)` (`:140-153`). Sign POST `publicToken.js:115-271` writes signature/venue only.
- **Status demotion today is one-way.** `crud.js:594-621` demotes `balance_paid→deposit_paid` only when the new total goes *up* past `amount_paid`. The 3-state ladder (`accepted | deposit_paid | balance_paid`) lives inline in `refundHelpers.js:244-275`, not shared.
- **Breakdown labels are rendered to clients/admins literally on multiple surfaces:** `ProposalPricingBreakdown.js:63`, `client/src/components/PricingBreakdown.js:20`, `ProposalCreate.js:1247`, `QuoteWizard.js:742`, and `ClassWizard.js:511` (which already runs a blanket `bartender→instructor` regex on labels). Invoices do NOT render breakdown labels: `invoiceHelpers.js:50-173` builds lines from snapshot shape (`snap.package`, `snap.staffing`, ...).
- **Admin pricing editor:** `ProposalDetailEditForm.js:155-167,541-558`. `EventEditForm.js` only passes `adjustments` through.
- **BEO** (`beoHandlers.js`, `BeoSections.js`) shows no gratuity/tip-jar today.
- **Decision: layer, do not replace** the forced surcharge.

## 3. The model

Two stored fields on the proposal:
- `tip_jar BOOLEAN DEFAULT true` — visible nudge for guests; staff can still be tipped without it.
- `gratuity_rate NUMERIC(10,4) DEFAULT 0` — pre-paid gratuity **rate per staff member per hour** (dollars). `0` = none.

Linking rule: **if `tip_jar = false`, `gratuity_rate >= 50`.** Enforced at the route layer (clean error returned BEFORE the DB CHECK can throw), in the engine, and as a DB `CHECK (tip_jar = true OR gratuity_rate >= 50)`. Every write that touches either column writes both together.

**Computed, never stored as a fixed dollar figure:**
```
staffCount     = staffing.actual + additional-bartender addon qty
                 // staffing.actual already folds the numBartenders override — do not re-add it.
                 // This is a SEPARATE count from the engine's `totalStaff` (which includes barbacks/servers);
                 // gratuity must NOT pay support staff (their gratuity is already in their pricing).
gratuityAmount = gratuity_rate × staffCount × durationHours    // event service hours only
```
Appended to the breakdown as a distinct **`"Gratuity"`** line when `gratuity_rate > 0`; folded into `total_price`. Scales symmetrically with crew and hours (post-payment guard in §6; notification in §7).

**Staff noun.** Add an exported `getStaffNoun(pkg)` to `pricingEngine.js` returning `'instructor'` for class packages, else `'bartender'`, and **freeze it into the snapshot** as `pricing_snapshot.staff_noun`. Every client/BEO/admin surface reads that frozen value (never re-derives), so a later re-categorization can't retroactively swap the noun on a signed proposal. Reconcile `ClassWizard.js:511`'s existing regex to read this instead of string-replacing.

**Applies to all packages**, including class/hosted (uses the instructor noun). The forced surcharge stays class-exempt; the client gratuity does not. Step shown only when `staffCount >= 1`.

## 4. Client presentation (booking): simple, totals only

Plain dollars, one jar choice; the rate is internal.
```
Tip jar at the bar?    ( • Keep it    ◦ Skip it )
  Keep it →  Add a gratuity?   ◦ No    ◦ $200 (suggested)    ◦ Custom $____
  Skip it →  Gratuity for your bartenders:   $400   (adjust, $400 minimum)
New total: $X,XXX
```
- Suggested total = `25 × staffCount × hours`; no-jar minimum = `50 × staffCount × hours`. Noun follows `staff_noun`.
- The client lands on a **total**; the server derives `gratuity_rate = enteredTotal / (staffCount × hours)`, stored `NUMERIC(10,4)`; line amounts round to cents.
- **Amount boundaries:** jar kept → any amount `>= 0`; **`$0` = "No"** (no line). Jar skipped → `>= $50 × staffCount × hours`. No hard max ceiling; server applies sane validation (reject negative/NaN/non-numeric/Infinity and an absurd sanity bound); genuine typos are corrected via the manual refund flow (§6).
- **Default if skipped:** `tip_jar = true`, `gratuity_rate = 0` (today's behavior).
- **States:** loading during the recompute/intent round-trip; error if it fails; inline floor message; "New total" updates only after server confirmation. **Step disabled** (inert) when `staffCount × hours <= 0` — on the client step *and* the admin control (§7).
- Lives in `SignAndPaySection.js` before the deposit/full tablets.

## 5. Pricing-engine integration + recompute sites

Extend `calculateProposal(...)` with `gratuityRate` + `tipJar`; compute `staffCount` per §3 (separate from `totalStaff`); append the `"Gratuity"` line. It coexists with a forced `"Shared Gratuity"` line.

Every recompute site passes the proposal's stored `gratuity_rate` + `tip_jar`. Verdicts (the plan confirms each role + tests each):
- `crud.js:236` (create) **include**; `crud.js:554` (update) **include**.
- `metadata.js:74` **preserve** (plan confirms what it recomputes).
- `public.js:89` (public fetch/preview) **preserve** (default-0 shows no line; preset shows it); `public.js:341` **preserve**.
- `drinkPlans.js:325` **preserve, do not drop or double-add** (plan determines whether it writes the proposal snapshot or a separate figure).
- **7th site — the checkout persist/recompute (§6):** the create-intent path recomputes `total_price` with the gratuity before charging.

## 6. Money flow, persistence, validation, overpayment guard

- Gratuity adds to `total_price`; `deposit_amount` stays $100. Deposit path: $100 now, gratuity in the balance; full / inside-14-days: included now.
- **Persistence + ordering (server is the authority).** The client's `tip_jar` + chosen *total* are submitted to the **create-intent endpoint** (`stripe.js:86-202`). In one server transaction it: validates (floor, non-negative, sane bound, coerce `staffCount×hours<=0`→rate 0), derives the rate, persists `tip_jar`+`gratuity_rate`, recomputes and writes `total_price` via `calculateProposal`, **then** builds the PaymentIntent `amount` from the just-written `total_price`. This removes the TOCTOU at `:135-137` and the persist-then-intent split. Each gratuity change re-calls create-intent; the `(proposal_id, amount)` cache yields a fresh intent. **Stale-intent safety:** on any gratuity change, mark the prior `stripe_sessions` row superseded AND call `stripe.paymentIntents.cancel(oldId)`, so a stale browser tab cannot confirm the old amount.
- **Ceiling:** no hard max; sane validation only (per above). Honest fat-fingers are handled by refunding (below), not by a strict cap.
- **Downward-edit overpayment guard.** Extract the 3-state demotion ladder from `refundHelpers.js:244-275` into a shared helper (`reconcileProposalPaymentStatus`) and call it on every edit/recompute (`crud.js` update, the create-intent persist, admin edits) so status is honest after a price move in **either** direction (today only price-up demotes). When a change leaves `amount_paid > total_price`: do not auto-refund and do not silently sit "Paid in Full" — surface a **durable** overpayment signal: write a `proposal_activity_log` entry (`overpayment_detected`) and show an "overpaid $X, issue refund" flag on the admin proposal detail (derived from `amount_paid > total_price`). The admin refunds via the existing `refundHelpers` flow. This generalizes to any price-down on a paid proposal.

## 7. Two entry points, consent, notification

- **Client** at checkout (§4); **Admin** in `ProposalDetailEditForm.js` (preserve `EventEditForm.js` pass-through), subject to the same `staffCount×hours<=0` disable.
- Prefill + adjustable: an admin-preset value shows at checkout as the starting point; the client can change it under the same rules; client has final say at booking.
- **Post-payment changes (D + notify):**
  - **Staffing-driven** increase (guest count up → more bartenders → more gratuity): no new consent (the client agreed to a rate that scales), but **notify the client by email** that the crew and gratuity changed. (Email per the notification-cost preference.)
  - **Direct admin rate increase** after payment: a new charge — requires client consent or is disallowed post-payment. A stored change-origin (`'staffing' | 'admin'`) distinguishes the two at write time so the guard can tell them apart.

## 8. Payroll — pool everything, gate on funded

- Extend `payrollMath.js:45` `extractGratuityCents` to sum the label set `["Shared Gratuity", "Gratuity"]`. Backward-compatible; the forced line's stored label never changes.
- **Pool all DrB-processed gratuity** across the bartenders regardless of source (forced surcharge + client pre-paid): it sums into one `gratuity_share_cents` and distributes together (Dallas's call — anything DrB controls, DrB owns the fair split). Accepted consequence: this dilutes the forced surcharge away from the specific over-ratio bartender, and the paystub (`paystubPdf.js:101`) shows one blended "Gratuity" row — update the paystub/FAQ copy to reflect a pooled figure. The distribution split itself stays the staff-payment project's concern.
- **Funded-accrual gate (policy + backstop).** Policy: if gratuity is on the bill, the bill is paid in full before the event or the event is not worked (the balance-due-before-event timing enforces this operationally). Backstop in code: gate the **gratuity** portion of accrual on funded inside `accruePayoutsForProposal` (only accrue gratuity when `amount_paid >= total_price`), covering BOTH the auto and the manual (`lifecycle.js:168-184`) completion paths. **Wages are never gated** (staff worked, they are paid regardless). This replaces r2's incorrect "unpaid events are cancellations" justification.
- Update the three label-asserting tests (`payrollMath.test.js`, `payrollAccrual.test.js`, `admin/payroll.test.js`); confirm no other snapshot consumer filters on the label; confirm pooling does not break an existing admin payroll report.

## 9. BEO / crew

Surface on the BEO (`beoHandlers.js` + `BeoSections.js`) once set (not gated on funding): tip jar present or not, and gratuity pre-paid (using `staff_noun`). Clarify whether the BEO reads the proposal row or `pricing_snapshot`; column defaults backfill rows, so a null-safe fallback ("jar present, no gratuity") matters only on a snapshot-read path. Note possible cross-touch with client-portal-v2's Bartender Tips section.

## 10. Invoice line + label strategy

- **Invoice (B1):** `invoiceHelpers.js` must gain an explicit branch that emits a **Gratuity** invoice line from the proposal's gratuity (it builds from snapshot shape, not labels, so the line is otherwise invisible on the invoice PDF). Without this the client pays a gratuity that never shows on their invoice.
- **One shared label constant.** The client-elected line is `"Gratuity"`. The forced surcharge keeps its stored snapshot label `"Shared Gratuity"` (payroll/back-compat) but gets a disambiguated **client-facing display string** (so it cannot be read as the §8.3 no-jar gratuity). Both display strings live in one shared exported constant module and are used in lockstep across every label-rendering surface: `ProposalPricingBreakdown.js`, `PricingBreakdown.js`, `ProposalCreate.js`, `QuoteWizard.js`, `ClassWizard.js`, the new invoice line + invoice templates, breakdown emails, BEO, and admin/payroll views. A consistency test asserts the single source.
- **Snapshot the display string at compute time (W9).** The label shown is captured when the snapshot is computed, so new proposals get the disambiguated wording and already-signed proposals keep what they showed (no retroactive change diverging from a downloaded invoice PDF). Old proposals showing "Shared Gratuity" predate §8.3, so there is nothing to reconcile there.
- **Rounding/floor:** store the rate `NUMERIC(10,4)`; round only computed lines to cents; the `>= 50` floor check compares the **stored** rate (small epsilon if needed), never a re-derived value.

## 11. Data model

`ALTER TABLE proposals` (near `:1161`), in order:
1. `ADD COLUMN IF NOT EXISTS tip_jar BOOLEAN DEFAULT true`
2. `ADD COLUMN IF NOT EXISTS gratuity_rate NUMERIC(10,4) DEFAULT 0`
3. `ADD COLUMN IF NOT EXISTS gratuity_rate_change_origin TEXT` (`'staffing' | 'admin' | null`, for §7's post-payment guard)
4. then the CHECK, guarded with the `IF NOT EXISTS (information_schema...)` pattern (`schema.sql:912-920` style): `CHECK (tip_jar = true OR gratuity_rate >= 50)`. Existing rows take `(true, 0)` and pass; use `NOT VALID` + `VALIDATE` if warranted; include a sanity SELECT confirming no existing row fails.

`pricing_snapshot` gains `staff_noun` and the captured display strings (§3, §10). Route-layer validation rejects a `(false, <50)` write with a clean message before the CHECK fires.

## 12. Testing / verification

- **pricingEngine:** gratuity = rate × staffCount × hours; excludes barback/server (separate from `totalStaff`); coexists with the forced line; scales both ways; absent at rate 0; instructor noun for class packages; `numBartenders` override not double-counted; `staff_noun` frozen in snapshot.
- **Recompute survival:** an unrelated edit preserves the line across all 7 sites (one assertion each); `drinkPlans` neither drops nor double-adds.
- **Server authority/validation:** rejects no-jar `< 50`, negative, NaN, over-sanity-bound; derives rate from posted total; charge derives from the server-recomputed `total_price`; create-intent persists + recomputes before computing `amount`; prior intent cancelled on change.
- **Overpayment guard:** an edit pushing `total_price < amount_paid` runs the shared demotion ladder, demotes status, writes the `overpayment_detected` log + surfaces the flag; no silent "Paid in Full"; no auto-refund.
- **Funded accrual:** a manually-completed partially-paid event accrues wages but $0 gratuity; a fully-paid event accrues the pooled gratuity.
- **payrollMath:** sums both labels; old single-label snapshots still extract; forced + client pool.
- **Notification:** a staffing-driven post-payment increase emails the client; a direct admin rate increase post-payment is gated by consent.
- **Migration:** CHECK passes for all existing rows. **Label consistency:** one constant drives every surface. **Client build:** `CI=true react-scripts build` passes.

## 13. Files touched (anticipated)

- **Schema:** `server/db/schema.sql` (3 columns + CHECK + snapshot fields).
- **Pricing:** `server/utils/pricingEngine.js` (`calculateProposal`, `getStaffNoun`, `staffCount`, snapshot fields) + the 6 call sites.
- **Payroll:** `server/utils/payrollMath.js`, `server/utils/payrollAccrual.js` (funded gate) + the three payroll test files; `server/utils/paystubPdf.js` + paystub/FAQ copy.
- **Status helper:** extract `reconcileProposalPaymentStatus` from `refundHelpers.js`; call from `crud.js` + create-intent.
- **Checkout/charge:** `client/.../SignAndPaySection.js`, `ProposalView.js`, `server/routes/stripe.js` (persist + recompute + intent + cancel-on-change).
- **Completion:** `server/routes/proposals/lifecycle.js` (funded gate shared via accrual).
- **Invoice + labels:** `server/utils/invoiceHelpers.js` (+ templates), a shared label-constant module, and the label-render surfaces (`ProposalPricingBreakdown.js`, `PricingBreakdown.js`, `ProposalCreate.js`, `QuoteWizard.js`, `ClassWizard.js`), breakdown emails.
- **Admin:** `ProposalDetailEditForm.js` (+ `EventEditForm.js` pass-through).
- **Proposal routes:** `crud.js`, `public.js`, `metadata.js`.
- **BEO:** `beoHandlers.js`, `BeoSections.js`.
- **Notification:** the comms templates/dispatcher for the staffing-change email.

## 14. Documentation updates

- `ARCHITECTURE.md`: gratuity model in proposal/pricing + payroll; new columns + snapshot fields.
- `README.md`: checkout gratuity in Key Features if listed.
- `CLAUDE.md` Cross-Cutting Consistency: a gratuity bullet (rate stored / dollars computed; layered on the forced surcharge; all gratuity pooled and gated on funded; both labels extracted; applies to all packages with the `staff_noun`; the shared label constant) — load-bearing money logic like the hosted-bartender rule.

## 15. Out of scope

- The distribution split of the pooled gratuity across staff (existing payroll / staff-payment project).
- Renaming the forced surcharge's stored snapshot label (back-compat; display-only relabel per §10).
- Project A (the master agreement document swap), shipped separately.
- Tip-jar cash physically collected on-site (outside DrB's processing; "if we control it, it's on us" applies to processed gratuity).
