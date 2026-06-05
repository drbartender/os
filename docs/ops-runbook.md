# Ops Runbook — Manual Obligations from the Event Services Agreement

Source: `docs/superpowers/specs/2026-06-04-event-services-agreement-integration-design.md` §6.

The master Event Services Agreement (presented at proposal sign-and-pay) creates
obligations the platform does NOT automate. Honor these manually and
consistently — the signed agreement is binding even where the code does not
enforce the term.

## Client-favorable (watch these — under-enforcing breaks a promise you made)

- **§5.2 Final guest count — 85% floor (asymmetric in the client's favor).**
  Downward guest-count changes after the 14-day deadline do NOT reduce the
  contract total below **85%** of the signed proposal. The app does not automate
  re-quotes; when you manually re-quote a decreased guest count, never drop below
  85% of the signed total. (Upward changes <10% bill at the per-guest add-on
  rate; >=10% add staff at the contracted per-bartender rate, subject to
  availability.)

## Seller-side (not auto-enforced; apply when the situation arises)

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

## Payment methods (§2.3)

The agreement lists ACH, card, check, Google/Apple/Amazon Pay, Cash App, Venmo,
and Zelle. Only Stripe (cards + Apple/Google Pay) is an integrated rail. Accept
the others manually if a client asks; there is no automated reconciliation
(external payment recon is parked).

## Known interim contradiction (§8.3 — to be fixed in Project B)

At sub-100-guest events carrying extra/add-on bartenders, the client sees a
"$50/hr Shared Gratuity" line (the sub-100-guest surcharge) while §8.3 frames
"$50/bartender/hr" as meaning *no tip jar*. Low frequency; §1.3 gives the master
terms control over a conflicting Event-Specific line. The relabel is a
payroll-coupled change assigned to Project B.
