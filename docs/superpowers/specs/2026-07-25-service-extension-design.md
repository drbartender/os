# On-site service extension (design spec)

Status: rev 3, APPROVED 2026-07-26. Rev 1 approved 2026-07-25 (brainstorm,
section-by-section); rev 2 folded in the spec-fleet findings (13 blockers, 12
warnings) and redesigned the money model from fold-into-contract to side money;
rev 3 records Dallas's approval of side money and the no-receivable rule it rests
on (D12, D14), which changed the admin override.
Author: Claude + Dallas

## 1. Problem

Clients regularly want more bar time, and they realize it 30 to 60 minutes before
the contracted end. The party is going, they are having fun, and they cannot find
a checkbook, a card, or their phone. Today there is no way to price and collect
that in the moment, so it either does not get billed or it gets settled privately
with the bartender in cash. That happened recently: a client told a new bartender
that Dallas had said to "work it out with the bartender" and handed him cash.

The revenue leak is the smaller half of the problem. The real exposure is
coverage. A bartender who stays past the contracted end time under a private cash
arrangement is arguably no longer working under a DRB contract, during the hour
when guests are drunkest and an overserve incident is most likely. This feature
exists to keep every served minute inside the DRB contract and to leave a record
that proves it.

Dallas should put the coverage question to his broker in writing. This spec does
not assume an answer; it makes sure the artifact exists either way.

## 2. Grounding (prod data pulled 2026-07-25, code verified 2026-07-26)

These facts shaped the design and are recorded so a later reader knows why.

- **Card on file is effectively absent.** Of 40 booked events in the last 180
  days, zero are autopay-enrolled and 2 have a saved payment method. The card is
  only saved when the client opts into autopay at checkout (`stripeCreateIntent.js`
  sets `setup_future_usage` only when `wantsAutopay`), and nobody does. A
  "charge the card on file" flow would almost never fire. Rejected as the primary
  path.
- **Most events are fully paid before the day.** 22 full payments vs 20 deposits
  in 180 days, and balances are charged ahead. At event time the balance invoice
  is locked, so an extension is new money on top, not a balance bump.
- **The common event is service-only.** Nearly all recent bookings are The Core
  Reaction (flat, `base_rate_4hr` $350, `extra_hour_rate` $100/hr). Hosted
  per-guest packages are rare.
- **Gratuity is inconsistently applied.** `gratuity_rate` is $50/staff/hr on
  roughly a third of recent bookings and $0 on the rest.
- **There is no seniority concept.** 2 admins (Dallas, Zul), 70 staff, zero
  managers. Positions are Bartender and Banquet Server.
