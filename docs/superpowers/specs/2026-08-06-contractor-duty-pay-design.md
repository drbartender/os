# Contractor Duty Pay, Out-of-Area Bonus, and Review Rewards

Design spec, 2026-08-06. Brainstormed live with Dallas; section-by-section approvals are the approval. Revised same day after the /review-spec fleet (13 blockers folded back in; Dallas decisions: hosted flat-hours block, manager access to the bonus knob, manager-visible distances, announcement handled manually).

Ancestor doc: `docs/staff-ops-backlog-2026-07-22.md` (Project B). This spec supersedes its pay-rules portion. Project C (receipt reimbursements) and Project D (staff directory) remain separate and unbuilt.

Money seam: read `.claude/seam-sweep-2026-07-02.md` before planning. Finding M5 there (roster corrections orphaning payable lines) is directly relevant; section 3.5 exists because of it.

## 1. Goal

Duty-based pay stops living in admin memory. When the booking says a duty happened (bar brought, supplies picked up, menu printed, parking paid, remote venue staffed, review earned), the matching contractor pay line is created automatically, is visible on the paystub by name, and is editable and removable at payroll time. All policy is written down: the field guide carries the schedule, the contractor agreement points at it.

Known live bug this closes first: staff-facing copy already promises "a flat $5 for the print" (`client/src/components/staff/BeoSections.js:312-317`) with zero payroll plumbing behind it.

## 2. Locked amounts and rules

| Kind | Amount | Trigger (all also require the proposal funded, see 4.1) | Who |
|---|---|---|---|
| `bar_rental` | $20 | `num_bars > 0` and nonzero `pricing_snapshot.bar_rental.total` | Attributed bartender |
| `parking` | $20 | `parking-fee` add-on on the proposal | Every approved staffer, no attribution |
| `equipment_supplies` | $20 | Client paid at least $50 of storage-pickup add-ons; ONE fee per event, not per add-on. BYOB/flat packages only, never hosted | Attributed staffer |
| `hosted_supplies` | hours block x staffer hourly rate | Hosted package (`isHostedPackage`) with any storage-pickup add-on or `num_bars > 0`; replaces both `equipment_supplies` and `bar_rental` on hosted events | Attributed staffer |
| `menu_print` | $5 | `menu_print_key` present and `menu_not_required` false | Attributed bartender |
| `out_of_area` | Admin/manager-set, capped $250 (suggest bands, see 6) | Attached to shift; locked per accepter, see 6 | Accepting staffer |
| `review_bounty` | $10 | Admin logs a named 5-star review (Google or Thumbtack) | Each named staffer |
| `review_contest` | $100 | Admin one-click award at quarter end | Quarter winner (tie splits the pot) |

Related rules:

- Bringing your own bar or picking up a DRB bar at the Pilsen storage unit both qualify for the same $20.
- Menu print: frame required, frames stocked at Pilsen, planning size 8x10. The print always stays with the client; a DRB-stocked frame stays too; a bartender's personal frame can go home. Tablet display is an acceptable alternative (no line).
- Hosted events (Dallas decision 2026-08-06, replaces the 7/22 "hourly for actual handling" idea): supply and load work on hosted events pays a FLAT HOURS BLOCK as the `hosted_supplies` duty line, default 2.5 hours (policy range 2 to 3) times the attributed staffer's `contractor_profiles.hourly_rate`, editable like any duty line. This deliberately does NOT touch `payrollMath.contractedHours()` (no hosted branch exists there today; adding one would be a retroactive wage change to every past hosted event). Actual-hours tracking is explicitly rejected as a pain. `hosted_supplies` replaces both the $20 equipment fee and the $20 bar share on hosted events so one pickup is never paid twice.
- Parking pays every approved staffer because the client is charged per staff member (`per_staff` billing, barbacks and servers included). Carpool passengers: admin unchecks their line. Known and accepted divergence: the client is billed on the PRICED staff count at proposal time (`pricingEngine.js` totalStaff) while payout follows the APPROVED ROSTER at accrual; a roster that grew or shrank after pricing pays a different headcount than was billed. Small amounts, accepted.
- Tax treatment: all duty lines are pay for services, not substantiated expense reimbursements. They flow into `payouts.total_cents` and therefore into the 1099 rollup (`server/routes/admin/payrollTax.js` sums `payouts.total_cents`; this holds because of the single-writer rule in 3.3). Typed lines keep a future carve-out possible; nothing changes now.

