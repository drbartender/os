# Venue Address Collection — Design

**Date:** 2026-05-15
**Status:** Approved (design)

## Summary

We need the client's full street venue address for every booked event. Today we
only capture a freeform `proposals.event_location` (typically just `"City, State"`
from the quote wizard or an admin-typed Thumbtack value). The proposal stage does
not need the full address — city/state is adequate for pricing and preview. Once
the client books, staff are dispatched to the venue, so the real address is
required.

**Decision:** collect a structured venue address (optional venue name + street +
city + state + ZIP). The **street address is collected only at the sign + pay
step**, where it is **required** — the booking cannot complete without it. The
quote wizard collects only the optional **venue name** plus the **city/state**
that are already required there today. The street field is intentionally **not**
in the wizard.

### Why street is checkout-only (client-perspective rationale — load-bearing)

From the client's seat, the quote wizard is the *shopping* stage: they haven't
hired anyone and are comparing vendors. Asking for a full street address just to
get a price reads as a premature data grab and trips a privacy instinct,
especially for at-home events. City/state feels fine (obviously needed to price
travel) and the *venue name* feels fine — even fun (a booked venue is a point of
pride). Sign + pay is the opposite: the client has chosen the vendor and is
already entering legal name, signature, and a credit card. In that context "where
is your event?" is the expected delivery-address-at-checkout moment and adds
almost no perceived friction. **Do not reintroduce a street field into the quote
wizard** — its absence there is a deliberate UX decision, not an oversight.

## Goals

- Capture a structured venue address: `venue_name` (optional), `venue_street`,
  `venue_city`, `venue_state`, `venue_zip` (optional).
- Quote wizard: collect only `venue_name` (optional) + `venue_city`/`venue_state`
  (required, exactly as today). No street/ZIP ask during shopping.
- A hard requirement for `venue_street` (+ city/state) at sign + pay — enforced
  client-side **and** server-side.
- Every existing consumer of location data (public proposal view, PDF, emails,
  `shifts.location`, staff SMS, geocoding) keeps working with a now-complete
  address and no structural change.
- Admin can enter/correct the structured address (Thumbtack / phone bookings).

## Non-goals (explicit scope decisions)

- **No** street field in the quote wizard (deliberate — see rationale above).
- **No** post-deposit reminder scheduler chasing missing addresses.
- **No** hard gate on the auto-assign scheduler.
- **No** hard block on the admin manual-confirm path
  (`PATCH /api/proposals/:id/status` → `confirmed`). Admin-confirmed events that
  never went through client sign + pay rely on the admin having entered the
  address; this is an accepted gap (see Known Limitations).
- **No** street autocomplete/geocode-on-type in v1 (possible later enhancement).

## Data Model

`server/db/schema.sql`, `proposals` table (currently defined ~lines 771–793,
only `event_location TEXT`). Add idempotently:

```sql
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_name   TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_street  TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_city    TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_state   TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_zip     TEXT;
```

`event_location TEXT` is **kept** and becomes a **derived display string**
composed from the structured fields (see Composition Rule). It remains the field
every existing consumer reads, so nothing downstream needs structural change.
`venue_state` stores the full state name exactly as the wizard dropdown supplies
it (e.g. `"Illinois"`), matching the existing `event_location` format — no
abbreviation mapping is introduced. `venue_street`/`venue_zip` stay `NULL` for a
proposal until the client reaches sign + pay (or an admin fills them in).

No structured columns are added to `shifts`. `shifts.location` (existing
`VARCHAR(500)`) continues to be the single string staff-facing code reads;
`createEventShifts` composes it from the proposal's structured fields.

## API Contract

All booking endpoints that accept venue data use these snake_case JSON keys
(per project naming convention):

```
venue_name   (string, optional, max 200)
venue_street (string, max 200)
venue_city   (string, max 120)
venue_state  (string, one of: Illinois, Indiana, Michigan, Minnesota, Wisconsin)
venue_zip    (string, optional, /^\d{5}(-\d{4})?$/)
```

**Validation tiers** (client- and server-side, kept in sync):

| Field        | Quote wizard      | Sign + pay gate |
|--------------|-------------------|-----------------|
| venue_name   | optional (shown)  | optional (shown)|
| venue_city   | required          | required        |
| venue_state  | required          | required        |
| venue_street | not collected     | **required**    |
| venue_zip    | not collected     | optional        |

`venue_city`/`venue_state` requirement in the wizard exactly preserves today's
behavior (they are already required there). ZIP is optional everywhere it is
shown. Server-side validation mirrors the client rules on every endpoint;
`venue_state` is validated against the same allowed-state list the dropdown uses.

## Shared Component