- **An off-ledger invoice lane already exists, wired and dormant.** The webhook's
  invoice branch skips the `amount_paid` roll-up for labels in
  `OFF_LEDGER_INVOICE_LABELS` (`paymentIntentSucceeded.js`, comment: "the branch
  stays wired for a future genuinely-additive label"); `refreshUnlockedInvoices`
  excludes those labels from `lockedTotal` and skips refreshing bespoke labels
  entirely (`invoiceLifecycle.js`); refund reconciliation skips them
  (`refundHelpers.js`, the `OFF_LEDGER_INVOICE_LABELS.includes(link.invoice_label)`
  branch). The set is currently `Object.freeze([])`. This feature is the
  anticipated label.
- **The alternative to off-ledger is a live, just-confirmed landmine.** Drink
  Plan Extras take the other shape: their webhook branch DOES increment
  `proposals.amount_paid` while their money never enters `total_price`, so they
  push `amount_paid` above `total_price`. On 2026-07-26 (`29316b10`) a refunds
  change was reverted specifically because that shape breaks the naive
  `amount_paid - total_price` overpayment derivation, double-subtracting extras
  and swallowing genuine contract refunds; prod's only positive difference
  (proposal 599, $60) is exactly a paid Drink Plan Extras invoice. Service
  Extension must NOT copy that shape. Beyond the refund math, an inflated
  `amount_paid` would falsely satisfy two gates keyed on it: the
  funded-gratuity gate (`paidCents >= totalCents`, `payrollAccrual.js`), which
  would release the CONTRACT gratuity pool on a deposit-only event, and the
  auto-complete gate (`total_price - amount_paid <= 0`), which would complete
  an event and accrue payroll early. Going off-ledger keeps this feature out of
  that entire class of bug. Do not "make it consistent with Drink Plan Extras."
- **The gratuity pool has a precedent for event-scoped side money.** Payroll
  accrual pools card tips by summing the `tips` table scoped to the event's
  shifts (`payrollAccrual.js:341-346`), separate from the snapshot-derived
  contract gratuity. An extension gratuity addend mirrors that shape.

## 3. Decisions

Each decision was made explicitly during the brainstorm (D1 to D11, 2026-07-25)
or forced by the fleet review (D12 to D13, 2026-07-26).

1. **Staff initiate from the staff portal, not by SMS.** SMS is used only for two
   outbound messages: the client's payment link and the staffer's greenlight or
   decline. Rationale: free-text SMS parsing at a loud party would have to guess
   which shift the texter means, and a wrong guess charges the wrong client.
2. **Staff never see the price.** Not in the UI and not in any API response
   field, error message, or shared endpoint. The fleet verified the existing
   staff surfaces carry no money; only the new `service_extensions.amount_cents`
   and `gratuity_cents` need withholding from staff-facing responses.
3. **No permission gate on initiating.** Any staffer assigned to the event can
   start a request, hosted or not. Dallas controls who is on the job at staffing
   time. Explicitly rejected: a seniority flag on the profile. "Assigned" is a
   server-side predicate, not a UI statement; see section 5.
4. **Hosted events get a confirmation step, not a lock.** On a hosted package the
   request screen asks the staffer to confirm they have the product to serve the
   extra time before it sends.
5. **Staff pick a new end time, not a number of extra hours.** The picker opens
   on the current contracted end time, steps in 30 minutes, and is capped at plus
   3 hours measured from that same current contracted end. For a second
   extension, "current contracted end" is the already-extended end.
6. **Price is the pricing engine's delta.** No new pricing path. Gratuity rides
   along because it is a per-staff-per-hour rate in the contract, and it is the
   money that actually reaches the bartender for standing there at 11pm.
   Explicitly rejected: a flat $100/hr, which charges the same whether one
   bartender stays or three.
7. **The client pays on the regular invoice page.** `InvoicePage` already runs
   Stripe's `PaymentElement`, which surfaces Apple Pay and Google Pay on the
   client's own phone. That is the actual answer to "I cannot find my payment
   method."
8. **Terms must be accepted before paying, and the server enforces it.** Brief,
   and it names the insurance point. Acceptance is recorded server-side via a
   dedicated endpoint; intent creation for an extension invoice is refused until
   the acceptance is on the row. A client-side-only gate would let the exact
   client who routes around the system produce an artifact-free payment.
9. **Unpaid is a hard stop.** No greenlight means bar service ends at the
   contracted time. No grace hour. Admin can override.
10. **The record does not wait on the money for its wording, but the contract
    change does.** Nothing about the event moves until payment (or an admin
    override) settles the request.
11. **Language says SERVICE ends at the contracted time.** Policy is 30 minutes
    of cleanup after, and staff are paid for contracted hours regardless, so the
    messages must not read as "you are done and must leave."
12. **Extension money is side money, not contract money (rev 2).** The extension
    invoice's label joins `OFF_LEDGER_INVOICE_LABELS`. `total_price`,
    `pricing_snapshot`, `amount_paid`, and payment status never move; the paid
    extension lives as its own invoice, payment, and `service_extensions` row on
    the event, and the duration bump alone is the contract-record change.
    Rationale: rev 1 folded the delta into the contract via
    `foldExtrasIntoProposal`, and the fleet showed that path is unsound here on
    four independent axes: the fold has no duration legs and reprices the whole
    proposal (any catalog drift since booking lands in one jump at 11pm); the
    webhook's `amount_paid` increment races the fold's status reconcile and
    demotes a paid proposal; an unpaid admin override raises `total_price` with
    no money, which permanently blocks auto-completion and, through the
    funded-gratuity gate, zeroes the whole event's gratuity pool; and a bespoke
    label sits outside `CONTRACT_LABELS`, so a refund would drop `amount_paid`
    without dropping `total_price`. Side money dissolves all four and rides an
    off-ledger lane that was built waiting for exactly this label. The visible
    trade: the proposal's headline total stays the booked price, and the
    extension shows as its own invoice and payment on the event rather than
    inside `total_price`.

    **Why side money is safe here, in Dallas's words (2026-07-26, approving
    D12):** an extension only ever happens once the event is basically over,
    and there is nothing to track or chase, because it does not exist for DRB
    to care about unless it was paid and the service was rendered right away.
    That is the load-bearing invariant behind this whole section, not a
    convenience. An extension is a paid-and-served fact or it is nothing.
    Consequences that follow, and must not be "improved" later: no dunning, no
    reminder ladder, no aging report, and no collections surface for extension
    invoices ever. (Verified 2026-07-26: balance reminders key off
    `proposals.total_price` / `amount_paid` / `balance_due_date`, never off
    invoice rows, so no existing scheduler would chase one. That is a fact to
    preserve, not a coincidence to rely on.) The corollary is D14.
