# Contract hours vs worked hours after an on-site extension

Date: 2026-09-30. Bounded change, brainstormed in chat with Dallas, who approved the
design and asked for a step-back review before the build. Lane: `ext-contract-hours`.

## The defect

`proposals.event_duration_hours` carries two meanings. It is the duration the contract was
PRICED at (the pricing snapshot, `total_price`, and the stored `proposal_addons.quantity`
values were all computed from it), and it is the duration the bar WORKS (event end time, the
2:00 AM curfew gate, shift end times, payroll hours). Before an on-site extension the two are
equal. `settleExtension` (`server/utils/serviceExtensionSettle.js`) moves the second: it
writes `event_duration_hours = requested_duration_hours` on the proposal and the shift, and
deliberately nothing else, because the extension's money lives on its own invoice, off the
contract ledger (spec 2026-07-25, decisions 7 and 14).

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
   duration, so an "additional bartender x4" row on a booking extended from 4h to 5h reads back
   as 0.8 bartenders. `computeExtensionDelta` loads its add-ons through this SQL, so a SECOND
   extension on such a booking is priced from the wrong count today. `lineItemCancel.js` has
   the same inversion.
4. The admin editor form (`client/src/pages/admin/proposalEditor/formState.js`,
   `recoverAddonQuantities`) inverts from the row's duration for the stepper counts, and its
   live price preview (`POST /proposals/calculate`, stateless) prices the form's duration, so
   the preview shows the double-billed total.
5. `drinkPlans/lab.js` and `drinkPlans/submit.js` price a lab-chosen add-on with
   `calculateAddonCost(addon, guests, Number(proposal.event_duration_hours))`.
6. `changeRequests.priceProposedState` prices `proposed.event_duration_hours ??
   proposal.event_duration_hours`.

Prod on 2026-09-30: one settled extension (proposal 842, 3h to 4h, paid, `completed`, no
add-ons). Its row reads 4.0 and its snapshot 3; nothing has re-saved it. Nothing is
mis-billed yet.

## The rule

**Contract hours = the row's `event_duration_hours` minus the hours settled extensions
added.** Settled means `status IN ('paid', 'overridden')`: an admin override grants the time
with no receivable (decision 14), so the contract must not bill it either. `expired` and
`cancelled` never moved the row and are excluded. The hours an extension added are
`requested_duration_hours - contracted_duration_hours` on its `service_extensions` row.

Nothing is stored and nothing is backfilled. The value is derived on read from rows that
already exist. An admin who lengthens a booking in the editor after an extension still adds
contract time, because the row moves and the extension rows do not.

One module owns the rule, `server/utils/contractDuration.js`:

- `subtractSettledExtensions(rowHours, extensionRows)`: pure, tested.
- `contractDurationHours(db, proposalId, rowHours)`: one SELECT over `service_extensions`,
  then the pure function.
- `CONTRACT_DURATION_SQL`: the same subtraction as a SQL expression on an aliased `proposals
  p`, for the one query that inverts add-on quantities inside SQL.

## Where it applies

| Site | Today | After |
|---|---|---|
| `crud.js` PATCH: `dh` for `calculateProposal` and `resolveGratuityForPatch` | row hours | contract hours. The row still STORES the worked hours; the curfew gate, `syncShiftsFromProposal` and the end-time display keep reading the row. |
| `proposalExtrasFold.js`: both catalog legs and the final snapshot | row hours | contract hours |
| `REPRICE_ADDON_SQL` `pa_duration_hours` | `p.event_duration_hours` | `CONTRACT_DURATION_SQL` (this also fixes the second-extension count) |
| `lineItemCancel.js`: `unitCountOf` (2 reads) and its `calculateProposal` | row hours | contract hours |
| `changeRequests.priceProposedState` | proposed or row | proposed or row, minus settled hours |
| `drinkPlans/lab.js`, `drinkPlans/submit.js`: `calculateAddonCost` | row hours | contract hours |
| `POST /proposals/calculate` | body hours | subtracts settled hours when the body carries `proposal_id`; the editor sends it when editing an existing proposal |
| admin `GET /proposals/:id` (`getOne.js`) | | adds `settled_extension_hours` (number, 0 when none) |
| `formState.recoverAddonQuantities` | row hours | row hours minus `settled_extension_hours` |

