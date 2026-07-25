# On-site service extension (design spec)

Status: approved 2026-07-25 (brainstorm, section-by-section)
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

## 2. Grounding (prod data pulled 2026-07-25)

These numbers shaped the design and are recorded so a later reader knows why.

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

## 3. Decisions

Each decision below was made explicitly during the brainstorm.

1. **Staff initiate from the staff portal, not by SMS.** SMS is used only for two
   outbound messages: the client's payment link and the staffer's greenlight or
   decline. Rationale: free-text SMS parsing at a loud party would have to guess
   which shift the texter means, and a wrong guess charges the wrong client.
2. **Staff never see the price.** Not in the UI and not in the API response. It is
   not their business, and it keeps the negotiation with the client out of their
   hands.
3. **No permission gate on initiating.** Any staffer assigned to the event can
   start a request, hosted or not. Dallas controls who is on the job at staffing
   time; a runtime flag that can block someone he personally staffed is a failure
   mode with no upside. Explicitly rejected: a seniority flag on the profile.
4. **Hosted events get a confirmation step, not a lock.** On a hosted package the
   request screen asks the staffer to confirm they have the product to serve the
   extra time before it sends. Rationale: the alcohol was bought against a 4-hour
   shopping list, so the extra hour is product as well as labor.
5. **Staff pick a new end time, not a number of extra hours.** The picker opens on
   the contracted end time, steps in 30 minutes, and is capped at plus 3 hours so
   a mis-scroll cannot invoice a second event.
6. **Price is the pricing engine's delta.** No new pricing path. Gratuity rides
   along because it is a per-staff-per-hour rate in the contract, and it is the
   money that actually reaches the bartender for standing there at 11pm.
   Explicitly rejected: a flat $100/hr, which charges the same whether one
   bartender stays or three and would lose money on multi-staff events.
7. **The client pays on the regular invoice page.** Not a bespoke wallet-only
   screen. `InvoicePage` already runs Stripe's `PaymentElement`, which surfaces
   Apple Pay and Google Pay on the client's own phone. That is the actual answer
   to "I cannot find my payment method."
8. **Terms must be accepted before paying.** Brief, and it names the insurance
   point. Rationale: the client has the same incentive to go around DRB that the
   bartender does ($60 cash beats $100 invoiced), and coverage is the only
   argument that lands on someone without integrity.
9. **Unpaid is a hard stop.** No greenlight means bar service ends at the
   contracted time. No grace hour, no "settle up Monday." Admin can override.
10. **The contract does not move until money lands.** The proposal is untouched
    while a request is pending.
11. **Language says SERVICE ends at the contracted time.** Policy is 30 minutes of
    cleanup after, and staff are paid for contracted hours regardless, so the
    messages must not read as "you are done and must leave."

## 4. Non-goals

- No card-on-file / off-session charging. See grounding.
- No cash or external-payment reconciliation path. A "client paid me cash" button
  is the leak, not the fix. (See also the parked Zelle/Venmo recon spec.)
- No seniority or role tier.
- No change to how extensions are handled for events with no DRB-assigned staff.
- Not a general "edit the event mid-flight" tool. Duration only.

## 5. Flow

1. **Request.** Staffer opens their shift in the staff portal and taps "Request
   more time." Available only from event start through the contracted end plus 15
   minutes. They pick a new end time. On a hosted package they also tick the
   product confirmation. No price is shown or sent.
2. **Price and send.** The server computes the delta with the pricing engine,
   creates an itemized extension invoice, and sends the client its token link by
   SMS with the same thing emailed as a backup. Dallas and Zul are notified that
   the request went out.
3. **Client accepts and pays.** The invoice page shows the terms block above the
   payment element, with pay disabled until accepted. Acceptance is recorded with
   timestamp and IP.
4. **Settle.** On `payment_intent.succeeded`, the extension folds into the
   contract (section 7) and every staffer assigned to that event gets the
   greenlight text. Not just the requester: on a two-bartender job both need to
   know.
5. **Expire.** If nothing is paid by the contracted end time plus 15 minutes, the
   request expires, its open payment intents are cancelled and the invoice voided,
   and every assigned staffer gets the decline text.
6. **Override.** Dallas or Zul can greenlight unpaid time from the admin side, or
   kill a pending request. An override performs the same fold and leaves the
   invoice open and unpaid to collect.

## 6. Pricing

