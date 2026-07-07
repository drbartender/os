# CC event transfer (cc-import phase 3) — design, 2026-07-07

CheckCherry dies 2026-07-21. Thirteen future confirmed CC events (Luva Dorris
runs 7/18 inside CC and is SKIPPED, per Dallas) must become native DRB
proposals with correct money, correct staffing inputs, and NONE of the
automated misfires v1 caused ("messages about already paid bills or invoices
for the incorrect amount... and those are just examples"). Brainstormed
conversationally 2026-07-07; Dallas answered the full quiz in-chat.

## Core mechanism (the money law)

- Every transfer sets `total_price_override` = the CC contracted total, so
  the pricing engine can never recompute a different number. Package +
  add-ons are set for ops/staffing display, money comes from the override.
- CC-collected money folds into `proposals.amount_paid` at transfer, with
  ZERO `proposal_payments` rows (the ledger already holds those payments in
  the CC era; native rows would double-count blended metrics). A new
  `external_paid` column records the CC-collected amount explicitly (whole
  DOLLARS, matching the proposals money exception) so the panel can show
  "Collected in CheckCherry: $X" and the number is bookkept, not derived.
- Balance math then self-corrects everywhere that computes
  `total_price - amount_paid` (verified: balanceReminderScheduling.js:77).
  Paid-in-full transfers (Amy M.) have zero balance and never dun.
- `balance_due_date` = CC "Due On". Balances collect via normal DRB invoices
  (Dallas confirmed); the invoice amount derives from the same balance math.
- New column `transferred_from_cc_id TEXT` (partial unique) marks transfers
  and links to the ledger row. `proposals.cc_id` stays NULL forever (v1
  relic; the ledger loader's double-count guard keys on it).

## Creation path (the v1 lesson)

The transfer script drives the REAL proposal-creation code path (same
snapshot/addons/drink-plan helpers the admin route uses), never a parallel
reimplementation. Born status='confirmed' with accepted_at set (they signed
CC contracts; DRB must never ask them to accept, sign, or pay a deposit).
Manifest of the 13 (client_id, package_id, addons, guests, hours, venue,
event_type/custom, total, external_paid, due date, notes) lives OFF-REPO at
~/cc-archive/2026-07-07-transfer-manifest.json (client PII stays out of git).

## The guard sweep (each verified against code during build, allow/suppress)

SUPPRESS on transferred events:
- Acceptance/sign-and-pay nudges + master service agreement chase (CC
  contract stands). Born-confirmed sidesteps the sent->accept funnel.
- Deposit asks of any kind (external_paid covers the deposit; no Stripe
  activity until a balance invoice).
- Checkout-gratuity floor (a sign-and-pay concept; transferred events never
  pass through checkout — verify the invoice path adds no gratuity line).
- Last-minute booking machinery (bookingWindow full-pay enforcement,
  last_minute_hold, staff SMS blast): transfers are not new bookings even
  when created inside the 14-day window.
- Drink-plan AUTO-invite/nudge (Dallas's call): plans are created but the
  nudge is suppressed; Dallas intro-notes each client personally, then
  nudges manually. Suppression must survive the scheduler (not just skip
  the initial enqueue).
- Booking-confirmation / any client email on the create+confirm transition
  (script path must be comms-silent end to end; grep every sendEmail/
  scheduleMessage reachable from the creation + status path).

ALLOW (the point of transferring):
- Balance reminders (correct by amount_paid math), event-eve staff SMS,
  shift/staffing flows, shopping list, review/thank-you post-event, payroll
  accrual on DRB-collected balance payments + shifts per normal rules.

## Metrics dedupe (these events exist in the ledger too)

- At transfer commit: DELETE the event's `legacy_cc_proposals` row (its CC
  DEPOSIT rows in legacy_cc_payments STAY — that money was genuinely
  collected in the CC era; cash-basis monthly revenue remains true).
- Loader learns the registry: skip events whose cc_id appears in
  `proposals.transferred_from_cc_id` on any reload, and report the skip
  count (no silent truncation). Post-apply expectations adjust by the same
  count. The double-count guard (proposals.cc_id / legacy_charge_id) is
  untouched — transfers use the new column precisely so the guard and the
  metrics tri-state (which key on cc_id) keep their meaning.

## The 13 (from the quiz; guest counts confirmed in order after skipping Luva)

Sid Khaitan 7/23 Core Reaction 3.5h g100 $350 paid$100 other/"Launch Party";
Cody Hillesheim 7/31 Core 7h +1btd g125 $930 paid$100 wedding;
Eliana Stoyanoff 8/1 Primary Culture 4h +softdrink g50 $750 paid$100 default 'event';
Emiline Mccoy 8/1 Core 2h g75 $300 paid$100 other/"Cocktail Party";
Jack Van Dyke 8/1 Midrange Reaction 4h g175 $3,273 paid$100 wedding;
Jayme Corcoran 8/9 Core 5h g100 $450 paid$0 other/"Vow Renewal" (confirmed
with no deposit — transfer as-is, Dallas investigates separately);
James Stewart 8/22 Core 5h g100 $450 paid$100 wedding, venue 16015 W Baker
Rd, Manhattan IL 60442;
Emily Zschernitz 9/5 Core 5h g100 $450 paid$100 wedding;
Amy Martinez 9/26 Core 5h +ice g100 $550 paid$550 (PAID IN FULL) wedding;
Shazana Nadeem 10/16 Core 4h +1btd g150 $510 paid$100 wedding;
Madelyn Marie 10/17 Cultivated Complex 6h +softdrink g60 $1,493 paid$100
wedding (CC "Additional Hours" add-ons fold into duration, not add-ons);
Julia Neave 10/22 Carbon Suspension 5h +softdrink g100 $2,425 paid$100 wedding;
Cecilia & Ryan 8/21/2027 Core 8h +1btd g160 $1,070 paid$100 wedding.

All clients already exist (phase-1 import, linked by transferred ledger
rows). Package names match DRB exactly (verified against service_packages).

## Post-transfer operations (Dallas)

Turn OFF CC client notifications once the 13 are live. If a payment still
slides through CC before 7/21 (Sid due 7/9, Cody due 7/17), Dallas reports
it and we bump that event's external_paid/amount_paid (small documented
update path, no payment rows). Then CC cancellation.