13. **A zero-delta extension still requires acceptance and settles without a
    charge (rev 2).** The engine is law (D6), and it prices some real shapes at
    $0: flat packages below 4 hours extending within the base (a 3h Core
    Reaction to 4h), per-guest class packages (`extra_hour_rate` 0), hosted
    events pinned under `min_total`. Stripe cannot charge $0, and the coverage
    artifact matters regardless of price, so the client link shows the terms
    with "$0, included in your package" and an Accept button, no payment
    element; acceptance settles the request.
14. **The admin override grants time; it never creates a receivable (rev 3).**
    An override voids the extension invoice (cancelling open intents first) and
    bumps the duration. It does not leave an open invoice to collect, because
    per D12 an unpaid extension is not a thing DRB carries. The override is a
    coverage-and-payroll action: it says "this time was DRB service, pay the
    staff for it, and the record shows why," not "bill them later." If Dallas
    ever does want to bill an overridden extension, the existing manual-invoice
    tooling is the deliberate, visible way to do it. Rev 2 had the override
    leaving the invoice open; that contradicted D12 by manufacturing exactly
    the receivable the model says will not exist.

## 4. Non-goals

- No card-on-file / off-session charging. See grounding.
- No cash or external-payment reconciliation path. A "client paid me cash"
  button is the leak, not the fix.
- No seniority or role tier.
- Not a general "edit the event mid-flight" tool. Duration only.
- No changes to `foldExtrasIntoProposal`, `reconcileProposalPaymentStatus`, the
  auto-complete gates, or the webhook's contract roll-up math. The design is
  chosen so the battle-tested money paths are joined, not modified.

## 5. Flow

1. **Request.** The staffer opens their shift in the staff portal and taps
   "Request more time." The initiate endpoint requires the exact assignment
   predicate the staff home uses: a `shift_requests` row with
   `user_id = req.user.id AND shift_id = $1 AND status = 'approved' AND
   dropped_at IS NULL`. `auth` plus `requireOnboarded` is not sufficient (the
   known onboarding self-promotion hole means "authenticated" does not mean
   "real staff on this job"). The endpoint also enforces the request window
   server-side: from event start through current contracted end plus 15
   minutes, computed as an instant using `event_timezone` (section 11). A
   shift whose stored times cannot be parsed returns an explicit conflict
   (`unparseable_shift_time`, the `staffShiftActions.js` precedent), never a
   silent pass or fail. Rate limit: the existing rate-limiter middleware at 5
   requests per user per hour, on top of the one-pending-per-proposal index.
   The staffer picks the new end time (D5); hosted packages add the product
   confirmation tick (D4). The screen has loading, error, and disabled/pending
   states matching the existing `ShiftDetail` drop/cover flow, and a specific
   message for the collision case: "another request for this event is already
   with the client." The new screen is its own component file; `ShiftDetail.js`
   is already past the size cap and must not grow.
2. **Price and send.** The server computes the delta (section 6), writes the
   `service_extensions` row, and creates the extension invoice (section 7).
   The client gets the invoice token link by SMS, with the same by email.
   Client sends route through the existing immediate-send suppression
   (`shouldSendImmediate`): SMS respects opt-out and the phone-scoped STOP
   guard, email respects `email_enabled` and bounce status. If both channels
   are suppressed or missing, the request still exists and the admins are
   alerted with the link so they can relay it; it expires on schedule
   otherwise. Dallas and Zul are notified on every request the moment it goes
   out, so they can kill one they disagree with.
