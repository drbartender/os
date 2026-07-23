# Cancel line item: one-motion removal with the money handled

**Date:** 2026-07-22
**Status:** Approved (section-by-section, Dallas)
**Track:** Project (think on main, build in a lane)

## Problem

Removing something from a booked contract and returning the client's money
are two disconnected operations today, and each one alone leaves the proposal
wrong.

- A refund through the payment panel moves money but never touches
  `proposal_addons` or the pricing snapshot. Refunding a paid Enhancement Lab
  charge gives the money back but leaves the item on the contract, so the
  proposal immediately shows the client owing that amount again. (This is the
  open fix-list item from 598987d, under discussion 2026-07-21, resolved by
  this feature.)
- The admin editor (`PATCH /proposals/:id`) can remove items, but it passes
  `total_price_override` through as an absolute value, so on an override'd
  contract removing an item does not lower the contract. And it never
  refunds: a decrease below `amount_paid` only flags overpayment and leaves
  the admin to run a second, manually computed refund from the payment panel.

The removal mechanics already exist: `foldExtrasIntoProposal` is symmetric
(negative deltas work; the Enhancement Lab already removes items through it),
and it moves the override by the catalog delta so negotiated prices survive.
What is missing is one deliberate act that removes a line and settles the
money in the same motion.

## Decisions

**The money rule.** Cancel lowers the total. A refund fires only when the
new total lands below `amount_paid`, and it refunds exactly that
overpayment, never the item's sticker price. A partly paid client who
cancels an item mostly just owes less.

**One motion, double confirm.** Cancel and refund are one act behind a
two-step confirmation. This flow has no cancel-without-settling path and no
settle-without-cancel path.

**Every client-visible line is a cancel target.** "Sorry, that one is
special" does not work with a client. The storage shape (addon row,
engine-computed line, adjustment entry) is an implementation detail behind a
per-kind registry, never an admin-facing excuse.

**The package line hands off.** Cancelling the package itself is event
cancellation, which is the existing flow, not this feature. The breakdown's
package line routes there.

**Gratuity is removable and shrinkable, with a mandatory staff notice.**
Details in the registry section.

## Design

### Surface and architecture

Admin-only. The pricing breakdown on the proposal page and the event page
(the shared surfaces from the 2026-07-21 event-editor merge) gets a per-line
cancel affordance. Clients keep their existing paths (change requests, the
Lab); nothing client-facing changes.

Server side is one new preview/execute endpoint pair taking a typed target:

| target | meaning |
|---|---|
| `addon:<slug>` | catalog or lab add-on row, optional quantity |
| `bar` | drops `num_bars` |
| `syrup:<id>` | one syrup selection |
| `extra-bartender` | lowers the bartender count |
| `adjustment:<idx>` | one adjustments-column entry, incl. manual charges and discounts |
| `gratuity` | remove entirely or lower to a given rate |

Execute composes existing seams in order: the per-kind mutation,
`foldExtrasIntoProposal` (contract-safe reprice, override moved by catalog
delta), `refreshUnlockedInvoices`, shift re-sync, then the refund
planner/executor. Proposal money stays in dollars and refunds in cents, with
conversion at the same seam the refund chain uses today.

This is explicitly NOT a new mode on `PATCH /proposals/:id`: that path
treats the override as absolute and is 834 lines of battle-tested money code
this feature must not destabilize.

### Confirm flow and money movement

Two steps, always:

1. **Preview.** Clicking cancel on a line opens a modal fed by the
   server-computed preview: the line being removed, old total, new total,
   delta, paid so far, and the consequence, one of "client owes $X less" or
   "client becomes overpaid: refund $Y". When part of `amount_paid` is
   external money (CC transfer, Zelle), the preview splits it: "refund $A to
   card, return $B manually". Locked invoices on the proposal are noted (see
   cross-seams). Quantity lines ask "remove how many?", defaulting to all.
   The gratuity target offers its remove/lower choice here.
2. **Confirm.** The button restates the act: "Remove and refund $225.00", or
   "Remove (client owes $150.00 less)". Cancel returns to the page with
   nothing changed.

Ordering: the removal transaction (per-kind mutation, fold, invoice refresh,
shift sync, activity log) commits FIRST. The refund fires after commit
through the existing chain: pending `proposal_refunds` row, synchronous
Stripe refund with idempotency key, reconciliation, `charge.refunded`
webhook backstop, and the 15-minute stranded-pending sweeper. A Stripe
failure leaves the removal standing with the overpaid flag set, and the
payment panel's existing refund is the retry path. The proposal is never
left with money moved but the item still on the contract, which is the
exact wart this feature exists to close.

Multi-charge overpayment: a refund cannot span Stripe charges
(`EXCEEDS_SINGLE_CHARGE`), so an overpayment larger than any single charge
auto-splits into sequential per-charge refunds.

External-paid money: only the card portion fires through Stripe. The
external portion stays flagged as "return manually" in the preview and on
the proposal; `external_paid` is never touched by the automated path,
consistent with the refund chain today.

Client comms: when a refund fires, the client gets the existing refund
notice. A removal with no refund goes through the notify-client
confirmation toggle, the existing machinery; nothing new is invented.

### The per-kind registry

Eligibility first: the cancel affordance shows on active proposals up
through the event. It is hidden on archived proposals and completed events
(payroll has run; changes there are deliberate manual territory).

