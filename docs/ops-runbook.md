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
- **§8.1 Lead-bartender overtime — $100/hr.** Additional Time bills at **$100/hr
  for the lead** plus $40/hr per additional bartender, pro-rated in 30-min
  increments. The app's `extra_bartender_hourly` default ($40) covers the
  additional-bartender rate only; the $100/hr lead overtime is not automated —
  add it to the final invoice manually.

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
3. **Adoption is automatic.** The `charge.refunded` webhook routes the
   dashboard refund through `applyRefundReconciliation`, which classifies the
   linked invoice label as off-ledger and records the refund without touching
   contract money (the stale-pending refund sweeper is the backstop for any
   refund row stuck pending).

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