**A guard on the PATCH.** When a save changes `event_duration_hours` and a `pending`
extension request exists for the proposal, refuse with a ValidationError naming the pending
request. Reason: settle writes the row to the request's absolute `requested_duration_hours`,
so an admin duration edit made while a request is pending is silently overwritten at settle
today, and it would also break the subtraction (the row would have moved by something other
than the extension's delta). Saves that leave the duration alone are unaffected.

## Not touched, and why

- **Payroll** (`serviceExtensionPayroll.js`, `payrollAccrual`): staff worked the hours; those
  read the worked duration, correctly.
- **Shift end times, the curfew gate, `eventEndInstant`, reminders, the public page's
  displayed duration**: worked hours, correctly.
- **The extension's own delta legs** (`computeExtensionDelta`): a second extension prices from
  the current worked hours to the requested ones, which is right; only its add-on counts
  change, through the SQL fix above.
- **Payment-time gratuity recompute** (`stripeCreateIntent.js`, the
  `payment_intent.succeeded` gratuity apply): both pass the row's hours, but both run only
  under the PAYABLE status guard (`sent`, `viewed`, `accepted`). An extension needs an
  assigned bartender on a shift, which needs a confirmed booking, so no extension can exist
  when these run. Left alone; a reviewer disagreeing should say so.
- **Pre-signing pricing** (`public.js`, `publicOptions.js`, `optionsPricingShared.js`,
  `thumbtackProposalDraft.js`): no extension can exist before a booking. Left alone.
- **`invoiceLifecycle.refreshUnlockedInvoices`**: rebuilds from `total_price`; once
  `total_price` stops moving, it stops moving.
- **The snapshot's `inputs.durationHours`** becomes, by definition, the contract hours.
  Nothing compares it to the row (grep verified).

## Tests

Pure (`contractDuration.test.js`): no extensions; one paid; two paid; one overridden; a
declined and an expired one excluded; pg NUMERIC strings; a row shorter than the sum
(corrupt data) floors at 0.5h and warns rather than going negative.

Database-backed, one fixture (booked Core Reaction, 4h, one additional-bartender add-on,
one `paid` extension row 4h to 5h, row at 5.0):

- PATCH of a venue field: `total_price` and `pricing_snapshot.inputs.durationHours` unchanged.
- PATCH `event_duration_hours` 6: total rises by exactly one contract hour (catalog), snapshot
  says 5.
- PATCH duration with a `pending` extension present: refused; a PATCH of the venue is not.
- `foldExtrasIntoProposal` with no extras change: total unchanged.
- `loadRepriceAddons` returns the additional-bartender count 1, not 0.8.
- `computeExtensionDelta` for a second extension 5h to 6h: the staffing delta is one
  bartender-hour, not 0.8 of one.
- `lineItemCancel` preview on the fixture: the bartender line is removable at count 1.
- `POST /proposals/calculate` with `proposal_id` and `duration_hours: 5` equals the saved
  total; without `proposal_id` it prices 5 hours.
- `GET /proposals/:id` carries `settled_extension_hours: 1`.

Client (jest): `recoverAddonQuantities` with `settled_extension_hours` inverts to 1.

## Docs

`ARCHITECTURE.md` (the rule, under the service extension section), `README.md` folder tree
(new util), `PRICING.md` (one paragraph: the contract prices contract hours; an extension
never moves the contract total), `docs/ops-runbook.md` (the "leave the editor alone" warning
comes out), the fix-list entry (deleted when this ships).

## Review level

`crud.js` is the proposal money route and `proposalExtrasFold.js` and `lineItemCancel.js`
are money paths: full fleet on the lane before merge, second opinion at push.

## Edges accepted

- A paid extension that is later refunded by hand keeps `status = 'paid'` (refunds are manual
  and off-ledger by design), so its hours stay out of the contract. Correct: the time was
  worked and was billed once.
- A multi-shift event: settle moves the proposal's duration but not any shift; the
  subtraction is unaffected.
- The rule reads `service_extensions`; a proposal with none costs one indexed SELECT per
  re-price, on admin and drink-plan paths only. No public-page cost.
