# Staff Payment System — Design Spec

**Status:** Approved section by section during brainstorming, 2026-05-22. Ready for implementation planning.
**Date:** 2026-05-22
**Author:** Dallas + Claude
**Branch:** `staff-payments`

---

## 1. Overview

Dr. Bartender pays its contractors (bartenders, barbacks, servers) by hand: remembering payroll is due, working out who is owed what, then paying each contractor one at a time inside their own payment app. This system replaces that with a weekly payroll worklist that computes every payout, assists the payment itself, and gives the admin and the staff a transparent, itemized record.

This is a first version by design. The system computes and records payouts and makes paying fast; it does not move money on its own. Funds still leave through the admin's existing accounts (Venmo, Cash App, PayPal, Chase ACH, paper check).

## 2. Scope

### In scope

- New tables: `pay_periods`, `payouts`, `payout_events`. New columns on `tips`.
- Per-event payout computation: wage, gratuity share, card-tip share, all netted for card processing fees.
- Weekly Tuesday-to-Monday pay periods with a holiday-aware payday.
- The admin payroll portal, a section under Financials: the worklist, itemized rows, assisted payment, mark-paid.
- The staff side: a My Pay page and a paystub PDF generated for every period worked.
- Notifications: a payroll-due reminder to the admin and a paystub-ready email to each contractor.
- Updates to contractor-facing pay-policy copy (Field Guide, Payday Protocols, and any other page that states a pay policy).

### Deferred to separate workstreams

- **Year-end 1099 generation and delivery.** The ledger keeps per-contractor year-to-date totals correct and exportable. Generating and delivering the actual 1099 documents is a later pass.
- **Contractor agreement v3.** The contractor agreement is a signed, versioned legal document. Changing its pay terms is a re-version with a re-acknowledgement decision, tracked alongside this build rather than inside it. See Section 14.
- **Automated ACH and paper checks.** A direct bank integration is not realistic, and a third-party payables provider is its own money-movement pipeline. Not pursued now. ACH and check stay manual.

## 3. Data model

All money is stored in integer cents. Schema statements are idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), per the project's schema conventions.

### 3.1 `pay_periods`

One row per Tuesday-to-Monday window.

```sql
CREATE TABLE IF NOT EXISTS pay_periods (
  id SERIAL PRIMARY KEY,
  start_date DATE NOT NULL,            -- a Tuesday
  end_date DATE NOT NULL,              -- the following Monday
  payday DATE NOT NULL,                -- second working day on or after end_date (see Section 5)
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'processing', 'paid')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (start_date)
);
```

### 3.2 `payouts`

One row per contractor per pay period. This is a single worklist row and becomes that contractor's paystub.

```sql
CREATE TABLE IF NOT EXISTS payouts (
  id SERIAL PRIMARY KEY,
  pay_period_id INTEGER NOT NULL REFERENCES pay_periods(id),
  contractor_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid')),
  total_cents INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,                 -- snapshot of the method used, set at mark-paid
  payment_handle TEXT,                 -- snapshot of the handle used, set at mark-paid
  paid_at TIMESTAMPTZ,
  paid_by INTEGER REFERENCES users(id),
  paystub_storage_key TEXT,            -- R2 object key for the generated paystub PDF
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (pay_period_id, contractor_id)
);
```

### 3.3 `payout_events`

The line items inside a payout, one per event the contractor worked that period. This is what the expandable worklist row and the paystub itemize.

