# Setup Time on Back-Facing Pages

## Context

Staff and admin need to know how early the crew must arrive to set up before an event's
service start — but this must never be advertised to clients or leads. Today there is no
setup-time concept surfaced anywhere: shift `start_time` equals service start, and the
dormant `shifts.setup_minutes_before INTEGER DEFAULT 60` column (schema.sql ~line 1059)
is accepted by `PUT /shifts/:id` but never defaulted by package, displayed, or editable.

This adds a setup time that:
- Defaults to **60 min** before service start, **90 min** for **hosted** (per-guest) packages.
- Is **admin-adjustable** (edits the minutes-before number; displayed everywhere as a
  derived clock time).
- Appears only on **back-facing** surfaces (admin event/proposal pages, staff portal
  pages, staff hire-confirmation email).
- Is **never** sent to clients/leads — stripped server-side, never rendered on public
  proposal/invoice/wizard surfaces.

Key facts confirmed during exploration:
- There is **no events table** — an "event" is a proposal in a paid status, edited via
  `PATCH /api/proposals/:id` (`server/routes/proposals/crud.js`), which already runs
  `syncShiftsFromProposal()` inside its transaction.
- `pricing_snapshot.package.pricing_type` carries `'per_guest'` for hosted; `isHostedPackage(pkg)`
  lives in `server/utils/pricingEngine.js:32-34`. Both sync functions already `SELECT p.*`
  so the snapshot is in hand — no extra join needed.
- `publicToken.js` uses an explicit column allowlist (not `SELECT p.*`), so a new
  proposals column does **not** auto-leak; we just keep it out and document the omission.

## Approach

**Storage.** Add nullable `proposals.setup_minutes_before INTEGER` (NULL = "use default",
no SQL default). Effective value derived at read time:
`proposal.setup_minutes_before ?? (isHostedPackage(pricing_snapshot.package) ? 90 : 60)`.
No backfill needed; survives package flips pre-booking.

**Sync target.** `createEventShifts()` / `syncShiftsFromProposal()` write the effective
minutes into the existing `shifts.setup_minutes_before`. Shift `start_time` stays equal to
service start — setup is informational, **not** a change to the billable/pay window.

**Display.** Always a derived clock time (`service_start − effectiveMinutes`, 12-hour).
Admin GET serves a server-derived `setup_time_display`; staff surfaces compute it
client-side from the shift's own `setup_minutes_before` + `start_time` (correct even for
hand-built multi-shift events the proposal sync skips).

**Boundary.** The public token endpoint never ships the column or any derived setup key;
no client component/email renders it.

### Decided defaults (no further input needed)
- Admin input on **both** `EventEditForm.js` and `ProposalDetailEditForm.js` (both seed
  from `initialFormFromProposal()`).
- Validation: integer **0–600** inclusive; explicit `null` allowed (reset to default).
- Staff label: **"Setup HH:MM"** (e.g. "Setup 4:00 PM"); email row: "Setup / arrive by".
- `EventsDashboard` list view **omits** setup in v1 (its list endpoint doesn't select
  `pricing_snapshot`; revisit later if needed).
- Hosted source = `pricing_snapshot.package` (snapshot is the as-sold record); joined
  `service_packages` only as a defensive fallback where a caller already has it.

## Critical files

| File | Change |
|---|---|
| `server/db/schema.sql` | `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS setup_minutes_before INTEGER;` in the proposals ALTER block alongside `total_price_override`, with a comment (NULL = derive 90 hosted / 60 else; sync target = `shifts.setup_minutes_before`; never public). Do **not** touch the `shifts` column at ~line 1059. |
| `server/utils/setupTime.js` *(new, ~40 lines, pure, no DB)* | `effectiveSetupMinutes(proposal, pkg)`, `subtractMinutesFromTime(timeStr, minutes)` (tolerant of "17:00" and "5:00 PM", mod-1440 wrap, time-only output, null on unparseable), `setupTimeDisplay(proposal, pkg)`. Imports `isHostedPackage` from `./pricingEngine`. New file (not appended) per file-size discipline. |
| `client/src/utils/setupTime.js` *(new)* | Mirror `subtractMinutesFromTime` + `formatSetupTime(startTime, minutes)`. Cross-reference comment to the server twin (mirrored-util pattern, like `eventTypes.js`). |
| `server/utils/eventCreation.js` | `require('./setupTime')`. In `createEventShifts()` add `setup_minutes_before` to the shift INSERT (value = `effectiveSetupMinutes(proposal)`). In `syncShiftsFromProposal()` add `setup_minutes_before = $N` to the UPDATE SET (same derivation; keep the `count !== 1` guard). Do not alter `start_time`/`end_time` logic. |
| `server/routes/proposals/crud.js` | `PATCH /:id`: destructure + validate `setup_minutes_before` (present & non-null → int 0–600 else `ValidationError({ setup_minutes_before })`); resolve via the **undefined-vs-null sentinel** pattern modeled on `total_price_override` (~lines 304-314) — `undefined` keeps old, `null` sets NULL; bind the resolved value **directly, not via COALESCE**. `GET /:id`: attach `setup_time_display: setupTimeDisplay(row)` (raw column already flows via `SELECT p.*`). |
| `server/routes/shifts.js` | Add `s.setup_minutes_before` to `GET /shifts/my-requests` projection; add **`s.start_time` and `s.setup_minutes_before`** to `GET /shifts/user/:userId/events`. (`GET /shifts`, `/shifts/by-proposal/:id`, `PUT /shifts/:id` already `SELECT s.*` / COALESCE — no change.) For the `shiftRequestApproved` email caller that uses an explicit query (~lines 619-627), add `s.setup_minutes_before`; compute `subtractMinutesFromTime(start_time, setup_minutes_before ?? 60)` and pass to the template. |
| `server/utils/emailTemplates.js` | `shiftRequestApproved()` (~294-313): add optional `setupTime` param → one HTML table row after Time + appended text line, rendered only when present. Staff-facing section only — no client template touched. |
| `client/src/pages/admin/ProposalDetailEditForm.js` | Add `setup_minutes_before` to `initialFormFromProposal()`; add to `handleSave` PATCH payload (`null` when blank, else `Number`); labeled minutes input near start-time/duration with live derived-clock + default helper text. |
| `client/src/pages/admin/EventEditForm.js` | Inherits the field via imported `initialFormFromProposal`; add `setup_minutes_before` to its PATCH payload; minutes input near `event_start_time` with derived-clock helper. |
| `client/src/pages/admin/EventDetailPage.js` | Render `proposal.setup_time_display` on the identity/time line after the service-time range; optionally per shift row from shift fields via the client util. |
| `client/src/pages/staff/StaffShifts.js`, `StaffSchedule.js`, `StaffEvents.js` | Add a "Setup HH:MM" line from `formatSetupTime(start_time, setup_minutes_before ?? 60)`; hidden when start time missing. |
| `server/routes/proposals/publicToken.js` | Keep `GET /t/:token` allowlist + `res.json` free of `setup_minutes_before` and any derived setup key. Extend the existing exclusion comment to name it explicitly (back-of-house only). |
| `ARCHITECTURE.md` | Proposals block: add `setup_minutes_before` bullet (nullable; derive rule; synced to shifts; never public). Shifts block: note it is informational, `start_time` always = service start, editable via `PUT /shifts/:id`, auto-synced for single-shift events only. |
| `CLIENT_FACING_SURFACES.md` | Add a note: setup time is back-of-house only; public token route deliberately omits it. |

