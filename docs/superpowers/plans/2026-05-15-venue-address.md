# Venue Address Collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect a structured venue address (optional venue name + street + city + state + optional ZIP) — optional venue name in the quote wizard, street **required at the sign + pay step** — and feed the composed address into the existing `event_location` / `shifts.location` pipeline.

**Architecture:** A single server util (`server/utils/venueAddress.js`) owns composition + validation. New `venue_*` columns on `proposals` are the source of truth; `event_location` becomes a derived display string composed from them, so every existing consumer (proposal view, PDF, emails, `shifts.location`, staff SMS, geocoding) keeps working untouched. A new client component `VenueAddressFields` is used at the sign + pay gate and the admin edit form. The quote wizard only gains one optional "Venue name" input (see Deviation 1).

**Tech Stack:** Node 18 / Express, raw `pg` SQL, React 18 (CRA), vanilla CSS, `asyncHandler` + `AppError`/`ValidationError`, Stripe, axios via `BASE_URL`.

---

## Project-specific execution notes (read first)

- **No unit-test harness exists.** The only automated check is `npm run lint` (ESLint over `server/`). Per `.claude/CLAUDE.md`, verification = lint + manual app testing + the 5 pre-push review agents (those agents are user-triggered at push time and are NOT part of this plan). Each task below ends with `npm run lint` (when it touches `server/`) and a concrete manual verification, instead of unit tests. This is a deliberate adaptation of the writing-plans TDD default to this repo's actual workflow (user instructions outrank the skill's default).
- **Commit cadence follows CLAUDE.md, not per-task.** CLAUDE.md Rule 3: commits are finished work grouped by *logical feature*, user-cued. Do **not** commit after every task. Commit at the labelled **COMMIT CHECKPOINT**s only, and only after the user gives a commit cue. Never push (push is explicit-only, user-initiated).
- **Explicit staging only** (`git add <specific paths>`), never `git add .`/`-A`.
- **Max reasoning effort**: this crosses schema → routes → frontend and touches the payment/booking path. Treat every cross-layer edit carefully.

### Deviation 1 from spec (intentional, flagged for user)

The spec's "Shared Component" section says the wizard passes `VenueAddressFields` with `showStreet={false}`. In practice the wizard's City/State are bespoke inline inputs wired to its `fieldClass`/`inputClass`/`fieldErrors`/`FieldError` + draft-resume machinery. Swapping them for the shared component risks regressing wizard validation and the resume/restore flow for **zero user-visible benefit**. So: **the wizard only gains one optional "Venue name" inline input** (same pattern as its existing inputs). `VenueAddressFields` is used at the sign + pay gate and admin form only. Spec intent (optional venue name captured in the wizard; structured component at checkout/admin) is fully preserved.

### Deviation 2 from spec (intentional, flagged for user)

Spec says `create-intent` re-checks venue completeness server-side (defense in depth) — kept. **Added:** the client also gates the create-intent *request* on venue completeness, so the Stripe form isn't requested (and the "couldn't load payment form" error can't flash) until the venue address is filled. The server check remains as the true backstop.

---

## File Structure

**Create:**
- `server/utils/venueAddress.js` — compose + validate + state list + completeness (CJS, no DB calls).
- `client/src/components/VenueAddressFields.js` — controlled structured-address inputs (gate + admin).

**Modify (server):**
- `server/db/schema.sql` — add idempotent `venue_*` columns to `proposals`.
- `server/utils/eventCreation.js:133` — compose `shifts.location` from structured fields, fall back to `event_location`.
- `server/routes/proposals/public.js:226-342` — accept/validate/store `venue_*`, set `event_location` via compose.
- `server/routes/proposals/publicToken.js:26-45, 94-133` — return `venue_*` + `venue_complete`; require/persist venue at sign.
- `server/routes/stripe.js:88-118` — import `ValidationError`, select venue cols, reject incomplete.
- `server/routes/proposals/crud.js:238-318` — accept/validate/persist `venue_*`, recompose `event_location`, sync linked shifts.

**Modify (client):**
- `client/src/pages/website/quoteWizard/QuoteWizard.js:44-67, 595-613` — `defaultForm.venue_name`; submit sends `venue_*` not `event_location`.
- `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js:87` — add optional Venue name input.
- `client/src/pages/proposal/proposalView/ProposalView.js:95-174, 317-345` — venue state, gate intent + sign, pass props.
- `client/src/pages/proposal/proposalView/SignAndPaySection.js:55-118` — render gate / read-only confirmation.
- `client/src/pages/admin/ProposalDetailEditForm.js:5,169,301-302,525` — replace `LocationInput` with `VenueAddressFields`.

**Modify (docs):**
- `ARCHITECTURE.md`, `README.md` (per CLAUDE.md mandatory docs table).

---

## Task 1: Add `venue_*` columns to schema

**Files:**
- Modify: `server/db/schema.sql` (after line 1075, the `event_type_custom` ALTER — the existing idempotent-ALTER region)

- [ ] **Step 1: Add the idempotent column block**

In `server/db/schema.sql`, immediately after line 1075 (`ALTER TABLE proposals ADD COLUMN IF NOT EXISTS event_type_custom VARCHAR(255);`) insert:

```sql

-- Structured venue address (collected: venue name optional in quote wizard;
-- street required at sign+pay). event_location is a derived display string
-- composed from these via server/utils/venueAddress.js.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_name   TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_street TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_city   TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_state  TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_zip    TEXT;
```

- [ ] **Step 2: Verify**