## 3. Data model: typed duty lines

`payout_events` cannot hold this: `UNIQUE(payout_id, shift_id)` with `shift_id NOT NULL` means one row per person per event, and `adjustment_cents` is untyped and admin-owned after first accrual. Rejected alternatives: folding into `adjustment_cents`; per-kind columns on `payout_events`.

### 3.1 Tables

New table `payout_duty_lines`:

- `id`, `payout_id` FK payouts ON DELETE CASCADE (NOT NULL), `contractor_id` FK users NOT NULL (denormalized from the payout; carries review-kind uniqueness across periods)
- `shift_id` FK shifts ON DELETE RESTRICT, NULLABLE: event-derived kinds carry it; review kinds may not
- `kind` TEXT CHECK in ('bar_rental','parking','equipment_supplies','hosted_supplies','menu_print','out_of_area','review_bounty','review_contest')
- `amount_cents` INTEGER NOT NULL (all math in integer cents; every dollars source such as `proposal_addons.line_total` NUMERIC crosses the boundary via `Math.round(x * 100)` exactly once)
- `origin` TEXT CHECK ('auto','admin'), `admin_owned` BOOLEAN default false (set on any admin amount edit; derivation never overwrites an owned amount)
- `removed_at` TIMESTAMPTZ, `removed_by` (the remove checkbox; system reversals write `removed_by = NULL` with a `note`). Removed rows are KEPT so derivation never resurrects (`docs/fix-list-remaining-2026-07-02.md:71` precedent). Restore clears `removed_at` and restores the stored amount (no re-derive). Editing an amount to $0 is distinct from removal.
- `note` TEXT
- `staff_review_id` FK NULLABLE (review_bounty), `contest_quarter` TEXT NULLABLE like '2026-Q3' (review_contest)
- `created_at`, `updated_at`
- Uniqueness: partial `UNIQUE(payout_id, shift_id, kind)` for the event-derived kinds; `UNIQUE(staff_review_id, contractor_id)` for bounties (per review per person ACROSS periods, so re-logging after a period rolls cannot double-pay); `UNIQUE(contest_quarter, contractor_id)` partial for contest awards (double-click pays once).

New table `duty_attributions` (solves "a pending line has nowhere to live": `payout_id` is NOT NULL and per-contractor, so an unattributed line cannot exist as a row):

- `proposal_id`, `kind`, `user_id`, `attributed_by`, `attributed_at`, `UNIQUE(proposal_id, kind)`
- Lines for attributed kinds are only ever materialized AFTER an attribution row exists. Single-eligible-staffer events get their attribution row auto-written at derivation. Multi-staff events surface the attribution modal (section 5) which writes the rows; derivation then materializes the lines on its next run (the modal triggers one).

### 3.2 Derivation

Runs inside `accruePayoutsForProposal` (`server/utils/payrollAccrual.js`). Full caller set is EIGHT sites: `proposals/lifecycle.js`, `balanceScheduler.js`, `paymentIntentSucceeded.js`, `payrollTips.js`, `serviceExtensionSweep.js`, `ccImport/proposalActions.js`, and the two admin re-accrual sites in `admin/payroll.js` (fee recapture, tip assign).

- Derive, never increment. Each run computes the set of auto lines that SHOULD exist and reconciles both directions:
  - Missing and trigger true and attribution satisfied: INSERT with `ON CONFLICT DO NOTHING` against the partial unique index. Safe because amounts are derived, not accumulated; a conflict means a concurrent run already materialized the line. Two racing accrual callers must never abort the surrounding transaction.
  - Existing auto line whose trigger has gone FALSE (refund dropped the funded gate, menu print deleted, parking or pickup add-on cancelled via `lineItemCancel.js`, `num_bars` lowered): while the pay period is open, soft-remove it (`removed_at` set, `removed_by = NULL`, note 'trigger no longer met'), UNLESS `admin_owned` or `origin='admin'`, which are never system-removed. Once the payout is paid or the period is processing/paid: no automatic clawback ever; raise a Sentry-visible admin alert instead (amounts are small; human decides).
  - A removed row (by admin or system) is never resurrected by derivation. If the trigger goes true again after a system removal, derivation clears the system removal (admin removals stay removed).
