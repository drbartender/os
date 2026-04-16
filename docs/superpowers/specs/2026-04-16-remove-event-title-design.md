# Remove Event Title from the App

**Date:** 2026-04-16
**Scope:** Full stack — schema, backend routes, utilities, email/SMS templates, frontend pages and wizards
**Motivation:** "Event title" duplicates "event type" in the UI and is frequently mixed up with it. Proposals, shifts, and drink plans currently carry both a free-text `event_name` and a structured `event_type`, and many displays concatenate them into a single "title" string. Client name + event type is sufficient to identify any event. Removing `event_name` end to end eliminates the confusion and simplifies every form, card, heading, email, and calendar entry.

---

## Goals

- Drop the `event_name` column from `proposals`, `shifts`, and `drink_plans`.
- Display every event as two independent data points: `client_name` and a resolved `event_type` label, never concatenated into a single title string.
- Provide a graceful `'event'` fallback when `event_type` is not yet set (e.g., drink plans submitted via the public Potion Planning Lab).
- Keep shifts and drink plans self-describing when they exist without a linked proposal (denormalize `event_type`, `event_type_custom`, and — for shifts — `client_name`).
- Leave `blog_posts.title` and unrelated `title` tooltips/labels untouched.

## Non-Goals

- Not merging proposals and events into a single pipeline (per existing project-wide decision to keep proposal and event views separate).
- Not renaming `event_type` or restructuring the event type taxonomy.
- No attempt to backfill historical `event_name` text into `event_type` — any record with a missing type will display as "event" and can be corrected by hand in admin.
- Not redesigning the public Potion Planning Lab flow to ask for event type up front; admin will set the type during review.
- No UI rebranding or visual overhaul — this is a targeted cleanup, not a redesign.

---

## Design

### Display composition

All display is composed from two independent fields:

```
client_name        → from clients.name or the denormalized column on shifts/drink_plans
event_type_label   → resolved via getEventTypeLabel({ event_type, event_type_custom })
```

`getEventTypeLabel` rules:
1. If `event_type` matches an id in `EVENT_TYPES`, return that entry's `label`.
2. If `event_type === 'other'` and `event_type_custom` is set, return the custom string.
3. Otherwise return the literal string `'event'`.

Display fallbacks when multiple fields are missing:
- Both present: *"Smith — Wedding Reception"*
- Client only: *"Smith — event"*
- Type only: *"Wedding Reception on Fri Nov 8"*
- Neither: *"Event on Fri Nov 8"* (uses `event_date` as last resort)

Any place that currently interpolates `event_name` uses the resolved label instead. Emails read naturally either way:
- *"Your proposal for your wedding reception"*
- *"Your proposal for your event"* (when no type set)

### Schema changes

All changes idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP COLUMN IF EXISTS`) and run on app boot via `schema.sql`.

**`proposals`**
- `DROP COLUMN IF EXISTS event_name`

**`shifts`**
- `ADD COLUMN IF NOT EXISTS event_type VARCHAR(100)`
- `ADD COLUMN IF NOT EXISTS event_type_custom VARCHAR(255)`
- `ADD COLUMN IF NOT EXISTS client_name VARCHAR(255)`
- Backfill from linked proposal (see below)
- `DROP COLUMN IF EXISTS event_name` — removes the old `NOT NULL VARCHAR(255)` constraint with it. `event_date` remains required; `event_type` is optional.

**`drink_plans`**
- `ADD COLUMN IF NOT EXISTS event_type VARCHAR(100)`
- `ADD COLUMN IF NOT EXISTS event_type_custom VARCHAR(255)`
- Backfill from linked proposal (see below)
- `DROP COLUMN IF EXISTS event_name`
- `client_name` already exists — keep.

**Event type data**
- `client/src/data/eventTypes.js`: add `{ id: 'cocktail-class', label: 'Cocktail Class', category: 'class' }`.

### Backfill

Runs once per deploy, inside `schema.sql`, after the new columns are added and before `event_name` is dropped. Idempotent — guarded by `WHERE ... IS NULL`.

```sql
UPDATE shifts s
   SET event_type        = p.event_type,
       event_type_custom = p.event_type_custom,
       client_name       = c.name
  FROM proposals p
  LEFT JOIN clients c ON c.id = p.client_id
 WHERE s.proposal_id = p.id
   AND s.event_type IS NULL;

UPDATE drink_plans d
   SET event_type        = p.event_type,
       event_type_custom = p.event_type_custom
  FROM proposals p
 WHERE d.proposal_id = p.id
   AND d.event_type IS NULL;