```sql
CREATE TABLE IF NOT EXISTS payout_events (
  id SERIAL PRIMARY KEY,
  payout_id INTEGER NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  contracted_hours NUMERIC(5,2) NOT NULL,   -- event duration + 1h setup + 0.5h breakdown
  hours NUMERIC(5,2) NOT NULL,              -- hours actually paid; defaults to contracted_hours
  rate_cents INTEGER NOT NULL,              -- per-hour rate; defaults to the contractor's rate
  wage_cents INTEGER NOT NULL DEFAULT 0,    -- round(hours * rate_cents)
  late BOOLEAN NOT NULL DEFAULT FALSE,      -- record only; never auto-docks
  gratuity_share_cents INTEGER NOT NULL DEFAULT 0,
  card_tip_gross_cents INTEGER NOT NULL DEFAULT 0,
  card_tip_fee_cents INTEGER NOT NULL DEFAULT 0,
  card_tip_net_cents INTEGER NOT NULL DEFAULT 0,
  adjustment_cents INTEGER NOT NULL DEFAULT 0,   -- freeform, may be negative
  adjustment_note TEXT,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.4 Columns added to `tips`

```sql
ALTER TABLE tips ADD COLUMN IF NOT EXISTS fee_cents INTEGER;                       -- real Stripe fee
ALTER TABLE tips ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id);  -- matched event; NULL = unassigned
```

`fee_cents` is the actual fee from the Stripe balance transaction for that tip. `shift_id` is the event the tip is matched to by timestamp (Section 4.4); NULL means unassigned.

### 3.5 Reused, not rebuilt

- Payment method and handles stay on `payment_profiles`.
- The contractor default rate stays on `contractor_profiles.hourly_rate`.
- The scheduler framework and the `scheduled_messages` dispatcher are reused (Sections 6 and 9).
- Paystub PDFs use the existing PDFKit and Cloudflare R2 upload patterns.

## 4. Payout computation

Each `payout_events` line is computed from four parts. The computation lives in pure functions (no DB access inside them), mirroring `server/utils/pricingEngine.js`, so it is unit-testable in isolation.

### 4.1 Wage

`wage_cents = round(hours * rate_cents)`.

- `hours` defaults to **contracted time**: the event's scheduled duration plus a 1-hour setup and a 30-minute breakdown. It is adjustable per event in the portal.
- `rate_cents` defaults to the contractor's `contractor_profiles.hourly_rate`. It is adjustable per event.
- The `late` flag is a record only. It never reduces pay automatically. To dock, the admin trims `hours` or `rate_cents` or uses the adjustment line. Docking is always discretionary.

### 4.2 Gratuity share

The event's total gratuity is read from `proposals.pricing_snapshot` (the "Shared Gratuity" figure produced by the pricing engine). It is netted for card fees, then split evenly across the bartenders on the event.

- Fee-netting: `gratuity_net = gratuity_gross - gratuity_fee`, where `gratuity_fee` is the gratuity's pro-rata share of the actual Stripe fees on the client's proposal card payments, computed as `total_card_fee * (gratuity_gross / total_card_payment)`. Proposal amounts paid by a non-card method recorded manually carry no fee.
- Split: `gratuity_net` divided evenly among the event's bartenders. See Section 4.5 for who counts and for remainder handling.

### 4.3 Card-tip share

The event's credit-card tips are the `tips` rows whose matched shift (Section 4.4) belongs to the event. An event is a proposal and may have more than one shift; the pool spans all of them.

- Event gross pool = sum of `tips.amount_cents`. Event fee pool = sum of `tips.fee_cents`.
- Each pool is split evenly across the event's bartenders. A bartender's `payout_events` row stores `card_tip_gross_cents` and `card_tip_fee_cents` as their shares, and `card_tip_net_cents = card_tip_gross_cents - card_tip_fee_cents`.
- Cash, Venmo, and Cash App tips are not in this computation. They are pooled by the bartenders themselves, honor system, the night of the event, and never touch the system.

### 4.4 Tip-to-event matching

Every `tips` row has `tipped_at` (the payment timestamp) and `target_user_id` (the bartender). A tip is matched to that bartender's shift whose service window contains `tipped_at`.

- The service window for a shift runs from setup start (event start minus the setup lead) to 3 hours after the event's scheduled end. The 3-hour grace covers guests who tip shortly after the event. The buffer is a defined, tunable constant.
- A bartender works at most one event per day, so windows do not normally overlap. If two of a bartender's windows ever do, the tip is matched to the event whose start time is nearer the tip timestamp.
- A tip whose timestamp falls in no window is left unassigned (`shift_id` NULL) and surfaces in the portal for manual assignment (Section 7).
- Matching runs when a tip is recorded (the Stripe webhook) and again during payout computation, so a tip that arrives after its event still gets matched.

### 4.5 Who shares, and remainders

- Only **bartenders** share gratuity and card tips. Barbacks and servers are paid their flat rate, which the pay policy already states includes gratuity; they are excluded from both splits.
- The bartenders on an event are the contractors with an approved bartender-position `shift_request` on any of that event's shifts.
- Even splits leave remainder cents. Remainders are distributed one cent at a time to the event's bartenders ordered by `users.id`, so the split is exact to the cent and deterministic.

### 4.6 Line and payout totals

- `line_total_cents = wage_cents + gratuity_share_cents + card_tip_net_cents + adjustment_cents`, floored at 0 (Section 11).
- `payouts.total_cents` is the sum of its `payout_events.line_total_cents`.

## 5. Pay periods and payday

- A pay period is a Tuesday-to-Monday window. Periods roll forward automatically so one always exists for any event date.
- **Payday** is the second working day on or after the period's `end_date` (the closing Monday), counting that Monday itself when it is a working day. A working day is Monday to Friday excluding US federal holidays.
  - Normal week: Monday is working day one, Tuesday is payday.
  - Monday is a holiday: Tuesday is working day one, Wednesday is payday.
  - Both Monday and Tuesday are holidays: Wednesday is working day one, Thursday is payday.
- The payday is computed and stored on the `pay_periods` row at creation. The computation is a pure function over a US federal holiday calendar and is unit-tested.

## 6. Payout lifecycle

1. **Accrual.** When an event completes (hooking into the existing auto-complete runner, `processEventCompletions`), the system computes a `payout_events` row for each contractor who worked it and upserts their `payouts` row for the period the event falls in, creating the `payouts` row, and the `pay_periods` row, if needed.
2. **Live.** While its period is `open`, a payout recomputes when something relevant changes: a card tip is matched, a Stripe fee settles, a shift is edited.
3. **Freeze.** When the period reaches payday, the admin starts the run with a deliberate "Process Payroll" action; merely viewing the page does not freeze anything. That action flips the period to `processing` and its payouts stop auto-recomputing. The admin's manual adjustments still apply; nothing else moves the numbers.
4. **Paid.** Marking a payout paid sets `status = 'paid'`, snapshots the payment method and handle, records `paid_at` and `paid_by`, and generates the paystub PDF. When every payout in a period is paid, the period flips to `paid`.
5. **Late tips.** A card tip matched to an event whose period is already `processing` or `paid` is not lost. It rolls forward as a `payout_events` row on that contractor's next payout, labeled to its original event.

## 7. Admin payroll portal

A new admin-only **Payroll** section under Financials. The existing per-contractor `PayoutsTab` on the user-detail page, currently a placeholder, is wired to show that contractor's payout history from the same tables.

- **Worklist.** Opens on the current pay period. A header shows the period dates, the payday, the total payroll, and progress (paid versus pending count). Below, one row per contractor who worked: name, payment method, amount owed, status.
- **Expandable row.** A row expands to its itemized invoice: one line per event with wage, gratuity share, and card-tip share, plus any adjustment, and the row total. While the payout is pending, `hours`, `rate_cents`, `late`, and the adjustment line are editable inline and totals recompute live. Card-tip lines show whether the tip has cleared Stripe or is still settling. This itemized view is defined once and reused as the paystub (Section 8).
- **Paying, by method.**
  - Venmo or Cash App: a button opens a QR encoding the pre-filled payment (recipient, amount, and a note such as "Dr. Bartender payroll"). The admin scans it with a phone; the app opens filled in.
  - PayPal: the button opens the contractor's paypal.me in a new tab with the amount filled, paid on the desktop.
  - Check, direct deposit, other: no link; the row shows the amount and the details to handle externally.
- **Marking paid.** A payout stays `pending` until you explicitly click Mark Paid; nothing marks it for you, and skipping someone simply leaves them on the list. Mark Paid records the method and timestamp, freezes the payout, generates the paystub, and moves the row to paid. Pay and Mark Paid are one cadence: resolving one contractor advances you to the next unpaid row, so a full run is a rhythm, not dozens of separate clicks.
- **Unassigned tips.** A panel lists card tips the matching could not place. The admin assigns each to its event. A tip left unassigned when the period is processed rolls to the next period (Section 6.5).
- **History.** Past periods are viewable read-only.

Note on the Venmo deep link: Venmo reliably pre-fills the recipient but is historically inconsistent at pre-filling the amount. Cash App and PayPal pre-fill the amount reliably. If Venmo amount pre-fill fails, the QR still saves the recipient lookup and the admin types the amount. To be verified during implementation.

## 8. Staff side

- A **My Pay page** in the staff portal, with a small earnings tile on the staff dashboard linking to it.
- A contractor sees only their own payouts, never the roster. The current period shows as a live preview, labeled clearly as an in-progress estimate that is not final until payday. Past periods show as final.
- Each payout opens to the same itemized breakdown as the admin worklist, including the card fee shown explicitly (gross, fee, net).
- **Paystub.** Marking a payout paid generates a paystub PDF, stored in R2 and downloadable from My Pay. It carries the full itemized breakdown, the fee lines, the payment method and date, and two short notes: that cash and app tips are settled separately and are not on the document, and that the figures are 1099 income with no taxes withheld.
- The current-period preview is live; the paystub is the frozen, official record, created only at mark-paid.

Staff-facing endpoints follow the existing `/api/me/...` pattern and return only the authenticated contractor's own data, filtered by `req.user.id`.

## 9. Notifications

Two notifications, both email (SMS is reserved for genuinely time-sensitive touches), both on the existing `scheduled_messages` dispatcher.

- **Payroll-due reminder.** To the admin, when a period's payday arrives.
- **Paystub-ready email.** To a contractor, when their payout is marked paid.

The `scheduled_messages.entity_type` CHECK constraint gains `payout` so these messages anchor cleanly. Today it allows `proposal`, `shift`, `client`, `consult`.

## 10. Document updates

The Field Guide, Payday Protocols, and any other contractor-facing page that states a pay policy are rewritten in this build to match the settled policies:

- Per-person hourly rates.
- Contracted time (event duration plus 1-hour setup plus 30-minute breakdown).
- The lateness rule, reframed: the business reserves the right to dock up to 20% of contracted pay, and calling ahead helps. The copy stays firm and does not state that the dock is rarely applied.
- Tips pooled honor-system the night of the event.
- Gratuity 100% to bartenders, split evenly.
- Card processing fees passed through, so tips and gratuity reach staff net of the fee.
- The Tuesday-to-Monday pay week and the second-working-day payday.

The two onboarding pages currently disagree on the lateness rule (Payday Protocols says "without notice", the Field Guide does not). Both are aligned to the reframed wording.

A small consistency fix rides along: the stale `PAYMENT_METHODS` list in `client/src/pages/admin/userDetail/helpers.js` still lists Zelle (retired) with inconsistent casing. It is corrected to match the canonical lowercase enum.

The contractor agreement is **not** edited in this build. See Section 14.

## 11. Edge cases

- **Floor at zero.** `line_total_cents` and `payouts.total_cents` floor at 0. An adjustment cannot drive a payout negative; if one would, it caps at 0 and the line is flagged.
- **No payment method.** A contractor with no `payment_profiles` method still appears on the worklist, flagged, so the admin chases it rather than missing the person.
- **Refunded or disputed card tip after payout.** If a card tip is refunded or disputed after its payout was already paid, it surfaces as an admin alert with two options: absorb it, or net it against that contractor's next payout via an adjustment line. There is never an automatic clawback.
- **Late and unassigned tips.** Covered in Sections 6.5 and 7.
- **Event edited before freeze.** While the period is `open`, payouts recompute, so an edited shift flows through. After freeze, a change requires a manual adjustment or rolls forward.

## 12. Testing

- The payout computation and the date logic are pure functions, the same shape as `pricingEngine.js`, and carry heavy unit coverage: wage, fee-netting, gratuity and card-tip splits, remainder distribution, the payday and US-federal-holiday calendar, and tip-to-event matching including the sequential-day case.
- Integration tests cover the lifecycle (accrual on event completion, freeze, mark-paid) and the portal routes.
- Money is asserted in integer cents throughout.

## 13. Access and PII

- The Payroll section is admin-only. Managers do not have access in this version.
- Staff endpoints return only the caller's own payouts, filtered by `req.user.id`.
- Bank routing and account numbers stay masked on the worklist. ACH is paid from the admin's saved Chase payee, so the full numbers are not needed in normal use. A full reveal, if ever required, is a deliberate action recorded in `admin_audit_log`.

## 14. Deferred items

1. **Year-end 1099 generation and delivery.** The ledger keeps per-contractor year-to-date totals exportable; document generation is a later pass.
2. **Contractor agreement v3.** Updating the signed, versioned contractor agreement to carry the new pay terms is a re-version with a re-acknowledgement question (whether already-signed contractors must re-sign). Tracked as its own item, run alongside this build, not blocking it.
3. **Automated ACH and paper checks.** A bank or payables-provider integration is out of scope. ACH and check stay manual.

## 15. Open items

1. **Contracted-hours setup default.** The contracted-hours default uses the flat 1-hour setup from the pay policy. Hosted events that schedule a 90-minute setup will need `hours` bumped per event, unless the default is later changed to read the shift's `setup_minutes_before`.
2. **Manager access.** The Payroll section is admin-only for this version. Whether managers should ever have access is left for a later decision.

## 16. Suggested implementation order

1. **Data model and computation engine.** The three tables and the `tips` columns, the pure-function payout computation, the payday calculation, tip-to-event matching, and the accrual hook on event completion. Backend, fully unit-tested.
2. **Admin payroll portal.** The Financials > Payroll worklist, expandable rows, adjustments, the payment actions and QR, mark-paid, the unassigned-tips panel, history.
3. **Staff side.** The My Pay page, the dashboard tile, paystub PDF generation.
4. **Notifications and document updates.** The two scheduled messages and the contractor-facing copy rewrites.

The contractor agreement v3 (Section 14) proceeds as a separate track.