`client/src/components/VenueAddressFields.js` (new). One controlled component
rendering, in order: Venue name *(optional)* · Street · City · State (the
existing 5-state `<select>`, reused) · ZIP. Props:

- `showStreet` / `showZip` (bool) — field visibility. Wizard passes both
  `false` (renders only Venue name + City + State); the sign + pay gate and
  admin pass both `true`.
- `requireStreet` (bool) — when `true` (sign + pay gate) the component enforces a
  non-empty street; `false` for wizard and admin.
- value + `onChange` for the structured fields.

City/State are always rendered and treated as required wherever the component is
used at a client surface; one component + props keeps markup and validation in
sync across all surfaces. This replaces the single freeform `LocationInput`
usage for venue entry. `LocationInput.js` stays in the repo for any other
callers but is no longer used for venue address.

## Surface 1 — Quote Wizard (venue name only)

Files: `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js`,
`client/src/pages/website/quoteWizard/QuoteWizard.js` (submit payload ~581–631;
required-field validation ~520–521),
`client/src/pages/website/quoteWizard/helpers.js` (`defaultForm` / `steps`),
`server/routes/proposals/public.js`
(`POST /api/proposals/public/submit`, INSERT ~329–342).

- `EventDetailsStep` renders `VenueAddressFields` with
  `showStreet={false} showZip={false}` → only Venue name (optional) + City +
  State. City/State keep today's required validation, unchanged. No street/ZIP
  ask here.
- `helpers.js` `defaultForm` gains `venue_name` only (city/state already present
  as `event_city`/`event_state`; reuse those values for
  `venue_city`/`venue_state`).
- `QuoteWizard.js` submit stops sending the pre-joined
  `event_location: "City, State"` and instead sends `venue_name`, `venue_city`,
  `venue_state` (no `venue_street`/`venue_zip` from the wizard).
- `public.js` submit handler reads those keys, validates (wizard tier), stores
  `venue_name`/`venue_city`/`venue_state` (street/zip remain `NULL`), and sets
  `event_location` via the Composition Rule.

## Surface 2 — Proposal Sign + Pay (the required gate)

Files: `server/routes/proposals/publicToken.js`
(`GET /t/:token` ~19–89, `POST /t/:token/sign` ~94–180),
`server/routes/stripe.js` (`POST /create-intent/:token`),
`client/src/pages/proposal/proposalView/ProposalView.js`,
`client/src/pages/proposal/proposalView/SignAndPaySection.js`,
`client/src/pages/proposal/proposalView/ProposalHeader.js` (displays
`event_location` ~54–59).

- `GET /t/:token` returns the structured `venue_*` values and a boolean
  `venue_complete` (true when `venue_street`, `venue_city`, `venue_state` are all
  present — ZIP and venue name are **not** required for completeness).
- `SignAndPaySection`:
  - `venue_complete === true` → render the address read-only as a confirmation
    line with a small "edit" affordance. No friction.
  - `venue_complete === false` → render `VenueAddressFields` with
    `showStreet showZip requireStreet`. Any `venue_name` captured in the wizard
    is prefilled. The signature submit control and the deposit/pay control are
    disabled until gate-tier validation passes (street + city + state present;
    ZIP optional).
- `POST /t/:token/sign` accepts the `venue_*` keys. **Server-side**: if the
  proposal does not already have a complete venue address, the submitted address
  is validated at the gate tier and street/city/state are **required** — reject
  the signature with a `ValidationError` if absent/invalid. On success, persist
  the structured fields and recompute `event_location`.
- `POST /create-intent/:token` re-checks (defense in depth): refuse to create a
  payment intent if the proposal still lacks street/city/state. Since the shift
  is created at `deposit_paid` (Stripe webhook → `createEventShifts`), the
  address is guaranteed present on the proposal before any shift exists.

## Surface 3 — Admin Edit + Shift Sync

Files: `client/src/pages/admin/ProposalDetailEditForm.js` (currently binds
`LocationInput` to `event_location` ~301–302, init ~525, PATCH payload ~169),
`server/routes/proposals/crud.js` (`PATCH /api/proposals/:id` ~238–312),
`server/utils/eventCreation.js`.

- Replace the single `LocationInput` with `VenueAddressFields`
  (`showStreet showZip`, no `requireStreet` — admin is trusted and may
  legitimately save a partial address for an early-stage proposal).
- `PATCH /api/proposals/:id` accepts the `venue_*` keys, validates types/formats
  (state against allowed list, zip format) but does not hard-require street for
  admin, persists them, and recomputes `event_location`.
- **Cross-cutting sync (per CLAUDE.md):** when a venue field changes on a
  proposal that already has linked shifts, update each linked shift's
  `location` (recomposed) and set its `lat`/`lng` to `NULL` so the existing
  geocode path (`server/routes/shifts.js` ~649–660) re-resolves coordinates.
  This closes the current gap where proposal-location edits silently do not
  reach shifts.