```

Standalone shifts or drink plans with no `proposal_id` keep `event_type` NULL and display as "event" until manually set.

### Shared display helpers

Two mirrored modules expose the same `getEventTypeLabel({ event_type, event_type_custom })` signature:

**`server/utils/eventTypes.js`** — new file. Contains a minimal id→label map (id + label + category only) duplicated from the client array, plus the `getEventTypeLabel` helper. Used by email templates, SMS builders, calendar ICS formatters, Stripe descriptors, and any server-side string composition.

**`client/src/utils/eventTypes.js`** — new file. Thin wrapper over `client/src/data/eventTypes.js` exporting the same helper. Used by all admin dashboards and public-facing React pages that display event rows.

The drift surface is ~25 id→label pairs. Risk of the two files diverging is low because adding an event type is already a rare schema-level change; an in-code comment in both files cross-references the other.

### Backend changes

**`server/routes/proposals.js`**
- Remove `event_name` from all SELECT column lists, INSERT column/value lists, UPDATE SETs, and request body validation.
- Delete the "Derive event_name from event type" block (~L447).
- Emails previously passed `eventName`; now pass `eventTypeLabel` computed via the helper.

**`server/routes/shifts.js`**
- SELECTs read `event_type`, `event_type_custom`, `client_name` directly from the shift row. No fallback join — shifts are denormalized by design (mirrors today's copy-at-creation behavior for `event_name`; re-syncing from the proposal on later edits is out of scope).
- INSERT/UPDATE replace `event_name` with the three new fields.
- Required-field validation: `event_date` required; `event_type` optional.

**`server/routes/drinkPlans.js`**
- Same swap. Public submission endpoint does not require `event_type`; admin review form can set it later.
- Search/filter on `dp.event_name ILIKE` (~L318) becomes `dp.client_name ILIKE OR dp.client_email ILIKE`. Searching by the event-type label would require joining against a server-side taxonomy table, which is more machinery than this simple filter deserves.

**`server/routes/calendar.js`**
- iCal `SUMMARY` becomes `${client_name} — ${event_type_label}` (or just `${event_type_label}` if no client). Filename derivation (~L408) uses the same composition.

**`server/routes/clientPortal.js`, `server/routes/invoices.js`, `server/routes/messages.js`**
- Remove `event_name` from SELECT column lists. Read `event_type` from the proposal (or the shift in the case of `messages.js`), resolve to a label on the server using the helper.

**`server/routes/stripe.js` + `server/utils/balanceScheduler.js`**
- Stripe PaymentIntent / invoice `description` fields use `${event_type_label} event — ${client_name}`. Fallback to `"event — {client_name}"` cleanly.

**`server/utils/eventCreation.js`**
- When creating shifts or drink plans from a proposal, copy `event_type`, `event_type_custom`, and `client_name` forward (the slot previously filled by `event_name`).

**`server/utils/emailTemplates.js`**
- Signature change: every template that currently accepts `eventName` now accepts `eventTypeLabel`. Default parameter `= 'event'` so templates read naturally without a ternary at each call site.
- Subject lines: *"Your proposal for your {eventTypeLabel}"* → *"Your proposal for your event"* when unset.

**`server/utils/autoAssign.js`, `server/utils/autoAssignScheduler.js`**
- SMS approval message becomes *"Open bartender shift: {event_type_label} on {date} at {client_name}"*.

**Seed data**
- `server/db/seedTestData.js` — INSERT statements for proposals, shifts, and drink plans set `event_type` instead of `event_name`. Pick representative types per record.

### Frontend changes

**`client/src/utils/eventTypes.js`** — new file with the `getEventTypeLabel` helper. Every component below imports from here.

**Admin pages**
- `ProposalCreate.js` — remove the `form.event_name` state field, the input element, and the "Title:" label (~L253). Review/summary section shows `Client: {client_name}` and `Event type: {event_type_label}` as separate rows.
- `ProposalDetail.js` — split the heading (~L708): `<h1>{client_name}</h1>` with a subtitle `<span>{event_type_label}</span>`. Keep the `.event-title` CSS class on the heading; it now styles the client name.
- `EventsDashboard.js` — delete the `eventTitle()` helper (~L57). Each row/card shows `{client_name}` primary with `{event_type_label}` secondary.
- `ShiftDetail.js` — remove the local `title` variable. Heading uses the same two-line pattern.
- `ClientDetail.js` — proposal and shift lists display both fields separately.
- `DrinkPlansDashboard.js`, `DrinkPlanDetail.js` — same pattern.

**Public / client pages**
- `ClientDashboard.js` (~L111) — `{client_name}` primary; event type + date as secondary metadata; `'event'` fallback when type missing.
- `ProposalView.js` (~L345) — heading "*Your {event_type_label} proposal*".
- `InvoicePage.js` (~L165) — same pattern.
- `pages/plan/steps/WelcomeStep.js` — "*Here's your drink plan for your {event_type_label}*". When `client_name` is set and type isn't, phrase as "*{client_name}'s event*". When nothing is set, "*your event*".

**Wizards**
- `ClassWizard.js` — remove the `event_name` form field and input (~L467). On submit, hard-code `event_type: 'cocktail-class'`, `event_type_category: 'class'`, `event_type_custom: null`, and omit `event_name` from the POST body. (Mirrors the three-field shape that `QuoteWizard` already sends.)
- `QuoteWizard.js` — already uses `event_type` only. No change.

**Shopping list PDF**
- `ShoppingListPDF.jsx` — add `eventTypeLabel` to the header metadata next to the event date. `clientName` remains the primary identifier.

**CSS**
- `.event-title` class stays; now styles the client name heading. No renaming.

### Stripe, calendar, and external consumers

- **Stripe**: `description` fields are free-text, so the new format ships with the next PaymentIntent. No Stripe-side changes.
- **Calendar (ICS)**: subscribers see the updated `SUMMARY` on next calendar client sync. No action required from users.
- **Thumbtack webhook**: does not consume `event_name` — no change.
- **Email marketing**: leads/campaigns use `first_name`, `last_name`, event-type selectors already; no `event_name` references to update.

---

## Rollout

Single deploy. Schema migration runs on app boot via `schema.sql`. Backfill + column drop happen in the same idempotent boot block.

No feature flag — solo-user app, immediate cutover is fine. After deploy, any proposal/shift/drink plan missing an `event_type` will display as "event" until the user sets the type in admin; no user-facing breakage.

## Testing checklist

- Create a new proposal in admin — verify no title input is present, review screen shows `Client` and `Event type` as separate rows.
- Create a proposal via `QuoteWizard` — verify linked shifts and drink plans inherit `event_type`, `event_type_custom`, `client_name`.
- Open an existing (migrated) proposal — client name + type both display correctly.
- Send a proposal email and a payment-reminder email — subject lines and bodies read naturally both with a known type and with an unset type.
- Create a standalone shift in admin — `event_type` optional, `'event'` fallback renders where needed.
- Submit a cocktail class via `ClassWizard` — submission succeeds with `event_type: 'cocktail-class'`, no `event_name` in request body.
- Submit a Potion Planning Lab drink plan anonymously — admin can open it, set the event type, and the display updates.
- Generate an invoice and start Stripe checkout — descriptor reads `"{event_type_label} event — {client_name}"` or `"event — {client_name}"` for untyped records.
- Subscribe to the iCal calendar feed in a calendar client — `SUMMARY` uses the new format.
- Run auto-assign SMS — message uses the new phrasing.
- Shopping list PDF shows both client name and event type in the header.

## Documentation updates

- **`CLAUDE.md`**: add to the Cross-Cutting Consistency section — "Client name and event type are displayed as separate data points. Never concatenate them into a single 'title' string or prompt for an `event_name`."
- **`README.md`**: remove any `event_name` references from schema/entity descriptions.
- **`ARCHITECTURE.md`**: update the Database Schema section to reflect dropped/new columns on `proposals`, `shifts`, `drink_plans`.

## Risks and mitigations

- **Risk:** The server-side `EVENT_TYPES` mirror drifts from the client source of truth. **Mitigation:** both files cross-reference each other in header comments; adding a type is already rare; a cheap Node test script (`node -e "..."`) compared at commit time could be added if drift becomes an issue.
- **Risk:** An existing record with a populated `event_name` but no `event_type` loses its descriptive text after the drop. **Mitigation:** documented as expected — user can fix in admin; the `'event'` fallback keeps the UI functional and non-broken.
- **Risk:** The backfill UPDATE could mis-populate if a shift/drink plan is linked to a proposal whose `event_type` is NULL. **Mitigation:** the `SET` only runs where the target `event_type IS NULL`, so linking later via admin still works correctly; a NULL source is fine because the target stays NULL.
- **Risk:** Calendar subscribers' existing imported events keep the old `SUMMARY` until each client re-syncs. **Mitigation:** accepted — most calendar clients resync within hours; not worth special handling.