3. **Client accepts and pays.** The invoice page detects an extension invoice
   (the invoice GET gains extension fields when a `service_extensions` row
   references it) and shows the terms block; the pay button stays disabled
   until the client accepts. Acceptance calls a public accept endpoint on the
   invoice token that stamps `client_accepted_at`, IP, and user agent on the
   extension row (idempotent). `create-intent-for-invoice` refuses (409) an
   extension invoice whose acceptance is not stamped. Ordinary invoices
   (Deposit, Balance, links already in client inboxes) see none of this: the
   terms block and the acceptance gate exist only when an extension row
   references the invoice. Zero-delta requests show the terms and an Accept
   button only (D13); acceptance settles directly.
4. **Settle.** On payment success (or zero-delta acceptance), the request is
   claimed and the duration bump lands (section 7). Every staffer assigned to
   the event gets the greenlight message; on a two-bartender job both need to
   know. Staff sends respect the staff-side gates (section 10).
5. **Expire.** A sweep runs every 60 seconds (registered in `server/index.js`
   behind `RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER`, default on, honored only
   when `RUN_SCHEDULERS` is not false, so it is off in local dev like every
   other scheduler). It claims rows with
   `UPDATE service_extensions SET status = 'expired' WHERE status = 'pending'
   AND expires_at < NOW()` and, per claimed row: cancels open intents
   (`cancelOpenInvoiceIntents`), voids the invoice, and sends the decline
   message to every assigned staffer. The claim-update is the race gate: settle
   and expiry both claim with `WHERE status = 'pending'` and act only on
   `rowCount = 1`, so exactly one wins.
6. **Override / cancel.** Admin surfaces (section 8) let Dallas or Zul
   greenlight unpaid time (status `overridden`, reason required) or cancel a
   pending request (status `cancelled`). An override bumps the duration exactly
   as a paid settle does and VOIDS the extension invoice (D14): no receivable is
   left behind, and because the money is side money an override cannot demote
   payment status, block auto-completion, or touch the funded-gratuity gate
   either. A cancel voids the invoice too and bumps nothing. Both actions write
   `adminAuditLog` entries.

## 6. Pricing

The delta is computed once, at request time, and stored on the extension row.
Both components come from `calculateProposal`:

- **Service delta:** the catalog computation at the new duration minus the same
  at the current duration, both with `totalPriceOverride` off. This is the
  fold's own delta discipline: a negotiated override is a contract, so the
  catalog delta is what moves, and anything the change did not touch cancels
  out. A plain "engine total minus engine total" with the override on would
  collapse to zero for override'd proposals (the override replaces
  `serviceTotal`), which is why the override must be held aside.
- **Gratuity delta:** `gratuityLineAmount(gratuity_rate, staffCount, newHours)`
  minus the same at current hours. Stored separately as `gratuity_cents`
  because payroll consumes it (section 9).

`amount_cents = service delta + gratuity delta`, integer cents. That number is
the invoice, what the client accepts, and what the client pays. There is no
second computation at settle time, so rev 1's "delta re-verification" problem
does not exist.

What the engine gets right for free:

- **Multi-staff.** Bartenders above the included ratio bill at
  `extra_bartender_hourly` scaled by duration, PLUS the sub-100-guest gratuity
  surcharge ($50/$25/$15 per hour for under 50/75/100 guests,
  `pricingEngine.js:142-149`). This surcharge is the load-bearing rule
  CLAUDE.md flags as repeatedly re-lost; it is in the delta because it is in
  the engine, and section 13 pins it with a test.
- **Timed add-ons.** `per_guest_timed` scales only above 4 hours
  (`Math.max(0, durationHours - 4)`), and `per_hour` add-ons are floored at
  `minimum_hours`, so an extension inside the floor adds $0 for that add-on.
  Both are the engine's existing behavior, listed here so nobody "fixes" them.

Worked examples:

| Event | Extension | Price |
|---|---|---|
| Core Reaction, 1 bartender, `gratuity_rate` 0 | +30 min (from 4h) | $50 |
| Core Reaction, 1 bartender, `gratuity_rate` $50 | +30 min (from 4h) | $75 |
| Core Reaction, 100 guests, 2 bartenders (1 over ratio), `gratuity_rate` 0 | +60 min | $140 |
| Core Reaction, 50 guests, 2 bartenders (1 over ratio), `gratuity_rate` 0 | +60 min | $165 ($100 base + $40 hourly + $25 surcharge) |
| Base Compound hosted, 100 guests, `gratuity_rate` 0 | +60 min | $500 |

Degenerate deltas (all real, all settle via the zero-delta path when $0):

- Flat packages return the same base for any duration at or under 4 hours, so a
  3h Core Reaction extending to 4h is $0 (and 3.5h to 4.5h is $50, not $100).
- The six per-guest class packages carry `extra_hour_rate` 0. The Doctor's
  Orders is the other class shape: `bar_type` class but flat-priced with a real
  extra-hour rate. Both shapes get tests.
- Hosted events pinned to `min_total` absorb part or all of the delta.

## 7. Money model

Side money (D12). The extension invoice's label is a new constant,
`SERVICE_EXTENSION_INVOICE_LABEL = 'Service Extension'`, added to
`OFF_LEDGER_INVOICE_LABELS` in `proposalMoneyShared.js`. Per the standing rule
on that constant, joining it is what makes the webhook skip the `amount_paid`
roll-up, keeps `refreshUnlockedInvoices` from counting it, and makes refund
reconciliation leave the contract alone. `CONTRACT_LABELS` is untouched.