Run: `git diff server/db/schema.sql`
Expected: only the 7 added lines, inside the existing ALTER region, matching the surrounding `ADD COLUMN IF NOT EXISTS` style. No `CREATE TABLE` edits. (schema.sql is applied idempotently at deploy; nothing to run locally.)

---

## Task 2: Create the venue address util

**Files:**
- Create: `server/utils/venueAddress.js`

- [ ] **Step 1: Write the util**

Create `server/utils/venueAddress.js`:

```js
// Structured venue address: compose + validate. Pure, no DB calls.
// event_location and shifts.location are derived from these fields.

const VENUE_STATES = ['Illinois', 'Indiana', 'Michigan', 'Minnesota', 'Wisconsin'];
const ZIP_RE = /^\d{5}(-\d{4})?$/;

function s(v) { return (v == null ? '' : String(v)).trim(); }

/**
 * Join non-empty parts: [name, street, "City, State Zip"].
 * City/state only → "Chicago, Illinois" (byte-identical to legacy event_location).
 * Returns null when nothing is set.
 */
function composeVenueLocation(v = {}) {
  const name = s(v.venue_name);
  const street = s(v.venue_street);
  const city = s(v.venue_city);
  const state = s(v.venue_state);
  const zip = s(v.venue_zip);
  const cityState = [city, state].filter(Boolean).join(', ');
  const cityStateZip = [cityState, zip].filter(Boolean).join(' ');
  return [name, street, cityStateZip].filter(Boolean).join(', ') || null;
}

/** True when the address is "complete enough" to dispatch staff. */
function isVenueComplete(v = {}) {
  return !!(s(v.venue_street) && s(v.venue_city) && s(v.venue_state));
}

/**
 * Validate a venue payload. Returns a fieldErrors object (empty = valid).
 * @param {object} v
 * @param {object} opts { requireStreet, requireCityState }
 */
function validateVenue(v = {}, opts = {}) {
  const { requireStreet = false, requireCityState = false } = opts;
  const e = {};
  const name = s(v.venue_name);
  const street = s(v.venue_street);
  const city = s(v.venue_city);
  const state = s(v.venue_state);
  const zip = s(v.venue_zip);

  if (requireStreet && !street) e.venue_street = 'Street address is required';
  if (requireCityState && !city) e.venue_city = 'City is required';
  if (requireCityState && !state) e.venue_state = 'State is required';

  if (name.length > 200) e.venue_name = 'Venue name is too long';
  if (street.length > 200) e.venue_street = 'Street address is too long';
  if (city.length > 120) e.venue_city = 'City is too long';
  if (state && !VENUE_STATES.includes(state)) e.venue_state = 'Select a valid state';
  if (zip && !ZIP_RE.test(zip)) e.venue_zip = 'Enter a valid ZIP (e.g. 60601)';

  return e;
}

module.exports = { VENUE_STATES, composeVenueLocation, isVenueComplete, validateVenue };
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS (no new ESLint errors).

- [ ] **Step 3: Smoke-check composition**

Run:
```bash
node -e "const {composeVenueLocation,isVenueComplete}=require('./server/utils/venueAddress');console.log(composeVenueLocation({venue_name:'Citadel Banquet Hall',venue_street:'123 Main St',venue_city:'Chicago',venue_state:'Illinois',venue_zip:'60601'}));console.log(composeVenueLocation({venue_city:'Chicago',venue_state:'Illinois'}));console.log(isVenueComplete({venue_city:'Chicago',venue_state:'Illinois'}));"
```
Expected output, exactly:
```
Citadel Banquet Hall, 123 Main St, Chicago, Illinois 60601
Chicago, Illinois
false
```

---

## Task 3: Compose `shifts.location` in createEventShifts

**Files:**
- Modify: `server/utils/eventCreation.js:1` (add require), `:133` (use compose)

- [ ] **Step 1: Add the require**

In `server/utils/eventCreation.js`, after line 5 (`const { PUBLIC_SITE_URL } = require('./urls');`) add:

```js
const { composeVenueLocation } = require('./venueAddress');
```

- [ ] **Step 2: Use composed location in the shift INSERT**

In `server/utils/eventCreation.js`, replace line 133 exactly:

```js
    proposal.event_location || null,
```

with:

```js
    composeVenueLocation(proposal) || proposal.event_location || null,
```

(`proposal` is `SELECT p.*` so `venue_*` are present. Falls back to legacy `event_location` when no structured data.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual verification (deferred to Task 11 end-to-end run)**

No standalone run here (requires a paid proposal + webhook). Verified in the end-to-end check at the end of Task 11.

---

## Task 4: Quote-wizard submit endpoint stores structured venue

**Files:**
- Modify: `server/routes/proposals/public.js:226-342`

- [ ] **Step 1: Require the util**

At the top of `server/routes/proposals/public.js`, with the other `require`s, add:

```js
const { composeVenueLocation, validateVenue } = require('../../utils/venueAddress');
```

- [ ] **Step 2: Accept the venue keys**

In the destructure at lines 227-235, replace `event_location,` with:

```js
    venue_name, venue_city, venue_state,
```

(Wizard no longer sends `event_location`. Street/ZIP are not collected in the wizard.)

- [ ] **Step 3: Validate (city/state required, formats)**

Immediately after the existing block that throws on `fieldErrors` (line 242, `if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);`), add:

```js

  const venueInput = { venue_name, venue_city, venue_state };
  const venueErrors = validateVenue(venueInput, { requireCityState: true });
  if (Object.keys(venueErrors).length > 0) throw new ValidationError(venueErrors);
  const composedLocation = composeVenueLocation(venueInput);