## Composition Rule

A single shared helper composes the display/location string from structured
fields. Used by the wizard submit, the sign route, the admin PATCH, and
`createEventShifts`. Implement once in `server/utils/` (e.g.
`composeVenueLocation({ venue_name, venue_street, venue_city, venue_state, venue_zip })`)
and mirror in the client only if needed for live preview.

Rule: join the non-empty parts —
`[venue_name, venue_street, "<city>, <state><space><zip>"]`. Examples:

- Full (post sign + pay): `"Citadel Banquet Hall, 123 Main St, Chicago, Illinois 60601"`
- Wizard with venue name, no street: `"Citadel Banquet Hall, Chicago, Illinois"`
- City/state only (legacy / no name): `"Chicago, Illinois"` — byte-identical to
  today's behavior, so legacy proposals and any admin-typed city/state values
  are unaffected.

`createEventShifts` (`server/utils/eventCreation.js` ~88–149, INSERT ~122–138):
set `shifts.location` from the composed structured address; fall back to the
proposal's existing `event_location` when no structured data is present (legacy
/ admin-confirmed proposals).

## Downstream Impact

`event_location` and `shifts.location` remain the strings every consumer reads;
they just become more complete. Verified consumers (no structural change
expected — re-confirm during implementation that none parse the string by
splitting on `", "` for logic; exploration found none):

- `server/routes/shifts.js` — staff assignment SMS/email (~506–514).
- `server/utils/autoAssign.js` — auto-assign booking message (~295–325).
- `server/utils/emailTemplates.js` — shift confirmation / request-approved
  templates (~306, ~603).
- `client/src/pages/staff/StaffEvents.js` — staff event cards (~63–66).
- `client/src/components/adminos/drawers/ShiftDrawer.js` — shift location
  display (~196).
- Geocoding (`shifts.lat`/`lng`) — accuracy improves automatically with a real
  street address; no new code.
- Public proposal view / `ProposalHeader` and proposal PDF — display the fuller
  composed string; no structural change.

## Edge Cases & Known Limitations

- **Wizard → name + city/state, then sign + pay:** gate detects missing street,
  requires street/city/state at sign (venue name prefilled from wizard); server
  persists and recomposes `event_location`; deposit webhook composes
  `shifts.location`. Works.
- **Thumbtack / phone booking:** admin enters structured fields in
  `ProposalDetailEditForm`. If the client then goes through sign + pay, the gate
  still enforces completeness.
- **Admin manual-confirm without client signature**
  (`PATCH /api/proposals/:id/status` → `confirmed`): no hard block (per
  Non-goals). Shifts are created from `createEventShifts`' fallback
  (`event_location`), which may be only city/state. Accepted gap by explicit
  decision; admin is expected to fill the structured address for these.
- **Autopay balance:** unaffected — the address is on the proposal before the
  deposit, well before any balance activity.
- **State list:** the five-state allowlist is shared by the dropdown and
  server validation; adding a state later is a one-place change.

## Testing

- Quote wizard submits with venue name and without; verify `venue_name`/
  `venue_city`/`venue_state` stored, `venue_street`/`venue_zip` `NULL`, and the
  composed `event_location`. Confirm the wizard never sends street/zip.
- Sign + pay with a proposal missing street: client controls disabled until
  street/city/state valid; `POST /t/:token/sign` rejects missing/invalid address
  server-side; `POST /create-intent/:token` rejects when incomplete. ZIP omitted
  is accepted.
- Sign + pay with a proposal that already has street/city/state: read-only
  confirmation, no friction, sign + deposit proceed.
- Deposit webhook → `createEventShifts`: `shifts.location` equals the composed
  full address; legacy proposal with only `event_location` still falls back
  correctly.
- Admin edits venue on a proposal with existing shifts: linked
  `shifts.location` updates and `lat`/`lng` reset; geocode re-resolves.
- Server-side validation: invalid state, malformed zip, empty required
  (street/city/state at gate) all rejected with `ValidationError`.

## Documentation Updates (per CLAUDE.md mandatory table)

- `ARCHITECTURE.md` — Database Schema section: add the `venue_*` columns to the
  `proposals` table description; note `event_location` is now a composed display
  string. If a `composeVenueLocation` util is added, mention it in the relevant
  section. `README.md` — add `VenueAddressFields` to the components tree.
- No new env vars, npm scripts, or integrations → CLAUDE.md unchanged.

## Out of Scope

Street field in the quote wizard; post-deposit reminder scheduler; auto-assign
hard gate; admin-confirm hard block; street autocomplete/geocode-on-type.
(Recorded here so the implementation plan does not reintroduce them.)
