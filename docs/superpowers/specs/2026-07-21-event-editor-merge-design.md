# Event editor merge: full proposal editing from the event page

**Date:** 2026-07-21
**Status:** Approved (section-by-section, Dallas)
**Track:** Project (think on main, build in a lane)

## Problem

A booked event's guest count (and package, add-ons, adjustments, everything
priced) cannot be edited from the event page. `EventEditForm` deliberately
exposes only date, time, location, and contact. The only route to the pricing
editor is a 10px `9818`-style link inside the `EVENT · <id>` eyebrow on
`EventDetailPage`, which is not a human-visible affordance. In practice the
admin lands on the event (via ⌘K's Events group or the Events dashboard), sees
no way to change guest count, and is stuck.

The proposal-side editor (`ProposalDetailEditForm`) already handles every one
of these edits with no status gating, and `PATCH /proposals/:id` already does
the full downstream cascade in one transaction: re-price, payment-status
reconcile in both directions, shift lockstep sync, unlocked-invoice refresh,
Additional Services invoice on increase, change-request resolution, reschedule
notices. The gap is purely which fields the event-side form renders.

### Latent money defect found during design

`EventEditForm`'s premise is that it round-trips every pricing input
unchanged. It omits one: `addon_quantities`. Server-side, every other pricing
field falls back to the stored value when absent, but add-on quantity resolves
through `safeAddonQty(addon_quantities?.[id])`, and `safeAddonQty(undefined)`
returns 1. Saving a date change from the event page therefore resets any
admin-set add-on quantity to 1 and reprices. Verified against prod
2026-07-21: every booked event's qty > 1 today is engine-derived (guest count,
hours), none admin-set, so nothing is currently mispriced. The defect is
latent. The merge removes it structurally: one payload builder, not two.

## Design

### One editor, two mounts

Extract the body of `ProposalDetailEditForm` (846 lines, already over the
700-line soft cap) into a shared editor component that owns:

- form state seeded from the existing `initialFormFromProposal` builder
- the debounced `/proposals/calculate` live-total preview (including the
  `gratuityDirty` guard exactly as it exists today)
- every section: Client, Event, Package, Add-ons, Glassware, Class options,
  Syrups, Adjustments, Gratuity, Total override, Live preview
- the full save payload (the one currently in `ProposalDetailEditForm`,
  including `addon_quantities`, `class_options`, `client_provides_glassware`)
- dirty tracking, leave-confirm modal, field errors

Mount points:

- **`ProposalDetail`** mounts it exactly as today (passes `changeRequest`
  when applying a client change request). No behavior change.
- **`EventDetailPage`'s Edit button** mounts the same component plus the
  transient staff-notification toggles (`notify_assigned_staff`,
  `notify_staff_sms`, `notify_staff_email`) that `EventEditForm` carries
  today. Those remain event-mount-only, preserving current behavior.

`EventEditForm.js` shrinks to a thin wrapper (or is deleted if the wrapper is
trivial enough to inline into `EventDetailPage`).

Mount differences are props, not forks: `changeRequest` (proposal mount),
`showStaffNotifyToggles` (event mount), card title text. Everything else is
identical by construction.

No server changes. `PATCH /proposals/:id` is untouched.

### File placement and size

The extraction must leave no file over the 700-line soft cap. Follow the
existing page-split pattern (self-contained section extraction). Target
shape: a `proposalEditor/` module under `client/src/pages/admin/` holding the
shared form plus its larger sections; `ProposalDetailEditForm.js` remains only
as the proposal mount (or is renamed away entirely). Exact file split is the
plan's call; the constraint is the cap and one payload builder.

### Reprice confirmation on booked events

A confirmation modal appears at save time when BOTH hold:

1. the proposal is booked: status in `deposit_paid`, `balance_paid`,
   `confirmed`
2. the computed total moved: live preview total differs from stored
   `total_price`

Pure logistics edits (no price movement) save without a modal, as today.
Unbooked proposals never see the modal regardless of price movement (repricing
is the normal quoting workflow).

Modal content, assembled entirely from data already in hand (stored proposal
row + live preview), no extra fetches:

- Old total, new total, signed delta
- Paid so far
- New balance
- Consequence lines, only those that will actually fire, derived from the
  same rules the server applies:
  - increase while `balance_paid`: will drop back to deposit paid, autopay
    unenrolled, an Additional Services invoice created for the increase
  - increase while `deposit_paid`/`confirmed`: invoice line only
  - decrease below amount paid: client becomes overpaid by $X, a refund is
    likely owed (server flags overpayment; it never moves money on its own)
  - always, when repricing: unlocked invoices are rebuilt at the new
    pricing; locked and manual invoices stay untouched

Confirm button: "Save and reprice". Cancel returns to the form with state
intact. The modal is client-side prediction only; the server transaction is
byte-identical with or without it. It does not become a second decision-maker
on the money path.

## Out of scope

- **⌘K search changes.** Dropped during design. Booked proposals already
  surface under the Events group; the original complaint dissolved once the
  event page can edit everything. No fuzzy matching, no grouping changes.
- **Server-side changes of any kind.**
- **The client-facing change-request flow.** Untouched; the proposal mount
  keeps passing `change_request_id` exactly as today.

## Testing

- **Unit (client):** payload builder produces identical bodies from both
  mounts given the same form state, including `addon_quantities` (the latent
  defect's regression test). Modal trigger logic: booked + moved = modal;
  booked + unmoved = no modal; unbooked + moved = no modal.
- **Manual, dev DB:** on a booked event, from the EVENT page edit guest
  count, confirm modal shows correct old/new/delta/paid/balance and correct
  consequence lines for increase and decrease; save; verify shift re-sync,
  invoice refresh, and payment-status demotion behave as they already do from
  the proposal side. Verify a date-only edit on an event with an admin-set
  add-on quantity > 1 no longer resets it (set one up by hand first).
- **Review scaling:** the form drives `PATCH /proposals/:id` (money path), so
  the lane gets the full review fleet regardless of the client-only diff.