- Existing gates respected: proposal `status='completed'`, pay period open. The `pay_period_not_open` silent skip is acceptable for launch because derivation re-runs on every accrual; the plan must include a catch-up re-derive when a period opens (same class as the ship backfill in 10.1).
- Review-kind lines are derived from `staff_reviews` rows into the CURRENT OPEN period's payout. If no period is open, the `staff_reviews` row simply waits (nothing is lost; the next derivation after a period opens materializes it). Late-tip deferral precedent: `payrollLateTip.js`.

### 3.3 Totals: one writer

`payouts.total_cents = GREATEST(0, SUM(payout_events.line_total_cents) + SUM(active duty line amount_cents))` where active = `removed_at IS NULL`.

The fleet found SIX sites that recompute the total from `payout_events` alone: `payrollAccrual.js` (both sweeps), `payrollClawback.js`, `payrollLateTip.js`, `payrollProcessing.js` `recomputePayoutTotal` (called by the admin PATCH), and `serviceExtensionPayroll.js`. The fix is structural, not six patches: `recomputePayoutTotal` in `payrollProcessing.js` becomes THE single writer of `payouts.total_cents`, extended to include active duty lines, and all six sites are refactored to call it. Any future writer that sums `payout_events` directly is a bug by definition. `ARCHITECTURE.md`'s "total_cents = clamped sum of its lines" wording updates with this.

### 3.4 Payout lifecycle guards

Both empty-payout cleanups (`payrollAccrual.js`, the pending-payout DELETE ... WHERE NOT EXISTS payout_events) must also check `NOT EXISTS (active payout_duty_lines)`. A payout carrying only duty lines (the shift-less review case) is legitimate and must survive; today's predicate would CASCADE-delete a $100 contest award tracelessly.

### 3.5 Roster corrections (seam-sweep M5)

The held/orphan roster sweeps operate on `payout_events` only. Duty-line analog, same pass:

- A worker who leaves the approved roster (denied, dropped) has their auto duty lines system-removed while the period is open (same rules as 3.2 reversal; `admin_owned` lines follow the existing `held_state` semantics: held, zeroed from the total, chip for admin confirm).
- An attribution row pointing at an off-roster worker is flagged; the payroll screen shows "needs re-attribution" and the process gate (5) refuses until resolved.
- Sign-scoped readers (`paystubData.js`, staff portal payouts) treat held duty money the way they treat held positive adjustments.

### 3.6 Admin API

New sibling route file `server/routes/admin/payrollDuty.js` (`payroll.js` is over the size ratchet; `payrollTax.js` set the extraction precedent). Endpoints: create manual line (kind from the CHECK list, amount validated, admin only), amount edit, remove, restore, attribution write/re-write. Guard rails mirror the existing PATCH: frozen when payout paid or period processing/paid; allowed in `reopened` (same as the existing PATCH); absolute amount cap $1,000 matching the adjustment cap. EVERY mutation writes a `logAdminAction` row (the existing payout-event PATCH writes none; duty lines do not inherit that gap; the create/edit/remove/attribute/award actions are all admin money mutations).

Validation parity: client mirrors the server rules (kind whitelist, cents integer, cap) with inline error copy; server is authoritative.

### 3.7 Paystub and staff portal

- `paystubPdf.js` / `paystubData.js`: add a sixth category row "Duty pay" to BOTH the this-period and YTD aggregates so the stub keeps footing against NET PAID (which reads `payouts.total_cents`, the canonical total). Itemized duty lines render under their event (or an "Other" group when `shift_id` is NULL). The PDF is hand-positioned with no pagination; the plan must handle row overflow (page break or per-event compaction) since duty rows roughly halve the row budget.
- Staff portal (`server/routes/staffPortal/payouts.js`): the events query INNER JOINs `shifts` and cannot project NULL-shift lines; duty lines come from their own query (pinned `po.contractor_id = req.user.id`, same IDOR scoping as the rest of the endpoint) and the summary math includes the duty category so it foots against `total_cents`. The current-period tile counts events from `payout_events`; a duty-only payout must not render as "$X, 0 events" without a label ("includes duty pay").

## 4. Detection

### 4.1 The funded gate

No per-line-item payment record exists. Detection is the predicate gratuity accrual already uses (`payrollAccrual.js:296-298`): the proposal carries the item AND `amount_paid >= total_price`. Never key on invoice line description text.