```

- [ ] **Step 4: Persist columns + composed event_location**

In the INSERT at lines 329-342, change the column list and values. Replace:

```js
      INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, status,
        event_type, event_type_category, event_type_custom, admin_notes, class_options)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [
      finalClientId, event_date || null,
      event_start_time || null, dh, event_location || null, gc, package_id, nb,
      numBartenders, snapshotJson, totalPrice, proposalStatus,
      event_type || null, event_type_category || null, event_type_custom || null,
      glasswareNote,
      cleanClassOptions ? JSON.stringify(cleanClassOptions) : null
    ]);
```

with:

```js
      INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
        event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, status,
        event_type, event_type_category, event_type_custom, admin_notes, class_options,
        venue_name, venue_city, venue_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *
    `, [
      finalClientId, event_date || null,
      event_start_time || null, dh, composedLocation, gc, package_id, nb,
      numBartenders, snapshotJson, totalPrice, proposalStatus,
      event_type || null, event_type_category || null, event_type_custom || null,
      glasswareNote,
      cleanClassOptions ? JSON.stringify(cleanClassOptions) : null,
      (venue_name || '').trim() || null, (venue_city || '').trim() || null, (venue_state || '').trim() || null
    ]);
```

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: PASS.

---

## Task 5: Public proposal GET returns venue + `venue_complete`

**Files:**
- Modify: `server/routes/proposals/publicToken.js:1-10` (require), `:26-45` (SELECT), `:83-88` (response)

- [ ] **Step 1: Require the util**

In `server/routes/proposals/publicToken.js`, after line 10 (`const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');`) add:

```js
const { isVenueComplete } = require('../../utils/venueAddress');
```

- [ ] **Step 2: Select the venue columns**

In the SELECT at lines 26-45, on the line that reads:

```js
      p.event_location, p.event_type, p.event_type_category, p.event_type_custom,
```

append the venue columns so it becomes:

```js
      p.event_location, p.event_type, p.event_type_category, p.event_type_custom,
      p.venue_name, p.venue_street, p.venue_city, p.venue_state, p.venue_zip,
```

- [ ] **Step 3: Return `venue_complete`**

In the final `res.json({ ... })` at lines 83-88, add `venue_complete`:

```js
  res.json({
    ...proposal,
    addons: addonsRes.rows,
    drink_plan_token: drinkPlanToken,
    venue_complete: isVenueComplete(proposal),
    status: proposal.status === 'sent' ? 'viewed' : proposal.status,
  });
```

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS.

---

## Task 6: Require + persist venue at the sign route

**Files:**
- Modify: `server/routes/proposals/publicToken.js:94-137`

- [ ] **Step 1: Add the util import (if not already from Task 5)**

Ensure the require added in Task 5 includes `composeVenueLocation` and `validateVenue`. Change that line to:

```js
const { isVenueComplete, composeVenueLocation, validateVenue } = require('../../utils/venueAddress');
```

- [ ] **Step 2: Accept venue from the body & widen the lookup**

In `POST /t/:token/sign`, replace the destructure at line 95:

```js
  const { client_signed_name, client_signature_data, client_signature_method } = req.body;
```

with:

```js
  const { client_signed_name, client_signature_data, client_signature_method,
    venue_name, venue_street, venue_city, venue_state, venue_zip } = req.body;
```

Replace the lookup query at lines 106-109:

```js
  const lookup = await pool.query(
    "SELECT id FROM proposals WHERE token = $1",
    [req.params.token]
  );
```

with:

```js
  const lookup = await pool.query(
    `SELECT id, venue_name, venue_street, venue_city, venue_state, venue_zip
       FROM proposals WHERE token = $1`,
    [req.params.token]
  );
```

- [ ] **Step 3: Gate — require a complete venue when one isn't stored yet**

Immediately after the `if (!lookup.rows[0]) throw new NotFoundError(...)` line (line 110), add:

```js

  // Venue address gate: if the proposal doesn't already have a complete venue
  // address, the client must supply one now (street + city + state required).
  const storedVenue = lookup.rows[0];
  let venueToPersist = null;
  if (!isVenueComplete(storedVenue)) {
    const submitted = { venue_name, venue_street, venue_city, venue_state, venue_zip };
    const venueErrors = validateVenue(submitted, { requireStreet: true, requireCityState: true });
    if (Object.keys(venueErrors).length > 0) throw new ValidationError(venueErrors);
    venueToPersist = submitted;
  }
```

- [ ] **Step 4: Persist venue + recomposed event_location in the atomic UPDATE**

Replace the UPDATE at lines 119-133:

```js
  const upd = await pool.query(`
    UPDATE proposals SET
      client_signed_name = $1,
      client_signature_data = $2,
      client_signed_at = NOW(),
      client_signature_method = $3,
      client_signature_ip = $4,
      client_signature_user_agent = $5,
      client_signature_document_version = $6,
      status = 'accepted'
    WHERE id = $7
      AND client_signed_at IS NULL
      AND status NOT IN ('accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed', 'cancelled')
    RETURNING id
  `, [client_signed_name, client_signature_data, client_signature_method, ip, userAgent, PROPOSAL_DOCUMENT_VERSION, lookup.rows[0].id]);
```

with:

```js
  // When venueToPersist is set, also write the structured fields and the
  // recomposed event_location in the same atomic UPDATE.
  const mergedVenue = venueToPersist || storedVenue;
  const composedLocation = composeVenueLocation(mergedVenue);
  const upd = await pool.query(`
    UPDATE proposals SET
      client_signed_name = $1,
      client_signature_data = $2,
      client_signed_at = NOW(),
      client_signature_method = $3,
      client_signature_ip = $4,
      client_signature_user_agent = $5,
      client_signature_document_version = $6,
      status = 'accepted',
      venue_name  = COALESCE($8, venue_name),
      venue_street = COALESCE($9, venue_street),
      venue_city  = COALESCE($10, venue_city),
      venue_state = COALESCE($11, venue_state),
      venue_zip   = COALESCE($12, venue_zip),
      event_location = COALESCE($13, event_location)
    WHERE id = $7
      AND client_signed_at IS NULL
      AND status NOT IN ('accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed', 'cancelled')
    RETURNING id
  `, [
    client_signed_name, client_signature_data, client_signature_method, ip, userAgent,
    PROPOSAL_DOCUMENT_VERSION, lookup.rows[0].id,
    venueToPersist ? ((venue_name || '').trim() || null) : null,
    venueToPersist ? venue_street.trim() : null,
    venueToPersist ? venue_city.trim() : null,
    venueToPersist ? venue_state.trim() : null,
    venueToPersist ? ((venue_zip || '').trim() || null) : null,
    venueToPersist ? composedLocation : null,
  ]);
```

(`venue_street/city/state` are guaranteed non-empty here because `validateVenue` with `requireStreet`+`requireCityState` already rejected blanks.)

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: PASS.

---

## Task 7: `create-intent` rejects an incomplete venue (server backstop)

**Files:**
- Modify: `server/routes/stripe.js:1-20` (import), `:101-118` (select + check)

- [ ] **Step 1: Ensure `ValidationError` and the util are imported**

Open `server/routes/stripe.js`. Find the existing `require('../utils/errors')` line (it imports `AppError, NotFoundError, ConflictError, ExternalServiceError`). Add `ValidationError` to that destructure. Then add below it:

```js
const { isVenueComplete } = require('../utils/venueAddress');
```

(If the errors are imported individually, add `ValidationError` consistently with the existing style. Verify with `git grep "require('../utils/errors')" server/routes/stripe.js`.)

- [ ] **Step 2: Select venue columns in the create-intent query**

In `POST /create-intent/:token`, the SELECT at lines 101-108 — append venue columns. Change:

```js
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price, p.event_date,
           p.stripe_customer_id, p.deposit_amount,
           c.email AS client_email, c.name AS client_name
```

to:

```js
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price, p.event_date,
           p.stripe_customer_id, p.deposit_amount,
           p.venue_street, p.venue_city, p.venue_state,
           c.email AS client_email, c.name AS client_name
```

- [ ] **Step 3: Reject when incomplete**

Immediately after the two status guards (right after line 118, the `if (!['sent','viewed','accepted']...)` block), add:

```js

  if (!isVenueComplete(proposal)) {
    throw new ValidationError(
      { venue_street: 'Please add the venue address before paying' },
      'Venue address required'
    );
  }
```

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS.

**COMMIT CHECKPOINT A (backend) — only on a commit cue from the user.**
Suggested staged paths + message:
```bash
git add server/db/schema.sql server/utils/venueAddress.js server/utils/eventCreation.js \
  server/routes/proposals/public.js server/routes/proposals/publicToken.js server/routes/stripe.js
git commit -m "feat(venue): structured venue address — schema, compose/validate util, booking-path enforcement"
```

---

## Task 8: Admin PATCH accepts/validates venue, recomposes, syncs shifts

**Files:**
- Modify: `server/routes/proposals/crud.js:238-318` (+ require near top)

- [ ] **Step 1: Require the util**

Near the top of `server/routes/proposals/crud.js`, with the other requires, add:

```js
const { composeVenueLocation, validateVenue } = require('../../utils/venueAddress');
```

- [ ] **Step 2: Accept venue keys**

In the PATCH destructure at lines 239-244, add the venue keys. After `event_type, event_type_category, event_type_custom,` add:

```js
    venue_name, venue_street, venue_city, venue_state, venue_zip,
```

- [ ] **Step 3: Validate formats (admin is trusted — no required fields)**

Immediately after `const old = existing.rows[0];` (line 254) add:

```js

    const venueProvided = [venue_name, venue_street, venue_city, venue_state, venue_zip]
      .some(v => v !== undefined);
    if (venueProvided) {
      const venueErrors = validateVenue(
        { venue_name, venue_street, venue_city, venue_state, venue_zip },
        { requireStreet: false, requireCityState: false }
      );
      if (Object.keys(venueErrors).length > 0) throw new ValidationError(venueErrors);
    }
    const mergedVenue = {
      venue_name:   venue_name   ?? old.venue_name,
      venue_street: venue_street ?? old.venue_street,
      venue_city:   venue_city   ?? old.venue_city,
      venue_state:  venue_state  ?? old.venue_state,
      venue_zip:    venue_zip    ?? old.venue_zip,
    };
    const recomposedLocation = venueProvided
      ? composeVenueLocation(mergedVenue)
      : null;
```

- [ ] **Step 4: Persist venue + recomposed location in the UPDATE**

In the `UPDATE proposals SET` at lines 299-318: add the venue columns to the SET clause and renumber. Replace the whole statement:

```js
    const updatedRow = await dbClient.query(`
      UPDATE proposals SET
        event_date = COALESCE($1, event_date),
        event_start_time = COALESCE($2, event_start_time), event_duration_hours = $3,
        event_location = COALESCE($4, event_location), guest_count = $5,
        package_id = $6, num_bars = $7, num_bartenders = $8,
        pricing_snapshot = $9, total_price = $10,
        event_type = COALESCE($12, event_type),
        event_type_category = COALESCE($13, event_type_category),
        event_type_custom = COALESCE($14, event_type_custom),
        adjustments = $15, total_price_override = $16
      WHERE id = $11
      RETURNING *
    `, [
      event_date, event_start_time, dh, event_location, gc,
      pkgId, nb, snapshot.staffing.actual,
      JSON.stringify(snapshot), snapshot.total, req.params.id,
      event_type || null, event_type_category || null, event_type_custom || null,
      JSON.stringify(adj), tpo ?? null
    ]);
```

with:

```js
    const updatedRow = await dbClient.query(`
      UPDATE proposals SET
        event_date = COALESCE($1, event_date),
        event_start_time = COALESCE($2, event_start_time), event_duration_hours = $3,
        event_location = COALESCE($17, COALESCE($4, event_location)), guest_count = $5,
        package_id = $6, num_bars = $7, num_bartenders = $8,
        pricing_snapshot = $9, total_price = $10,
        event_type = COALESCE($12, event_type),
        event_type_category = COALESCE($13, event_type_category),
        event_type_custom = COALESCE($14, event_type_custom),
        adjustments = $15, total_price_override = $16,
        venue_name  = COALESCE($18, venue_name),
        venue_street = COALESCE($19, venue_street),
        venue_city  = COALESCE($20, venue_city),
        venue_state = COALESCE($21, venue_state),
        venue_zip   = COALESCE($22, venue_zip)
      WHERE id = $11
      RETURNING *
    `, [
      event_date, event_start_time, dh, event_location, gc,
      pkgId, nb, snapshot.staffing.actual,
      JSON.stringify(snapshot), snapshot.total, req.params.id,
      event_type || null, event_type_category || null, event_type_custom || null,
      JSON.stringify(adj), tpo ?? null,
      recomposedLocation,
      venue_name ?? null, venue_street ?? null, venue_city ?? null,
      venue_state ?? null, venue_zip ?? null
    ]);
```

(`$17` = recomposed location wins when venue fields were edited; otherwise falls back to explicit `event_location` ($4) then existing — fully back-compatible.)

- [ ] **Step 5: Sync linked shifts when venue changed (CLAUDE.md cross-cutting)**

Find the existing `DELETE FROM proposal_addons WHERE proposal_id = $1` line (≈321). Immediately **before** it, add:

```js
    // Keep linked shifts' location in sync with an edited venue, and clear
    // lat/lng so the existing geocode path re-resolves coordinates.
    if (venueProvided && recomposedLocation) {
      await dbClient.query(
        `UPDATE shifts SET location = $1, lat = NULL, lng = NULL
         WHERE proposal_id = $2`,
        [recomposedLocation, req.params.id]
      );
    }
```

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: PASS.

**COMMIT CHECKPOINT B (admin backend) — only on a commit cue.**
```bash
git add server/routes/proposals/crud.js
git commit -m "feat(venue): admin edit persists structured venue + syncs linked shifts"
```

---

## Task 9: Create the `VenueAddressFields` client component

**Files:**
- Create: `client/src/components/VenueAddressFields.js`

- [ ] **Step 1: Write the component**

Create `client/src/components/VenueAddressFields.js`:

```jsx
import React from 'react';

export const VENUE_STATES = ['Illinois', 'Indiana', 'Michigan', 'Minnesota', 'Wisconsin'];

// Controlled structured-address inputs. Used at the sign+pay gate and the
// admin proposal edit form. value: {venue_name,venue_street,venue_city,
// venue_state,venue_zip}. onChange(field, value).
export default function VenueAddressFields({
  value = {},
  onChange,
  fieldErrors = {},
  requireStreet = false,
  inputClassName = 'form-input',
  selectClassName = 'form-select',
  labelClassName = 'form-label',
  idPrefix = 'venue',
}) {
  const v = value || {};
  const set = (f) => (e) => onChange(f, e.target.value);
  const req = requireStreet ? ' *' : '';

  return (
    <div className="venue-address-fields">
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-name`}>Venue name (optional)</label>
        <input id={`${idPrefix}-name`} className={inputClassName} value={v.venue_name || ''}
          onChange={set('venue_name')} placeholder="e.g. Citadel Banquet Hall" autoComplete="off" />
        {fieldErrors.venue_name && <div className="field-error">{fieldErrors.venue_name}</div>}
      </div>
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-street`}>Street address{req}</label>
        <input id={`${idPrefix}-street`} className={inputClassName} value={v.venue_street || ''}
          onChange={set('venue_street')} placeholder="123 Main St" autoComplete="off"
          aria-invalid={!!fieldErrors.venue_street} />
        {fieldErrors.venue_street && <div className="field-error">{fieldErrors.venue_street}</div>}
      </div>
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-city`}>City *</label>
        <input id={`${idPrefix}-city`} className={inputClassName} value={v.venue_city || ''}
          onChange={set('venue_city')} placeholder="Chicago" autoComplete="off"
          aria-invalid={!!fieldErrors.venue_city} />
        {fieldErrors.venue_city && <div className="field-error">{fieldErrors.venue_city}</div>}
      </div>
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-state`}>State *</label>
        <select id={`${idPrefix}-state`} className={selectClassName} value={v.venue_state || ''}
          onChange={set('venue_state')} aria-invalid={!!fieldErrors.venue_state}>
          <option value="">-- Select --</option>
          {VENUE_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        {fieldErrors.venue_state && <div className="field-error">{fieldErrors.venue_state}</div>}
      </div>
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-zip`}>ZIP (optional)</label>
        <input id={`${idPrefix}-zip`} className={inputClassName} value={v.venue_zip || ''}
          onChange={set('venue_zip')} placeholder="60601" inputMode="numeric" autoComplete="off"
          aria-invalid={!!fieldErrors.venue_zip} />
        {fieldErrors.venue_zip && <div className="field-error">{fieldErrors.venue_zip}</div>}
      </div>
    </div>
  );
}

