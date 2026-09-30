# Ops Runbook — Manual Procedures

## Obligations from the Event Services Agreement

Source: `docs/superpowers/specs/2026-06-04-event-services-agreement-integration-design.md` §6.

The master Event Services Agreement (presented at proposal sign-and-pay) creates
obligations the platform does NOT automate. Honor these manually and
consistently — the signed agreement is binding even where the code does not
enforce the term.

### Client-favorable (watch these — under-enforcing breaks a promise you made)

- **§5.2 Final guest count — 85% floor (asymmetric in the client's favor).**
  Downward guest-count changes after the 14-day deadline do NOT reduce the
  contract total below **85%** of the signed proposal. The app does not automate
  re-quotes; when you manually re-quote a decreased guest count, never drop below
  85% of the signed total. (Upward changes <10% bill at the per-guest add-on
  rate; >=10% add staff at the contracted per-bartender rate, subject to
  availability.)

### Seller-side (not auto-enforced; apply when the situation arises)

- **§3.1 Cancellation tiers (liquidated damages).** More than 14 days out: the
  client forfeits the retainer; refund any excess over the retainer **less a 5%
  processing fee** within 15 business days. 14 days or fewer out: 100% of the
  contract total is due, amounts paid are non-refundable. `refundHelpers.js`
  issues admin partial refunds but does NOT compute these tiers — calculate
  manually.
- **§2.5 Returned payment / chargeback — $35 fee.** Returned checks or reversed
  payments incur a **$35** fee. Not coded; bill manually.
- **§8.1 Additional Time (agreement v4).** Which terms a client agreed to is
  the version recorded on their signature, shown on the admin proposal page as
  "Agreement version". Go by that, never by the signing date: a client signs
  whichever version their browser loaded, so v3 signatures keep arriving after
  v4 ships. No Signature card at all means no signature was recorded here
  (the Check Cherry transfers, for one). A version of
  event-services-agreement-v2 means they signed the abridged pre-June text,
  which states no added-time rate. In both cases neither text below is
  theirs; go by the contract they signed.
  - **On-site time is automated.** The bartender requests it, the client gets
    a separate 'Service Extension' invoice that states the amount, and the
    bartender is cleared to continue only once it is accepted and paid. Two
    exits: a $0 extension settles on acceptance alone, and an admin override
    on the request grants the time unpaid and voids the invoice. A price
    override on the booking changes nothing here: the extension is always
    priced from the catalog. Every 30-min increment past the booked end
    bills, even inside a package's 4-hour base:
    - The package: $100/hr on the Core Reaction. On a hosted package, the
      per-guest extra-hour rate times the billed guest count (25 minimum). On
      a class, $0, because a class's extra-hour rate is $0.
    - $40/hr per over-included bartender, plus the sub-100-guest gratuity
      surcharge on each: $50/hr under 50 guests, $25/hr at 50 to 74, $15/hr
      at 75 to 99, none at 100 or more. A class charges neither.
    - Time-priced add-ons past their included hours, and the client's
      gratuity for the added time.
    The proposal page shows the client the package rate under the Total
    ("Added time on the day"), except on a proposal signed under v3. It
    follows the catalog: change a rate and signed clients see the new one.
  - **The automation does not read the signed version.** Every client is
    quoted the formula above. v3 signers agreed to $100/hr for the lead
    bartender plus $40/hr for each additional bartender, added to the final
    invoice. The automated quote can differ from that. On a hosted package
    the package charge is the per-guest rate, not $100/hr. On any package it
    also carries the surcharge, time-priced add-ons and gratuity, which v3
    8.1 does not list. OPEN, owner decision: whether a v3 signer is held to
    the automated quote or billed the v3 rate. There is no verified recipe
    for billing the v3 rate by hand yet: the admin override on the request
    grants the time, and the warning below then applies to the booking.
  - **After an extension settles, leave the booking's editor alone.**
    Settling, paid or overridden, moves the booking's duration and leaves its
    price where it was. The next save of that booking in the admin editor
    re-prices it at the longer duration, which bills the added time through
    the contract on top of the extension invoice. If an edit cannot wait,
    note the total before, save, and compare: the part of the increase that
    is not your own edit is the added time billed a second time. The code fix
    is on the fix list.
  - **Time arranged in advance** (an admin duration change) is the ordinary
    re-price. What it adds for the added time varies, so read it off the
    save: note the total and the package line before, save, and compare.
    - No override: over-included bartenders, time-priced add-ons and gratuity
      re-price on their own. The package line re-prices only where the
      catalog charges for the hour. It does not inside the 4-hour base (a 3h
      Core Reaction moved to 4h adds $0). It may not on a small hosted
      booking still held at the $550 minimum (The Primary Culture at 25
      guests adds $0 from 4h to 5h, and $75 from 4h to 6h). It never does on
      a class. Add only the package amount the save left out, as a surcharge
      adjustment. Anything else bills twice.
    - "Override total" set: the override replaces the whole calculated total,
      so the save adds nothing for the added time at any hour. A 4h Core
      Reaction sold at $400 and moved to 6h keeps a $400 service total. A
      surcharge adjustment changes nothing here and still prints as a line,
      so do not add one. Raise the override by the service charge for the
      added time: package hours, over-included bartenders with their
      surcharge, time-priced add-ons. Leave the client's Gratuity line out:
      it sits on top of the override and rescales with the hours on its own.

### Payment methods (§2.3)

The agreement lists ACH, card, check, Google/Apple/Amazon Pay, Cash App, Venmo,
and Zelle. Only Stripe (cards + Apple/Google Pay) is an integrated rail. Accept
the others manually if a client asks; there is no automated reconciliation
(external payment recon is parked).

### Known interim contradiction (§8.3 — to be fixed in Project B)

At sub-100-guest events carrying extra/add-on bartenders, the client sees a
"$50/hr Shared Gratuity" line (the sub-100-guest surcharge) while §8.3 frames
"$50/bartender/hr" as meaning *no tip jar*. Low frequency; §1.3 gives the master
terms control over a conflicting Event-Specific line. The relabel is a
payroll-coupled change assigned to Project B.

## Service Extension refunds (Stripe dashboard, manual by design)

Source: `docs/superpowers/specs/2026-07-25-service-extension-design.md` §7 and
§14; wired 2026-08-03 (plan Task 19).

Extension money is off-ledger: a paid extension lives on its own
'Service Extension' invoice, minted alone and paid alone, and its dollars never
enter `proposals.total_price` or `amount_paid`. Because of that, the admin
refund button deliberately cannot see extension payments:
`loadPaymentsWithRemaining` (`server/utils/refundHelpers.js`) excludes any
payment linked to an off-ledger-labeled invoice from the refund candidate set,
on both the admin panel rails and the cancel-line rails. Refunding a paid
extension is therefore a manual Stripe-dashboard action against that specific
payment.

### How the admin refund panel works today (for contrast, not for extensions)

`POST /api/stripe/refund/:id` plans against the contract candidates
(`planRefund`) and executes through the shared `refundExecute` util: it writes
a `total_scope`-stamped pending `proposal_refunds` row, fires the Stripe
refund, then reconciles (`server/routes/stripe.js`). There is no inline
orchestration in the route anymore; never describe or rebuild one.

### Procedure: refund a paid extension

1. **Find the payment.** The event's extensions panel shows the extension and
   its 'Service Extension' invoice; that invoice's payment carries the Stripe
   payment intent id. In the Stripe dashboard, locate the payment by that
   intent id (or by the client's email plus the extension's charge date and
   amount).
2. **Refund it at Stripe** (full or partial) against that payment. Do not
   attempt the admin refund button for this: the extension payment is not in
   its candidate list, and that is intentional.
3. **Adoption is automatic.** The `refund.created` webhook routes the
   dashboard refund through `applyRefundReconciliation`, which classifies the
   linked invoice label as off-ledger and records the refund without touching
   contract money (the stale-pending refund sweeper is the backstop for any
   refund row stuck pending). Since 2026-09-15 this is `refund.created`, not
   `charge.refunded`: the account API version no longer puts a `refunds` list
   on the Charge, so the old handler silently reconciled nothing. An extension
   refund lands `contract` scope, which is harmless because `Service Extension`
   is not a contract label: the contract portion computes to zero and the
   off-ledger rule keeps `amount_paid` still.

### What to expect afterwards

- **Contract totals do not move.** `total_price` and `amount_paid` stay put:
  those dollars never entered them, so their refund never leaves them.
- The extension invoice's paid/due figures drop, the reversal is recorded on
  `invoice_payments`, and the refund appears in `proposal_refunds` and the
  proposal activity log.
- **The event duration is never auto-reverted.** Whether the extended time was
  actually served is a fact only a human knows. If the extension should also
  be undone operationally, adjust the event duration by hand.
- **Gratuity (spec §14 default, approved 2026-08-03): the bartender keeps the
  gratuity share.** The refund returns the client's money; it does not claw
  back the staff pool share. This stands unless Dallas later flips the default
  to pull-from-pool-on-refund.