### 4.2 Sources per kind

- Bar rental: `proposals.num_bars` plus `pricing_snapshot.bar_rental.total > 0`.
- Parking: `parking-fee` row read via `pricing_snapshot.addons` slugs (survives catalog deletion; `proposal_addons.addon_id` nulls on catalog delete).
- Equipment and supplies: REUSE `service_addons.requires_provisioning` (exists, means "staff must acquire/transport", already seeded for flavor-blaster, real-glassware, carbonated-cocktails, and already drives `computeSupplyRunDefault`). NO new catalog flag: two overlapping flags would drift. If a future add-on is provisioning-but-not-storage-pickup, split the flag then. Threshold: flagged add-on `line_total` sum, converted to cents, at least $50.00. The bar-rental package fee (`num_bars` money) does NOT count toward the threshold: the bar duty already pays its own $20; counting it here would double-pay a single pickup. One $20 fee per event.
- Menu print: `menu_print_key IS NOT NULL AND NOT menu_not_required`. A fulfillment fact (admin upload); prints stay free to clients. The upload can be deleted later; reversal follows 3.2.
- Roster: the canonical approved query (`status='approved' AND dropped_at IS NULL`), positions via `staffingRoles.js`.

### 4.3 Parking rewire (in scope)

Clients cannot buy parking on the live path: v2 planner records `logistics.parking = 'paid'` as text only (`DayOfV2.js`); only the retired v1 planner attached the add-on. Rewire, deliberately narrow:

- ATTACH happens at drink-plan submit: paid-lot selection adds the `parking-fee` add-on through the existing extras fold/invoice-at-submit path. Plans are submit-once, so this is a one-shot client action that only ever RAISES `total_price` (which correctly re-evaluates payment status on increase).
- No client detach path exists or is added. Removal is admin-only through the existing cancel-line-item flow (`lineItemCancel.js`), which already handles money unwind correctly. This closes the fleet's finding that a public-token detach could lower `total_price` and flip the funded gate true from an unauthenticated surface.
- Expose `parking-fee` in the ADMIN add-on picker (today `proposalRules.js` hides it from everyone) so admins can attach it when clients arrange parking by phone.
- Fix the v2 disclosure copy: it currently hardcodes $20 x `num_bartenders` while billing is `per_staff` (all staff). Copy must state the real math.

## 5. Attribution

- Eligible sets: `menu_print` and `bar_rental` attribute among approved bartenders; `equipment_supplies` / `hosted_supplies` among all approved staff. Exactly one eligible person: auto-write the attribution row at derivation (a one-bartender-plus-barback crew auto-attributes bar and menu to the bartender). Zero eligible (no bartender on a bar/menu duty): no auto line; admin resolves manually.
- Multi-eligible events: duties derive as attribution-pending (no line rows exist yet, see 3.1). The admin control is "Process period" (`PayRunView.js`, `POST /admin/payroll/periods/:id/process`); there is no literal "Run Payroll" button. Because processing FREEZES line edits, the attribution modal must resolve strictly BEFORE the process call: the process endpoint returns 409 while unattributed duties or flagged re-attributions exist in the period, and the UI intercepts Process to pop the modal first (who brought the bar, who did the pickup, who printed the menu).
- Confirming writes attribution rows and triggers derivation; re-attribution while the period is open moves the line between the two contractors' payouts in ONE transaction with both totals recomputed via the single writer (3.3), re-validating against the current approved roster at confirm time (a staffer who dropped between modal open and confirm is rejected).
- `parking` and `out_of_area` never attribute (everyone / the accepter).
- Modal states: loading, error-with-retry, and an explicit "dismissed without completing" path that leaves Process blocked with a visible reason.

## 6. Out-of-Area Bonus and Remote Staffing Fee

Judgment-with-instruments, not automation. Killed by decision: the ZIP-to-tier table as law, the automated local-first posting window, the hard eligibility gate, the re-notify flow. Dallas is the window; DRB is small.

Staff side:

- Shift knob: attach an Out-of-Area Bonus, one amount field. Access: `requireStaffing` (admin and `can_staff` managers; Dallas decision), hard cap $250 (the bands top out at $35; Madison-class custom is ~$100; the cap bounds the blast radius of the irreversible lock below). Suggested amount from internal bands (40-60 mi: $10; 60-90: $20; 90-120: $35; beyond 120: custom) using venue distance.
- New shift columns: bonus amount, attached_by/at, locked_at, locked_user_id. NULL on all existing rows (no backfill needed; feature is forward-only).
- LOCK, precisely defined: the lock stamps when the shift request of a staffer becomes approved while the bonus is attached (admin approval, manager approval, auto-assign, or cover claim; there is no separate staffer "accept" event in the system). While that staffer holds the shift the bonus is never reduced or removed. If they drop, the lock releases and the still-attached bonus re-arms for the next approved staffer. Attach/adjust freely before any approval.
- Fairness is legible, not enforced: approvals display each requester's home distance to the venue ("home: 8 mi from venue"). Visible to admin AND `can_staff` managers (Dallas decision 2026-08-06: manager visibility accepted; distances are derived, home addresses are not shown). Internal guidance, not published: the bonus is for staff traveling roughly 40+ miles.
- Pays through the duty-line engine (`out_of_area`, shift-linked, amount = the locked shift amount).
- The bonus flag and amount stay on the shift even when the owner works it and no payroll line exists, so remote events report their true cost.

Client side:

- Remote Staffing Fee, a separate object from the staff bonus, never linked to it.
- Popup on the ADMIN send surfaces only: the proposal editor SendModal and the ProposalDetail send/status action. The public self-serve wizard and Thumbtack auto-drafts get no popup (admin reviews TT drafts anyway and can add the fee in the editor). Trigger: fewer than 3 active staff homes within 40 miles of the venue. Copy shape: "This venue is ~85 miles out, 1 active staffer within 40. Add a Remote Staffing Fee? Suggested $20." Options: add suggested, custom amount, send without. Answered once per proposal via a new `proposals.remote_fee_prompted_at` column.
- Counting rules: "active staff" = `onboarding_status = 'approved'` (one definition, stated here). Staff with NULL coordinates are excluded from the within-40 count AND surfaced: "2 staff uncounted (no geocoded address)". They never silently count as far.
- The fee lands as a surcharge in `proposals.adjustments` labeled "Remote Staffing Fee" (existing `source_type='manual'` invoice path, inside `total_price`; NOT off-ledger; do not touch `OFF_LEDGER_INVOICE_LABELS`).
- Billed at proposal time or never. No fee is ever added to a booked client; an unpriced remote event means DRB absorbs the bonus, by design.

Geocoding support (in scope): geocode the venue on shift create/update, GATED on a complete street address (`isVenueComplete` / `venue_street` present). Nominatim with `limit=1` returns a city centroid for street-less queries with no confidence signal, so street-less venues get NO coordinates, which correctly disables the suggestion, the distances, and the popup (never guess). The geocode call owns its own 1 req/sec throttle (`geocode.js` provides only a delay helper; callers must apply it). Missing coordinates never block any action.

Published ambiguity (deliberate): field guide says only "shifts outside our normal service area may include an Out-of-Area Bonus, at company discretion, based on staffing needs." Client-facing copy carries only: "Dr. Bartender always attempts to staff events with qualified local bartenders first; when local staffing is unavailable, travel costs may apply." No bands, no thresholds, no schedule anywhere public. Bands live only in the admin suggestion code.

## 7. Reviews: bounty and quarterly contest

Counting rule (one currency): a 5-star review that names the staffer personally ("Jane was dope"). Google or Thumbtack both count. 4-stars count for nothing. "Dallas and his team were great" credits no one. A review naming two staffers credits both ($10 each). First-name-plus-obvious-context counts; admin is the judge.

Ingest:

- `staff_reviews` table: review date, stars, source ('google'|'thumbtack'), text excerpt, optional proposal link, created_by; credited staffers via join rows. NEW COLUMN `tt_review_id` UNIQUE NULLABLE referencing `thumbtack_reviews.review_id`: `thumbtack_reviews` plus its webhook ingest ALREADY EXIST (`server/routes/thumbtack.js`, `ON CONFLICT (review_id) DO NOTHING`, signature-verified). The TT path auto-creates a pending `staff_reviews` row keyed by `tt_review_id`, so a webhook replay cannot mint a second one, and the manual-log surface warns when a TT-sourced row already exists for that review. Google reviews are manual rows with no external key (admin judgment is the dedup).
- Admin confirms and tags names; confirming a named 5-star makes each credited staffer eligible for a $10 `review_bounty` line, derived into the current open period (or waiting for one, 3.2). `UNIQUE(staff_review_id, contractor_id)` on the duty line makes the pay idempotent per person per review, across periods.
- Corrections: while the target period is open, un-tagging removes the line (system removal). After the line is paid: alert-only, human decides (3.2 rule).