// Display helper for the read-only "already provided" confirmation.
export function formatVenue(v = {}) {
  const cityState = [v.venue_city, v.venue_state].filter(Boolean).join(', ');
  const cityStateZip = [cityState, v.venue_zip].filter(Boolean).join(' ');
  return [v.venue_name, v.venue_street, cityStateZip].filter(Boolean).join(', ');
}
```

- [ ] **Step 2: Verify the client builds**

Run: `cd client && npx eslint src/components/VenueAddressFields.js`
Expected: no errors (CRA ESLint config). Return to repo root afterward (`cd ..`).

---

## Task 10: Quote wizard — optional Venue name input + send `venue_*`

**Files:**
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js:44-67` (defaultForm), `:595-613` (submit body)
- Modify: `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js:87`

- [ ] **Step 1: Add `venue_name` to defaultForm**

In `client/src/pages/website/quoteWizard/QuoteWizard.js`, in `defaultForm` (≈line 44-67), directly after the `event_state: '',` line (≈53) add:

```js
    venue_name: '',
```

- [ ] **Step 2: Send structured venue, drop `event_location`**

In `handleSubmit`'s fetch body (≈line 605), replace the line:

```js
          event_location: [form.event_city, form.event_state].filter(Boolean).join(', ') || null,
```

with:

```js
          venue_name: form.venue_name?.trim() || null,
          venue_city: form.event_city,
          venue_state: form.event_state,
```

- [ ] **Step 3: Add the optional Venue name input to the Event step**

In `client/src/pages/website/quoteWizard/steps/EventDetailsStep.js`, directly after the State `form-group` closing `</div>` at line 87 (the line before the blank line + `{/* Alcohol provider */}`), insert:

```jsx
        <div className="form-group">
          <label htmlFor="wz-venue_name" className="form-label">Venue name (optional)</label>
          <input id="wz-venue_name" className="form-input" value={form.venue_name || ''}
            onChange={e => update('venue_name', e.target.value)}
            placeholder="e.g. Citadel Banquet Hall (if you know it)" autoComplete="off" />
        </div>
```

- [ ] **Step 4: Lint client files**

Run: `cd client && npx eslint src/pages/website/quoteWizard/QuoteWizard.js src/pages/website/quoteWizard/steps/EventDetailsStep.js && cd ..`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Start dev (`npm run dev`). Open the quote wizard, Event Details step. Confirm:
- "Venue name (optional)" input appears under State; not required to advance.
- Complete a quote. In the DB (or admin proposal view) confirm the new proposal row has `venue_name` (if typed), `venue_city`, `venue_state` set and `event_location` = `"<Venue name>, City, State"` or `"City, State"`.

---

## Task 11: Sign + pay gate (ProposalView + SignAndPaySection)

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js:29-31, 95-174, 317-345`
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js:55-118`

- [ ] **Step 1: Venue state in ProposalView**

In `client/src/pages/proposal/proposalView/ProposalView.js`, near the signature state (lines 29-31, the `sigName/sigData/sigMethod` `useState`s) add:

```jsx
  const [venue, setVenue] = useState({
    venue_name: '', venue_street: '', venue_city: '', venue_state: '', venue_zip: '',
  });
```

After the proposal is loaded (find where `setProposal(...)` / proposal data first lands — same effect that sets `loading false`), seed venue from the proposal once:

```jsx
  // Seed editable venue from the loaded proposal (once).
  useEffect(() => {
    if (proposal) {
      setVenue((cur) => (cur._seeded ? cur : {
        venue_name: proposal.venue_name || '',
        venue_street: proposal.venue_street || '',
        venue_city: proposal.venue_city || '',
        venue_state: proposal.venue_state || '',
        venue_zip: proposal.venue_zip || '',
        _seeded: true,
      }));
    }
  }, [proposal]);

  const venueComplete = !!proposal?.venue_complete
    || !!(venue.venue_street?.trim() && venue.venue_city?.trim() && venue.venue_state?.trim());
```

(Place the `venueComplete` line after the `venue` state + seed effect, before the create-intent effect at line 95.)

- [ ] **Step 2: Gate the create-intent effect on venue completeness**

In the create-intent effect (lines ≈95-135), add an early return alongside the existing guards. Right after the existing `if (!needsDeposit && !needsFull) return;` (line 100) add:

```jsx
    if (!venueComplete) return;
```

And add `venueComplete` to that effect's dependency array (line 135) — change:

```jsx
  }, [isPayableStatus, paymentOption, autopayChecked, token, depositSecret, fullSecret]);
```

to:

```jsx
  }, [isPayableStatus, paymentOption, autopayChecked, token, depositSecret, fullSecret, venueComplete]);
```

- [ ] **Step 3: Validate venue + include it in the sign POST**

In `handleSign` (lines 138-174), after the `if (!sigData) {...}` block (line 150) and before the `if (proposal.client_signed_at ...) return;` line, add:

```jsx
    if (!proposal.venue_complete) {
      const ve = {};
      if (!venue.venue_street?.trim()) ve.venue_street = 'Street address is required';
      if (!venue.venue_city?.trim()) ve.venue_city = 'City is required';
      if (!venue.venue_state?.trim()) ve.venue_state = 'State is required';
      if (Object.keys(ve).length) {
        setFieldErrors(ve);
        const msg = 'Please add the venue address.';
        setFormError(msg);
        throw new Error(msg);
      }
    }
```

In the sign `axios.post` body (lines 156-160) add the venue fields:

```jsx
      await axios.post(`${BASE_URL}/proposals/t/${token}/sign`, {
        client_signed_name: sigName.trim(),
        client_signature_data: sigData,
        client_signature_method: sigMethod,
        venue_name: venue.venue_name?.trim() || null,
        venue_street: venue.venue_street?.trim() || null,
        venue_city: venue.venue_city?.trim() || null,
        venue_state: venue.venue_state?.trim() || null,
        venue_zip: venue.venue_zip?.trim() || null,
      });
```

- [ ] **Step 4: Pass venue props to SignAndPaySection**

At the `signAndPay` `<SignAndPaySection ... />` usage (≈line 317-340), add these props:

```jsx
                venue={venue}
                setVenue={setVenue}
                venueComplete={venueComplete}
                proposalVenue={{
                  venue_name: proposal.venue_name, venue_street: proposal.venue_street,
                  venue_city: proposal.venue_city, venue_state: proposal.venue_state,
                  venue_zip: proposal.venue_zip,
                }}
```

- [ ] **Step 5: Render the gate UI in SignAndPaySection**

In `client/src/pages/proposal/proposalView/SignAndPaySection.js`:

Add imports at the top (after line 6):

```jsx
import VenueAddressFields, { formatVenue } from '../../../components/VenueAddressFields';
```

Add the new props to the destructure (after `handleSign,` at line 81):

```jsx
  venue,
  setVenue,
  venueComplete,
  proposalVenue,
```

In `mode === 'signAndPay'`, insert a venue block **between** the Signature `</div>` (line 118) and the `{/* Payment Options */}` block (line 120):

```jsx
        {/* Venue address */}
        <div>
          <label className="sign-pay-eyebrow">Where is your event?</label>
          {proposalVenue && (proposalVenue.venue_street || proposalVenue.venue_city) && venueComplete ? (
            <p className="sign-pay-venue-confirm">
              {formatVenue(proposalVenue)}
            </p>
          ) : (
            <VenueAddressFields
              value={venue}
              onChange={(f, val) => setVenue((cur) => ({ ...cur, [f]: val }))}
              requireStreet
              inputClassName="sign-pay-input"
              selectClassName="sign-pay-input"
              labelClassName="sign-pay-eyebrow"
              idPrefix="signpay-venue"
            />
          )}
        </div>
```

Update the `PaymentForm` `disabled` prop (line 166) to also require a complete venue:

```jsx
                  disabled={!sigName.trim() || !sigData || !venueComplete}
```

- [ ] **Step 6: Lint client files**

Run: `cd client && npx eslint src/pages/proposal/proposalView/ProposalView.js src/pages/proposal/proposalView/SignAndPaySection.js src/components/VenueAddressFields.js && cd ..`
Expected: no errors.

- [ ] **Step 7: End-to-end manual verification (covers Tasks 3–7, 11)**

With `npm run dev` and Stripe test mode (`STRIPE_TEST_MODE_UNTIL` in the future, test cards):

1. Create a quote via the wizard **without** a venue name. Open the proposal link.
2. On the proposal: confirm a "Where is your event?" block with street/city/state/(zip) appears; the Stripe payment form does **not** load and the pay button is disabled while street/city/state are empty.
3. Fill street + city + state (leave ZIP blank). Confirm the Stripe form now loads, sign, and pay the deposit with test card `4242 4242 4242 4242`.
4. In admin, open the resulting event/shift: confirm `shifts.location` = the composed full address (e.g. `123 Main St, Chicago, Illinois`) and the proposal shows the structured venue.
5. Re-open the same proposal token: the venue now shows as a **read-only** confirmation line (no inputs), pay flow unaffected.
6. Negative: a proposal that already had a complete venue (admin pre-filled) shows the read-only line and never blocks.

Document the result inline when executing (pass/fail per step).

**COMMIT CHECKPOINT C (client booking flow) — only on a commit cue.**
```bash
git add client/src/components/VenueAddressFields.js \
  client/src/pages/website/quoteWizard/QuoteWizard.js \
  client/src/pages/website/quoteWizard/steps/EventDetailsStep.js \
  client/src/pages/proposal/proposalView/ProposalView.js \
  client/src/pages/proposal/proposalView/SignAndPaySection.js
git commit -m "feat(venue): wizard venue-name field + required venue gate at sign & pay"
```

---

## Task 12: Admin proposal edit — replace LocationInput with VenueAddressFields

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailEditForm.js:5, 169, 301-302, 525`

- [ ] **Step 1: Swap the import**

In `client/src/pages/admin/ProposalDetailEditForm.js` line 5, replace:

```jsx
import LocationInput from '../../components/LocationInput';
```

with:

```jsx
import VenueAddressFields from '../../components/VenueAddressFields';
```

- [ ] **Step 2: Seed venue fields into editForm init**

At the editForm initializer (≈line 525, `event_location: p.event_location || '',`) add directly below it:

```jsx
    venue_name: p.venue_name || '',
    venue_street: p.venue_street || '',
    venue_city: p.venue_city || '',
    venue_state: p.venue_state || '',
    venue_zip: p.venue_zip || '',