**On request** (one transaction): insert the `service_extensions` row
(`pending`, `expires_at` = contracted end + 15 min), create the invoice with
`createInvoice` at status `sent` (a `draft` invoice is unpayable:
`create-intent-for-invoice` accepts only `sent`/`partially_paid`), label
`Service Extension`, one line item ("Additional bar service, 10:00 PM to
11:00 PM"), `amount_due = amount_cents`. `refreshUnlockedInvoices` is not
called and would skip the bespoke label anyway. `createAdditionalInvoiceIfNeeded`
is never involved: `total_price` does not move, so it has nothing to mint.

**On payment success**, inside the existing `paymentIntentSucceeded` invoice
branch (which already, per current code: inserts the `proposal_payments` row
idempotently, links via `intent.metadata.invoice_id`, locks the invoice when
fully paid, and skips the `amount_paid` roll-up for off-ledger labels), add one
step after the link: look up `service_extensions` by `invoice_id` (that lookup
is the discriminator; no new intent metadata). If a row is found:

1. Claim it: `UPDATE service_extensions SET status = 'paid' ... WHERE id = $1
   AND status = 'pending'`; proceed only on `rowCount = 1`. This is the
   settle/expire race gate and a second idempotency wall behind
   `isFirstDelivery`.
2. Bump `proposals.event_duration_hours` to `requested_duration_hours`.
3. Targeted shift sync: update the linked shift's `event_duration_hours` and
   `end_time` (display string via `addHoursToTime`) in a two-column UPDATE
   scoped by `proposal_id`. Deliberately NOT `syncShiftsFromProposal`: the full
   sync rewrites location, roster slots, and setup minutes mid-event, and
   no-ops on multi-shift events. An event with more than one shift row skips
   the sync and alerts the admin instead.
4. Queue the staff greenlight sends for the post-commit `isFirstDelivery` tail,
   so a retried commit cannot re-text the roster.

No fold, no reconcile, no invoice refresh. A proposal already `completed` or
`archived` at settle time does not throw (a throw would roll back the payment
row and make Stripe retry the same failure for days): the payment records, the
extension row is claimed `paid`, and the admins get an alert to resolve by hand
(the `payment_on_archived` precedent).

**Zero-delta settle** runs the same steps 1 to 4 from the accept endpoint, with
no invoice payment involved.

**On expiry**, the sweep claims the row, cancels open intents, voids the
invoice, and sends declines. If a payment was already confirmed at Stripe in
the race window, the webhook still fires: the link is refused (void invoice,
existing warn path), and because the label is off-ledger the `amount_paid`
roll-up is skipped, so the contract is untouched by design. The handler detects
this shape (payment against a void extension invoice) and raises a Sentry event
plus an admin alert with a refund instruction. Damage is contained to "refund
one payment," not "unwind contract state."

**On override**: claim the row to `overridden` with `override_by_user_id` and
`override_reason` (same `WHERE status = 'pending'` gate, so an override cannot
race a settle or an expiry), then steps 2 to 4, then cancel open intents and
void the invoice (D14). Nothing is left to collect. The override screen carries
the payroll note from section 9, including that a voided extension contributes
no gratuity.

**On cancel**: claim the row to `cancelled`, cancel open intents, void the
invoice, send the decline messages. No duration bump.

**Refunding a paid extension** is a plain refund of that payment. Off-ledger
means reconciliation does not touch `amount_paid` or `total_price`. The
duration is NOT auto-reverted: whether the time was served is a fact the admin
knows and the system does not, so un-extending is a deliberate admin edit of
the event, not a refund side effect.

## 8. Data model and surfaces

New table `service_extensions`:

- `id`, `proposal_id` (FK, ON DELETE CASCADE), `shift_id` (FK, ON DELETE SET
  NULL), `requested_by_user_id` (FK users), `invoice_id` (FK, ON DELETE SET
  NULL)
- `contracted_end_time`, `requested_end_time` (display strings),
  `contracted_duration_hours`, `requested_duration_hours` (NUMERIC(4,1),
  reading the persisted duration current at request time, so a second
  extension's "contracted" values are the already-extended ones)
- `amount_cents`, `gratuity_cents` (integer cents)
- `hosted_product_confirmed` (boolean, null on non-hosted)
- `terms_version`, `client_accepted_at`, `client_accept_ip`, `client_accept_ua`
- `status` CHECK in (`pending`, `paid`, `expired`, `cancelled`, `overridden`)
- `override_by_user_id`, `override_reason`
- `expires_at`, `created_at`, `updated_at`
- Partial unique index: one row per `proposal_id` WHERE `status = 'pending'`

Schema statements idempotent per house rule.

**Terms copy registry:** `server/data/extensionTermsCopy.js`, modeled on
`smsConsentCopy.getConsentCopy(version)`: versioned copy, and a lookup that
refuses an unknown version rather than recording a lie. Without it a stored
`terms_version` maps to no text and the artifact claim is empty.

**Routes:** one new file, `server/routes/serviceExtensions.js`:

- `POST /api/service-extensions` (staff, `auth` + assignment predicate +
  window + rate limit). Response carries request status only, never
  `amount_cents` or `gratuity_cents` (D2).
- `POST /api/invoices/t/:token/accept-extension-terms` (public, rate-limited,
  `requireUuidToken` per the UUID token-guard convention). Also the zero-delta
  settle entry.
- `GET /api/invoices/t/:token` (existing route, `invoices.js`) gains extension
  fields (`is_extension`, terms copy, `client_accepted_at`) when an extension
  row references the invoice.
- `POST /api/admin/service-extensions/:id/override` and
  `.../cancel` (admin/manager). Both write `adminAuditLog`.

**Admin surfaces:** a compact extensions panel on the proposal/event detail
page: each request's status, requester, old and new end, amount, outcome
timestamps, plus Cancel on pending rows and Override with a required reason.
The admin notification links here. Empty state: panel hidden. No new top-level
page. Deliberately absent, per D12: any open-extension-invoice list, aging
view, or "collect" action.

**Activity log:** `proposal_activity_log` actions `extension_requested`,
`extension_paid`, `extension_expired`, `extension_cancelled`,
`extension_overridden`.

**Docs:** README folder tree (new route + data + util files), ARCHITECTURE
route table + schema section (`service_extensions`), CLAUDE.md env table
(`RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER`), per the mandatory-updates table.

## 9. Payroll

Two components, handled separately.

**Wage hours.** `payrollAccrual` seeds `contracted_hours` from
`proposal.event_duration_hours` on first accrual. But first accrual mid-event
is the NORM, not the exception: a card tip matched to the shift triggers
accrual while the period is open, and auto-complete fires at the contracted
end, inside the request window. So a warn-only mitigation is inadequate.
Rule: on settle/override, for each affected payout line in an OPEN period, if
`hours = contracted_hours` (the admin demonstrably has not touched the line),
re-seed both to the new contracted hours; if they differ, do not touch the
line and surface a warning on the admin extension panel linking to the payroll
line. A frozen period follows the late-tip deferral-marker precedent: no
silent write, admin alert.

**Gratuity share.** The pool in `payrollAccrual` is snapshot-derived and the
snapshot does not move (D12), so the extension's gratuity rides in as an
addend, mirroring how card tips already join: pool = snapshot gratuity +
`SUM(gratuity_cents) FROM service_extensions WHERE proposal_id = $1 AND status
= 'paid'`. The funded gate for the addend is per-extension (`status = 'paid'`
means its own money arrived), independent of the proposal-level
`amount_paid >= total_price` gate that governs the snapshot pool. An
`overridden` extension contributes NO gratuity, permanently: its invoice is
voided (D14), so that money never arrives and the row never becomes `paid`.
Wage hours still accrue for it, because the funded gate has never applied to
wages (staff worked, staff paid). If Dallas comps an extension and still wants
the crew to see the gratuity, `payout_events.adjustment_cents` is the
deliberate, visible lever; nothing does it automatically. The extension
payment's
Stripe fee sits outside `CONTRACT_LABELS`, so it does not net against the
pool: DRB absorbs that fee. Decided, not accidental; it errs toward staff,
consistent with the accrual file's stated bias.

An extension paid after accrual has run re-enters through the same
re-accrue-while-open path tips use; frozen periods again follow the late-tip
precedent.

## 10. Notifications and copy

**Client, terms block above the payment element:**

> **Extend bar service to 11:00 PM**
> Another 30 minutes of bar service under your existing agreement. Same team,
> same terms, same $2 million liquor liability coverage.
>
> That coverage applies to service booked through Dr. Bartender. Our bartenders
> cannot accept payment directly for additional service time, and any
> arrangement made privately with a bartender is not insured.

**Client SMS:** short, with the invoice link. Email carries the same. Both go
through `shouldSendImmediate` (section 5).

**Staffer, declined or expired:**

> Dr. Bartender: additional time was not approved. Bar service ends at 10:00 PM
> as contracted. Serving past that is not DRB work and is not covered by DRB
> insurance. Do not accept payment from the client directly.

**Staffer, approved:**

> Dr. Bartender: approved. Bar service now runs to 11:00 PM. Your hours are
> updated, nothing else to do.

**Staff-side channel gates.** Staff SMS is gated on `agreements.sms_consent`
(the `messages.js` precedent). Fallback order per staffer: SMS if consented,
else web push (the portal has VAPID push), else email. A staffer reachable on
no channel triggers an admin alert naming them, because the decline message is
the one carrying the legal warning and it must not silently vanish. All staff
sends fire in the post-commit tail, never inside the transaction.

**Admin:** notified on request-out, settle, expiry, and the void-invoice
payment shape (section 7).

**Placement beyond this feature.** The insurance sentence belongs upstream too:
the event services agreement, the pre-event email, and the contractor
agreement. Tracked on the fix list ("Coverage language in signed documents,"
added 2026-07-25), blocked on the broker answer.

## 11. Edge cases

- **`YES` collides with SMS opt-in.** `smsInbound.js` `START_WORDS` contains
  `yes`; this design has no inbound client SMS at all. Recorded so nobody
  reintroduces a reply-YES flow.
- **Timezone.** The request window and `expires_at` are instants derived from
  `event_date`, `event_start_time`, `event_duration_hours`, and
  `event_timezone`, computed the way `processEventCompletions` already does
  (`balanceScheduler.js:228`), extracted into a shared helper in this build.
  NOT `shiftTime.js` (hardcodes Chicago) and NOT `addHoursToTime` for instant
  math (naive string arithmetic with a midnight wrap; it remains fine for the
  shift's display string). Events crossing midnight get a test.
- **Authoritative contracted end** = proposal `event_start_time` +
  `event_duration_hours`. `shifts.end_time` is display and may have been
  hand-edited; the picker opens on the proposal-derived value.
- **Second extension after one settles:** allowed; new request reads the
  persisted (already-extended) duration as its baseline, and the +3h cap
  measures from that baseline.
- **Concurrent requests:** partial unique index; the second gets the collision
  message from section 5.
- **No assigned staff:** the server predicate is the rule; the UI simply has no
  surface without an assignment.
- **Completed/archived proposal at settle:** no throw; record, claim, alert
  (section 7).
- **Client unreachable on both channels:** request exists, admins alerted with
  the link, normal expiry otherwise (section 5).
- **Late payment after expiry:** contained by the off-ledger skip; refund one
  payment, alert the admin (section 7).

## 12. Cross-cutting consistency checklist

What moves, and everything that reads it:

- `proposals.event_duration_hours` (the ONLY proposal column that moves):
  consumed by payroll seeding (section 9), auto-complete's end-instant math
  (extending correctly delays completion), BEO, calendar feeds, client portal
  event display, and the staff event-details page. Each gets verified in the
  plan, not assumed.
- `shifts.event_duration_hours` + `end_time`: staff portal surfaces, shift
  hour displays.
- `total_price`, `pricing_snapshot`, `amount_paid`, proposal status: explicitly
  DO NOT move (D12). Payment-status math, autopay, `createAdditionalInvoiceIfNeeded`,
  and the funded-gratuity gate are untouched by construction.
- Invoices: new label joins `OFF_LEDGER_INVOICE_LABELS` (the standing rule:
  new invoice-only labels MUST join the constant); `CONTRACT_LABELS`
  untouched; fee-netting consequence decided in section 9.
- Money Board and revenue reporting: this is the one real cost of off-ledger.
  Extension revenue is in `proposal_payments` and `invoices` but NOT in
  `proposals.amount_paid`, so any surface that totals revenue from `amount_paid`
  will under-report it while any surface that sums payments will include it.
  Enumerate which surfaces do which and decide per surface in the plan; do not
  "fix" a discrepancy by rolling the payment into `amount_paid` (see §2's
  landmine note).
- Refunds: off-ledger skip covers reconciliation; no auto-un-extend (section 7).
- Activity log + `adminAuditLog` entries per section 8.
- Docs per section 8.

## 13. Testing

- Engine delta per shape: flat above/below the 4h boundary, per-guest, class
  (both class shapes: per-guest zero-rate and The Doctor's Orders flat), hosted
  pinned to `min_total`, with and without `gratuity_rate`, with and without
  `total_price_override` (delta computed with override off), single and
  multi-bartender including the 50-guest surcharge case ($165, the load-bearing
  rule).
- Zero-delta: acceptance-only settle, no intent created.
- Server-side gates: initiate without the assignment predicate is refused;
  intent creation before acceptance is refused; window enforcement; rate
  limit; unparseable shift time returns the explicit conflict.
- Race and idempotency: settle/expire claim single-winner; replayed webhook
  does not double-bump; expiry then late payment leaves contract untouched and
  raises the alert.
- Off-ledger: extension payment does not move `amount_paid`, status, or any
  balance invoice; refund of an extension payment leaves contract accounting
  untouched. Explicit regression guard for the §2 landmine: a paid extension on
  a DEPOSIT-only event must leave `gratuityFunded` false and must not trip
  auto-completion.
- Override (D14): duration bumps, invoice ends `void`, no open invoice survives
  anywhere for that proposal, and no reminder or scheduled message is created
  for it. Cancel: invoice `void`, duration unchanged.
- Payroll: seed-before-accrual; re-seed when `hours = contracted_hours`;
  no-touch + warning when admin-edited; frozen-period deferral; gratuity addend
  for `paid` only (not `pending`/`overridden`); fee not netted against the
  pool. Chicago-keyed track-and-restore pay-period fixtures per the standing
  test law.
- Staff API responses carry no `amount_cents`/`gratuity_cents`.
- Staff send gating: no consent falls back push then email; no channel alerts
  admin.
- Timezone: event crossing midnight; window math in a non-default
  `event_timezone`.

## 14. Open items

- Dallas: coverage question to the broker in writing.
- Signed-document copy changes: on the fix list, blocked on the broker answer.

D12 was confirmed by Dallas on 2026-07-26, which closes the only design fork
that was still open. The spec is ready for a plan.