Quarterly contest:

- Eligibility floor: worked at least 4 events in the quarter AND earned at least 2 named 5-stars. (Admin knobs; these are the seeds.) "Events worked" = events whose date falls in the quarter where the staffer holds an approved, non-dropped shift request.
- Winner: highest rate, named 5-stars divided by events worked. Tie splits the $100 pot.
- Leaderboard view computes from `staff_reviews` plus events worked; displays plainly ("3 of 10 events reviewed"). Empty state: "no qualifying staff this quarter."
- Award is a one-click admin action creating the `review_contest` line(s) with `contest_quarter` stamped; `UNIQUE(contest_quarter, contractor_id)` makes the click idempotent (a double-click or retry cannot pay $200). Never automatic.

Policy line for the field guide: staff may mention that reviews help; never offer a guest or client anything for a review; reviews from friends or family do not count.

## 8. Policy text

Field guide (`client/src/pages/FieldGuide.js`):

- New section "Duty Pay & Bonuses": the concrete schedule for bar rental $20, parking $20 (only when the client paid for parking; carpool passengers excluded), equipment and supplies $20 (one per event; hosted events get the flat supply-hours block instead), menu print $5 (frame rules per section 2), review bounty $10 and the quarterly $100 contest (floor, rate rule, named-and-five-stars, no-incentives rule), and: "duty pay appears automatically on your payout and is confirmed at payroll time." Travel gets ONLY the ambiguous discretionary line from section 6.
- Section 08 (Loaner Gear & Supply Runs): drop "we'll cover costs if it's pre-approved" in favor of pointing at the new section.
- Section 10 (Paperwork & Payments): add a pointer to the new section.

Contractor agreement (`server/data/contractorAgreement.js`):

- Bump `CURRENT_VERSION` to v3, keep v2 in the `VERSIONS` map. One added sentence in the Compensation clause: duty-based fees and bonuses are paid per the published Field Guide schedule, which the Company may update. Numbers stay out of the legal doc.
- NO re-consent flow (explicit decision): v3 applies to new signers; existing staff stay on v2. Announcement to current staff is handled MANUALLY by Dallas (his call, out of scope; no broadcast infrastructure gets built).

## 9. Admin surfaces

- Payroll screen: duty lines under each person's event line (or "Other" for shift-less lines), amount editable, remove checkbox, restore; loading/error/disabled states per the existing `EventLineItem` patterns, error shows retry. Process intercept pops the attribution modal (5).
- Shift page: Out-of-Area knob (access and cap per 6), suggested amount, requester home distances beside approvals, locked indicator.
- Proposal editor/detail: the far-venue Send popup (6).
- Reviews: log/confirm surface plus the quarterly leaderboard with one-click award.
- Every mutation on these surfaces audit-logs (3.6).

## 10. Build order (lane shape for the plan)

1. Duty-line engine: schema (`payout_duty_lines`, `duty_attributions`, shift bonus columns, `staff_reviews`, `proposals.remote_fee_prompted_at`, all idempotent), derivation with reversal, single-writer totals refactor (3.3), lifecycle guards (3.4), roster sweep analog (3.5), `payrollDuty.js` API, paystub/portal itemization and footing. Money seam, full review fleet.
2. Detection triggers plus the parking v2 rewire and copy fix (client money path: full fleet).
3. Payroll UI: line display, edit/remove/restore, attribution modal, process 409 gate.
4. Out-of-Area: shift knob + cap + guard, distances, geocode-on-shift (street-gated, throttled), Send popup + `remote_fee_prompted_at`, Remote Staffing Fee surcharge, admin picker exposure of `parking-fee`.
5. Reviews: `staff_reviews` + `tt_review_id` bridge, TT ingest hook, log surface, bounty derivation, leaderboard, contest award.
6. Policy text: field guide sections, agreement v3. Copy, light review.

### 10.1 Ship backfill

