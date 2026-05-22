# Venue Name Smart Search (Google Places) — Design

**Date:** 2026-05-22
**Status:** Approved (design)
**Builds on:** `docs/superpowers/specs/2026-05-15-venue-address-design.md`

## Summary

The venue-address feature already collects a structured address (`venue_name`,
`venue_street`, `venue_city`, `venue_state`, `venue_zip`) on `proposals`. Today
`venue_name` is a plain text field. This feature turns it into a **typeahead
search** backed by Google Places: a client or admin types a venue name, gets
live suggestions from Google's global place index, and on selecting one the
address fields auto-fill.

The search is a convenience layer over a field that stays plain free text.
Selecting a suggestion is always optional. If the typed text is not a real
listed place (a made-up label like "The Smith Residence" for someone's home),
nothing matches and the user simply keeps their text and fills the address by
hand, exactly as today.

## Goals

- `venue_name` becomes a typeahead. Suggestions come from Google Places, not
  from Dr. Bartender's own bookings.
- Each suggestion row shows the venue name plus its full address, so venues
  with similar names are easy to tell apart.
- Selecting a suggestion auto-fills the structured address fields.
- The field remains plain free text. No selection is ever required.
- The search appears on every surface with a venue-name field: the quote
  wizard, the proposal sign + pay gate, and the admin proposal create/edit
  forms, through one shared component.
- In the quote wizard, selecting a venue silently captures the full street
  address (street and zip included, even though the wizard never shows a street
  field). That booking then reaches sign + pay already address-complete and the
  client is not asked for the address again.
- The feature is purely additive. If Google is unreachable or the API key is
  unset, the field degrades to a plain text input and no form is blocked.

## Non-goals (explicit scope decisions)

- **No internal venue catalog.** Suggestions are not drawn from past proposals.
  An external index is what lets clients find venues Dr. Bartender has never
  worked, and it removes both the cold-start problem and the risk of exposing a
  past client's home address.
- **No `venues` table and no schema change.** The five `venue_*` columns
  already exist on `proposals`.
- **No client-side Google key.** See Integration Approach below.
- **No `place_id` storage.** Only the resolved address fields are persisted.
  Storing `place_id` (for re-geocoding or richer detail later) is a possible
  future enhancement, deliberately deferred.
- **No change to existing geocoding.** `shifts.location` is still geocoded by
  the existing Nominatim util (`server/utils/geocode.js`). Venue search is a
  separate Google integration; the two do not overlap.
- **No autocomplete on the street/city/zip fields.** The search is on the
  venue-name field only.
- **No map or pin-drop UI.**

## Decisions

### Provider: Google Places

Google Places (New) has the best coverage of small, niche US businesses such as
regional wedding barns, which is precisely the case this feature exists for.
Mapbox was considered (lighter signup, comparable free tier) but rejected for
weaker niche-POI coverage. An internal catalog and OpenStreetMap/Nominatim were
both rejected (coverage, cold start, autocomplete ToS).

### Integration approach: server-side proxy

React calls our own `/api/venues/...` endpoints. Express calls Google with a
server-only key and we render the dropdown ourselves.

A client-side Google JS widget was rejected: it places the API key in the
browser bundle (referrer restriction only), and the quote wizard is a fully
public page. The server proxy keeps the key a server secret, allows per-IP
rate limiting, and matches how the codebase already wraps external services
(Stripe through `server/utils/stripeClient.js`).

## Data Model

**No schema change.** `venue_name`, `venue_street`, `venue_city`,
`venue_state`, `venue_zip` already exist on `proposals` (added by the
venue-address feature). This feature only changes how those columns get
populated. In particular, the quote wizard begins writing `venue_street` and
`venue_zip`, which it previously always left `NULL`.

## Backend

### `server/utils/googlePlaces.js` (new)

Wraps the two Google Places (New) calls. Reads `GOOGLE_PLACES_API_KEY`. Pure
proxy, no DB access. Fails soft on every error path: returns `[]` or `null`,
never throws. This is what makes the front-end degrade gracefully.

`isConfigured()` returns whether `GOOGLE_PLACES_API_KEY` is set.

`searchVenues(input, sessionToken)`:
- Returns `[]` immediately when not configured, or when `input` trimmed is
  under 3 characters.
- `POST https://places.googleapis.com/v1/places:autocomplete`
  - Headers: `Content-Type: application/json`, `X-Goog-Api-Key: <key>`
  - Body: `{ input, sessionToken, includedRegionCodes: ["us"],
    locationBias: { rectangle: REGION_RECTANGLE } }`
  - `REGION_RECTANGLE` is a coarse bounding box over the five service-area
    states: `low { latitude: 36.95, longitude: -97.3 }`,
    `high { latitude: 49.4, longitude: -82.0 }`. `locationBias` biases results
    toward that box; the `VENUE_STATES` allowlist in `mapPlaceToVenue` is the
    precise gate for what counts as in service area.
- From the response `suggestions` array, keep only entries with a
  `placePrediction` (ignore `queryPrediction`). Map each to
  `{ placeId, name, address }` where `name` is
  `placePrediction.structuredFormat.mainText.text` and `address` is
  `placePrediction.structuredFormat.secondaryText.text` (fall back to
  `placePrediction.text.text`).
- On a non-OK response or any thrown error, return `[]`.

`getVenueDetails(placeId, sessionToken)`:
- Returns `null` when not configured or `placeId` is missing.
- `GET https://places.googleapis.com/v1/places/{placeId}?sessionToken=<token>`
  - Headers: `X-Goog-Api-Key: <key>`,
    `X-Goog-FieldMask: addressComponents,displayName` (minimal mask keeps the
    Place Details call in the cheaper SKU tier).
- Maps `addressComponents` (each `{ longText, shortText, types }`) into the
  structured venue:
  - `venue_street`: `street_number.longText` plus `route.longText`, joined by a
    space. Empty if `route` is absent.
  - `venue_city`: `locality.longText`, falling back to `postal_town` then
    `sublocality_level_1`.
  - `venue_state`: `administrative_area_level_1.longText` (full state name,
    e.g. "Illinois", to match the `venue_state` storage format).
  - `venue_zip`: `postal_code.longText`.
  - `venue_name`: `displayName.text`.
- **Service-area guard:** if the resolved `venue_state` is not one of the five
  allowed states (`VENUE_STATES` in `server/utils/venueAddress.js`), return only
  `{ venue_name }` with the other fields empty. An out-of-area venue contributes
  its name but no address. This keeps the wizard's five-option state select and
  the `validateVenue` allowlist from ever receiving an invalid state.
- On a non-OK response or any thrown error, return `null`.

The exact Google request and response field names should be confirmed against
the current Places API (New) documentation at implementation time.

### `server/routes/venues.js` (new)

An Express router, one resource file per the project convention. Mounted in
`server/index.js` as `app.use('/api/venues', venuesRouter)`.

- `GET /api/venues/search?q=<text>&token=<sessionToken>`
  - Returns `{ results: [...] }` from `searchVenues`. A short or missing `q`
    yields `{ results: [] }` with a 200. Absence of matches is a normal
    outcome, so no `AppError` is thrown.
- `GET /api/venues/details/:placeId?token=<sessionToken>`
  - Returns `{ venue: {...} | null }` from `getVenueDetails`.

Both handlers are wrapped in `asyncHandler`. Both are **unauthenticated**: the
quote wizard is public and no proposal token exists at that stage. The
endpoints are a thin proxy that exposes nothing sensitive (only Google place
suggestions). Server-side input hardening: `q` and `placeId` are coerced to
strings and length-capped (for example `q` to 200 characters) before use.

### Cost and abuse controls

- **Session token.** The client generates a UUID (`crypto.randomUUID()`) when a
  search begins and reuses it across keystrokes, sending it on every
  autocomplete request and on the final details request. Google then bills the
  whole search as one bundled session rather than per keystroke. A fresh token
  is generated after each selection.
- **Debounce and minimum length.** The component fires a request only after a
  250 ms typing pause and only at 3 or more characters.
- **Rate limiting.** A new per-IP limiter in `server/middleware/rateLimiters.js`
  (suggested `windowMs: 60000, max: 60`) guards both endpoints. A real search
  is well under that; the ceiling curbs scripted abuse.
- **Operational.** A daily quota cap should be set on the Google key in the
  Google Cloud console so worst-case spend is bounded regardless of traffic.
  At Dr. Bartender's quote volume, usage is expected to stay within Google's
  free tier.

### Environment variable

`GOOGLE_PLACES_API_KEY` (new). Added to `.env.example`, the CLAUDE.md
environment table, and the README environment table. The server proxy fails
soft when it is unset, so a missing key never breaks a form, it only disables
the suggestions.

## Shared Component: `client/src/components/VenueSearchInput.js` (new)

One controlled, self-contained typeahead. It owns its transient state
(suggestions, open/closed, keyboard highlight, loading, session token); parents
deal only with the value and two callbacks.

Props:
- `value` (string): the current venue name.
- `onChange(name)`: called on every keystroke with the raw text.
- `onSelect(venue)`: called when a suggestion is chosen, with the structured
  object `{ venue_name, venue_street, venue_city, venue_state, venue_zip }`.
  Out-of-area venues arrive here as name-only per the service-area guard.
- Passthrough props for wiring and styling: `id`, `inputClassName`,
  `placeholder`, `disabled`, `ariaInvalid`.

Behavior:
- API calls go through `client/src/utils/api.js` (the shared axios instance),
  per project convention. The endpoints are public, so the absence of a JWT on
  the wizard is fine.
- On keystroke: call `onChange(text)`, open the dropdown, and after a 250 ms
  debounce, if the text is 3 or more characters, request
  `/venues/search?q=<text>&token=<sessionToken>`. An `AbortController` (or a
  request sequence id) discards stale responses so a slow earlier request
  cannot overwrite a newer one.
- Dropdown: render a `<ul>` mirroring the existing event-type autocomplete
  (`wz-event-type-dropdown`). Each row shows the venue name in bold with its
  full address beneath it. New CSS classes (for example `venue-search-dropdown`,
  `venue-search-option`) are added to `index.css`, modeled on the event-type
  classes.
- Keyboard navigation: Up and Down move the highlight, Enter selects the
  highlighted row, Escape closes. A click outside closes the dropdown. This
  mirrors `handleEventTypeKeyDown` in the quote wizard.
- On select: request `/venues/details/:placeId?token=<sessionToken>`, then call
  `onSelect(venue)`, set the input to the venue name, close the dropdown, and
  regenerate the session token.
- Graceful degradation: if `/venues/search` returns an empty list (key unset,
  Google error, or genuinely no matches), the dropdown simply does not appear.
  No error UI. The user keeps typing and the field behaves as plain text.

The component is generic. It never decides what a selection means for a given
surface; each parent does that in its `onSelect` handler.

## Surface 1: Quote Wizard

Files: `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js`,
`client/src/pages/website/quoteWizard/QuoteWizard.js`,
`server/routes/proposals/public.js`.

- `QuoteWizard.js`: the default form state gains `venue_street` and
  `venue_zip` (default `''`). City and state already exist as `event_city` /
  `event_state`.
- `EventDetailsStep.js`: the plain `wz-venue_name` input is replaced with
  `VenueSearchInput`.
  - `onChange(name)`: `update('venue_name', name)` and **clear** `venue_street`
    and `venue_zip`. Any manual edit of the name drops a previously captured
    address, so a wizard proposal never stores a street that does not match the
    name shown. City and state are left alone, since they are visible wizard
    fields the client owns.
  - `onSelect(venue)`: one functional `setForm` merge. Set `venue_name`,
    `venue_street`, `venue_zip`, and overwrite `event_city` / `event_state`
    from the venue (the venue is the authoritative location), but only set a
    wizard field when the venue provides a non-empty value for it. An
    out-of-area venue arrives name-only, so only `venue_name` changes.
- `QuoteWizard.js`: the submit payload adds `venue_street` and `venue_zip` when
  present.
- `public.js` (`POST /api/proposals/public/submit`): accept `venue_street` and
  `venue_zip`. Validate with the shared `validateVenue` at the wizard tier
  (street still not required; when present it is length-checked, and zip is
  format-checked). Store both columns in the INSERT and recompose
  `event_location` with `composeVenueLocation`, which already includes street
  when present.

Result: a wizard proposal where the client selected a venue now has
`venue_street`, `venue_city`, and `venue_state` populated, so `isVenueComplete`
is true. At sign + pay the existing `venue_complete` path shows the address
read-only and does not ask again. A wizard proposal with no selection is
unchanged from today: name only, `venue_street`/`venue_zip` `NULL`, address
collected at sign + pay.

## Surface 2: Proposal Sign + Pay

Files: `client/src/components/VenueAddressFields.js`,
`client/src/pages/proposal/proposalView/SignAndPaySection.js`,
`client/src/pages/proposal/proposalView/ProposalView.js`.

- `VenueAddressFields.js`: the plain venue-name `<input>` is replaced with
  `VenueSearchInput`. `VenueAddressFields` keeps its existing
  `onChange(field, value)` prop and gains no new prop.
  - `VenueSearchInput`'s `onChange` maps to `onChange('venue_name', name)`.
    Editing the name here does not clear the other fields: at sign + pay and
    admin all five fields are visible and independently editable, so clearing
    them on a name edit would be surprising.
  - `VenueSearchInput`'s `onSelect` is handled inside `VenueAddressFields` by an
    `applyVenue` helper that calls `onChange(field, value)` once for each
    `venue_*` field the result contains.
- `venue_complete === true` (the wizard already captured a full address): the
  existing read-only confirmation shows, unchanged. The search is not needed.
- `venue_complete === false`: `VenueAddressFields` renders as today but the name
  field is now a search. Selecting a venue fills street, city, state, and zip at
  once, the gate-tier validation passes, and the sign and deposit controls
  enable. Manual entry still works for a venue with no Google match.

## Surface 3: Admin

Files: `client/src/pages/admin/ProposalCreate.js`,
`client/src/pages/admin/ProposalDetailEditForm.js`,
`client/src/pages/admin/EventEditForm.js`.

All three already use `VenueAddressFields`, so they get the search the moment
`VenueAddressFields` embeds `VenueSearchInput`. They need no change: each
already passes `value` and a functional `onChange(field, value)`, which is
exactly what the `applyVenue` helper inside `VenueAddressFields` reuses. The
existing admin endpoints (`POST` for create, `PATCH /api/proposals/:id`) already
accept all five `venue_*` keys, so no admin-side server change is needed.

### Multi-field update on selection

A selection sets up to five fields. The `applyVenue` helper inside
`VenueAddressFields` calls the parent `onChange(field, value)` once per field.
This is safe because all four `VenueAddressFields` consumers
(`SignAndPaySection`, `ProposalCreate`, `ProposalDetailEditForm`,
`EventEditForm`) implement `onChange` with a functional `setState`
(`setX(prev => ({ ...prev, [field]: value }))`), so the sequential calls within
one handler do not race. The quote wizard's `EventDetailsStep` is not a
`VenueAddressFields` consumer; it handles a selection with its own single
functional `setForm` merge.

## Edge Cases and Known Limitations

- **Edit the name after selecting.** Wizard: `onChange` clears the silently
  captured `venue_street` and `venue_zip`. Sign + pay and admin: all fields are
  visible, so a name edit changes only the name.
- **Out-of-area venue.** The bounding box is coarse and can include slivers of
  neighboring states. The service-area guard in `getVenueDetails` returns such a
  venue as name-only, so the address fields and the five-option state selects
  never receive an unsupported state. The user fills the address manually.
- **No street in the Google result.** Some places resolve without a
  `street_number`/`route`. `venue_street` is then empty, `isVenueComplete` stays
  false, and sign + pay still asks for the street. Correct behavior.
- **No selection at all.** Identical to today: free text name, manual address.
- **API key unset or Google down.** The field is a plain text input. All forms
  still submit. No error is shown to the user.
- **Rate limit hit.** `/api/venues/search` returns 429; the component shows no
  dropdown and the field stays usable as plain text.

## Downstream Impact

- `event_location` is recomposed by `composeVenueLocation` on wizard submit and
  on the existing admin and sign routes. It only becomes more complete. No
  consumer of `event_location` or `shifts.location` needs a change; this was
  already established by the venue-address feature.
- `shifts.location` is built from the proposal's structured fields at deposit.
  More wizard proposals will now carry a real street, so the existing Nominatim
  geocode of `shifts.location` resolves more accurately. No code change.
- No new columns, no migration.

## Testing

- Autocomplete: typing 3 or more characters shows suggestions, each row shows
  name plus full address; keyboard navigation and click both select.
- Wizard, with selection: `venue_name`, `venue_street`, `venue_city`,
  `venue_state`, `venue_zip` are stored; `event_location` includes the street;
  sign + pay shows the address read-only (`venue_complete` true).
- Wizard, free text with no selection: only `venue_name` stored;
  `venue_street`/`venue_zip` `NULL`; sign + pay asks for the address as today.
- Wizard: editing the name after a selection clears `venue_street`/`venue_zip`.
- Sign + pay, `venue_complete` false: selecting a venue fills all five fields,
  gate validation passes, sign and deposit controls enable.
- Admin create and edit: selecting a venue fills all five fields and a save
  persists them.
- Out-of-area venue: only the name is applied.
- `GOOGLE_PLACES_API_KEY` unset: the field works as plain text, no dropdown, no
  errors, every form still submits.
- `public.js` server validation rejects a malformed `venue_zip` and an
  over-length `venue_street`.
- Rate limit: requests past the per-IP ceiling return 429 and the component
  degrades quietly.

## Documentation Updates (per CLAUDE.md mandatory table)

- **CLAUDE.md:** add `GOOGLE_PLACES_API_KEY` to the environment table; add
  Google Places to the Tech Stack list.
- **README.md:** add `GOOGLE_PLACES_API_KEY` to the environment table; add
  `server/routes/venues.js`, `server/utils/googlePlaces.js`, and
  `client/src/components/VenueSearchInput.js` to the folder tree.
- **ARCHITECTURE.md:** add `/api/venues/search` and `/api/venues/details` to the
  route table; mention `googlePlaces.js`; add Google Places under Third-Party
  Integrations.
- **`.env.example`:** add `GOOGLE_PLACES_API_KEY`.

## File Inventory

New: `server/utils/googlePlaces.js`, `server/routes/venues.js`,
`client/src/components/VenueSearchInput.js`.

Modified: `server/index.js` (mount route), `server/middleware/rateLimiters.js`
(new limiter), `server/routes/proposals/public.js` (accept/validate/store
`venue_street` and `venue_zip`), `client/src/components/VenueAddressFields.js`
(embed search), `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js`
and `client/src/pages/website/quoteWizard/QuoteWizard.js` (wizard search and
silent capture), `client/src/index.css` (dropdown styles), `.env.example`,
`CLAUDE.md`, `README.md`, `ARCHITECTURE.md`.

`SignAndPaySection.js`, `ProposalCreate.js`, `ProposalDetailEditForm.js`, and
`EventEditForm.js` are deliberately not modified: embedding `VenueSearchInput`
inside the shared `VenueAddressFields` gives all four surfaces the search with
no parent change.

## Out of Scope

Internal venue catalog; `venues` table; client-side Google key; `place_id`
storage; replacing Nominatim geocoding; street/city/zip field autocomplete;
map or pin-drop UI. Recorded here so the implementation plan does not
reintroduce them.