- **Add-on rows** (`addon:<slug>`): delete the `proposal_addons` row, or
  lower its quantity when the admin removes fewer than all.
- **Second bar** (`bar`): drops `num_bars`; the pricing engine reprices bar
  rental on its own.
- **Syrups** (`syrup:<id>`): removes the selection from the snapshot's
  syrup selections, per syrup.
- **Extra bartenders** (`extra-bartender`): lowers the count, never below
  the package's required staffing. Hosted-ratio law holds: included 1:100
  bartenders render as included, not cancellable; only over-ratio
  bartenders, which carry real price, are targets, and the engine prices
  their hourly plus surcharge. A staffing removal re-syncs shifts, and on a
  funded proposal reconciles the payroll accrual for the open period,
  mirroring what a roster drop already does.
- **Adjustments** (`adjustment:<idx>`): removes the entry, including manual
  charges. Removing a discount RAISES the total; that flows through the
  existing increase path (an unlocked invoice absorbs it on rebuild, an
  Additional Services invoice is minted only when invoices are locked).
- **Gratuity** (`gratuity`): full removal sets the rate to 0 and flips
  `tip_jar` on, the only valid state under the DB CHECK
  (`tip_jar OR gratuity_rate >= 50`), and fires a MANDATORY staff
  notification: staff must know they can put out a tip jar. A shrink offers
  "remove entirely or lower to $X/staff/hr"; below the $50 no-jar floor the
  jar flips on with the same notice. The durable record is tip-jar status on
  the staff event-details page (verify it renders there; add it if
  missing). The forced Shared Gratuity surcharge is structural and
  untouched. A refunded gratuity rides the existing tip clawback machinery
  (`clawbackTipByPaymentIntent` via the `charge.refunded` handler).

### Cross-seams

- **The Lab resurrection trap.** The add-on row is not the only record of a
  lab-added item; the drink plan's selections carry the `labAdded` entry.
  An admin cancel must strip that too (and lab syrup selections for a syrup
  target), or the client's next Lab save reconciles the item right back
  onto the contract. The removal also retriggers the existing shopping-list
  regeneration so the list stays honest. This is the one place cancel
  writes outside the proposal tables.
- **Locked and manual invoices: never touched.** `refreshUnlockedInvoices`
  only rebuilds unlocked invoices; a hand-built locked itemization survives
  by design. When one exists, the preview says so plainly: "a locked
  invoice for $X stands and won't be rebuilt."
- **Open delta invoices reconcile down.** An unpaid Additional Services
  invoice minted by an earlier increase, or an unpaid Enhancement Lab
  invoice minted by a fully paid Lab round, gets reconciled down when the
  money behind it is cancelled, so the client is not chased for cancelled
  money. A paid delta invoice needs nothing special: its dollars already
  sit in `amount_paid` and flow through the overpayment math.
  (`OFF_LEDGER_INVOICE_LABELS` is empty at HEAD; every lab charge is
  contract money. This feature depends on that and adds nothing
  off-ledger.)
- **Autopay and reminders: free.** Autopay charges total minus paid at fire
  time, so a lowered total charges less; the fold's demotion path already
  disarms autopay on the paid-in-full flip; balance reminders compute their
  amount when they fire and suppress at zero balance.
- **Audit.** Every cancel writes an activity-log row: the target, old and
  new totals, and refund IDs when money moved.

### Execution guards

- **One computation, two callers.** Preview and execute run the same
  server-side function; the preview is never a client-side estimate. The
  confirm button restates exactly what execute will do, by construction.
- **Stale-preview guard.** Execute carries a fingerprint from the preview
  (proposal `updated_at` plus `amount_paid`). If anything moved between
  preview and confirm (another admin saved, a payment landed), execute
  rejects with "numbers changed, review again" instead of acting on stale
  math. Execute takes the proposal row FOR UPDATE, same as the Lab PUT, so
  two admins cannot cancel concurrently.

## Out of scope

- Client-facing cancellation of anything. Clients keep change requests and
  the Lab.
- Event/package cancellation itself. The package line only links to the
  existing flow.
- The forced Shared Gratuity surcharge.
- Any change to `PATCH /proposals/:id` or to the payment panel's refund
  behavior.

## Testing

- **Unit (server), the money core:** per-kind registry tests on an
  override'd contract: the removed item moves the total by its catalog
  price and everything unchanged cancels (the drink-plan-override
  regression shape). Gratuity full removal passes the DB CHECK via the
  tip-jar flip; a below-$50 shrink flips too. Extra-bartender floor and
  hosted-included guards. Refund split across two charges. External-paid
  split in the preview. Removal-commits-then-refund-fires ordering with a
  simulated Stripe failure leaving the overpaid flag.
- **Seam tests:** Lab resurrection guard (cancel a lab-added item, replay a
  Lab PUT, the item stays gone). Open Additional Services and Enhancement
  Lab invoices reconciled down. Locked invoice untouched. An adjustment
  removal that raises the total flowing through the existing increase path.
- **Suites the change reaches:** the fold, refund helpers, and invoice
  lifecycle all have existing callers; grep them and run those suites (lab,
  submitOverride, refund, webhook), per the standing law.
- **Manual, dev DB plus Stripe test mode:** one full paid-cancel walk with
  a real test-mode refund; one gratuity removal confirming the staff notice
  lands.
- **Review scaling:** money path end to end, so the full review fleet at
  each lane checkpoint, max effort.