At deploy, a one-time re-derive runs `accruePayoutsForProposal` over completed proposals in the current open pay period so the shipping period gets its duty lines (including the promised $5 prints). Same mechanism serves the period-open catch-up in 3.2.

### 10.2 Documentation updates (mandatory per CLAUDE.md)

README folder tree (`payrollDuty.js`, new components); ARCHITECTURE route table (new admin routes), schema section (new tables/columns), and the `payouts.total_cents` invariant wording (now includes duty lines via the single writer). No new env vars, no new integrations.

## 11. Out of scope (parked)

- Tip/review hardware: the 4x6 two-sided PVC bar postcard (TIP/REVIEW faces, QR + NFC each) and personal NFC business cards (review front, name + tip QR back). Designed, deferred.
- Review funnel page (star filter to Google vs internal feedback) and any tip-page changes; the post-tip review ask stays as-is until the separate review tap exists.
- POD/direct-ship framed menu prints: keep bartender-prints flow.
- Agreement re-consent flow; staff email broadcast infrastructure.
- Automated local-first posting window, zone ZIP table (killed by decision, not deferred).
- Receipt reimbursements (backlog Project C).

## 12. Key code anchors

Line numbers verified by the grounding reviewer 2026-08-06; treat as approximate after any edit.

- `server/utils/payrollAccrual.js` (idempotent recompute; funded gate :296-298; roster query :202-211; held_state :23-89, :500-545; empty-payout deletes :254-259 and :614-620; total writes :261 and :632)
- `server/utils/payrollProcessing.js` (`recomputePayoutTotal` :34, becomes the single total writer), `server/utils/serviceExtensionPayroll.js` (:155 total write, refactor to the single writer), `server/utils/payrollClawback.js` (:241), `server/utils/payrollLateTip.js` (:200, deferral-marker precedent)
- `server/db/schema.sql`: `payout_events` :2922, `service_addons` :667 (`requires_provisioning` :3565, seeds :3571-3583), `proposal_addons` :892, `agreements` :122, `thumbtack_reviews` :1867, `contractor_profiles.lat/lng` :1199-1200
- `server/routes/admin/payroll.js` (PATCH guard rails :133-250; `recomputePayoutTotal` call :240; process endpoint; re-accrual sites :294, :640), `server/routes/admin/payrollTax.js` (:118 sums `payouts.total_cents`), `server/utils/paystubData.js` (:87-111 category aggregates), `server/utils/paystubPdf.js` (:112-117 five-row footing)
- `server/routes/staffPortal/payouts.js` (:159-176 INNER JOIN shifts; :190-246 summary), `server/routes/staffPortal.js` (:126-129 event_count tile)
- `server/utils/pricingEngine.js` (`calculateBarRental` :111; totalStaff :383-386; `isHostedPackage`), `server/utils/payrollMath.js` (`contractedHours`, deliberately untouched), `server/utils/lineItemCancel.js` (cancel unwind; reversal trigger source)
- `client/src/pages/plan/v2/steps/DayOfV2.js` (:21-22 hardcoded copy math) + retired `client/src/pages/plan/steps/LogisticsStep.js` (attach reference), `client/src/utils/proposalRules.js` (:116 parking-fee hidden), `server/utils/proposalExtrasFold.js` (re-evaluates payment on increase)
- `server/utils/autoAssign.js` (`haversineDistance` :18-27, exported :428), `server/utils/geocode.js` (no built-in throttle; delay helper :59), `server/utils/eventCreation.js` (:393-394 coord nulling; `computeSupplyRunDefault` :133), `server/utils/venueAddress.js` (`isVenueComplete`)
- `server/routes/proposals/menuPrint.js` (upload :77, delete :110), `client/src/components/staff/BeoSections.js:312-317` (the live $5 promise)
- `server/routes/thumbtack.js` (:571-620 review webhook, `ON CONFLICT (review_id) DO NOTHING`), `server/data/contractorAgreement.js`, `client/src/pages/FieldGuide.js` (§08 :115, §10 :145)
- `client/src/pages/admin/payroll/PayRunView.js` (:322 Process control), `client/src/pages/admin/payroll/EventLineItem.js` (edit patterns)
- `server/utils/proposalMoneyShared.js` (`OFF_LEDGER_INVOICE_LABELS` :47: do not touch)