The price is `calculateProposal` re-run at the new duration minus the same
computation at the contracted duration. Nothing is invented.

What this gets right for free:

- **Package base.** Flat packages add `(newHours - oldHours) * extra_hour_rate`.
  Per-guest packages add `billedGuests * (newHours - oldHours) * extra_hour_rate`.
- **Multi-staff.** Extra bartenders above the included ratio bill at
  `extra_bartender_hourly` scaled by duration, so three bartenders staying costs
  the client more than one.
- **Gratuity.** `gratuityLineAmount(rate, staffCount, hours)` scales with hours,
  so a $50/staff/hr event owes another $25 for a half hour and a $0 event owes
  nothing extra.
- **Timed add-ons.** `per_guest_timed` and `per_hour` add-ons scale on their own.
- **Negotiated overrides.** `foldExtrasIntoProposal` already prices the delta at
  catalog with `total_price_override` held aside and moves the contract by it.
  This matters: many Core Reaction bookings are sold at $400 against a $350
  catalog, and both dropping the override and passing it through untouched are
  wrong.

Worked examples:

| Event | Extension | Price |
|---|---|---|
| Core Reaction, 1 bartender, `gratuity_rate` 0 | +30 min | $50 |
| Core Reaction, 1 bartender, `gratuity_rate` $50 | +30 min | $75 |
| Core Reaction, 2 bartenders (1 over ratio), `gratuity_rate` 0 | +60 min | $140 |
| Base Compound hosted, 100 guests, `gratuity_rate` 0 | +60 min | $500 |

## 7. Money model and ordering

**Nothing about the proposal changes while a request is pending.** On request the
system creates an extension invoice with an explicit line item, for example
"Additional bar service, 10:00 PM to 11:00 PM," priced at the engine delta. The
proposal's `event_duration_hours` and `total_price` are untouched. The invoice
token is what the client receives.

**On payment success**, inside the existing `paymentIntentSucceeded` handler and
in one transaction with the proposal selected `FOR UPDATE`:

1. Persist `proposals.event_duration_hours` at the new value.
2. Call `foldExtrasIntoProposal` with new `durationBefore` / `durationAfter` legs.
   This follows the leg contract the cancel-line work established for
   `num_bartenders` and `adjustments`: the caller persists the column, the fold
   writes only `total_price`, `pricing_snapshot`, and `total_price_override`.
3. `refreshUnlockedInvoices` + link the payment to the extension invoice via
   `linkPaymentToInvoice`.
4. Re-evaluate payment status via the fold's `reconcileProposalPaymentStatus`.
5. Sync the linked `shifts` row: `event_duration_hours` and `end_time`
   (`addHoursToTime` in `eventCreation.js` is the existing helper).
6. Stamp the extension row as approved.

**Delta re-verification.** The delta is computed at request time to price the
invoice and recomputed at fold time. Same night, same inputs, so they should
match. If they differ, the invoiced amount is authoritative (that is what the
client accepted and paid) and the discrepancy is logged to Sentry and the activity
log rather than silently repricing.

**Ordering rationale.** This is what makes the record say the right thing. A paid
extension reads as a 4.5 hour event. One the client never tapped reads as a 4 hour
event with an expired request attached, which is exactly the artifact wanted if the
cash deal happened anyway.

## 8. Data model

New table `service_extensions`, one row per request:

- `id`, `proposal_id`, `shift_id`, `requested_by_user_id`
- `contracted_end_time`, `requested_end_time`, `contracted_duration_hours`,
  `requested_duration_hours`
- `amount_cents` (the quoted delta), `invoice_id`
- `hosted_product_confirmed` (boolean, null on non-hosted)
- `terms_version`, `client_accepted_at`, `client_accept_ip`, `client_accept_ua`
- `status`: `pending` | `paid` | `expired` | `cancelled` | `overridden`
- `override_by_user_id`, `override_reason`
- `expires_at`, `created_at`, `updated_at`

Constraint: at most one `pending` row per `proposal_id` (partial unique index).

The row is written on every outcome, including declines and expiries. Combined
with the invoice, the payment, and the activity log, this is the artifact for a
broker or a lawyer.

## 9. Payroll

`payrollAccrual` seeds `contracted_hours` from `proposal.event_duration_hours` on
the first accrual for that contractor and shift, and accrual runs at event
completion, after the fold. So the extra time reaches pay with no special path.