```

- [ ] **Step 3: Replace the input**

At lines 301-302, replace:

```jsx
            <LocationInput value={editForm.event_location}
              onChange={(v) => update('event_location', v)} />
```

with:

```jsx
            <VenueAddressFields
              value={editForm}
              onChange={(f, val) => update(f, val)}
            />
```

(`update(field, value)` already exists in this form — same signature used elsewhere. The `event_location` label/`form-group` wrapper around these lines stays; it now wraps the structured fields.)

- [ ] **Step 4: Send venue fields in the PATCH payload**

At ≈line 169 (`event_location: editForm.event_location,` in the PATCH body), replace that single line with:

```jsx
        venue_name: editForm.venue_name,
        venue_street: editForm.venue_street,
        venue_city: editForm.venue_city,
        venue_state: editForm.venue_state,
        venue_zip: editForm.venue_zip,
```

(Server recomposes `event_location` from these and syncs linked shifts — Task 8.)

- [ ] **Step 5: Lint**

Run: `cd client && npx eslint src/pages/admin/ProposalDetailEditForm.js && cd ..`
Expected: no errors.

- [ ] **Step 6: Manual verification**

In admin, edit a proposal that already has linked shifts: change the street, save. Confirm:
- The proposal detail shows the updated composed location.
- The linked shift's location updated to the recomposed address and its lat/lng cleared (re-geocodes on next view).

**COMMIT CHECKPOINT D (admin UI) — only on a commit cue.**
```bash
git add client/src/pages/admin/ProposalDetailEditForm.js
git commit -m "feat(venue): admin proposal edit uses structured venue fields"
```

---

## Task 13: Documentation (CLAUDE.md mandatory docs table)

**Files:**
- Modify: `ARCHITECTURE.md` (Database Schema section; integrations/util mention)
- Modify: `README.md` (components tree)

- [ ] **Step 1: ARCHITECTURE.md — schema**

In the `proposals` table description in `ARCHITECTURE.md`'s Database Schema section, add a line documenting the new columns and that `event_location` is now a derived/composed display string:

```
venue_name, venue_street, venue_city, venue_state, venue_zip — structured venue
address (venue name optional in quote wizard; street required at sign+pay).
event_location is a derived display string composed from these (see
server/utils/venueAddress.js).
```

- [ ] **Step 2: ARCHITECTURE.md — util**

In the utilities/relevant section of `ARCHITECTURE.md`, add a one-liner for `server/utils/venueAddress.js` (compose/validate venue, single source of the `event_location` format).

- [ ] **Step 3: README.md — components tree**

In `README.md`'s folder-structure tree under client components, add `VenueAddressFields.js` (structured venue address input — sign+pay gate & admin).

- [ ] **Step 4: Verify**

Run: `git diff --stat ARCHITECTURE.md README.md`
Expected: both files show small additions only.

**COMMIT CHECKPOINT E (docs) — only on a commit cue.**
```bash
git add ARCHITECTURE.md README.md docs/superpowers/plans/2026-05-15-venue-address.md
git commit -m "docs(venue): schema, util, component tree for structured venue address"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- Structured columns on `proposals` → Task 1. ✔
- Compose/validate single util → Task 2. ✔
- Wizard collects optional venue name + (existing) city/state, no street/zip → Tasks 4, 10 (+ Deviation 1 documented). ✔
- `event_location` kept as composed display string; legacy "City, State" byte-identical → Task 2 compose rule + Task 4/6/8 wiring; smoke test in Task 2 Step 3. ✔
- Required gate at sign+pay, client + server enforced → Tasks 6 (server sign), 7 (server create-intent backstop), 11 (client). ✔
- `venue_complete` from GET → Task 5. ✔
- ZIP optional everywhere; venue name optional → `validateVenue` (Task 2), wizard (Task 10), gate (Task 6 requires street/city/state only). ✔
- `createEventShifts` composes `shifts.location`, falls back → Task 3. ✔
- Admin structured edit + recompose + **shift sync incl. lat/lng reset** → Task 8 (server) + Task 12 (UI). ✔
- Downstream consumers unchanged (read `event_location`/`shifts.location`) — no tasks needed; verified in Task 11 step 4. ✔
- Non-goals respected: no reminder scheduler, no auto-assign gate, no admin-confirm hard block, no autocomplete — none added. ✔
- Docs → Task 13. ✔

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output. ✔

**3. Type/name consistency:** `composeVenueLocation`, `isVenueComplete`, `validateVenue`, `VENUE_STATES` consistent across Tasks 2/3/4/5/6/7/8. JSON keys `venue_name|venue_street|venue_city|venue_state|venue_zip` consistent server↔client. `validateVenue(input,{requireStreet,requireCityState})` signature consistent in Tasks 4/6/8. `VenueAddressFields` props (`value/onChange(field,val)/requireStreet/*ClassName/idPrefix`) consistent in Tasks 9/11/12. ✔

---

## Notes / Risks

- **`update(field, val)` in ProposalDetailEditForm**: Step 12.3 assumes the existing `update` helper sets `editForm[field]`. If its signature differs, adapt the `onChange` to the form's existing setter — the rest is unaffected.
- **stripe.js errors import shape**: Task 7 Step 1 — verify whether `errors` are destructured together or imported individually; add `ValidationError` in the file's existing style.
- **Wizard city/state still client-required** via existing `getStepRules()` (lines 520-521) — unchanged; server now also validates (Task 4) which only tightens correctness.
- **Idempotency**: schema ALTERs are `IF NOT EXISTS`; `createEventShifts` already idempotent — unchanged.
```
