# Contract hours vs worked hours after an on-site extension

Date: 2026-09-30. Bounded change, brainstormed in chat with Dallas, who approved the
design and asked for a step-back review before the build. The design fleet (spec-grounding,
spec-gaps, spec-risk) returned 5 blockers and 11 warnings on the first draft; all are folded
below, and Dallas chose the override as the stranded-extension recovery. Lane:
`ext-contract-hours`.

## The defect

`proposals.event_duration_hours` carries two meanings. It is the duration the contract was
PRICED at (the pricing snapshot, `total_price`, and the stored `proposal_addons.quantity`
values were all computed from it), and it is the duration the bar WORKS (event end time, the
2:00 AM curfew gate, shift end times, payroll hours). Before an on-site extension the two are
equal. `settleExtension` (`server/utils/serviceExtensionSettle.js`) moves the second: it
writes `event_duration_hours = requested_duration_hours` on the proposal and the shift, and
deliberately nothing else, because the extension's money lives on its own invoice, off the
contract ledger (spec 2026-07-25, decision D12: extension money is side money, not contract
money).

Every reader that wants the priced duration then reads the worked one. Verified against
code on 2026-09-30:

1. The admin editor's PATCH (`server/routes/proposals/crud.js`) re-prices every save from the
   row's duration and writes `total_price` unconditionally, with no status guard. After a paid
   extension the next save bills the added hours a second time through the contract: hours past
   the 4-hour base at the catalog rate, over-included bartenders, timed add-ons, and a longer
   Gratuity line.
2. `foldExtrasIntoProposal` (`server/utils/proposalExtrasFold.js`) re-prices at the row's
   duration for a drink-plan submit, a lab refresh, and the cancel-line-item fold.
3. `REPRICE_ADDON_SQL` (same file) inverts `proposal_addons.quantity` back to an input count
   by dividing by `p.event_duration_hours`. The stored quantity was computed at the contract
   duration. The inversion rounds (`storedToInputCount`, `Math.max(1, Math.round(raw))`), so
   one additional bartender on a 4h to 5h booking still reads as 1 (4/5 rounds up), but three
   read as 2 (12/5) and two on a 4h to 6h booking read as 1 (8/6). `computeExtensionDelta`
   loads its add-ons through this SQL, so a SECOND extension on such a booking is priced from
   the wrong count today. `lineItemCancel.js` has the same inversion, and on a partial
   removal it WRITES the remaining quantity at the row's hours, which the next read at contract
   hours would undo.
4. `eventCreation.js` (`addonHeadcount`, `deriveStaffingRoster`) derives `positions_needed`
   by dividing the snapshot's add-on quantity by the row's hours, on every shift sync
   (`syncShiftsFromProposal`, called from the PATCH and from `lineItemCancel`). Today a re-save
   re-stores the quantity at worked hours, which makes this right by accident; after the fix
   the quantity stays at contract hours, so the roster would lose a seat (3 bartenders on a 4h
   to 5h booking derive 2). `position` is the money seam for staffing.
5. The admin editor form (`client/src/pages/admin/proposalEditor/formState.js`,
   `recoverAddonQuantities`) inverts from the row's duration for the stepper counts, and its
   live price preview (`POST /proposals/calculate`, stateless) prices the form's duration, so
   the preview shows the double-billed total. A second client caller,
   `client/src/pages/admin/RemoteStaffingFeePrompt.js`, fetches `GET /proposals/:id`, inverts
   at row hours and PATCHes headlessly (pre-booking only in practice, but it saves money).
6. `drinkPlans/lab.js` and `drinkPlans/submit.js` price a lab-chosen add-on with
   `calculateAddonCost(addon, guests, Number(proposal.event_duration_hours))`.
7. `changeRequests.priceProposedState` prices `proposed.event_duration_hours ??
   proposal.event_duration_hours`.

Prod on 2026-09-30: one settled extension (proposal 842, 3h to 4h, paid, `completed`, no
add-ons). Its row reads 4.0 and its snapshot 3; nothing has re-saved it. Nothing is
mis-billed yet.

## The rule