**Known gotcha, must be surfaced in the UI.** After the first accrual the admin
owns `hours`, and re-accrual preserves the prior row. If accrual has already run
for that event, a late extension will not re-seed and the staffer is silently
underpaid. The admin override screen and the extension detail view must say so and
link to the payroll line. This mirrors the existing payroll rate-seeding gotcha
(a profile rate bump does not touch already-accrued lines).

## 10. Notifications and copy

**Client, terms block above the payment element:**

> **Extend bar service to 11:00 PM**
> Another 30 minutes of bar service under your existing agreement. Same team,
> same terms, same $2 million liquor liability coverage.
>
> That coverage applies to service booked through Dr. Bartender. Our bartenders
> cannot accept payment directly for additional service time, and any arrangement
> made privately with a bartender is not insured.

**Client SMS:** short, with the invoice link. Email carries the same.

**Staffer, declined or expired:**

> Dr. Bartender: additional time was not approved. Bar service ends at 10:00 PM as
> contracted. Serving past that is not DRB work and is not covered by DRB
> insurance. Do not accept payment from the client directly.

**Staffer, approved:**

> Dr. Bartender: approved. Bar service now runs to 11:00 PM. Your hours are
> updated, nothing else to do.

**Admin:** notified when a request goes out, when it settles, and when it expires.

**Placement beyond this feature.** The 10pm terms screen only catches a client who
came to the system. The client who was always going to hand a bartender $60 never
opens it. A version of the insurance sentence belongs in the event services
agreement signed at booking and in the pre-event email, where it costs nothing and
arrives before anyone is negotiating in a kitchen. Likewise, the "serving past the
contracted end is not DRB work and is not covered" line belongs in the contractor
agreement, not only in a text message. Both are follow-on work, not in this build.

## 11. Edge cases

- **`YES` collides with SMS opt-in.** `smsInbound.js` `START_WORDS` already
  contains `yes`, so a reply-YES-to-approve flow would fight carrier opt-in
  handling. This design avoids inbound client SMS entirely; the client acts on the
  invoice page. Recorded so nobody reintroduces it.
- **Client opted out of SMS or has no phone.** Fall back to email only and notify
  the admin that the link could not be texted. Respect the phone-scoped STOP
  guard.
- **Late payment after expiry.** On expiry, cancel open payment intents
  (`cancelOpenInvoiceIntents`) and void the invoice so a late tap cannot generate
  an hour nobody worked.
- **Two staffers request at once.** The partial unique index on pending requests
  makes the second a no-op that surfaces the existing pending request.
- **A second extension after one settles.** Allowed. The new request's contracted
  end is the already-extended end.
- **Event has no assigned staff.** The button does not exist; there is no staff
  portal surface without an assignment.
- **Proposal is already `completed`.** Fold must handle or refuse cleanly rather
  than half-applying. Refuse and route to admin override.
- **Timezone.** All end-time math uses `event_timezone` (defaults
  `America/Chicago`) via the existing `shiftTime` / `eventTimezone` helpers. Never
  naive local time.

## 12. Cross-cutting consistency checklist

Per CLAUDE.md, changing duration means everything downstream moves:

- `proposals`: `event_duration_hours`, `total_price`, `pricing_snapshot`, payment
  status re-evaluation
- `shifts`: `event_duration_hours`, `end_time`
- invoices: extension invoice, `refreshUnlockedInvoices`, payment linking
- gratuity: basis is rate times staff times hours, moves with the fold
- payroll: `contracted_hours` on first accrual, plus the already-accrued gotcha
- BEO, calendar, client portal, and Money Board all read from the above and should
  be verified rather than assumed
- refunds: extension money is ordinary contract money and stays off
  `OFF_LEDGER_INVOICE_LABELS`

## 13. Testing

- Pricing delta unit tests per package shape: flat, per-guest, class (zero extra
  hour rate), with and without `gratuity_rate`, with and without
  `total_price_override`, single and multi bartender.
- Fold idempotency: a replayed webhook must not double-extend.
- Expiry: invoice voided, intents cancelled, late payment impossible.
- Pending uniqueness under concurrent requests.
- Staff API response contains no price field.
- Payroll: extension before accrual seeds correctly; extension after accrual
  surfaces the warning rather than silently underpaying.
- Timezone: an event crossing midnight extends correctly.

## 14. Open items

- Dallas to put the coverage question to the broker in writing.
- Insurance language for the event services agreement, the pre-event email, and
  the contractor agreement: follow-on work, not this build.
