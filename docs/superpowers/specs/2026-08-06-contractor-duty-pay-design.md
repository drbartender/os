# Contractor Duty Pay, Out-of-Area Bonus, and Review Rewards

Design spec, 2026-08-06. Brainstormed live with Dallas; section-by-section approvals are the approval.

Ancestor doc: `docs/staff-ops-backlog-2026-07-22.md` (Project B). This spec supersedes its pay-rules portion. Project C (receipt reimbursements) and Project D (staff directory) remain separate and unbuilt.

Money seam: read `.claude/seam-sweep-2026-07-02.md` before planning.

## 1. Goal

Duty-based pay stops living in admin memory. When the booking says a duty happened (bar brought, supplies picked up, menu printed, parking paid, remote venue staffed, review earned), the matching contractor pay line is created automatically, is visible on the paystub by name, and is editable and removable at payroll time. All policy is written down: the field guide carries the schedule, the contractor agreement points at it.

Known live bug this closes first: staff-facing copy already promises "a flat $5 for the print" (`client/src/components/staff/BeoSections.js:311-316`) with zero payroll plumbing behind it.

## 2. Locked amounts and rules

| Kind | Amount | Trigger (all also require the proposal funded, see 4.1) | Who |
|---|---|---|---|
| `bar_rental` | $20 | `num_bars > 0` and nonzero `pricing_snapshot.bar_rental.total` | Attributed bartender |
| `parking` | $20 | `parking-fee` add-on on the proposal | Every approved staffer, no attribution |
| `equipment_supplies` | $20 | Client paid at least $50 of storage-pickup add-ons; ONE fee per event, not per add-on | Attributed staffer |
| `menu_print` | $5 | `menu_print_key` present and `menu_not_required` false | Attributed bartender |
| `out_of_area` | Admin-set (suggest bands, see 6) | Admin attaches to shift; locked once accepted | Accepting staffer |
| `review_bounty` | $10 | Admin logs a named 5-star review (Google or Thumbtack) | Each named staffer |
| `review_contest` | $100 | Admin one-click award at quarter end | Quarter winner (tie splits the pot) |

Related rules:

- Bringing your own bar or picking up a DRB bar at the Pilsen storage unit both qualify for the same $20.
- Menu print: frame required, frames stocked at Pilsen, planning size 8x10. The print always stays with the client; a DRB-stocked frame stays too; a bartender's personal frame can go home. Tablet display is an acceptable alternative (no line).
- Hosted events (`isHostedPackage`) never get the $20 equipment fee: equipment and supply handling pays HOURLY instead, folded into contracted hours. Policy numbers: 90 minutes setup, up to 2.5 hours supply handling.
- Parking pays every approved staffer because the client is charged per staff member (`per_staff` billing, barbacks and servers included). Carpool passengers: admin unchecks their line.
- Tax treatment: all duty lines are pay for services, not substantiated expense reimbursements. They stay inside 1099 totals (`payrollTax.js` rollup unchanged). Typed lines keep a future carve-out possible; nothing changes now.

## 3. Data model: typed duty lines

`payout_events` cannot hold this: `UNIQUE(payout_id, shift_id)` with `shift_id NOT NULL` means one row per person per event, and `adjustment_cents` is untyped and admin-owned after first accrual (accrual preserves it; auto-writing there mixes machine and human money with no provenance). Rejected alternatives: folding into `adjustment_cents`; per-kind columns on `payout_events` (a migration per future kind, parallel state columns for removal/attribution).

New table `payout_duty_lines`:

- `id`, `payout_id` FK payouts ON DELETE CASCADE (NOT NULL)
- `shift_id` FK shifts ON DELETE RESTRICT, NULLABLE: event-derived kinds carry it; review kinds may not (a review can land after its event's period froze, or with no event link). Precedent for money landing in the current open period: `payrollLateTip.js`.
- `kind` TEXT CHECK in ('bar_rental','parking','equipment_supplies','menu_print','out_of_area','review_bounty','review_contest')
- `amount_cents` INTEGER NOT NULL
- `origin` TEXT CHECK ('auto','admin')
- `admin_owned` BOOLEAN default false: set on any admin amount edit; derivation never overwrites an owned amount
- `removed_at` TIMESTAMPTZ, `removed_by`: the remove checkbox. Removed rows are KEPT so derivation finds them and does not resurrect (see the resurrection bug precedent, `docs/fix-list-remaining-2026-07-02.md:71`)
- `note` TEXT
- `staff_review_id` FK NULLABLE (review kinds; UNIQUE(staff_review_id, payout_id) prevents double-crediting one review to one person)
- `created_at`, `updated_at`
- Partial unique index: `UNIQUE(payout_id, shift_id, kind)` WHERE kind NOT IN ('review_bounty','review_contest'): auto kinds are singletons per person-event; review kinds may repeat.

Derivation (inside `accruePayoutsForProposal`, `server/utils/payrollAccrual.js`):

- Derive, never increment. Each run computes the set of auto lines that SHOULD exist per worker and inserts only what is missing. Idempotent across all existing call sites (lifecycle complete, balance scheduler, webhook, tips, service extension, cc import).
- Never resurrect a removed line; never overwrite an `admin_owned` amount; respect the existing gates (proposal `status='completed'`, pay period open, silent skip with Sentry warning otherwise).
- Interplay with `held_state` roster sweeps: a held worker's duty lines are zeroed from the total the same way held positive adjustments are (sign-scoped readers in `paystubData.js` / staff portal payouts get the same treatment). Exact mechanics resolved in the plan.
- Totals: `payouts.total_cents = GREATEST(0, SUM(payout_events.line_total_cents) + SUM(active duty line amounts))`. `payout_events.line_total_cents` math is unchanged. Clawback floor interplay resolved in the plan; do not repeat the ON CONFLICT resurrection pattern.
- Freeze rules unchanged: no creation, edit, or removal once the payout is paid or the period is processing/paid.

Admin API: extend the payroll admin surface with create (admin manual line), amount edit, remove/restore for duty lines, mirroring the existing PATCH guard rails (`server/routes/admin/payroll.js`, frozen-state checks, sane amount cap like the existing +/- $1,000).

Paystub and staff portal: itemize duty lines by label ("Bar rental $20.00", "Menu print $5.00", "Out-of-Area Bonus $35.00", "Review bounty $10.00") on `paystubPdf.js`, `paystubData.js`, and the staff payouts view, grouped under their event when `shift_id` is present, else under an "Other" group.

## 4. Detection

### 4.1 The funded gate

There is no per-line-item payment record; add-ons fold into Deposit/Balance/Full Payment invoices. Detection is the same two-part predicate gratuity accrual already uses (`payrollAccrual.js:296-298`): the proposal carries the item AND `amount_paid >= total_price` (both proposal-level, dollars). Never key on invoice line description text (three spellings exist for bar rental alone).

### 4.2 Sources per kind

- Bar rental: `proposals.num_bars` plus `pricing_snapshot.bar_rental.total > 0`.
- Parking: `parking-fee` row in `proposal_addons` (read slugs via `pricing_snapshot.addons`, which survives catalog deletion; `proposal_addons.addon_id` goes NULL on catalog delete).
- Equipment and supplies: sum of `line_total` over proposal add-ons whose catalog row is flagged storage-pickup (new `service_addons.storage_pickup BOOLEAN`, seeded true for bubble gun / flavor blaster, glassware, carbonation kit, and the like). The bar-rental package fee (`num_bars` money) does NOT count toward the $50 threshold: the bar duty already pays its own $20 via `bar_rental`, and counting it here would double-pay a single pickup. One $20 fee per event when the flagged-add-on total is at least $50.
- Menu print: `proposals.menu_print_key IS NOT NULL AND NOT menu_not_required`. A fulfillment fact, not a payment fact, and deliberately so: prints are free to clients today and stay that way.
- Roster: the canonical approved query (`status='approved' AND dropped_at IS NULL`), positions via `staffingRoles.js`.

### 4.3 Parking rewire (in scope)

On the live v2 planner path clients cannot buy parking: `DayOfV2.js` records `logistics.parking = 'paid'` as text only; nothing attaches the `parking-fee` add-on (only the retired v1 `LogisticsStep.js` did). Rewire: when a v2 drink plan selects paid parking, attach/detach the `parking-fee` add-on to the proposal the way v1 did, flowing through the existing drink-plan extras invoice path. Keep the v1 behavior as the reference implementation. Client copy exists ("A $20 parking fee per staff member is added to your event balance").

## 5. Attribution

- Single-bartender events: auto-attribute all attributed kinds to that bartender at derivation.
- Multi-staff events: attributed kinds (`bar_rental`, `equipment_supplies`, `menu_print`) derive as pending attribution. Clicking Run Payroll surfaces the attribution modal: who brought the bar, who did the pickup, who printed the menu. Confirming stamps the lines to the chosen staffer(s). Reassignable while the period is open.
- `parking` and `out_of_area` never need attribution (everyone / the accepter).

## 6. Out-of-Area Bonus and Remote Staffing Fee

Deliberately judgment-with-instruments, not automation. Killed from earlier drafts: the ZIP-to-tier table as law, the automated local-first posting window with lead-time tiers, the hard eligibility gate, the re-notify flow. Dallas is the window; DRB is small.

Staff side:

- Admin knob on the shift: attach an Out-of-Area Bonus, one amount field. The system suggests an amount from internal bands (40-60 mi: $10; 60-90: $20; 90-120: $35; beyond 120: custom) using venue distance, and shows each active staffer's home distance to the venue beside approvals.
- LOCKED once a staffer accepts a shift carrying the bonus: never reduced, never removed after acceptance. Attach/adjust freely before that.
- Fairness is legible, not enforced: approvals display "home: N mi from venue" so a normal-commute staffer is visibly not owed the premium. Internal guidance (not published): the bonus is for staff traveling roughly 40+ miles.
- Pays through the duty-line engine (`out_of_area`, shift-linked).
- The bonus flag and amount stay recorded on the shift even when the owner works it and no payroll line exists, so remote events report their true cost.

Client side:

- Remote Staffing Fee, a separate object from the staff bonus, never linked to it.
- Popup on proposal Send when the venue is far or thin on coverage: fewer than 3 active staff homes within 40 miles of the venue (haversine over `contractor_profiles.lat/lng`). Copy shape: "This venue is ~85 miles out, 1 active staffer within 40. Add a Remote Staffing Fee? Suggested $20." Options: add suggested, custom amount, send without. Answered once per proposal; re-sends do not nag. No usable venue coordinates: no popup, never guess.
- The fee lands as a surcharge in `proposals.adjustments` labeled "Remote Staffing Fee" (renders via the existing `source_type='manual'` invoice path, inside `total_price`; it is NOT an off-ledger label, do not touch `OFF_LEDGER_INVOICE_LABELS`).
- Billed at proposal time or never. No fee is ever added to a booked client; an unpriced remote event means DRB absorbs the bonus, by design (the bonus amounts are small for exactly this reason).

Geocoding support (in scope): venue coordinates are unreliable today (`shifts.lat/lng` nulled on location change, `eventCreation.js:393-394`; many proposals lack street addresses). Geocode the venue on shift create/update from the proposal venue fields via the existing Nominatim util (`server/utils/geocode.js`, 1 req/sec). Graceful degradation everywhere: missing coordinates disable the suggestion and the popup, never block the action.

Published ambiguity (deliberate): the field guide says only "shifts outside our normal service area may include an Out-of-Area Bonus, at company discretion, based on staffing needs." Client-facing copy carries only: "Dr. Bartender always attempts to staff events with qualified local bartenders first; when local staffing is unavailable, travel costs may apply." No bands, no thresholds, no schedule anywhere public. The bands live only in the admin suggestion code.

## 7. Reviews: bounty and quarterly contest

Counting rule (one currency): a 5-star review that names the staffer personally ("Jane was dope"). Google or Thumbtack both count. 4-stars count for nothing. "Dallas and his team were great" credits no one (planning-stage praise is the owner's work). A review naming two staffers credits both ($10 each). First-name-plus-obvious-context counts; admin is the judge.

Ingest:

- `staff_reviews` table: review date, stars, source ('google'|'thumbtack'), text excerpt, optional proposal/event link, created_by; credited staffers via join rows (a review can credit several).
- Thumbtack: reviews arrive via the existing TT webhook infrastructure; auto-create a pending `staff_reviews` row for admin to confirm and tag names.
- Google: notification email to the admin inbox; manual log in the same surface, ~30 seconds.
- Logging a named 5-star creates the $10 `review_bounty` duty line per credited staffer in the current open period (no shift link required). The `staff_review_id` uniqueness stops double-pays.

Quarterly contest:

- Eligibility floor: worked at least 4 events in the quarter AND earned at least 2 named 5-stars. (Floor numbers are admin knobs; these are the seeds.) "Events worked" = events whose date falls in the quarter where the staffer holds an approved, non-dropped shift request (`status='approved' AND dropped_at IS NULL`).
- Winner: highest rate, named 5-stars divided by events worked in the quarter. Tie splits the $100 pot.
- Leaderboard view computes from `staff_reviews` plus events worked; displays plainly ("3 of 10 events reviewed").
- Award is a one-click admin action creating the `review_contest` line(s). Never automatic.

Policy line for the field guide: staff may mention that reviews help; never offer a guest or client anything in exchange for a review; reviews from friends or family do not count.

## 8. Policy text

Field guide (`client/src/pages/FieldGuide.js`):

- New section "Duty Pay & Bonuses": the concrete schedule for bar rental $20, parking $20 (only when the client paid for parking; carpool passengers excluded), equipment and supplies $20 (one per event; hosted events pay hourly instead), menu print $5 (frame rules as in section 2), review bounty $10 and the quarterly $100 contest (floor, rate rule, named-and-five-stars requirement, no-incentives rule), and: "duty pay appears automatically on your payout and is confirmed at payroll time." Travel gets ONLY the ambiguous discretionary line from section 6. No bands published.
- Section 08 (Loaner Gear & Supply Runs): drop "we'll cover costs if it's pre-approved" in favor of pointing at the new section.
- Section 10 (Paperwork & Payments): add a pointer to the new section.

Contractor agreement (`server/data/contractorAgreement.js`):

- Bump `CURRENT_VERSION` to v3, keep v2 in the `VERSIONS` map. One added sentence in the Compensation clause: duty-based fees and bonuses are paid per the published Field Guide schedule, which the Company may update. Numbers stay out of the legal doc.
- NO re-consent flow (explicit decision): v3 applies to new signers; existing staff stay on v2 and get an announcement email when this ships ("new duty pay schedule is live, see the field guide"). Clause 11 already reserves field-guide updates with notice. The missing re-consent mechanism goes on the backlog for a future policy change that takes something away.

## 9. Admin surfaces

- Payroll screen (`EventLineItem.js` area): duty lines listed under each person's event line, amount editable, remove checkbox, restore. Run Payroll triggers the attribution modal when unattributed lines exist on multi-staff events.
- Shift page: Out-of-Area knob, suggested amount, per-staffer home distances beside approvals, locked indicator.
- Proposal Send: the far-venue popup.
- Reviews: log/confirm surface plus the quarterly leaderboard with one-click award.

## 10. Build order (lane shape for the plan)

1. Duty-line engine: schema, derivation in accrual, totals, paystub/portal itemization. Money seam, full review fleet.
2. Detection triggers plus the parking v2 rewire (client money path: full fleet).
3. Payroll UI: line display, edit/remove, attribution modal.
4. Out-of-Area: shift knob, distances, geocode-on-shift fix, Send popup, Remote Staffing Fee surcharge.
5. Reviews: tables, TT webhook ingest, log surface, bounty lines, leaderboard, contest award.
6. Policy text: field guide sections, agreement v3, announcement email. Copy, light review.

## 11. Out of scope (parked)

- Tip/review hardware: the 4x6 two-sided PVC bar postcard (TIP/REVIEW faces, QR + NFC each) and personal NFC business cards (review front, name + tip QR back). Designed, deferred.
- Review funnel page (star filter to Google vs internal feedback) and any tip-page changes; the post-tip review ask stays as-is until the separate review tap exists.
- POD/direct-ship framed menu prints (Printful-style): keep bartender-prints flow.
- Agreement re-consent flow.
- Automated local-first posting window, zone ZIP table (killed by decision, not deferred).
- Receipt reimbursements (backlog Project C).

## 12. Key code anchors

- `server/utils/payrollAccrual.js` (idempotent recompute, funded gate :296-298, roster query :202-211, held_state :23-89, :500-545)
- `server/db/schema.sql`: `payout_events` :2903-2946, `service_addons` :655-807, `proposal_addons` :880-891, `agreements` :110-145
- `server/routes/admin/payroll.js` (PATCH guard rails :121-200), `server/utils/paystubData.js`, `server/utils/paystubPdf.js`, `server/utils/payrollClawback.js`, `server/utils/payrollLateTip.js`
- `server/utils/pricingEngine.js` (`calculateBarRental` :111, staff counting :385), `server/utils/lineItemCancel.js` (the existing what-did-the-client-buy enumerator)
- `client/src/pages/plan/v2/steps/DayOfV2.js` + retired `client/src/pages/plan/steps/LogisticsStep.js` (parking rewire reference)
- `server/utils/autoAssign.js` (`haversineDistance` :18-27), `server/utils/geocode.js`, `server/utils/eventCreation.js` (:393 coord nulling, `computeSupplyRunDefault` :133)
- `server/routes/proposals/menuPrint.js`, `client/src/components/staff/BeoSections.js:311-316` (the live $5 promise)
- `server/data/contractorAgreement.js`, `client/src/pages/FieldGuide.js`
- `server/utils/proposalMoneyShared.js` (`OFF_LEDGER_INVOICE_LABELS`: do not touch)