## Cross-cutting risks (handle explicitly)

- **NULL-reset trap:** never persist `setup_minutes_before` with `COALESCE($n, old)` — that
  makes "reset to default" impossible. Use the undefined/null sentinel (mirror
  `total_price_override`).
- **Multi-shift events:** `syncShiftsFromProposal` no-ops when shift count ≠ 1 (by design).
  Proposal-level override won't propagate to hand-built multi-shift events; admin sets
  those per shift via `PUT /shifts/:id`. Staff always read the shift value → stays
  consistent. Document, don't "fix".
- **No package yet** (top-shelf draft, `pricing_snapshot = '{}'`): `isHostedPackage(undefined)`
  → false → 60. `effectiveSetupMinutes` must use optional chaining.
- **Event time edited after override set:** offset is stored, not a clock time, so display
  re-derives automatically; a time-only PATCH must not reset `setup_minutes_before`
  (it's `undefined` in that payload → kept).
- **Day-boundary wrap:** 90 min before 12:30 AM = 11:00 PM — compute mod 1440, print
  time only (no date), per the app's separate-date/time convention.
- **Time-string tolerance:** shift `start_time` is stored 12-hour ("5:00 PM");
  `event_start_time` may be 24-hour ("17:00"). The helper accepts both, returns null on
  failure (mirror `formatTime12`).

## Verification (end-to-end, manual)

1. Create a proposal with a **hosted (per_guest)** package, `event_start_time` "17:00" →
   DB `proposals.setup_minutes_before` is NULL.
2. Admin `GET /api/proposals/:id` → `setup_minutes_before: null`,
   `setup_time_display: "4:00 PM"` (17:00 − 90). EventDetailPage shows it on the time line.
3. Take through deposit so `createEventShifts` fires →
   `SELECT setup_minutes_before, start_time FROM shifts WHERE proposal_id=…` → `90`, `'5:00 PM'`.
4. `PATCH /api/proposals/:id { setup_minutes_before: 45 }` → proposals = 45; single-shift
   sync set `shifts.setup_minutes_before = 45`; admin GET display "4:15 PM".
5. `PATCH { setup_minutes_before: null }` → proposals NULL; shift back to 90; display "4:00 PM".
6. `GET /api/proposals/t/:token` → raw body has **no** `setup_minutes_before` /
   `setup_time_display`. Load `/proposal/:token` and `/invoice/:token` unauthenticated →
   no setup/arrival text anywhere. Repo-grep `setup_minutes_before`/`setup_time` →
   zero matches under `client/src/pages/{proposal,invoice,website}/` and client email templates.
7. PATCH package → BYOB (flat), override NULL → display = start − 60; shift re-synced to 60.
8. As staff, get approved on the shift → StaffShifts / StaffSchedule / StaffEvents each
   show "Setup 4:00 PM"; `shiftRequestApproved` email has the Setup/arrive-by row.
9. Edge: `event_start_time` "00:30", hosted → display "11:00 PM" (no date).
10. Two hand-built shifts: PATCH proposal setup → shifts unchanged (by design); set each
    via `PUT /shifts/:id` → staff sees per-shift values.
11. Regression: shift `start_time`/`end_time` identical before vs. after setting an
    override (pay-window invariant holds).

Run the standard pre-push agent fleet (this touches schema → routes → sync → client →
email → public boundary; cross-cutting + data-exposure surface).

## Branch note

This is independent of the in-flight `feat/venue-address` work. Per Git Rule 1, the
implementer confirms the branch before starting — recommended: a fresh branch off `main`
(or proceed on `main`), not stacked on the uncommitted venue changes.