**Contract hours = the row's `event_duration_hours` minus the hours settled extensions
added, and never below the hours the first settled extension found contracted.** Settled
means `status IN SETTLE_OUTCOMES` (`'paid'`, `'overridden'`, exported from
`serviceExtensionSettle.js` and read by every consumer, so a future settle outcome cannot be
missed): an admin override grants the time with no receivable, so the contract must not bill
it either. `expired` and `cancelled` never moved the row and are excluded. The hours an
extension added are `requested_duration_hours - contracted_duration_hours` on its
`service_extensions` row.

The lower bound exists for the hand revert the runbook permits after a refund ("adjust the
event duration by hand"): with the row reverted to 4h and a `paid` row still counted, plain
subtraction would derive 3h and under-price every hourly line. A contract cannot be shorter
than what an extension started from, so the clamp restores 4h. When it binds, Sentry gets a
message with the proposal id and both figures; a result under 0.5h (corrupt data) falls back
to the row's hours with the same alert, never to a silent under-bill. A genuine post-extension
shortening of the contract below the pre-extension hours is priced with an adjustment, not a
duration edit (runbook).

Nothing is stored and nothing is backfilled. The value is derived on read from rows that
already exist. An admin who lengthens a booking in the editor after an extension still adds
contract time, because the row moves and the extension rows do not.

One module owns the rule, `server/utils/contractDuration.js`, and it is JS only (no SQL twin
of the rule to drift):

- `contractHoursFrom(rowHours, settledRows)`: pure, returns `{ hours, clamped, corrupt }`.
- `loadSettledExtensions(db, proposalId)`: one indexed SELECT of the settled rows
  (`idx_service_extensions_proposal_status`). Callers inside a transaction pass their held
  client (one pooled connection per request); preview paths may pass `pool`.
- `contractDurationHours(db, proposalId, rowHours)`: the two above, returning a number, with
  the Sentry report when the clamp or the corrupt fallback binds.
- `SETTLED_EXTENSION_COLUMNS`: two correlated subselects (`COALESCE(SUM(added), 0)` and
  `MIN(contracted)`) for the one query that inverts add-on quantities in SQL; the JS pure
  function then does the arithmetic, so a proposal with no extension rows sums to 0, not NULL.

## Where it applies

| Site | Today | After |
|---|---|---|
| `crud.js` PATCH: `calculateProposal` and `resolveGratuityForPatch` | row hours | contract hours, in a variable named `contractHours`; `workedHours` (the body value or the row) is what the UPDATE stores and what the curfew gate, `syncShiftsFromProposal` and the end-time display read. Two names so a rename cannot cross them. `crud.js` is at 993 lines against a 1000 cap, so the guard and the resolution live in a sibling helper. |
| `proposalExtrasFold.js`: both catalog legs and the final snapshot | row hours | contract hours, loaded on the fold's held client after its `FOR UPDATE` |
| `REPRICE_ADDON_SQL` + `withRepriceQuantities` | divides by `p.event_duration_hours` | selects `SETTLED_EXTENSION_COLUMNS` and inverts at `contractHoursFrom(...)` (this also fixes the second-extension count) |
| `lineItemCancel.js`: reads at the count inversion, the fallback amount, `removableBartenders` (hours-independent, moved for consistency) and the partial-removal WRITE (`remainingCount x effectiveHoursFor`) | row hours | contract hours, one value loaded on its client |
| `eventCreation.js` `deriveStaffingRoster` | divides by row hours | divides by the hours the quantity was priced at: the snapshot's `inputs.durationHours` when present, else contract hours. `syncShiftsFromProposal` and `createEventShifts` compute it and pass it in. |
| `changeRequests.priceProposedState` | proposed or row | takes an optional `settledRows` argument. The change-request callers (`server/routes/clientPortal/changeRequests.js` preview and apply, the admin approval path) load and pass it; the public options and switch routes pass nothing and are byte-identical. |
| `drinkPlans/lab.js`, `drinkPlans/submit.js`: `calculateAddonCost` | row hours | contract hours |
| `POST /proposals/calculate` | body hours | accepts an optional `proposal_id` (positive integer, else ignored; admin-only route). When present, BOTH reads (`computeGratuityBasis` for a draft mandate, and `calculateProposal`) use body hours minus that proposal's settled hours. |
| admin `GET /proposals/:id` (`getOne.js`) | | always emits `settled_extension_hours` (a number, 0 when none) |
| client: `formState.recoverAddonQuantities` callers (`ProposalEditorForm` seeding, `RemoteStaffingFeePrompt`) | row hours | row hours minus `settled_extension_hours ?? 0` |
| client: `ProposalEditorForm` preview | | sends `proposal_id` when editing an existing proposal; shows one hint under the duration field when `settled_extension_hours > 0`: "Includes Xh of on-site extension, billed on its own invoice. The contract prices Yh." |
| `serviceExtensionSweep.js` (two alert strings), `paymentIntentSucceeded.js` (`settle_failed` string) | "settle by hand, bump the duration" | "override the request from the event page; never edit the duration by hand" |
| `serviceExtensionSettle.js` | `SETTLE_OUTCOMES` private | exported |

**A guard on the PATCH.** When a save CHANGES `event_duration_hours` (numeric comparison
against the stored value; the editor sends the field on every save, so presence means
nothing) and a `pending` extension request exists for the proposal, refuse with a
ValidationError keyed `event_duration_hours`: "An extension request is pending for this event.
Override or cancel it from the event page first." Saves that leave the duration alone, including
the start-time or date fix that unblocks a curfew refusal, go through. Reason: settle writes the
row to the request's absolute `requested_duration_hours`, so a duration edit made while a
request is pending is silently overwritten at settle today, and would also break the
subtraction.

**Recovery goes through the row, never through a duration edit (Dallas, 2026-09-30).** A paid
extension the webhook failed to settle (a `pending` row with a `paid` invoice, or a
`settle_failed` alert) is settled with the existing admin override
(`POST /service-extensions/:id/override`): it moves the duration, runs payroll and the staff
greenlight, and its invoice void is a no-op on a paid invoice. Accepted cost: the row reads
`overridden` and the activity log records an amount waived on an extension the client paid.
An admin "settle as paid" action is filed for when this state first occurs. The expired-with-
paid case (a payment landing mid-sweep) has no row to settle: refund the client from Stripe,
or, if the time was served, re-open the row to `pending` by SQL and override it (runbook).

## Not touched, and why

- **Payroll** (`serviceExtensionPayroll.js`, `payrollAccrual`): staff worked the hours; those
  read the worked duration, correctly.
- **Shift end times, the curfew gate, `eventEndInstant`, reminders, the public page's
  displayed time line**: worked hours, correctly.
- **The extension's own delta legs** (`computeExtensionDelta`): a second extension prices from
  the current worked hours to the requested ones, which is right; only its add-on counts
  change, through the SQL fix above.
- **Payment-time gratuity recompute** (`stripeCreateIntent.js`, the
  `payment_intent.succeeded` gratuity apply): both pass the row's hours, but both run only
  under the PAYABLE status guard (`sent`, `viewed`, `accepted`). An extension needs an
  assigned bartender on a shift, which needs a confirmed booking, and no status transition
  leads back to the payable set, so no extension can exist when these run. The one escape is
  the admin-only `PATCH /:id/status?force=true`, accepted. Left alone.
- **Pre-signing pricing** (`public.js`, `publicOptions.js`, `publicSwitch.js`,
  `optionsPricingShared.js`, `thumbtackProposalDraft.js`): no extension can exist before a
  booking. Left alone; `priceProposedState` keeps its public callers byte-identical.
- **`invoiceLifecycle.refreshUnlockedInvoices`**: rebuilds from `total_price`; once
  `total_price` stops moving, it stops moving.
- **The snapshot's `inputs.durationHours`** becomes, by definition, the contract hours.
  Nothing compares it to the row (grep verified). Three surfaces DISPLAY it: the package
  includes copy (`{hours}`) on the public proposal page, `ProposalDetail` and
  `EventDetailPage`, and the per-hour breakdown labels. After the first re-save an extended
  5h event reads "4 hours of service" in the includes copy beside a 5h time line. Intended:
  the package includes four hours; the fifth was bought on its own invoice.
- **The mobile admin** reads `GET /proposals/:id` through `offlineGet`; the new field is
  additive and needs nothing today. ma-e3 (the edit sheet) must send `proposal_id` to
  `/calculate` and subtract on its stepper recovery; named here so it is not re-lost.

## Tests

Pure (`contractDuration.test.js`): no extensions; one paid; two paid; one overridden; a
cancelled and an expired one excluded; pg NUMERIC strings; the clamp (row reverted below the
first contracted hours restores them and reports `clamped`); a result under 0.5h reports
`corrupt` and returns the row hours; a status outside `SETTLE_OUTCOMES` is ignored.

Database-backed. Fixture A: booked Core Reaction, 4h, THREE additional bartenders (stored
quantity 12), one `paid` extension row 4h to 5h, row at 5.0, one shift. Fixture B: the 606
shape, hosted with `total_price_override` set, `paid` extension. Fixture C: Core Reaction with
a `gratuity_floor_rate` mandate and an `overridden` extension. Fixture Z: no extension rows.

- PATCH of a venue field on A, B, C: `total_price`, `total_price_override`, the Gratuity line
  and `pricing_snapshot.inputs.durationHours` unchanged (a SQL sum that counted `pending`, or
  that listed only `paid`, fails on C).
- PATCH `event_duration_hours` 6 on A: the row and the shift store 6, the snapshot says 5,
  the total rises by exactly one catalog hour, the curfew gate evaluated at 6.
- PATCH duration with a `pending` row present (full editor body): refused, key
  `event_duration_hours`; the same body with the duration unchanged is not refused and leaves
  the total alone.
- `loadRepriceAddons` on A returns the additional-bartender count 3, not 2; on Z the counts
  are unchanged from today.
- `computeExtensionDelta` on A for a second extension 5h to 6h: the staffing delta is three
  bartender-hours, not two.
- `foldExtrasIntoProposal` on A with no extras change: total unchanged.
- `lineItemCancel` on A: preview offers the bartender line at count 3; executing a partial
  removal of 1 stores quantity 8 (2 x 4 contract hours), reads back as 2, and refunds one
  bartender's contract hours.
- `syncShiftsFromProposal` on A: the roster carries 3 additional bartenders, not 2.
- `POST /proposals/calculate` with `proposal_id` A and `duration_hours: 5`, with and without
  a draft mandate: equals the saved total and rate; without `proposal_id` it prices 5 hours; a
  garbage `proposal_id` is ignored, not a 500.
- `GET /proposals/:id` carries `settled_extension_hours: 1` on A and `0` on Z.
- `priceProposedState` without the argument makes no `service_extensions` query (pure call
  with a counting fake client).

Client (jest): `recoverAddonQuantities` with the subtracted hours inverts 12 to 3; the editor
preview body carries `proposal_id` when editing and not when creating; the hint renders only
when `settled_extension_hours > 0`.

## Docs

`ARCHITECTURE.md` (the rule, under the service extension section), `README.md` folder tree
(new util), `PRICING.md` (one paragraph: the contract prices contract hours; an extension
never moves the contract total), `docs/ops-runbook.md` (the "leave the editor alone" warning
comes out; the refund section's "adjust the event duration by hand" gains the clamp's meaning;
a recovery recipe for a stranded paid extension replaces every "bump by hand"), the fix-list
entry (deleted when this ships), and a new fix-list entry for the admin "settle as paid" action.

## Review level

`crud.js` is the proposal money route and `proposalExtrasFold.js` and `lineItemCancel.js`
are money paths; `paymentIntentSucceeded.js` gets a string change: full fleet on the lane
before merge, second opinion at push.

## Edges accepted

- A paid extension that is later refunded by hand keeps `status = 'paid'` (refunds are manual
  and off-ledger by design), so its hours stay out of the contract. Correct: the time was
  worked and was billed once. If the admin also reverts the duration, the clamp holds the
  contract at the pre-extension hours.
- A multi-shift event: settle moves the proposal's duration but not any shift; the
  subtraction is unaffected.
- The rule reads `service_extensions`; a proposal with none costs one indexed SELECT per
  re-price, on admin and drink-plan paths only. No public-page cost.
- A settled extension followed by `lineItemCancel` removing the additional-bartender line the
  extension's own delta priced: the contract refunds the contract hours; the extension invoice
  keeps its bartender-hour (extension refunds are manual by design). Accepted.
- A client change request filed before an extension whose proposed duration equals the
  post-extension row applies as a no-op on the row. Rare; accepted.
- The guard refuses a duration edit while a request is pending; the request is settled by
  override or cancelled first. The sweep can expire it underneath, after which the edit goes
  through and the expired row is excluded, correctly.
